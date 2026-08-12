/**
 * NimbusSSH - 配置加密导出/导入模块 (config-portable)
 * ============================================================
 * 职责:
 *   - 将完整连接列表 (含明文凭据, 由调用方从 credential-store 解密后传入)
 *     加密为单个自包含 JSON 文件 (换机/备份刚需), 全程 AES-256-GCM 认证加密。
 *   - 导入时校验版本/格式, 派生密钥, GCM 解密 (认证失败 = 密码错误或文件被篡改,
 *     明确报错, 绝不泄露任何解密内容)。
 *
 * 加密格式 (v1):
 *   {
 *     v: 1,
 *     kdf: 'scrypt',
 *     salt: <b64, 16B 随机>,
 *     iv:  <b64, 12B 随机>,
 *     tag: <b64, 16B GCM 认证标签>,
 *     data: <b64, AES-256-GCM 密文 (明文为连接列表 JSON)>,
 *     meta: { exportedAt: ISO 时间, count: 连接条数 }
 *   }
 *   - 整文件加密: data 即全部连接列表 (含凭据), 导出文件不含明文 JSON。
 *   - 密钥派生: scrypt(password, salt, 32B) — 参数: N=16384, r=8, p=1 (Node 默认),
 *     未来可扩展 kdf='pbkdf2' (pbkdf2Sync, 100000 轮 SHA-256), 导入时按 kdf 字段分发。
 *   - 认证: GCM tag 校验失败即抛错 -> 密码错误或文件已损坏; 防篡改。
 *
 * 清洗 (白名单):
 *   - 导出前对 list 做字段白名单清洗, 仅保留现有连接字段
 *     (id/name/host/port/username/user/authMethod/password/passphrase/privateKeyPath/tunnels),
 *     剔除未知字段; tunnels 子项同样白名单清洗 (localPort/remoteHost/remotePort/name)。
 *   - 导入解密后再次清洗, 保证外来文件不能注入任意字段。
 *
 * 安全要点:
 *   - 纯 node crypto (scryptSync / createCipheriv / createDecipheriv 'aes-256-gcm'),
 *     无新 npm 依赖, 不依赖 Electron, 便于 tests/ 下 node 直跑。
 *   - 错误信息为固定文案, 不含密码/内容/底层异常细节。
 */

const crypto = require('crypto');

const VERSION = 1;
const KDF = 'scrypt';
const KEY_LEN = 32;      // AES-256 密钥长度 (字节)
const SALT_LEN = 16;     // 随机盐 (字节)
const IV_LEN = 12;       // GCM 推荐 12B IV (字节)
const TAG_LEN = 16;      // GCM 认证标签 (字节)
const PBKDF2_ITERATIONS = 100000; // kdf='pbkdf2' 时的迭代轮数 (备用派生路径)
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 导入文件大小上限 (防超大文件拖垮解密)

// 连接记录字段白名单 (与现有连接配置字段一致; 'user' 兼容旧格式别名)
const CONN_FIELDS = [
  'id', 'name', 'host', 'port', 'username', 'user',
  'authMethod', 'password', 'passphrase', 'privateKeyPath', 'tunnels',
];
// 隧道子项字段白名单
const TUNNEL_FIELDS = ['localPort', 'remoteHost', 'remotePort', 'name'];

/**
 * 清洗单条连接记录: 仅保留白名单字段; 剔除未知字段/非对象/数组。
 * tunnels 为数组时逐个白名单清洗并过滤非法项; 非数组则剔除。
 * @param {*} conn
 * @returns {object|null} 清洗后的对象 (无 host 的非法项返回 null)
 */
function cleanConn(conn) {
  if (!conn || typeof conn !== 'object' || Array.isArray(conn)) return null;
  const out = {};
  for (const key of CONN_FIELDS) {
    if (conn[key] !== undefined && conn[key] !== null) out[key] = conn[key];
  }
  if (Array.isArray(out.tunnels)) {
    out.tunnels = out.tunnels
      .map((t) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
        const clean = {};
        for (const tk of TUNNEL_FIELDS) {
          if (t[tk] !== undefined && t[tk] !== null) clean[tk] = t[tk];
        }
        return clean;
      })
      .filter((t) => t !== null);
  } else if (out.tunnels !== undefined) {
    delete out.tunnels;
  }
  return out;
}

/**
 * 清洗连接列表: 仅保留对象且含非空 host 的条目 (无 host 的记录无意义, 剔除)。
 * @param {*} list
 * @returns {object[]}
 */
