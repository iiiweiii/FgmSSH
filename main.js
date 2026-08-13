/**
 * FgmSSH - 主进程
 * 负责: 创建窗口 / SSH 连接管理 / IPC 通信 / SFTP 文件传输 / 图片预览 / 系统托盘保活 / 服务器健康监控
 *
 * ==================== 应用生命周期 (托盘保活) ====================
 * 会话生命周期约定 (Roadmap: 最小化到托盘 + 后台保活, P1 行为变更):
 *   - 「关闭窗口」按钮 / Alt+F4  -> 最小化到系统托盘 (win.hide), 进程与所有 SSH 会话保持存活, 不做任何清理。
 *   - 「托盘双击 / 菜单『显示主窗口』」-> 恢复并聚焦主窗口 (win.show + focus)。
 *   - 「托盘菜单『退出』/ 文件菜单或 Ctrl+Q」-> 真正退出: isQuitting=true -> app.quit()
 *     -> before-quit 执行 cleanupAllSessions (断开全部会话 + 停止全部隧道 + 会话清理审计)
 *     -> will-quit 清理临时目录 + 冲刷审计日志 + 销毁托盘图标。
 *   - 单实例锁已启用; 第二个实例启动时 second-instance 恢复既有主窗口, 不重复建窗。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');
const { Client } = require('ssh2');
const auditLog = require('./src/audit-log'); // 操作日志模块 (纯 node, 见 src/audit-log.js)
// 连接凭据加密存储 (纯 node, 见 src/credential-store.js): 主进程 safeStorage 注入,
// 仅负责 password/passphrase 的加解密/迁移; store:load 返回脱敏视图 (凭据仅存主进程),
// store:save 由主进程加密落盘 (fail-closed, 任一记录加密失败即拒绝写入)。
// auditLog 模块在文件顶部已引入 (此处仅引用模块对象, 实际调用发生在运行时, 无初始化顺序问题)。
const credentialStore = require('./src/credential-store').createCredentialStore({
  safeStorage,
  log: (m) => auditLog.logAudit({ type: 'store.migrate', detail: m }),
});
// 隧道/端口转发管理器 (纯 node, 见 src/tunnel-manager.js): 以会话为粒度登记/停止/清理隧道,
// 复用原有 net.createServer + conn.forwardOut 通道, 新增审计与生命周期管理, 便于 node 直跑测试。
const tunnelManager = require('./src/tunnel-manager').createTunnelManager();
// 断线自动重连策略 (纯 node, 见 src/reconnect.js): 指数退避 1s/2s/4s/... 上限 32s,
// 总重试上限可配置 (默认 5); 用户主动断开/退出/会话关闭时取消定时器; 可注入 mock 直跑测试。
const reconnectModule = require('./src/reconnect');
// SFTP 断点续传核心 (纯 node, 见 src/transfer-resume.js): 下载 .part 续传 + 上传远端 stat 基准续传,
// 进度回调 + 审计联动, sftp/fs 可注入 mock 直跑测试。
const transferResume = require('./src/transfer-resume');
// 配置加密导出/导入 (纯 node crypto, 见 src/config-portable.js): AES-256-GCM + scrypt,
// 导出文件整文件加密 (不含明文凭据), 导入 GCM 认证失败即「密码错误或文件已损坏」。
const configPortable = require('./src/config-portable');
// 服务器健康监控解析 (纯 node, 见 src/health-parser.js): 解析 uptime/free/df/top 输出为
// 结构化指标; fetchMonitorData 通过 exec 注入采集, main.js 注入 ssh2 conn.exec 封装。
const healthParser = require('./src/health-parser');
// SFTP 文件搜索/过滤 (纯 node, 见 src/file-filter.js): 客户端子串过滤 + find 递归搜索
// 命令构造 (关键字白名单 + maxdepth 钳制 + 单引号转义, 无注入面) + find 输出解析。
const fileFilter = require('./src/file-filter');
// 文本编辑增强 (纯 node, 见 src/editor-highlight.js): 大文件分段加载阈值判定
// (isLargeDoc/segmentPreviewInfo 供 doc:open 共用, 渲染层负责语法高亮)。
const editorHighlight = require('./src/editor-highlight');
// 更新检查 (纯 node, 见 src/update-check.js): GitHub Releases API 版本比对 + 定时器,
// 失败静默; fetchFn/timer 可注入 (main.js 注入 Electron net.fetch 与真实定时器)。
const updateCheckModule = require('./src/update-check');
// 主机密钥指纹校验 (纯 node, 见 src/hostkey-store.js): TOFU known_hosts 存储
// (userData/known_hosts.json, 明文非机密, 与加密凭据库分离) + OpenSSH 兼容指纹计算。
// main.js 注入存储路径, 在 buildConnConfig 中挂接 ssh2 hostVerifier。
const hostkeyStore = require('./src/hostkey-store');
// userData 迁移 (纯 node, 见 src/userdata-migrate.js): v1.1.0 软件更名后
// app.getPath('userData') 目录变更, 启动早期把更名前的旧目录内容复制到新目录
// (防配置丢失), 幂等/只复制不删除。
const { migrateUserData } = require('./src/userdata-migrate');

// 防御性清理: 某些开发环境/宿主会注入 NODE_OPTIONS / ELECTRON_RUN_AS_NODE,
// 会导致 Electron 拒绝启动 (--use-system-ca is not allowed in NODE_OPTIONS)
// 或强制以纯 Node 模式运行 (ELECTRON_RUN_AS_NODE=1 时无 app/ipcMain)。
// 在加载任何 Electron API 前清除, 确保 exe 在任何环境双击即用。
delete process.env.NODE_OPTIONS;
delete process.env.ELECTRON_RUN_AS_NODE;

// 自定义协议特权注册 (必须在 app ready 前调用一次):
// standard 保证 nimbus-preview://<filename> 能被 URL 正确解析 (host = 文件名),
// secure/supportFetchAPI/stream 保证协议可被 <img> 与 net.fetch 正常使用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nimbus-preview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // 文档查看器: 与 nimbus-preview 同配置 (ready 前注册, 渲染进程 fetch/iframe 均可访问)
  {
    scheme: 'nimbus-doc',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// ---------- 会话管理 ----------
// 每个 SSH 连接对应一个 session, 由 windowId:sessionId 唯一标识
const sessions = new Map(); // key: `${winId}:${sessionId}`

// ---------- 托盘保活状态 ----------
// isQuitting: 标记是否进入「真正退出」流程。false 时主窗口 close 被拦截为 hide (最小化到托盘),
//             不清理任何会话; true 时 close 放行, before-quit 统一执行 cleanupAllSessions。
let isQuitting = false;
let tray = null;      // 系统托盘图标 (app ready 后创建, 真退出时销毁)
let mainWin = null;   // 主窗口引用 (托盘恢复用)

// 已通过本地对话框确认的本地路径登记表 (防止 sftp:download/upload 被任意路径滥用)
// - dialog:selectSavePath / dialog:selectFile 登记
// - sftp:download / sftp:upload 执行前校验并消费移除
const approvedLocalPaths = new Set();

// ---------- 更新检查配置 (Roadmap 第一梯队 ③, S) ----------
// 对应 GitHub 真实仓库 https://github.com/iiiweiii/FgmSSH (public; v1.1.0 软件更名,
// 仓库已由维护者同步改名)。发布新版本时在 GitHub 创建 tag (如 v1.1.0)
// 即触发更新提醒 (compareVersions 与当前版本比较)。
// 单文件绿色版定位: 仅检查提示, 不自动下载/不自动升级; 失败/离线/超时一律静默。
const UPDATE_CHECK_CONFIG = {
  owner: 'iiiweiii',
  repo: 'FgmSSH',
  initialDelayMs: 4000,     // 启动延迟 (不阻塞启动)
  intervalMs: 24 * 3600 * 1000, // 启动一次 + 每 24h 一次
  timeoutMs: 5000,          // 请求超时 (静默跳过)
};
// 全局设置 (userData/settings.json): autoCheckUpdate 总开关 (与连接配置无关)
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
// 主机密钥指纹库 (TOFU, 防中间人): userData/known_hosts.json, 与 connections.json 同级。
// 明文存储 (指纹非机密, 与 OpenSSH known_hosts 同定位), 与加密凭据库完全分离。
const KNOWN_HOSTS_FILE = path.join(app.getPath('userData'), 'known_hosts.json');
// 指纹确认弹窗超时 (ms): 用户无响应默认拒绝 (防连接挂起)
const HOSTKEY_CONFIRM_TIMEOUT_MS = 60000;
// 运行中的更新检查器 (settings:save 关闭/开启时 stop/start)
let updateChecker = null;

// 读取全局设置 (容错, 默认 autoCheckUpdate=true)
function loadGlobalSettings() {
  const defaults = { autoCheckUpdate: true };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          autoCheckUpdate: parsed.autoCheckUpdate !== false,
        };
      }
    }
  } catch (e) {}
  return defaults;
}

// 保存全局设置 (容错; 仅接受布尔开关)
function saveGlobalSettings(settings) {
  const next = {
    autoCheckUpdate: !!(settings && settings.autoCheckUpdate),
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// 广播更新检查结果到所有窗口 (非会话级事件, 不依赖 sessions)
function broadcastUpdateCheck(payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:check', payload);
    }
  }
}

// 更新检查完成统一处理: 审计 (update.check, target=版本号, 无敏感) + 渲染层提示事件
function handleUpdateCheckResult(res) {
  if (!res || !res.ok) {
    auditLog.logAudit({
      type: 'update.check',
      target: app.getVersion(),
      result: 'failure',
      detail: '更新检查失败 (离线/超时), 已静默跳过',
    });
    return;
  }
  if (res.hasUpdate) {
    auditLog.logAudit({
      type: 'update.check',
      target: String(res.latest || res.tag || ''),
      result: 'success',
      detail: `发现新版本 ${res.latest} (当前 ${res.current})`,
    });
    broadcastUpdateCheck({
      hasUpdate: true,
      latest: res.latest,
      tag: res.tag,
      url: res.url,
      current: res.current,
    });
  } else {
    auditLog.logAudit({
      type: 'update.check',
      target: String(res.latest || res.tag || app.getVersion()),
      result: 'success',
      detail: `当前已是最新版本 (${res.current})`,
    });
  }
}

// 创建/启动更新检查器 (读全局设置; autoCheck=false 时不启动)
function startUpdateChecker() {
  const settings = loadGlobalSettings();
  if (!settings.autoCheckUpdate) return;
  if (updateChecker) return; // 幂等
  updateChecker = updateCheckModule.createUpdateChecker({
    owner: UPDATE_CHECK_CONFIG.owner,
    repo: UPDATE_CHECK_CONFIG.repo,
    initialDelayMs: UPDATE_CHECK_CONFIG.initialDelayMs,
    intervalMs: UPDATE_CHECK_CONFIG.intervalMs,
    timeoutMs: UPDATE_CHECK_CONFIG.timeoutMs,
    autoCheck: true,
    getVersion: () => app.getVersion(),
    // Electron 主进程 net.fetch (不依赖 Node 全局 fetch)
    fetchFn: (url, init) => net.fetch(url, init),
    audit: (res) => handleUpdateCheckResult(res),
  });
  updateChecker.start();
}

// 根据全局设置启停更新检查器 (settings:save 后调用)
function applyUpdateCheckSetting() {
  const settings = loadGlobalSettings();
  if (settings.autoCheckUpdate) {
    startUpdateChecker();
  } else if (updateChecker) {
    updateChecker.stop();
    updateChecker = null;
  }
}

// 递归删除最大深度 (防止符号链接环导致死循环)
const MAX_DELETE_DEPTH = 50;

// 文件夹打包下载递归最大深度 (防止符号链接环导致死循环)
const MAX_DOWNLOAD_DEPTH = 100;

// ---------- 图片预览 ----------
// 预览文件存放在系统临时目录的 nimbus-preview 子目录, 由自定义协议 nimbus-preview://<filename> 提供访问。
// 预览是主进程内部行为: 直接 sftp 流式下载到临时目录, 不走 approvedLocalPaths 登记。
const PREVIEW_DIR = path.join(app.getPath('temp'), 'nimbus-preview');
const PREVIEW_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

// ---------- 内置文档查看器 ----------
// 文档临时下载目录: 与 nimbus-preview 同机制, 由自定义协议 nimbus-doc://<filename> 提供访问。
// 主进程内部 sftp 流式下载 (不走 approvedLocalPaths 登记), 支持文本类编辑 (doc:save 写回远端)。
const DOC_DIR = path.join(app.getPath('temp'), 'nimbus-docs');
// 文档扩展名白名单 (文本类 + 二进制类; 图片预览走 preview 通道, 不在此列)
const DOC_EXTENSIONS = [
  '.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts',
  '.html', '.css', '.xml', '.conf', '.ini', '.csv',
  '.pdf', '.docx', '.doc',
];
// 文本类扩展名 (可在查看器内直接编辑并保存回远端)
const TEXT_DOC_EXTENSIONS = [
  '.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts',
  '.html', '.css', '.xml', '.conf', '.ini', '.csv',
];

// 文档打开登记表: filename -> { sessionId, remotePath }
// 用途: doc:save 仅允许保存「经 doc:open 在当前会话打开过」的文档,
//       防止渲染层被攻破后通过 doc:save 覆盖远端任意文件 (P2 安全加固)。
// 生命周期: doc:open 成功下载后登记; doc:close 清理临时文件时删除 (会话关闭也会联动 doc:close)。
const docOpenRegistry = new Map();

// 校验文档临时文件名: 仅允许本进程生成的 nimbus-doc-<uuid><ext> 形态, 禁止路径分隔符与 .. (防目录穿越)
function isSafeDocFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return filename.startsWith('nimbus-doc-');
}

// 校验预览临时文件名: 仅允许本进程生成的 nimbus-<uuid><ext> 形态, 禁止路径分隔符与 .. (防目录穿越)
// 注意: 明确排除 nimbus-doc- 前缀 (文档查看器临时文件), 防止 preview 通道越权访问/清理文档文件
function isSafePreviewFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return filename.startsWith('nimbus-') && !filename.startsWith('nimbus-doc-');
}

function getSession(winId, sessionId) {
  return sessions.get(`${winId}:${sessionId}`);
}

// ---------- 操作日志辅助 ----------
// 会话审计身份: user = username@host (FgmSSH 无登录体系, 以「会话 ID + 连接用户名/主机」作为用户标识)
function auditIdentity(winId, sessionId) {
  const session = sessions.get(`${winId}:${sessionId}`);
  return { user: (session && session.user) || null, session: sessionId };
}
// 统一埋点入口: 在 IPC handler 成功/失败分支调用, 自动补 user/session
function logAuditOp(type, winId, sessionId, target, result, detail) {
  const id = auditIdentity(winId, sessionId);
  auditLog.logAudit({ type, target, result, detail, user: id.user, session: id.session });
}

function broadcastData(key, data) {
  const [winId] = key.split(':');
  const win = BrowserWindow.fromId(Number(winId));
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:data', { sessionId: key.split(':')[1], data });
  }
}

// ---------- SSH 连接 (支持断线自动重连) ----------
// 会话生命周期约定 (Roadmap 第一梯队 ① 断线自动重连, M):
//   - 会话意外断开 (网络抖动/服务器重启, 非用户主动 disconnect/quit) -> 触发自动重连:
//     指数退避 1s/2s/4s/8s/16s/32s(上限), 总重试上限可配置 (默认 5 次, 连接配置
//     autoReconnectMaxAttempts 覆盖); 重连成功即重置退避计数。
//   - 凭据复用: 重连时主进程优先从持久化存储解密 (credential-store.decryptRecord,
//     按 host/port/username 匹配), 未匹配 (临时连接) 回退使用内存中的连接配置;
//     解密失败/无凭据 -> 放弃重连 (reconnect.failed fatal) 并提示。
//   - 边界: 用户手动断开 (ssh:disconnect) / 应用退出 (cleanupAllSessions) -> 取消重连定时器;
//     重连期间用户关闭会话 -> 取消定时器; 隧道随连接重建 (autoStartConfiguredTunnels)。
//   - 审计: reconnect.attempt / reconnect.success / reconnect.failed (含第 N 次尝试, 无敏感信息)。
//   - 开关: 每连接配置 autoReconnect (默认 true, 连接配置可关), 随 connections 持久化。
// 状态机 (session 字段):
//   - closed=true            会话已完全清理并从 sessions 移除
//   - reconnecting=true      处于重连等待/进行中 (会话保留在 sessions, IPC 视为未就绪)
//   - userDisconnected       用户主动断开标记 (ssh:disconnect / cleanupAllSessions 置位)
//   - everConnected          曾成功建立过 shell (仅「已连接后断开」才自动重连)
function createSSHSession(winId, sessionId, config) {
  const key = `${winId}:${sessionId}`;
  const session = {
    id: sessionId,
    winId,                  // 窗口 ID: hostVerifier 向对应窗口发指纹确认/警告事件用
    conn: null,              // ssh2 Client (初始连接/重连时重建)
    stream: null,
    sftp: null,              // 懒加载的 SFTP 通道, 首次使用时创建并缓存 (重连后失效重建)
    closed: false,
    reconnecting: false,     // 是否处于重连等待/进行中
    userDisconnected: false, // 用户主动断开标记 (ssh:disconnect / 退出清理)
    reconnectCanceled: false,// 重连期间用户关闭会话 -> 取消标记
    reconnectTimer: null,    // (兼容字段) 由 reconnectRunner 管理定时器
    reconnectRunner: null,   // 断线自动重连控制器 (src/reconnect.js)
    resizeHandler: null,
    // 主机密钥指纹校验状态 (TOFU): 每会话独立, 多会话并发不串台
    hostKeyState: {
      pending: false,        // 是否有正在等待用户确认的指纹校验
      queue: [],             // 并发校验回调队列 (防重复弹窗; accept/reject 统一放行/拒绝)
      timer: null,           // 确认超时定时器 (60s 默认拒绝)
      mode: null,            // 'confirm' (首次) | 'mismatch' (危险警告)
      host: null, port: null, algorithm: null, fingerprint: null, md5: null,
    },
    user: `${config.username}@${config.host}`, // 审计用户标识 (username@host)
    auditDisconnectLogged: false,              // 防重复记录断开日志 (error/close/主动断开/窗口关闭)
    everConnected: false,                      // 曾成功建立过 shell (重连判定边界)
    autoReconnect: config.autoReconnect !== false, // 默认开启, 连接配置可关
    reconnectMaxAttempts: normalizeReconnectMaxAttempts(config.autoReconnectMaxAttempts),
    config,                  // 连接配置 (内存中保留用于重连; 不落日志)
  };

  sessions.set(key, session);
  connectClient(winId, sessionId, session);
  return session;
}

// 归一化重连总尝试上限: 正整数 (1..50), 非法/缺省 -> 默认 5
function normalizeReconnectMaxAttempts(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 50) return n;
  return 5;
}

// 构造 ssh2 认证配置 (初始连接与重连共用)
// 注意: 仅从 session.config 读取认证材料, 不写日志
function buildConnConfig(session) {
  const config = session.config;
  const connConfig = {
    host: config.host,
    port: Number(config.port) || 22,
    username: config.username,
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  if (config.authMethod === 'password') {
    connConfig.password = config.password;
  } else if (config.authMethod === 'privateKey') {
    if (!config.privateKeyPath || !fs.existsSync(config.privateKeyPath)) {
      throw new Error('私钥文件不存在: ' + config.privateKeyPath);
    }
    connConfig.privateKey = fs.readFileSync(config.privateKeyPath, 'utf8');
    if (config.passphrase) connConfig.passphrase = config.passphrase;
  } else {
    // agent 认证
    connConfig.agent = process.env.SSH_AUTH_SOCK;
  }

  // 主机密钥指纹校验 (TOFU, 防中间人): 默认开启, 连接配置 hostKeyVerify=false 可关闭;
  // 关闭时不传 hostVerifier (ssh2 不校验服务器指纹)。初始连接与重连共用本函数,
  // trusted 指纹直接放行 (无 UI), unknown/mismatch 走确认/警告弹窗 (60s 超时默认拒绝)。
  if (config.hostKeyVerify !== false) {
    connConfig.hostVerifier = (keyBuffer, callback) => {
      handleHostKeyVerification(session, keyBuffer, callback);
    };
  }
  return connConfig;
}

// ---------- 主机密钥指纹校验 (TOFU, 防中间人) ----------
// ssh2 hostVerifier 回调: 对服务器 host key 计算 OpenSSH 兼容 SHA256 指纹并比对 known_hosts。
//   trusted  -> 直接放行 (初始连接与重连共用, 无 UI);
//   unknown  -> 发 hostkey:confirm 事件等待用户确认 (60s 无响应默认拒绝);
//   mismatch -> 发 hostkey:mismatch 危险警告 (用户可覆盖信任新指纹或拒绝连接)。
// 并发安全: 状态挂在 session.hostKeyState, 事件带 sessionId, 多会话首次连接互不串台。

// 从 host key blob 前 4 字节解析算法名 (ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256 ...)
function detectKeyAlgorithm(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length < 4) return 'unknown';
  try {
    const len = keyBuffer.readUInt32BE(0);
    if (len > 0 && len <= keyBuffer.length - 4) {
      const name = keyBuffer.slice(4, 4 + len).toString('utf8');
      if (name && /^[A-Za-z0-9-]+$/.test(name)) return name;
    }
  } catch (e) { /* 非标准 blob: 回退 unknown */ }
  return 'unknown';
}

