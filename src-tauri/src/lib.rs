//! FgmSSH Tauri v2 后端核心: 模块声明 + 全部 IPC 命令注册 (契约 SPEC §2)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audit;
mod credential;
mod hostkey;
mod preview_doc;
mod ssh;
mod state;
mod store;
mod util;

// backend-ext 负责的模块 (按契约签名引用; 函数名如有出入由主理人统一校对)。
mod monitor;
mod portable;
mod sftp;
mod tunnel;
mod update;

use serde::Serialize;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub use state::AppState;

// ================= 统一返回结构 (契约: {ok, error?}) =================

/// 通用命令返回 {ok, error?}。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdOk {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CmdOk {
    pub fn success() -> Self {
        CmdOk { ok: true, error: None }
    }
    pub fn failure(msg: impl Into<String>) -> Self {
        CmdOk {
            ok: false,
            error: Some(msg.into()),
        }
    }
}

/// 文件对话框返回 {ok, path?, error?}。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DialogResult {
    fn ok(path: String) -> Self {
        DialogResult {
            ok: true,
            path: Some(path),
            error: None,
        }
    }
    fn canceled() -> Self {
        DialogResult {
            ok: false,
            path: None,
            error: Some("已取消".to_string()),
        }
    }
}

// ================= 文件对话框命令 (SPEC §2) =================

/// 将对话框选择的本地路径登记进 approved_local_paths (sftp 上传/下载消费移除, 见 sftp.rs)。
fn register_approved_path(state: &AppState, path: &str) {
    if let Ok(mut guard) = state.approved_local_paths.lock() {
        guard.insert(path.to_string());
    }
}

/// selectKeyFile: 选择私钥文件。
#[tauri::command]
pub async fn dialog_select_key(app: AppHandle) -> DialogResult {
    // TODO(verify): tauri-plugin-dialog 2 阻塞对话框 API 名称/返回类型
    // (blocking_pick_file / FilePath::into_path 返回 Result)。
    let picked = app
        .dialog()
        .file()
        .add_filter("私钥文件", &["pem", "ppk", "key", "p12", "pfx"])
        .blocking_pick_file();
    match picked.and_then(|fp| fp.into_path().ok()) {
        Some(p) => DialogResult::ok(p.to_string_lossy().to_string()),
        None => DialogResult::canceled(),
    }
}

/// selectFile: 选择任意文件 (登记进 approved_local_paths 供 sftp_upload 消费)。
#[tauri::command]
pub async fn dialog_select_file(app: AppHandle, state: State<'_, AppState>) -> DialogResult {
    let picked = app.dialog().file().blocking_pick_file();
    match picked.and_then(|fp| fp.into_path().ok()) {
        Some(p) => {
            let s = p.to_string_lossy().to_string();
            register_approved_path(state.inner(), &s);
            DialogResult::ok(s)
        }
        None => DialogResult::canceled(),
    }
}

/// selectSavePath: 选择保存路径 (登记进 approved_local_paths 供 sftp_download 消费)。
#[tauri::command]
pub async fn dialog_select_save_path(app: AppHandle, state: State<'_, AppState>) -> DialogResult {
    let picked = app.dialog().file().blocking_save_file();
    match picked.and_then(|fp| fp.into_path().ok()) {
        Some(p) => {
            let s = p.to_string_lossy().to_string();
            register_approved_path(state.inner(), &s);
            DialogResult::ok(s)
        }
        None => DialogResult::canceled(),
    }
}

// ================= store / settings 命令 (SPEC §2) =================

/// storeLoad: 返回脱敏视图 (password/passphrase='' + hasPassword/hasPassphrase)。
#[tauri::command]
pub fn store_load() -> Vec<serde_json::Value> {
    store::load_redacted()
}

/// storeSave: fail-closed 保存连接列表 (留空沿用磁盘旧凭据)。
#[tauri::command]
pub fn store_save(list: Vec<serde_json::Value>) -> CmdOk {
    match store::save(&list, store::SaveOpts::default()) {
        Ok(()) => CmdOk::success(),
        Err(e) => CmdOk::failure(e),
    }
}

/// settingsLoad: 读取全局设置。
#[tauri::command]
pub fn settings_load() -> serde_json::Value {
    store::load_settings()
}

/// settingsSave: 保存全局设置。
#[tauri::command]
pub fn settings_save(settings: serde_json::Value) -> CmdOk {
    match store::save_settings(&settings) {
        Ok(()) => CmdOk::success(),
        Err(e) => CmdOk::failure(e),
    }
}

// ================= audit 命令 (SPEC §2) =================

/// auditLog: 记录一条审计日志 (fire-and-forget)。
#[tauri::command]
pub fn audit_log(entry: audit::AuditEntry) -> CmdOk {
    audit::log(entry);
    CmdOk::success()
}

