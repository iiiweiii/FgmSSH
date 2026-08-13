//! 服务器健康监控（monitor）
//!
//! 职责（对应 SPEC 命令 `ssh_monitor_fetch`）：
//!   - 在会话上执行「编译期常量」命令表（uptime / free / df / top / hostname / os-release /
//!     date / nvidia-smi），与 Electron 版 health-parser.js 的 `MONITOR_COMMANDS` 完全一致，
//!     保证前端 health-parser.js 可直接解析输出。
//!   - 单条命令：输出上限 64KB、超时 8s；单条失败不阻塞整体（errors 记录固定文案）。
//!   - 解析策略（与 team-lead 约定的实现选择）：
//!     **后端只返回原始 stdout 分组（raw: { cmd, stdout }），结构化字段 info/load/memory/
//!     disks/cpu 由前端 health-parser.js 从 raw 解析填充**，后端不重复解析，避免两套解析
//!     逻辑漂移。命令成功但解析失败等语义由前端负责。
//!
//! 本模块同时导出 `exec_remote_command`（通用远端命令执行助手），供 sftp.rs 的
//! `sftp_search`（find 递归搜索）复用——两处均走同一 64KB/8s 上限与友好错误收敛。
//!
//! 依赖 crate::state::AppState（backend-core 提供）字段：
//!   - `pub sessions: Arc<std::sync::Mutex<HashMap<String, crate::ssh::SessionHandle>>>`
//!     （std Mutex 短临界区，不跨 await 持有）
//!   - `crate::ssh::SessionHandle.handle: SessionHandleInner`（可 Clone，提供
//!     `channel_open_session()` 等 async 方法开新通道，见 ssh.rs；无需暴露原始 Handle）

use crate::state::AppState;
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::State;

/// 单条命令输出上限（与 Electron execSSHCommand 默认一致）
pub const EXEC_MAX_BYTES: usize = 64 * 1024;
/// 单条命令执行超时
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(8);

/// 编译期常量命令表（与 Electron health-parser.js MONITOR_COMMANDS 一致）。
/// 全部为常量字符串，无任何用户输入拼接，无注入面。
pub const MONITOR_COMMANDS: &[(&str, &str)] = &[
    ("load", "uptime"),
    ("memory", "free -k"),
    ("disks", "df -h -P"),
    ("cpu", "top -bn1"),
    ("hostname", "hostname"),
    ("os", "cat /etc/os-release"),
    ("date", "date -u +%Y-%m-%dT%H:%M:%SZ"),
    (
        "gpu",
        "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits",
    ),
];

/// 单条命令执行结果
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    /// 远端退出码（未获取到为 None）
    pub code: Option<u32>,
}

/// 原始命令输出分组（raw 项）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RawCommandOutput {
    pub cmd: String,
    pub stdout: String,
}

/// `ssh_monitor_fetch` 返回结构。
/// 说明：结构化字段 info/load/memory/disks/cpu 由前端 health-parser.js 解析 raw 后填充，
/// 后端统一置 null/空（与 SPEC 返回形状一致但值为空），errors 为后端收集的命令失败信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorResponse {
    pub ok: bool,
    pub info: Option<serde_json::Value>,
    pub load: Option<serde_json::Value>,
    pub memory: Option<serde_json::Value>,
    pub disks: Vec<serde_json::Value>,
    pub cpu: Option<serde_json::Value>,
    pub errors: HashMap<String, String>,
    pub raw: HashMap<String, RawCommandOutput>,
}

/// 在指定会话上执行单条远端命令并收集输出（输出上限 + 超时保护）。
/// 命令字符串必须来自编译期常量表（或经 sftp_search 白名单构造），调用方负责注入安全。
/// 错误返回固定友好文案，不泄露远端路径/堆栈细节。
pub async fn exec_remote_command(
    state: &AppState,
    session_id: &str,
    command: &str,
    max_bytes: usize,
    timeout: Duration,
) -> Result<ExecOutput, String> {
    // 经 SessionHandleInner 开新会话通道 (ssh.rs 的 channel_open_session, 已收敛友好错误)。
    let handle = {
        let guard = state.sessions.lock().map_err(|_| "会话状态不可用")?;
        let sh = guard
            .get(session_id)
            .ok_or_else(|| "会话不存在".to_string())?;
        sh.handle.clone()
    };

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|_| "会话不存在或未就绪")?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| "命令执行失败")?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut code: Option<u32> = None;

    let fut = async {
        // russh 0.44.x: channel.wait().await -> Option<ChannelMsg> (直接是消息, 无 Result 包裹)。
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => append_capped(&mut stdout, data.as_ref(), max_bytes),
                ChannelMsg::ExtendedData { data, .. } => {
                    append_capped(&mut stderr, data.as_ref(), max_bytes)
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    };

    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| "命令执行超时")?;

    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code,
    })
}

/// 追加字节到输出缓冲，超过上限后丢弃（避免内存膨胀）。
fn append_capped(buf: &mut Vec<u8>, data: &[u8], max_bytes: usize) {
    if buf.len() >= max_bytes {
        return;
    }
    let take = (max_bytes - buf.len()).min(data.len());
    buf.extend_from_slice(&data[..take]);
}

/// `ssh_monitor_fetch`：并发执行全部监控命令，逐条失败不阻塞整体。
#[tauri::command]
pub async fn ssh_monitor_fetch(
    session_id: String,
    state: State<'_, AppState>,
) -> MonitorResponse {
    // 前置会话存在性校验（无会话时快速失败，避免为每条命令都走一遍锁）
    {
        match state.sessions.lock() {
            Ok(guard) => {
                if !guard.contains_key(&session_id) {
                    return monitor_fail("会话不存在");
                }
            }
            Err(_) => return monitor_fail("会话状态不可用"),
        }
    }

    // 并发组：每条命令独立 try/catch 语义，失败仅记入 errors，不阻塞整体。
    let futs: Vec<_> = MONITOR_COMMANDS
        .iter()
        .map(|(section, cmd)| {
            let sid = session_id.clone();
            let section = (*section).to_string();
            let cmd = (*cmd).to_string();
            // 借用 state（State 实现 Deref<Target=AppState>，可隐式转为 &AppState）
            let st = &state;
            async move {
                let out =
                    exec_remote_command(st, &sid, &cmd, EXEC_MAX_BYTES, EXEC_TIMEOUT).await;
                (section, cmd, out)
            }
        })
        .collect();

    let results = futures::future::join_all(futs).await;

    let mut raw: HashMap<String, RawCommandOutput> = HashMap::new();
    let mut errors: HashMap<String, String> = HashMap::new();
    for (section, cmd, res) in results {
        match res {
            Ok(out) => {
                raw.insert(
                    section,
                    RawCommandOutput {
                        cmd,
                        stdout: out.stdout,
                    },
                );
                let stderr = out.stderr.trim();
                if !stderr.is_empty() {
                    // 与 Electron 行为一致：stderr 作为该 section 的降级说明（截断 200 字符）
                    errors.insert(section, stderr.chars().take(200).collect());
                }
            }
            Err(e) => {
                errors.insert(section, e);
            }
        }
    }

    MonitorResponse {
        ok: true,
        info: None,
        load: None,
        memory: None,
        disks: Vec::new(),
        cpu: None,
        errors,
        raw,
    }
}

fn monitor_fail(error: &str) -> MonitorResponse {
    MonitorResponse {
        ok: false,
        info: None,
        load: None,
        memory: None,
        disks: Vec::new(),
        cpu: None,
        errors: HashMap::new(),
        raw: HashMap::new(),
    }
}