// 向指定窗口发送主机密钥事件 (hostkey:confirm / hostkey:mismatch)
function sendHostKeyEvent(session, channel, payload) {
  const win = BrowserWindow.fromId(Number(session.winId));
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, Object.assign({ sessionId: session.id }, payload));
  }
}

// 重置会话待确认指纹状态 (清队列 + 取消超时定时器)
function resetHostKeyState(session) {
  const st = session.hostKeyState;
  if (!st) return;
  if (st.timer) {
    try { clearTimeout(st.timer); } catch (e) {}
    st.timer = null;
  }
  st.pending = false;
  st.mode = null;
  st.host = null;
  st.port = null;
  st.algorithm = null;
  st.fingerprint = null;
  st.md5 = null;
  st.queue = [];
}

// 拒绝队列中全部挂起的校验回调 (用户拒绝 / 超时 / 会话关闭): callback(false) -> 连接失败
function rejectPendingHostKeyCallbacks(session, auditDetail) {
  const st = session.hostKeyState;
  if (!st || !st.pending) return { ok: false, error: '没有待确认的主机密钥' };
  const queue = st.queue.slice();
  const { host, port, algorithm } = st;
  resetHostKeyState(session);
  auditLog.logAudit({
    type: 'hostkey.reject',
    target: `${host}:${port}`,
    result: 'failure',
    user: session.user,
    session: session.id,
    detail: auditDetail || `用户拒绝主机密钥 (${algorithm})`,
  });
  for (const cb of queue) {
    if (typeof cb === 'function') {
      try { cb(false); } catch (e) { /* 回调异常不影响其余 */ }
    }
  }
  return { ok: true };
}

// 接受队列中全部挂起的校验回调 (首次信任 / 覆盖信任新指纹): trustHostKey 落库 + callback(true)
function acceptPendingHostKeyCallbacks(session, override) {
  const st = session.hostKeyState;
  if (!st || !st.pending) return { ok: false, error: '没有待确认的主机密钥' };
  const queue = st.queue.slice();
  const { host, port, fingerprint, algorithm } = st;
  const saved = hostkeyStore.trustHostKey(KNOWN_HOSTS_FILE, host, port, fingerprint, algorithm);
  resetHostKeyState(session);
  auditLog.logAudit({
    type: override ? 'hostkey.override' : 'hostkey.accept',
    target: `${host}:${port}`,
    result: 'success',
    user: session.user,
    session: session.id,
    detail: `${override ? '主机密钥不匹配, 用户选择信任新指纹' : '首次连接, 用户信任主机密钥'} (${algorithm})`,
  });
  for (const cb of queue) {
    if (typeof cb === 'function') {
      try { cb(true); } catch (e) { /* 回调异常不影响其余 */ }
    }
  }
  return saved;
}

// 等待用户确认的指纹校验入口 (unknown / mismatch 共用):
// 已有弹窗在等 -> 挂起本次回调到队列 (防重复弹窗); 否则发事件 + 60s 超时兜底。
function waitHostKeyConfirmation(session, mode, info) {
  const st = session.hostKeyState;
  if (st.pending) {
    st.queue.push(info.callback);
    return;
  }
  st.pending = true;
  st.mode = mode;
  st.host = info.host;
  st.port = info.port;
  st.algorithm = info.algorithm;
  st.fingerprint = info.fingerprint;
  st.md5 = info.md5;
  st.queue = [info.callback];
  sendHostKeyEvent(session, mode === 'mismatch' ? 'hostkey:mismatch' : 'hostkey:confirm', info.event);
  st.timer = setTimeout(() => {
    // 确认弹窗 60s 无响应: 默认拒绝 (防连接挂起)
    rejectPendingHostKeyCallbacks(session, '指纹确认超时, 已拒绝连接');
  }, HOSTKEY_CONFIRM_TIMEOUT_MS);
}

// ssh2 hostVerifier 主逻辑 (session 必须含 winId / id / config / hostKeyState)
function handleHostKeyVerification(session, keyBuffer, callback) {
  if (typeof callback !== 'function') return;
  const config = session && session.config;
  if (!config) {
    try { callback(false); } catch (e) {}
    return;
  }
  const host = config.host;
  const port = Number(config.port) || 22;

  let fp;
  try {
    fp = hostkeyStore.computeFingerprint(keyBuffer);
  } catch (e) {
    try { callback(false); } catch (err) {}
    return;
  }
  const algorithm = detectKeyAlgorithm(keyBuffer);
  const res = hostkeyStore.checkHostKey(KNOWN_HOSTS_FILE, host, port, fp.sha256, algorithm);

  if (res.status === 'trusted') {
    // 已信任指纹: 直接放行 (初始连接 / 自动重连共用, 无 UI)
    try { callback(true); } catch (e) {}
    return;
  }

  if (res.status === 'mismatch') {
    // 危险! 库中已有不同指纹 -> 发警告, 用户可覆盖信任新指纹或拒绝连接
    auditLog.logAudit({
      type: 'hostkey.mismatch',
      target: `${host}:${port}`,
      result: 'failure',
      user: session.user,
      session: session.id,
      detail: `主机密钥与已存指纹不匹配 (${algorithm})`,
    });
    waitHostKeyConfirmation(session, 'mismatch', {
      host, port, algorithm,
      fingerprint: fp.sha256,
      md5: fp.md5,
      callback,
      event: {
        host, port, algorithm,
        sha256: fp.sha256,
        md5: fp.md5,
        storedSha256: (res.stored && res.stored.fingerprint) || '',
        storedAlgorithm: (res.stored && res.stored.algorithm) || '',
        keyId: hostkeyStore.hostKeyId(host, port),
      },
    });
    return;
  }

  // unknown: 首次连接 -> 发确认弹窗 (展示 SHA256 + MD5 指纹)
  waitHostKeyConfirmation(session, 'confirm', {
    host, port, algorithm,
    fingerprint: fp.sha256,
    md5: fp.md5,
    callback,
    event: {
      host, port, algorithm,
      sha256: fp.sha256,
      md5: fp.md5,
      keyId: hostkeyStore.hostKeyId(host, port),
    },
  });
}

// 重连凭据复用: 优先从持久化存储解密 (credential-store.decryptRecord, 按 host/port/username 匹配),
// 未匹配 (临时连接) 回退内存中的连接配置; 解密后仍缺字段时回退内存配置对应字段。
// 返回 { ok:true, config } 或 { ok:false, error }
function resolveReconnectConfig(session) {
  const config = session.config;
  let base = config;
  try {
    // loadConnectionsRaw 返回解密后的明文记录 (主进程内部使用)
    const stored = loadConnectionsRaw().find((c) => (
      c && c.host === config.host &&
      String(c.port) === String(config.port) &&
      c.username === config.username
    ));
    if (stored) base = stored;
  } catch (e) {
    // 存储读取失败: 回退内存配置
  }

  const resolved = Object.assign({}, base);
  // 存储记录解密失败置空时回退内存配置 (尽力复用; 仍缺则放弃)
  if (resolved.authMethod === 'password' && !resolved.password && config.password) {
    resolved.password = config.password;
  }
  if (resolved.authMethod === 'privateKey') {
    if (!resolved.privateKeyPath && config.privateKeyPath) resolved.privateKeyPath = config.privateKeyPath;
    if (!resolved.passphrase && config.passphrase) resolved.passphrase = config.passphrase;
  }
  return { ok: true, config: resolved };
}

// 是否允许自动重连 (用户主动断开 / 应用退出 / 会话已关闭 / 连接配置关闭 -> false)
function canReconnect(session) {
  if (!session.autoReconnect) return false;
  if (session.userDisconnected) return false;
  if (session.reconnectCanceled) return false;
  if (session.closed) return false;
  if (isQuitting) return false;
  return true;
}

// 建立一次 ssh2 连接并挂接会话 (初始连接)
function connectClient(winId, sessionId, session) {
  const config = session.config;
  const conn = new Client();
  session.conn = conn;
  session.stream = null;
  session.sftp = null;
  session.reconnecting = false;

  conn.on('ready', () => {
    openShellAndWire(winId, sessionId, session, conn, config, (err) => {
      if (err) {
        sendEvent(winId, sessionId, 'error', { message: `无法打开 shell: ${err.message}` });
      }
    });
  });

  conn.on('error', (err) => {
    sendEvent(winId, sessionId, 'error', { message: `连接失败: ${friendlySSHError(err.message)}` });
    // 审计: 连接失败 (已翻译为友好诊断, 不含握手细节/凭据)
    session.auditDisconnectLogged = true;
    auditLog.logAudit({
      type: 'connect',
      target: `${config.host}:${config.port}`,
      result: 'failure',
      user: session.user,
      session: sessionId,
      detail: friendlySSHError(err.message),
    });
    handleUnexpectedClose(winId, sessionId, session, config, conn, err);
  });

  conn.on('close', () => {
    handleUnexpectedClose(winId, sessionId, session, config, conn);
  });

  let connConfig;
  try {
    connConfig = buildConnConfig(session);
  } catch (e) {
    sendEvent(winId, sessionId, 'error', { message: e.message });
    session.auditDisconnectLogged = true;
    auditLog.logAudit({
      type: 'connect',
      target: `${config.host}:${config.port}`,
      result: 'failure',
      user: session.user,
      session: sessionId,
      detail: e.message,
    });
    cleanupSession(winId, sessionId, session);
    return;
  }

  conn.connect(connConfig);
}

