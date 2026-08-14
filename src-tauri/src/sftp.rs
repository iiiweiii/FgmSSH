//! SFTP 全家桶（sftp）
//!
//! 职责（对应 SPEC 第 2 节命令）：
//!   - `sftp_list`              列目录
//!   - `sftp_download`          下载（断点续传：本地 `<目标>.part` 记录已下载字节）
//!   - `sftp_upload`            上传（断点续传：远端大小 = 已传 offset，flags 'a' 追加）
//!   - `sftp_register_upload_paths`  登记合法本地文件（对话框/拖拽的唯一入口，消费校验）
//!   - `sftp_mkdir` / `sftp_delete` / `sftp_rename` / `sftp_cd_sync` / `sftp_search`
//!   - `sftp_download_folder`   递归下载并 zip 打包（防 zip-slip）
//!
//! 安全要点：
//!   - 本地写入/读取路径必须经 `approved_local_paths` 登记（dialog_select_save_path /
//!     dialog_select_file 登记，本模块消费移除），未登记一律 `路径未经过确认`。
//!   - 远端路径校验：必须绝对路径 + 拒绝 `..` 段。
//!   - sftp_search 走 find 递归：关键字白名单 [A-Za-z0-9_.-] + maxdepth 钳制 ≤10 +
//!     路径单引号转义，无 shell 注入面。
//!   - zip 打包条目名规范化，拒绝绝对路径 / `..` / Windows 盘符（防 zip-slip）。
//!   - 错误信息一律固定友好文案，不泄露远端路径细节 / 堆栈。
//!
//! 依赖 crate::state::AppState（backend-core 提供，已按真实字段对齐）：
//!   - `pub sessions: Arc<std::sync::Mutex<HashMap<String, SessionHandle>>>`
//!   - `pub approved_local_paths: Arc<std::sync::Mutex<HashSet<String>>>`
//!     （dialog_select_save_path / dialog_select_file 由 lib.rs 登记，本模块消费移除）
//!   - `crate::ssh::SessionHandle.sftp: Option<Arc<SftpSession>>`（SftpSession 不可 Clone，
//!     用 Arc 共享；见 get_sftp）+ `handle: SessionHandleInner`（可 Clone，开新通道）
//!     （与 ssh.rs 字段对齐）

