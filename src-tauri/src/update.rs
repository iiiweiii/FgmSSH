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
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GITHUB_API: &str = "https://api.github.com/repos/";
const GITHUB_WEB: &str = "https://github.com/";
const DEFAULT_OWNER: &str = "iiiweiii";
const DEFAULT_REPO: &str = "FgmSSH";
const TIMEOUT: Duration = Duration::from_secs(5);
/// 下载更新包的超时 (安装包数十 MB, 需宽松)
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(900);
const USER_AGENT: &str = "fgm-ssh-update-check";

/// Release 附件 (用于应用内下载更新)。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// 资源 sha256 (GitHub API `digest` 字段; 老资源可能缺省 -> 不校验哈希)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Serialize, Clone)]
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
    /// 该 Release 的附件列表 (应用内下载更新时挑选可用安装包)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<UpdateAsset>,
}

fn failed_check() -> UpdateCheckResult {
    UpdateCheckResult {
        ok: false,
        has_update: None,
        current: None,
        latest: None,
        url: None,
        assets: vec![],
    }
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
    run_check(&app, owner, repo, current_version).await
}

/// 实际执行检查 (命令与启动期静默检查共用)。
pub async fn run_check(
    app: &AppHandle,
    owner: Option<String>,
    repo: Option<String>,
    current_version: Option<String>,
) -> UpdateCheckResult {
    let owner = owner.unwrap_or_else(|| DEFAULT_OWNER.to_string());
    let repo = repo.unwrap_or_else(|| DEFAULT_REPO.to_string());
    let current = current_version.unwrap_or_else(|| app.package_info().version.to_string());

    // 仅允许简单的 owner/repo（防 URL 注入），异常值静默失败
    let safe_owner = sanitize_owner_repo(&owner);
    let safe_repo = sanitize_owner_repo(&repo);
    if safe_owner.is_empty() || safe_repo.is_empty() {
        return failed_check();
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
        Err(_) => return failed_check(),
    };

    let response = match resp {
        Ok(r) => r,
        Err(_) => return failed_check(),
    };
    // TODO(verify): ureq 2.x Response 状态码/读取 API（status() / into_string()）
    if response.status() != 200 {
        return failed_check();
    }
    let body = match response.into_string() {
        Ok(b) => b,
        Err(_) => return failed_check(),
    };
    let data: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return failed_check(),
    };

    let tag = match data.get("tag_name").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return failed_check(),
    };
    let url = data
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}{}/{}/releases", GITHUB_WEB, safe_owner, safe_repo));

    // 附件列表 (应用内下载更新用): 仅保留 https 且可下载的 .exe
    let mut assets: Vec<UpdateAsset> = vec![];
    if let Some(arr) = data.get("assets").and_then(|v| v.as_array()) {
        for a in arr {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let dl = a.get("browser_download_url").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() || dl.is_empty() || !is_allowed_download_url(dl) {
                continue;
            }
            if !name.to_ascii_lowercase().ends_with(".exe") {
                continue;
            }
            assets.push(UpdateAsset {
                name: name.to_string(),
                url: dl.to_string(),
                size: a.get("size").and_then(|v| v.as_u64()),
                sha256: a
                    .get("digest")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim_start_matches("sha256:").to_ascii_lowercase())
                    .filter(|s| s.len() == 64),
            });
        }
    }

    let cmp = compare_versions(&tag, &current);
    UpdateCheckResult {
        ok: true,
        has_update: Some(cmp > 0),
        current: Some(current),
        latest: Some(tag),
        url: Some(url),
        assets,
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

// ---------------------------------------------------------------------------
// 应用内下载 + 自替换更新 (update_download / update_apply)
// ---------------------------------------------------------------------------
//
// 流程: 前端选中 Release 附件 (优先 portable exe) -> update_download 流式下载到
// 临时目录 (带 update:progress 进度事件 + sha256 校验) -> update_apply 校验 MZ 头后
// 启动一个 PowerShell 助手: 等待本进程退出 -> 覆盖当前 exe -> 重新启动 -> 清理临时文件,
// 本进程随即退出。可同时用于便携版与 NSIS 安装版 (安装目录在用户可写位置)。

const DOWNLOAD_CHUNK: usize = 64 * 1024;
/// 心跳式进度上报间隔 (避免每 64KB 都发事件)
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn download_failed(msg: impl Into<String>) -> DownloadResult {
    DownloadResult { ok: false, path: None, error: Some(msg.into()) }
}

/// 仅允许 GitHub 官方下载域 (发布附件会 302 到 objects.githubusercontent.com)
fn is_allowed_download_url(url: &str) -> bool {
    url.starts_with("https://github.com/")
        || url.starts_with("https://objects.githubusercontent.com/")
}

/// 从 URL 末段提取安全的文件名 (仅 [A-Za-z0-9._-], 且必须以 .exe 结尾)
fn safe_exe_name(url: &str) -> Option<String> {
    let no_query = url.split('?').next().unwrap_or(url);
    let last = no_query.rsplit('/').next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if cleaned.len() >= 5 && cleaned.to_ascii_lowercase().ends_with(".exe") {
        Some(cleaned)
    } else {
        None
    }
}

/// 下载更新包到临时目录 (流式 + 进度事件 + 可选 sha256 校验)。
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    url: String,
    sha256: Option<String>,
) -> DownloadResult {
    if !is_allowed_download_url(&url) {
        return download_failed("更新地址不受信任");
    }
    let file_name = match safe_exe_name(&url) {
        Some(n) => n,
        None => return download_failed("更新包文件名非法"),
    };
    let dir = std::env::temp_dir().join("fgmssh-update");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return download_failed(format!("无法创建临时目录: {e}"));
    }
    let dest = dir.join(&file_name);

    let app_ref = app.clone();
    let expected = sha256.map(|s| s.trim().to_ascii_lowercase()).filter(|s| s.len() == 64);
    let url_owned = url.clone();
    let dest_owned = dest.clone();

    let res = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};

        let agent = ureq::AgentBuilder::new()
            .timeout(DOWNLOAD_TIMEOUT)
            .user_agent(USER_AGENT)
            .build();
        let resp = agent
            .get(&url_owned)
            .call()
            .map_err(|e| format!("网络错误: {e}"))?;
        if resp.status() != 200 {
            return Err(format!("下载失败: HTTP {}", resp.status()));
        }
        let total: Option<u64> = resp
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok());

        let mut reader = resp.into_reader();
        let mut file = std::fs::File::create(&dest_owned)
            .map_err(|e| format!("无法写入临时文件: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; DOWNLOAD_CHUNK];
        let mut received: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        let mut emit = |received: u64, total: Option<u64>, app: &AppHandle| {
            let _ = app.emit(
                "update:progress",
                serde_json::json!({ "received": received, "total": total }),
            );
        };
        emit(0, total, &app_ref);
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("下载中断: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("写入失败: {e}"))?;
            hasher.update(&buf[..n]);
            received += n as u64;
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                last_emit = std::time::Instant::now();
                emit(received, total, &app_ref);
            }
        }
        file.flush().map_err(|e| format!("写入失败: {e}"))?;
        drop(file);
        emit(received, total.or(Some(received)), &app_ref);

        if let Some(expect) = expected {
            let got = format!("{:x}", hasher.finalize());
            if !got.eq_ignore_ascii_case(&expect) {
                let _ = std::fs::remove_file(&dest_owned);
                return Err("校验失败: 安装包哈希不匹配".to_string());
            }
        }
        Ok(())
    })
    .await;

    match res {
        Ok(Ok(())) => DownloadResult {
            ok: true,
            path: Some(dest.to_string_lossy().to_string()),
            error: None,
        },
        Ok(Err(e)) => download_failed(e),
        Err(_) => download_failed("下载任务异常终止"),
    }
}

