/**
 * FgmSSH 连接凭据加密存储模块回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/credential-store-test.js
 * 覆盖:
 *   1. encrypt/decrypt 往返 (明文可复原)
 *   2. encrypt 产物带 enc:v1: 前缀且不含明文子串
 *   3. decryptRecord 对 enc:v1: token 解密、对明文/降级值原样返回
 *   4. migrateIfNeeded 把明文迁移为加密、changed=true; 已加密不动、changed=false; 幂等
 *   5. save/load 全链路 (list 经 encryptRecord 落盘 -> decryptRecord 读回, 凭据复原, 其他字段不变)
 *   6. fail-closed 路径 (isEncryptionAvailable=false 时 encrypt 返回 null、不落明文、仅警告一次)
 *   7. 单条解密失败不抛 (mock decryptString 对特定 token 抛错 -> 该字段置空、整体成功)
 */
const assert = require('assert');

const { createCredentialStore, TOKEN_PREFIX } = require('../src/credential-store');

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

/**
 * 可逆 mock safeStorage (XOR + 固定 key), 实现 isEncryptionAvailable /
 * encryptString / decryptString 往返, 与 Electron safeStorage 接口形状一致。
 * @param {object} opts - { available: boolean, failB64: string[] (解密失败白名单) }
 */
function makeMockSafeStorage(opts) {
  const o = opts || {};
  const KEY = Buffer.from('nimbus-mock-key-2026', 'utf8');
  const failB64 = new Set(o.failB64 || []);
  const xor = (buf) => {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ KEY[i % KEY.length];
    return out;
  };
  return {
    isEncryptionAvailable: () => o.available !== false,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (cipher) => {
      if (failB64.has(cipher.toString('base64'))) {
        throw new Error('mock: cannot decrypt (key rotated / corrupted)');
      }
      return xor(Buffer.from(cipher));
    },
  };
}