use crate::state::AppState;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// 单次拖拽登记上限（防 Set 膨胀，与 Electron 一致）
const MAX_DROP_PATHS: usize = 500;
/// 递归删除最大深度（防符号链接环）
const MAX_DELETE_DEPTH: usize = 50;
/// 文件夹打包下载递归最大深度
const MAX_DOWNLOAD_DEPTH: usize = 100;
/// 递归搜索结果返回上限（find 输出已受 64KB 限制，这里再兜一层）
const MAX_SEARCH_RESULTS: usize = 200;
/// find 搜索默认深度 / 钳制上下限（任务约定上限 10）
const SEARCH_DEFAULT_DEPTH: i64 = 3;
const SEARCH_MAX_DEPTH: i64 = 10;
const SEARCH_MIN_DEPTH: i64 = 1;
/// 搜索关键字长度上限
const MAX_KEYWORD_LEN: usize = 64;
/// 远端路径长度上限
const MAX_REMOTE_PATH_LEN: usize = 4096;
/// 传输块大小
const CHUNK_SIZE: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// 返回结构（serde 统一 camelCase）
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SftpItem {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String, // "file" | "dir"
    /// 前端 renderer.js 用 entry.isDir 判断文件夹 (双击进入/图标/右键菜单), 原实现缺该字段。
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64, // 毫秒时间戳（与 Electron normalizeMtime 语义一致）
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResult {
    pub ok: bool,
    pub path: String,
    /// 注意: 字段名为 entries (前端 renderer.js loadDir 读 res.entries; SPEC 写 items 系笔误)。
    pub entries: Vec<SftpItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResult {
    pub ok: bool,
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRegisterResult {
    pub ok: bool,
    pub count: usize,
    pub accepted: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSimpleResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpCdSyncResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SftpSearchHit {
    pub path: String,
    pub name: String,
    pub dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSearchResult {
    pub ok: bool,
    pub results: Vec<SftpSearchHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 进度事件负载（SPEC 3 节：sftp-upload-progress / sftp-download-progress）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgressPayload {
    pub session_id: String,
    pub phase: String,
    pub percent: Option<f64>,
    pub transferred: Option<u64>,
    pub total: Option<u64>,
}

// ---------------------------------------------------------------------------
// 会话 / SFTP 通道获取
// ---------------------------------------------------------------------------

/// 获取会话的 SFTP 通道；未初始化时经会话 handle 懒创建并写回 SessionHandle。
/// 返回 Arc<SftpSession>：russh-sftp 的 SftpSession **不实现 Clone**，故以 Arc 共享
/// （后端 core 在 ssh.rs 中把 SessionHandle.sftp 定义为 Option<Arc<SftpSession>>）。
/// `pub`: 供 preview_doc.rs 复用 (preview/doc 的 SFTP 下载)。
pub async fn get_sftp(state: &AppState, session_id: &str) -> Result<Arc<SftpSession>, String> {
    let handle = {
        let guard = state.sessions.lock().map_err(|_| "会话状态不可用")?;
        let sh = guard.get(session_id).ok_or_else(|| "会话不存在".to_string())?;
        if let Some(sftp) = sh.sftp.clone() {
            return Ok(sftp);
        }
        // ssh.rs 提供 SessionHandleInner (可 Clone), 经它开新通道。
        sh.handle.clone()
    };

    // 懒创建 SFTP 子系统并写回会话（并发重复创建可接受：后写覆盖）
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|_| "SFTP 通道未就绪")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|_| "SFTP 通道未就绪")?;
    let sftp = Arc::new(
        // russh 0.44.x: Channel 本身不实现 AsyncRead/AsyncWrite, 需 into_stream() 转流。
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|_| "SFTP 通道未就绪")?,
    );
    {
        let mut guard = state.sessions.lock().map_err(|_| "会话状态不可用")?;
        if let Some(sh) = guard.get_mut(session_id) {
            sh.sftp = Some(sftp.clone());
        }
    }
    Ok(sftp)
}

/// 从 approved_local_paths 消费并校验路径（消费移除，防重放）。
/// 返回 Ok(path) 时该路径已被消费；未登记返回 Err("路径未经过确认")。
fn consume_approved_path(state: &AppState, path: &str) -> Result<(), String> {
    let mut guard = state
        .approved_local_paths
        .lock()
        .map_err(|_| "路径未经过确认")?;
    if guard.remove(path) {
        Ok(())
    } else {
        Err("路径未经过确认".to_string())
    }
}

// ---------------------------------------------------------------------------
// 路径与元数据工具
// ---------------------------------------------------------------------------

/// 远端路径安全校验：以 / 开头、无 `..` 段、长度上限。
/// `pub`: 供 preview_doc.rs 复用 (preview_open/doc_open/doc_save 远端路径校验)。
pub fn is_safe_remote_path(p: &str) -> bool {
    if p.is_empty() || p.len() > MAX_REMOTE_PATH_LEN || !p.starts_with('/') {
        return false;
    }
    !p.split('/').any(|seg| seg == "..")
}

/// 拼接远端路径（正确处理根路径）
fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{}", name)
    } else {
        let base = base.trim_end_matches('/');
        format!("{}/{}", base, name)
    }
}

/// 判断条目是否为目录。优先 FileAttributes 自带判断，permissions 缺失时回退 symlink_metadata。
/// russh-sftp 2.x: is_dir() 返回 bool (非 Option); lstat 已改名为 symlink_metadata。
async fn entry_is_dir(sftp: &SftpSession, attrs: &FileAttributes, path: &str) -> bool {
    if attrs.is_dir() {
        return true;
    }
    sftp.symlink_metadata(path)
        .await
        .ok()
        .map(|a| a.is_dir())
        .unwrap_or(false)
}

/// 归一化 mtime 为毫秒时间戳（兼容 秒 / 毫秒 两种形态，与 Electron normalizeMtime 一致）
fn normalize_mtime(secs: Option<u64>) -> u64 {
    match secs {
        None => 0,
        Some(v) => {
            if v > 1_000_000_000_000 {
                v // 已是毫秒
            } else {
                v.saturating_mul(1000)
            }
        }
    }
}

/// 单引号 shell 转义（纵深防御；cwd 已通过白名单前置校验）
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 当前毫秒时间戳
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 发射传输进度事件
fn emit_progress(
    app: &AppHandle,
    event: &str,
    session_id: &str,
    phase: &str,
    transferred: u64,
    total: u64,
) {
    let percent = if total > 0 {
        Some(((transferred as f64 / total as f64) * 100.0 * 100.0).round() / 100.0)
    } else {
        None
    };
    let payload = SftpProgressPayload {
        session_id: session_id.to_string(),
        phase: phase.to_string(),
        percent,
        transferred: Some(transferred),
        total: Some(total),
    };
    let _ = app.emit(event, payload);
}

// ---------------------------------------------------------------------------
// sftp_list
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    session_id: String,
    path: String,
) -> SftpListResult {
    let state = app.state::<AppState>();
    let target = if path.is_empty() { "/".to_string() } else { path };
    if !is_safe_remote_path(&target) {
        return list_err(&target, "路径包含非法段");
    }
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return list_err(&target, &e),
    };

    // russh-sftp 2.x: read_dir 返回 ReadDir, 迭代项为 SftpResult<(FileAttributes, String)>。
    let entries = match sftp.read_dir(&target).await {
        Ok(e) => e,
        Err(_) => return list_err(&target, "读取目录失败"),
    };

    let mut items: Vec<SftpItem> = Vec::new();
    // russh-sftp 2.0.0-beta.2: read_dir 迭代项为 DirEntry (file_name()/metadata()/file_type())。
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = entry.metadata();
        let is_dir = entry_is_dir(&sftp, &attrs, &join_remote_path(&target, &name)).await;
        items.push(SftpItem {
            name,
            type_: if is_dir { "dir" } else { "file" }.to_string(),
            is_dir,
            size: attrs.size.unwrap_or(0),
            mtime: normalize_mtime(attrs.mtime.map(|v| v as u64)),
        });
    }

    // 目录优先，再按名称不区分大小写排序（与 Electron 一致）
    items.sort_by(|a, b| {
        if a.type_ != b.type_ {
            return if a.type_ == "dir" { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    SftpListResult {
        ok: true,
        path: target,
        entries: items,
        error: None,
    }
}

fn list_err(path: &str, error: &str) -> SftpListResult {
    SftpListResult {
        ok: false,
        path: path.to_string(),
        entries: Vec::new(),
        error: Some(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// sftp_download / sftp_upload（断点续传）
// ---------------------------------------------------------------------------

/// 解析下载续传状态：
///   - (part_size, true, true)   .part 已写满（== 远端大小），仅需改名
///   - (offset, true, false)     0 < part_size < 远端大小，从 part_size 续传
///   - (0, false, false)         从头下载
fn resolve_download_resume(part_path: &str, remote_size: u64) -> (u64, bool, bool) {
    let part_size = match std::fs::metadata(part_path) {
        Ok(m) => m.len(),
        Err(_) => 0,
    };
    if part_size > 0 && part_size < remote_size {
        return (part_size, true, false);
    }
    if part_size == remote_size && remote_size > 0 {
        return (remote_size, true, true);
    }
    (0, false, false)
}

/// 下载收尾：rename .part -> 目标；目标已存在（上次完成但未改名成功）时删除 .part 视为完成。
async fn finish_download(part_path: &str, target_path: &str) -> Result<(), String> {
    match tokio::fs::rename(part_path, target_path).await {
        Ok(_) => Ok(()),
        Err(_) => {
            if tokio::fs::metadata(target_path).await.is_ok() {
                let _ = tokio::fs::remove_file(part_path).await;
                return Ok(());
            }
            Err("写入本地文件失败".to_string())
        }
    }
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> SftpTransferResult {
    let state = app.state::<AppState>();
    if remote_path.is_empty() || local_path.is_empty() {
        return transfer_err("参数不完整");
    }
    if !is_safe_remote_path(&remote_path) {
        return transfer_err("路径包含非法段");
    }
    // 安全：本地路径必须经对话框登记并消费移除
    if let Err(e) = consume_approved_path(&state, &local_path) {
        return transfer_err(&e);
    }

    // 确保本地父目录存在
    if let Some(parent) = Path::new(&local_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return transfer_err(&e),
    };

    // 远端大小（续传判定 + 进度分母；metadata 失败按 0 处理，走全新下载，读时再报错）
    // russh-sftp 2.x: stat 改名为 metadata。
    let remote_size = match sftp.metadata(&remote_path).await {
        Ok(a) => a.len(),
        Err(_) => 0,
    };

    let part_path = format!("{}.part", local_path);
    let (offset, resumed, complete) = resolve_download_resume(&part_path, remote_size);

    if complete {
        return match finish_download(&part_path, &local_path).await {
            Ok(_) => SftpTransferResult { ok: true, resumed: true, error: None },
            Err(e) => transfer_err(&e),
        };
    }

    // 打开远端文件 (只读; 续传时 seek 到 offset)
    // russh-sftp 2.x: open_with_flags(path, OpenFlags)。
    let mut remote = match sftp.open_with_flags(&remote_path, OpenFlags::READ).await {
        Ok(f) => f,
        Err(_) => return transfer_err("读取远端文件失败"),
    };
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        if remote.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
            return transfer_err("读取远端文件失败");
        }
    }

    // 本地 .part：续传追加写，全量截断写
    let mut local = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&part_path)
        .await
    {
        Ok(f) => f,
        Err(_) => return transfer_err("写入本地文件失败"),
    };

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut transferred = offset;
    loop {
        let n = match remote.read(&mut buf).await {
            Ok(n) => n,
            Err(_) => return transfer_err("下载失败"),
        };
        if n == 0 {
            break;
        }
        if local.write_all(&buf[..n]).await.is_err() {
            return transfer_err("写入本地文件失败");
        }
        transferred += n as u64;
        emit_progress(&app, "sftp-download-progress", &session_id, "downloading", transferred, remote_size);
    }
    if local.flush().await.is_err() {
        return transfer_err("写入本地文件失败");
    }
    drop(local);

    match finish_download(&part_path, &local_path).await {
        Ok(_) => SftpTransferResult { ok: true, resumed, error: None },
        Err(e) => transfer_err(&e),
    }
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> SftpTransferResult {
    let state = app.state::<AppState>();
    if local_path.is_empty() || remote_path.is_empty() {
        return transfer_err("参数不完整");
    }
    if !is_safe_remote_path(&remote_path) {
        return transfer_err("路径包含非法段");
    }
    // 安全：本地路径必须经对话框/拖拽登记并消费移除
    if let Err(e) = consume_approved_path(&state, &local_path) {
        return transfer_err(&e);
    }

    let local_meta = match tokio::fs::metadata(&local_path).await {
        Ok(m) if m.is_file() => m,
        _ => return transfer_err("本地文件不存在"),
    };
    let local_size = local_meta.len();

    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return transfer_err(&e),
    };

    // 断点续传：以远端大小为基准（远端 0 < size < 本地 -> 追加续传；否则全量覆盖）
    // russh-sftp 2.x: stat 改名为 metadata。
    let offset = match sftp.metadata(&remote_path).await {
        Ok(a) => {
            let rs = a.len();
            if rs > 0 && rs < local_size {
                rs
            } else {
                0
            }
        }
        Err(_) => 0,
    };
    let resumed = offset > 0;

    // russh-sftp 2.x: open_with_flags(path, OpenFlags) 取代 OpenOptions builder。
    let flags = if resumed {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    };
    let mut remote = match sftp.open_with_flags(&remote_path, flags).await {
        Ok(f) => f,
        Err(_) => return transfer_err("上传失败"),
    };

    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    let mut local = match tokio::fs::File::open(&local_path).await {
        Ok(f) => f,
        Err(_) => return transfer_err("本地文件不存在"),
    };
    if offset > 0 {
        if local.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
            return transfer_err("读取本地文件失败");
        }
    }

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut transferred = offset;
    loop {
        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(_) => return transfer_err("读取本地文件失败"),
        };
        if n == 0 {
            break;
        }
        // TODO(verify): russh-sftp File::write 签名（写满/短写处理）
        if remote.write(&buf[..n]).await.is_err() {
            return transfer_err("上传失败");
        }
        transferred += n as u64;
        emit_progress(&app, "sftp-upload-progress", &session_id, "uploading", transferred, local_size);
    }
    let _ = remote.flush().await;

    SftpTransferResult { ok: true, resumed, error: None }
}

fn transfer_err(error: &str) -> SftpTransferResult {
    SftpTransferResult { ok: false, resumed: false, error: Some(error.to_string()) }
}

// ---------------------------------------------------------------------------
// sftp_register_upload_paths（登记合法本地文件）
// ---------------------------------------------------------------------------

/// sftp_upload_data: 拖拽上传 (前端 File -> ArrayBuffer 字节流直传, 无本地磁盘路径)。
/// 安全: 远端路径白名单校验 + 单文件大小上限; 数据源为渲染层 File 对象, 不经
/// approved_local_paths (该机制仅约束有磁盘路径的对话框上传)。
#[tauri::command]
pub async fn sftp_upload_data(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    bytes: Vec<u8>,
) -> SftpSimpleResult {
    let state = app.state::<AppState>();
    if remote_path.is_empty() || bytes.is_empty() {
        return simple_err("参数不完整");
    }
    if !is_safe_remote_path(&remote_path) {
        return simple_err("路径包含非法段");
    }
    if bytes.len() > 100 * 1024 * 1024 {
        return simple_err("文件过大，请使用「上传文件」按钮");
    }
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return simple_err(&e),
    };
    use tokio::io::AsyncWriteExt;
    let mut remote = match sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
    {
        Ok(f) => f,
        Err(_) => return simple_err("上传失败"),
    };
    if remote.write_all(&bytes).await.is_err() {
        return simple_err("上传失败");
    }
    if remote.flush().await.is_err() {
        return simple_err("上传失败");
    }
    crate::audit::log(crate::audit::AuditEntry {
        r#type: Some("sftp.upload".into()),
        session: Some(session_id),
        target: Some(remote_path),
        result: Some("success".into()),
        detail: Some(format!("拖拽上传 {} 字节", bytes.len())),
        ..Default::default()
    });
    SftpSimpleResult { ok: true, error: None }
}

#[tauri::command]
pub fn sftp_register_upload_paths(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> SftpRegisterResult {
    let mut accepted: Vec<String> = Vec::new();
    let mut guard = match state.approved_local_paths.lock() {
        Ok(g) => g,
        Err(_) => {
            return SftpRegisterResult {
                ok: false,
                count: 0,
                accepted: Vec::new(),
                error: Some("系统状态异常".to_string()),
            }
        }
    };
    for p in paths {
        if accepted.len() >= MAX_DROP_PATHS {
            break;
        }
        if p.is_empty() || guard.contains(&p) {
            continue; // 空路径 / 已登记（防重复）
        }
        match std::fs::metadata(&p) {
            Ok(m) if m.is_file() => {
                guard.insert(p.clone());
                accepted.push(p);
            }
            _ => continue, // 目录 / 不存在 / 无权限 一律忽略
        }
    }
    SftpRegisterResult {
        ok: true,
        count: accepted.len(),
        accepted,
        error: None,
    }
}

// ---------------------------------------------------------------------------
// sftp_mkdir / sftp_delete / sftp_rename
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    session_id: String,
    path: String,
) -> SftpSimpleResult {
    let state = app.state::<AppState>();
    if path.is_empty() || !is_safe_remote_path(&path) {
        return simple_err("路径包含非法段");
    }
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return simple_err(&e),
    };
    match sftp.create_dir(&path).await {
        Ok(_) => SftpSimpleResult { ok: true, error: None },
        Err(_) => simple_err("创建目录失败"),
    }
}

