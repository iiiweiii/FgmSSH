/**
 * NimbusSSH - 主机密钥指纹存储模块 (hostkey-store, TOFU)
 * ============================================================
 * 职责 (Roadmap 第一梯队 ②, 纯 node, 主进程使用):
 *   - 维护 known_hosts 指纹库 (userData/known_hosts.json), 实现 TOFU
 *     (Trust On First Use, 首次连接信任 + 后续比对) 防中间人攻击。
 *   - 结构: `{ "<host>:<port>": { fingerprint, algorithm, firstSeen, lastSeen } }`
 *     - fingerprint: OpenSSH 兼容 SHA256 指纹 (SHA256:<base64 无 padding>, 与 ssh-keygen -lf 一致)
 *     - algorithm:   服务器密钥算法 (ssh-ed25519 / ssh-rsa / ecdsa-sha2-* ...)
 *     - firstSeen / lastSeen: ISO 8601 时间戳
 *   - computeFingerprint: 对 ssh2 hostVerifier 收到的 host key Buffer 计算
 *     OpenSSH 兼容指纹 (SHA256:xxx 无 padding) + MD5 十六进制 (MD5:aa:bb:..., 展示更直观)。
 *   - checkHostKey: 三态判定 trusted / unknown / mismatch (mismatch = 危险, 可能中间人)。
 *   - trustHostKey: 用户确认后写入 (unknown 首次写入 / mismatch 覆盖新指纹)。
 *
 * 设计要点:
 *   - 本模块不 require('electron') (顶层无硬依赖), 存储路径由调用方注入,
 *     便于 tests/ 下 node 直跑。
 *   - known_hosts 为明文 JSON (主机指纹非机密, 与 OpenSSH known_hosts 同定位),
 *     但与凭据库 (credential-store, 加密) 完全分离。
 *   - 路径安全: host/port 仅作为 JSON key 的字符串拼接 (无文件系统路径注入),
 *     写入时 mkdirSync recursive 自动建目录。
 *   - 容错: 文件缺失 -> {}; JSON 损坏 -> 回退 {} (不抛异常, 不覆盖原文件直到下次写入)。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 生成 known_hosts 的 key: "<host>:<port>" (纯字符串拼接, 无注入面)。
 * @param {string} host
 * @param {number|string} port
 * @returns {string}
 */
function hostKeyId(host, port) {
  return String(host == null ? '' : host) + ':' + String(port == null ? 22 : port);
}

/**
 * 计算 OpenSSH 兼容指纹 (对 host key 原始 Buffer)。
 * SHA256: base64 无尾部 padding (与 `ssh-keygen -lf` 输出逐字符一致, 便于用户比对);
 * MD5:    冒号分隔十六进制小写 (与 `ssh-keygen -E md5 -lf` 输出一致)。
 * @param {Buffer|Uint8Array|string} hostKeyBuffer ssh2 hostVerifier 收到的 host key
 * @returns {{sha256: string, md5: string}} SHA256:xxx (无 padding) + MD5:aa:bb:...
 */
function computeFingerprint(hostKeyBuffer) {
  let buf;
  if (Buffer.isBuffer(hostKeyBuffer)) {
    buf = hostKeyBuffer;
  } else if (hostKeyBuffer instanceof Uint8Array) {
    buf = Buffer.from(hostKeyBuffer);
  } else if (typeof hostKeyBuffer === 'string') {
    buf = Buffer.from(hostKeyBuffer, 'utf8');
  } else {
    buf = Buffer.from([]);
  }
  // OpenSSH 指纹 base64 不带尾部 '=' padding (ssh-keygen -lf 实测): 去掉尾缀保持一致
  const sha256 = 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
  const md5Hex = crypto.createHash('md5').update(buf).digest('hex').match(/../g).join(':');
  return { sha256, md5: 'MD5:' + md5Hex };
}

/**
 * 归一化存储的指纹值: 兼容早期版本可能写入的带 base64 padding 的 SHA256 指纹
 * (SHA256:abc== -> SHA256:abc)。OpenSSH 指纹无尾部 '=', 此处去掉历史条目残留,
 * 避免升级后同一主机被误判为 mismatch。
 * @param {*} value 存储的 fingerprint 值
 * @returns {*} 归一化后的值 (非字符串原样返回)
 */
