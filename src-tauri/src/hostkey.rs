//! 主机密钥指纹库 (TOFU, 对应 Electron hostkey-store.js)
//!
//! - known_hosts.json 为明文 JSON (主机指纹非机密), 结构与原版一致:
//!   `{ "<host>:<port>": { fingerprint, algorithm, firstSeen, lastSeen } }`
//! - 指纹格式: SHA256:<base64 无 padding> (与 `ssh-keygen -lf` 逐字符一致) +
//!   MD5:aa:bb:... 冒号小写 (与 `ssh-keygen -E md5 -lf` 一致)。
//! - 三态判定: trusted / unknown / mismatch (mismatch = 危险, 可能中间人)。
//! - 容错: 文件缺失/JSON 损坏/非对象 -> 回退空库 (不抛异常, 不覆盖原文件)。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use sha2::{Digest, Sha256};

/// 单台主机的指纹条目 (与 hostkey-store.js 字段一致, camelCase)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyEntry {
    pub fingerprint: String,
    pub algorithm: String,
    pub first_seen: String,
    pub last_seen: String,
}

/// 计算出的指纹对 (sha256 / md5 均带前缀)。
#[derive(Debug, Clone)]
pub struct Fingerprints {
    pub sha256: String,
    pub md5: String,
}

/// 三态判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    Mismatch,
}

/// check_host_key 的返回。
#[derive(Debug)]
pub struct HostKeyCheck {
    pub status: HostKeyStatus,
    pub stored: Option<HostKeyEntry>,
}

/// known_hosts 的 key: "<host>:<port>" (纯字符串拼接, 无注入面)。
pub fn host_key_id(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

/// 归一化存储的指纹值: 去掉历史版本可能残留的 base64 尾部 padding
/// (SHA256:abc== -> SHA256:abc), 避免升级后同一主机被误判为 mismatch。
pub fn normalize_stored_fingerprint(v: &str) -> String {
    if v.starts_with("SHA256:") {
        let b64 = &v["SHA256:".len()..];
        let trimmed = b64.trim_end_matches('=');
        format!("SHA256:{}", trimmed)
    } else {
        v.to_string()
    }
}

/// 计算 OpenSSH 兼容指纹 (对 host key 原始字节)。
/// SHA256: base64 去尾部 padding; MD5: 冒号分隔十六进制小写。
pub fn compute_fingerprints(host_key: &[u8]) -> Fingerprints {
    let sha256_digest = Sha256::digest(host_key);
    let sha256_b64 = base64::engine::general_purpose::STANDARD.encode(sha256_digest);
    let sha256_b64 = sha256_b64.trim_end_matches('=');
    let sha256 = format!("SHA256:{}", sha256_b64);

    // md5 0.7 (sytsem0): compute() -> [u8;16]; 与 ssh-keygen -E md5 冒号小写格式一致。
    let md5_digest = md5::compute(host_key);
    let md5_hex = md5_digest
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":");
    let md5 = format!("MD5:{}", md5_hex);

    Fingerprints { sha256, md5 }
}

/// 从 SSH 线上格式的 host key 字节中提取算法名:
/// 前 4 字节为大端长度, 其后为算法字符串 ("ssh-ed25519"/"ssh-rsa"/"ecdsa-sha2-nistp256"...)。
/// 解析失败返回 "unknown"。
pub fn extract_algorithm(host_key: &[u8]) -> String {
    if host_key.len() >= 4 {
        let len = u32::from_be_bytes([host_key[0], host_key[1], host_key[2], host_key[3]]) as usize;
        if 4 + len <= host_key.len() {
            if let Ok(s) = std::str::from_utf8(&host_key[4..4 + len]) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

/// 读取 known_hosts 指纹库。文件缺失/JSON 损坏/非对象 -> 回退空库 (容错)。
pub fn load(path: &Path) -> HashMap<String, HostKeyEntry> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return HashMap::new(),
    };
    let mut out = HashMap::new();
    for (k, v) in obj {
        let mut entry: HostKeyEntry = match serde_json::from_value(v.clone()) {
            Ok(e) => e,
            Err(_) => continue, // 单条损坏跳过
        };
        // 旧值归一: 兼容早期版本带 padding 的 SHA256 指纹 (内存归一, 下次 trust 时落盘)。
        entry.fingerprint = normalize_stored_fingerprint(&entry.fingerprint);
        out.insert(k.clone(), entry);
    }
    out
}

/// 保存 known_hosts 指纹库 (目录不存在自动创建)。
pub fn save(path: &Path, map: &HashMap<String, HostKeyEntry>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "写入主机指纹库失败".to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|_| "写入主机指纹库失败".to_string())?;
    std::fs::write(path, json).map_err(|_| "写入主机指纹库失败".to_string())
}

/// 查询单个主机指纹条目 (不存在返回 None)。
pub fn get_entry(path: &Path, host: &str, port: u16) -> Option<HostKeyEntry> {
    load(path).remove(&host_key_id(host, port))
}

/// 校验主机指纹三态 (对应 hostkey-store.js checkHostKey)。
pub fn check_host_key(
    path: &Path,
    host: &str,
    port: u16,
    fingerprint: &str,
    _algorithm: &str,
) -> HostKeyCheck {
    let id = host_key_id(host, port);
    let map = load(path);
    match map.get(&id) {
        None => HostKeyCheck {
            status: HostKeyStatus::Unknown,
            stored: None,
        },
        Some(stored) => {
            if !fingerprint.is_empty() && stored.fingerprint == fingerprint {
                HostKeyCheck {
                    status: HostKeyStatus::Trusted,
                    stored: Some(stored.clone()),
                }
            } else {
                HostKeyCheck {
                    status: HostKeyStatus::Mismatch,
                    stored: Some(stored.clone()),
                }
            }
        }
    }
}

/// 信任 (写入/覆盖) 主机指纹: 首次确认写入; mismatch 覆盖时更新 fingerprint 并保留 firstSeen。
pub fn trust_host_key(
    path: &Path,
    host: &str,
    port: u16,
    fingerprint: &str,
    algorithm: &str,
) -> Result<(), String> {
    let id = host_key_id(host, port);
    let mut map = load(path);
    let now = chrono::Utc::now().to_rfc3339();
    let existing = map.get(&id).cloned();
    map.insert(
        id,
        HostKeyEntry {
            fingerprint: fingerprint.to_string(),
            algorithm: if algorithm.is_empty() {
                "unknown".to_string()
            } else {
                algorithm.to_string()
            },
            first_seen: existing
                .map(|e| e.first_seen)
                .unwrap_or_else(|| now.clone()),
            last_seen: now,
        },
    );
    save(path, &map)
}
