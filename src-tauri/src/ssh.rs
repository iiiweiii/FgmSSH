//! SSH 会话核心 (russh 0.44.x 客户端): 连接/认证/TOFU 主机密钥/终端数据流/断线重连。
//!
//! 架构 (基于 russh 0.44.1 API 事实):
//! - `russh::client::Handle<H>` 与 `russh::Channel` **均不实现 Clone**; Channel 的
//!   `wait(&mut self)` 需要独占借用。因此终端通道由 `run_session_runtime` 后台任务**独占**,
//!   写/改尺寸/关闭经 `mpsc::UnboundedSender<TerminalCmd>` 命令通道下发 (actor 模式)。
//! - sftp/tunnel/monitor 需另开通道时, 通过 `SessionHandleInner` (Arc<Mutex<Option<Handle>>>,
//!   可 Clone) 的 async 方法 (`channel_open_session` / `channel_open_direct_tcpip`) 获取
//!   新通道, 与终端通道互不干扰。
//! - TOFU (SPEC 4.3): `SshClientHandler::check_server_key` 在握手期计算指纹, 查 known_hosts:
//!   trusted -> 放行; unknown -> 发 hostkey:confirm 事件; mismatch -> 发 hostkey:mismatch 事件;
//!   挂起等待前端 hostkey_accept/hostkey_reject 决策, 60s 超时默认拒绝。用 oneshot 实现。
//! - 重连: 指数退避 1..32s (上限 32s), autoReconnect 默认开, 上限 autoReconnectMaxAttempts 默认 5;
//!   用户主动断开 (user_disconnected) 不重连; 收到显式 exit status 视为正常退出不重连。
//! - 并发安全: sessions 表在 AppState (std Mutex, 短临界区); 命令通道用 tokio mpsc。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::state::AppState;

// ================= 参数结构 (契约 §2, camelCase) =================

/// ssh_connect 的 config 参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfig {
    #[serde(default)]
    pub conn_id: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// password | privateKey | agent
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub tunnels: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub auto_reconnect: Option<bool>,
    #[serde(default)]
    pub auto_reconnect_max_attempts: Option<u32>,
    /// 是否启用主机密钥 TOFU 校验 (前端传布尔; 原实现误用 Option<String> 导致反序列化失败)。
    #[serde(default)]
    pub host_key_verify: Option<bool>,
}

fn default_port() -> u16 {
    22
}

// ================= 待确认主机密钥 / 注册表 =================

/// 握手期挂起的主机密钥决策请求 (oneshot: 前端 hostkey_accept/reject 驱动)。
pub struct PendingHostKey {
    pub tx: tokio::sync::oneshot::Sender<bool>,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub md5: String,
    pub algorithm: String,
}

/// 注册表类型 (session_id -> PendingHostKey), 由 ssh 命令与 handler 共享。
pub type PendingRegistry = Arc<Mutex<HashMap<String, PendingHostKey>>>;

// ================= 会话句柄 =================

/// 具体通道类型: russh 客户端通道 (泛型参数为 client::Msg)。
/// 依据 russh 0.44.1: `Handle::channel_open_session() -> Channel<Msg>` (Msg = client::Msg)。
pub type SessionChannel = russh::Channel<russh::client::Msg>;

/// 下发到终端通道后台任务的命令 (actor 模式)。
#[derive(Debug)]
pub enum TerminalCmd {
    /// 写入终端数据。
    Write(Vec<u8>),
    /// 调整 PTY 尺寸 (rows, cols)。
    Resize(u32, u32),
    /// 关闭通道 (用户主动断开)。
    Close,
}

/// 会话句柄内层: 可并发开新通道的 russh 客户端 Handle。
/// russh 0.44.x 的 `client::Handle` **不实现 Clone**, 因此用
/// `Arc<tokio::sync::Mutex<Option<Handle>>>` 包裹, 经 async 方法对外提供 `&self` 访问,
/// 使 sftp/tunnel/monitor 可沿用 `sh.handle.clone()` + `handle.channel_open_*(...)` 的调用形态。
#[derive(Clone)]
pub struct SessionHandleInner {
    inner: Arc<tokio::sync::Mutex<Option<russh::client::Handle<SshClientHandler>>>>,
}

