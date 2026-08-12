/**
 * NimbusSSH - 连接凭据加密存储模块 (credential-store)
 * ============================================================
 * 职责:
 *   - 用 Electron 主进程 safeStorage (Windows 上为 DPAPI) 加密连接配置中的
 *     password / passphrase 字段后落盘; 读取时解密为明文供渲染层使用。
 *   - 渲染层 store:load / store:save 对外行为不变 (load 返回明文, save 在主进程加密)。
 *   - 旧明文配置自动迁移: 首次加载发现明文 password/passphrase -> 自动加密回写 (幂等, 用户无感)。
 *   - 安全降级: safeStorage.isEncryptionAvailable() 为 false 时保持明文并 console.warn 一次,
 *     绝不崩溃、不影响连接功能。
 *   - 加解密失败容错: 单条解密失败 (密钥轮换/文件损坏) -> 该字段置空并跳过 (不抛异常),
 *     整体 load 不因单条失败而失败。
 *
 * 设计要点:
 *   - 本模块不 require('electron') (顶层无硬依赖), safeStorage 通过 createCredentialStore
 *     参数注入, 便于 tests/ 下 node 直跑 (注入 mock)。
 *   - 加密存储格式: `enc:v1:<base64>` 前缀标记, 便于识别与未来 v2 演进。
 *   - privateKey 是路径, 不加密 (非密钥内容); 其他字段 (host/user/port/name/authMethod 等)
 *     保持原样。
 *   - 已加密 token 再次 encrypt 时原样返回 (幂等), 保证迁移/保存可重复执行安全。
 */

const TOKEN_PREFIX = 'enc:v1:';

// 需要加密/解密的敏感字段 (privateKey 为路径, 不加密)
const SECRET_FIELDS = ['password', 'passphrase'];

/**
 * 创建凭据加密存储实例。
 * @param {object} opts
 *   - safeStorage: Electron 主进程 safeStorage 模块 (须实现 isEncryptionAvailable /
 *     encryptString / decryptString); 未注入或不可用时自动降级明文。
 *   - log: 可选日志回调 (m: string); 未提供时降级为 console.warn。
 * @returns {{
 *   encrypt(secret: string): string,
 *   decrypt(token: string): string,
 *   encryptRecord(conn: object): object,
 *   decryptRecord(conn: object): object,
 *   migrateIfNeeded(list: object[]): { list: object[], changed: boolean },
 *   isEncryptedToken(value: any): boolean,
 *   TOKEN_PREFIX: string,
 * }}
 */
