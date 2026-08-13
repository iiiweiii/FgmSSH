//! 全局状态 (AppState): 会话表 / 已批准本地路径 / 持久化路径 / 主机密钥待确认注册表。
//!
//! 设计要点:
//! - 所有可变字段用 `Arc<Mutex<...>>` 包裹, 使 AppState 可 Clone (供 tokio::spawn 与
//!   tauri::State 共用); std Mutex 仅用于短临界区 (不跨 await 持有)。
//! - 路径全部基于 `app.path().app_data_dir()` (SPEC 1/state.rs), 与 Electron userData 语义一致。
//! - hostkey_pending 是 SSH 握手期「主机密钥待用户确认」的注册表 (TOFU, SPEC 4.3):
//!   ssh.rs 的 ClientHandler 在 server_public_key 回调中登记, hostkey_accept/reject 命令消费。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use crate::ssh::{PendingRegistry, SessionHandle};
use crate::tunnel::TunnelRecord;

/// 全局应用状态。
#[derive(Clone)]
pub struct AppState {
    /// 活跃 SSH 会话表 (session_id -> SessionHandle)。
    pub sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    /// 已批准用于上传的本地路径登记 (SPEC 4.4: 数量上限/普通文件校验由 sftp 模块负责)。
    pub approved_local_paths: Arc<Mutex<HashSet<String>>>,
    /// 主机密钥待确认注册表 (TOFU 握手期间挂起, hostkey:confirm/mismatch 事件等待前端决策)。
    pub hostkey_pending: PendingRegistry,
    /// 会话隧道注册表 (session_id -> 隧道列表; 仅绑 127.0.0.1, 见 tunnel.rs)。
    pub tunnels: Arc<Mutex<HashMap<String, Vec<TunnelRecord>>>>,
    /// userData 根目录 (app.path().app_data_dir())。
    pub user_data_dir: PathBuf,
    /// known_hosts.json 绝对路径 (明文, 非机密)。
    pub known_hosts_path: PathBuf,
    /// connections.json 绝对路径 (凭据加密落盘, fail-closed)。
    pub store_path: PathBuf,
    /// settings.json 绝对路径 (明文全局设置)。
    pub settings_path: PathBuf,
    /// 审计日志目录 (audit-YYYY-MM-DD.jsonl 按天滚动)。
    pub audit_dir: PathBuf,
    /// AppHandle 克隆: 供后台任务 (SSH 数据读取/重连) 发射事件。
    pub app: AppHandle,
}

impl AppState {
    /// 基于 AppHandle 计算全部持久化路径并初始化状态。
    /// app_data_dir 获取失败时回退系统临时目录 (生产环境不会走到)。
    pub fn new(app: AppHandle) -> Self {
        let user_data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("fgmssh"));

        let known_hosts_path = user_data_dir.join("known_hosts.json");
        let store_path = user_data_dir.join("connections.json");
        let settings_path = user_data_dir.join("settings.json");
        let audit_dir = user_data_dir.join("logs");

        // 目录懒创建: store/audit 模块 init 时会再确保一次 (幂等)。
        let _ = std::fs::create_dir_all(&user_data_dir);

        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            approved_local_paths: Arc::new(Mutex::new(HashSet::new())),
            hostkey_pending: Arc::new(Mutex::new(HashMap::new())),
            tunnels: Arc::new(Mutex::new(HashMap::new())),
            user_data_dir,
            known_hosts_path,
            store_path,
            settings_path,
            audit_dir,
            app,
        }
    }
}