impl SessionHandleInner {
    pub fn new(handle: russh::client::Handle<SshClientHandler>) -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(Some(handle))),
        }
    }

    /// 打开新会话通道 (sftp/monitor 复用; 连接断开/重连窗口返回友好错误)。
    /// russh 0.44.x: channel_open_session(&self) -> Channel<Msg>。
    pub async fn channel_open_session(&self) -> Result<SessionChannel, String> {
        let mut guard = self.inner.lock().await;
        let handle = guard
            .as_mut()
            .ok_or_else(|| "会话已断开".to_string())?;
        handle
            .channel_open_session()
            .await
            .map_err(|_| "打开会话通道失败".to_string())
    }

    /// 打开 direct-tcpip 转发通道 (tunnel 使用)。
    /// TODO(verify): russh 0.44.x channel_open_direct_tcpip 参数顺序 (host,port,origin,origin_port)。
    pub async fn channel_open_direct_tcpip(
        &self,
        host: &str,
        port: u32,
        originator_host: &str,
        originator_port: u32,
    ) -> Result<SessionChannel, String> {
        let mut guard = self.inner.lock().await;
        let handle = guard
            .as_mut()
            .ok_or_else(|| "会话已断开".to_string())?;
        handle
            .channel_open_direct_tcpip(host, port, originator_host, originator_port)
            .await
            .map_err(|_| "打开转发通道失败".to_string())
    }

    /// 替换底层 Handle (重连成功后更新; 所有克隆共享同一 inner, 一处替换全局生效)。
    pub async fn replace(&self, handle: russh::client::Handle<SshClientHandler>) {
        *self.inner.lock().await = Some(handle);
    }
}

/// 单个 SSH 会话的句柄 (供命令与后台任务共享)。
#[derive(Clone)]
pub struct SessionHandle {
    pub id: String,
    pub config: ConnectConfig,
    /// 可并发开新通道的会话句柄 (sftp/tunnel/monitor 通过它开新通道)。
    pub handle: SessionHandleInner,
    /// 懒创建的 SFTP 通道 (见 sftp.rs get_sftp)。
    pub sftp: Option<Arc<russh_sftp::client::SftpSession>>,
    /// 用户主动断开标记 (阻止自动重连)。
    pub user_disconnected: Arc<AtomicBool>,
    /// 当前连接是否存活。
    pub connected: Arc<AtomicBool>,
    /// 重连退避中断通知 (用户断开时立即唤醒)。
    pub cancel: Arc<tokio::sync::Notify>,
    /// 是否允许自动重连 (config.autoReconnect, 默认 true)。
    pub reconnect_enabled: bool,
    /// 重连次数上限 (config.autoReconnectMaxAttempts, 默认 5)。
    pub max_attempts: u32,
    pub attempts: Arc<AtomicU32>,
    /// 终端通道命令发送端 (写/改尺寸/关闭); 由后台任务消费。
    pub cmd_tx: mpsc::UnboundedSender<TerminalCmd>,
}

// ================= russh ClientHandler (TOFU) =================

/// 客户端 Handler: 仅实现主机密钥校验 (TOFU); 终端数据流由 run_session_runtime
/// 通过 channel.wait() 消费, 本 Handler 不处理 data 回调。
pub struct SshClientHandler {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub known_hosts_path: PathBuf,
    pub pending: PendingRegistry,
    pub app: AppHandle,
    /// 是否执行主机密钥 TOFU 校验 (hostKeyVerify=false 时跳过, 直接放行)。
    pub verify_host_key: bool,
}

/// 从 russh 主机公钥对象提取 SSH wire blob (与 ssh-keygen -lf 指纹输入一致)。
/// russh-keys 0.44.x: `PublicKeyBase64` trait 在 crate 根公开 (pub trait),
/// `public_key_bytes()` 返回 wire blob (PublicKey::fingerprint() 内部同源)。
fn public_key_blob_bytes(key: &russh::keys::key::PublicKey) -> Vec<u8> {
    use russh::keys::PublicKeyBase64;
    key.public_key_bytes()
}

#[async_trait::async_trait]
impl russh::client::Handler for SshClientHandler {
    /// russh 0.44.x client::Handler 必须提供关联 Error 类型 (满足 From<Error>+Send+Debug)。
    type Error = russh::Error;

