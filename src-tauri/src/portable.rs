//! 配置加密导出/导入（portable）
//!
//! 职责（对应 SPEC 命令 `config_export` / `config_import`）：
//!   - 导出：读取 store 明文连接列表 -> 字段白名单清洗 -> AES-256-GCM 加密（密钥由
//!     scrypt(password, salt) 派生，salt 随机 16B 存文件头）-> 弹保存对话框写文件。
//!   - 导入：弹打开对话框读文件 -> 校验魔数/版本 -> GCM 认证解密（失败固定文案
//!     `密码错误或文件已损坏`，不泄露任何内容）-> 白名单清洗 -> 全量替换 store
//!     （overwrite_empty=true 语义，不继承磁盘旧凭据）。
//!
//! 二进制文件布局（v1）：
//!   [0..8]  魔数 "FGMSSHPC"
//!   [8]     格式版本 (1)
//!   [9]     KDF 标识 (0 = scrypt)
//!   [10..26]  salt (16B)
//!   [26..38] iv (12B)
//!   [38..54] GCM tag (16B)
//!   [54..]  AES-256-GCM 密文（明文为连接列表 JSON）
//!
//! scrypt 参数：N=16384 (log2=14), r=8, p=1 —— 与 Electron config-portable.js Node 默认一致。
//!
//! 安全要点：
//!   - 对话框选文件在主进程（tauri-plugin-dialog），后端只做加解密 + 读写指定路径；
//!     路径一律来自对话框返回值，config_export / config_import **不接收渲染层路径参数**。
//!   - 导入文件大小上限 5MB（防超大文件拖垮解密）。
//!   - 清洗：导入/导出两侧均做字段白名单清洗，外来文件不能注入任意字段。
//!   - 错误信息一律固定友好文案，不含密码/内容/底层异常细节。
//!
//! 依赖 crate::store（backend-core 提供，已按真实签名对齐）：
//!   - `crate::store::load_raw() -> Vec<serde_json::Value>` 读取解密后的明文连接列表
//!     （store.rs 亦保留 load_connections_raw() 包装，等价）
//!   - `crate::store::save(&[serde_json::Value], SaveOpts { overwrite_empty: bool })
//!      -> Result<(), String>` 全量落盘（config_import 传 overwrite_empty=true）
//!   - 本模块使用 chrono::Local（默认文件名时间戳），Cargo.toml 中 chrono 需带默认
//!     features（含 clock）或显式启用 "clock"（TODO(verify)）

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use typenum::U12;

const MAGIC: &[u8; 8] = b"FGMSSHPC";
const FORMAT_VERSION: u8 = 1;
const KDF_SCRYPT: u8 = 0;
const SALT_LEN: usize = 16;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;
const SCRYPT_LOG_N: u8 = 14; // N = 2^14 = 16384（Node scryptSync 默认）
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;

/// 连接记录字段白名单（与 Electron config-portable.js CONN_FIELDS 一致；'user' 兼容旧格式）
const CONN_FIELDS: &[&str] = &[
    "id", "name", "host", "port", "username", "user",
    "authMethod", "password", "passphrase", "privateKeyPath", "tunnels",
];
/// 隧道子项字段白名单
const TUNNEL_FIELDS: &[&str] = &["localPort", "remoteHost", "remotePort", "name"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPortableResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn ok_result(count: usize) -> ConfigPortableResult {
    ConfigPortableResult { ok: true, count: Some(count), error: None }
}

fn err_result(error: &str) -> ConfigPortableResult {
    ConfigPortableResult { ok: false, count: None, error: Some(error.to_string()) }
}

// ---------------------------------------------------------------------------
// 白名单清洗
// ---------------------------------------------------------------------------

fn clean_conn(v: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = v.as_object()?;
    let mut out = serde_json::Map::new();
    for key in CONN_FIELDS {
        if let Some(val) = obj.get(*key) {
            if !val.is_null() {
                out.insert((*key).to_string(), val.clone());
            }
        }
    }
    if let Some(t) = out.get("tunnels") {
        if let Some(arr) = t.as_array() {
            let cleaned: Vec<serde_json::Value> = arr.iter().filter_map(clean_tunnel).collect();
            out.insert("tunnels".to_string(), serde_json::Value::Array(cleaned));
        } else {
            out.remove("tunnels");
        }
    }
    // 无 host 的记录无意义，剔除
    let host = out.get("host").and_then(|h| h.as_str()).unwrap_or("");
    if host.trim().is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(out))
}

