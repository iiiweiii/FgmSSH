//! 通用小工具 (无业务依赖)。

use std::path::Path;

/// 当前时间 ISO 8601 (UTC, 带 Z), 例如 `2026-08-13T02:00:00.123Z`。
/// 供 hostkey firstSeen/lastSeen、audit ts、config meta 共用, 保证格式一致。
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 判断字符串是否为空 (None / 空串 / 全空白)。
pub fn is_blank(value: Option<&String>) -> bool {
    match value {
        None => true,
        Some(s) => s.trim().is_empty(),
    }
}

/// 从字符串中取非空值 (Option<String> 语义: 空串视为 None)。
pub fn non_empty(value: Option<String>) -> Option<String> {
    match value {
        Some(s) if !s.trim().is_empty() => Some(s),
        _ => None,
    }
}

/// 友好的 "不是文件" 校验 (供 sftp_register_upload_paths 登记用)。
pub fn is_regular_file(path: &Path) -> bool {
    path.is_file()
}

/// 版本号比较 (语义化; 非语义化回退字符串比较)。返回 -1 / 0 / 1。
/// 对齐原 Electron src/update-check.js compareVersions。
pub fn compare_versions(a: &str, b: &str) -> i8 {
    fn norm(t: &str) -> String {
        t.trim().trim_start_matches(['v', 'V']).to_string()
    }
    fn parts(t: &str) -> Option<(u64, u64, u64)> {
        let mut it = t.split(['.', '-']);
        let maj = it.next()?.parse().ok()?;
        let min = it.next().unwrap_or("0").parse().unwrap_or(0);
        let pat = it.next().unwrap_or("0").split('.').next().unwrap_or("0").parse().unwrap_or(0);
        Some((maj, min, pat))
    }
    let na = norm(a);
    let nb = norm(b);
    let pa = parts(&na);
    let pb = parts(&nb);
    match (pa, pb) {
        (Some(x), Some(y)) => {
            if x < y {
                -1
            } else if x > y {
                1
            } else {
                0
            }
        }
        _ => {
            if na == nb {
                0
            } else if na < nb {
                -1
            } else {
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert_eq!(compare_versions("v1.2.3", "1.2.4"), -1);
        assert_eq!(compare_versions("1.2.3", "v1.2.3"), 0);
        assert_eq!(compare_versions("2.0.0", "1.9.9"), 1);
        assert_eq!(compare_versions("1.2.3-beta.1", "1.2.3"), -1);
    }
}