#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    session_id: String,
    path: String,
) -> SftpSimpleResult {
    let state = app.state::<AppState>();
    if path.is_empty() {
        return simple_err("参数不完整");
    }
    if path == "/" {
        return simple_err("不能删除根目录");
    }
    if !is_safe_remote_path(&path) {
        return simple_err("路径包含非法段");
    }
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return simple_err(&e),
    };
    match remove_recursive(&sftp, &path, 0).await {
        Ok(_) => SftpSimpleResult { ok: true, error: None },
        Err(e) => simple_err(&e),
    }
}

/// 递归删除：目录先清空内部再 rmdir；判型用 symlink_metadata（不跟随符号链接），符号链接按文件 unlink。
/// 递归删除：目录先清空内部再 rmdir；判型用 symlink_metadata（不跟随符号链接），符号链接按文件 unlink。
/// 注: 递归 async fn 需 Box::pin 引入间接层 (E0733), 故拆出 inner 内部函数。
async fn remove_recursive(sftp: &SftpSession, path: &str, depth: usize) -> Result<(), String> {
    fn inner<'a>(
        sftp: &'a SftpSession,
        path: &'a str,
        depth: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if depth > MAX_DELETE_DEPTH {
                return Err("目录嵌套过深，已中止删除".to_string());
            }
            // russh-sftp 2.x: lstat 改名为 symlink_metadata; is_dir() 返回 bool。
            let attrs = sftp
                .symlink_metadata(path)
                .await
                .map_err(|_| "删除失败".to_string())?;
            if attrs.is_dir() {
                if let Ok(entries) = sftp.read_dir(path).await {
                    for entry in entries {
                        let name = entry.file_name();
                        if name == "." || name == ".." {
                            continue;
                        }
                        let child = join_remote_path(path, &name);
                        inner(sftp, &child, depth + 1).await?;
                    }
                }
                sftp.remove_dir(path).await.map_err(|_| "删除失败".to_string())
            } else {
                sftp.remove_file(path).await.map_err(|_| "删除失败".to_string())
            }
        })
    }
    inner(sftp, path, depth).await
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    session_id: String,
    old_path: String,
    new_path: String,
) -> SftpSimpleResult {
    let state = app.state::<AppState>();
    if old_path.is_empty() || new_path.is_empty() {
        return simple_err("参数不完整");
    }
    if !is_safe_remote_path(&old_path) || !is_safe_remote_path(&new_path) {
        return simple_err("路径包含非法段");
    }
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return simple_err(&e),
    };
    match sftp.rename(&old_path, &new_path).await {
        Ok(_) => SftpSimpleResult { ok: true, error: None },
        Err(_) => simple_err("重命名失败"),
    }
}

