//! 凭据加密模块 (DPAPI, 对应 Electron credential-store.js)
//!
//! - 存储格式 `enc:v1:<base64>`, 前缀兼容旧 token; Windows DPAPI 同一用户可解密。
//! - `encrypt`: 空串原样返回; 已加密 token 幂等返回; 加密失败/不可用返回 None (fail-closed,
//!   绝不返回明文)。
//! - `decrypt`: 非 enc:v1: 前缀原样返回 (兼容降级明文); 失败返回 None, 调用方置空。
//! - 非 Windows 平台: DPAPI 不可用, encrypt/decrypt 均返回 None (fail-closed)。

/// enc:v1: 前缀 (与 credential-store.js TOKEN_PREFIX 一致)。
pub const TOKEN_PREFIX: &str = "enc:v1:";

/// base64 Engine trait (base64 0.22 需显式导入才能调用 STANDARD.encode/decode)。
use base64::Engine;

/// 判断值是否为已加密 token。
pub fn is_encrypted_token(value: &str) -> bool {
    value.starts_with(TOKEN_PREFIX)
}

/// 加密单个明文秘密 -> token。
/// - 空串返回 Some("") (无秘密);
/// - 已加密 token 原样返回 (幂等);
/// - DPAPI 不可用/加密抛错返回 None (fail-closed)。
pub fn encrypt(secret: &str) -> Option<String> {
    if secret.is_empty() {
        return Some(String::new());
    }
    if is_encrypted_token(secret) {
        return Some(secret.to_string());
    }
    let cipher = dpapi_encrypt(secret.as_bytes())?;
    let token = format!(
        "{}{}",
        TOKEN_PREFIX,
        base64::engine::general_purpose::STANDARD.encode(cipher)
    );
    Some(token)
}

/// 解密 token -> 明文。
/// - 空串返回 Some("");
/// - 非 enc:v1: 前缀原样返回 (兼容未加密明文);
/// - DPAPI 不可用/解密失败返回 None (调用方将该字段置空)。
pub fn decrypt(token: &str) -> Option<String> {
    if token.is_empty() {
        return Some(String::new());
    }
    if !is_encrypted_token(token) {
        return Some(token.to_string());
    }
    let b64 = &token[TOKEN_PREFIX.len()..];
    let cipher = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let plain = dpapi_decrypt(&cipher)?;
    String::from_utf8(plain).ok()
}

/// 加密单条连接记录: 仅处理 password/passphrase, 其余字段透传 (浅拷贝)。
/// 任一敏感字段 encrypt 返回 None -> 整体返回 None (fail-closed)。
pub fn encrypt_record(conn: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = conn.as_object()?;
    let mut out = obj.clone();
    for field in ["password", "passphrase"] {
        if let Some(serde_json::Value::String(s)) = out.get(field) {
            if !s.is_empty() {
                out.insert(field.to_string(), serde_json::Value::String(encrypt(s)?));
            }
        }
    }
    Some(serde_json::Value::Object(out))
}

/// 解密单条连接记录: 仅处理 password/passphrase, 其余字段透传。
/// 单条解密失败 -> 该字段置空 (不抛异常)。
pub fn decrypt_record(conn: &serde_json::Value) -> serde_json::Value {
    let Some(obj) = conn.as_object() else {
        return conn.clone();
    };
    let mut out = obj.clone();
    for field in ["password", "passphrase"] {
        if let Some(serde_json::Value::String(s)) = out.get(field) {
            if is_encrypted_token(s) {
                let dec = decrypt(s).unwrap_or_default();
                out.insert(field.to_string(), serde_json::Value::String(dec));
            }
        }
    }
    serde_json::Value::Object(out)
}

#[cfg(windows)]
fn dpapi_encrypt(plain: &[u8]) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // windows 0.58: CryptProtectData 返回 Result<()>, dwFlags 为 u32;
        // 可选参数 (entropy/reserved/prompt) 传 None。
        let ok = CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok.is_err() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        // 释放由 DPAPI 分配的缓冲区 (windows 0.58: LocalFree 在 Win32::Foundation,
        // 参数为 HLOCAL 包装类型)。
        if !output.pbData.is_null() {
            let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        }
        Some(bytes)
    }
}

#[cfg(windows)]
fn dpapi_decrypt(cipher: &[u8]) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok.is_err() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if !output.pbData.is_null() {
            let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        }
        Some(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_encrypt(_plain: &[u8]) -> Option<Vec<u8>> {
    // 非 Windows 平台无 DPAPI: fail-closed, 拒绝加密 (绝不返回明文)。
    None
}

#[cfg(not(windows))]
fn dpapi_decrypt(_cipher: &[u8]) -> Option<Vec<u8>> {
    None
}