/// auditQuery: 查询审计日志 (按时间/用户/类型/结果筛选 + 分页)。
#[tauri::command]
pub fn audit_query(filters: audit::AuditQueryFilters) -> audit::AuditQueryResult {
    audit::query(&filters)
}

// ================= open_external (SPEC §4.5) =================

/// openExternal: 仅放行 http/https, 其余拒绝。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> CmdOk {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return CmdOk::failure("仅支持打开 http/https 链接");
    }
    // TODO(verify): tauri-plugin-shell 2 ShellExt::open 调用方式。
    use tauri_plugin_shell::ShellExt;
    match app.shell().open(std::path::Path::new(&url), None) {
        Ok(()) => CmdOk::success(),
        Err(_) => CmdOk::failure("打开链接失败"),
    }
}

// ================= 入口 =================

/// 构造 404 协议响应 (预览/文档未命中或非法文件名)。
/// TODO(verify): tauri v2 中 `http::Response` 的 body 类型与 builder 返回值; 当前按
/// `Vec<u8>` body 写, 若编译报期望 `Cow<'static, [u8]>` 则改 `Cow::Owned(...)`。
fn http_not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 构造 200 协议响应 (图片/文档字节流 + mime + 短期缓存)。
fn http_ok(body: Vec<u8>, mime: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Cache-Control", "max-age=3600")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 注册 nimbus-preview / nimbus-doc 自定义 URI 协议 (仅允许读取 preview_tmp 下已登记文件)。
/// TODO(verify): tauri v2 中 `register_uri_scheme_protocol` 的闭包签名 (参数 &AppHandle,
/// &Request, 返回 Result<Response, Box<dyn Error>>) 与 body 类型; 不同小版本有微差,
/// 若编译报签名不匹配, 按编译器建议调整。
fn register_uri_schemes<R: tauri::Runtime>(app: &AppHandle<R>) {
    // nimbus-preview: 图片预览临时文件 (nimbus- 前缀, 非 nimbus-doc-)
    {
        let app_clone = app.clone();
        let _ = app.register_uri_scheme_protocol("nimbus-preview", move |_ah, req| {
            let url = req.uri().to_string();
            let filename = match preview_doc::parse_protocol_filename(&url) {
                Some(f) => f,
                None => return Ok(http_not_found()),
            };
            match preview_doc::read_registered_tmp(&filename, "preview") {
                Some((bytes, mime)) => Ok(http_ok(bytes, mime)),
                None => Ok(http_not_found()),
            }
        });
        // 保留 app_clone 以防闭包未捕获时延长其生命周期 (目前闭包内未用, 仅显式 drop)
        drop(app_clone);
    }

    // nimbus-doc: 文档查看器临时文件 (nimbus-doc- 前缀)
    {
        let app_clone = app.clone();
        let _ = app.register_uri_scheme_protocol("nimbus-doc", move |_ah, req| {
            let url = req.uri().to_string();
            let filename = match preview_doc::parse_protocol_filename(&url) {
                Some(f) => f,
                None => return Ok(http_not_found()),
            };
            match preview_doc::read_registered_tmp(&filename, "doc") {
                Some((bytes, mime)) => Ok(http_ok(bytes, mime)),
                None => Ok(http_not_found()),
            }
        });
        drop(app_clone);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let state = AppState::new(app.handle().clone());
            // 注入存储路径 (store/audit/preview_doc 模块初始化, 幂等)。
            store::init(state.store_path.clone(), state.settings_path.clone());
            audit::init(state.audit_dir.clone());
            // preview/doc: 设置 preview_tmp 目录 + 启动清理过期文件 + 清理 orphan 注册。
            let _ = preview_doc::init(app.handle());
            // 注册自定义 URI 协议 (nimbus-preview / nimbus-doc)。
            register_uri_schemes(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ssh + hostkey (ssh.rs)
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::hostkey_accept,
            ssh::hostkey_reject,
            // 对话框 (lib.rs)
            dialog_select_key,
            dialog_select_file,
            dialog_select_save_path,
            // store / settings (lib.rs)
            store_load,
            store_save,
            settings_load,
            settings_save,
            // audit (lib.rs)
            audit_log,
            audit_query,
            // 外部链接 (lib.rs)
            open_external,
            // preview / doc (preview_doc.rs)
            preview_doc::preview_open,
            preview_doc::preview_close,
            preview_doc::preview_save_as,
            preview_doc::doc_open,
            preview_doc::doc_close,
            preview_doc::doc_load_full,
            preview_doc::doc_save,
            // ---- backend-ext 模块 ----
            monitor::ssh_monitor_fetch,
            tunnel::tunnel_start,
            tunnel::tunnel_list,
            tunnel::tunnel_stop,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_register_upload_paths,
            sftp::sftp_mkdir,
            sftp::sftp_delete,
            sftp::sftp_rename,
            sftp::sftp_cd_sync,
            sftp::sftp_search,
            sftp::sftp_download_folder,
            update::update_check,
            portable::config_export,
            portable::config_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}