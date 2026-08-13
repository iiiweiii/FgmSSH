/**
 * FgmSSH Tauri v2 - window.nimbus 桥接层 (核心交付物)
 * ============================================================
 * 目标: 让原样复用的 src/renderer.js 中全部 `window.nimbus.*` 调用在 Tauri 下原样工作。
 * 实现: @tauri-apps/api 的 invoke() 映射到 SPEC 第 2 节定义的小写下划线 Tauri Command;
 *       事件用 listen() 订阅后转发到内部回调表, on* 注册回调并返回取消函数。
 *
 * 安全约束 (对应 SPEC 第 4 节):
 *   - 渲染进程无 Node API: 本文件不做任何 require('electron') / node 模块;
 *   - 拖拽 File 取真实磁盘路径 (webUtils.getPathForFile) 是 Electron 专属能力,
 *     Tauri 前端拿不到真实路径。采用「对话框为主」方案 (见 sftpRegisterUploadPaths);
 *   - 本桥接层只转发, 不接触凭据明文; store_load 脱敏等由后端保证。
 *
 * 兼容性基线: 与 fmgssh-review/preload.js 暴露的 API 形状一一对应 (含返回 Promise 语义;
 * Tauri invoke 的 Promise reject 语义与 ipcRenderer.invoke 一致)。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
// pdfjs worker 源文件经 vite「?url」资产导入: 打包后作为独立静态资源输出并提供运行时 URL,
// 供 renderer.js 的 renderDocPdf 取来转 Blob URL 使用 (dev/build 均可解析, 不依赖 node_modules 相对路径)。
// 注: pdfjs-dist@4 无 exports 字段, 裸子路径 `pdfjs-dist/build/pdf.worker.min.mjs` 可直接解析。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ---------------------------------------------------------------------------
// 运行环境守卫: 在纯浏览器 (非 Tauri) 下打开时给出可诊断的错误, 而不是静默失败
// ---------------------------------------------------------------------------
function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

function guardedInvoke(cmd, args) {
  if (!isTauriRuntime()) {
    const err = new Error(`[nimbus-bridge] 非 Tauri 运行时, 无法调用命令 "${cmd}"。请在 tauri dev / 打包后的应用内运行。`);
    return Promise.reject(err);
  }
  return invoke(cmd, args);
}

function safeCall(cb, payload) {
  try {
    cb(payload);
  } catch (err) {
    console.error('[nimbus-bridge] 事件回调异常:', err);
  }
}

// ---------------------------------------------------------------------------
// 事件桥: 订阅 Tauri 后端事件 -> 分发给 on* 注册的回调
// ---------------------------------------------------------------------------
const cbTable = {
  data: new Set(),            // onData        <- ssh:data
  event: new Set(),           // onEvent       <- ssh:event (+ 兼容独立 sftp 进度事件)
  hostKeyConfirm: new Set(),  // onHostKeyConfirm <- hostkey:confirm
  hostKeyMismatch: new Set(), // onHostKeyMismatch <- hostkey:mismatch
  updateCheck: new Set(),     // onUpdateCheck <- update:check
};

// 若后端按 SPEC 第 3 节把 sftp 进度作为独立事件发射, 归一化为 renderer.js 期望的
// onEvent 同构 payload {sessionId, type, ...rest} (renderer 在 ssh:event 里读 type/phase)。
function normalizeProgress(type, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  return Object.assign({}, p, { type, sessionId: p.sessionId });
}

function startEventBridge() {
  const subscriptions = [
    { tauriEvent: 'ssh:data', dispatch: (p) => cbTable.data.forEach((cb) => safeCall(cb, p)) },
    { tauriEvent: 'ssh:event', dispatch: (p) => cbTable.event.forEach((cb) => safeCall(cb, p)) },
    { tauriEvent: 'hostkey:confirm', dispatch: (p) => cbTable.hostKeyConfirm.forEach((cb) => safeCall(cb, p)) },
    { tauriEvent: 'hostkey:mismatch', dispatch: (p) => cbTable.hostKeyMismatch.forEach((cb) => safeCall(cb, p)) },
    { tauriEvent: 'update:check', dispatch: (p) => cbTable.updateCheck.forEach((cb) => safeCall(cb, p)) },
    // 兼容: SPEC 独立进度事件 -> 归入 onEvent (后端若已走 ssh:event 则不重复触发)
    { tauriEvent: 'sftp-upload-progress', dispatch: (p) => cbTable.event.forEach((cb) => safeCall(cb, normalizeProgress('sftp-upload-progress', p))) },
    { tauriEvent: 'sftp-download-progress', dispatch: (p) => cbTable.event.forEach((cb) => safeCall(cb, normalizeProgress('sftp-download-progress', p))) },
  ];
  if (!isTauriRuntime()) return; // 纯浏览器下跳过订阅, 由 guardedInvoke 负责报错
  for (const sub of subscriptions) {
    listen(sub.tauriEvent, (e) => sub.dispatch(e.payload)).catch((err) => {
      console.warn(`[nimbus-bridge] 事件订阅失败 ${sub.tauriEvent}:`, err);
    });
  }
}

// on* 统一实现: 注册回调到表, 返回取消函数 (与 Electron ipcRenderer.on 无取消句柄相比,
// 返回函数为幂等增强; renderer.js 忽略返回值, 行为兼容)
function makeOn(kind) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    cbTable[kind].add(cb);
    return () => cbTable[kind].delete(cb);
  };
}

// ---------------------------------------------------------------------------
// 拖拽/文件选择 兼容层 (Tauri 拿不到 File 的磁盘路径)
// ---------------------------------------------------------------------------
// getPathForFile: Electron 专属 (webUtils.getPathForFile 同步返回磁盘路径)。
// Tauri 前端无法获得真实磁盘路径, 恒返回空串 —— renderer.js 的 drop 处理会因此走到
// 「无法获取拖拽文件路径」分支。这是已知 UX 妥协: 拖拽上传退化为「使用上传按钮/对话框选择」,
// 对应 renderer.js: handleSftpDrop 中的提示路径。
function getPathForFile() {
  return ''; // TODO(verify): 若后续后端实现 File -> 路径通道可在此接回
}

// 判断入参是否「真实拖拽产生的 File 对象」: 具备 name/type/size 等特征且非字符串
function isFileLike(v) {
  return v && typeof v === 'object' && typeof v.name === 'string'
    && (typeof v.type === 'string' || 'webkitRelativePath' in v || typeof v.size === 'number');
}

// sftpRegisterUploadPaths:
//   - 入参为 File 对象数组 (renderer.js handleSftpDrop 拖拽流程) -> 拒绝并提示改走对话框;
//   - 入参为字符串数组 (对话框流程登记的本地路径 / 未来增强) -> 直接 invoke sftp_register_upload_paths。
// 安全: 字符串数组仅接受普通字符串, 不做 Node 路径解析; 后端负责存在性/普通文件/数量校验。
async function sftpRegisterUploadPaths(filesOrPaths) {
  if (!Array.isArray(filesOrPaths)) {
    return { ok: false, error: 'sftp_register_upload_paths 需要字符串路径数组' };
  }
  const hasFileObjects = filesOrPaths.some(isFileLike);
  if (hasFileObjects) {
    // 拖拽登记退化方案: Tauri 下拿不到拖拽 File 的真实磁盘路径,
    // 提示用户改走「上传文件」对话框 (renderer 收到 reg.ok=false 后按 accepted 空处理)。
    console.warn('[nimbus-bridge] 拖拽上传在 Tauri 下不受支持 (无 webUtils.getPathForFile), 请使用上传对话框');
    return { ok: false, error: '拖拽上传请使用文件选择对话框', accepted: [] };
  }
  const paths = filesOrPaths.filter((p) => typeof p === 'string' && p.length > 0);
  if (paths.length === 0) {
    return { ok: false, error: '没有可登记的上传路径', accepted: [] };
  }
  return guardedInvoke('sftp_register_upload_paths', { paths });
}

// ---------------------------------------------------------------------------
// window.nimbus
// ---------------------------------------------------------------------------
const nimbus = {
  // ---- SSH 连接/终端 ----
  connect: (sessionId, config) => guardedInvoke('ssh_connect', { sessionId, config }),
  write: (sessionId, data) => guardedInvoke('ssh_write', { sessionId, data }),
  resize: (sessionId, rows, cols) => guardedInvoke('ssh_resize', { sessionId, rows, cols }),
  disconnect: (sessionId) => guardedInvoke('ssh_disconnect', { sessionId }),

  // ---- 端口转发隧道 ----
  // 兼容旧调用名 createTunnel(sessionId, tunnelCfg) 与新名 tunnelStart(sessionId, cfg)
  createTunnel: (sessionId, tunnelCfg) => guardedInvoke('tunnel_start', { sessionId, cfg: tunnelCfg }),
  tunnelStart: (sessionId, cfg) => guardedInvoke('tunnel_start', { sessionId, cfg }),
  tunnelList: (sessionId) => guardedInvoke('tunnel_list', { sessionId }),
  tunnelStop: (sessionId, tunnelId) => guardedInvoke('tunnel_stop', { sessionId, tunnelId }),

  // ---- 服务器健康监控 ----
  monitorFetch: (sessionId) => guardedInvoke('ssh_monitor_fetch', { sessionId }),

  // ---- 认证辅助 ----
  selectKeyFile: () => guardedInvoke('dialog_select_key', {}),
  // Electron 下用于 SSH-Agent 密钥选择; Tauri SPEC 未定义对应命令, 保留桩供兼容。
  // 后端若实现 ssh_choose_ssh_agent 可在此接线。
  checkAgent: () => Promise.resolve({ ok: false, error: 'not_implemented' }), // TODO(verify): 后端未提供 ssh_choose_ssh_agent

  // ---- SFTP 文件浏览 ----
  sftpList: (sessionId, path) => guardedInvoke('sftp_list', { sessionId, path }),
  sftpDownload: (sessionId, remotePath, localPath) => guardedInvoke('sftp_download', { sessionId, remotePath, localPath }),
  sftpUpload: (sessionId, localPath, remotePath) => guardedInvoke('sftp_upload', { sessionId, localPath, remotePath }),
  getPathForFile,
  sftpRegisterUploadPaths,
  sftpMkdir: (sessionId, path) => guardedInvoke('sftp_mkdir', { sessionId, path }),
  sftpDelete: (sessionId, path) => guardedInvoke('sftp_delete', { sessionId, path }),
  sftpRename: (sessionId, oldPath, newPath) => guardedInvoke('sftp_rename', { sessionId, oldPath, newPath }),
  sftpDownloadFolder: (sessionId, remotePath, localZipPath) => guardedInvoke('sftp_download_folder', { sessionId, remotePath, localZipPath }),
  sftpCdSync: (sessionId, rawPath) => guardedInvoke('sftp_cd_sync', { sessionId, rawPath }),
  sftpSearch: (sessionId, path, keyword, maxDepth) => guardedInvoke('sftp_search', { sessionId, path, keyword, maxDepth }),

  // ---- 本地文件对话框 ----
  // 注意: 后端命令参数名与这里 invoke 的键一一对应 (camelCase)
  selectFile: () => guardedInvoke('dialog_select_file', {}),
  selectSavePath: (defaultName) => guardedInvoke('dialog_select_save_path', { defaultName }),

  // ---- 图片预览 ----
  previewOpen: (sessionId, remotePath) => guardedInvoke('preview_open', { sessionId, remotePath }),
  previewClose: (filename) => guardedInvoke('preview_close', { filename }),
  previewSaveAs: (sessionId, remotePath) => guardedInvoke('preview_save_as', { sessionId, remotePath }),

  // ---- 内置文档查看器 ----
  docOpen: (sessionId, remotePath) => guardedInvoke('doc_open', { sessionId, remotePath }),
  docLoadFull: (sessionId, filename) => guardedInvoke('doc_load_full', { sessionId, filename }),
  docSave: (sessionId, remotePath, content) => guardedInvoke('doc_save', { sessionId, remotePath, content }),
  docClose: (filename) => guardedInvoke('doc_close', { filename }),

  // ---- 连接配置存储 ----
  storeLoad: () => guardedInvoke('store_load', {}),
  storeSave: (list) => guardedInvoke('store_save', { list }),

  // ---- 全局设置 ----
  settingsLoad: () => guardedInvoke('settings_load', {}),
  settingsSave: (settings) => guardedInvoke('settings_save', { settings }),

  // ---- 配置加密导出/导入 ----
  configExport: (password) => guardedInvoke('config_export', { password }),
  configImport: (password) => guardedInvoke('config_import', { password }),

  // ---- 其他 ----
  openExternal: (url) => guardedInvoke('open_external', { url }),

  // ---- 操作日志 ----
  auditLog: (entry) => guardedInvoke('audit_log', { entry }),
  auditQuery: (filters) => guardedInvoke('audit_query', { filters }),

  // ---- 更新检查 ----
  updateCheck: () => guardedInvoke('update_check', {}),

  // ---- 主机密钥指纹 (TOFU) ----
  hostKeyAccept: (sessionId, override) => guardedInvoke('hostkey_accept', { sessionId, override }),
  hostKeyReject: (sessionId) => guardedInvoke('hostkey_reject', { sessionId }),

  // ---- 事件注册 (返回取消函数) ----
  onData: makeOn('data'),
  onEvent: makeOn('event'),
  onUpdateCheck: makeOn('updateCheck'),
  onHostKeyConfirm: makeOn('hostKeyConfirm'),
  onHostKeyMismatch: makeOn('hostKeyMismatch'),
};

// 幂等: 只挂载一次
if (!window.nimbus) {
  window.nimbus = nimbus;
}
// 暴露 pdfjs worker 资产 URL (供 renderer.js 的 PDF 渲染使用; 见 renderDocPdf)
window.__PDFJS_WORKER_URL__ = pdfWorkerUrl;
startEventBridge();
