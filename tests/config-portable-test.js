/**
 * NimbusSSH 配置加密导出/导入模块回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/config-portable-test.js
 * 覆盖:
 *   1. exportConfig 成功: 返回 v1 负载 (v/kdf/salt/iv/tag/data/meta), 无明文 JSON 泄露
 *   2. export -> import 往返: 明文凭据复原, 字段白名单清洗 (未知字段剔除), count 正确
 *   3. 错误密码 / 篡改密文 / 篡改 tag -> '密码错误或文件已损坏' (GCM 认证失败)
 *   4. 空密码拒绝; 版本不兼容拒绝; 格式非法拒绝; 非数组解密拒绝
 *   5. tunnels 子项白名单清洗
 *   6. 导出文件不含明文 (data 字段整体 base64 密文, 不含 host/密码明文)
 */
const assert = require('assert');

const cp = require('../src/config-portable');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  \u2713 ' + name); })
    .catch((err) => {
      failed++;
      console.error('  \u2717 ' + name);
      console.error('    ' + ((err && err.stack) || err));
    });
}

// 测试用连接列表 (模拟 loadConnections 解密后的明文)
function sampleList() {
  return [
    {
      id: 'c_abc123', name: '生产服务器', host: '192.168.1.10', port: 22, username: 'root',
      authMethod: 'password', password: 'P@ssw0rd!', privateKeyPath: '', passphrase: '',
      extraUnknown: 'should-be-dropped', internal: { x: 1 },
      tunnels: [
        { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web', junk: 'drop' },
        { localPort: 3306, remoteHost: 'db.internal', remotePort: 3306, name: 'mysql' },
      ],
    },
    {
      id: 'c_def456', name: 'dev', host: '10.0.0.5', port: 2222, username: 'deploy',
      authMethod: 'privateKey', password: '', privateKeyPath: 'C:/keys/id_rsa', passphrase: 'key-pass',
    },
  ];
}

async function run() {
  // ---------- 1. exportConfig 成功 ----------
  await test('exportConfig: 返回 v1 加密负载, 含 meta.count, 不含明文', () => {
    const res = cp.exportConfig(sampleList(), 'correct horse battery');
    assert.strictEqual(res.ok, true);
    const d = res.data;
    assert.strictEqual(d.v, 1);
    assert.strictEqual(d.kdf, 'scrypt');
    assert.ok(typeof d.salt === 'string' && d.salt.length > 0, 'salt 应为 base64');
    assert.ok(typeof d.iv === 'string' && d.iv.length > 0, 'iv 应为 base64');
    assert.ok(typeof d.tag === 'string' && d.tag.length > 0, 'tag 应为 base64');
    assert.ok(typeof d.data === 'string' && d.data.length > 0, 'data 应为 base64 密文');
    assert.strictEqual(d.meta.count, 2, 'count 应等于清洗后条数');
    assert.ok(typeof d.meta.exportedAt === 'string', 'exportedAt 应为 ISO 时间');
    const json = JSON.stringify(d);
    assert.ok(!json.includes('P@ssw0rd!'), '导出负载不应含明文密码');
    assert.ok(!json.includes('key-pass'), '导出负载不应含明文 passphrase');
    assert.ok(!json.includes('192.168.1.10'), '导出负载不应含明文 host (整文件加密)');
  });

  // ---------- 2. 往返 + 白名单清洗 ----------
  await test('export -> import 往返: 凭据复原, 未知字段剔除, tunnels 白名单清洗', () => {
    const res = cp.exportConfig(sampleList(), 'pw-123');
    assert.strictEqual(res.ok, true);
    const imp = cp.importConfig(res.data, 'pw-123');
    assert.strictEqual(imp.ok, true);
    assert.strictEqual(imp.count, 2);
    const list = imp.list;
    assert.strictEqual(list[0].host, '192.168.1.10');
    assert.strictEqual(list[0].password, 'P@ssw0rd!', '密码应复原');
    assert.strictEqual(list[0].authMethod, 'password');
    assert.strictEqual(list[0].extraUnknown, undefined, '未知字段应剔除');
    assert.strictEqual(list[0].internal, undefined, '未知字段应剔除');
    assert.strictEqual(list[0].tunnels.length, 2, 'tunnels 保留');
    assert.deepStrictEqual(list[0].tunnels[0], { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' }, 'tunnels 子项未知字段剔除');
    assert.strictEqual(list[1].passphrase, 'key-pass', 'passphrase 应复原');
    assert.strictEqual(list[1].privateKeyPath, 'C:/keys/id_rsa');
  });

  // ---------- 3. GCM 认证失败 ----------
  await test('错误密码 -> 密码错误或文件已损坏', () => {
    const res = cp.exportConfig(sampleList(), 'right-pw');
    const imp = cp.importConfig(res.data, 'wrong-pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
    assert.strictEqual(imp.list, undefined, '失败时不应返回任何内容');
  });

  await test('篡改密文 data -> 密码错误或文件已损坏', () => {
    const res = cp.exportConfig(sampleList(), 'pw');
    const payload = JSON.parse(JSON.stringify(res.data));
    const buf = Buffer.from(payload.data, 'base64');
    buf[0] ^= 0xff; // 翻转密文首字节
    payload.data = buf.toString('base64');
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
  });

  await test('篡改认证标签 tag -> 密码错误或文件已损坏', () => {
    const res = cp.exportConfig(sampleList(), 'pw');
    const payload = JSON.parse(JSON.stringify(res.data));
    const tag = Buffer.from(payload.tag, 'base64');
    tag[0] ^= 0x01;
    payload.tag = tag.toString('base64');
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
  });

  await test('篡改 iv -> 认证失败 (不泄露内容)', () => {
    const res = cp.exportConfig(sampleList(), 'pw');
    const payload = JSON.parse(JSON.stringify(res.data));
    const iv = Buffer.from(payload.iv, 'base64');
    iv[0] ^= 0x01;
    payload.iv = iv.toString('base64');
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码错误或文件已损坏');
  });

  // ---------- 4. 边界: 空密码 / 版本 / 格式 / 非数组 ----------
  await test('空密码: export/import 均拒绝', () => {
    assert.strictEqual(cp.exportConfig(sampleList(), '').ok, false);
    assert.strictEqual(cp.exportConfig(sampleList(), '  ').ok, false);
    const res = cp.exportConfig(sampleList(), 'pw');
    const imp = cp.importConfig(res.data, '');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '密码不能为空');
  });

  await test('版本不兼容 -> 不支持的备份版本', () => {
    const res = cp.exportConfig(sampleList(), 'pw');
    const payload = JSON.parse(JSON.stringify(res.data));
    payload.v = 99;
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '不支持的备份版本');
  });

  await test('格式非法 (缺失字段/非对象/错误 base64) -> 文件格式无效', () => {
    assert.strictEqual(cp.importConfig(null, 'pw').error, '文件格式无效');
    assert.strictEqual(cp.importConfig([], 'pw').error, '文件格式无效');
    assert.strictEqual(cp.importConfig('not-object', 'pw').error, '文件格式无效');
    const res = cp.exportConfig(sampleList(), 'pw');
    const p1 = JSON.parse(JSON.stringify(res.data));
    delete p1.data;
    assert.strictEqual(cp.importConfig(p1, 'pw').error, '文件格式无效');
    const p2 = JSON.parse(JSON.stringify(res.data));
    p2.salt = '!!!not-base64!!!';
    assert.strictEqual(cp.importConfig(p2, 'pw').ok, false);
  });

  await test('解密出非数组内容 -> 文件内容无效', () => {
    // 构造合法加密但内容为对象的数据: 手动加密一个对象
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync('pw', salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify({ not: 'array' }), 'utf8'), cipher.final()]);
    const payload = {
      v: 1, kdf: 'scrypt',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'),
      meta: { count: 0 },
    };
    const imp = cp.importConfig(payload, 'pw');
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.error, '文件内容无效');
  });

  // ---------- 5. 清洗: 无 host 条目剔除; 非数组 list 导出为空 ----------
  await test('sanitizeList: 非数组 -> 空; 无 host 条目剔除', () => {
    assert.deepStrictEqual(cp.sanitizeList(null), []);
    assert.deepStrictEqual(cp.sanitizeList('x'), []);
    const out = cp.sanitizeList([
      { id: 'a', host: 'h1', password: 'p1' },
      { id: 'b', password: 'no-host' },
      'junk',
      null,
      { id: 'c', host: '   ', username: 'u' },
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].host, 'h1');
  });

  // ---------- 6. 空列表导出 ----------
  await test('空列表导出: count=0, 往返得到空数组', () => {
    const res = cp.exportConfig([], 'pw');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.meta.count, 0);
    const imp = cp.importConfig(res.data, 'pw');
    assert.strictEqual(imp.ok, true);
    assert.deepStrictEqual(imp.list, []);
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