async function run() {
  // ---------- 1. encrypt/decrypt 往返 ----------
  await test('encrypt/decrypt 往返: 明文可复原', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const token = store.encrypt('P@ssw0rd!');
    assert.strictEqual(store.decrypt(token), 'P@ssw0rd!');
    // 空串/非字符串原样返回
    assert.strictEqual(store.encrypt(''), '');
    assert.strictEqual(store.decrypt(''), '');
    assert.strictEqual(store.encrypt(undefined), undefined);
    assert.strictEqual(store.decrypt(42), 42);
  });

  // ---------- 2. 产物前缀与不含明文 ----------
  await test('encrypt 产物带 enc:v1: 前缀且不含明文子串', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const secret = 'TopSecret-2026';
    const token = store.encrypt(secret);
    assert.ok(token.startsWith(TOKEN_PREFIX), '应带 enc:v1: 前缀');
    assert.ok(!token.includes(secret), '产物不应包含明文子串');
    assert.ok(token.length > TOKEN_PREFIX.length, '应包含 base64 密文');
  });

  // ---------- 3. decryptRecord 对 token/明文/降级值 ----------
  await test('decryptRecord: enc:v1: token 解密, 明文/降级值原样返回, 原对象不变', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const token = store.encrypt('pw123');
    const conn = {
      id: 'a', host: '10.0.0.1', username: 'root',
      password: token, passphrase: 'plain-pp', privateKeyPath: 'C:/keys/id_rsa',
    };
    const out = store.decryptRecord(conn);
    assert.strictEqual(out.password, 'pw123', 'token 应解密为明文');
    assert.strictEqual(out.passphrase, 'plain-pp', '非前缀明文值应原样返回');
    assert.strictEqual(out.host, '10.0.0.1');
    assert.strictEqual(out.privateKeyPath, 'C:/keys/id_rsa', 'privateKey 路径不处理');
    assert.notStrictEqual(out, conn, '应浅拷贝, 不修改原对象');
    assert.strictEqual(conn.password, token, '原对象 password 保持 token');
  });

  // ---------- 4. migrateIfNeeded ----------
  await test('migrateIfNeeded: 明文迁移为加密 changed=true; 已加密不动; 幂等', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const list = [
      { id: 1, password: 'plain-pw', passphrase: '' },
      { id: 2, password: '', passphrase: 'plain-pp' },
      { id: 3, password: 'enc:v1:already-encrypted', passphrase: '' }, // 已加密 (不做真实性校验)
      { id: 4, password: '', passphrase: '' }, // 无凭据, 不动
    ];
    const r1 = store.migrateIfNeeded(list);
    assert.strictEqual(r1.changed, true, '存在明文凭据应标记 changed');
    assert.ok(r1.list[0].password.startsWith('enc:v1:'), '明文 password 应被加密');
    assert.ok(r1.list[1].passphrase.startsWith('enc:v1:'), '明文 passphrase 应被加密');
    assert.strictEqual(r1.list[2].password, 'enc:v1:already-encrypted', '已加密不动');
    assert.strictEqual(r1.list[3].password, '', '无凭据不动');
    assert.strictEqual(r1.list[0].host, undefined, '其他字段透传');
    // 幂等: 第二次 changed=false
    const r2 = store.migrateIfNeeded(r1.list);
    assert.strictEqual(r2.changed, false, '第二次迁移 changed 应为 false');
    assert.deepStrictEqual(r2.list, r1.list, '第二次迁移结果应与第一次一致');
    // 原列表不被修改
    assert.strictEqual(list[0].password, 'plain-pw');
  });

  // ---------- 5. save/load 全链路 ----------
  await test('save/load 全链路: 落盘加密 -> 读回解密, 凭据复原, 其他字段不变', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const original = [
      {
        id: 'a', name: 'dev', host: '10.0.0.1', port: 22, username: 'root',
        authMethod: 'password', password: 'P@ssw0rd!', privateKeyPath: '', passphrase: '',
      },
      {
        id: 'b', name: 'prod', host: '10.0.0.2', port: 2222, username: 'deploy',
        authMethod: 'privateKey', password: '', privateKeyPath: 'C:/keys/id_rsa', passphrase: 'key-pass',
      },
    ];
    // save 路径: 加密 -> 模拟 JSON 落盘
    const onDisk = original.map((c) => store.encryptRecord(c));
    const diskJson = JSON.stringify(onDisk);
    // load 路径: 模拟读盘 -> 解密
    const loaded = JSON.parse(diskJson).map((c) => store.decryptRecord(c));

    assert.strictEqual(loaded[0].password, 'P@ssw0rd!', 'password 应复原');
    assert.strictEqual(loaded[1].passphrase, 'key-pass', 'passphrase 应复原');
    assert.strictEqual(loaded[0].host, '10.0.0.1', 'host 不变');
    assert.strictEqual(loaded[0].port, 22, 'port 不变');
    assert.strictEqual(loaded[0].username, 'root', 'username 不变');
    assert.strictEqual(loaded[0].authMethod, 'password', 'authMethod 不变');
    assert.strictEqual(loaded[1].privateKeyPath, 'C:/keys/id_rsa', 'privateKeyPath 不变');
    // 落盘内容不含明文
    assert.ok(!diskJson.includes('P@ssw0rd!'), '落盘 JSON 不应包含明文 password');
    assert.ok(!diskJson.includes('key-pass'), '落盘 JSON 不应包含明文 passphrase');
  });

  // ---------- 6. fail-closed 路径 ----------
  await test('fail-closed: isEncryptionAvailable=false 时 encrypt 返回 null、不落明文、仅警告一次', () => {
    const logs = [];
    const store = createCredentialStore({
      safeStorage: makeMockSafeStorage({ available: false }),
      log: (m) => logs.push(m),
    });
    // fail-closed: 加密不可用 -> encrypt 返回 null, 绝不返回明文
    assert.strictEqual(store.encrypt('plain-secret'), null);
    assert.strictEqual(store.encrypt('plain-secret'), null, '再次调用仍 null');
    // 已加密 token 幂等返回 (不受可用性影响)
    assert.strictEqual(store.encrypt('enc:v1:abc'), 'enc:v1:abc');
    // migrate 不标记 changed (不回写, 避免每次加载重复改写)
    const r = store.migrateIfNeeded([{ id: 1, password: 'p1', host: 'h' }]);
    assert.strictEqual(r.changed, false, '加密不可用时不应标记 changed');
    assert.strictEqual(r.list[0].password, 'p1', '迁移时不改动明文 (不落盘)');
    // 无法解密 enc:v1: token -> 置空, 不抛
    assert.strictEqual(store.decrypt('enc:v1:AAAA'), '', '无法解密时置空');
    assert.strictEqual(store.decryptRecord({ id: 2, password: 'plain', host: 'h' }).password, 'plain', '明文原样返回');
    // 仅警告一次 (新文案: 拒绝明文凭据落盘)
    const downgradeLogs = logs.filter((m) => m.includes('拒绝明文凭据落盘'));
    assert.ok(downgradeLogs.length >= 1, '应产生 fail-closed 警告');
    assert.ok(downgradeLogs.length <= 1, '警告应只出现一次 (实际 ' + downgradeLogs.length + ')');
  });

  await test('未注入 safeStorage: 不崩溃, encrypt 返回 null (fail-closed)', () => {
    const store = createCredentialStore();
    assert.strictEqual(store.encrypt('x'), null);
    assert.strictEqual(store.decrypt('x'), 'x');
    const r = store.migrateIfNeeded([{ id: 1, password: 'x' }]);
    assert.strictEqual(r.changed, false);
  });

  // ---------- 7. 单条解密失败容错 ----------
  await test('单条解密失败: 该字段置空、其他字段保留、整体不抛', () => {
    const failB64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64');
    const store = createCredentialStore({
      safeStorage: makeMockSafeStorage({ failB64: [failB64] }),
    });
    const good = store.encrypt('good-pw');
    const badRecord = { id: 1, host: 'h1', password: 'enc:v1:' + failB64, passphrase: 'enc:v1:' + failB64 };
    const goodRecord = { id: 2, host: 'h2', password: good };
    const out = [badRecord, goodRecord].map((c) => store.decryptRecord(c));

    assert.strictEqual(out[0].password, '', '失败字段应置空');
    assert.strictEqual(out[0].passphrase, '', '失败字段应置空');
    assert.strictEqual(out[0].host, 'h1', '其他字段保留');
    assert.strictEqual(out[0].id, 1, '其他字段保留');
    assert.strictEqual(out[1].password, 'good-pw', '正常记录仍可解密');
    assert.strictEqual(out[1].host, 'h2');
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
