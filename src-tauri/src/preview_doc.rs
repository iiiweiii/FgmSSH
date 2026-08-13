//! 图片预览 / 文档查看器 (SPEC §2 命令实现)
//!
//! 设计要点 (与 Electron 版 doc:open/preview:open 系列对齐):
//! - 临时文件统一存放于 `app.path().app_cache_dir()/preview_tmp/`, 由自定义协议
//!   `nimbus-preview://<filename>` / `nimbus-doc://<filename>` 提供给渲染层加载。
//! - 主进程内部 SFTP 流式下载 (不走 approved_local_paths 登记): 预览/查看是经主进程
//!   主动行为, 仅 saveAs 触发用户选择的保存路径走 approved_local_paths 消费校验。
//! - 文件名格式 (防目录穿越 + 类型隔离): 预览 `nimbus-<ms>-<seq><ext>`, 文档 `nimbus-doc-<ms>-<seq><ext>`。
//!   preview 协议排除 nimbus-doc- 前缀, doc 协议只允许 nimbus-doc- 前缀。
//! - 注册表统一: preview_open / doc_open 成功后写入 REGISTRY; 协议回调只允许
//!   已登记文件名; preview_close / doc_close 清理临时文件 + 移出注册。
//! - 大文件分段 (与 editor-highlight.js 一致): 文本类 > 2MB 仅下载前 512KB,
//!   doc_load_full 追加剩余; PDF/DOCX ≤ 100MB、文本 ≤ 32MB 硬上限。
//! - 启动清理: 扫描 preview_tmp 下 mtime > 24h 的 nimbus-* 文件删除, 同时清理
//!   registry 中已不存在的孤儿 (app 重启后残留的过夜临时文件)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::audit::AuditEntry;
use crate::state::AppState;

// ================= 常量 (与 Electron 版常量严格对齐) =================

/// 图片预览白名单 (team-lead 规格, 收敛 Electron 版去 .bmp)。
const PREVIEW_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

/// 文档白名单 (文本类 + 二进制类)。
const DOC_EXTENSIONS: &[&str] = &[
    ".txt", ".log", ".md", ".json", ".yml", ".yaml", ".sh", ".py", ".js", ".ts",
    ".html", ".css", ".xml", ".conf", ".ini", ".csv",
    ".pdf", ".docx", ".doc",
];
/// 文本类 (可在查看器内编辑并保存回远端)。
const TEXT_DOC_EXTENSIONS: &[&str] = &[
    ".txt", ".log", ".md", ".json", ".yml", ".yaml", ".sh", ".py", ".js", ".ts",
    ".html", ".css", ".xml", ".conf", ".ini", ".csv",
];

/// 文本类分段阈值 (与 editor-highlight.js DOC_SEGMENT_THRESHOLD 一致: 2MB)。
const DOC_SEGMENT_THRESHOLD: u64 = 2 * 1024 * 1024;
/// 文本类分段预览字节数 (与 DOC_PREVIEW_BYTES 一致: 512KB)。
const DOC_PREVIEW_BYTES: u64 = 512 * 1024;
/// 二进制 (PDF/DOCX) 大小上限 (team-lead 规格)。
const BINARY_DOC_MAX: u64 = 100 * 1024 * 1024;
/// 文本类大小上限 (team-lead 规格)。
const TEXT_DOC_MAX: u64 = 32 * 1024 * 1024;
/// 启动清理过期 mtime 阈值 (24h)。
const CLEANUP_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// 临时文件名长度上限 (与 Electron 版 isSafeDocFilename / isSafePreviewFilename 一致)。
const FILENAME_MAX_LEN: usize = 200;

// ================= 模块全局状态 =================

/// 临时文件根目录 (由 init 设置)。
static PREVIEW_TMP: OnceLock<PathBuf> = OnceLock::new();

/// 统一注册表: filename -> RegEntry。
/// preview 协议和 doc 协议回调都通过此表校验 (team-lead 规格: 已登记文件名)。
static REGISTRY: OnceLock<Mutex<HashMap<String, RegEntry>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
enum RegKind {
    Preview,
    Doc,
}