function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(cleanConn)
    .filter((c) => c !== null && typeof c.host === 'string' && c.host.trim() !== '');
}

/**
 * 根据 kdf 字段派生 AES-256 密钥。
 * scrypt: crypto.scryptSync(password, salt, 32) (N=16384,r=8,p=1 Node 默认);
 * pbkdf2: crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')。
 * @param {string} password
 * @param {string} saltB64 - base64 盐
 * @param {string} kdf
 * @returns {Buffer} 32B 密钥
 */
function deriveKey(password, saltB64, kdf) {
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length !== SALT_LEN) throw new Error('invalid-salt');
  if (kdf === 'scrypt') return crypto.scryptSync(password, salt, KEY_LEN);
  if (kdf === 'pbkdf2') return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  throw new Error('unsupported-kdf');
}

/**
 * 导出加密配置。
 * @param {object[]} list   - 完整连接数组 (明文凭据, 由调用方解密后传入)
 * @param {string} password - 加密密码 (非空)
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 *   data 为 v1 加密负载 (见文件头格式说明), 调用方负责序列化落盘。
 */
function exportConfig(list, password) {
  try {
    if (typeof password !== 'string' || password.trim().length === 0) {
      return { ok: false, error: '密码不能为空' };
    }
    const cleanList = sanitizeList(list);
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = deriveKey(password, salt.toString('base64'), KDF);
    const plaintext = Buffer.from(JSON.stringify(cleanList), 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ok: true,
      data: {
        v: VERSION,
        kdf: KDF,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64'),
        meta: {
          exportedAt: new Date().toISOString(),
          count: cleanList.length,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: '导出失败: 加密参数不合法' };
  }
}

/**
 * 导入并解密配置。
 * @param {object} payload  - 读取到的备份文件 JSON 对象
 * @param {string} password - 解密密码
 * @returns {{ok: true, list: object[], count: number} | {ok: false, error: string}}
 *   - 认证失败 (密码错误/文件被篡改) -> {ok:false, error:'密码错误或文件已损坏'}
 *   - 版本/格式不合法 -> 对应明确文案 (不含内容)
 */
function importConfig(payload, password) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: '文件格式无效' };
    }
    if (payload.v !== VERSION) {
      return { ok: false, error: '不支持的备份版本' };
    }
    if (typeof password !== 'string' || password.trim().length === 0) {
      return { ok: false, error: '密码不能为空' };
    }
    const { kdf, salt, iv, tag, data } = payload;
    if (
      typeof kdf !== 'string' ||
      typeof salt !== 'string' ||
      typeof iv !== 'string' ||
      typeof tag !== 'string' ||
      typeof data !== 'string'
    ) {
      return { ok: false, error: '文件格式无效' };
    }

    const key = deriveKey(password, salt, kdf);
    const ivBuf = Buffer.from(iv, 'base64');
    if (ivBuf.length !== IV_LEN) return { ok: false, error: '文件格式无效' };
    const tagBuf = Buffer.from(tag, 'base64');
    if (tagBuf.length !== TAG_LEN) return { ok: false, error: '文件格式无效' };
    const dataBuf = Buffer.from(data, 'base64');
    if (dataBuf.length === 0 || dataBuf.length > MAX_FILE_BYTES) {
      return { ok: false, error: '文件格式无效' };
    }

    // GCM 认证解密: tag 不匹配 (密码错误/内容被篡改) -> 明确报错, 不返回任何内容
    let plain;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
      decipher.setAuthTag(tagBuf);
      plain = Buffer.concat([decipher.update(dataBuf), decipher.final()]);
    } catch (e) {
      return { ok: false, error: '密码错误或文件已损坏' };
    }

    let list;
    try {
      list = JSON.parse(plain.toString('utf8'));
    } catch (e) {
      return { ok: false, error: '文件内容无效' };
    }
    if (!Array.isArray(list)) {
      return { ok: false, error: '文件内容无效' };
    }
    // 解密结果再次白名单清洗 (外来文件不能注入任意字段)
    const cleanList = sanitizeList(list);
    return { ok: true, list: cleanList, count: cleanList.length };
  } catch (e) {
    // deriveKey 等底层异常统一收敛为格式错误 (不泄露内部细节)
    return { ok: false, error: '文件格式无效' };
  }
}

module.exports = {
  exportConfig,
  importConfig,
  sanitizeList,
  cleanConn,
  VERSION,
  KDF,
  KEY_LEN,
  SALT_LEN,
  IV_LEN,
  TAG_LEN,
  CONN_FIELDS,
  TUNNEL_FIELDS,
};
