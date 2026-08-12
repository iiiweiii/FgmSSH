/**
 * QA 补充验证 (独立于 tunnel-test.js, 由 QA Engineer 编写, 只读不改 src/)
 * 覆盖:
 *   1. 隧道自动建立 E2E: mock 连接成功回调 -> 断言 config.tunnels 被逐个创建、参数正确、失败项不阻塞后续
 *   2. 端口占用冲突:
 *      a) 同会话重复本地端口 -> 第二次 start 失败 + audit tunnel.error + 其余隧道不受影响
 *      b) 跨会话 EADDRINUSE (真实 net 模块) -> 第二次 start 失败 + audit tunnel.error + 第一会话隧道不受影响
 *   3. 删除隧道后持久化 list 中 tunnels 字段同步移除 (渲染层 filter + credential-store 往返)
 * 运行: node tests/qa-supplemental-tunnel.js
 */
const assert = require('assert');
const net = require('net');
const { createTunnelManager } = require('../src/tunnel-manager');
const { createCredentialStore } = require('../src/credential-store');

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

function makeMockSafeStorage() {
  const KEY = Buffer.from('nimbus-mock-key-2026', 'utf8');
  const xor = (buf) => {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ KEY[i % KEY.length];
    return out;
  };
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (cipher) => xor(Buffer.from(cipher)),
  };
}

function makeMockConn() {
  const calls = [];
  return {
    _calls: calls,
    forwardOut(srcAddr, srcPort, dstAddr, dstPort, cb) {
      calls.push({ srcAddr, srcPort, dstAddr, dstPort });
      cb(null, { pipe() { return this; } });
    },
  };
}

function makeAuditCapture() {
  const entries = [];
  return { entries, handler: (entry) => entries.push(entry) };
}

// ---------- 模拟 main.js 连接成功回调时序 ----------
// 与 main.js autoStartConfiguredTunnels 同构: conn.on('ready') -> shell -> autoStartTunnels
async function simulateConnectionReady(manager, sessionKey, config, handlers) {
  const conn = makeMockConn();
  // 连接已就绪 (shell ready 之后调用 autoStart)
  const results = await manager.autoStartTunnels({
    sessionKey,
    conn,
    tunnels: config.tunnels || [],
    handlers,
  });
  return { conn, results };
}