/// PowerShell 单引号字符串转义
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// 应用更新: 校验更新包 -> 生成自替换助手 (等待本进程退出 -> 覆盖 exe -> 重启) -> 退出本进程。
#[tauri::command]
pub async fn update_apply(app: AppHandle, path: String) -> crate::CmdOk {
    use std::io::Read;

    let src = std::path::PathBuf::from(&path);
    let meta = match std::fs::metadata(&src) {
        Ok(m) => m,
        Err(_) => return crate::CmdOk::failure("更新包不存在"),
    };
    // 安装包至少数百 KB; 过小视为无效 (防误覆盖)
    if !meta.is_file() || meta.len() < 512 * 1024 {
        return crate::CmdOk::failure("更新包无效 (体积异常)");
    }
    let mut f = match std::fs::File::open(&src) {
        Ok(f) => f,
        Err(_) => return crate::CmdOk::failure("无法读取更新包"),
    };
    let mut magic = [0u8; 2];
    if f.read_exact(&mut magic).is_err() || &magic != b"MZ" {
        return crate::CmdOk::failure("更新包不是有效的可执行文件");
    }
    drop(f);

    let current = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return crate::CmdOk::failure("无法定位当前程序路径"),
    };

    // 助手脚本: 等本进程退出 -> 覆盖 -> 启动新版 -> 清理
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'\n\
         try {{ Wait-Process -Id {pid} -Timeout 120 }} catch {{}}\n\
         Start-Sleep -Milliseconds 400\n\
         Copy-Item -LiteralPath '{src}' -Destination '{dst}' -Force\n\
         Start-Process -FilePath '{dst}'\n\
         Start-Sleep -Milliseconds 800\n\
         Remove-Item -LiteralPath '{src}' -Force\n",
        pid = std::process::id(),
        src = ps_quote(&src.to_string_lossy()),
        dst = ps_quote(&current.to_string_lossy()),
    );
    // PowerShell -EncodedCommand 需要 UTF-16LE + base64 (可安全传递中文路径)
    let mut utf16 = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&utf16);

    let spawned = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ])
        .spawn();
    if spawned.is_err() {
        return crate::CmdOk::failure("无法启动更新助手");
    }

    // 稍等前端把「正在重启…」显示出来, 再退出
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.exit(0);
    });
    crate::CmdOk::success()
}