fn simple_err(error: &str) -> SftpSimpleResult {
    SftpSimpleResult { ok: false, error: Some(error.to_string()) }
}

// ---------------------------------------------------------------------------
// sftp_cd_sync（终端 cd 同步 -> 安全绝对路径）
// ---------------------------------------------------------------------------

/// 解析远端 home 目录：先试 canonicalize("~")（OpenSSH 返回字面 ~ 时回退 canonicalize(".")）。
/// russh-sftp 2.x: realpath 改名为 canonicalize, 返回 String。
async fn resolve_sftp_home(sftp: &SftpSession) -> Option<String> {
    if let Ok(p) = sftp.canonicalize("~").await {
        let s = p;
        if s != "~" && !s.ends_with("/~") {
            return Some(s);
        }
    }
    sftp.canonicalize(".").await.ok()
}

#[tauri::command]
pub async fn sftp_cd_sync(
    app: AppHandle,
    session_id: String,
    raw_path: String,
) -> SftpCdSyncResult {
    let state = app.state::<AppState>();
    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return cd_err(&e),
    };
    let raw = raw_path.trim();
    if raw.is_empty() {
        return cd_err("空路径");
    }

    // 解析目标绝对路径：~ / ~/xxx / 绝对 / 相对（相对路径基于服务器端 cwd 由 realpath 归一化）
    let target = if raw == "~" || raw.starts_with("~/") {
        let home = match resolve_sftp_home(&sftp).await {
            Some(h) => h,
            None => return cd_err("无法解析 home 目录"),
        };
        if raw == "~" {
            home
        } else {
            format!("{}/{}", home.trim_end_matches('/'), &raw[2..])
        }
    } else {
        raw.to_string()
    };

    // russh-sftp 2.x: realpath -> canonicalize (返回 String); stat -> metadata。
    let resolved = match sftp.canonicalize(&target).await {
        Ok(p) => p,
        Err(_) => return cd_err("路径不存在或无法解析"),
    };
    if !is_safe_remote_path(&resolved) {
        return cd_err("路径包含非法段");
    }

    // 存在性 + 目录校验（cd 到文件应失败，渲染层静默忽略）
    match sftp.metadata(&resolved).await {
        Ok(a) if a.is_dir() => SftpCdSyncResult {
            ok: true,
            path: Some(resolved),
            error: None,
        },
        Ok(_) => cd_err("非目录"),
        Err(_) => cd_err("路径不存在或无法解析"),
    }
}