async function run() {
  // ============ 1. 自动建立 E2E ============
  await test('补充: 自动建立 E2E — 连接成功回调后逐个创建, 参数正确, 失败项不阻塞后续', async () => {
    const net2 = require('net');
    const manager = createTunnelManager({ net: net2 });
    const audit = makeAuditCapture();
    const config = {
      tunnels: [
        { localPort: 12301, remoteHost: 'db.internal', remotePort: 5432, name: 'pg' },
        { localPort: 12302, remoteHost: '', remotePort: 443 },   // 远端主机空 -> 默认 127.0.0.1
        { localPort: 12303, remoteHost: 'web', remotePort: 8080, name: 'web' },
      ],
    };
    // 模拟连接成功 (shell ready) 后的回调
    const { conn, results } = await simulateConnectionReady(manager, 'w:1:sA', config, {
      onAudit: audit.handler,
      isSessionAlive: () => true,
    });
    assert.strictEqual(results.length, 3, '3 条配置均应被尝试');
    assert.ok(results.every((r) => r.ok === true), '全部建立成功');
    // 真实 net 下端口确实被监听
    const list = manager.listTunnels('w:1:sA');
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(list.map((t) => t.localPort), [12301, 12302, 12303]);
    // 连接对象本身未被破坏 (forwardOut 可调用)
    assert.strictEqual(typeof conn.forwardOut, 'function');
    // 审计: 3 条 tunnel.start, target 无敏感信息
    const starts = audit.entries.filter((e) => e.type === 'tunnel.start');
    assert.strictEqual(starts.length, 3);
    assert.ok(starts.every((e) => /^localhost:\d+ -> .+:\d+$/.test(e.target)));
    // 清理 (释放真实端口)
    manager.stopAllTunnels('w:1:sA', { onAudit: audit.handler });
    assert.strictEqual(manager.listTunnels('w:1:sA').length, 0);
  });

  await test('补充: 自动建立 E2E — 部分失败 (端口被本机占用) 不阻塞其余隧道与连接', async () => {
    const manager = createTunnelManager({ net: require('net') });
    const audit = makeAuditCapture();
    // 预先占用一个端口, 模拟端口冲突
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busyPort = blocker.address().port;

    const config = {
      tunnels: [
        { localPort: busyPort, remoteHost: 'h1', remotePort: 80 },   // 必失败 (本机已占用)
        { localPort: 12311, remoteHost: 'h2', remotePort: 81 },      // 应成功
      ],
    };
    const { results } = await simulateConnectionReady(manager, 'w:1:sB', config, {
      onAudit: audit.handler,
      isSessionAlive: () => true,
    });
    assert.strictEqual(results[0].ok, false, '占用端口应失败');
    assert.strictEqual(results[1].ok, true, '后续隧道应继续建立');
    const err = audit.entries.find((e) => e.type === 'tunnel.error' && e.target.includes(`localhost:${busyPort}`));
    assert.ok(err, '失败项应有 tunnel.error 审计');
    assert.strictEqual(err.result, 'failure');
    // 连接/其余隧道不受影响
    assert.strictEqual(manager.listTunnels('w:1:sB').length, 1);
    manager.stopAllTunnels('w:1:sB');
    await new Promise((r) => blocker.close(r));
  });

  // ============ 2. 端口占用冲突 ============
  await test('补充: 同会话重复本地端口 -> 第二次 start 失败 + audit tunnel.error + 原隧道不受影响', async () => {
    const manager = createTunnelManager({ net: require('net') });
    const audit = makeAuditCapture();
    const conn = makeMockConn();
    const r1 = await manager.startTunnel({
      sessionKey: 'w:1:sC', conn,
      cfg: { localPort: 12321, remoteHost: 'h1', remotePort: 80 },
      handlers: { onAudit: audit.handler, isSessionAlive: () => true },
    });
    assert.strictEqual(r1.ok, true);
    const r2 = await manager.startTunnel({
      sessionKey: 'w:1:sC', conn,
      cfg: { localPort: 12321, remoteHost: 'h2', remotePort: 81 }, // 同会话同端口
      handlers: { onAudit: audit.handler, isSessionAlive: () => true },
    });
    assert.strictEqual(r2.ok, false, '同会话重复端口应失败');
    assert.match(r2.error, /已在该会话中使用/);
    const err = audit.entries.find((e) => e.type === 'tunnel.error' && e.target === 'localhost:12321 -> h2:81');
    assert.ok(err, '应有 tunnel.error 审计');
    // 原隧道不受影响, 仍运行
    const list = manager.listTunnels('w:1:sC');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].remoteHost, 'h1');
    manager.stopAllTunnels('w:1:sC');
  });

  await test('补充: 跨会话 EADDRINUSE (真实 net) -> 第二会话失败 + audit tunnel.error + 第一会话不受影响', async () => {
    const manager = createTunnelManager({ net: require('net') });
    const audit = makeAuditCapture();
    // 会话 1: 先占用端口 12331
    const r1 = await manager.startTunnel({
      sessionKey: 'w:1:sD1', conn: makeMockConn(),
      cfg: { localPort: 12331, remoteHost: 'h1', remotePort: 80 },
      handlers: { onAudit: audit.handler, isSessionAlive: () => true },
    });
    assert.strictEqual(r1.ok, true, '会话1 应建立');
    // 会话 2: 同端口 (跨会话, 绕过同会话重复检查, 由真实 net 报 EADDRINUSE)
    const r2 = await manager.startTunnel({
      sessionKey: 'w:2:sD2', conn: makeMockConn(),
      cfg: { localPort: 12331, remoteHost: 'h2', remotePort: 81 },
      handlers: { onAudit: audit.handler, isSessionAlive: () => true },
    });
    assert.strictEqual(r2.ok, false, '跨会话端口冲突应失败');
    assert.match(r2.error, /EADDRINUSE|already in use/i);
    const err = audit.entries.find((e) => e.type === 'tunnel.error' && e.target === 'localhost:12331 -> h2:81');
    assert.ok(err, '应有 tunnel.error 审计');
    // 第一会话隧道不受影响
    const list1 = manager.listTunnels('w:1:sD1');
    assert.strictEqual(list1.length, 1);
    assert.strictEqual(list1[0].status, 'running');
    // 第二会话注册表无残留
    assert.strictEqual(manager.listTunnels('w:2:sD2').length, 0);
    manager.stopAllTunnels('w:1:sD1');
    manager.stopAllTunnels('w:2:sD2');
  });

  // ============ 3. 删除隧道持久化同步 ============
  await test('补充: 删除隧道后持久化 list 中 tunnels 字段同步移除 (渲染层 filter + credential-store 往返)', async () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const conn = {
      id: 'c1', name: 'dev', host: '10.0.0.1', port: 22, username: 'root',
      authMethod: 'password', password: 'S3cret!', privateKeyPath: '', passphrase: '',
      tunnels: [
        { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' },
        { localPort: 3306, remoteHost: 'db.internal', remotePort: 3306, name: '' },
      ],
    };
    // 渲染层 deleteTunnelItem 逻辑: filter 掉指定 localPort
    conn.tunnels = conn.tunnels.filter((t) => Number(t.localPort) !== Number(8080));
    // 持久化: encryptRecord -> 落盘 JSON -> decryptRecord (load)
    const onDisk = JSON.stringify(store.encryptRecord(conn));
    assert.ok(!onDisk.includes('S3cret!'), '落盘不应含明文密码');
    const loaded = store.decryptRecord(JSON.parse(onDisk));
    assert.deepStrictEqual(loaded.tunnels, [
      { localPort: 3306, remoteHost: 'db.internal', remotePort: 3306, name: '' },
    ], '删除后 tunnels 应仅剩 3306');
    assert.strictEqual(loaded.password, 'S3cret!', '密码仍可解密');
    // 再删最后一条 -> tunnels 数组为空 (或 undefined 前保持空数组)
    loaded.tunnels = loaded.tunnels.filter((t) => Number(t.localPort) !== Number(3306));
    const disk2 = JSON.stringify(store.encryptRecord(loaded));
    const loaded2 = store.decryptRecord(JSON.parse(disk2));
    assert.deepStrictEqual(loaded2.tunnels, [], '全部删除后 tunnels 应为空数组');
    assert.strictEqual(loaded2.password, 'S3cret!');
  });

  await test('补充: 持久化往返保留 name 空串与远端默认值, 不引入多余字段', async () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const conn = {
      id: 'c2', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'x',
      tunnels: [{ localPort: 9000, remoteHost: '', remotePort: 90, name: '' }],
    };
    const loaded = store.decryptRecord(JSON.parse(JSON.stringify(store.encryptRecord(conn))));
    assert.deepStrictEqual(loaded.tunnels, [{ localPort: 9000, remoteHost: '', remotePort: 90, name: '' }]);
    assert.deepStrictEqual(Object.keys(loaded.tunnels[0]).sort(), ['localPort', 'name', 'remoteHost', 'remotePort']);
  });

  console.log('\n补充验证结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('补充验证执行异常:', err);
  process.exit(1);
});
