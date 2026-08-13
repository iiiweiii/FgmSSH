//! 端口转发 / 隧道（tunnel）
//!
//! 职责（对应 SPEC 第 2 节命令）：
//!   - `tunnel_start`  建立本地 TCP 监听（仅绑 127.0.0.1），连接到来时经会话
//!     `channel_open_direct_tcpip` 转发到远端 host:port，返回 tunnelId
//!   - `tunnel_list`   查询会话隧道列表
//!   - `tunnel_stop`   按 tunnelId 停止并清理
//!   - `stop_all_tunnels_for_session`  会话关闭时由 ssh.rs / lib.rs 调用，自动清理全部隧道
//!
//! 安全要点：
//!   - 本地端口只绑定 127.0.0.1（绑定失败即返回错误），绝不监听 0.0.0.0。
//!   - 端口校验：local_port / remote_port 必须为 1..=65535 整数。
//!   - 同会话内本地端口重复检测。
//!   - 错误信息固定友好文案，不泄露远端路径 / 堆栈。
//!
//! 依赖 crate::state::AppState（backend-core 提供）字段：
//!   - `pub sessions: Arc<std::sync::Mutex<HashMap<String, SessionHandle>>>`
//!     （std Mutex 短临界区，不跨 await 持有）
//!   - `pub tunnels: Arc<std::sync::Mutex<HashMap<String, Vec<TunnelRecord>>>>`
//!     （TunnelRecord 由本模块定义；state.rs 已按此对齐）
//!   - `crate::ssh::SessionHandle.handle: SessionHandleInner`（可 Clone，提供
//!     `channel_open_direct_tcpip(host, port, originator_host, originator_port)` async 方法）

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::net::TcpListener;

/// 单条隧道记录（内部注册表项，含任务句柄用于停止）
pub struct TunnelRecord {
    pub tunnel_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub name: String,
    pub status: String, // "running" | "failed" | "stopping"
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub task: tokio::task::JoinHandle<()>,
}

/// 隧道配置（前端传 camelCase）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub local_port: u32,
    pub remote_host: String,
    pub remote_port: u32,
    #[serde(default)]
    pub name: String,
}

/// 归一化隧道配置：远端主机为空默认 127.0.0.1（与 Electron tunnel-manager.js describe 一致）
fn describe(cfg: &TunnelConfig) -> (u16, String, u16, String) {
    let local = cfg.local_port.clamp(1, 65535) as u16;
    let remote_port = cfg.remote_port.clamp(1, 65535) as u16;
    let host = if cfg.remote_host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        cfg.remote_host.trim().to_string()
    };
    (local, host, remote_port, cfg.name.clone())
}

// ---------------------------------------------------------------------------
// 返回结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStartResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub name: String,
    pub status: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelListResult {
    pub ok: bool,
    pub tunnels: Vec<TunnelInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStopResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn tunnel_id_seq() -> &'static std::sync::atomic::AtomicU64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    &SEQ
}