#[derive(Clone, Debug)]
struct RegEntry {
    kind: RegKind,
    session_id: String,
    /// 仅 Doc: 远端路径 + 分段信息。
    remote_path: String,
    truncated: bool,
    loaded_bytes: u64,
    total_size: u64,
}

fn registry() -> &'static Mutex<HashMap<String, RegEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_tmp() -> &'static PathBuf {
    PREVIEW_TMP.get().expect("preview_doc::init must be called first")
}

fn ensure_tmp_dir() -> Result<(), String> {
    std::fs::create_dir_all(preview_tmp()).map_err(|_| "创建临时目录失败".to_string())
}

/// 启动初始化: 由 lib.rs setup 调用一次。
/// 设置 preview_tmp 目录 + 启动清理过期文件 + 清理 orphan 注册。
pub fn init(app: &AppHandle) -> Result<(), String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "获取缓存目录失败".to_string())?;
    let tmp = cache.join("preview_tmp");
    std::fs::create_dir_all(&tmp).map_err(|_| "创建 preview_tmp 失败".to_string())?;
    // OnceLock::set 在已设置时返回 Err; 幂等 init 容错忽略。
    let _ = PREVIEW_TMP.set(tmp.clone());

    // 确保 registry 已初始化。
    let _ = registry();

    cleanup_expired(&tmp, CLEANUP_MAX_AGE_SECS);
    let _ = prune_orphans(&tmp);
    Ok(())
}

/// 清理 mtime > max_age_secs 的临时文件 (仅清理本模块生成的前缀文件)。
fn cleanup_expired(dir: &Path, max_age_secs: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        // 仅清理本模块生成的文件 (nimbus- 前缀)
        if !name.starts_with("nimbus-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(mtime) = meta.modified() else {
            continue;
        };
        let age = mtime
            .duration_since(UNIX_EPOCH)
            .map(|d| now.saturating_sub(d.as_secs()))
            .unwrap_or(0);
        if age > max_age_secs {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 移除注册表中临时文件已不存在的孤儿条目。
fn prune_orphans(dir: &PathBuf) -> Result<(), String> {
    let to_remove: Vec<String> = {
        let guard = registry().lock().unwrap();
        guard
            .iter()
            .filter_map(|(filename, _)| {
                let p = dir.join(filename);
                if p.exists() {
                    None
                } else {
                    Some(filename.clone())
                }
            })
            .collect()
    };
    if to_remove.is_empty() {
        return Ok(());
    }
    let mut guard = registry().lock().unwrap();
    for k in to_remove {
        guard.remove(&k);
    }
    Ok(())
}

// ================= 校验 =================

/// 远端路径安全: 复用 sftp::is_safe_remote_path (pub) 保证与 sftp 命令一致。
fn is_safe_remote_path(p: &str) -> bool {
    crate::sftp::is_safe_remote_path(p)
}

/// 预览临时文件名校验: nimbus- 前缀, 非 nimbus-doc-, 无路径分隔符与 .. (防目录穿越 + 类型隔离)。
fn is_safe_preview_filename(filename: &str) -> bool {
    if filename.is_empty() || filename.len() > FILENAME_MAX_LEN {
        return false;
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return false;
    }
    filename.starts_with("nimbus-") && !filename.starts_with("nimbus-doc-")
}

/// 文档临时文件名校验: nimbus-doc- 前缀。
fn is_safe_doc_filename(filename: &str) -> bool {
    if filename.is_empty() || filename.len() > FILENAME_MAX_LEN {
        return false;
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return false;
    }
    filename.starts_with("nimbus-doc-")
}

// ================= 文件名生成 =================

/// 唯一临时文件名: `{prefix}-{ms_hex}-{seq_hex}{ext}`。
fn gen_filename(prefix: &str, ext: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{:x}-{:x}{}", prefix, ms, seq, ext)
}

// ================= Mime / 扩展名 =================

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".pdf" => "application/pdf",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc" => "application/msword",
        _ => "text/plain; charset=utf-8",
    }
}