fn cd_err(error: &str) -> SftpCdSyncResult {
    SftpCdSyncResult { ok: false, path: None, error: Some(error.to_string()) }
}

// ---------------------------------------------------------------------------
// sftp_search（find 递归搜索，防注入）
// ---------------------------------------------------------------------------

/// 搜索关键字白名单：保留 [A-Za-z0-9_.-] 与 CJK 常用区（与前端 file-filter.js 规则一致），
/// 其余（空格/引号/分号/$ 等 shell 元字符）一律剔除。
fn sanitize_search_keyword(keyword: &str) -> String {
    let k = keyword.trim();
    if k.is_empty() || k.chars().count() > MAX_KEYWORD_LEN {
        return String::new();
    }
    k.chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '-')
                || ('\u{4e00}'..='\u{9fff}').contains(c)
        })
        .collect()
}

/// 搜索起始目录校验：以 / 开头的绝对路径，无 `..` 段（允许尾部斜杠，find 可正常处理）。
fn is_safe_search_cwd(cwd: &str) -> bool {
    is_safe_remote_path(cwd)
}

fn clamp_search_depth(max_depth: Option<i64>) -> i64 {
    let d = max_depth.unwrap_or(SEARCH_DEFAULT_DEPTH);
    d.clamp(SEARCH_MIN_DEPTH, SEARCH_MAX_DEPTH)
}