fn clean_tunnel(v: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = v.as_object()?;
    let mut out = serde_json::Map::new();
    for key in TUNNEL_FIELDS {
        if let Some(val) = obj.get(*key) {
            if !val.is_null() {
                out.insert((*key).to_string(), val.clone());
            }
        }
    }
    Some(serde_json::Value::Object(out))
}

fn sanitize_list(list: &[serde_json::Value]) -> Vec<serde_json::Value> {
    list.iter()
        .filter_map(|v| {
            // 仅保留对象且含非空 host 的条目
            if !v.is_object() {
                return None;
            }
            clean_conn(v)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 加解密
// ---------------------------------------------------------------------------

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let mut key = [0u8; KEY_LEN];
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .map_err(|_| "加密参数不合法")?;
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key).map_err(|_| "加密参数不合法")?;
    Ok(key)
}

/// AES-256-GCM 加密：返回 (密文, tag)。aes-gcm encrypt 将 16B tag 追加在密文尾部。
fn encrypt_plaintext(key: &[u8; KEY_LEN], iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; TAG_LEN]), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    // aes-gcm 0.10.3: Nonce 直接泛型于 nonce 大小 (U12), 不再是 cipher 类型。
    let nonce = Nonce::<U12>::from_slice(iv);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| "加密失败")?;
    if ct.len() < TAG_LEN {
        return Err("加密失败".to_string());
    }
    let (data, tag) = ct.split_at(ct.len() - TAG_LEN);
    let mut tag_arr = [0u8; TAG_LEN];
    tag_arr.copy_from_slice(tag);
    Ok((data.to_vec(), tag_arr))
}

/// GCM 认证解密：认证失败（密码错误/内容被篡改）返回固定文案。
fn decrypt_payload(key: &[u8; KEY_LEN], iv: &[u8; IV_LEN], data: &[u8], tag: &[u8; TAG_LEN]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    // aes-gcm 0.10.3: Nonce 直接泛型于 nonce 大小 (U12), 不再是 cipher 类型。
    let nonce = Nonce::<U12>::from_slice(iv);
    let mut ct = data.to_vec();
    ct.extend_from_slice(tag);
    cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| "密码错误或文件已损坏".to_string())
}

/// 组装 v1 二进制文件
fn build_file_bytes(password: &str, list: &[serde_json::Value]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut iv = [0u8; IV_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut iv);

    let key = derive_key(password, &salt)?;
    let plaintext = serde_json::to_vec(list).map_err(|_| "序列化失败")?;
    let (data, tag) = encrypt_plaintext(&key, &iv, &plaintext)?;

    let mut out = Vec::with_capacity(8 + 1 + 1 + SALT_LEN + IV_LEN + TAG_LEN + data.len());
    out.extend_from_slice(MAGIC);
    out.push(FORMAT_VERSION);
    out.push(KDF_SCRYPT);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&tag);
    out.extend_from_slice(&data);
    Ok(out)
}

/// 解析并解密 v1 二进制文件 -> 清洗后的连接列表
fn parse_file_bytes(password: &str, data: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    const HEADER_LEN: usize = 8 + 1 + 1 + SALT_LEN + IV_LEN + TAG_LEN;
    if data.len() < HEADER_LEN {
        return Err("文件格式无效".to_string());
    }
    if &data[0..8] != MAGIC {
        return Err("文件格式无效".to_string());
    }
    if data[8] != FORMAT_VERSION {
        return Err("不支持的备份版本".to_string());
    }
    if data[9] != KDF_SCRYPT {
        return Err("不支持的备份版本".to_string());
    }
    let salt = &data[10..10 + SALT_LEN];
    let iv = &data[10 + SALT_LEN..10 + SALT_LEN + IV_LEN];
    let tag = &data[10 + SALT_LEN + IV_LEN..HEADER_LEN];
    let ciphertext = &data[HEADER_LEN..];

    let key = derive_key(password, salt)?;
    let mut iv_arr = [0u8; IV_LEN];
    iv_arr.copy_from_slice(iv);
    let mut tag_arr = [0u8; TAG_LEN];
    tag_arr.copy_from_slice(tag);

    let plain = decrypt_payload(&key, &iv_arr, ciphertext, &tag_arr)?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&plain).map_err(|_| "文件内容无效")?;
    let arr = parsed.as_array().ok_or_else(|| "文件内容无效".to_string())?;
    let clean = sanitize_list(arr);
    Ok(clean)
}

