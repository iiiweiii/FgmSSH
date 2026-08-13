//! 连接配置 / 全局设置持久化 (对应 main.js loadConnectionsRaw/loadConnections/saveConnections)
//!
//! - load_raw:    读盘 + 明文凭据自动加密迁移 (仅当加密可用) + 解密返回明文列表 (仅主进程内部用)。
//! - load_redacted:store_load 命令用: password/passphrase 置空 + hasPassword/hasPassphrase 标记。
//! - save:        fail-closed: 任一记录加密失败 -> 整体拒绝写入 (绝不落明文);
//!                留空沿用: password='' 且磁盘有同 id 旧值 -> 沿用旧密文;
//!                overwrite_empty=true (config_import) 全量替换, 不继承磁盘旧凭据。
//! - settings:    明文 JSON (全局设置, 与连接配置无关)。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::credential;

/// 存储路径的全局单例 (由 setup 中 store::init 注入)。
static STORE: OnceLock<Mutex<StorePaths>> = OnceLock::new();

#[derive(Clone)]
pub struct StorePaths {
    pub connections_path: PathBuf,
    pub settings_path: PathBuf,
}

/// 初始化存储路径 (幂等; 未初始化时 store 函数按未初始化处理, 返回空/拒绝)。
pub fn init(connections_path: PathBuf, settings_path: PathBuf) {
    let _ = STORE.set(Mutex::new(StorePaths {
        connections_path,
        settings_path,
    }));
}

fn paths() -> Option<StorePaths> {
    STORE.get().map(|m| m.lock().unwrap().clone())
}

// ---------- connections.json ----------

fn read_connections() -> Vec<Value> {
    let Some(p) = paths() else { return vec![] };
    let raw = match std::fs::read_to_string(&p.connections_path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(arr)) => arr,
        _ => vec![],
    }
}

fn write_connections(list: &[Value]) -> Result<(), String> {
    let Some(p) = paths() else {
        return Err("存储模块未初始化".to_string());
    };
    if let Some(dir) = p.connections_path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "写入配置失败".to_string())?;
    }
    let json =
        serde_json::to_string_pretty(list).map_err(|_| "写入配置失败".to_string())?;
    std::fs::write(&p.connections_path, json).map_err(|_| "写入配置失败".to_string())
}

/// 内部: 读取磁盘原始连接列表 (含密文) -> 明文凭据自动迁移 (仅加密可用时写回) ->
/// 解密返回明文列表 (仅供导出/连接补全等主进程内部使用)。
pub fn load_raw() -> Vec<Value> {
    let list = read_connections();
    if list.is_empty() {
        return list;
    }

    // 第一遍: 检查是否存在明文敏感字段, 且全部可加密 (fail-closed: 任一失败则不迁移不写回)。
    let mut needs_migration = false;
    let mut all_encryptable = true;
    for conn in &list {
        let Some(obj) = conn.as_object() else { continue };
        for field in ["password", "passphrase"] {
            if let Some(Value::String(s)) = obj.get(field) {
                if !s.is_empty() && !credential::is_encrypted_token(s) {
                    needs_migration = true;
                    if credential::encrypt(s).is_none() {
                        all_encryptable = false;
                    }
                }
            }
        }
    }

    // 第二遍: 加密并写回 (仅当存在明文且全部可加密; 迁移过程任一加密失败则整体不写回)。
    if needs_migration && all_encryptable {
        let mut migrated: Vec<Value> = Vec::with_capacity(list.len());
        let mut all_ok = true;
        for conn in &list {
            match credential::encrypt_record(conn) {
                Some(enc) => migrated.push(enc),
                None => {
                    all_ok = false;
                    break;
                }
            }
        }
        if all_ok {
            let _ = write_connections(&migrated);
        }
    }

    // 解密返回 (单条解密失败 -> 字段置空)。
    list.iter().map(credential::decrypt_record).collect()
}