    /// TOFU: 计算指纹 -> 查 known_hosts -> trusted 放行 / unknown|mismatch 发事件挂起等决策。
    /// 返回 Ok(true) 接受, Ok(false) 拒绝 (中断握手)。
    /// russh 0.44.x 该方法名为 check_server_key (参数 &PublicKey, 返回 Result<bool>)。
    async fn check_server_key(
        &mut self,
        host_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, russh::Error> {
        use crate::hostkey::HostKeyStatus;

        // 用户关闭 TOFU 校验 (hostKeyVerify=false): 直接放行, 不做指纹比对。
        if !self.verify_host_key {
            return Ok(true);
        }

        let blob = public_key_blob_bytes(host_key);
        let fp = crate::hostkey::compute_fingerprints(&blob);
        let algorithm = crate::hostkey::extract_algorithm(&blob);
        let check = crate::hostkey::check_host_key(
            &self.known_hosts_path,
            &self.host,
            self.port,
            &fp.sha256,
            &algorithm,
        );

        match check.status {
            HostKeyStatus::Trusted => Ok(true),
            status => {
                // 登记待确认 + 发事件 (confirm: unknown 首次 / mismatch: 危险警告)。
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                self.pending.lock().unwrap().insert(
                    self.session_id.clone(),
                    PendingHostKey {
                        tx,
                        host: self.host.clone(),
                        port: self.port,
                        fingerprint: fp.sha256.clone(),
                        md5: fp.md5.clone(),
                        algorithm: algorithm.clone(),
                    },
                );
                let event_name = if status == HostKeyStatus::Unknown {
                    "hostkey:confirm"
                } else {
                    "hostkey:mismatch"
                };
                let payload = serde_json::json!({
                    "sessionId": self.session_id,
                    "host": self.host,
                    "port": self.port,
                    "algorithm": algorithm,
                    "fingerprint": fp.sha256,
                    "md5": fp.md5,
                });
                let _ = self.app.emit(event_name, payload);

                // 60s 超时默认拒绝 (SPEC 4.3)。
                match tokio::time::timeout(Duration::from_secs(60), rx).await {
                    Ok(Ok(true)) => Ok(true),
                    _ => {
                        self.pending.lock().unwrap().remove(&self.session_id);
                        Ok(false)
                    }
                }
            }
        }
    }
}

// ================= 事件发射 =================

/// 发 ssh:data (payload: {sessionId, data}); data 为 UTF-8 lossy 字符串。
fn emit_data(app: &AppHandle, session_id: &str, data: &[u8]) {
    let payload = serde_json::json!({
        "sessionId": session_id,
        "data": String::from_utf8_lossy(data),
    });
    let _ = app.emit("ssh:data", payload);
}

/// 发 ssh:event (payload: {sessionId, type, data})。
fn emit_event(app: &AppHandle, session_id: &str, event_type: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "sessionId": session_id,
        "type": event_type,
        "data": data,
    });
    let _ = app.emit("ssh:event", payload);
}

// ================= 凭据补全 (store 解密) =================

/// 密码补全: config.password 为空且 connId 存在 -> 从 store 磁盘解密补全。
fn resolve_password(state: &AppState, config: &ConnectConfig) -> String {
    if let Some(pw) = &config.password {
        if !pw.is_empty() {
            return pw.clone();
        }
    }
    if let Some(conn_id) = &config.conn_id {
        for conn in crate::store::load_raw() {
            if conn.get("id").and_then(serde_json::Value::as_str) == Some(conn_id.as_str()) {
                if let Some(pw) = conn.get("password").and_then(serde_json::Value::as_str) {
                    return pw.to_string();
                }
            }
        }
    }
    String::new()
}

/// 口令补全 (私钥 passphrase), 同上。
fn resolve_passphrase(state: &AppState, config: &ConnectConfig) -> Option<String> {
    if let Some(pp) = &config.passphrase {
        if !pp.is_empty() {
            return Some(pp.clone());
        }
    }
    if let Some(conn_id) = &config.conn_id {
        for conn in crate::store::load_raw() {
            if conn.get("id").and_then(serde_json::Value::as_str) == Some(conn_id.as_str()) {
                if let Some(pp) = conn.get("passphrase").and_then(serde_json::Value::as_str) {
                    if !pp.is_empty() {
                        return Some(pp.to_string());
                    }
                }
            }
        }
    }
    None
}