fn ext_of(p: &str) -> String {
    Path::new(p)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn kind_for_ext(ext: &str) -> &'static str {
    match ext {
        ".pdf" => "pdf",
        ".docx" | ".doc" => "docx",
        _ => "text",
    }
}

fn display_name(remote_path: &str) -> String {
    Path::new(remote_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(remote_path)
        .to_string()
}

// ================= SFTP 下载辅助 (主进程内部) =================

/// 全量下载到本地路径, 超 max_bytes 报错。用于 preview_open 与 doc_open (非分段)。
async fn sftp_download_full(
    sftp: &std::sync::Arc<russh_sftp::client::SftpSession>,
    remote_path: &str,
    local_path: &Path,
    max_bytes: u64,
) -> Result<u64, String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|_| "读取远端文件失败".to_string())?;
    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|_| "下载失败".to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > max_bytes {
            // 清理半成品本地文件
            drop(file);
            let _ = std::fs::remove_file(local_path);
            return Err(format!(
                "文件超过 {}MB 大小上限",
                max_bytes / (1024 * 1024)
            ));
        }
        file.write_all(&buf[..n])
            .await
            .map_err(|_| "写入本地文件失败".to_string())?;
    }
    file.flush()
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    Ok(total)
}

/// 分段下载: 仅前 max_bytes 字节 (doc_open 大文件分段预览用)。
async fn sftp_download_partial(
    sftp: &std::sync::Arc<russh_sftp::client::SftpSession>,
    remote_path: &str,
    local_path: &Path,
    max_bytes: u64,
) -> Result<u64, String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|_| "读取远端文件失败".to_string())?;
    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    while total < max_bytes {
        let want = ((max_bytes - total) as usize).min(buf.len());
        let n = match remote.read(&mut buf[..want]).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return Err("下载失败".to_string()),
        };
        file.write_all(&buf[..n])
            .await
            .map_err(|_| "写入本地文件失败".to_string())?;
        total += n as u64;
    }
    file.flush()
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    Ok(total)
}

/// 追加远端 offset 起的剩余字节到本地文件 (doc_load_full 用)。
async fn sftp_append_tail(
    sftp: &std::sync::Arc<russh_sftp::client::SftpSession>,
    remote_path: &str,
    local_path: &Path,
    offset: u64,
) -> Result<u64, String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|_| "读取远端文件失败".to_string())?;
    if offset > 0 {
        remote
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| "读取远端文件失败".to_string())?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(local_path)
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = match remote.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return Err("读取远端失败".to_string()),
        };
        file.write_all(&buf[..n])
            .await
            .map_err(|_| "写入本地文件失败".to_string())?;
        total += n as u64;
    }
    file.flush()
        .await
        .map_err(|_| "写入本地文件失败".to_string())?;
    Ok(total)
}

/// 远端写流 (doc_save 用, WRITE|CREATE|TRUNCATE 覆盖)。
async fn sftp_overwrite_write(
    sftp: &std::sync::Arc<russh_sftp::client::SftpSession>,
    remote_path: &str,
    content: &[u8],
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;
    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|_| "保存失败".to_string())?;
    remote
        .write_all(content)
        .await
        .map_err(|_| "保存失败".to_string())?;
    remote.flush().await.map_err(|_| "保存失败".to_string())?;
    Ok(())
}

// ================= 返回结构 (兼容 renderer.js) =================

/// preview_open 返回 (renderer.js 2700 用 res.ok + res.url + res.name)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// doc_open 返回 (renderer.js 2026-2038 用 name/filename/url/ext/isText/truncated/totalSize/previewText;
/// team-lead 规格加 kind: "pdf"|"docx"|"text")。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub url: String,
    pub name: String,
    pub filename: String,
    pub ext: String,
    pub is_text: bool,
    pub truncated: bool,
    pub total_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_text: Option<String>,
    pub kind: String,
}

fn err_doc(e: &str) -> DocOpenResult {
    DocOpenResult {
        ok: false,
        error: Some(e.to_string()),
        url: String::new(),
        name: String::new(),
        filename: String::new(),
        ext: String::new(),
        is_text: false,
        truncated: false,
        total_size: 0,
        preview_text: None,
        kind: String::new(),
    }
}