/// store_load 用: 脱敏视图 (password/passphrase='' + hasPassword/hasPassphrase)。
pub fn load_redacted() -> Vec<Value> {
    load_raw()
        .iter()
        .map(|conn| {
            let Some(obj) = conn.as_object() else {
                return conn.clone();
            };
            let mut out = obj.clone();
            let has_password = obj
                .get("password")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            let has_passphrase = obj
                .get("passphrase")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            out.insert("password".into(), Value::String(String::new()));
            out.insert("passphrase".into(), Value::String(String::new()));
            out.insert("hasPassword".into(), Value::Bool(has_password));
            out.insert("hasPassphrase".into(), Value::Bool(has_passphrase));
            Value::Object(out)
        })
        .collect()
}

/// store_save / config_import 用。
#[derive(Default, Clone, Copy)]
pub struct SaveOpts {
    /// true = 全量替换 (config_import), 跳过「留空沿用」merge, 不继承磁盘旧凭据。
    pub overwrite_empty: bool,
}

/// 供 portable.rs (config_export) 使用: 读取解密后的明文连接列表 (含凭据, 仅主进程内部)。
/// TODO(verify): 与 portable.rs 的函数名约定 load_connections_raw。
pub fn load_connections_raw() -> Result<Vec<Value>, String> {
    Ok(load_raw())
}

/// 供 portable.rs (config_import) 使用: 全量落盘 (overwrite_empty=true 语义, 不继承旧凭据)。
/// TODO(verify): 与 portable.rs 的函数名约定 save_connections。
pub fn save_connections(list: &[Value], overwrite_empty: bool) -> Result<(), String> {
    save(list, SaveOpts { overwrite_empty })
}

/// fail-closed 保存连接列表。
/// 留空沿用: password='' 且磁盘有同 id 旧值 -> 沿用旧密文 (旧值可能为 enc:v1: 密文,
/// 加密时幂等返回原 token)。
/// 任一记录加密失败 -> 整体拒绝写入。
pub fn save(list: &[Value], opts: SaveOpts) -> Result<(), String> {
    // 1) 读取现有 (仅当非全量替换)。
    let existing = if opts.overwrite_empty {
        Vec::new()
    } else {
        read_connections()
    };
    let by_id: HashMap<String, Value> = existing
        .iter()
        .filter_map(|c| {
            c.get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), c.clone()))
        })
        .collect();

    // 2) merge: 留空沿用旧值。
    let merged: Vec<Value> = list
        .iter()
        .map(|conn| {
            if opts.overwrite_empty {
                return conn.clone();
            }
            let Some(obj) = conn.as_object() else {
                return conn.clone();
            };
            let id = obj.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(old) = by_id.get(id) else {
                return conn.clone();
            };
            let mut out = obj.clone();
            for field in ["password", "passphrase"] {
                if let Some(Value::String(s)) = out.get(field) {
                    if s.is_empty() {
                        if let Some(Value::String(old_s)) = old.get(field) {
                            out.insert(field.to_string(), Value::String(old_s.clone()));
                        }
                    }
                }
            }
            Value::Object(out)
        })
        .collect();

    // 3) 加密 (fail-closed: 任一失败整体拒绝)。
    let mut encrypted: Vec<Value> = Vec::with_capacity(merged.len());
    for conn in &merged {
        match credential::encrypt_record(conn) {
            Some(enc) => encrypted.push(enc),
            None => {
                return Err("系统加密不可用，凭据保存被拒绝（为避免明文存储）".to_string());
            }
        }
    }

    // 4) 落盘。
    write_connections(&encrypted)
}

// ---------- settings.json ----------

/// 读取全局设置 (缺失/损坏 -> 默认对象)。
pub fn load_settings() -> Value {
    let Some(p) = paths() else {
        return serde_json::json!({});
    };
    let raw = match std::fs::read_to_string(&p.settings_path) {
        Ok(s) => s,
        Err(_) => return serde_json::json!({}),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v @ Value::Object(_)) => v,
        _ => serde_json::json!({}),
    }
}

/// 保存全局设置 (明文 JSON, 与凭据无关)。
pub fn save_settings(settings: &Value) -> Result<(), String> {
    let Some(p) = paths() else {
        return Err("存储模块未初始化".to_string());
    };
    if let Some(dir) = p.settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "写入设置失败".to_string())?;
    }
    let json =
        serde_json::to_string_pretty(settings).map_err(|_| "写入设置失败".to_string())?;
    std::fs::write(&p.settings_path, json).map_err(|_| "写入设置失败".to_string())
}