/// 加载私钥 KeyPair (支持口令)。
/// russh-keys 0.44.x: `load_secret_key` 是 `russh::keys` 的自由函数 (见官方
/// client_exec_simple 示例), 非 KeyPair 关联方法。
fn load_key_pair(
    path: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::key::KeyPair, String> {
    russh::keys::load_secret_key(path, passphrase).map_err(|_| "无法读取私钥".to_string())
}

// ================= 建立会话 (连接 + 认证 + 终端) =================

/// 完整建立一次 SSH 会话 (初始连接与重连共用)。
/// 认证方式: password / privateKey (含 passphrase) / agent (暂不支持)。
/// 返回 (终端通道, russh 会话句柄) —— 会话句柄供 sftp/tunnel/monitor 开新通道。
async fn establish_session(
    state: &AppState,
    session_id: &str,
    config: &ConnectConfig,
) -> Result<(SessionChannel, russh::client::Handle<SshClientHandler>), String> {
    let host = config.host.trim().to_string();
    if host.is_empty() {
        return Err("主机地址不能为空".to_string());
    }
    let port = if config.port == 0 { 22 } else { config.port };

    let mut client_config = russh::client::Config::default();
    // TODO(verify): russh 0.44.x Config 无 connection_timeout 字段 (0.44.1 实测无),
    //   连接超时改用下方 tokio::time::timeout 包裹。
    client_config.keepalive_interval = Some(Duration::from_secs(30));

    let handler = SshClientHandler {
        session_id: session_id.to_string(),
        host: host.clone(),
        port,
        known_hosts_path: state.known_hosts_path.clone(),
        pending: state.hostkey_pending.clone(),
        app: state.app.clone(),
        verify_host_key: config.host_key_verify.unwrap_or(true),
    };

    // russh 0.44.x: connect(config: Arc<Config>, addrs, handler) -> Handle<H>;
    // 连接超时 15s 由 tokio timeout 实现。
    let mut handle = match tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(Arc::new(client_config), (host.clone(), port), handler),
    )
    .await
    {
        Ok(Ok(h)) => h,
        Ok(Err(_)) => return Err("无法连接到远程主机".to_string()),
        Err(_) => return Err("连接超时".to_string()),
    };

    // 认证
    match config.auth_method.as_str() {
        "password" => {
            let pw = resolve_password(state, config);
            handle
                .authenticate_password(&config.username, &pw)
                .await
                .map_err(|_| "密码认证失败，请检查用户名和密码")?;
        }
        "privateKey" | "private_key" | "key" => {
            let path = config
                .private_key_path
                .clone()
                .ok_or_else(|| "请先选择私钥文件".to_string())?;
            let passphrase = resolve_passphrase(state, config);
            let key_pair = load_key_pair(&path, passphrase.as_deref())
                .map_err(|e| format!("无法读取私钥：{}", e))?;
            handle
                .authenticate_publickey(&config.username, Arc::new(key_pair))
                .await
                .map_err(|_| "密钥认证失败，请检查私钥文件或口令")?;
        }
        "agent" => {
            // russh 可通过 russh-keys 的 agent 客户端支持 SSH Agent,
            // 但当前依赖集未引入 (SPEC 5), fail-safe 返回不支持。
            return Err("暂不支持 SSH Agent 认证方式".to_string());
        }
        other => {
            return Err(format!("不支持的认证方式：{}", other));
        }
    }

    // 打开终端通道 (初始 PTY 尺寸 80x24, 前端随后会 resize)。
    // russh 0.44.x: channel_open_session() -> Channel<client::Msg>。
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|_| "打开会话通道失败")?;
    // russh 0.44.x: request_pty(want_reply, term, cols, rows, pix_w, pix_h, modes)。
    channel
        .request_pty(true, "xterm", 80, 24, 0, 0, &[])
        .await
        .map_err(|_| "请求终端失败")?;
    channel
        .request_shell(true)
        .await
        .map_err(|_| "启动远程 Shell 失败")?;

    Ok((channel, handle))
}

// ================= 终端通道循环 (actor: 独占 channel, 消费命令) =================

struct ChannelEnd {
    /// 是否收到显式退出状态。
    exit_status: Option<u32>,
    /// 连接是否异常断开 (非用户主动)。
    dropped: bool,
}

