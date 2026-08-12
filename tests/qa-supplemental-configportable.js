/**
 * QA 独立补充验证 — config-portable ⑤ (与工程师测试互补, 独立视角)
 * 1. 导出->导入往返: 同密码、凭据字段完整、count 正确
 * 2. 错误密码导入 -> 明确失败且无部分数据 (list 不存在)
 * 3. 篡改 data 一个字节 -> 失败
 * 4. 导出文件 grep 无明文 (host/username/password 原文出现在整个文件 JSON 中)
 * 5. 两次导出 salt/iv 不同 (随机性)
 * 6. 篡改 salt 长度/非 base64 -> 统一错误文案 (不泄露内部细节)
 * 7. 导入后字段注入: 构造含 __proto__/constructor 等危险键 -> 白名单剔除
 * 8. 超长文件 data (超 5MB) -> 文件格式无效 (防 DoS)
 */
const assert = require('assert');
const crypto = require('crypto');
const cp = require('../src/config-portable');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log('  \u2713 ' + name); })
    .catch((err) => { failed++; console.error('  \u2717 ' + name); console.error('    ' + ((err && err.stack) || err)); });
}

function sampleList() {
  return [
    { id: 'c1', name: 'prod', host: '192.168.1.10', port: 22, username: 'root', authMethod: 'password', password: 'S3cr3t!Pw', privateKeyPath: '', passphrase: '', tunnels: [{ localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' }] },
    { id: 'c2', name: 'dev', host: '10.0.0.5', port: 2222, username: 'deploy', authMethod: 'privateKey', password: '', privateKeyPath: 'C:/keys/id_rsa', passphrase: 'kp-999' },
  ];
}

async function run() {
  // 1. 往返完整
  await test('往返: 同密码导入凭据完整 (password/passphrase/privateKeyPath), count=2', () => {
    const exp = cp.exportConfig(sampleList(), 'qa-pw-1');
    assert.strictEqual(exp.ok, true);
    const imp = cp.importConfig(exp.data, 'qa-pw-1');
    assert.strictEqual(imp.ok, true);
    assert.strictEqual(imp.count, 2);
    const [a, b] = imp.list;
    assert.strictEqual(a.password, 'S3cr3t!Pw');
    assert.strictEqual(a.host, '192.168.1.10');
    assert.strictEqual(a.username, 'root');
    assert.strictEqual(a.port, 22);
    assert.strictEqual(b.passphrase, 'kp-999');
    assert.strictEqual(b.privateKeyPath, 'C:/keys/id_rsa');
    assert.deepStrictEqual(a.tunnels[0], { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' });
  });

  // 2. 错误密码
  await test('错误密码: 明确失败 + 无部分数据', () => {
    const exp = cp.exportConfig(sampleList(), 'right');
    const imp = cp.importConfig(exp.data, 'wrong');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
    assert.strictEqual(imp.list, undefined);
    assert.strictEqual(imp.count, undefined);
  });

  // 3. 篡改 data 一个字节
  await test('篡改 data 一个字节 -> 认证失败', () => {
    const exp = cp.exportConfig(sampleList(), 'pw');
    const p = JSON.parse(JSON.stringify(exp.data));
    const buf = Buffer.from(p.data, 'base64');
    buf[buf.length - 1] ^= 0x01; // 翻转最后字节
    p.data = buf.toString('base64');
    const imp = cp.importConfig(p, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
  });

  // 4. 导出文件无明文
  await test('导出文件 JSON 全文不含明文 host/username/password/passphrase', () => {
    const exp = cp.exportConfig(sampleList(), 'pw');
    const json = JSON.stringify(exp.data);
    for (const secret of ['192.168.1.10', '10.0.0.5', 'root', 'deploy', 'S3cr3t!Pw', 'kp-999', 'C:/keys/id_rsa']) {
      assert.ok(!json.includes(secret), '不应出现明文: ' + secret);
    }
    // data 应为合法 base64 密文, 解码后仍不含明文
    const dec = Buffer.from(exp.data.data, 'base64');
    assert.ok(!dec.toString('utf8').includes('S3cr3t!Pw'));
  });

  // 5. 随机性
  await test('两次导出 salt/iv/tag 均不同', () => {
    const e1 = cp.exportConfig(sampleList(), 'pw');
    const e2 = cp.exportConfig(sampleList(), 'pw');
    assert.notStrictEqual(e1.data.salt, e2.data.salt);
    assert.notStrictEqual(e1.data.iv, e2.data.iv);
    assert.notStrictEqual(e1.data.tag, e2.data.tag);
    // salt 解码后 16B, iv 12B, tag 16B
    assert.strictEqual(Buffer.from(e1.data.salt, 'base64').length, 16);
    assert.strictEqual(Buffer.from(e1.data.iv, 'base64').length, 12);
    assert.strictEqual(Buffer.from(e1.data.tag, 'base64').length, 16);
  });

  // 6. 篡改 salt -> 统一错误文案
  await test('篡改 salt -> 统一错误文案 (认证失败)', () => {
    const exp = cp.exportConfig(sampleList(), 'pw');
    const p = JSON.parse(JSON.stringify(exp.data));
    const s = Buffer.from(p.salt, 'base64');
    s[0] ^= 0xff;
    p.salt = s.toString('base64');
    const imp = cp.importConfig(p, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
  });

  await test('salt 长度非 16B / 非 base64 -> 文件格式无效 (无内部细节)', () => {
    const exp = cp.exportConfig(sampleList(), 'pw');
    const p1 = JSON.parse(JSON.stringify(exp.data));
    p1.salt = Buffer.alloc(8).toString('base64');
    assert.strictEqual(cp.importConfig(p1, 'pw').error, '文件格式无效');
    const p2 = JSON.parse(JSON.stringify(exp.data));
    p2.iv = 'short';
    assert.strictEqual(cp.importConfig(p2, 'pw').error, '文件格式无效');
    const p3 = JSON.parse(JSON.stringify(exp.data));
    p3.tag = Buffer.alloc(5).toString('base64');
    assert.strictEqual(cp.importConfig(p3, 'pw').error, '文件格式无效');
  });

  // 7. 危险键注入 (原型污染尝试)
  await test('导入清洗: __proto__/constructor/toString 键被白名单剔除', () => {
    // 手工构造合法加密 payload, 内容含危险键
    const malicious = [
      { id: 'x', host: 'h1', __proto__: { polluted: true }, constructor: 'evil', toString: 'evil', password: 'p' },
    ];
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync('pw', salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(malicious), 'utf8'), cipher.final()]);
    const payload = { v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'), meta: { count: 1 } };
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, true);
    assert.strictEqual(imp.list.length, 1);
    const item = imp.list[0];
    // 关键安全属性: 注入的危险值被剔除 (constructor/toString 不可能是 'evil'),
    // 且无原型污染 (Object.prototype 未被注入 polluted)
    assert.notStrictEqual(item.constructor, 'evil', '注入的 constructor 值应被剔除');
    assert.notStrictEqual(item.toString, 'evil', '注入的 toString 值应被剔除');
    assert.strictEqual(Object.prototype.polluted, undefined, '不应污染 Object.prototype');
    assert.strictEqual(item.host, 'h1');
    assert.strictEqual(item.password, 'p');
  });

  // 8. 超大 data 防 DoS
  await test('超大 data (>5MB) -> 文件格式无效 (防 DoS)', () => {
    const exp = cp.exportConfig(sampleList(), 'pw');
    const p = JSON.parse(JSON.stringify(exp.data));
    p.data = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    const imp = cp.importConfig(p, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '文件格式无效');
  });

  console.log('\nQA 补充验证: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