// ================= 命令 (SPEC §2) =================

/// preview_open(session_id, remote_path, state):
/// 白名单图片 -> 主进程内部 SFTP 流式下载到 preview_tmp/ -> 登记 REGISTRY ->
/// 返回 nimbus-preview://<filename>。
#[tauri::command]
pub async fn preview_open(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> PreviewOpenResult {
    if !is_safe_remote_path(&remote_path) {
        return PreviewOpenResult {
            ok: false,
            error: Some("路径包含非法段 (..)".into()),
            url: None,
            filename: None,
            name: None,
        };
    }
    let ext = ext_of(&remote_path);
    if !PREVIEW_EXTENSIONS.contains(&ext.as_str()) {
        return PreviewOpenResult {
            ok: false,
            error: Some("不支持预览该文件类型".into()),
            url: None,
            filename: None,
            name: None,
        };
    }
    if ensure_tmp_dir().is_err() {
        return PreviewOpenResult {
            ok: false,
            error: Some("创建临时目录失败".into()),
            url: None,
            filename: None,
            name: None,
        };
    }

    let sftp = match crate::sftp::get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => {
            crate::audit::log(AuditEntry {
                r#type: Some("preview.open".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("failure".into()),
                detail: Some(e),
                ..Default::default()
            });
            return PreviewOpenResult {
                ok: false,
                error: Some("会话不存在或未就绪".into()),
                url: None,
                filename: None,
                name: None,
            };
        }
    };

    let filename = gen_filename("nimbus", &ext);
    let local_path = preview_tmp().join(&filename);

    match sftp_download_full(&sftp, &remote_path, &local_path, BINARY_DOC_MAX).await {
        Ok(_) => {
            registry().lock().unwrap().insert(
                filename.clone(),
                RegEntry {
                    kind: RegKind::Preview,
                    session_id: session_id.clone(),
                    remote_path: String::new(),
                    truncated: false,
                    loaded_bytes: 0,
                    total_size: 0,
                },
            );
            let name = display_name(&remote_path);
            crate::audit::log(AuditEntry {
                r#type: Some("preview.open".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("success".into()),
                detail: Some(format!("图片预览: {}", name)),
                ..Default::default()
            });
            PreviewOpenResult {
                ok: true,
                error: None,
                url: Some(format!("nimbus-preview://{}", filename)),
                filename: Some(filename),
                name: Some(name),
            }
        }
        Err(e) => {
            crate::audit::log(AuditEntry {
                r#type: Some("preview.open".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("failure".into()),
                detail: Some(e.clone()),
                ..Default::default()
            });
            PreviewOpenResult {
                ok: false,
                error: Some(e),
                url: None,
                filename: None,
                name: None,
            }
        }
    }
}

/// preview_close(filename): 删临时文件 + 移出注册。
#[tauri::command]
pub fn preview_close(filename: String) -> crate::CmdOk {
    if !is_safe_preview_filename(&filename) {
        return crate::CmdOk::failure("非法的预览文件名");
    }
    let local_path = preview_tmp().join(&filename);
    let _ = std::fs::remove_file(&local_path);
    registry().lock().unwrap().remove(&filename);
    crate::CmdOk::success()
}