/// 终端通道主循环: 读 channel 数据 -> 发 ssh:data; 同时消费写/改尺寸/关闭命令。
/// russh 0.44.x: Channel::wait(&mut self) -> Option<ChannelMsg> (非 Stream)。
/// 返回: 收到显式 exit status 视为正常退出 (dropped=false); 否则视为连接异常 (dropped=true)。
async fn run_channel_loop(
    channel: &mut SessionChannel,
    state: &AppState,
    handle: &SessionHandle,
    cmd_rx: &mut mpsc::UnboundedReceiver<TerminalCmd>,
) -> ChannelEnd {
    let mut exit_status = None;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                let Some(msg) = msg else { break }; // 通道关闭
                match msg {
                    russh::ChannelMsg::Data { data } => {
                        emit_data(&state.app, &handle.id, data.as_ref());
                    }
                    russh::ChannelMsg::ExtendedData { data, .. } => {
                        emit_data(&state.app, &handle.id, data.as_ref());
                    }
                    russh::ChannelMsg::ExitStatus { exit_status: code } => {
                        exit_status = Some(code);
                        emit_event(
                            &state.app,
                            &handle.id,
                            "exit",
                            serde_json::json!({ "exitStatus": code }),
                        );
                    }
                    russh::ChannelMsg::ExitSignal { .. } => {
                        emit_event(
                            &state.app,
                            &handle.id,
                            "exit",
                            serde_json::json!({ "reason": "exitSignal" }),
                        );
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break }; // 命令发送端全部关闭
                match cmd {
                    TerminalCmd::Write(buf) => {
                        // Channel::data<R: AsyncRead + Unpin>(&self, R); &[u8] 满足约束。
                        let _ = tokio::time::timeout(
                            Duration::from_secs(5),
                            channel.data(buf.as_slice()),
                        )
                        .await;
                    }
                    TerminalCmd::Resize(rows, cols) => {
                        let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                    }
                    TerminalCmd::Close => {
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
        }
    }
    let dropped = exit_status.is_none();
    ChannelEnd { exit_status, dropped }
}

// ================= 会话运行时 =================

/// 会话运行时: 终端通道循环 + 异常断开后的指数退避重连。
/// 用户主动断开 (ssh_disconnect 置位) 立即终止; 正常退出 (exit status) 不重连。
async fn run_session_runtime(
    state: AppState,
    handle: SessionHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<TerminalCmd>,
    mut current: SessionChannel,
) {
    let mut attempts: u32 = 0;

    loop {
        if handle.user_disconnected.load(Ordering::SeqCst) {
            break;
        }

        let end = run_channel_loop(&mut current, &state, &handle, &mut cmd_rx).await;

        if handle.user_disconnected.load(Ordering::SeqCst) {
            break;
        }
        if !end.dropped {
            // 正常退出 (收到 exit status)。
            handle.connected.store(false, Ordering::SeqCst);
            break;
        }

        // 异常断开: 判断是否自动重连。
        if !handle.reconnect_enabled {
            emit_event(&state.app, &handle.id, "error", serde_json::json!({ "error": "连接已断开" }));
            break;
        }
        if attempts >= handle.max_attempts {
            emit_event(
                &state.app,
                &handle.id,
                "exit",
                serde_json::json!({ "reason": "重连失败，已达最大尝试次数" }),
            );
            break;
        }

        attempts += 1;
        handle.connected.store(false, Ordering::SeqCst);
        emit_event(
            &state.app,
            &handle.id,
            "reconnecting",
            serde_json::json!({ "attempt": attempts, "maxAttempts": handle.max_attempts }),
        );
        crate::audit::log(crate::audit::AuditEntry {
            r#type: Some("ssh.reconnect".into()),
            session: Some(handle.id.clone()),
            result: Some("failure".into()),
            detail: Some(format!("第 {}/{} 次尝试重连", attempts, handle.max_attempts)),
            ..Default::default()
        });

        // 指数退避 1..32s (可被用户断开打断)。
        let delay = Duration::from_secs(1u64 << (attempts - 1).min(5));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = handle.cancel.notified() => { break; }
        }
        if handle.user_disconnected.load(Ordering::SeqCst) {
            break;
        }

        // 丢弃断开期间残留的输入命令 (有界, 防重连后重放旧输入, 也防热循环)。
        for _ in 0..1024 {
            if cmd_rx.try_recv().is_err() {
                break;
            }
        }

        match establish_session(&state, &handle.id, &handle.config).await {
            Ok((channel, new_handle)) => {
                attempts = 0;
                handle.connected.store(true, Ordering::SeqCst);
                current = channel;
                // 更新会话句柄 (所有克隆共享 inner, sftp/tunnel/monitor 立即使用新连接)。
                handle.handle.replace(new_handle).await;
                emit_event(&state.app, &handle.id, "reconnected", serde_json::json!({}));
                crate::audit::log(crate::audit::AuditEntry {
                    r#type: Some("ssh.reconnect".into()),
                    session: Some(handle.id.clone()),
                    result: Some("success".into()),
                    detail: Some("自动重连成功".into()),
                    ..Default::default()
                });
            }
            Err(e) => {
                emit_event(
                    &state.app,
                    &handle.id,
                    "reconnect-failed",
                    serde_json::json!({ "attempt": attempts, "maxAttempts": handle.max_attempts, "error": e }),
                );
            }
        }
    }

    // 清理: 停止本会话隧道 + 从会话表移除 (幂等)。
    crate::tunnel::stop_all_tunnels_for_session(&state, &handle.id);
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(&handle.id);
    }
}