function normalizeStoredFingerprint(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^(SHA256:[A-Za-z0-9+/]+)=+$/, '$1');
}

/**
 * 读取 known_hosts 指纹库。
 * 文件不存在 / JSON 损坏 / 非对象 -> 回退 {} (容错, 不抛异常)。
 * @param {string} storePath known_hosts.json 绝对路径
 * @returns {object} { "<host>:<port>": { fingerprint, algorithm, firstSeen, lastSeen } }
 */
function loadKnownHosts(storePath) {
  try {
    if (storePath && fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 旧值归一: 兼容早期版本可能写入的带 base64 padding 的 SHA256 指纹,
        // 升级后不把同一主机误判为 mismatch (内存归一, 下次 trustHostKey 保存时落盘)。
        for (const key of Object.keys(parsed)) {
          const entry = parsed[key];
          if (entry && typeof entry === 'object' && typeof entry.fingerprint === 'string') {
            entry.fingerprint = normalizeStoredFingerprint(entry.fingerprint);
          }
        }
        return parsed;
      }
    }
  } catch (e) {
    // 损坏 JSON: 回退空库 (保守; 不覆盖原文件, 下次 trustHostKey 写入时重建)
  }
  return {};
}

/**
 * 保存 known_hosts 指纹库 (目录不存在自动创建)。
 * @param {string} storePath known_hosts.json 绝对路径
 * @param {object} map 指纹库对象
 * @returns {{ok: boolean, error?: string}}
 */
function saveKnownHosts(storePath, map) {
  const data = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  if (!storePath) return { ok: false, error: 'storePath 缺失' };
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '写入 known_hosts 失败' };
  }
}

/**
 * 查询单个主机指纹条目 (不存在返回 null)。
 * @param {string} storePath
 * @param {string} host
 * @param {number|string} port
 * @returns {object|null}
 */
function getEntry(storePath, host, port) {
  const map = loadKnownHosts(storePath);
  return map[hostKeyId(host, port)] || null;
}

/**
 * 校验主机指纹三态:
 *   - trusted : 库中存在且 fingerprint 一致 -> 放行
 *   - unknown : 库中无记录 (首次连接) -> 需用户确认
 *   - mismatch: 库中存在但 fingerprint 不同 -> 危险! 可能中间人攻击
 * @param {string} storePath
 * @param {string} host
 * @param {number|string} port
 * @param {string} fingerprint SHA256:xxx
 * @param {string} algorithm
 * @returns {{status: 'trusted'|'unknown'|'mismatch', stored?: object}}
 */
function checkHostKey(storePath, host, port, fingerprint, algorithm) {
  const id = hostKeyId(host, port);
  const map = loadKnownHosts(storePath);
  const stored = map[id];
  if (!stored) return { status: 'unknown' };
  const storedFp = stored.fingerprint;
  if (typeof fingerprint === 'string' && fingerprint.length > 0 && storedFp === fingerprint) {
    return { status: 'trusted', stored };
  }
  return { status: 'mismatch', stored };
}

/**
 * 信任 (写入/覆盖) 主机指纹: 首次确认写入; mismatch 覆盖时更新 fingerprint 并保留 firstSeen。
 * @param {string} storePath
 * @param {string} host
 * @param {number|string} port
 * @param {string} fingerprint SHA256:xxx
 * @param {string} algorithm
 * @returns {{ok: boolean, id: string, error?: string}}
 */
function trustHostKey(storePath, host, port, fingerprint, algorithm) {
  const id = hostKeyId(host, port);
  const map = loadKnownHosts(storePath);
  const now = new Date().toISOString();
  const existing = map[id];
  map[id] = {
    fingerprint: String(fingerprint || ''),
    algorithm: String(algorithm || 'unknown'),
    firstSeen: (existing && existing.firstSeen) || now,
    lastSeen: now,
  };
  const res = saveKnownHosts(storePath, map);
  return res.ok ? { ok: true, id } : { ok: false, id, error: res.error };
}

module.exports = {
  hostKeyId,
  computeFingerprint,
  normalizeStoredFingerprint,
  loadKnownHosts,
  saveKnownHosts,
  getEntry,
  checkHostKey,
  trustHostKey,
};