/// preview_save_as(session_id, remote_path, state): 弹保存对话框 -> 登记 approved_local_paths
/// -> 复用 sftp::sftp_download 写流到目标路径并审计。
/// TODO(verify): tauri-plugin-dialog 2 blocking_save_file 从 async command 调用在 Windows
/// 的合法性; 当前与 lib.rs::dialog_select_* 同样模式 (已知可能在 Windows 需额外处理)。
#[tauri::command]
pub async fn preview_save_as(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> crate::CmdOk {
    if !is_safe_remote_path(&remote_path) {
        return crate::CmdOk::failure("路径包含非法段 (..)");
    }
    // 默认文件名清洗: 去路径分隔符防默认名被用作目录穿越
    let safe_name = display_name(&remote_path)
        .replace(['\\', '/'], "_");
    let picked = app
        .dialog()
        .file()
        .set_title("保存图片")
        .set_file_name(&safe_name)
        .blocking_save_file();
    let file_path = match picked.and_then(|fp| fp.into_path().ok()) {
        Some(p) => p,
        None => return crate::CmdOk::failure("已取消"),
    };
    let local = file_path.to_string_lossy().to_string();
    // 登记 approved_local_paths -> 交 sftp_download 消费移除
    if let Ok(mut guard) = state.approved_local_paths.lock() {
        guard.insert(local.clone());
    }
    // 复用 sftp::sftp_download (主进程内部函数调用, 非经 invoke; State 可 Copy 直接传)。
    let res = crate::sftp::sftp_download(
        session_id.clone(),
        remote_path.clone(),
        local,
        state,
        app.clone(),
    )
    .await;
    crate::audit::log(AuditEntry {
        r#type: Some("preview.saveAs".into()),
        session: Some(session_id),
        target: Some(remote_path),
        result: Some(if res.ok { "success" } else { "failure" }.into()),
        detail: if res.ok {
            None
        } else {
            res.error.clone()
        },
        ..Default::default()
    });
    if res.ok {
        crate::CmdOk::success()
    } else {
        crate::CmdOk::failure(res.error.unwrap_or_else(|| "保存失败".into()))
    }
}

/// doc_open(session_id, remote_path, state):
/// 白名单扩展名 -> 主进程内部 SFTP 下载到 preview_tmp/ -> REGISTRY 登记 -> 返回 nimbus-doc://<filename>。
/// 大小上限: PDF/DOCX≤100MB, 文本≤32MB; 文本类 > 2MB 自动分段 (truncated + previewText)。
#[tauri::command]
pub async fn doc_open(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> DocOpenResult {
    if !is_safe_remote_path(&remote_path) {
        return err_doc("路径包含非法段 (..)");
    }
    let ext = ext_of(&remote_path);
    if !DOC_EXTENSIONS.contains(&ext.as_str()) {
        return err_doc("不支持打开该文件类型");
    }
    if ensure_tmp_dir().is_err() {
        return err_doc("创建临时目录失败");
    }

    let sftp = match crate::sftp::get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => {
            crate::audit::log(AuditEntry {
                r#type: Some("doc.open".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("failure".into()),
                detail: Some(e),
                ..Default::default()
            });
            return err_doc("会话不存在或未就绪");
        }
    };

    // 远端大小 (stat 失败按 0 -> 走全量下载; max_bytes 兜底)。
    let total_size: u64 = sftp
        .metadata(&remote_path)
        .await
        .ok()
        .map(|a| a.len())
        .unwrap_or(0);

    let is_text = TEXT_DOC_EXTENSIONS.contains(&ext.as_str());
    let max_bytes = if is_text { TEXT_DOC_MAX } else { BINARY_DOC_MAX };
    if total_size > max_bytes {
        return err_doc(&format!(
            "文件超过 {}MB 大小上限",
            max_bytes / (1024 * 1024)
        ));
    }

    let filename = gen_filename("nimbus-doc", &ext);
    let local_path = preview_tmp().join(&filename);

    let truncated = is_text && total_size > DOC_SEGMENT_THRESHOLD;
    let preview_limit = if truncated {
        total_size.min(DOC_PREVIEW_BYTES)
    } else {
        total_size
    };

    let dl = if truncated {
        sftp_download_partial(&sftp, &remote_path, &local_path, preview_limit).await
    } else {
        sftp_download_full(&sftp, &remote_path, &local_path, max_bytes).await
    };
    if let Err(e) = dl {
        crate::audit::log(AuditEntry {
            r#type: Some("doc.open".into()),
            session: Some(session_id),
            target: Some(remote_path),
            result: Some("failure".into()),
            detail: Some(e.clone()),
            ..Default::default()
        });
        return err_doc(&e);
    }

    let loaded_bytes = if truncated { preview_limit } else { total_size };
    registry().lock().unwrap().insert(
        filename.clone(),
        RegEntry {
            kind: RegKind::Doc,
            session_id: session_id.clone(),
            remote_path: remote_path.clone(),
            truncated,
            loaded_bytes,
            total_size,
        },
    );

    let preview_text = if truncated {
        std::fs::read_to_string(&local_path).unwrap_or_default()
    } else {
        String::new()
    };
    let name = display_name(&remote_path);
    crate::audit::log(AuditEntry {
        r#type: Some("doc.open".into()),
        session: Some(session_id),
        target: Some(remote_path),
        result: Some("success".into()),
        detail: Some(if truncated {
            format!(
                "打开文档: {} (大文件分段预览 {} / {} 字节)",
                name, preview_limit, total_size
            )
        } else {
            format!("打开文档: {}", name)
        }),
        ..Default::default()
    });

    DocOpenResult {
        ok: true,
        error: None,
        url: format!("nimbus-doc://{}", filename),
        name,
        filename,
        ext,
        is_text,
        truncated,
        total_size,
        preview_text: if truncated {
            Some(preview_text)
        } else {
            None
        },
        kind: kind_for_ext(&ext).to_string(),
    }
}

/// doc_load_full(session_id, filename, state):
/// 仅 truncated=true 时追加远端剩余字节到本地; 完成后续渲染层重新 fetch 完整内容。
/// 安全: filename 校验 + registry 匹配 sessionId。
#[tauri::command]
pub async fn doc_load_full(
    session_id: String,
    filename: String,
    state: State<'_, AppState>,
) -> serde_json::Value {
    if !is_safe_doc_filename(&filename) {
        return serde_json::json!({ "ok": false, "error": "非法的文档文件名" });
    }
    let entry = {
        let guard = registry().lock().unwrap();
        guard.get(&filename).cloned()
    };
    let entry = match entry {
        Some(e) => e,
        None => {
            return serde_json::json!({
                "ok": false,
                "error": "文档未打开或会话不符"
            })
        }
    };
    if entry.session_id != session_id || entry.kind != RegKind::Doc {
        return serde_json::json!({
            "ok": false,
            "error": "文档未打开或会话不符"
        });
    }
    if !entry.truncated {
        return serde_json::json!({ "ok": true, "totalSize": entry.total_size });
    }

    let sftp = match crate::sftp::get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => {
            crate::audit::log(AuditEntry {
                r#type: Some("doc.loadFull".into()),
                session: Some(session_id),
                target: Some(entry.remote_path.clone()),
                result: Some("failure".into()),
                detail: Some(e),
                ..Default::default()
            });
            return serde_json::json!({ "ok": false, "error": "会话不存在或未就绪" });
        }
    };

    let local_path = preview_tmp().join(&filename);
    match sftp_append_tail(&sftp, &entry.remote_path, &local_path, entry.loaded_bytes).await {
        Ok(_) => {
            registry().lock().unwrap().insert(
                filename.clone(),
                RegEntry {
                    kind: RegKind::Doc,
                    session_id: entry.session_id.clone(),
                    remote_path: entry.remote_path.clone(),
                    truncated: false,
                    loaded_bytes: entry.total_size,
                    total_size: entry.total_size,
                },
            );
            crate::audit::log(AuditEntry {
                r#type: Some("doc.loadFull".into()),
                session: Some(session_id),
                target: Some(entry.remote_path.clone()),
                result: Some("success".into()),
                detail: Some(format!("加载全部 {} 字节", entry.total_size)),
                ..Default::default()
            });
            serde_json::json!({ "ok": true, "totalSize": entry.total_size })
        }
        Err(e) => {
            crate::audit::log(AuditEntry {
                r#type: Some("doc.loadFull".into()),
                session: Some(session_id),
                target: Some(entry.remote_path.clone()),
                result: Some("failure".into()),
                detail: Some(e.clone()),
                ..Default::default()
            });
            serde_json::json!({ "ok": false, "error": e })
        }
    }
}