// ================= 命令 (契约 §2) =================

/// ssh_connect(sessionId, config) -> {ok, error?}
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    session_id: String,
    config: ConnectConfig,
) -> crate::CmdOk {
    // Tauri 2.6+: async 命令参数含 State<'_, T> 必须返回 Result, 为保持返回契约不变,
    // 改由 AppHandle 注入后内部取 state (State 类型本身不受此限制)。
    let state = app.state::<AppState>();
    // 同 id 已存在会话: 先标记断开 (幂等)。
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(old) = sessions.remove(&session_id) {
            old.user_disconnected.store(true, Ordering::SeqCst);
            old.cancel.notify_one();
        }
    }

    let (channel, handle) = match establish_session(&state, &session_id, &config).await {
        Ok(ok) => ok,
        Err(e) => {
            crate::audit::log(crate::audit::AuditEntry {
                r#type: Some("ssh.connect".into()),
                user: Some(format!("{}@{}", config.username, config.host)),
                session: Some(session_id),
                target: Some(format!("{}:{}", config.host, config.port)),
                result: Some("failure".into()),
                detail: Some(e.clone()),
                ..Default::default()
            });
            return crate::CmdOk::failure(e);
        }
    };

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<TerminalCmd>();
    let sh = SessionHandle {
        id: session_id.clone(),
        config: config.clone(),
        handle: SessionHandleInner::new(handle),
        sftp: None,
        user_disconnected: Arc::new(AtomicBool::new(false)),
        connected: Arc::new(AtomicBool::new(true)),
        cancel: Arc::new(tokio::sync::Notify::new()),
        reconnect_enabled: config.auto_reconnect.unwrap_or(true),
        max_attempts: config.auto_reconnect_max_attempts.unwrap_or(5).max(1),
        attempts: Arc::new(AtomicU32::new(0)),
        cmd_tx,
    };

    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(session_id.clone(), sh.clone());
    }

    tokio::spawn(run_session_runtime(state.inner().clone(), sh, cmd_rx, channel));

    // 自动建立该连接配置中的隧道 (修复: 原实现忽略了 config.tunnels, 前端注释期望
    // 连接成功后自动建立)。失败不阻塞连接, 仅记审计日志。
    if let Some(tunnels) = config.tunnels.as_ref() {
        for tv in tunnels {
            match serde_json::from_value::<crate::tunnel::TunnelConfig>(tv.clone()) {
                Ok(tcfg) => {
                    let r = crate::tunnel::start_tunnel(state.inner(), &session_id, tcfg).await;
                    if !r.ok {
                        crate::audit::log(crate::audit::AuditEntry {
                            r#type: Some("tunnel.start".into()),
                            session: Some(session_id.clone()),
                            result: Some("failure".into()),
                            detail: r.error.clone(),
                            ..Default::default()
                        });
                    }
                }
                Err(_) => {
                    crate::audit::log(crate::audit::AuditEntry {
                        r#type: Some("tunnel.start".into()),
                        session: Some(session_id.clone()),
                        result: Some("failure".into()),
                        detail: Some("隧道配置格式无效".into()),
                        ..Default::default()
                    });
                }
            }
        }
    }

    crate::audit::log(crate::audit::AuditEntry {
        r#type: Some("ssh.connect".into()),
        user: Some(format!("{}@{}", config.username, config.host)),
        session: Some(session_id),
        target: Some(format!("{}:{}", config.host, config.port)),
        result: Some("success".into()),
        ..Default::default()
    });

    crate::CmdOk::success()
}