// ---------------------------------------------------------------------------
// tunnel_start
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tunnel_start(
    session_id: String,
    cfg: TunnelConfig,
    state: State<'_, AppState>,
) -> TunnelStartResult {
    // 端口校验（1..=65535 整数）
    if cfg.local_port < 1 || cfg.local_port > 65535 {
        return TunnelStartResult { ok: false, tunnel_id: None, error: Some("本地端口无效".to_string()) };
    }
    if cfg.remote_port < 1 || cfg.remote_port > 65535 {
        return TunnelStartResult { ok: false, tunnel_id: None, error: Some("远端端口无效".to_string()) };
    }
    let (local_port, remote_host, remote_port, name) = describe(&cfg);

    // 同会话内本地端口重复检查
    {
        let guard = match state.tunnels.lock() {
            Ok(g) => g,
            Err(_) => return TunnelStartResult { ok: false, tunnel_id: None, error: Some("系统状态异常".to_string()) },
        };
        if let Some(records) = guard.get(&session_id) {
            if records.iter().any(|r| r.status == "running" && r.local_port == local_port) {
                return TunnelStartResult { ok: false, tunnel_id: None, error: Some(format!("本地端口 {} 已在该会话中使用", local_port)) };
            }
        }
    }

    // 仅绑定 127.0.0.1（绑定失败即错）
    let listener = match TcpListener::bind(("127.0.0.1", local_port)).await {
        Ok(l) => l,
        Err(_) => return TunnelStartResult { ok: false, tunnel_id: None, error: Some("绑定本地端口失败".to_string()) },
    };

    // 获取会话 handle（SessionHandleInner: 开 direct_tcpip 通道）。
    let handle = {
        match state.sessions.lock() {
            Ok(guard) => match guard.get(&session_id) {
                Some(sh) => sh.handle.clone(),
                None => {
                    return TunnelStartResult { ok: false, tunnel_id: None, error: Some("会话不存在".to_string()) };
                }
            },
            Err(_) => {
                return TunnelStartResult { ok: false, tunnel_id: None, error: Some("会话状态不可用".to_string()) };
            }
        }
    };

    let tunnel_id = format!("t_{}_{:x}", now_ms(), tunnel_id_seq().fetch_add(1, std::sync::atomic::Ordering::Relaxed));

    // 监听循环任务：收到本地连接 -> direct_tcpip 到远端 -> 双向转发
    let remote_host_c = remote_host.clone();
    let name_c = name.clone();
    let task = tokio::spawn(async move {
        loop {
            let (socket, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => break, // 监听错误即终止任务（外部调用 abort 也会终止）
            };
            let channel = match handle
                .channel_open_direct_tcpip(&remote_host_c, remote_port as u32, "127.0.0.1", local_port as u32)
                .await
            {
                Ok(c) => c,
                Err(_) => {
                    drop(socket);
                    continue;
                }
            };
            tokio::spawn(async move {
                // russh 0.44.x: Channel 本身不实现 AsyncRead/AsyncWrite,
                // 需先 into_stream() 转为 ChannelStream 再双向拷贝。
                // ChannelStream 实现 tokio::io::AsyncRead/AsyncWrite（已按 docs.rs 0.44.1 核实）。
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    // 登记到会话隧道注册表
    {
        let mut guard = match state.tunnels.lock() {
            Ok(g) => g,
            Err(_) => {
                task.abort();
                return TunnelStartResult { ok: false, tunnel_id: None, error: Some("系统状态异常".to_string()) };
            }
        };
        let record = TunnelRecord {
            tunnel_id: tunnel_id.clone(),
            local_port,
            remote_host,
            remote_port,
            name: name_c,
            status: "running".to_string(),
            error: None,
            created_at_ms: now_ms(),
            task,
        };
        guard.entry(session_id).or_default().push(record);
    }

    TunnelStartResult { ok: true, tunnel_id: Some(tunnel_id), error: None }
}

// ---------------------------------------------------------------------------
// tunnel_list / tunnel_stop / 会话清理
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tunnel_list(session_id: String, state: State<'_, AppState>) -> TunnelListResult {
    let guard = match state.tunnels.lock() {
        Ok(g) => g,
        Err(_) => {
            return TunnelListResult { ok: false, tunnels: Vec::new() };
        }
    };
    let mut tunnels: Vec<TunnelInfo> = match guard.get(&session_id) {
        Some(records) => records
            .iter()
            .map(|r| TunnelInfo {
                id: r.tunnel_id.clone(),
                local_port: r.local_port,
                remote_host: r.remote_host.clone(),
                remote_port: r.remote_port,
                name: r.name.clone(),
                status: r.status.clone(),
                created_at: r.created_at_ms,
                error: r.error.clone(),
            })
            .collect(),
        None => Vec::new(),
    };
    tunnels.sort_by_key(|t| t.created_at);
    TunnelListResult { ok: true, tunnels }
}

#[tauri::command]
pub fn tunnel_stop(session_id: String, tunnel_id: String, state: State<'_, AppState>) -> TunnelStopResult {
    let mut guard = match state.tunnels.lock() {
        Ok(g) => g,
        Err(_) => return TunnelStopResult { ok: false, error: Some("系统状态异常".to_string()) },
    };
    let records = match guard.get_mut(&session_id) {
        Some(r) => r,
        None => return TunnelStopResult { ok: false, error: Some("隧道不存在".to_string()) },
    };
    let idx = match records.iter().position(|r| r.tunnel_id == tunnel_id) {
        Some(i) => i,
        None => return TunnelStopResult { ok: false, error: Some("隧道不存在".to_string()) },
    };
    let record = records.remove(idx);
    record.task.abort();
    // 移除后若空则清理会话键
    if records.is_empty() {
        guard.remove(&session_id);
    }
    TunnelStopResult { ok: true, error: None }
}

/// 会话关闭时清理全部隧道（ssh.rs / lib.rs 断开会话时调用）。
/// 返回被清理的隧道数量；幂等（无注册表时返回 0）。
pub fn stop_all_tunnels_for_session(state: &AppState, session_id: &str) -> usize {
    let mut guard = match state.tunnels.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let records = match guard.remove(session_id) {
        Some(r) => r,
        None => return 0,
    };
    let count = records.len();
    for r in records {
        r.task.abort();
    }
    count
}
