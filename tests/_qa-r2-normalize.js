#!/usr/bin/env node
/** Round2 QA 补充: normalizeStoredFingerprint / 旧带 padding 条目归一生效验证 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/hostkey-store');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-norm-'));
const p = path.join(dir, 'known_hosts.json');

// 1) normalizeStoredFingerprint 单元行为
check('无 padding 值原样不变', store.normalizeStoredFingerprint('SHA256:Y5Bn0lxnS+dl5dnK38A0IV/6btRQ+gj3xYQtgvEIkEI') === 'SHA256:Y5Bn0lxnS+dl5dnK38A0IV/6btRQ+gj3xYQtgvEIkEI');
check('单 = 去除', store.normalizeStoredFingerprint('SHA256:abc=') === 'SHA256:abc');
check('多 = 去除', store.normalizeStoredFingerprint('SHA256:abc===') === 'SHA256:abc');
check('MD5 值不受影响', store.normalizeStoredFingerprint('MD5:22:6b:f1:09') === 'MD5:22:6b:f1:09');
check('非字符串原样返回', store.normalizeStoredFingerprint(123) === 123 && store.normalizeStoredFingerprint(null) === null);
check('非 SHA256 前缀不受影响', store.normalizeStoredFingerprint('abc=') === 'abc=');

// 2) 手工构造带 padding 旧条目 -> loadKnownHosts 内存归一 -> checkHostKey 对新无 padding 指纹判 trusted
const unpadded = 'SHA256:Y5Bn0lxnS+dl5dnK38A0IV/6btRQ+gj3xYQtgvEIkEI';
fs.writeFileSync(p, JSON.stringify({
  'example.com:22': { fingerprint: unpadded + '=', algorithm: 'ssh-ed25519', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
  'other.com:22': { fingerprint: unpadded + '==', algorithm: 'ssh-ed25519', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
}), 'utf8');

const map = store.loadKnownHosts(p);
check('loadKnownHosts 内存归一 (example.com:22)', map['example.com:22'].fingerprint === unpadded, map['example.com:22'].fingerprint);
check('loadKnownHosts 内存归一 (other.com:22)', map['other.com:22'].fingerprint === unpadded, map['other.com:22'].fingerprint);
const r = store.checkHostKey(p, 'example.com', 22, unpadded, 'ssh-ed25519');
check('旧带 padding 条目对新无 padding 指纹 -> trusted (归一生效)', r.status === 'trusted', r.status);

// 3) 磁盘文件未被 loadKnownHosts 改写 (内存归一, 下次 trustHostKey 保存时才落盘)
const raw = fs.readFileSync(p, 'utf8');
check('loadKnownHosts 不直接改写磁盘 (仍含旧 padding)', raw.includes(unpadded + '='), 'file unchanged');

// 4) trustHostKey 落库后为无 padding 新值
store.trustHostKey(p, 'example.com', 22, unpadded, 'ssh-ed25519');
const raw2 = fs.readFileSync(p, 'utf8');
check('trustHostKey 保存后指纹为无 padding', raw2.includes(unpadded) && !raw2.includes(unpadded + '='), '');

console.log('\n==== Round2 归一化补充: ' + passed + ' 通过, ' + failed + ' 失败 ====');
process.exit(failed > 0 ? 1 : 0);