// 在指定 conn 上打开 shell 并挂接数据/事件流 (首次连接与重连共用)。
// 成功: 更新 session.conn/stream, 发 ready 事件, 审计 connect.success, 自动建立配置隧道;
// 失败: cb(err), 由调用方决定重试/放弃。
function openShellAndWire(winId, sessionId, session, conn, config, cb) {
  const key = `${winId}:${sessionId}`;
  conn.shell({
    term: process.env.TERM || 'xterm-256color',
    rows: config.rows || 30,
    cols: config.cols || 120,
    env: { LANG: 'en_US.UTF-8', TERM: process.env.TERM || 'xterm-256color' },
  }, (err, stream) => {
    if (err) {
      cb(err);
      return;
    }
    session.conn = conn;
    session.stream = stream;
    session.sftp = null; // 新连接: 旧 SFTP 通道已失效, 懒加载重建
    session.reconnecting = false;
    session.everConnected = true;
    session.auditDisconnectLogged = false;

    sendEvent(winId, sessionId, 'ready', { message: '连接成功' });
    // 审计: 连接成功 (target = host:port, 不记录密码/私钥等认证材料)
    auditLog.logAudit({
      type: 'connect',
      target: `${config.host}:${config.port}`,
      result: 'success',
      user: session.user,
      session: sessionId,
      detail: `SSH 连接成功 (${config.username}@${config.host}:${config.port})`,
    });

    // 自动建立该连接配置中的隧道 (失败不阻塞连接, 仅记 audit tunnel.error + 渲染层 toast);
    // 重连成功时同样随连接重建 (若有配置)
    autoStartConfiguredTunnels(winId, sessionId, config);

    stream.on('data', (data) => broadcastData(key, data.toString('utf8')));
    stream.on('close', (code, signal) => {
      sendEvent(winId, sessionId, 'closed', { message: '连接已关闭' });
      // 区分「会话正常结束」(exit -> code=0 / 被 kill -> signal) 与「连接被中断」
      // (流被销毁, code/signal 均无): 前者按原有行为结束会话 (cleanupSession),
      // 后者交由 conn error/close 分支判定自动重连, 避免 `exit` 触发重连。
      const sessionEnded = typeof code === 'number' || (typeof signal === 'string' && signal.length > 0);
      if (sessionEnded && !session.reconnecting && !session.closed) {
        cleanupSession(winId, sessionId, session);
      }
    });
    stream.on('error', (e) => sendEvent(winId, sessionId, 'error', { message: e.message }));

    // 收到 resize 指令
    session.resizeHandler = (e, size) => {
      if (session.stream && !session.stream.destroyed) {
        session.stream.setWindow(size.rows, size.cols);
      }
    };
    cb(null);
  });
}

// 意外断开统一入口 (error / close / stream close 均进入):
// 幂等 — 已清理 (session.closed) / 已在重连 (session.reconnecting) / 非当前连接 (conn 身份不符) 直接返回。
// 判定是否自动重连: 启用 autoReconnect 且曾成功连接 (everConnected) 且非用户主动/退出;
// 否则按原有行为: 断开审计 + closed 事件 + 清理会话。
function handleUnexpectedClose(winId, sessionId, session, config, conn, err) {
  if (session.closed) return;
  if (session.reconnecting) return;
  // 仅处理当前活跃连接: 防止旧连接 (已被重连替换) 的迟到事件误伤新连接
  if (conn && session.conn !== conn) return;

  // 停止会话侧通道 (隧道/SFTP/旧 conn/旧 stream); 保留会话记录供重连
  stopSessionChannels(winId, sessionId, session);

  if (!canReconnect(session) || !session.everConnected) {
    // 不可重连 (未启用/从未连接成功/用户断开/退出): 原有断开审计 + closed 事件 + 清理
    if (!session.auditDisconnectLogged) {
      session.auditDisconnectLogged = true;
      auditLog.logAudit({
        type: 'disconnect',
        target: `${config.host}:${config.port}`,
        result: 'success',
        user: session.user,
        session: sessionId,
        detail: '连接已关闭 (远端/网络)',
      });
    }
    sendEvent(winId, sessionId, 'closed', { message: '连接已关闭' });
    cleanupSession(winId, sessionId, session);
    return;
  }

  // 触发自动重连
  session.auditDisconnectLogged = true;
  auditLog.logAudit({
    type: 'disconnect',
    target: `${config.host}:${config.port}`,
    result: 'success',
    user: session.user,
    session: sessionId,
    detail: '连接已关闭, 触发自动重连',
  });
  session.reconnecting = true;
  sendEvent(winId, sessionId, 'reconnect-status', {
    status: 'connecting',
    attempt: 0,
    maxAttempts: session.reconnectMaxAttempts,
  });

  session.reconnectRunner = reconnectModule.createReconnectRunner({
    maxAttempts: session.reconnectMaxAttempts,
    baseDelayMs: 1000,
    maxDelayMs: 32000,
    connectFn: (p) => reconnectAttempt(winId, sessionId, session, p),
    shouldAbort: () => !canReconnect(session),
    onState: (state) => {
      sendEvent(winId, sessionId, 'reconnect-status', state);
      // 放弃/取消重连: 主进程清理会话记录 (渲染层错误提示由 reconnect-status gaveup 驱动)
      if (state.status === 'gaveup' || state.status === 'canceled') {
        cleanupSession(winId, sessionId, session);
      }
    },
    onAudit: (entry) => {
      const id = auditIdentity(winId, sessionId);
      auditLog.logAudit(Object.assign({}, entry, { user: id.user, session: sessionId }));
    },
  });
  session.reconnectRunner.start();
}

// 停止会话侧通道 (隧道/SFTP/conn/stream), 但保留会话记录 (重连路径复用)。
// 与 cleanupSession 的区别: 不删除 sessions 记录、不置 closed。
function stopSessionChannels(winId, sessionId, session) {
  const key = `${winId}:${sessionId}`;
  tunnelManager.stopAllTunnels(key, { onAudit: tunnelAuditHandler(winId, sessionId) });
  try { if (session.sftp) session.sftp.end(); } catch (e) {}
  try { if (session.conn) session.conn.end(); } catch (e) {}
  try { if (session.stream) session.stream.end(); } catch (e) {}
  session.sftp = null;
  session.stream = null;
  session.conn = null;
  session.resizeHandler = null;
}

// 完全清理会话 (从 sessions 移除 + 停止隧道 + 关闭通道 + 取消重连)。
// 幂等: session.closed 置位后直接返回。
function cleanupSession(winId, sessionId, session) {
  if (session.closed) return;
  session.closed = true;
  session.reconnecting = false;
  // 会话关闭: 若仍有等待用户确认的主机密钥校验, 按拒绝处理 (防止 ssh2 回调挂起)
  if (session.hostKeyState && session.hostKeyState.pending) {
    rejectPendingHostKeyCallbacks(session, '会话已关闭, 主机密钥校验取消');
  }
  if (session.reconnectRunner) {
    session.reconnectRunner.cancel();
    session.reconnectRunner = null;
  }
  const key = `${winId}:${sessionId}`;
  tunnelManager.stopAllTunnels(key, { onAudit: tunnelAuditHandler(winId, sessionId) });
  sessions.delete(key);
  try { if (session.sftp) session.sftp.end(); } catch (e) {}
  try { if (session.conn) session.conn.end(); } catch (e) {}
  try { if (session.stream) session.stream.end(); } catch (e) {}
}

// 单次重连尝试 (由 reconnectRunner.connectFn 调用):
// 解密凭据 -> 校验可用性 (失败/缺失 -> fatal 放弃) -> 新建 Client 连接 -> shell 挂接。
// 返回 { ok, attempt?, error?, fatal? }。
function reconnectAttempt(winId, sessionId, session, p) {
  const attempt = (p && p.attempt) || 1;

  // 用户断开/退出竞态: 尝试开始前再次校验
  if (!canReconnect(session)) {
    return Promise.resolve({ ok: false, fatal: true, error: '会话已关闭, 取消重连' });
  }

  // 凭据复用: 优先存储解密, 回退内存配置
  let resolved;
  try {
    const r = resolveReconnectConfig(session);
    if (!r.ok) {
      return Promise.resolve({ ok: false, fatal: true, error: r.error });
    }
    resolved = r.config;
  } catch (e) {
    return Promise.resolve({ ok: false, fatal: true, error: '无法获取连接凭据, 已放弃重连' });
  }

  // 凭据可用性校验 (解密失败/无凭据 -> 放弃, 不退避重试)
  if (resolved.authMethod === 'password' && !resolved.password) {
    return Promise.resolve({ ok: false, fatal: true, error: '无法解密连接凭据 (密码缺失), 已放弃重连' });
  }
  if (resolved.authMethod === 'privateKey' && (!resolved.privateKeyPath || !fs.existsSync(resolved.privateKeyPath))) {
    return Promise.resolve({ ok: false, fatal: true, error: '私钥文件不可用, 已放弃重连' });
  }

  // 用解析后的配置更新会话 (重连后的隧道/审计以该配置为准)
  session.config = resolved;

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    conn.on('ready', () => {
      openShellAndWire(winId, sessionId, session, conn, resolved, (err) => {
        if (err) {
          try { conn.end(); } catch (e) {}
          settle({ ok: false, error: `无法打开 shell: ${err.message}` });
          return;
        }
        settle({ ok: true, attempt });
      });
    });
    conn.on('error', (err) => {
      settle({ ok: false, error: friendlySSHError(err.message) });
    });
    conn.on('close', () => {
      settle({ ok: false, error: '连接被关闭' });
    });

    let connConfig;
    try {
      connConfig = buildConnConfig(session);
    } catch (e) {
      settle({ ok: false, fatal: true, error: e.message });
      return;
    }
    try {
      conn.connect(connConfig);
    } catch (e) {
      settle({ ok: false, fatal: false, error: (e && e.message) || '重连连接异常' });
    }
  });
}

function sendEvent(winId, sessionId, type, payload) {
  const win = BrowserWindow.fromId(Number(winId));
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:event', { sessionId, type, ...payload });
  }
}

// 将 ssh2 原始错误翻译为友好的中文诊断提示
function friendlySSHError(msg) {
  if (!msg) return '未知错误';
  if (msg.includes('All configured authentication methods failed')) {
    return '认证失败：请检查 端口 / 用户名 / 密码 是否正确，或切换认证方式 (密码/私钥/Agent)';
  }
  if (msg.includes('ECONNREFUSED')) {
    return '连接被拒绝：请确认主机地址与端口正确，且服务端 SSH 服务已开启';
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
    return '连接超时：请检查网络连通性与防火墙设置';
  }
  if (msg.includes('EHOSTUNREACH')) {
    return '主机不可达：请检查 IP 地址是否正确、网络是否连通';
  }
  if (msg.includes('Unable to negotiate')) {
    return 'SSH 协议协商失败：服务端可能不是标准 SSH 服务，或版本不兼容';
  }
  if (msg.includes('No such file')) {
    return '私钥文件不存在：请重新选择私钥文件';
  }
  if (msg.includes('bad permissions') || msg.includes('permissions')) {
    return '私钥权限问题：Windows 下请确保私钥文件可被当前用户读取';
  }
  return msg;
}

// ---------- 本地端口转发 (隧道) ----------
// createTunnel 保持原有签名 (winId, sessionId, tunnelCfg) 与行为 (net.createServer +
// forwardOut + 'tunnel' 事件), 实现委托给 tunnelManager (纯 node 模块, 便于 node 直跑测试),
// 新增: 隧道登记 (可按会话查询/停止)、失败审计 (tunnel.error)、成功审计 (tunnel.start)。
// 返回 Promise<{ok, tunnelId?, error?}>。
function createTunnel(winId, sessionId, tunnelCfg) {
  const key = `${winId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !session.stream) {
    return Promise.resolve({ ok: false, error: '会话未就绪，无法创建隧道' });
  }
  return tunnelManager.startTunnel({
    sessionKey: key,
    conn: session.conn,
    cfg: tunnelCfg || {},
    handlers: {
      isSessionAlive: tunnelAliveHandler(winId, sessionId),
      onEvent: tunnelEventHandler(winId, sessionId),
      onAudit: tunnelAuditHandler(winId, sessionId),
    },
  });
}

// 统一隧道审计回调: 自动补 user/session 审计身份 (target 已含 localPort/remoteHost/remotePort, 无敏感信息)
function tunnelAuditHandler(winId, sessionId) {
  return (entry) => {
    const id = auditIdentity(winId, sessionId);
    auditLog.logAudit(Object.assign({}, entry, { user: id.user, session: id.session }));
  };
}

// 统一隧道事件回调: 转发到渲染层 ssh:event 通道 (type: tunnel / tunnel-error / tunnel-stopped)
function tunnelEventHandler(winId, sessionId) {
  return (evt) => sendEvent(winId, sessionId, evt.type, evt);
}

// 统一隧道存活校验: 会话仍存在且未关闭 (防止重建/关闭后隧道端口泄漏)
function tunnelAliveHandler(winId, sessionId) {
  const key = `${winId}:${sessionId}`;
  return () => {
    const session = sessions.get(key);
    return !!session && !session.closed;
  };
}

// 连接建立后自动建立该连接配置中的隧道 (config.tunnels):
// 失败不阻塞连接 —— 每条失败仅记 audit tunnel.error (tunnelManager 内完成) + 渲染层 toast,
// 不打断连接流程; 已停止的隧道配置 (状态) 不会在下次连接时自动建立 (stopTunnel 已移除登记,
// 但 conn.tunnels 仍保留配置, 由面板「删除」负责从持久化配置移除)。
function autoStartConfiguredTunnels(winId, sessionId, config) {
  const key = `${winId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !Array.isArray(config.tunnels) || config.tunnels.length === 0) return;
  tunnelManager.autoStartTunnels({
    sessionKey: key,
    conn: session.conn,
    tunnels: config.tunnels,
    handlers: {
      isSessionAlive: tunnelAliveHandler(winId, sessionId),
      onEvent: tunnelEventHandler(winId, sessionId),
      onAudit: tunnelAuditHandler(winId, sessionId),
    },
  }).then((results) => {
    // 失败项额外向渲染层发事件供 toast (审计已由 tunnelManager 完成)
    for (const r of results) {
      if (!r.ok) {
        sendEvent(winId, sessionId, 'tunnel-error', {
          message: `自动建立隧道失败 (localhost:${r.cfg.localPort} -> ${r.cfg.remoteHost}:${r.cfg.remotePort}): ${r.error}`,
        });
      }
    }
  }).catch(() => {});
}

// ---------- SFTP 文件传输 ----------