/// ssh_write(sessionId, data) -> {ok, error?}
/// 经命令通道下发到后台任务, 由后台任务独占 channel 写入 (fire-and-forget)。
#[tauri::command]
pub async fn ssh_write(
    app: AppHandle,
    session_id: String,
    data: String,
) -> crate::CmdOk {
    let state = app.state::<AppState>();
    let handle = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return crate::CmdOk::failure("会话不存在或已断开");
    };

    match handle.cmd_tx.send(TerminalCmd::Write(data.into_bytes())) {
        Ok(()) => crate::CmdOk::success(),
        Err(_) => crate::CmdOk::failure("会话不存在或已断开"),
    }
}

/// ssh_resize(sessionId, rows, cols) -> {ok}
#[tauri::command]
pub async fn ssh_resize(
    app: AppHandle,
    session_id: String,
    rows: u32,
    cols: u32,
) -> crate::CmdOk {
    let state = app.state::<AppState>();
    let handle = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return crate::CmdOk::failure("会话不存在或已断开");
    };

    match handle.cmd_tx.send(TerminalCmd::Resize(rows, cols)) {
        Ok(()) => crate::CmdOk::success(),
        Err(_) => crate::CmdOk::failure("会话不存在或已断开"),
    }
}

/// ssh_disconnect(sessionId) -> {ok}
#[tauri::command]
pub async fn ssh_disconnect(app: AppHandle, session_id: String) -> crate::CmdOk {
    let state = app.state::<AppState>();
    let handle = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };
    if let Some(handle) = handle {
        // 标记用户主动断开 (阻止重连) + 唤醒退避 sleep + 下发关闭命令。
        handle.user_disconnected.store(true, Ordering::SeqCst);
        handle.cancel.notify_one();
        let _ = handle.cmd_tx.send(TerminalCmd::Close);
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(&session_id);
    }
    // 清理本会话隧道 (仅绑 127.0.0.1, 随会话一起停止)。
    crate::tunnel::stop_all_tunnels_for_session(&state, &session_id);
    crate::audit::log(crate::audit::AuditEntry {
        r#type: Some("ssh.disconnect".into()),
        session: Some(session_id),
        result: Some("success".into()),
        ..Default::default()
    });
    crate::CmdOk::success()
}

/// hostkey_accept(sessionId, override) -> {ok, error?}
/// 前端在收到 hostkey:confirm / hostkey:mismatch 后调用; 接受即写入信任 (override 语义兼容原版)。
#[tauri::command]
pub fn hostkey_accept(
    state: State<'_, AppState>,
    session_id: String,
    r#override: bool,
) -> crate::CmdOk {
    let pending = state.hostkey_pending.lock().unwrap().remove(&session_id);
    match pending {
        Some(p) => {
            // override=false: 首次信任 (unknown); override=true: 覆盖旧指纹 (mismatch)。
            // 两分支均写入信任; 若写入失败仅影响指纹库, 连接决策仍按用户选择放行。
            let _ = crate::hostkey::trust_host_key(
                &state.known_hosts_path,
                &p.host,
                p.port,
                &p.fingerprint,
                &p.algorithm,
            );
            let _ = p.tx.send(true);
            crate::CmdOk::success()
        }
        None => crate::CmdOk::failure("没有待确认的主机密钥"),
    }
}

/// hostkey_reject(sessionId) -> {ok}
#[tauri::command]
pub fn hostkey_reject(state: State<'_, AppState>, session_id: String) -> crate::CmdOk {
    let pending = state.hostkey_pending.lock().unwrap().remove(&session_id);
    if let Some(p) = pending {
        let _ = p.tx.send(false);
    }
    crate::CmdOk::success()
}