/// doc_save(session_id, remote_path, content, state):
/// 仅文本类 + 必须经 doc_open 在当前会话打开过的来源才回写远端 (P2 安全加固)。
/// 写流: WRITE|CREATE|TRUNCATE 全量覆盖。
#[tauri::command]
pub async fn doc_save(
    session_id: String,
    remote_path: String,
    content: String,
    state: State<'_, AppState>,
) -> crate::CmdOk {
    if !is_safe_remote_path(&remote_path) {
        return crate::CmdOk::failure("路径包含非法段 (..)");
    }
    let ext = ext_of(&remote_path);
    if !TEXT_DOC_EXTENSIONS.contains(&ext.as_str()) {
        return crate::CmdOk::failure("文档未打开或类型不支持编辑");
    }
    let opened = {
        let guard = registry().lock().unwrap();
        guard.values().any(|v| {
            v.kind == RegKind::Doc
                && v.session_id == session_id
                && v.remote_path == remote_path
        })
    };
    if !opened {
        return crate::CmdOk::failure("文档未打开或类型不支持编辑");
    }

    let sftp = match crate::sftp::get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(_) => return crate::CmdOk::failure("会话不存在或未就绪"),
    };

    match sftp_overwrite_write(&sftp, &remote_path, content.as_bytes()).await {
        Ok(()) => {
            crate::audit::log(AuditEntry {
                r#type: Some("doc.save".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("success".into()),
                ..Default::default()
            });
            crate::CmdOk::success()
        }
        Err(_) => {
            crate::audit::log(AuditEntry {
                r#type: Some("doc.save".into()),
                session: Some(session_id),
                target: Some(remote_path),
                result: Some("failure".into()),
                detail: Some("写入或刷新失败".into()),
                ..Default::default()
            });
            crate::CmdOk::failure("保存失败")
        }
    }
}

