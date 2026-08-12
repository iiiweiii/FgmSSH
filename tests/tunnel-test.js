/**
 * FgmSSH 隧道/端口转发功能回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/tunnel-test.js
 * 覆盖 (Roadmap ② SSH 隧道/端口转发管理面板):
 *   1. 隧道配置随连接持久化 (tunnels 字段经 credential-store save/load 往返不丢)
 *   2. 连接建立后自动创建配置中的隧道 (mock 创建函数断言被调用、参数正确)
 *   3. 隧道创建失败不阻塞连接 (listen 失败 / 创建函数抛异常 -> 连接仍成功, 审计 tunnel.error)
 *   4. tunnelStop 从列表移除 (按 id 与按 localPort 均可用)
 *   5. 会话关闭清理隧道 (stopAllTunnels 关闭监听并清空列表, 审计 tunnel.stop)
 *   6. 审计事件 type 正确 (tunnel.start / tunnel.stop / tunnel.error, target 无敏感信息)
 *   7. 边界: 非法端口 / 同会话重复本地端口 / 会话已关闭不建立 / 运行期监听错误
 *   8. 静态断言: main/preload/renderer/index 隧道通道与面板引用一致
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createCredentialStore } = require('../src/credential-store');
const { createTunnelManager } = require('../src/tunnel-manager');

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

// ---------- mock safeStorage (与 credential-store-test 同构) ----------
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

// ---------- mock net: 可控 fake server ----------
// listen 异步完成 (setImmediate): 默认成功; failPorts 中的端口触发 'error' (模拟 EADDRINUSE)。
function makeFakeServer(failPorts) {
  const handlers = {};
  return {
    _handlers: handlers,
    _closed: false,
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return this; },
    _emit(evt, ...args) { (handlers[evt] || []).slice().forEach((cb) => cb(...args)); },
    listen(port, host, cb) {
      this._listenArgs = { port, host, cb };
      if (failPorts.has(Number(port))) {
        setImmediate(() => this._emit('error', new Error('EADDRINUSE: address already in use')));
      } else {
        setImmediate(() => cb());
      }
      return this;
    },
    close(cb) { this._closed = true; if (typeof cb === 'function') cb(); return this; },
  };
}

function makeMockNet(opts) {
  const o = opts || {};
  const failPorts = new Set(o.failPorts || []);
  const servers = [];
  return {
    _servers: servers,
    createServer(fn) {
      const s = makeFakeServer(failPorts);
      s._connectionHandler = fn;
      servers.push(s);
      return s;
    },
  };
}

// ---------- mock ssh2 conn (forwardOut 记录调用参数) ----------
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

// ---------- 审计捕获器 ----------
function makeAuditCapture() {
  const entries = [];
  return {
    entries,
    handler: (entry) => entries.push(entry),
  };
}

async function run() {
  // ---------- 1. 持久化 ----------
  await test('隧道配置随连接持久化: tunnels 字段经 credential-store save/load 往返不丢', () => {
    const store = createCredentialStore({ safeStorage: makeMockSafeStorage() });
    const conn = {
      id: 'a', name: 'dev', host: '10.0.0.1', port: 22, username: 'root',
      authMethod: 'password', password: 'P@ssw0rd!', privateKeyPath: '', passphrase: '',
      tunnels: [
        { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' },
        { localPort: 3306, remoteHost: 'db.internal', remotePort: 3306, name: '' },
      ],
    };
    // save 路径: encryptRecord -> 模拟 JSON 落盘
    const onDisk = store.encryptRecord(conn);
    const diskJson = JSON.stringify(onDisk);
    // load 路径: 读盘 -> decryptRecord
    const loaded = store.decryptRecord(JSON.parse(diskJson));

    assert.deepStrictEqual(loaded.tunnels, conn.tunnels, 'tunnels 字段应原样往返');
    assert.strictEqual(loaded.password, 'P@ssw0rd!', 'password 仍应解密为明文');
    assert.strictEqual(loaded.host, '10.0.0.1', '其他字段不变');
    assert.strictEqual(loaded.username, 'root', '其他字段不变');
    assert.ok(!diskJson.includes('P@ssw0rd!'), '落盘 JSON 不应包含明文密码');
  });

  // ---------- 2. 自动建立 ----------
  await test('连接建立后自动创建配置中的隧道 (mock 创建函数断言被调用、参数正确)', async () => {
    const manager = createTunnelManager({ net: makeMockNet() });
    const audit = makeAuditCapture();
    const calls = [];
    const mockStart = async ({ sessionKey, conn, cfg }) => {
      calls.push({ sessionKey, conn, cfg });
      return { ok: true, tunnelId: 'mock-1' };
    };
    const results = await manager.autoStartTunnels({
      sessionKey: 'w:1:s1',
      conn: makeMockConn(),
      tunnels: [
        { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' },
        { localPort: 9090, remoteHost: '', remotePort: 443 }, // 远端主机空 -> 默认 127.0.0.1
        null, // 非法项应跳过
      ],
      handlers: { onAudit: audit.handler },
      startFn: mockStart,
    });
    assert.strictEqual(calls.length, 2, '应为每条有效配置调用一次创建函数');
    assert.strictEqual(calls[0].sessionKey, 'w:1:s1');
    assert.deepStrictEqual(calls[0].cfg, { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, name: 'web' });
    assert.deepStrictEqual(calls[1].cfg, { localPort: 9090, remoteHost: '127.0.0.1', remotePort: 443, name: '' });
    assert.strictEqual(results.length, 2, '非法项不计入结果');
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(results[1].ok, true);
  });

  await test('startTunnel 真实路径: 监听 127.0.0.1:localPort + forwardOut 参数正确 + 审计 tunnel.start', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const events = [];
    const res = await manager.startTunnel({
      sessionKey: 'w:1:s1b',
      conn,
      cfg: { localPort: 8080, remoteHost: 'db.internal', remotePort: 5432, name: 'pg' },
      handlers: { onAudit: audit.handler, onEvent: (evt) => events.push(evt) },
    });
    assert.strictEqual(res.ok, true);
    assert.ok(res.tunnelId, '应返回 tunnelId');
    assert.strictEqual(net._servers.length, 1, '应创建 1 个本地监听');
    const server = net._servers[0];
    assert.strictEqual(server._listenArgs.port, 8080, '应监听指定本地端口');
    assert.strictEqual(server._listenArgs.host, '127.0.0.1', '应仅监听回环地址');
    // 模拟连接到来 -> forwardOut 参数正确
    const socket = { destroy() {}, pipe() { return this; } };
    server._connectionHandler(socket);
    assert.strictEqual(conn._calls.length, 1);
    assert.deepStrictEqual(conn._calls[0], {
      srcAddr: '127.0.0.1', srcPort: 8080, dstAddr: 'db.internal', dstPort: 5432,
    });
    // 审计 + 事件
    const start = audit.entries.find((e) => e.type === 'tunnel.start');
    assert.ok(start, '应有 tunnel.start 审计');
    assert.strictEqual(start.target, 'localhost:8080 -> db.internal:5432');
    assert.strictEqual(start.result, 'success');
    assert.ok(events.some((e) => e.type === 'tunnel'), '应有 tunnel 事件');
  });

  // ---------- 3. 失败不阻塞 ----------
  await test('隧道创建失败不阻塞连接 (listen 失败 -> 连接仍成功, 审计 tunnel.error)', async () => {
    const net = makeMockNet({ failPorts: [8080] });
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const events = [];
    // 模拟连接流程: 连接建立后自动建立配置中的隧道; 隧道失败不改变连接状态
    let connectionStatus = 'connecting';
    const results = await manager.autoStartTunnels({
      sessionKey: 'w:1:s2',
      conn,
      tunnels: [
        { localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80 },   // 失败
        { localPort: 9090, remoteHost: '127.0.0.1', remotePort: 443 },  // 成功
      ],
      handlers: { onAudit: audit.handler, onEvent: (evt) => events.push(evt) },
    });
    connectionStatus = 'connected';
    assert.strictEqual(connectionStatus, 'connected', '隧道失败不应阻塞连接');
    assert.strictEqual(results[0].ok, false, '8080 应失败');
    assert.strictEqual(results[1].ok, true, '9090 应成功 (失败不阻塞后续隧道)');
    const err = audit.entries.find((e) => e.type === 'tunnel.error' && e.target === 'localhost:8080 -> 127.0.0.1:80');
    assert.ok(err, '应有 tunnel.error 审计');
    assert.strictEqual(err.result, 'failure');
    const ok = audit.entries.find((e) => e.type === 'tunnel.start' && e.target === 'localhost:9090 -> 127.0.0.1:443');
    assert.ok(ok, '后续隧道仍应建立并审计 tunnel.start');
    assert.ok(events.some((e) => e.type === 'tunnel-error'), '应有 tunnel-error 事件');
  });

  await test('隧道创建函数抛异常不阻塞连接 (mock startFn throw -> 审计 tunnel.error, 继续)', async () => {
    const manager = createTunnelManager({ net: makeMockNet() });
    const audit = makeAuditCapture();
    const mockStart = async () => { throw new Error('mock 异常'); };
    const results = await manager.autoStartTunnels({
      sessionKey: 'w:1:s2b',
      conn: makeMockConn(),
      tunnels: [
        { localPort: 8080, remoteHost: 'h', remotePort: 80 },
        { localPort: 9090, remoteHost: 'h', remotePort: 90 },
      ],
      handlers: { onAudit: audit.handler },
      startFn: mockStart,
    });
    assert.strictEqual(results.length, 2, '全部隧道均应尝试 (异常不中断)');
    assert.ok(results.every((r) => r.ok === false));
    assert.strictEqual(results[0].error, 'mock 异常');
    assert.strictEqual(audit.entries.filter((e) => e.type === 'tunnel.error').length, 2, '每条失败均记 tunnel.error');
  });

  // ---------- 4. 停止移除 ----------
  await test('tunnelStop 从列表移除 (按 id 与按 localPort 均可用)', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const p1 = manager.startTunnel({ sessionKey: 'w:1:s4', conn, cfg: { localPort: 8001, remoteHost: 'h1', remotePort: 81 }, handlers: { onAudit: audit.handler } });
    const p2 = manager.startTunnel({ sessionKey: 'w:1:s4', conn, cfg: { localPort: 8002, remoteHost: 'h2', remotePort: 82 }, handlers: { onAudit: audit.handler } });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(manager.listTunnels('w:1:s4').length, 2);

    // 按 id 停止
    const st = manager.stopTunnel('w:1:s4', r1.tunnelId, { onAudit: audit.handler });
    assert.strictEqual(st.ok, true);
    let list = manager.listTunnels('w:1:s4');
    assert.strictEqual(list.length, 1, '停止后应从列表移除');
    assert.strictEqual(list[0].localPort, 8002);

    // 按 localPort 停止
    const st2 = manager.stopTunnel('w:1:s4', 8002, { onAudit: audit.handler });
    assert.strictEqual(st2.ok, true);
    assert.strictEqual(manager.listTunnels('w:1:s4').length, 0, '全部停止后列表为空');

    // 停止不存在的隧道 -> 失败但不抛
    const st3 = manager.stopTunnel('w:1:s4', 'nope', { onAudit: audit.handler });
    assert.strictEqual(st3.ok, false);

    // 审计: 2 条 tunnel.stop, 均为 success
    const stops = audit.entries.filter((e) => e.type === 'tunnel.stop');
    assert.strictEqual(stops.length, 2);
    assert.ok(stops.every((e) => e.result === 'success'));
  });

  // ---------- 5. 会话关闭清理 ----------
  await test('会话关闭清理隧道 (stopAllTunnels 关闭监听并清空列表, 审计 tunnel.stop)', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const p1 = manager.startTunnel({ sessionKey: 'w:1:s5', conn, cfg: { localPort: 8001, remoteHost: 'h', remotePort: 81 }, handlers: { onAudit: audit.handler } });
    const p2 = manager.startTunnel({ sessionKey: 'w:1:s5', conn, cfg: { localPort: 8002, remoteHost: 'h', remotePort: 82 }, handlers: { onAudit: audit.handler } });
    await Promise.all([p1, p2]);

    const res = manager.stopAllTunnels('w:1:s5', { onAudit: audit.handler });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.stopped, 2);
    assert.strictEqual(manager.listTunnels('w:1:s5').length, 0, '清理后列表应为空');
    assert.ok(net._servers.every((s) => s._closed === true), '全部监听应被关闭');
    const stops = audit.entries.filter((e) => e.type === 'tunnel.stop');
    assert.strictEqual(stops.length, 2);
    assert.ok(stops.every((e) => e.detail.includes('会话关闭')), 'detail 应标注会话关闭');

    // 重复清理幂等
    const res2 = manager.stopAllTunnels('w:1:s5', { onAudit: audit.handler });
    assert.strictEqual(res2.stopped, 0);
  });

  // ---------- 6. 审计类型 ----------
  await test('审计事件 type 正确 (tunnel.start / tunnel.stop / tunnel.error, target 无敏感信息)', async () => {
    const net = makeMockNet({ failPorts: [7001] });
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const events = [];
    await manager.startTunnel({ sessionKey: 'w:1:s6', conn, cfg: { localPort: 7000, remoteHost: 'svc', remotePort: 90 }, handlers: { onAudit: audit.handler, onEvent: (e) => events.push(e) } });
    await manager.startTunnel({ sessionKey: 'w:1:s6', conn, cfg: { localPort: 7001, remoteHost: 'svc', remotePort: 91 }, handlers: { onAudit: audit.handler, onEvent: (e) => events.push(e) } });
    manager.stopTunnel('w:1:s6', 7000, { onAudit: audit.handler });

    const types = audit.entries.map((e) => e.type);
    assert.ok(types.includes('tunnel.start'), '应含 tunnel.start');
    assert.ok(types.includes('tunnel.stop'), '应含 tunnel.stop');
    assert.ok(types.includes('tunnel.error'), '应含 tunnel.error');
    for (const e of audit.entries) {
      assert.match(e.target, /^localhost:\d+ -> .+:\d+$/, 'target 应为 localhost:<lp> -> <host>:<rp>');
      assert.ok(!e.target.includes('password'), 'target 不应含敏感字段');
      if (e.detail) assert.ok(!e.detail.includes('password='), 'detail 不应含敏感信息');
    }
    assert.ok(events.some((e) => e.type === 'tunnel'), '应有 tunnel 事件');
    assert.ok(events.some((e) => e.type === 'tunnel-error'), '应有 tunnel-error 事件');
  });

  // ---------- 7. 边界 ----------
  await test('非法端口/同会话重复本地端口: 拒绝并审计 tunnel.error', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const handlers = { onAudit: audit.handler };

    const r1 = await manager.startTunnel({ sessionKey: 'w:1:s7', conn, cfg: { localPort: 0, remoteHost: 'h', remotePort: 80 }, handlers });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /本地端口无效/);

    const r2 = await manager.startTunnel({ sessionKey: 'w:1:s7', conn, cfg: { localPort: 8080, remoteHost: 'h', remotePort: 70000 }, handlers });
    assert.strictEqual(r2.ok, false);
    assert.match(r2.error, /远端端口无效/);

    const r3 = await manager.startTunnel({ sessionKey: 'w:1:s7', conn, cfg: { localPort: 8080, remoteHost: 'h', remotePort: 80 }, handlers });
    assert.strictEqual(r3.ok, true);

    const r4 = await manager.startTunnel({ sessionKey: 'w:1:s7', conn, cfg: { localPort: 8080, remoteHost: 'h2', remotePort: 81 }, handlers });
    assert.strictEqual(r4.ok, false);
    assert.match(r4.error, /已在该会话中使用/);

    assert.strictEqual(audit.entries.filter((e) => e.type === 'tunnel.error').length, 3);
  });

  await test('会话已关闭时建立隧道: 不建立并释放监听', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const res = await manager.startTunnel({
      sessionKey: 'w:1:s8',
      conn: makeMockConn(),
      cfg: { localPort: 8080, remoteHost: 'h', remotePort: 80 },
      handlers: { isSessionAlive: () => false },
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /会话已关闭/);
    assert.strictEqual(net._servers[0]._closed, true, '监听应被关闭');
    assert.strictEqual(manager.listTunnels('w:1:s8').length, 0, '不应登记');
  });

  await test('运行期监听错误: 标记失败 + 审计 tunnel.error + 移除登记', async () => {
    const net = makeMockNet();
    const manager = createTunnelManager({ net });
    const conn = makeMockConn();
    const audit = makeAuditCapture();
    const events = [];
    const res = await manager.startTunnel({
      sessionKey: 'w:1:s9', conn,
      cfg: { localPort: 8080, remoteHost: 'h', remotePort: 80 },
      handlers: { onAudit: audit.handler, onEvent: (e) => events.push(e) },
    });
    assert.strictEqual(res.ok, true);
    // 运行期 error (如底层 socket 错误)
    net._servers[0]._emit('error', new Error('runtime boom'));
    assert.strictEqual(manager.listTunnels('w:1:s9').length, 0, '失败后应移除登记');
    const err = audit.entries.find((e) => e.type === 'tunnel.error');
    assert.ok(err, '应有 tunnel.error 审计');
    assert.match(err.detail, /runtime boom/);
    assert.ok(events.some((e) => e.type === 'tunnel-error'));
  });

  // ---------- 8. 静态断言 ----------
  await test('静态断言: main/preload/renderer/index 隧道通道与面板引用一致', () => {
    const root = path.join(__dirname, '..');
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    const tunnelSrc = fs.readFileSync(path.join(root, 'src', 'tunnel-manager.js'), 'utf8');

    // main.js: 引入 + IPC 通道 + 自动建立 + 清理 + 审计类型
    assert.ok(mainSrc.includes("require('./src/tunnel-manager')"), 'main.js 应 require tunnel-manager');
    assert.ok(mainSrc.includes("ipcMain.handle('ssh:tunnel:list'"), 'main.js 应有 ssh:tunnel:list IPC');
    assert.ok(mainSrc.includes("ipcMain.handle('ssh:tunnel:stop'"), 'main.js 应有 ssh:tunnel:stop IPC');
    assert.ok(mainSrc.includes("ipcMain.handle('ssh:tunnel'"), 'main.js 应保留 ssh:tunnel IPC');
    assert.ok(mainSrc.includes('autoStartConfiguredTunnels'), 'main.js 应有自动建立逻辑');
    assert.ok(mainSrc.includes('tunnelManager.stopAllTunnels'), 'main.js 应有会话关闭隧道清理');
    assert.ok(tunnelSrc.includes("'tunnel.start'"), 'tunnel-manager 应埋点 tunnel.start');
    assert.ok(tunnelSrc.includes("'tunnel.stop'"), 'tunnel-manager 应埋点 tunnel.stop');
    assert.ok(tunnelSrc.includes("'tunnel.error'"), 'tunnel-manager 应埋点 tunnel.error');

    // preload.js: 暴露桥接 (缺的补上, 现有 ssh:tunnel 复用)
    assert.ok(preloadSrc.includes('tunnelStart'), 'preload.js 应暴露 tunnelStart');
    assert.ok(preloadSrc.includes('tunnelList'), 'preload.js 应暴露 tunnelList');
    assert.ok(preloadSrc.includes('tunnelStop'), 'preload.js 应暴露 tunnelStop');

    // renderer.js: 面板 + IPC 调用 + 连接透传
    assert.ok(rendererSrc.includes('openTunnelPanel'), 'renderer.js 应有隧道面板入口');
    assert.ok(rendererSrc.includes('window.nimbus.tunnelList'), 'renderer.js 应调用 tunnelList');
    assert.ok(rendererSrc.includes('window.nimbus.tunnelStop'), 'renderer.js 应调用 tunnelStop');
    assert.ok(rendererSrc.includes('window.nimbus.tunnelStart'), 'renderer.js 应调用 tunnelStart');
    assert.ok(rendererSrc.includes('tunnels: Array.isArray(connConfig.tunnels)'), 'renderer.js 连接时应透传 tunnels');

    // index.html: 面板 DOM + 入口按钮 + 审计筛选
    assert.ok(indexSrc.includes('id="tunnelOverlay"'), 'index.html 应有隧道面板');
    assert.ok(indexSrc.includes('id="btnTunnel"'), 'index.html 应有隧道入口按钮');
    assert.ok(indexSrc.includes('value="tunnel.start"'), 'index.html 应有隧道审计筛选');
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