// 懒加载 SFTP 通道并缓存到 session.sftp
// 返回 Promise<SFTPWrapper>; 会话不存在/未就绪时 reject
function getSftp(winId, sessionId) {
  const key = `${winId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !session.conn) {
    return Promise.reject(new Error('会话不存在或未就绪'));
  }
  if (session.sftp) {
    return Promise.resolve(session.sftp);
  }
  return new Promise((resolve, reject) => {
    session.conn.sftp((err, sftp) => {
      // 回调触发时再次确认会话仍存在 (连接可能已关闭/重建)
      const current = sessions.get(key);
      if (!current || current !== session) {
        if (sftp) { try { sftp.end(); } catch (e) {} }
        reject(new Error('会话不存在或未就绪'));
        return;
      }
      if (err) {
        reject(new Error(`SFTP 初始化失败: ${err.message}`));
        return;
      }
      session.sftp = sftp;
      resolve(sftp);
    });
  });
}

// 拼接远端路径 (始终使用 / 分隔符)
function joinRemotePath(parent, name) {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

// 校验远端路径安全: 必须为非空字符串, 且不含 .. 段 (防路径穿越)
function isSafeRemotePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  return !p.split('/').some((seg) => seg === '..');
}

// 解析远端 home 目录 (R3 用): 优先 sftp.realpath('~') (部分服务器支持 ~ 展开);
// 但 OpenSSH 的 sftp-server 不做 ~ 展开, 实测返回字面路径如 /root/~ (含 ~ 段),
// 此时回退用 sftp.realpath('.') — SFTP 子系统 cwd (登录后通常即 home 目录)。
// 两者都失败返回 null (调用方按 {ok:false} 静默处理)。
async function resolveSftpHome(sftp) {
  const realpath = promisify(sftp.realpath).bind(sftp);
  try {
    const r = await realpath('~');
    // 若返回路径仍含字面 ~ 段, 视为服务器未展开 ~, 不可用
    if (r && !r.split('/').includes('~')) return r;
  } catch (e) {}
  try {
    return await realpath('.');
  } catch (e) {
    return null;
  }
}

// 终端 cd 同步 (R3): 解析 cd 目标为「安全绝对路径」供 SFTP 面板展示。
// - ~ / ~/xxx: 先解析 home 绝对路径再拼接 (~ 在路径中间如 /a/~b 按普通路径处理)
// - 绝对/相对路径: sftp.realpath 基于服务器端 cwd 解析 (天然支持 .. / 存在性校验)
// - 结果校验: isSafeRemotePath (拒 .. 段残留) + 以 / 开头
// - 存在性校验: 部分服务器 realpath 对「末级组件不存在」较宽松 (实测返回路径本身),
//   需额外 stat 确认目标真实存在, 否则 {ok:false} (cd 到不存在目录 -> 面板不动, 静默)
// - 失败 (目录不存在/权限/解析失败) -> {ok:false}, renderer 静默忽略, 不影响终端本身报错
async function sftpCdSync(winId, sessionId, rawPath) {
  const sftp = await getSftp(winId, sessionId);
  const raw = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!raw) return { ok: false, error: '空路径' };
  const realpath = promisify(sftp.realpath).bind(sftp);

  // 解析目标绝对路径: ~ / ~/xxx / 绝对路径 / 相对路径 (统一走 realpath 归一化)
  let target;
  if (raw === '~' || raw.startsWith('~/')) {
    const home = await resolveSftpHome(sftp);
    if (!home) return { ok: false, error: '无法解析 home 目录' };
    target = home + (raw === '~' ? '' : raw.slice(1)); // '~/xxx' -> home + '/xxx'
  } else {
    target = raw; // 相对路径基于服务器端 cwd 解析 (天然支持 ..)
  }

  let resolved;
  try {
    resolved = await realpath(target);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!isSafeRemotePath(resolved) || !resolved.startsWith('/')) {
    return { ok: false, error: '路径包含非法段 (..)' };
  }

  // 存在性校验 (见函数头注释): 仅 stat 通过还不够, 需确认目标是「目录」,
  // 否则 cd 到文件 (如 /etc/passwd) 会返回 {ok:true}, renderer loadDir 必然失败并弹错误 toast。
  try {
    const st = await promisify(sftp.stat).bind(sftp)(resolved);
    // ssh2 的 stat 返回 Stats 兼容对象 (有 isDirectory()); 个别环境缺失时回退按 mode 位判断
    const isDir = typeof st.isDirectory === 'function'
      ? st.isDirectory()
      : (st.mode & 0o170000) === 0o040000;
    if (!isDir) return { ok: false, error: '非目录' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: resolved };
}

// 归一化 mtime: 兼容 Date / 毫秒 / 秒 三种形态, 统一返回毫秒时间戳
function normalizeMtime(mtime) {
  if (mtime instanceof Date) return mtime.getTime();
  if (typeof mtime === 'number') return mtime > 1e12 ? mtime : mtime * 1000;
  return 0;
}

// 列出目录内容: 目录优先, 再按名称排序 (不区分大小写)
async function sftpList(winId, sessionId, remotePath) {
  const sftp = await getSftp(winId, sessionId);
  const target = remotePath || '/';
  const readdir = promisify(sftp.readdir).bind(sftp);

  let entries;
  try {
    entries = await readdir(target);
  } catch (e) {
    return { ok: false, error: `读取目录失败: ${e.message}` };
  }

  const items = [];
  for (const ent of entries || []) {
    const name = ent.filename;
    // 过滤 . 和 ..
    if (name === '.' || name === '..') continue;
    const attrs = ent.attrs || {};
    const isDir = !!(attrs.isDirectory && attrs.isDirectory());
    const isSymlink = !!(attrs.isSymbolicLink && attrs.isSymbolicLink());
    items.push({
      name,
      isDir,
      isSymlink,
      size: typeof attrs.size === 'number' ? attrs.size : 0,
      mtime: normalizeMtime(attrs.mtime),
    });
  }

  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { ok: true, path: target, entries: items };
}

// 下载远端文件 -> 本地 (流式核心, 供 sftpDownload 与图片预览内部下载复用)
// 注意: 本函数不校验 approvedLocalPaths, 调用方需自行确认路径安全策略
function downloadToFile(sftp, remotePath, localPath) {
  return new Promise((resolve) => {
    const rs = sftp.createReadStream(remotePath);
    const ws = fs.createWriteStream(localPath);
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true } : { ok: false, error });
    };
    rs.on('error', (err) => {
      // 断流清理: 关闭对端写入流并删除本地半成品文件
      ws.destroy();
      fs.unlink(localPath, () => {});
      settle(false, `下载失败: ${err.message}`);
    });
    ws.on('error', (err) => {
      rs.destroy();
      fs.unlink(localPath, () => {});
      settle(false, `写入本地文件失败: ${err.message}`);
    });
    ws.on('close', () => settle(true));
    rs.pipe(ws);
  });
}

// 下载远端文件前 maxBytes 字节 -> 本地 (大文件分段预览用; 与 downloadToFile 同构,
// 通过 createReadStream 的 end 选项限制字节数, 流式不占内存)
function downloadToFilePartial(sftp, remotePath, localPath, maxBytes) {
  return new Promise((resolve) => {
    const limit = Math.max(1, Number(maxBytes) || 1);
    const rs = sftp.createReadStream(remotePath, { start: 0, end: limit - 1 });
    const ws = fs.createWriteStream(localPath);
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true } : { ok: false, error });
    };
    rs.on('error', (err) => {
      ws.destroy();
      fs.unlink(localPath, () => {});
      settle(false, `下载失败: ${err.message}`);
    });
    ws.on('error', (err) => {
      rs.destroy();
      fs.unlink(localPath, () => {});
      settle(false, `写入本地文件失败: ${err.message}`);
    });
    ws.on('close', () => settle(true));
    rs.pipe(ws);
  });
}

// 追加远端文件从 offset 起的剩余字节到本地 (doc:loadFull 用; 流式追加, 不占内存)
function appendRemoteTail(sftp, remotePath, localPath, offset) {
  return new Promise((resolve) => {
    const start = Math.max(0, Number(offset) || 0);
    const rs = sftp.createReadStream(remotePath, { start });
    const ws = fs.createWriteStream(localPath, { flags: 'a' });
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true } : { ok: false, error });
    };
    rs.on('error', (err) => {
      ws.destroy();
      settle(false, `读取远端失败: ${err.message}`);
    });
    ws.on('error', (err) => {
      rs.destroy();
      settle(false, `写入本地文件失败: ${err.message}`);
    });
    ws.on('close', () => settle(true));
    rs.pipe(ws);
  });
}

// 下载远端文件 -> 本地 (流式, 用户触发, 必须经 dialog:selectSavePath 登记)
// 断点续传 (Roadmap 第一梯队 ②): 本地以 `<目标>.part` 记录已下载字节;
// 中断保留 .part, 再次下载同一路径 -> 检测 .part 存在 -> 从 offset 续传,
// 完成后 rename .part -> 目标文件。进度经 sftp-download-progress 事件上报
// (phase:'downloading'), 审计 sftp.resume (仅续传发生时)。
async function sftpDownload(winId, sessionId, remotePath, localPath) {
  if (!remotePath || !localPath) return { ok: false, error: '参数不完整: 缺少远端或本地路径' };
  // 安全校验: localPath 必须经 dialog:selectSavePath 确认并登记 (消费移除, 防止重放)
  if (!approvedLocalPaths.has(localPath)) {
    return { ok: false, error: '路径未经过确认' };
  }
  approvedLocalPaths.delete(localPath);

  const sftp = await getSftp(winId, sessionId);

  // 确保本地父目录存在
  try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); } catch (e) {}

  // 远端大小 (续传判定 + 进度分母); stat 失败按 0 处理 (走全新下载, createReadStream 会再报错)
  let remoteSize = 0;
  try {
    const st = await promisify(sftp.stat).bind(sftp)(remotePath);
    remoteSize = (st && typeof st.size === 'number') ? st.size : 0;
  } catch (e) {
    remoteSize = 0;
  }

  const res = await transferResume.downloadFileResumable({
    sftp,
    fs,
    remotePath,
    localPath,
    remoteSize,
    onProgress: (info) => sendEvent(winId, sessionId, 'sftp-download-progress', info),
  });

  if (res.resumed) {
    logAuditOp(
      'sftp.resume',
      winId,
      sessionId,
      remotePath,
      res.ok ? 'success' : 'failure',
      res.ok ? `从偏移 ${res.offset} 续传下载` : (res.error || '下载续传失败')
    );
  }
  return res;
}

// 上传本地文件 -> 远端 (流式, 用户触发, 必须经 dialog:selectFile/拖拽登记)
// 断点续传: 以远端 stat 为基准 (远端大小即已传 offset), 本地从 offset 继续读,
// 远端 flags:'a' 追加写 (ssh2 WriteStream 自动定位 EOF); 中断保留远端半成品,
// 下次 stat 继续。进度经 sftp-upload-progress 事件上报 (phase:'uploading'),
// 审计 sftp.resume (仅续传发生时)。
async function sftpUpload(winId, sessionId, localPath, remotePath) {
  if (!localPath || !remotePath) return { ok: false, error: '参数不完整: 缺少本地或远端路径' };
  // 安全校验: localPath 必须经 dialog:selectFile 确认并登记 (消费移除)
  if (!approvedLocalPaths.has(localPath)) {
    return { ok: false, error: '路径未经过确认' };
  }
  approvedLocalPaths.delete(localPath);
  if (!fs.existsSync(localPath)) return { ok: false, error: '本地文件不存在' };

  const sftp = await getSftp(winId, sessionId);

  const res = await transferResume.uploadFileResumable({
    sftp,
    fs,
    localPath,
    remotePath,
    onProgress: (info) => sendEvent(winId, sessionId, 'sftp-upload-progress', info),
  });

  if (res.resumed) {
    logAuditOp(
      'sftp.resume',
      winId,
      sessionId,
      remotePath,
      res.ok ? 'success' : 'failure',
      res.ok ? `从偏移 ${res.offset} 续传上传` : (res.error || '上传续传失败')
    );
  }
  return res;
}

// 递归删除: 目录先清空内部内容, 最后 rmdir
// 注意: 判型一律用 lstat (不跟随符号链接), 符号链接按文件 unlink 处理, 防止误删链接目标
async function sftpRemove(sftp, remotePath, isDir, depth) {
  if (depth > MAX_DELETE_DEPTH) {
    throw new Error('目录嵌套过深, 已中止删除 (可能存在符号链接环)');
  }
  const unlink = promisify(sftp.unlink).bind(sftp);
  const rmdir = promisify(sftp.rmdir).bind(sftp);
  const readdir = promisify(sftp.readdir).bind(sftp);
  const lstat = promisify(sftp.lstat).bind(sftp);

  if (!isDir) {
    // 普通文件与符号链接统一 unlink
    await unlink(remotePath);
    return;
  }

  let entries = [];
  try {
    entries = await readdir(remotePath);
  } catch (e) {
    // 读取失败时按空目录处理, 具体错误交由 rmdir 抛出
  }
  for (const ent of entries) {
    if (ent.filename === '.' || ent.filename === '..') continue;
    const childPath = joinRemotePath(remotePath, ent.filename);
    // 子项判型用 lstat, 符号链接一律按文件删除
    let childIsDir = false;
    try {
      const st = await lstat(childPath);
      childIsDir = !!(st.isDirectory && st.isDirectory());
    } catch (e) {
      childIsDir = false;
    }
    await sftpRemove(sftp, childPath, childIsDir, depth + 1);
  }
  await rmdir(remotePath);
}

async function sftpDelete(winId, sessionId, remotePath) {
  const sftp = await getSftp(winId, sessionId);
  if (!remotePath || remotePath === '/') return { ok: false, error: '不能删除根目录' };
  if (!isSafeRemotePath(remotePath)) return { ok: false, error: '路径包含非法段 (..)' };
  try {
    // 判型用 lstat: 符号链接不会被识别为目录, 从而按文件删除
    const lstat = promisify(sftp.lstat).bind(sftp);
    const st = await lstat(remotePath);
    const isDir = !!(st.isDirectory && st.isDirectory());
    await sftpRemove(sftp, remotePath, isDir, 0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `删除失败: ${e.message}` };
  }
}

async function sftpMkdir(winId, sessionId, remotePath) {
  const sftp = await getSftp(winId, sessionId);
  if (!remotePath) return { ok: false, error: '缺少目录路径' };
  if (!isSafeRemotePath(remotePath)) return { ok: false, error: '路径包含非法段 (..)' };
  try {
    await promisify(sftp.mkdir).bind(sftp)(remotePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `创建目录失败: ${e.message}` };
  }
}

async function sftpRename(winId, sessionId, oldPath, newPath) {
  const sftp = await getSftp(winId, sessionId);
  if (!oldPath || !newPath) return { ok: false, error: '参数不完整: 缺少旧/新路径' };
  if (!isSafeRemotePath(oldPath) || !isSafeRemotePath(newPath)) {
    return { ok: false, error: '路径包含非法段 (..)' };
  }
  try {
    await promisify(sftp.rename).bind(sftp)(oldPath, newPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `重命名失败: ${e.message}` };
  }
}

// ---------- SFTP 文件夹打包下载 (ZIP, 自写零依赖) ----------
// 方案决策 (2026-08-11): 采用方案 A 自写 ZIP 写入器。
// 理由:
// 1) 零依赖 — 不引入 npm 包, 避免 npm install 环境问题与 asar 打包风险 (本项目 npmRebuild:false,
//    打包约束严格, 新依赖需额外验证);
// 2) 完全可控 — 流式写入、进度上报、错误映射均为主进程内逻辑, 无第三方黑盒;
// 3) 关键原语已验证 — Node 22 内置 zlib.crc32 (支持增量, 第二参数为前值) + zlib.createDeflateRaw
//    均可用, 自写 ZIP 所需能力齐备。
// 流式方案: 每个文件条目使用「Local File Header(占位) + deflateRaw 数据 + Data Descriptor(bit3 flag)」,
// 解决"流式写入时 header 需预写 CRC/size"问题; CRC32 在数据流经时滚动计算。
const ZIP_LOCAL_SIG = 0x04034b50;    // PK\x03\x04
const ZIP_CENTRAL_SIG = 0x02014b50;  // PK\x01\x02
const ZIP_EOCD_SIG = 0x06054b50;     // PK\x05\x06
const ZIP_DD_SIG = 0x08074b50;       // PK\x07\x08 (Data Descriptor)
const ZIP_FLAG_DATADESC = 0x0008;    // bit 3: 数据描述符 (流式条目用)
const ZIP_FLAG_UTF8 = 0x0800;        // bit 11: 文件名 UTF-8
const ZIP_METHOD_STORE = 0;          // 存储 (目录/空条目)
const ZIP_METHOD_DEFLATE = 8;        // deflate (文件)

function zipWriteU16(buf, offset, value) { buf.writeUInt16LE(value & 0xffff, offset); }
function zipWriteU32(buf, offset, value) { buf.writeUInt32LE(value >>> 0, offset); }

// 毫秒时间戳 -> ZIP DOS 日期/时间 (两个 16 位字段, ZIP 规范)
function dosDateTime(ms) {
  const d = (ms && !isNaN(new Date(ms).getTime())) ? new Date(ms) : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// 构建 Local File Header + 文件名 (30 字节头; 流式文件条目用 bit3, CRC/size 占位 0)
function zipBuildLocalHeader(zipPath, isDir, mtimeMs) {
  const nameBuf = Buffer.from(zipPath, 'utf8');
  const header = Buffer.alloc(30);
  zipWriteU32(header, 0, ZIP_LOCAL_SIG);
  zipWriteU16(header, 4, 20);   // version needed to extract (2.0)
  zipWriteU16(header, 6, isDir ? ZIP_FLAG_UTF8 : (ZIP_FLAG_UTF8 | ZIP_FLAG_DATADESC));
  zipWriteU16(header, 8, isDir ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE);
  const dt = dosDateTime(mtimeMs);
  zipWriteU16(header, 10, dt.time);
  zipWriteU16(header, 12, dt.date);
  zipWriteU32(header, 14, 0);   // crc 占位 (流式条目由 Data Descriptor 提供)
  zipWriteU32(header, 18, 0);   // compressed size 占位
  zipWriteU32(header, 22, 0);   // uncompressed size 占位
  zipWriteU16(header, 26, nameBuf.length);
  zipWriteU16(header, 28, 0);   // extra field 长度
  return Buffer.concat([header, nameBuf]);
}

// 构建 Central Directory 条目 (46 字节头 + 文件名; 权威的 CRC/size/偏移)
function zipBuildCentralEntry(zipPath, isDir, mtimeMs, crc, compressedSize, uncompressedSize, localOffset) {
  const nameBuf = Buffer.from(zipPath, 'utf8');
  const buf = Buffer.alloc(46);
  zipWriteU32(buf, 0, ZIP_CENTRAL_SIG);
  zipWriteU16(buf, 4, 20);   // version made by (MS-DOS, 2.0)
  zipWriteU16(buf, 6, 20);   // version needed to extract
  zipWriteU16(buf, 8, isDir ? ZIP_FLAG_UTF8 : (ZIP_FLAG_UTF8 | ZIP_FLAG_DATADESC));
  zipWriteU16(buf, 10, isDir ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE);
  const dt = dosDateTime(mtimeMs);
  zipWriteU16(buf, 12, dt.time);
  zipWriteU16(buf, 14, dt.date);
  zipWriteU32(buf, 16, crc >>> 0);
  zipWriteU32(buf, 20, compressedSize >>> 0);
  zipWriteU32(buf, 24, uncompressedSize >>> 0);
  zipWriteU16(buf, 28, nameBuf.length);
  zipWriteU16(buf, 30, 0);   // extra field 长度
  zipWriteU16(buf, 32, 0);   // comment 长度
  zipWriteU16(buf, 34, 0);   // disk number start
  zipWriteU16(buf, 36, 0);   // internal file attributes
  zipWriteU32(buf, 38, isDir ? 0x10 : 0);   // external attrs: DOS 目录属性位
  zipWriteU32(buf, 42, localOffset >>> 0);
  return Buffer.concat([buf, nameBuf]);
}

// 构建 End Of Central Directory (22 字节)
function zipBuildEocd(centralSize, centralOffset, entryCount) {
  const buf = Buffer.alloc(22);
  zipWriteU32(buf, 0, ZIP_EOCD_SIG);
  zipWriteU16(buf, 4, 0);    // disk number
  zipWriteU16(buf, 6, 0);    // central dir 起始盘
  zipWriteU16(buf, 8, Math.min(0xffff, entryCount));
  zipWriteU16(buf, 10, Math.min(0xffff, entryCount));
  zipWriteU32(buf, 12, centralSize >>> 0);
  zipWriteU32(buf, 16, centralOffset >>> 0);
  zipWriteU16(buf, 20, 0);   // comment 长度
  return buf;
}

// 递归列出目录全部条目 (目录优先 + 按名称排序; lstat 判型, 符号链接不跟随, 按文件打包)
// 返回 [{zipPath, remotePath, isDir, mtime}] — zipPath 为 zip 根内相对路径, 以 / 分隔
// opts.rootZip: zip 根目录名 (如下载 /root/data -> 'data', 条目为 data/xxx; 缺省则无前缀)
// onProgress({phase:'listing', scanned}) 在扫描过程中周期回调
async function sftpListRecursive(sftp, remotePath, opts) {
  const onProgress = (opts && opts.onProgress) || function () {};
  const depthLimit = (opts && opts.depthLimit) || MAX_DOWNLOAD_DEPTH;
  const rootZip = (opts && opts.rootZip) || '';
  const result = [];
  let scanned = 0;

  async function walk(dirRemote, dirZip, depth) {
    if (depth > depthLimit) {
      throw new Error(`目录嵌套过深 (超过 ${depthLimit} 层), 已中止打包 (可能存在符号链接环)`);
    }
    const readdir = promisify(sftp.readdir).bind(sftp);
    const lstat = promisify(sftp.lstat).bind(sftp);
    let raw = [];
    try {
      raw = await readdir(dirRemote);
    } catch (e) {
      throw new Error(`读取目录失败 ${dirRemote}: ${e.message}`);
    }
    const items = [];
    for (const ent of raw || []) {
      const name = ent.filename;
      if (name === '.' || name === '..') continue;
      const childRemote = joinRemotePath(dirRemote, name);
      let isDir = false;
      let mtime = 0;
      try {
        const st = await lstat(childRemote);
        isDir = !!(st.isDirectory && st.isDirectory());
        mtime = normalizeMtime(st.mtime);
      } catch (e) {
        // lstat 失败 (条目消失/权限): 按文件处理, 具体错误由 createReadStream 抛出
        isDir = false;
      }
      items.push({ name, remotePath: childRemote, isDir, mtime });
    }
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const it of items) {
      const zipPath = dirZip ? `${dirZip}/${it.name}` : it.name;
      result.push({ zipPath, remotePath: it.remotePath, isDir: it.isDir, mtime: it.mtime });
      scanned++;
      if (scanned % 50 === 0) onProgress({ phase: 'listing', scanned });
      if (it.isDir) {
        await walk(it.remotePath, zipPath, depth + 1);
      }
    }
  }

  await walk(remotePath, rootZip, 0);
  onProgress({ phase: 'listing', scanned });
  return result;
}

// 流式写入单个文件条目: Local Header(占位) + createReadStream -> deflateRaw -> ws + Data Descriptor
// 返回 {crc, compressedSize, uncompressedSize}; 数据流经时滚动计算 CRC, 大文件不占内存
function zipWriteFileEntry(sftp, ws, remotePath, zipPath, mtimeMs) {
  return new Promise((resolve, reject) => {
    ws.write(zipBuildLocalHeader(zipPath, false, mtimeMs));

    const rs = sftp.createReadStream(remotePath);
    const deflater = zlib.createDeflateRaw({ level: 6 });
    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    let settled = false;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        // 断流清理: 销毁两端流, 交由外层 fail 删除半成品 zip
        try { rs.destroy(); } catch (e) {}
        try { deflater.destroy(); } catch (e) {}
        reject(err);
      } else {
        resolve({ crc: crc >>> 0, compressedSize: compressedSize >>> 0, uncompressedSize: uncompressedSize >>> 0 });
      }
    };

    rs.on('error', settle);
    deflater.on('error', settle);
    ws.on('error', settle);
    // 滚动 CRC + 字节统计 (与 pipe 并行监听, 均为只读统计)
    rs.on('data', (chunk) => {
      uncompressedSize += chunk.length;
      crc = zlib.crc32(chunk, crc);
    });
    deflater.on('data', (chunk) => { compressedSize += chunk.length; });
    deflater.on('end', () => {
      // 数据流结束后回写 Data Descriptor (bit3 flag 已声明)
      const dd = Buffer.alloc(16);
      zipWriteU32(dd, 0, ZIP_DD_SIG);
      zipWriteU32(dd, 4, crc >>> 0);
      zipWriteU32(dd, 8, compressedSize >>> 0);
      zipWriteU32(dd, 12, uncompressedSize >>> 0);
      ws.write(dd);
      settle(null);
    });
    // end:false — 共享的 zip 写入流不可在单条目结束后关闭
    rs.pipe(deflater).pipe(ws, { end: false });
  });
}

// 将打包/下载过程中的异常映射为清晰的中文错误信息
function friendlyZipDownloadError(err, remotePath) {
  const msg = (err && err.message) || String(err);
  const lower = String(msg).toLowerCase();
  const name = String(remotePath).split('/').filter(Boolean).pop() || remotePath;
  if (lower.includes('eacces') || lower.includes('permission denied')) {
    return `没有权限读取 ${name}`;
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return `文件不存在或已被删除: ${name}`;
  }
  if (lower.includes('enospc') || lower.includes('no space left')) {
    return '本地磁盘空间不足，无法完成打包';
  }
  if (lower.includes('eisdir')) {
    return `无法读取目录内容: ${name}`;
  }
  return `打包下载失败: ${msg}`;
}

// 下载远端文件夹 -> 本地 ZIP (保持目录层级; 空文件夹也生成含根目录条目的 zip)
// 流程: 递归列出 -> 逐个写条目 (目录=空条目, 文件=流式 deflate) -> Central Directory -> EOCD
// onProgress: {phase:'listing', scanned} | {phase:'packing', done, total, currentName}
async function sftpDownloadFolder(sftp, remotePath, localZipPath, onProgress) {
  if (!remotePath || !localZipPath) {
    throw new Error('参数不完整: 缺少远端或本地路径');
  }
  const rootName = String(remotePath).split('/').filter(Boolean).pop() || 'folder';

  // 1) 递归列出全部条目; 根目录条目始终存在 (空文件夹也能打包出含根目录的 zip)
  //    以文件夹名为 zip 根: 下载 /root/data -> zip 内含 data/ 与 data/xxx
  let children;
  try {
    children = await sftpListRecursive(sftp, remotePath, { onProgress, rootZip: rootName });
  } catch (e) {
    // 扫描阶段错误 (权限/路径不存在等): 直接映射为清晰中文错误
    throw new Error(friendlyZipDownloadError(e, remotePath));
  }
  const entries = [{ zipPath: rootName, remotePath, isDir: true, mtime: Date.now() }].concat(children);
  const fileCount = entries.reduce((n, x) => n + (x.isDir ? 0 : 1), 0);

  // 2) 确保本地父目录存在
  try { fs.mkdirSync(path.dirname(localZipPath), { recursive: true }); } catch (e) {}

  const ws = fs.createWriteStream(localZipPath);
  const centralChunks = [];
  let offset = 0;       // 当前 Local Header 在 zip 中的偏移 (central directory 记录用)
  let doneFiles = 0;    // 已打包文件数 (进度 total 按文件数计)

  return new Promise((resolve, reject) => {
    let settled = false;
    let currentRemote = remotePath;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch (e) {}
      fs.unlink(localZipPath, () => {});
      reject(new Error(friendlyZipDownloadError(err, currentRemote)));
    };

    ws.on('error', fail);
    ws.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true });
    });

    (async () => {
      try {
        for (const entry of entries) {
          currentRemote = entry.remotePath;
          const localOffset = offset;
          if (entry.isDir) {
            // 目录条目: 文件名以 / 结尾, stored, 大小 0, 外部属性带目录位
            const dirPath = entry.zipPath.endsWith('/') ? entry.zipPath : entry.zipPath + '/';
            const localHeader = zipBuildLocalHeader(dirPath, true, entry.mtime);
            ws.write(localHeader);
            offset += localHeader.length;
            centralChunks.push(zipBuildCentralEntry(dirPath, true, entry.mtime, 0, 0, 0, localOffset));
          } else {
            // 文件条目: 流式下载 + deflate (符号链接按文件处理, 读取链接目标内容)
            const result = await zipWriteFileEntry(sftp, ws, entry.remotePath, entry.zipPath, entry.mtime);
            offset += 30 + Buffer.byteLength(entry.zipPath, 'utf8') + 16 + result.compressedSize;
            centralChunks.push(zipBuildCentralEntry(
              entry.zipPath, false, entry.mtime,
              result.crc, result.compressedSize, result.uncompressedSize, localOffset
            ));
            doneFiles++;
            if (onProgress) {
              onProgress({ phase: 'packing', done: doneFiles, total: fileCount, currentName: entry.zipPath });
            }
          }
        }
        // 3) Central Directory + End Of Central Directory
        const centralBuf = Buffer.concat(centralChunks);
        const centralOffset = offset;
        ws.write(centralBuf);
        ws.write(zipBuildEocd(centralBuf.length, centralOffset, centralChunks.length));
        ws.end();
      } catch (e) {
        fail(e);
      }
    })();
  });
}

// ---------- 图片预览 (主进程内部下载到临时目录) ----------

// 注册 nimbus-preview 自定义协议: 将 nimbus-preview://<filename> 映射到预览临时目录文件。
// 注册前用 isProtocolHandled 判断, 避免重复注册抛错。
function registerPreviewProtocol() {
  if (protocol.isProtocolHandled('nimbus-preview')) return;
  protocol.handle('nimbus-preview', (request) => {
    try {
      // 解析文件名: 兼容 nimbus-preview://<filename> 与 nimbus-preview:///<filename> 两种写法
      const { host, pathname } = new URL(request.url);
      const raw = host || pathname;
      const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
      if (!isSafePreviewFilename(filename)) {
        return new Response('Not Found', { status: 404 });
      }
      const filePath = path.join(PREVIEW_DIR, filename);
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      // 用 net.fetch 包装 file:// URL, 由 Chromium 接管流式响应
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  });
}

// 注册 nimbus-doc 自定义协议: 将 nimbus-doc://<filename> 映射到文档临时目录文件。
// 与 registerPreviewProtocol 完全同构; 文件名校验走 isSafeDocFilename (nimbus-doc- 前缀)。
function registerDocProtocol() {
  if (protocol.isProtocolHandled('nimbus-doc')) return;
  protocol.handle('nimbus-doc', (request) => {
    try {
      const { host, pathname } = new URL(request.url);
      const raw = host || pathname;
      const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
      if (!isSafeDocFilename(filename)) {
        return new Response('Not Found', { status: 404 });
      }
      const filePath = path.join(DOC_DIR, filename);
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  });
}

// ---------- IPC 处理器 ----------
// P0-3: 渲染层不持明文凭据。连接时按 connId 从磁盘解密补全空密码/口令 (仅主进程接触明文)
function resolveAuthCredential(config) {
  if (!config || typeof config !== 'object') return config;
  const connId = config.connId;
  const needPassword = config.authMethod === 'password' && !config.password;
  const needPassphrase = config.authMethod === 'privateKey' && !config.passphrase;
  if (!connId || (!needPassword && !needPassphrase)) return config;
  const raw = loadConnectionsRaw();
  const rec = raw.find((c) => c && c.id === connId);
  if (!rec) return config;
  const out = { ...config };
  if (needPassword && typeof rec.password === 'string') out.password = rec.password;
  if (needPassphrase && typeof rec.passphrase === 'string') out.passphrase = rec.passphrase;
  return out;
}

ipcMain.handle('ssh:connect', (e, { sessionId, config }) => {
  if (!config || typeof config !== 'object') return { ok: false, error: '参数不完整' };
  if (config.authMethod === 'password' && !config.password && !config.connId) {
    return { ok: false, error: '未提供密码' };
  }
  createSSHSession(e.sender.id, sessionId, resolveAuthCredential(config));
  return { ok: true };
});

ipcMain.handle('ssh:write', (e, { sessionId, data }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (session && session.stream && !session.stream.destroyed) {
    session.stream.write(data);
    return { ok: true };
  }
  return { ok: false, error: '会话不存在' };
});

ipcMain.handle('ssh:resize', (e, { sessionId, rows, cols }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (session && session.stream && !session.stream.destroyed) {
    session.stream.setWindow(rows, cols);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('ssh:disconnect', (e, { sessionId }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (session) {
    // 审计: 用户主动断开 (标记后 conn close 事件不再重复记录; 也不触发自动重连)
    session.auditDisconnectLogged = true;
    session.userDisconnected = true;
    session.reconnectCanceled = true; // 重连期间用户关闭会话 -> 取消重连定时器
    if (session.reconnectRunner) {
      session.reconnectRunner.cancel();
      session.reconnectRunner = null;
    }
    auditLog.logAudit({
      type: 'disconnect',
      target: session.user,
      result: 'success',
      user: session.user,
      session: sessionId,
      detail: '用户主动断开连接',
    });
    // 用户主动断开: 联动清理该会话隧道 (关闭本地监听, 记 audit tunnel.stop) + 会话记录
    cleanupSession(e.sender.id, sessionId, session);
  }
  return { ok: true };
});

// ---------- 主机密钥指纹校验 IPC (TOFU, 防中间人) ----------
// hostkey:accept: 用户信任当前指纹。unknown 首次连接 -> 落库 + 放行 (hostkey.accept);
// mismatch 危险警告 -> 必须显式 override=true 才允许覆盖信任新指纹 (hostkey.override)。
ipcMain.handle('hostkey:accept', (e, { sessionId, override }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (!session) return { ok: false, error: '会话不存在' };
  const st = session.hostKeyState;
  if (!st || !st.pending) return { ok: false, error: '没有待确认的主机密钥' };
  // mismatch 弹窗必须显式 override=true 才允许覆盖 (安全边界); confirm 弹窗忽略 override 位
  if (st.mode === 'mismatch' && !override) {
    return { ok: false, error: '主机密钥不匹配, 需显式确认覆盖' };
  }
  return acceptPendingHostKeyCallbacks(session, override === true || st.mode === 'mismatch');
});

// hostkey:reject: 用户拒绝当前指纹 -> callback(false) 使连接失败 + 审计 hostkey.reject
ipcMain.handle('hostkey:reject', (e, { sessionId }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (!session) return { ok: false, error: '会话不存在' };
  return rejectPendingHostKeyCallbacks(session, null);
});

// 创建隧道 (面板「新增隧道」/ 连接后自动建立共用; 返回 {ok, tunnelId?, error?})
ipcMain.handle('ssh:tunnel', async (e, { sessionId, tunnelCfg }) => {
  try {
    return await createTunnel(e.sender.id, sessionId, tunnelCfg || {});
  } catch (err) {
    return { ok: false, error: (err && err.message) || '创建隧道失败' };
  }
});

// 查询当前会话的隧道列表 (仅该会话注册表, 各会话独立)
ipcMain.handle('ssh:tunnel:list', (e, { sessionId }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const tunnels = tunnelManager.listTunnels(key);
  return { ok: true, tunnels };
});

// 停止指定隧道 (按隧道 id, 兼容按本地端口); 停止后从列表移除并记 audit tunnel.stop
ipcMain.handle('ssh:tunnel:stop', (e, { sessionId, tunnelId }) => {
  const key = `${e.sender.id}:${sessionId}`;
  return tunnelManager.stopTunnel(key, tunnelId, {
    onEvent: tunnelEventHandler(e.sender.id, sessionId),
    onAudit: tunnelAuditHandler(e.sender.id, sessionId),
  });
});

ipcMain.handle('dialog:selectKey', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择私钥文件',
    properties: ['openFile'],
    filters: [{ name: '私钥文件', extensions: ['pem', 'key', 'ppk', '*'] }],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return { ok: true, path: result.filePaths[0] };
  }
  return { ok: false };
});

ipcMain.handle('ssh:chooseSshAgent', () => {
  // 返回可用的 SSH_AUTH_SOCK 或 Windows OpenSSH Agent 提示
  return { ok: true, agentAvailable: !!(process.env.SSH_AUTH_SOCK || os.platform() === 'win32') };
});

// ---------- 服务器健康监控 (Roadmap: 健康监控面板, P2) ----------
// 在指定会话上执行单条远端命令并收集输出 (带输出上限与超时保护)。
// 命令字符串全部来自 health-parser 的编译期常量表, 无用户输入拼接, 无注入面。
// 返回 { stdout, stderr, code }。
function execSSHCommand(session, command, opts) {
  return new Promise((resolve, reject) => {
    if (!session || !session.conn) {
      reject(new Error('会话未连接'));
      return;
    }
    const maxBytes = (opts && opts.maxBytes) || 64 * 1024;
    const timeoutMs = (opts && opts.timeoutMs) || 8000;
    let timer = null;
    session.conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => {
        if (stdout.length < maxBytes) stdout += d.toString('utf8');
      });
      if (stream.stderr) {
        stream.stderr.on('data', (d) => {
          if (stderr.length < maxBytes) stderr += d.toString('utf8');
        });
      }
      const finish = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        const code = (typeof stream.exitCode === 'number') ? stream.exitCode : null;
        resolve({ stdout, stderr, code });
      };
      stream.on('close', finish);
      stream.on('error', (e) => {
        if (timer) { clearTimeout(timer); timer = null; }
        reject(e);
      });
      // 超时保护: 命令卡死时强制关闭通道, 避免健康监控挂起
      timer = setTimeout(() => {
        try { stream.close(); } catch (e) {}
        reject(new Error('命令执行超时'));
      }, timeoutMs);
    });
  });
}

// 健康监控数据采集 IPC: 针对当前活动会话执行 uptime/free/df/top/hostname/os-release/date/
// nvidia-smi 等命令, 在 node 端解析为结构化 JSON, 渲染层只负责卡片渲染
// (不在 renderer 解析多行 shell 输出)。
// GPU 采集命令见 src/health-parser.js MONITOR_COMMANDS.gpu (nvidia-smi --query-gpu=... 
// --format=csv,noheader,nounits): 与并发组一致, 走 execSSHCommand 默认 64KB/8s 超时,
// 失败不阻塞整体 (data.gpu=null + errors.gpu), 渲染层展示降级文案。
// 单条命令失败不阻塞整体 (对应 section 为 null + errors 原因), 面板展示降级文案。
// 审计: monitor.refresh (target=host:port, detail=耗时), 不含命令输出等敏感信息。
ipcMain.handle('ssh:monitor:fetch', async (e, { sessionId }) => {
  const key = `${e.sender.id}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !session.conn) {
    return { ok: false, error: '会话未连接, 无法采集健康指标' };
  }
  const startedAt = Date.now();
  const target = session.user || `${session.id}`;
  try {
    // 磁盘解析诊断: 默认开启 (v23 起生产也开, 便于排查 df/白名单问题; 用户/我们想关时
    // 设 NIMBUS_DEV_DIAG=0 环境变量)。诊断输出到主进程 console (渲染进程 DevTools
    // Ctrl+Shift+I 可见), 仅含 df 原始行/挂载点/使用率, 不含密码等敏感信息。
    if (process.env.NIMBUS_DEV_DIAG === undefined) process.env.NIMBUS_DEV_DIAG = '1';
    const data = await healthParser.fetchMonitorData({
      exec: (command) => execSSHCommand(session, command),
      identity: target,
    });
    const elapsed = Date.now() - startedAt;
    auditLog.logAudit({
      type: 'monitor.refresh',
      target,
      result: 'success',
      user: target,
      session: sessionId,
      detail: `健康监控刷新 (耗时 ${elapsed}ms)`,
    });
    return { ok: true, ...data };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    auditLog.logAudit({
      type: 'monitor.refresh',
      target,
      result: 'failure',
      user: target,
      session: sessionId,
      detail: `健康监控失败 (耗时 ${elapsed}ms): ${(err && err.message) || '未知错误'}`,
    });
    return { ok: false, error: (err && err.message) || '获取监控数据失败' };
  }
});

