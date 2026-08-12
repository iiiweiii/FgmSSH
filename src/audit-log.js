/**
 * NimbusSSH - 操作日志模块 (audit-log)
 * ============================================================
 * 职责:
 *   - 统一收集关键操作 (连接/SFTP/文档/预览等) 为结构化 JSON 日志
 *   - JSON Lines 持久化 (每行一条, 按天滚动 audit-YYYY-MM-DD.jsonl)
 *   - 异步追加写 + 写入队列 (fire-and-forget, 不阻塞业务路径)
 *   - 脱敏: 密码/私钥/token 一律不落盘; 路径中的用户名段替换为 [REDACTED]
 *   - 查询: 按时间/用户/类型/结果筛选 + 分页
 *
 * 设计要点:
 *   - 本模块不依赖 Electron (纯 node fs/path), 便于 tests/ 下 node 直跑;
 *     main.js 调用 initAuditLog({dir: app.getPath('userData')/logs}) 注入目录。
 *   - 主进程是唯一写入口 (多窗口共用同文件, 由主进程串行写, 不交错不丢失)。
 *   - 写入失败静默 (console.warn 仅一次), 绝不抛给业务调用方。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 日志字段白名单 (固定 schema, 白名单策略: 未列入的字段一律不落盘)
// ts      - ISO 8601 时间戳 (自动生成, 忽略调用方传入值, 防伪造/保证排序)
// level   - 日志级别 (默认 INFO)
// user    - 用户标识 (sessionId 无法还原身份, 用 username@host)
// session - 会话 ID (渲染层 sessionId)
// type    - 操作类型 (connect/disconnect/sftp.list/sftp.upload/... )
// target  - 操作对象/目标 (远程路径/文件名/主机:端口)
// result  - 操作结果 (success/failure)
// detail  - 可选详细描述 (自由文本, 统一过 redact 脱敏)
const ALLOWED_FIELDS = ['ts', 'level', 'user', 'session', 'type', 'target', 'result', 'detail'];

// 未调用 initAuditLog 前的兜底目录 (main.js 总会显式传入 userData/logs)
const DEFAULT_LOG_DIR = path.join(os.tmpdir(), 'nimbusssh-audit');

let logDir = null;          // 日志目录 (initAuditLog 设置)
let writeQueue = Promise.resolve(); // 串行写入队列 (保证顺序 + 不交错)
let warnedOnce = false;     // 写入失败仅警告一次

// ---------- 初始化 ----------

/**
 * 初始化审计日志: 确定日志目录并创建 (幂等, 可重复调用用于重置目录)
 * @param {object} opts - { dir: 日志目录绝对路径 }
 * @returns {{dir: string}}
 */
function initAuditLog(opts) {
  const dir = (opts && opts.dir) ? opts.dir : DEFAULT_LOG_DIR;
  logDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('[audit-log] 创建日志目录失败:', e.message);
  }
  return { dir: logDir };
}

// ---------- 脱敏工具 ----------

/**
 * 从 user 标识中提取用户名 (username@host -> username; 无 @ 视为用户名本身)
 * @param {string} user
 * @returns {string}
 */
function extractUsername(user) {
  if (typeof user !== 'string' || !user) return '';
  const at = user.indexOf('@');
  return (at === -1 ? user : user.slice(0, at)).trim();
}

/**
 * 通用脱敏: 密码/私钥/token/长 base64 一律替换为 [REDACTED] 占位符。
 * 策略声明:
 *   - PEM 私钥块 (RSA/EC/DSA/OPENSSH/ENCRYPTED) 整块替换
 *   - 常见敏感键值对 password/passphrase/secret/token/api_key/auth 的取值替换
 *   - JWT 形态 token 替换
 *   - 连续 65+ 字符 base64 (疑似密钥材料) 替换 (宁可误伤, 不漏敏感)
 * 不记录 SSH 握手细节: 埋点层从不把握手/协商信息写入 detail, 此为第二道防线。
 * @param {*} text
 * @returns {*}
 */