/// 解析 find -print 输出为结果列表（与 Electron file-filter.js parseFindOutput 同语义）。
fn parse_find_output(output: &str, base: &str) -> Vec<SftpSearchHit> {
    let mut results: Vec<SftpSearchHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for line in output.split('\n') {
        let p = line.trim();
        if p.is_empty() || p == base {
            continue;
        }
        if p.to_lowercase().contains("permission denied") {
            continue;
        }
        let mut full = p.to_string();
        if full.starts_with("./") {
            full = if base == "/" {
                full[1..].to_string()
            } else {
                format!("{}/{}", base.trim_end_matches('/'), &full[2..])
            };
        }
        if !full.starts_with('/') {
            continue;
        }
        while full.len() > 1 && full.ends_with('/') {
            full.pop();
        }
        let (dir, name) = match full.rfind('/') {
            Some(idx) => {
                let d = full[..idx].to_string();
                let n = full[idx + 1..].to_string();
                (if d.is_empty() { "/".to_string() } else { d }, n)
            }
            None => continue,
        };
        if name.is_empty() || !seen.insert(full.clone()) {
            continue;
        }
        results.push(SftpSearchHit { path: full, name, dir });
        if results.len() >= MAX_SEARCH_RESULTS {
            break;
        }
    }
    results
}

