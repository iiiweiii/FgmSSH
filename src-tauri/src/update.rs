//! 更新检查（update）
//!
//! 职责（对应 SPEC 命令 `update_check`）：
//!   - ureq 请求 GitHub Releases latest API（HTTPS、5s 超时、User-Agent），比对 tag 与本地版本。
//!   - semver 比较：兼容 v/V 前缀与预发布段（如 v1.2.3-beta.1），非语义化 tag 回退字符串比较。
//!   - 有更新 -> {ok:true, hasUpdate:true, current, latest, url}；失败（离线/超时/无 tag）
//!     静默 {ok:false}，不自动下载/不自动升级。
//!   - 返回结构字段与 SPEC 一致：{ok, hasUpdate?, current?, latest?, url?}。
//!
//! 说明：
//!   - 命令参数 owner/repo/currentVersion 均为可选（前端 bridge 调用 updateCheck() 可传空），
//!     缺省时用默认仓库配置；currentVersion 缺省时取应用自身版本（app.package_info()）。
//!   - state 参数仅保持命令签名一致（本命令不访问会话）。

use serde::Serialize;
use std::cmp::Ordering;
use std::time::Duration;
use tauri::AppHandle;

const GITHUB_API: &str = "https://api.github.com/repos/";
const GITHUB_WEB: &str = "https://github.com/";
const DEFAULT_OWNER: &str = "iiiweiii";
const DEFAULT_REPO: &str = "FgmSSH";
const TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "fgm-ssh-update-check";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_update: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

// ---------------------------------------------------------------------------
// 版本比较（移植 Electron update-check.js compareVersions）
// ---------------------------------------------------------------------------

/// 归一化 tag：去首尾空白 + 去掉 v/V 前缀。
fn normalize_tag(tag: &str) -> String {
    let t = tag.trim();
    if t.len() > 1 && (t.starts_with('v') || t.starts_with('V')) {
        t[1..].to_string()
    } else {
        t.to_string()
    }
}

/// 解析语义化版本：(major, minor, patch, pre?)。pre 由 `-` 或 `.` 引出。
fn parse_version(tag: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let t = normalize_tag(tag);
    if t.is_empty() {
        return None;
    }
    let nums: Vec<&str> = t.split(['-', '.']).collect();
    if nums.len() < 3 {
        return None;
    }
    let major = nums[0].parse::<u64>().ok()?;
    let minor = nums[1].parse::<u64>().ok()?;
    let patch = nums[2].parse::<u64>().ok()?;
    // 前三段字符长度 + 3 个分隔符 = pre 段起点
    let consumed = nums[0].len() + nums[1].len() + nums[2].len() + 3;
    let pre = if nums.len() > 3 && t.len() > consumed {
        let rest = &t[consumed..];
        if rest.is_empty() { None } else { Some(rest.to_string()) }
    } else {
        None
    };
    Some((major, minor, patch, pre))
}

/// 预发布段比较：数字段按数值、字母段按字典序；数字段 < 字母段；短者更小。
fn compare_pre(a: &str, b: &str) -> i32 {
    let as_: Vec<&str> = a.split(['.', '-']).collect();
    let bs_: Vec<&str> = b.split(['.', '-']).collect();
    let n = as_.len().max(bs_.len());
    for i in 0..n {
        let x = as_.get(i).copied();
        let y = bs_.get(i).copied();
        match (x, y) {
            (None, _) => return -1,
            (_, None) => return 1,
            (Some(xs), Some(ys)) => {
                let xn = xs.parse::<u64>().ok();
                let yn = ys.parse::<u64>().ok();
                match (xn, yn) {
                    (Some(xn), Some(yn)) => {
                        if xn != yn {
                            return if xn < yn { -1 } else { 1 };
                        }
                    }
                    (Some(_), None) => return -1, // 数字段 < 字母段
                    (None, Some(_)) => return 1,
                    (None, None) => {
                        let c = xs.cmp(ys);
                        if c != Ordering::Equal {
                            return if c == Ordering::Less { -1 } else { 1 };
                        }
                    }
                }
            }
        }
    }
    0
}

/// 比较两个版本 tag：a < b -> -1，相等 -> 0，a > b -> 1。
/// 非语义化 tag 回退字符串比较（确定性）。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    match (parse_version(a), parse_version(b)) {
        (Some((ma, na, pa, prea)), Some((mb, nb, pb, preb))) => {
            if ma != mb {
                return if ma < mb { -1 } else { 1 };
            }
            if na != nb {
                return if na < nb { -1 } else { 1 };
            }
            if pa != pb {
                return if pa < pb { -1 } else { 1 };
            }
            match (prea, preb) {
                (None, None) => 0,
                (Some(_), None) => -1, // 有预发布段 < 无预发布段
                (None, Some(_)) => 1,
                (Some(x), Some(y)) => compare_pre(&x, &y),
            }
        }
        _ => {
            // 非语义化回退字符串比较
            let na = normalize_tag(a);
            let nb = normalize_tag(b);
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

// ---------------------------------------------------------------------------
// update_check
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn update_check(
    owner: Option<String>,
    repo: Option<String>,
    current_version: Option<String>,
    app: AppHandle,
) -> UpdateCheckResult {
    let owner = owner.unwrap_or_else(|| DEFAULT_OWNER.to_string());
    let repo = repo.unwrap_or_else(|| DEFAULT_REPO.to_string());
    let current = current_version.unwrap_or_else(|| app.package_info().version.to_string());

    // 仅允许简单的 owner/repo（防 URL 注入），异常值静默失败
    let safe_owner = sanitize_owner_repo(&owner);
    let safe_repo = sanitize_owner_repo(&repo);
    if safe_owner.is_empty() || safe_repo.is_empty() {
        return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None };
    }

    let api_url = format!("{}{}/{}/releases/latest", GITHUB_API, safe_owner, safe_repo);

    // ureq 为阻塞调用，放 spawn_blocking 避免阻塞异步运行时
    let resp = match tauri::async_runtime::spawn_blocking(move || {
        ureq::AgentBuilder::new()
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .get(&api_url)
            .call()
    })
    .await
    {
        Ok(r) => r,
        Err(_) => return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None },
    };

    let response = match resp {
        Ok(r) => r,
        Err(_) => return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None },
    };
    // TODO(verify): ureq 2.x Response 状态码/读取 API（status() / into_string()）
    if response.status() != 200 {
        return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None };
    }
    let body = match response.into_string() {
        Ok(b) => b,
        Err(_) => return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None },
    };
    let data: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None },
    };

    let tag = match data.get("tag_name").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return UpdateCheckResult { ok: false, has_update: None, current: None, latest: None, url: None },
    };
    let url = data
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}{}/{}/releases", GITHUB_WEB, safe_owner, safe_repo));

    let cmp = compare_versions(&tag, &current);
    UpdateCheckResult {
        ok: true,
        has_update: Some(cmp > 0),
        current: Some(current),
        latest: Some(tag),
        url: Some(url),
    }
}

/// owner/repo 白名单：仅保留 [A-Za-z0-9._-]，去首尾斜杠；空或超长返回空串。
fn sanitize_owner_repo(s: &str) -> String {
    let t: String = s
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if t.is_empty() || t.len() > 100 {
        String::new()
    } else {
        t
    }
}