function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  // 1) PEM 私钥块 (含 ENCRYPTED/RSA/EC/DSA 等变体)
  out = out.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    '[REDACTED:private-key]'
  );
  // 2) OpenSSH 私钥块 (BEGIN OPENSSH PRIVATE KEY)
  out = out.replace(
    /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    '[REDACTED:private-key]'
  );
  // 3) 常见敏感键值对: password=xxx / token:xxx / api_key=xxx 等
  out = out.replace(
    /\b(password|passwd|passphrase|secret|token|api[_-]?key|auth)\b\s*[:=]\s*[^\s,;|"'<>]+/gi,
    '$1=[REDACTED]'
  );
  // 4) JWT 形态 token
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:token]');
  // 5) 连续 65+ 字符 base64 (疑似私钥/凭据材料)
  out = out.replace(/[A-Za-z0-9+/]{65,}={0,2}/g, '[REDACTED:long-base64]');
  // 6) URI userinfo 密码段: user:password@host -> user:[REDACTED]@host (保留用户名)
  //    置于大块替换之后; [REDACTED] 不含 @, 不会被本规则二次匹配, 顺序安全
  out = out.replace(/(\w+):([^@\s/]+)@/g, '$1:[REDACTED]@');
  return out;
}

/**
 * 路径脱敏: 将路径中「等于当前用户名」的路径段替换为 [REDACTED]。
 * 策略: 保留路径可读性 (定位问题), 但隐藏用户目录名 (如 /home/root -> /home/[REDACTED])。
 * 用户名过短 (<2 字符) 不做段替换, 防止单字母段误伤 (如 /a/b 中的 a)。
 * @param {string} p      - 远程/本地路径
 * @param {string} user   - 用户标识 (username@host)
 * @returns {string}
 */
function redactPath(p, user) {
  if (typeof p !== 'string' || !p) return p;
  const username = extractUsername(user);
  if (!username || username.length < 2) return p;
  return p.split('/').map((seg) => (seg === username ? '[REDACTED]' : seg)).join('/');
}

// ---------- 条目清洗 ----------

/**
 * 字段白名单策略: 仅保留 ALLOWED_FIELDS, 其余字段 (password/privateKey 等) 一律丢弃;
 * 自动补 ts (ISO 8601, 覆盖调用方传入) / level=INFO; 非字符串值 JSON 序列化。
 * @param {object} entry
 * @returns {object} 清洗后的纯字符串字段对象
 */
function _sanitize(entry) {
  const src = (entry && typeof entry === 'object') ? entry : {};
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    out[key] = (typeof v === 'string') ? v : JSON.stringify(v);
  }
  // 自动补默认值 (ts 一律以落盘时刻为准, 保证单调排序)
  out.ts = new Date().toISOString();
  if (!out.level) out.level = 'INFO';
  if (!out.type) out.type = 'unknown';
  if (!out.result) out.result = 'success';
  return out;
}

// ---------- 写入 ----------

/**
 * 计算当前日志文件路径 (按天滚动: audit-YYYY-MM-DD.jsonl)
 * @returns {string}
 */
function getCurrentLogFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = 'audit-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.jsonl';
  return path.join(logDir, name);
}

/**
 * 单条异步追加 (appendFile 回调式; 错误静默, 仅首次 console.warn)
 * @param {string} file
 * @param {string} line
 * @returns {Promise<void>}
 */
function appendLine(file, line) {
  return new Promise((resolve) => {
    fs.appendFile(file, line + '\n', 'utf8', (err) => {
      if (err) {
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn('[audit-log] 写入日志失败 (仅警告一次):', err.message);
        }
      }
      resolve();
    });
  });
}

/**
 * 记录一条操作日志 (fire-and-forget)。
 * 组装 entry -> 白名单清洗 -> 脱敏 -> JSON.stringify -> 入队异步追加。
 * 返回写入队列 promise (调用方可忽略; 业务路径不 await, 绝无同步 IO)。
 * @param {object} entry - { type, target, result, detail, user, session }
 * @returns {Promise<void>}
 */
function logAudit(entry) {
  if (!logDir) return Promise.resolve(); // 未初始化: 静默丢弃, 不阻塞业务
  const clean = _sanitize(entry);
  // 脱敏: 自由文本统一过 redact; 目标路径额外做用户名段替换
  if (clean.user) clean.user = redact(clean.user);
  if (clean.session) clean.session = redact(clean.session);
  if (clean.type) clean.type = redact(clean.type);
  if (clean.result) clean.result = redact(clean.result);
  if (clean.detail) clean.detail = redact(clean.detail);
  if (clean.target) clean.target = redactPath(redact(clean.target), clean.user);
  // 可选字段为空则省略 (detail/user/session 等, 保持 JSON 干净)
  for (const key of ['user', 'session', 'detail']) {
    if (clean[key] === '') delete clean[key];
  }
  const line = JSON.stringify(clean);
  // 队列串行追加: 每条 append 在前一条完成后执行 -> 顺序保证 + 行不交错
  writeQueue = writeQueue.then(() => appendLine(getCurrentLogFile(), line));
  writeQueue.catch(() => {}); // 兜底: 队列异常不向外传播
  return writeQueue;
}