function createCredentialStore({ safeStorage, log } = {}) {
  // 各类告警仅提示一次, 防止降级/失败场景刷屏
  const warnedOnce = {};
  function warn(key, msg) {
    if (warnedOnce[key]) return;
    warnedOnce[key] = true;
    if (typeof log === 'function') {
      try { log(msg); } catch (e) { /* 日志失败不影响业务 */ }
    } else {
      console.warn(msg);
    }
  }

  /**
   * safeStorage 是否可用 (Windows 上即 DPAPI 可用)。
   * @returns {boolean}
   */
  function encryptionAvailable() {
    return !!(
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    );
  }

  /**
   * 加密单个明文秘密 -> token; 已加密 token 原样返回 (幂等)。
   * 降级: safeStorage 不可用或加密抛错时返回明文, 绝不抛给调用方。
   * @param {string} secret
   * @returns {string}
   */
  function encrypt(secret) {
    if (typeof secret !== 'string' || secret === '') return secret;
    if (secret.startsWith(TOKEN_PREFIX)) return secret; // 已加密, 幂等
    if (!encryptionAvailable()) {
      warn('downgrade', '[credential-store] safeStorage 不可用, 凭据以明文降级存储 (仅警告一次)');
      return secret;
    }
    try {
      const cipher = safeStorage.encryptString(secret);
      return TOKEN_PREFIX + cipher.toString('base64');
    } catch (e) {
      warn('encrypt-error', '[credential-store] 加密失败, 降级明文存储: ' + (e && e.message));
      return secret;
    }
  }

  /**
   * 解密 token -> 明文。
   *   - 非 enc:v1: 前缀原样返回 (兼容未加密/降级明文);
   *   - 解密失败 (密钥轮换/文件损坏/DPAPI 不可用) -> 返回 '' 且不抛异常。
   * @param {string} token
   * @returns {string}
   */
  function decrypt(token) {
    if (typeof token !== 'string' || token === '') return token;
    if (!token.startsWith(TOKEN_PREFIX)) return token;
    if (!encryptionAvailable()) {
      warn('downgrade', '[credential-store] safeStorage 不可用, 无法解密 enc:v1: token, 该字段置空 (仅警告一次)');
      return '';
    }
    try {
      const b64 = token.slice(TOKEN_PREFIX.length);
      const cipher = Buffer.from(b64, 'base64');
      return safeStorage.decryptString(cipher).toString('utf8');
    } catch (e) {
      warn('decrypt-error', '[credential-store] 解密失败, 该字段置空: ' + (e && e.message));
      return '';
    }
  }

  /**
   * 判断值是否为已加密 token (enc:v1: 前缀)。
   * @param {*} value
   * @returns {boolean}
   */
  function isEncryptedToken(value) {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
  }

  /**
   * 加密单条连接记录: 仅处理 password/passphrase, 其余字段透传
   * (浅拷贝, 不修改原对象)。
   * @param {object} conn
   * @returns {object}
   */
  function encryptRecord(conn) {
    if (!conn || typeof conn !== 'object' || Array.isArray(conn)) return conn;
    const out = Object.assign({}, conn);
    for (const field of SECRET_FIELDS) {
      if (typeof out[field] === 'string' && out[field] !== '') {
        out[field] = encrypt(out[field]);
      }
    }
    return out;
  }

  /**
   * 解密单条连接记录: 仅处理 password/passphrase, 其余字段透传
   * (浅拷贝, 不修改原对象)。
   * @param {object} conn
   * @returns {object}
   */
  function decryptRecord(conn) {
    if (!conn || typeof conn !== 'object' || Array.isArray(conn)) return conn;
    const out = Object.assign({}, conn);
    for (const field of SECRET_FIELDS) {
      if (typeof out[field] === 'string' && out[field] !== '') {
        out[field] = decrypt(out[field]);
      }
    }
    return out;
  }

  /**
   * 旧配置自动迁移: 把明文 password/passphrase 加密为 token。
   * 幂等: 已加密 token 不再处理; 重复执行第二次 changed=false。
   * 降级: safeStorage 不可用时视为无需迁移 (保持明文, 不回写, 避免每次加载重复改写)。
   * @param {object[]} list
   * @returns {{list: object[], changed: boolean}}
   */
  function migrateIfNeeded(list) {
    const arr = Array.isArray(list) ? list : [];
    const canEncrypt = encryptionAvailable();
    let changed = false;
    let hasSecret = false;

    const out = arr.map((conn) => {
      if (!conn || typeof conn !== 'object' || Array.isArray(conn)) return conn;
      let need = false;
      for (const field of SECRET_FIELDS) {
        const v = conn[field];
        if (typeof v === 'string' && v !== '') {
          hasSecret = true;
          if (!isEncryptedToken(v) && canEncrypt) { need = true; break; }
        }
      }
      if (!need) return conn;
      changed = true;
      return encryptRecord(conn);
    });

    // 降级提示 (仅一次): 检测到存在凭据字段但加密不可用
    if (!canEncrypt && hasSecret) {
      warn('downgrade', '[credential-store] safeStorage 不可用, 凭据以明文降级存储 (仅警告一次)');
    }
    if (changed) {
      const count = out.filter((c, i) => c !== arr[i]).length;
      warn('migrate', '[credential-store] 已迁移 ' + count + ' 条连接的明文凭据为加密存储');
    }
    return { list: out, changed };
  }

  return {
    encrypt,
    decrypt,
    encryptRecord,
    decryptRecord,
    migrateIfNeeded,
    isEncryptedToken,
    TOKEN_PREFIX,
  };
}

module.exports = { createCredentialStore, TOKEN_PREFIX };