/// doc_close(filename): 删临时文件 + 移出注册。
#[tauri::command]
pub fn doc_close(filename: String) -> crate::CmdOk {
    if !is_safe_doc_filename(&filename) {
        return crate::CmdOk::failure("非法的文档文件名");
    }
    let local_path = preview_tmp().join(&filename);
    let _ = std::fs::remove_file(&local_path);
    registry().lock().unwrap().remove(&filename);
    crate::CmdOk::success()
}

// ================= URI scheme 协议回调辅助 (供 lib.rs 注册) =================

/// 解析协议请求 URL 中的 filename (兼容 `nimbus-preview://<filename>` 与 `nimbus-preview:///<filename>`)。
/// 不依赖 url crate, 自实现百分号解码 (URL 路径段)。
pub fn parse_protocol_filename(request_url: &str) -> Option<String> {
    let after = request_url.splitn(2, "://").nth(1)?;
    let raw = after.trim_start_matches('/');
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);
    if raw.is_empty() {
        return None;
    }
    percent_decode(raw)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            let hex = &bytes[i + 1..i + 3];
            if let Ok(c) = u8::from_str_radix(std::str::from_utf8(hex).unwrap_or(""), 16) {
                out.push(c);
                i += 3;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// 协议回调读取已登记的临时文件 -> (bytes, mime_content_type)。
/// expect_kind: "preview" 或 "doc", 校验文件名格式与注册表登记一致性。
pub fn read_registered_tmp(filename: &str, expect_kind: &str) -> Option<(Vec<u8>, &'static str)> {
    let safe = match expect_kind {
        "preview" => is_safe_preview_filename(filename),
        "doc" => is_safe_doc_filename(filename),
        _ => return None,
    };
    if !safe {
        return None;
    }
    let reg_kind = match expect_kind {
        "preview" => RegKind::Preview,
        "doc" => RegKind::Doc,
        _ => return None,
    };
    let reg_hit = {
        let guard = registry().lock().unwrap();
        guard.get(filename).map(|e| e.kind == reg_kind).unwrap_or(false)
    };
    if !reg_hit {
        return None;
    }
    let p = preview_tmp().join(filename);
    let data = std::fs::read(&p).ok()?;
    let ext = ext_of(filename);
    Some((data, mime_for_ext(&ext)))
}