/**
 * 等待队列中所有待写日志落盘 (测试/退出前冲刷用; 正常业务无需调用)
 * @returns {Promise<void>}
 */
function flush() {
  return writeQueue;
}

// ---------- 查询 ----------

function parseTs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const ms = Date.parse(v);
  return isNaN(ms) ? null : ms;
}

function dayName(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return 'audit-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.jsonl';
}

/**
 * 收集需要读取的日志文件列表:
 *   - 未指定 from/to: 仅当前文件
 *   - 指定 from/to: 逐日扫描范围内文件 (上限 366 天, 防异常), 并兜底包含当前文件
 * @param {number|null} fromMs
 * @param {number|null} toMs
 * @returns {string[]}
 */
function collectLogFiles(fromMs, toMs) {
  if (!logDir) return [];
  const files = [];
  const pushIfExists = (p) => {
    if (fs.existsSync(p) && !files.includes(p)) files.push(p);
  };
  if (fromMs === null && toMs === null) {
    pushIfExists(getCurrentLogFile());
    return files;
  }
  const start = new Date(fromMs !== null ? fromMs : Date.now());
  start.setHours(0, 0, 0, 0);
  const end = new Date(toMs !== null ? toMs : Date.now());
  end.setHours(23, 59, 59, 999);
  let guard = 0;
  while (start.getTime() <= end.getTime() && guard < 366) {
    pushIfExists(path.join(logDir, dayName(start.getTime())));
    start.setDate(start.getDate() + 1);
    guard++;
  }
  pushIfExists(getCurrentLogFile()); // to 为今天/未来时确保包含当前文件
  return files;
}

function matchType(obj, typeFilter) {
  if (!typeFilter) return true;
  const types = String(typeFilter).split(',').map((s) => s.trim()).filter(Boolean);
  return types.includes(String(obj.type || ''));
}

/**
 * 按筛选条件匹配单条日志
 * @param {object} obj
 * @param {object} f   - { user, type, result }
 * @param {number|null} fromMs
 * @param {number|null} toMs
 */
function matchEntry(obj, f, fromMs, toMs) {
  const ts = parseTs(obj.ts);
  if (fromMs !== null && (ts === null || ts < fromMs)) return false;
  if (toMs !== null && (ts === null || ts > toMs)) return false;
  if (f.user && !String(obj.user || '').toLowerCase().includes(String(f.user).toLowerCase())) return false;
  if (!matchType(obj, f.type)) return false;
  if (f.result && String(obj.result || '') !== String(f.result)) return false;
  return true;
}

/**
 * 查询审计日志: 读取日志文件 -> 过滤 -> 按 ts 降序 -> 分页。
 * @param {object} filters
 *   - from/to: 时间范围 (ISO 字符串或毫秒时间戳; 可只给其一)
 *   - user:    用户标识子串 (不区分大小写)
 *   - type:    操作类型精确匹配 (支持逗号分隔多选, 如 'sftp.list,sftp.upload')
 *   - result:  success | failure
 *   - limit:   分页大小 (默认 100, 上限 1000)
 *   - offset:  偏移 (默认 0)
 * @returns {Promise<{total:number, items:object[]}>}
 */
async function queryAudit(filters) {
  const f = filters || {};
  const limit = Math.min(1000, Math.max(1, parseInt(f.limit, 10) || 100));
  const offset = Math.max(0, parseInt(f.offset, 10) || 0);
  const fromMs = parseTs(f.from);
  const toMs = parseTs(f.to);

  const entries = [];
  const files = collectLogFiles(fromMs, toMs);
  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue; // 文件读取失败 (被清理/权限): 跳过, 不中断查询
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== 'object') continue;
        if (!matchEntry(obj, f, fromMs, toMs)) continue;
        entries.push(obj);
      } catch (e) {
        // 损坏行: 跳过 (不影响整体查询)
      }
    }
  }
  entries.sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1)); // 最新在前
  return {
    total: entries.length,
    items: entries.slice(offset, offset + limit),
  };
}

// ---------- 导出 ----------
module.exports = {
  initAuditLog,
  logAudit,
  queryAudit,
  flush,
  redact,
  redactPath,
  extractUsername,
  _sanitize,
  getCurrentLogFile,
  getLogDir: () => logDir,
  _resetForTest: () => {
    writeQueue = Promise.resolve();
    logDir = null;
    warnedOnce = false;
  },
};