/// 默认文件名（仅文件名，不含目录）
fn default_backup_name() -> String {
    let stamp = chrono::Local::now().format("%Y%m%d").to_string();
    format!("fgm-connections-backup-{}.fgm", stamp)
}

// ---------------------------------------------------------------------------
// config_export / config_import
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn config_export(
    password: String,
    app: AppHandle,
) -> ConfigPortableResult {
    if password.trim().is_empty() {
        return err_result("密码不能为空");
    }

    // 读取 store 明文连接列表（含凭据；由 store.rs 解密；失败返回空列表）
    let list = crate::store::load_raw();
    let clean = sanitize_list(&list);
    let count = clean.len();

    // 加密 + 组文件（CPU 密集，spawn_blocking）
    let pwd = password.clone();
    let build = match tauri::async_runtime::spawn_blocking(move || build_file_bytes(&pwd, &clean)).await {
        Ok(b) => b,
        Err(_) => return err_result("导出异常"),
    };
    let bytes = match build {
        Ok(b) => b,
        Err(e) => return err_result(&e),
    };

    // 弹保存对话框（阻塞对话框放 spawn_blocking，避免阻塞异步运行时）
    let file_name = default_backup_name();
    let picked = match tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导出加密配置")
            .add_filter("FgmSSH 加密备份", &["fgm"])
            // TODO(verify): tauri-plugin-dialog 2.x FileDialogBuilder 方法名
            .set_file_name(&file_name)
            .blocking_save_file()
    })
    .await
    {
        Ok(p) => p,
        Err(_) => return err_result("导出异常"),
    };

    let file_path = match picked {
        Some(fp) => fp,
        None => return err_result("已取消"),
    };
    // TODO(verify): tauri-plugin-dialog FilePath::into_path 返回 Result<PathBuf, Error>
    let path = match file_path.into_path() {
        Ok(p) => p,
        Err(_) => return err_result("导出异常"),
    };

    // 写文件
    let write_res = match tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, &bytes)).await {
        Ok(r) => r,
        Err(_) => return err_result("导出异常"),
    };
    match write_res {
        Ok(_) => ok_result(count),
        Err(_) => err_result("写入文件失败"),
    }
}

#[tauri::command]
pub async fn config_import(
    password: String,
    app: AppHandle,
) -> ConfigPortableResult {
    if password.trim().is_empty() {
        return err_result("密码不能为空");
    }

    // 弹打开对话框（阻塞对话框放 spawn_blocking）
    let picked = match tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导入加密配置")
            .add_filter("FgmSSH 加密备份", &["fgm"])
            .blocking_pick_file()
    })
    .await
    {
        Ok(p) => p,
        Err(_) => return err_result("导入异常"),
    };

    let file_path = match picked {
        Some(fp) => fp,
        None => return err_result("已取消"),
    };
    let path = match file_path.into_path() {
        Ok(p) => p,
        Err(_) => return err_result("导入异常"),
    };

    // 读文件（大小上限 5MB）
    let read_res = match tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let meta = std::fs::metadata(&path).map_err(|_| "读取文件失败".to_string())?;
        if meta.len() > MAX_FILE_BYTES as u64 {
            return Err("文件格式无效".to_string());
        }
        std::fs::read(&path).map_err(|_| "读取文件失败".to_string())
    })
    .await
    {
        Ok(r) => r,
        Err(_) => return err_result("导入异常"),
    };
    let data = match read_res {
        Ok(d) => d,
        Err(e) => return err_result(&e),
    };

    // 解密 + 清洗（CPU 密集，spawn_blocking）
    let pwd = password.clone();
    let decrypt = match tauri::async_runtime::spawn_blocking(move || parse_file_bytes(&pwd, &data)).await {
        Ok(r) => r,
        Err(_) => return err_result("导入异常"),
    };
    let list = match decrypt {
        Ok(l) => l,
        Err(e) => return err_result(&e),
    };

    // 全量替换 store（overwrite_empty=true：不继承磁盘旧凭据）
    match crate::store::save(&list, crate::store::SaveOpts { overwrite_empty: true }) {
        Ok(_) => ok_result(list.len()),
        Err(_) => err_result("保存配置失败"),
    }
}