#[tauri::command]
pub async fn sftp_search(
    app: AppHandle,
    session_id: String,
    path: String,
    keyword: String,
    max_depth: Option<i64>,
) -> SftpSearchResult {
    let state = app.state::<AppState>();
    let kw = sanitize_search_keyword(&keyword);
    if kw.is_empty() {
        return search_err("搜索关键字无效");
    }
    if !is_safe_search_cwd(&path) {
        return search_err("路径包含非法段");
    }
    let depth = clamp_search_depth(max_depth);

    // 关键字已白名单化（无 shell 元字符），cwd 单引号转义；命令无用户可控 shell 元字符
    let cmd = format!(
        "find {} -maxdepth {} -iname '*{}*' -print",
        shell_single_quote(&path),
        depth,
        kw
    );

    let out = match crate::monitor::exec_remote_command(
        &state,
        &session_id,
        &cmd,
        crate::monitor::EXEC_MAX_BYTES,
        crate::monitor::EXEC_TIMEOUT,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return search_err(&e),
    };
    if out.stdout.trim().is_empty() {
        return search_err("搜索失败或未找到匹配");
    }

    SftpSearchResult {
        ok: true,
        results: parse_find_output(&out.stdout, &path),
        error: None,
    }
}

fn search_err(error: &str) -> SftpSearchResult {
    SftpSearchResult { ok: false, results: Vec::new(), error: Some(error.to_string()) }
}

// ---------------------------------------------------------------------------
// sftp_download_folder（递归下载 + zip 打包，防 zip-slip）
// ---------------------------------------------------------------------------

/// zip 条目名规范化（防 zip-slip）：拒绝绝对路径 / `..` 段 / Windows 盘符段 / 空名。
fn sanitize_zip_entry_path(rel: &str) -> Option<String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return None;
    }
    if rel.contains('\0') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in rel.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None, // 越界
            _ => parts.push(seg),
        }
    }
    if parts.is_empty() {
        return None;
    }
    // 拒绝 Windows 盘符（如 C: 段）
    if parts[0].len() == 2 && parts[0].as_bytes()[1] == b':' {
        return None;
    }
    Some(parts.join("/"))
}

/// 递归收集待打包条目：(远端绝对路径, zip 相对路径)。
/// 目录条目先行压入（保证 zip 内有目录层级），再递归子目录。
/// 注: 递归 async fn 需 Box::pin 引入间接层 (E0733), 故拆出 collect_inner 内部函数。
async fn collect_folder_files(
    sftp: &SftpSession,
    remote_dir: &str,
    zip_dir: &str,
    out: &mut Vec<(String, String, bool)>, // (remote_abs, zip_rel, is_dir)
    depth: usize,
) -> Result<(), String> {
    fn collect_inner<'a>(
        sftp: &'a SftpSession,
        remote_dir: &'a str,
        zip_dir: &'a str,
        out: &'a mut Vec<(String, String, bool)>,
        depth: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if depth > MAX_DOWNLOAD_DEPTH {
                return Err("目录嵌套过深，已中止打包".to_string());
            }
            let entries = sftp.read_dir(remote_dir).await.map_err(|_| "读取目录失败")?;
            // russh-sftp 2.0.0-beta.2: read_dir 迭代项为 DirEntry。
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let attrs = entry.metadata();
                let child_remote = join_remote_path(remote_dir, &name);
                let child_zip = if zip_dir.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", zip_dir, name)
                };
                let is_dir = entry_is_dir(sftp, &attrs, &child_remote).await;
                out.push((child_remote.clone(), child_zip.clone(), is_dir));
                if is_dir {
                    collect_inner(sftp, &child_remote, &child_zip, out, depth + 1).await?;
                }
            }
            Ok(())
        })
    }
    collect_inner(sftp, remote_dir, zip_dir, out, depth).await
}