// ---------- SFTP IPC ----------
ipcMain.handle('sftp:list', async (e, { sessionId, path }) => {
  try {
    const res = await sftpList(e.sender.id, sessionId, path);
    logAuditOp('sftp.list', e.sender.id, sessionId, path, res.ok ? 'success' : 'failure', res.ok ? undefined : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.list', e.sender.id, sessionId, path, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

ipcMain.handle('sftp:download', async (e, { sessionId, remotePath, localPath }) => {
  try {
    const res = await sftpDownload(e.sender.id, sessionId, remotePath, localPath);
    logAuditOp('sftp.download', e.sender.id, sessionId, remotePath, res.ok ? 'success' : 'failure', res.ok ? undefined : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.download', e.sender.id, sessionId, remotePath, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

ipcMain.handle('sftp:upload', async (e, { sessionId, localPath, remotePath }) => {
  try {
    const res = await sftpUpload(e.sender.id, sessionId, localPath, remotePath);
    const localName = String(localPath || '').split(/[\\/]/).pop() || '';
    logAuditOp('sftp.upload', e.sender.id, sessionId, remotePath, res.ok ? 'success' : 'failure', res.ok ? (localName ? `本地文件: ${localName}` : undefined) : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.upload', e.sender.id, sessionId, remotePath, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

// Roadmap ③: SFTP 拖拽上传路径登记
// 拖拽文件的真实路径由渲染进程经 preload webUtils.getPathForFile 取得 (仅真实拖拽产生的 File 对象
// 返回路径, 伪造/内存 File 返回空串), 与对话框流程 (dialog:selectFile) 同等安全: 此处登记后由
// sftp:upload 逐个消费校验, 不改变现有上传/审计链路。
// 过滤规则: 仅登记存在的普通文件 (目录 / 不存在 / 重复路径忽略), 防止任意路径滥用与目录递归上传。
ipcMain.handle('sftp:registerUploadPaths', (e, { paths }) => {
  if (!Array.isArray(paths)) return { ok: false, error: '参数不完整' };
  const accepted = [];
  const MAX_DROP_PATHS = 500; // 单次拖拽登记上限 (防 Set 膨胀)
  for (const p of paths) {
    if (accepted.length >= MAX_DROP_PATHS) break;
    if (typeof p !== 'string' || p.length === 0) continue;
    if (approvedLocalPaths.has(p)) continue; // 已登记 (防重复)
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue; // 过滤目录: 本次不做文件夹递归上传
    } catch (err) {
      continue; // 不存在或无权限
    }
    approvedLocalPaths.add(p);
    accepted.push(p);
  }
  return { ok: true, count: accepted.length, accepted };
});

ipcMain.handle('sftp:mkdir', async (e, { sessionId, path }) => {
  try {
    const res = await sftpMkdir(e.sender.id, sessionId, path);
    logAuditOp('sftp.mkdir', e.sender.id, sessionId, path, res.ok ? 'success' : 'failure', res.ok ? undefined : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.mkdir', e.sender.id, sessionId, path, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

ipcMain.handle('sftp:delete', async (e, { sessionId, path }) => {
  try {
    const res = await sftpDelete(e.sender.id, sessionId, path);
    logAuditOp('sftp.delete', e.sender.id, sessionId, path, res.ok ? 'success' : 'failure', res.ok ? undefined : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.delete', e.sender.id, sessionId, path, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

ipcMain.handle('sftp:rename', async (e, { sessionId, oldPath, newPath }) => {
  try {
    const res = await sftpRename(e.sender.id, sessionId, oldPath, newPath);
    logAuditOp('sftp.rename', e.sender.id, sessionId, oldPath, res.ok ? 'success' : 'failure', res.ok ? `新路径: ${newPath}` : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.rename', e.sender.id, sessionId, oldPath, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

// R3: 终端 cd 同步 (解析 cd 目标为安全绝对路径; 失败 {ok:false} 由 renderer 静默忽略)
ipcMain.handle('sftp:cdSync', async (e, { sessionId, rawPath }) => {
  try {
    const res = await sftpCdSync(e.sender.id, sessionId, rawPath);
    logAuditOp('sftp.cd', e.sender.id, sessionId, rawPath, res.ok ? 'success' : 'failure', res.ok ? `已切换: ${res.path}` : res.error);
    return res;
  } catch (err) {
    logAuditOp('sftp.cd', e.sender.id, sessionId, rawPath, 'failure', err.message || '会话不存在或未就绪');
    return { ok: false, error: err.message || '会话不存在或未就绪' };
  }
});

// Roadmap 第三梯队 ① (M): SFTP 服务端递归搜索
// 命令: find <cwd> -maxdepth N -iname "*keyword*" -print (由 src/file-filter.js 构造,
// 关键字白名单过滤 + maxdepth 钳制 1..3 + 单引号转义, 无注入面)。
// 超时 8s / 输出 64KB 上限复用 execSSHCommand; 服务器无 find 或执行失败 -> {ok:false, degraded:true}
// 由渲染层降级提示「仅当前目录过滤」。
// 审计: sftp.search (target=cwd, detail=命中数, 不含关键字内容, 无敏感)。
ipcMain.handle('sftp:search', async (e, { sessionId, path, keyword, maxDepth }) => {
  const winId = e.sender.id;
  const key = `${winId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !session.conn) {
    return { ok: false, error: '会话未连接' };
  }
  const cwd = (typeof path === 'string' && path.startsWith('/') && !path.split('/').some((s) => s === '..'))
    ? path
    : null;
  if (!cwd) return { ok: false, error: '搜索目录无效' };
  const depth = Math.max(1, Math.min(fileFilter.MAX_DEPTH_LIMIT, Math.floor(Number(maxDepth) || fileFilter.DEFAULT_MAX_DEPTH)));
  const cmd = fileFilter.buildFindCommand(cwd, keyword, { maxDepth: depth });
  if (!cmd) return { ok: false, error: '搜索关键字无效' };
  try {
    const out = await execSSHCommand(session, cmd, { maxBytes: 64 * 1024, timeoutMs: 8000 });
    const stderr = String(out.stderr || '');
    // 服务器无 find / 命令不存在: stderr 含 "not found"; 无 stdout 且退出码非 0 同样降级
    if (/not found/i.test(stderr) || (out.code !== 0 && !String(out.stdout || '').trim())) {
      logAuditOp('sftp.search', winId, sessionId, cwd, 'failure', '服务器不支持递归搜索 (未安装 find), 已降级');
      return { ok: false, degraded: true, error: '服务器不支持递归搜索 (未安装 find)，已降级为当前目录过滤' };
    }
    const results = fileFilter.parseFindOutput(out.stdout, cwd);
    logAuditOp('sftp.search', winId, sessionId, cwd, 'success', `递归搜索 (maxdepth ${depth}) 找到 ${results.length} 条`);
    return {
      ok: true,
      results,
      total: results.length,
      truncated: results.length >= fileFilter.MAX_RESULTS,
      cwd,
      maxDepth: depth,
    };
  } catch (err) {
    // 超时/通道异常: 降级提示 (不打扰)
    logAuditOp('sftp.search', winId, sessionId, cwd, 'failure', '递归搜索失败, 已降级');
    return { ok: false, degraded: true, error: '递归搜索失败 (超时或通道异常)，已降级为当前目录过滤' };
  }
});

// 下载远端文件夹 -> 本地 ZIP (对话框登记路径消费校验 + 进度事件上报)
ipcMain.handle('sftp:downloadFolder', async (e, { sessionId, remotePath, localZipPath }) => {
  const winId = e.sender.id;
  try {
    if (!remotePath || !localZipPath) return { ok: false, error: '参数不完整: 缺少远端或本地路径' };
    if (!isSafeRemotePath(remotePath)) return { ok: false, error: '路径包含非法段 (..)' };
    // 安全校验: localZipPath 必须经 dialog:selectSavePath 确认并登记 (消费移除, 防重放)
    if (!approvedLocalPaths.has(localZipPath)) {
      return { ok: false, error: '路径未经过确认' };
    }
    approvedLocalPaths.delete(localZipPath);

    const sftp = await getSftp(winId, sessionId);
    // 进度经 ssh:event 通道上报 (与 ready/error/tunnel 同一通道)
    const onProgress = (info) => sendEvent(winId, sessionId, 'sftp-download-progress', info);
    await sftpDownloadFolder(sftp, remotePath, localZipPath, onProgress);
    logAuditOp('sftp.downloadFolder', winId, sessionId, remotePath, 'success', '文件夹 ZIP 打包下载完成');
    return { ok: true };
  } catch (err) {
    logAuditOp('sftp.downloadFolder', winId, sessionId, remotePath, 'failure', (err && err.message) || '打包下载失败');
    return { ok: false, error: (err && err.message) || '打包下载失败' };
  }
});

// 选择本地文件 (上传用; 系统对话框是本地文件的唯一入口, 支持多选)
// 返回 {ok, paths}: 所有路径已登记, 供后续 sftp:upload 逐个消费校验
ipcMain.handle('dialog:selectFile', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    for (const p of result.filePaths) {
      approvedLocalPaths.add(p);
    }
    return { ok: true, paths: result.filePaths };
  }
  return { ok: false, paths: [] };
});

// 选择本地保存路径 (下载用)
ipcMain.handle('dialog:selectSavePath', async (e, defaultName) => {
  // 清洗默认文件名: 去掉路径分隔符, 防止默认名被当作目录穿越使用
  const safeName = String(defaultName || 'download').replace(/[\\/]/g, '_');
  const result = await dialog.showSaveDialog({
    title: '保存文件',
    defaultPath: safeName,
  });
  if (!result.canceled && result.filePath) {
    // 登记路径, 供后续 sftp:download 消费校验
    approvedLocalPaths.add(result.filePath);
    return { ok: true, path: result.filePath };
  }
  return { ok: false };
});

// ---------- 图片预览 IPC ----------

// 打开预览: 白名单扩展名 -> 内部 sftp 流式下载到临时目录 -> 返回 nimbus-preview://<filename>
ipcMain.handle('preview:open', async (e, { sessionId, remotePath }) => {
  try {
    if (!isSafeRemotePath(remotePath)) {
      return { ok: false, error: '路径包含非法段 (..)' };
    }
    const ext = path.extname(remotePath || '').toLowerCase();
    if (!PREVIEW_EXTENSIONS.includes(ext)) {
      return { ok: false, error: '不支持预览该文件类型' };
    }
    const sftp = await getSftp(e.sender.id, sessionId);
    const filename = `nimbus-${randomUUID()}${ext}`;
    const localPath = path.join(PREVIEW_DIR, filename);
    // 主进程内部下载: 不走 approvedLocalPaths 登记 (对话框仅约束用户触发的上传/下载)
    const dl = await downloadToFile(sftp, remotePath, localPath);
    if (!dl.ok) {
      logAuditOp('preview.open', e.sender.id, sessionId, remotePath, 'failure', dl.error);
      return dl;
    }
    const name = String(remotePath).split('/').pop() || remotePath;
    logAuditOp('preview.open', e.sender.id, sessionId, remotePath, 'success', `图片预览: ${name}`);
    return { ok: true, url: `nimbus-preview://${filename}`, name };
  } catch (err) {
    logAuditOp('preview.open', e.sender.id, sessionId, remotePath, 'failure', err.message || '预览失败');
    return { ok: false, error: err.message || '预览失败' };
  }
});

// 关闭预览: 删除临时目录下对应文件 (已校验文件名, 防目录穿越)
ipcMain.handle('preview:close', (e, filename) => {
  if (!isSafePreviewFilename(filename)) {
    return { ok: false, error: '非法的预览文件名' };
  }
  const localPath = path.join(PREVIEW_DIR, filename);
  try {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `清理临时文件失败: ${err.message}` };
  }
});

// 另存为: 预览窗口「下载」按钮 -> 系统保存对话框 (登记 approvedLocalPaths) -> 复用 sftpDownload
ipcMain.handle('preview:saveAs', async (e, { sessionId, remotePath }) => {
  try {
    if (!isSafeRemotePath(remotePath)) {
      return { ok: false, error: '路径包含非法段 (..)' };
    }
    const name = String(remotePath).split('/').pop() || 'preview';
    const result = await dialog.showSaveDialog({ title: '保存图片', defaultPath: name });
    if (result.canceled || !result.filePath) return { ok: false };
    approvedLocalPaths.add(result.filePath);
    const save = await sftpDownload(e.sender.id, sessionId, remotePath, result.filePath);
    logAuditOp('preview.saveAs', e.sender.id, sessionId, remotePath, save.ok ? 'success' : 'failure', save.ok ? undefined : save.error);
    return save;
  } catch (err) {
    logAuditOp('preview.saveAs', e.sender.id, sessionId, remotePath, 'failure', err.message || '保存失败');
    return { ok: false, error: err.message || '保存失败' };
  }
});

// ---------- 内置文档查看器 IPC ----------

// 打开文档: 白名单扩展名 -> 内部 sftp 流式下载到 DOC_DIR -> 返回 nimbus-doc://<filename>
// 返回 { ok, url, name, filename, ext, isText, truncated?, totalSize?, previewText? }
// (isText=文本类, 可在查看器内编辑保存)。
// 大文件分段 (Roadmap 第一梯队 ③): 文本类且远端大小 > 2MB 时, 仅下载前 512KB 供预览,
// truncated=true + previewText; 完整内容由 doc:loadFull 追加后渲染层重新 fetch。
// 分段预览只读 (编辑禁用), 保存逻辑始终基于完整内容 (doc:save 不变)。
ipcMain.handle('doc:open', async (e, { sessionId, remotePath }) => {
  try {
    if (!isSafeRemotePath(remotePath)) {
      return { ok: false, error: '路径包含非法段 (..)' };
    }
    const ext = path.extname(remotePath || '').toLowerCase();
    if (!DOC_EXTENSIONS.includes(ext)) {
      return { ok: false, error: '不支持打开该文件类型' };
    }
    const sftp = await getSftp(e.sender.id, sessionId);
    const filename = `nimbus-doc-${randomUUID()}${ext}`;
    const localPath = path.join(DOC_DIR, filename);
    const isText = TEXT_DOC_EXTENSIONS.includes(ext);

    // stat 远端大小 (大文件分段判定; stat 失败按 0 -> 走全量下载兜底)
    let totalSize = 0;
    try {
      const st = await promisify(sftp.stat).bind(sftp)(remotePath);
      totalSize = (st && typeof st.size === 'number') ? st.size : 0;
    } catch (err) {
      totalSize = 0;
    }
    const seg = editorHighlight.segmentPreviewInfo(totalSize);
    const truncated = isText && seg.truncated;

    let dl;
    if (truncated) {
      // 分段预览: 仅下载前 previewBytes 字节
      dl = await downloadToFilePartial(sftp, remotePath, localPath, seg.previewBytes);
    } else {
      // 小文件/二进制: 全量下载 (原有行为)
      dl = await downloadToFile(sftp, remotePath, localPath);
    }
    if (!dl.ok) {
      logAuditOp('doc.open', e.sender.id, sessionId, remotePath, 'failure', dl.error);
      return dl;
    }
    const name = String(remotePath).split('/').pop() || remotePath;
    // 登记打开记录: doc:save / doc:loadFull 前必须能在此表中匹配 (sessionId + remotePath)
    docOpenRegistry.set(filename, {
      sessionId,
      remotePath,
      truncated,
      loadedBytes: truncated ? seg.previewBytes : totalSize,
      totalSize,
    });
    let previewText = '';
    if (truncated) {
      try { previewText = fs.readFileSync(localPath, 'utf8'); } catch (err) { previewText = ''; }
      logAuditOp('doc.open', e.sender.id, sessionId, remotePath, 'success', `打开文档: ${name} (大文件分段预览 ${seg.previewBytes} / ${totalSize} 字节)`);
    } else {
      logAuditOp('doc.open', e.sender.id, sessionId, remotePath, 'success', `打开文档: ${name}`);
    }
    return {
      ok: true,
      url: `nimbus-doc://${filename}`,
      name,
      filename,
      ext,
      isText,
      truncated,
      totalSize,
      previewText,
    };
  } catch (err) {
    logAuditOp('doc.open', e.sender.id, sessionId, remotePath, 'failure', err.message || '打开文档失败');
    return { ok: false, error: err.message || '打开文档失败' };
  }
});

// 加载文档剩余部分 (大文件分段预览「加载全部」): 将远端 offset 起的剩余字节追加到
// 本地临时文件, 返回后渲染层重新 fetch nimbus-doc:// 取得完整内容。
// 安全约束 (与 doc:save 同构): 仅允许经 doc:open 在当前会话打开过且 truncated 的文档。
// 审计: doc.loadFull (target=remotePath, detail=总字节数, 无内容)。
ipcMain.handle('doc:loadFull', async (e, { sessionId, filename }) => {
  const winId = e.sender.id;
  try {
    if (!isSafeDocFilename(filename)) {
      return { ok: false, error: '非法的文档文件名' };
    }
    const reg = docOpenRegistry.get(filename);
    if (!reg || reg.sessionId !== sessionId) {
      return { ok: false, error: '文档未打开或会话不符' };
    }
    if (!reg.truncated) {
      return { ok: true, totalSize: reg.totalSize }; // 已完整加载
    }
    const sftp = await getSftp(winId, sessionId);
    const localPath = path.join(DOC_DIR, filename);
    const offset = reg.loadedBytes || 0;
    const appended = await appendRemoteTail(sftp, reg.remotePath, localPath, offset);
    if (!appended.ok) {
      logAuditOp('doc.loadFull', winId, sessionId, reg.remotePath, 'failure', appended.error);
      return appended;
    }
    reg.truncated = false;
    reg.loadedBytes = reg.totalSize;
    logAuditOp('doc.loadFull', winId, sessionId, reg.remotePath, 'success', `加载全部 ${reg.totalSize} 字节`);
    return { ok: true, totalSize: reg.totalSize };
  } catch (err) {
    logAuditOp('doc.loadFull', winId, sessionId, String(filename), 'failure', (err && err.message) || '加载全部失败');
    return { ok: false, error: (err && err.message) || '加载全部失败' };
  }
});

// 保存文档 (文本类): 将渲染进程编辑后的内容通过 sftp 写流覆盖回远端文件 (UTF-8)
// 安全约束 (P2): 仅文本类扩展名 + 必须经 doc:open 在当前会话打开过 (docOpenRegistry 匹配),
// 防止渲染层被攻破后通过 doc:save 覆盖远端任意文件。
ipcMain.handle('doc:save', (e, { sessionId, remotePath, content }) => {
  if (!isSafeRemotePath(remotePath)) {
    return { ok: false, error: '路径包含非法段 (..)' };
  }
  if (typeof content !== 'string') {
    return { ok: false, error: '文档内容无效' };
  }
  // 1) 扩展名白名单: 仅文本类可写回 (PDF/DOCX 等二进制不支持编辑保存)
  const ext = path.extname(remotePath || '').toLowerCase();
  if (!TEXT_DOC_EXTENSIONS.includes(ext)) {
    return { ok: false, error: '文档未打开或类型不支持编辑' };
  }
  // 2) 打开登记校验: 该 remotePath 必须经 doc:open 在当前会话打开过
  const isOpened = [...docOpenRegistry.values()].some(
    (v) => v.sessionId === sessionId && v.remotePath === remotePath
  );
  if (!isOpened) {
    return { ok: false, error: '文档未打开或类型不支持编辑' };
  }
  return new Promise((resolve) => {
    getSftp(e.sender.id, sessionId).then((sftp) => {
      const ws = sftp.createWriteStream(remotePath);
      let settled = false;
      const settle = (ok, error) => {
        if (settled) return;
        settled = true;
        logAuditOp('doc.save', e.sender.id, sessionId, remotePath, ok ? 'success' : 'failure', ok ? undefined : error);
        resolve(ok ? { ok: true } : { ok: false, error });
      };
      ws.on('error', (err) => settle(false, `保存失败: ${err.message}`));
      // close 在 flush 完成后触发; end(content) 写入后自动结束流
      ws.on('close', () => settle(true));
      ws.end(content, 'utf8');
    }).catch((err) => {
      logAuditOp('doc.save', e.sender.id, sessionId, remotePath, 'failure', err.message || '会话不存在或未就绪');
      resolve({ ok: false, error: err.message || '会话不存在或未就绪' });
    });
  });
});

// 关闭文档: 删除 DOC_DIR 下的临时文件 (已校验 nimbus-doc- 前缀, 幂等), 并移除打开登记
ipcMain.handle('doc:close', (e, filename) => {
  if (!isSafeDocFilename(filename)) {
    return { ok: false, error: '非法的文档文件名' };
  }
  const localPath = path.join(DOC_DIR, filename);
  try {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    docOpenRegistry.delete(filename); // 文档已关闭: 移除登记, 此后 doc:save 不再允许该文件
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `清理临时文件失败: ${err.message}` };
  }
});

// ---------- 存储连接配置 (password/passphrase 经 safeStorage 加密落盘) ----------
const STORE_FILE = path.join(app.getPath('userData'), 'connections.json');

// 内部: 读取磁盘原始连接列表 (含密文) -> 迁移 -> 返回明文列表 (仅供主进程内部使用: 导出/连接补全)
function loadConnectionsRaw() {
  let list = [];
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    }
  } catch (e) {}
  const migrated = credentialStore.migrateIfNeeded(list);
  if (migrated.changed) saveConnections(migrated.list);
  return migrated.list.map((conn) => credentialStore.decryptRecord(conn));
}

// store:load 返回脱敏视图: password/passphrase 一律置空, 附 hasPassword/hasPassphrase 标记
// (凭据只保留在主进程, 渲染层不持有明文; 连接时由 ssh:connect 按 connId 主进程解密补全)
function loadConnections() {
  const raw = loadConnectionsRaw();
  return raw.map((conn) => ({
    ...conn,
    password: '',
    passphrase: '',
    hasPassword: !!(conn && typeof conn.password === 'string' && conn.password !== ''),
    hasPassphrase: !!(conn && typeof conn.passphrase === 'string' && conn.passphrase !== ''),
  }));
}

// fail-closed 保存: 任一记录加密失败 -> 拒绝整体写入 (不落明文)
// 兼容: 渲染层提交的脱敏记录 (password='') 若磁盘已有原值 -> 沿用原密文 (留空保持不变)
// opts.overwriteEmpty=true (config:import): 全量替换, 跳过「留空沿用」merge, 不继承磁盘旧凭据
function saveConnections(list, opts) {
  try {
    const overwriteEmpty = !!(opts && opts.overwriteEmpty === true);
    let existing = [];
    if (!overwriteEmpty) {
      try {
        if (fs.existsSync(STORE_FILE)) {
          const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
          if (Array.isArray(parsed)) existing = parsed;
        }
      } catch (e) {}
    }
    const byId = new Map(existing.filter((c) => c && c.id).map((c) => [c.id, c]));
    const merged = (Array.isArray(list) ? list : []).map((conn) => {
      if (!conn || typeof conn !== 'object') return conn;
      if (overwriteEmpty) return conn; // 全量替换: 直接按传入记录加密, 不沿用磁盘旧凭据
      const old = byId.get(conn.id);
      if (!old) return conn;
      const out = { ...conn };
      if (out.password === '') out.password = old.password;       // 留空沿用原密文
      if (out.passphrase === '') out.passphrase = old.passphrase;
      return out;
    });
    const encrypted = merged.map((conn) => credentialStore.encryptRecord(conn));
    if (encrypted.some((c) => c === null)) {
      // 加密不可用: 拒绝写入 (fail-closed), 绝不落明文
      return { ok: false, error: '系统加密不可用，凭据保存被拒绝（为避免明文存储）' };
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(encrypted, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('store:load', () => loadConnections());
ipcMain.handle('store:save', (e, list) => saveConnections(list));

// ---------- 全局设置 (Roadmap 第一梯队 ③: 更新检查开关, 与连接配置无关) ----------
ipcMain.handle('settings:load', () => loadGlobalSettings());
ipcMain.handle('settings:save', (e, settings) => {
  const res = saveGlobalSettings(settings);
  if (res.ok) applyUpdateCheckSetting();
  return res;
});

// ---------- 配置加密导出/导入 (Roadmap ⑤) ----------
// 设计决策:
// - 系统对话框 (保存/打开) 全部在主进程内完成; 渲染层只负责「输入密码 + 展示结果」。
// - 导出: loadConnectionsRaw() 得到解密后的明文 list -> configPortable.exportConfig 加密
//   (整文件加密, 不含明文凭据) -> showSaveDialog -> 写文件 -> 审计 config.export
//   (target=文件名, 不含内容/密码)。
// - 导入: showOpenDialog -> 读文件 -> 渲染层传入密码 -> importConfig 解密
//   (认证失败 -> '密码错误或文件已损坏') -> 全量替换策略 (渲染层已确认提示) ->
//   saveConnections 落盘 (自动经 credential-store 加密) -> 审计 config.import (含条数)。
// - 审计失败分支: error 仅记固定文案 (密码错误/格式无效/写入失败等), 不记密码/内容。
ipcMain.handle('config:export', async (e, { password }) => {
  try {
    const list = loadConnectionsRaw(); // 解密后的明文连接数组 (主进程内部, 导出需真实数据)
    const res = configPortable.exportConfig(list, password);
    if (!res.ok) {
      auditLog.logAudit({ type: 'config.export', target: '配置导出', result: 'failure', detail: res.error });
      return res;
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = 'fgm-connections-backup-' +
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    const saveRes = await dialog.showSaveDialog({
      title: '导出加密配置',
      defaultPath: defaultName,
      filters: [{ name: 'FgmSSH 加密备份', extensions: ['json'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, error: '已取消' };
    }
    try {
      fs.writeFileSync(saveRes.filePath, JSON.stringify(res.data, null, 2), 'utf8');
    } catch (err) {
      auditLog.logAudit({ type: 'config.export', target: '配置导出', result: 'failure', detail: '写入文件失败' });
      return { ok: false, error: '写入文件失败' };
    }
    const fileName = String(saveRes.filePath).split(/[\\/]/).pop() || '备份文件';
    const count = (res.data && res.data.meta && typeof res.data.meta.count === 'number') ? res.data.meta.count : 0;
    auditLog.logAudit({
      type: 'config.export',
      target: fileName,
      result: 'success',
      detail: `已导出 ${count} 条连接配置 (AES-256-GCM 加密)`,
    });
    return { ok: true, count };
  } catch (err) {
    auditLog.logAudit({ type: 'config.export', target: '配置导出', result: 'failure', detail: '导出异常' });
    return { ok: false, error: '导出异常' };
  }
});

ipcMain.handle('config:import', async (e, { password }) => {
  try {
    const openRes = await dialog.showOpenDialog({
      title: '导入加密配置',
      properties: ['openFile'],
      filters: [{ name: 'FgmSSH 加密备份', extensions: ['json'] }],
    });
    if (openRes.canceled || !openRes.filePaths || openRes.filePaths.length === 0) {
      return { ok: false, error: '已取消' };
    }
    const filePath = openRes.filePaths[0];
    const fileName = String(filePath).split(/[\\/]/).pop() || '备份文件';
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      auditLog.logAudit({ type: 'config.import', target: fileName, result: 'failure', detail: '读取文件失败' });
      return { ok: false, error: '读取文件失败' };
    }
    let payload;
    try {
      payload = JSON.parse(content);
    } catch (err) {
      auditLog.logAudit({ type: 'config.import', target: fileName, result: 'failure', detail: '文件格式无效' });
      return { ok: false, error: '文件格式无效' };
    }
    const res = configPortable.importConfig(payload, password);
    if (!res.ok) {
      // res.error 为固定文案 (密码错误或文件已损坏 / 文件格式无效 / 版本不支持), 不含内容
      auditLog.logAudit({ type: 'config.import', target: fileName, result: 'failure', detail: res.error });
      return res;
    }
    // 全量替换策略: 导入后覆盖现有连接配置 (渲染层已 confirm 提示「将覆盖现有连接」)
    // overwriteEmpty=true: 导入为全量替换, 不继承磁盘旧凭据 (跳过「留空沿用」merge, 避免旧密码被带入新记录)
    const saveRes = saveConnections(res.list, { overwriteEmpty: true });
    if (!saveRes.ok) {
      auditLog.logAudit({ type: 'config.import', target: fileName, result: 'failure', detail: '保存配置失败' });
      return { ok: false, error: saveRes.error || '保存配置失败' };
    }
    auditLog.logAudit({
      type: 'config.import',
      target: fileName,
      result: 'success',
      detail: `已导入 ${res.count} 条连接配置 (覆盖现有配置)`,
    });
    return { ok: true, count: res.count };
  } catch (err) {
    auditLog.logAudit({ type: 'config.import', target: '配置导入', result: 'failure', detail: '导入异常' });
    return { ok: false, error: '导入异常' };
  }
});

// ---------- 操作日志 IPC ----------
// 渲染进程手动补充记录 (如打开日志面板等 UI 事件); entry 在主进程内经白名单+脱敏后落盘
ipcMain.handle('audit:log', (e, entry) => {
  auditLog.logAudit(entry || {});
  return { ok: true };
});
// 查询: 按时间/用户/类型/结果筛选 + 分页, 返回 {ok, total, items}
ipcMain.handle('audit:query', async (e, filters) => {
  try {
    const res = await auditLog.queryAudit(filters || {});
    return { ok: true, total: res.total, items: res.items };
  } catch (err) {
    return { ok: false, error: err.message || '查询日志失败' };
  }
});

ipcMain.handle('shell:openExternal', (e, url) => {
  shell.openExternal(url);
  return { ok: true };
});

// ---------- 托盘保活 + 真退出清理 ----------
// 全局会话清理: 仅在「真正退出」路径调用 (app.before-quit)。
// 逐个会话记录断开审计 -> 取消重连定时器 -> 停止该会话全部隧道 -> 关闭 SFTP/SSH 连接 -> 清空会话表。
// 「最小化到托盘」路径 (close -> hide) 不经过这里, 会话保持存活 (后台保活)。
function cleanupAllSessions() {
  for (const [key, session] of sessions.entries()) {
    if (!session.auditDisconnectLogged) {
      session.auditDisconnectLogged = true;
      auditLog.logAudit({
        type: 'disconnect',
        target: session.user,
        result: 'success',
        user: session.user,
        session: key.split(':')[1],
        detail: '应用退出, 会话清理',
      });
    }
    session.closed = true;
    session.userDisconnected = true;
    session.reconnectCanceled = true; // 退出不重连: 取消重连定时器
    if (session.reconnectRunner) {
      session.reconnectRunner.cancel();
      session.reconnectRunner = null;
    }
    const [winId, sid] = key.split(':');
    tunnelManager.stopAllTunnels(key, { onAudit: tunnelAuditHandler(Number(winId) || 0, sid) });
    try { if (session.sftp) session.sftp.end(); } catch (e) {}
    try { if (session.conn) session.conn.end(); } catch (e) {}
  }
  sessions.clear();
}

// 创建系统托盘图标 (app ready + 主窗口创建后调用):
// - 双击图标 -> 恢复主窗口
// - 右键菜单: 「显示主窗口」/「退出」 (退出是唯一真退出入口之一)
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    // 托盘创建失败 (极少数无托盘环境): 静默降级, 关闭窗口仍会退出 (由 window-all-closed 兜底)
    tray = null;
    return;
  }
  tray.setToolTip('FgmSSH - SSH 客户端');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
  tray.on('double-click', showMainWindow);
  auditLog.logAudit({ type: 'app.lifecycle', target: '系统托盘', result: 'success', detail: '托盘图标已创建' });
}

// 恢复主窗口 (托盘双击 / 菜单「显示主窗口」/ 第二实例触发)
function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) {
    createWindow();
    return;
  }
  if (!mainWin.isVisible()) mainWin.show();
  mainWin.focus();
  auditLog.logAudit({ type: 'app.lifecycle', target: '系统托盘', result: 'success', detail: '从托盘恢复主窗口' });
}

// 真正退出入口 (托盘菜单「退出」/ 菜单或 Ctrl+Q):
// 置 isQuitting=true 放行 close -> app.quit() -> before-quit 清理全部会话 -> will-quit 收尾。
function quitApp() {
  isQuitting = true;
  auditLog.logAudit({ type: 'app.lifecycle', target: '应用', result: 'success', detail: '用户退出应用' });
  app.quit();
}

// 窗口聚焦时拦截 Ctrl+Q (保留默认菜单不被替换, 仅补充退出快捷键; 与托盘「退出」同一退出路径)
function registerQuitShortcut(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt && !input.shift && !input.meta && input.key.toLowerCase() === 'q') {
      event.preventDefault();
      quitApp();
    }
  });
}

// ---------- 窗口创建 ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'FgmSSH - 现代化 SSH 客户端',
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: USE_SANDBOX,
    },
  });
  mainWin = win;
  registerQuitShortcut(win);

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // P0-1 安全: 拦截渲染层导航与 window.open
  // - xterm WebLinks 等 window.open: 一律拒绝新窗口, http(s) 链接转系统浏览器打开
  // - will-navigate: 应用为纯本地 SPA, 阻止任何非 file: 协议导航 (防跳板/防钓鱼)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ''))) {
      shell.openExternal(url).catch(() => {});
    }
    auditLog.logAudit({ type: 'window.open', target: String(url || '').slice(0, 200), result: 'blocked', detail: '新窗口打开已被拦截' });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (String(url).startsWith('file://')) return; // 本地 SPA 自身, 放行
    e.preventDefault();
    auditLog.logAudit({ type: 'will-navigate', target: String(url || '').slice(0, 200), result: 'blocked', detail: '导航已被拦截' });
  });

  // 生命周期: 关闭按钮/Alt+F4 -> 最小化到系统托盘 (隐藏窗口, 不退出进程, 不清理会话)。
  // 只有 isQuitting=true (托盘「退出」/ Ctrl+Q 触发的真退出) 时才放行关闭;
  // 会话/隧道/审计清理全部集中在真退出路径 (before-quit cleanupAllSessions), 隐藏路径不做任何清理。
  // 保底: 若托盘创建失败 (极少数无托盘环境), 关闭即走 quitApp 真退出, 避免窗口隐藏后无法恢复。
  win.on('close', (e) => {
    if (isQuitting) return; // 真退出: 放行
    if (!tray) { quitApp(); return; }
    e.preventDefault();
    win.hide();
    auditLog.logAudit({ type: 'app.lifecycle', target: '主窗口', result: 'success', detail: '最小化到系统托盘' });
  });

  win.on('closed', () => {
    if (mainWin === win) mainWin = null;
  });

  return win;
}

// 兼容模式: 任何 Windows 环境双击即用 (容器 / 远程桌面 / 老旧 GPU)
// P0-2 安全: 默认启用 Chromium OS 级沙箱 (安全基线)。
// 仅当显式设置 FGMSSH_NO_SANDBOX=1 (受限容器/远程桌面等无法跑沙箱的环境) 才降级关闭。
const USE_SANDBOX = process.env.FGMSSH_NO_SANDBOX !== '1';
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
if (!USE_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
}

app.whenReady().then(() => {
  // 单实例锁, 防止多个实例 (重复启动时 second-instance 恢复既有主窗口)
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    // 第二个实例尝试启动: 恢复并聚焦主窗口 (若窗口被隐藏到托盘)
    showMainWindow();
  });

  // 图片预览 + 文档查看器: 确保临时目录存在, 并注册自定义协议
  try { fs.mkdirSync(PREVIEW_DIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(DOC_DIR, { recursive: true }); } catch (e) {}
  registerPreviewProtocol();
  registerDocProtocol();

  // userData 迁移 (v1.1.0 软件更名): 必须是 userData 的【第一次触碰】, 必须在
  // initAuditLog / loadConnections / settings:load / hostkey 读取之前执行, 否则
  // 新目录 (%APPDATA%/FgmSSH) 下读不到旧数据。
  // - initAuditLog 内部 fs.mkdirSync(userData/logs, {recursive:true}) 会连带创建父目录
  //   新 userData 目录 —— 若迁移在其后执行, 会误判「新目录已存在」而跳过, 导致升级用户
  //   connections.json(DPAPI 加密凭据)/known_hosts.json/settings.json/logs 全部丢失。
  // - 迁移只复制不删除 (旧目录保留, 防回退); DPAPI 加密凭据与路径无关, 拷贝后仍可解密
  // - 迁移结果在下方 initAuditLog 之后补记 audit-log (type: store.migrate): 因 logAudit
  //   在 logDir 未初始化时静默丢弃, 此处仅 console 输出过程, 结果摘要留待 init 后落盘。
  // 旧 userData 目录名 = 更名前产品名; 迁移必须用旧名计算旧路径, 不能用当前 productName。
  const OLD_USER_DATA_DIR_NAME = 'NimbusSSH';
  let migrateSummary = null;
  try {
    const oldUserData = path.join(app.getPath('appData'), OLD_USER_DATA_DIR_NAME);
    const newUserData = app.getPath('userData');
    const migrateRes = migrateUserData({
      fs,
      path,
      oldDir: oldUserData,
      newDir: newUserData,
      log: (m) => console.log('[FgmSSH][store.migrate] ' + m),
    });
    migrateSummary = {
      result: migrateRes.migrated ? 'success' : 'skip',
      detail: `userData 迁移: ${migrateRes.migrated ? '已从 ' + oldUserData + ' 复制到 ' + newUserData : '未迁移 (' + migrateRes.reason + ')'}`,
    };
  } catch (e) {
    console.error('[FgmSSH] userData 迁移异常:', e && e.message);
  }

  // 操作日志: 默认 userData/logs/audit-YYYY-MM-DD.jsonl
  // (portable 版 userData = %APPDATA%/FgmSSH, 稳定可写, 不随临时解压目录消失)
  try { auditLog.initAuditLog({ dir: path.join(app.getPath('userData'), 'logs') }); } catch (e) {}
  // 迁移结果补记 (initAuditLog 之后, logDir 已就绪): 保证升级/首启的迁移动作有审计记录。
  if (migrateSummary) {
    try {
      auditLog.logAudit({ type: 'store.migrate', target: 'userData', result: migrateSummary.result, detail: migrateSummary.detail });
    } catch (e) { /* 审计失败不阻塞启动 */ }
  }

  createWindow();
  createTray();

  // Roadmap 第一梯队 ③: 启动延迟静默检查更新 (不阻塞启动; 离线/失败静默; 不自动升级)
  // 由全局设置 autoCheckUpdate 控制 (settings:save 可运行时启停)
  startUpdateChecker();

  app.on('activate', () => {
    // macOS Dock 点击激活: 若窗口被隐藏到托盘, 恢复之; 否则新建 (与原有行为一致)
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

// 真正退出前的会话/隧道清理: 只在 isQuitting 置位后 (托盘「退出」/ Ctrl+Q) 触发。
// 此时 close 事件已放行 (见 createWindow), 清理完成后 will-quit 做临时目录/日志收尾。
app.on('before-quit', () => {
  isQuitting = true;
  cleanupAllSessions();
});

// 退出前递归清理预览/文档临时目录
app.on('will-quit', () => {
  try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(DOC_DIR, { recursive: true, force: true }); } catch (e) {}
  auditLog.flush(); // 尽力冲刷待写日志 (异步 best-effort, 不阻塞退出)
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
});

// 托盘保活: 窗口全部关闭不再自动退出进程。
// 正常操作中 close 被拦截为 hide, 窗口不会真正销毁; 真退出时 isQuitting=true,
// 这里仅兜底 (如托盘创建失败降级时, 关闭窗口仍允许退出, 避免进程残留无窗口)。
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