#[tauri::command]
pub async fn sftp_download_folder(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_zip_path: String,
) -> SftpSimpleResult {
    let state = app.state::<AppState>();
    if remote_path.is_empty() || local_zip_path.is_empty() {
        return simple_err("参数不完整");
    }
    if !is_safe_remote_path(&remote_path) {
        return simple_err("路径包含非法段");
    }
    // 安全：zip 目标路径必须经对话框登记并消费移除
    if let Err(e) = consume_approved_path(&state, &local_zip_path) {
        return simple_err(&e);
    }

    let sftp = match get_sftp(&state, &session_id).await {
        Ok(s) => s,
        Err(e) => return simple_err(&e),
    };

    // 根目录名作为 zip 根（下载 /root/data -> zip 内 data/ 与 data/xxx）
    let root_name = remote_path
        .split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or("folder")
        .to_string();

    // 递归收集
    let mut files: Vec<(String, String, bool)> = Vec::new();
    if let Err(e) = collect_folder_files(&sftp, &remote_path, &root_name, &mut files, 0).await {
        let _ = std::fs::remove_file(&local_zip_path);
        return simple_err(&e);
    }

    // 打包（zip 写盘为同步 IO，正常量级可接受；大目录可后续改 spawn_blocking 分块）
    let zip_out = match std::fs::File::create(&local_zip_path) {
        Ok(f) => f,
        Err(_) => return simple_err("写入本地文件失败"),
    };
    let mut zip = zip::ZipWriter::new(zip_out);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 根目录条目始终存在（空文件夹也能打包出含根目录的 zip，与 Electron 一致）
    let root_entry = match sanitize_zip_entry_path(&root_name) {
        Some(s) => s,
        None => {
            drop(zip);
            let _ = std::fs::remove_file(&local_zip_path);
            return simple_err("打包失败");
        }
    };
    if zip.add_directory(&format!("{}/", root_entry), opts).is_err() {
        drop(zip);
        let _ = std::fs::remove_file(&local_zip_path);
        return simple_err("打包下载失败");
    }

    let total = files.len() as u64;
    let mut done = 0u64;
    for (remote_abs, zip_rel, is_dir) in files {
        // 防 zip-slip：条目名规范化，非法条目直接中止（绝不写入越界路径）
        let safe_rel = match sanitize_zip_entry_path(&zip_rel) {
            Some(s) => s,
            None => {
                drop(zip);
                let _ = std::fs::remove_file(&local_zip_path);
                return simple_err("打包失败");
            }
        };
        let mut ok_write = true;
        if is_dir {
            // TODO(verify): zip 2.x add_directory 对结尾斜杠的处理（传 name + "/" 最稳）
            ok_write = zip.add_directory(&format!("{}/", safe_rel), opts).is_ok();
        } else {
            // russh-sftp 2.x: open_with_flags(path, OpenFlags::READ)。
            let mut remote = match sftp.open_with_flags(&remote_abs, OpenFlags::READ).await {
                Ok(f) => f,
                Err(_) => {
                    drop(zip);
                    let _ = std::fs::remove_file(&local_zip_path);
                    return simple_err("读取远端文件失败");
                }
            };
            ok_write = zip.start_file(&safe_rel, opts).is_ok();
            if ok_write {
                use tokio::io::AsyncReadExt;
                let mut buf = vec![0u8; CHUNK_SIZE];
                loop {
                    match remote.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if zip.write_all(&buf[..n]).is_err() {
                                ok_write = false;
                                break;
                            }
                        }
                        Err(_) => {
                            ok_write = false;
                            break;
                        }
                    }
                }
            }
        }
        if !ok_write {
            drop(zip);
            let _ = std::fs::remove_file(&local_zip_path);
            return simple_err("打包下载失败");
        }
        done += 1;
        emit_progress(&app, "sftp-download-progress", &session_id, "packing", done, total);
    }

    if zip.finish().is_err() {
        let _ = std::fs::remove_file(&local_zip_path);
        return simple_err("打包下载失败");
    }

    SftpSimpleResult { ok: true, error: None }
}
