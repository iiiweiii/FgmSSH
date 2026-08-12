#!/usr/bin/env node
/**
 * FgmSSH - 主机密钥指纹校验 (hostVerifier) 集成测试 (node 直跑, 无 Electron)
 * 运行: node tests/hostkey-verifier-test.js
 *
 * 方法: 用 vm 沙箱加载真实 main.js (mock electron/ssh2/audit-log, 其余本地纯 node 模块
 * 走真实 require), 末尾注入导出 __nimbusTest 提取 buildConnConfig / handleHostKeyVerification /
 * createSSHSession / sessions / KNOWN_HOSTS_FILE 等真实函数, 验证:
 *   1. buildConnConfig 默认注入 hostVerifier; hostKeyVerify=false 时完全跳过
 *   2. trusted 指纹 -> 直接 callback(true), 无弹窗事件 (初始连接与重连共用路径)
 *   3. unknown 首次连接 -> 发 hostkey:confirm 事件 (含 SHA256/MD5/算法);
 *      用户 accept -> trustHostKey 落库 + callback(true) + 审计 hostkey.accept;
 *      二次连接同指纹 -> trusted 放行 (无弹窗)
 *   4. unknown -> reject -> callback(false) + 审计 hostkey.reject
 *   5. 并发校验去重: 弹窗等待期间再来一次校验 -> 不重复发事件, 回调入队;
 *      accept 后队列全部放行
 *   6. mismatch -> 发 hostkey:mismatch 危险警告 (含 storedSha256);
 *      必须 override=true 才可覆盖 (否则拒绝); override -> 更新库 + 放行 + 审计 hostkey.override
 *   7. mismatch -> reject -> callback(false) + 审计 hostkey.reject
 *   8. 60s 超时无响应 -> 默认拒绝 callback(false) (防挂起)
 *   9. 审计类型齐全: hostkey.accept / hostkey.reject / hostkey.override / hostkey.mismatch
 *   10. 静态断言: main.js hostVerifier 集成 / IPC / 事件通道; preload 桥接; renderer 弹窗
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const CWD = path.join(__dirname, '..');
const store = require('../src/hostkey-store');

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

// mock-ssh-server 的 ed25519 公钥 blob (与 hostkey-store-test 同源)
const FIXTURE_BUF = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIF82X3M7p/KqIf2PMW7y/wqHi1QOH7zdki35eUUuz1+M', 'base64');
const FIXTURE_SHA = store.computeFingerprint(FIXTURE_BUF).sha256;
const OTHER_BUF = Buffer.from('another-key-blob-xyz', 'utf8');
const OTHER_SHA = store.computeFingerprint(OTHER_BUF).sha256;

// 可控定时器: 记录 setTimeout/clearTimeout, 测试手动触发 (不真实等待 60s)
function makeFakeTimers() {
  const timers = [];
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeoutFn: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    _timers: timers,
    _pending() { return timers.filter((t) => !t.cleared); },
    _fireNext() {
      const t = this._pending()[0];
      if (!t) return null;
      t.cleared = true;
      t.fn();
      return t.ms;
    },
    _clearAll() { for (const t of timers) t.cleared = true; },
  };
}

// 最小 ssh2 Client mock (connectClient/reconnectAttempt 只用到 on/connect/end/shell)
class MockClient {
  constructor() {
    this._handlers = {};
    this._cfg = null;
  }
  on(evt, fn) { this._handlers[evt] = fn; return this; }
  connect(cfg) { this._cfg = cfg; }
  end() {}
  shell(args, cb) { if (typeof cb === 'function') cb(new Error('mock-no-shell')); }
  exec(cmd, cb) { if (typeof cb === 'function') cb(new Error('mock-no-exec')); }
}

// 加载真实 main.js 到 vm 沙箱; 每个沙箱独立 userData 目录 (known_hosts.json 互不污染)
function createSandbox() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-hkv-'));
  const knownHostsFile = path.join(userDataDir, 'known_hosts.json');
  const sent = { 'hostkey:confirm': [], 'hostkey:mismatch': [] };
  const ipcHandlers = {};
  const windows = new Map();
  const auditEntries = [];
  const timers = makeFakeTimers();

  const mockElectron = {
    app: {
      getPath: (name) => (name === 'userData' ? userDataDir : (name === 'temp' ? os.tmpdir() : '')),
      getVersion: () => '1.0.0',
      disableHardwareAcceleration: () => {},
      commandLine: { appendSwitch: () => {} },
      whenReady: () => new Promise(() => {}), // 永不 resolve: 不触发 ready 副作用
      on: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
    },
    BrowserWindow: {
      fromId: (id) => windows.get(Number(id)) || null,
      getAllWindows: () => [],
    },
    ipcMain: { handle: (channel, fn) => { ipcHandlers[channel] = fn; } },
    dialog: {},
    shell: {},
    protocol: { registerSchemesAsPrivileged: () => {} },
    net: {},
    safeStorage: {},
    Tray: function () {},
    Menu: {},
  };

  const mockRequire = (id) => {
    if (id === 'electron') return mockElectron;
    if (id === 'ssh2') return { Client: MockClient };
    if (id === './src/audit-log') {
      // 审计 stub: 记录条目, 不落盘 (避免污染真实日志目录)
      return {
        logAudit: (e) => auditEntries.push(e),
        initAuditLog: () => ({ dir: path.join(userDataDir, 'logs') }),
        queryAudit: async () => ({ total: 0, items: [] }),
        flush: async () => {},
        _resetForTest: () => {},
      };
    }
    if (id.startsWith('./') || id.startsWith('../')) {
      return require(path.resolve(CWD, id));
    }
    return require(id);
  };

  const sandbox = {
    require: mockRequire,
    module: { exports: {} },
    exports: {},
    __dirname: CWD,
    __filename: path.join(CWD, 'main.js'),
    console,
    process,
    Buffer,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
  };
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.join(CWD, 'main.js'), 'utf8') +
    '\n;globalThis.__nimbusTest = { buildConnConfig, handleHostKeyVerification, createSSHSession, cleanupSession, sessions, KNOWN_HOSTS_FILE, HOSTKEY_CONFIRM_TIMEOUT_MS, detectKeyAlgorithm };';
  vm.runInNewContext(source, sandbox, { filename: 'main.js' });

  // 注册一个假窗口 (winId=1) 用于事件捕获
  windows.set(1, {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (!sent[channel]) sent[channel] = [];
        sent[channel].push(payload);
      },
    },
  });

  return {
    sandbox,
    userDataDir,
    knownHostsFile,
    sent,
    ipcHandlers,
    auditEntries,
    timers,
    ex: sandbox.__nimbusTest,
    makeSession: (config, sessionId) => {
      const sid = sessionId || 's1';
      const res = sandbox.__nimbusTest.createSSHSession(1, sid, config);
      const session = sandbox.__nimbusTest.sessions.get(`1:${sid}`);
      return { res, session, connConfig: session.conn._cfg };
    },
  };
}

// 常见连接配置
const BASE_CONFIG = {
  host: 'example.com', port: 22, username: 'alice',
  authMethod: 'password', password: 'secret',
};

async function run() {
  // ---------- 1. buildConnConfig: hostVerifier 注入 / hostKeyVerify=false 跳过 ----------
  await test('buildConnConfig 默认注入 hostVerifier; hostKeyVerify=false 跳过', () => {
    const sb = createSandbox();
    const { connConfig } = sb.makeSession(BASE_CONFIG);
    assert.strictEqual(typeof connConfig.hostVerifier, 'function', '默认应注入 hostVerifier');

    const sb2 = createSandbox();
    const { connConfig: cfg2 } = sb2.makeSession(Object.assign({}, BASE_CONFIG, { hostKeyVerify: false }));
    assert.strictEqual(cfg2.hostVerifier, undefined, 'hostKeyVerify=false 不应传 hostVerifier');
    assert.strictEqual(cfg2.host, 'example.com', '其余配置不受影响');

    const sb3 = createSandbox();
    const { connConfig: cfg3 } = sb3.makeSession(Object.assign({}, BASE_CONFIG, { hostKeyVerify: true }));
    assert.strictEqual(typeof cfg3.hostVerifier, 'function', 'hostKeyVerify=true 显式注入');
  });

  // ---------- 2. trusted 直接放行 (无弹窗) ----------
  await test('trusted 指纹 -> callback(true), 无 confirm/mismatch 事件 (重连场景同路径)', async () => {
    const sb = createSandbox();
    // 预写库: 相当于首次连接已信任
    const t = store.trustHostKey(sb.knownHostsFile, 'example.com', 22, FIXTURE_SHA, 'ssh-ed25519');
    assert.strictEqual(t.ok, true);

    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = await new Promise((resolve) => {
      connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok));
    });
    assert.strictEqual(cbResult, true, 'trusted 应直接放行');
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 0, '不应发确认弹窗');
    assert.strictEqual(sb.sent['hostkey:mismatch'].length, 0, '不应发警告弹窗');
  });

  // ---------- 3. unknown -> confirm -> accept 落库 + 二次 trusted ----------
  await test('unknown 首次连接 -> confirm 事件 -> accept 落库放行 -> 二次 trusted 无弹窗', async () => {
    const sb = createSandbox();
    const { connConfig } = sb.makeSession(BASE_CONFIG);

    const firstCb = new Promise((resolve) => {
      connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok));
    });
    // 事件已发出, 但 callback 尚未被调用 (等待用户)
    const confirmEvents = sb.sent['hostkey:confirm'];
    assert.strictEqual(confirmEvents.length, 1, '应发一次 confirm 事件');
    const ev = confirmEvents[0];
    assert.strictEqual(ev.sessionId, 's1');
    assert.strictEqual(ev.host, 'example.com');
    assert.strictEqual(ev.port, 22);
    assert.strictEqual(ev.algorithm, 'ssh-ed25519');
    assert.strictEqual(ev.sha256, FIXTURE_SHA);
    assert.ok(ev.md5.startsWith('MD5:'), '应含 MD5 指纹');
    assert.strictEqual(ev.keyId, 'example.com:22');

    // 用户接受
    const acceptRes = await sb.ipcHandlers['hostkey:accept']({ sender: { id: 1 } }, { sessionId: 's1', override: false });
    assert.strictEqual(acceptRes.ok, true, 'accept 应 ok');
    assert.strictEqual(await firstCb, true, 'accept 后 callback(true)');
    // 落库
    const stored = store.loadKnownHosts(sb.knownHostsFile);
    assert.ok(stored['example.com:22'], 'known_hosts 应写入');
    assert.strictEqual(stored['example.com:22'].fingerprint, FIXTURE_SHA);
    // 审计
    const acceptAudit = sb.auditEntries.find((e) => e.type === 'hostkey.accept');
    assert.ok(acceptAudit, '应有 hostkey.accept 审计');
    assert.strictEqual(acceptAudit.target, 'example.com:22');
    assert.ok(String(acceptAudit.detail).includes('ssh-ed25519'));

    // 二次连接同指纹 -> trusted 直接放行 (无弹窗)
    const { connConfig: cfg2 } = sb.makeSession(BASE_CONFIG, 's2');
    const cb2 = await new Promise((resolve) => cfg2.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(cb2, true, '二次连接 trusted 放行');
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1, '不再发 confirm');
  });

  // ---------- 4. unknown -> reject ----------
  await test('unknown -> reject -> callback(false) + 审计 hostkey.reject', async () => {
    const sb = createSandbox();
    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1);

    const rejectRes = await sb.ipcHandlers['hostkey:reject']({ sender: { id: 1 } }, { sessionId: 's1' });
    assert.strictEqual(rejectRes.ok, true);
    assert.strictEqual(await cbResult, false, 'reject 后 callback(false)');
    const rejectAudit = sb.auditEntries.find((e) => e.type === 'hostkey.reject');
    assert.ok(rejectAudit, '应有 hostkey.reject 审计');
    // 未落库
    assert.deepStrictEqual(store.loadKnownHosts(sb.knownHostsFile), {}, '拒绝后不应写入 known_hosts');
  });

  // ---------- 5. 并发去重 ----------
  await test('并发校验去重: 弹窗等待期间再来一次 -> 不重复发事件, accept 后队列全部放行', async () => {
    const sb = createSandbox();
    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cb1 = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1, '第一次发 confirm');

    // 弹窗等待期间第二次校验 (例如重连尝试撞上弹窗)
    const cb2 = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1, '不重复发 confirm');
    assert.strictEqual(sb.sent['hostkey:mismatch'].length, 0);

    await sb.ipcHandlers['hostkey:accept']({ sender: { id: 1 } }, { sessionId: 's1', override: false });
    assert.strictEqual(await cb1, true, '队列第 1 个 callback(true)');
    assert.strictEqual(await cb2, true, '队列第 2 个 callback(true)');
    const accepts = sb.auditEntries.filter((e) => e.type === 'hostkey.accept');
    assert.strictEqual(accepts.length, 1, '并发去重只审计一次');
  });

  // ---------- 6. mismatch -> override 覆盖 / 无 override 拒绝 ----------
  await test('mismatch -> 危险警告事件 (含旧指纹); override=true 覆盖放行 + 审计 hostkey.override', async () => {
    const sb = createSandbox();
    // 预写旧指纹 (攻击/密钥更换场景)
    store.trustHostKey(sb.knownHostsFile, 'example.com', 22, OTHER_SHA, 'ssh-rsa');

    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    const mismatchEvents = sb.sent['hostkey:mismatch'];
    assert.strictEqual(mismatchEvents.length, 1, '应发 mismatch 警告');
    const ev = mismatchEvents[0];
    assert.strictEqual(ev.sessionId, 's1');
    assert.strictEqual(ev.sha256, FIXTURE_SHA, '当前指纹');
    assert.strictEqual(ev.storedSha256, OTHER_SHA, '已存指纹');
    assert.strictEqual(ev.storedAlgorithm, 'ssh-rsa');
    const mismatchAudit = sb.auditEntries.find((e) => e.type === 'hostkey.mismatch');
    assert.ok(mismatchAudit, '应有 hostkey.mismatch 审计');
    assert.strictEqual(mismatchAudit.result, 'failure');

    // 不带 override -> 拒绝 (安全边界)
    const noOverride = await sb.ipcHandlers['hostkey:accept']({ sender: { id: 1 } }, { sessionId: 's1', override: false });
    assert.strictEqual(noOverride.ok, false, 'mismatch 必须显式 override');
    assert.strictEqual(sb.sent['hostkey:mismatch'].length, 1, '弹窗仍在等 (未解决)');

    // 带 override -> 覆盖信任新指纹
    const overrideRes = await sb.ipcHandlers['hostkey:accept']({ sender: { id: 1 } }, { sessionId: 's1', override: true });
    assert.strictEqual(overrideRes.ok, true);
    assert.strictEqual(await cbResult, true, 'override 后 callback(true)');
    const overrideAudit = sb.auditEntries.find((e) => e.type === 'hostkey.override');
    assert.ok(overrideAudit, '应有 hostkey.override 审计');
    const after = store.checkHostKey(sb.knownHostsFile, 'example.com', 22, FIXTURE_SHA, 'ssh-ed25519');
    assert.strictEqual(after.status, 'trusted', '库中指纹已更新为新指纹');
  });

  await test('mismatch -> reject -> callback(false) + 审计 hostkey.reject', async () => {
    const sb = createSandbox();
    store.trustHostKey(sb.knownHostsFile, 'example.com', 22, OTHER_SHA, 'ssh-rsa');
    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:mismatch'].length, 1);

    await sb.ipcHandlers['hostkey:reject']({ sender: { id: 1 } }, { sessionId: 's1' });
    assert.strictEqual(await cbResult, false, 'reject 后 callback(false)');
    const rejects = sb.auditEntries.filter((e) => e.type === 'hostkey.reject');
    assert.ok(rejects.length >= 1, '应有 hostkey.reject 审计');
  });

  // ---------- 7. 60s 超时默认拒绝 ----------
  await test('60s 超时无响应 -> 默认拒绝 callback(false) (防挂起)', async () => {
    const sb = createSandbox();
    const { connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1);

    // 应有一个 60s 超时定时器
    assert.strictEqual(sb.timers._pending().length, 1, '应有超时定时器');
    assert.strictEqual(sb.timers._pending()[0].ms, 60000, '超时时长为 60s');
    const fired = sb.timers._fireNext();
    assert.strictEqual(fired, 60000);
    assert.strictEqual(await cbResult, false, '超时默认拒绝');
    const timeoutAudit = sb.auditEntries.find((e) => e.type === 'hostkey.reject');
    assert.ok(timeoutAudit, '超时应审计 hostkey.reject');
    assert.ok(String(timeoutAudit.detail).includes('超时'), 'detail 标注超时');
  });

  // ---------- 8. 重连场景 trusted 放行 (模拟重连, 无 UI) ----------
  await test('重连场景: 已信任库 -> 重连连接直接放行 (无弹窗, 不挂死)', async () => {
    const sb = createSandbox();
    store.trustHostKey(sb.knownHostsFile, 'example.com', 22, FIXTURE_SHA, 'ssh-ed25519');
    // 模拟重连: 同一 session 对象 (hostKeyState 已 reset) 再次走 buildConnConfig
    const { session, connConfig } = sb.makeSession(BASE_CONFIG);
    const cb = await new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(cb, true, '重连 trusted 直接放行');
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 0, '重连无弹窗');
    assert.strictEqual(sb.sent['hostkey:mismatch'].length, 0);
    assert.strictEqual(session.hostKeyState.pending, false, '无挂起状态');
  });

  // ---------- 9. 会话关闭时挂起校验按拒绝处理 ----------
  await test('会话关闭 (cleanupSession) -> 挂起的主机密钥校验按拒绝处理 (防 ssh2 回调挂起)', async () => {
    const sb = createSandbox();
    const { session, connConfig } = sb.makeSession(BASE_CONFIG);
    const cbResult = new Promise((resolve) => connConfig.hostVerifier(FIXTURE_BUF, (ok) => resolve(ok)));
    assert.strictEqual(sb.sent['hostkey:confirm'].length, 1);
    assert.strictEqual(session.hostKeyState.pending, true);

    sb.ex.cleanupSession(1, 's1', session);
    assert.strictEqual(await cbResult, false, '会话关闭后 callback(false)');
    assert.strictEqual(session.hostKeyState.pending, false, '状态已清理');
    const closeAudit = sb.auditEntries.find((e) => e.type === 'hostkey.reject');
    assert.ok(closeAudit, '关闭应审计 hostkey.reject');
  });

  // ---------- 10. 静态断言 ----------
  await test('静态断言: main.js / preload.js / renderer.js / index.html / style.css 接线一致', () => {
    const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
    const mainSrc = read('main.js');
    const preloadSrc = read('preload.js');
    const rendererSrc = read('src/renderer.js');
    const htmlSrc = read('src/index.html');
    const cssSrc = read('src/style.css');
    const storeSrc = read('src/hostkey-store.js');

    // main.js: require + 存储路径 + hostVerifier + IPC + 事件 + 审计 + 超时
    assert.ok(mainSrc.includes("require('./src/hostkey-store')"), 'main.js 应 require hostkey-store');
    assert.ok(mainSrc.includes("known_hosts.json"), 'main.js 应定义 known_hosts.json 存储路径');
    assert.ok(mainSrc.includes('hostVerifier'), 'main.js buildConnConfig 应注入 hostVerifier');
    assert.ok(mainSrc.includes('hostKeyVerify !== false'), 'main.js 默认开启 hostKeyVerify');
    assert.ok(mainSrc.includes("ipcMain.handle('hostkey:accept'"), 'main.js 应有 hostkey:accept IPC');
    assert.ok(mainSrc.includes("ipcMain.handle('hostkey:reject'"), 'main.js 应有 hostkey:reject IPC');
    assert.ok(mainSrc.includes("'hostkey:confirm'"), 'main.js 应发 hostkey:confirm 事件');
    assert.ok(mainSrc.includes("'hostkey:mismatch'"), 'main.js 应发 hostkey:mismatch 事件');
    assert.ok(mainSrc.includes('hostkey.accept') && mainSrc.includes('hostkey.reject'), 'main.js 应有 accept/reject 审计');
    assert.ok(mainSrc.includes('hostkey.override') && mainSrc.includes('hostkey.mismatch'), 'main.js 应有 override/mismatch 审计');
    assert.ok(mainSrc.includes('HOSTKEY_CONFIRM_TIMEOUT_MS'), 'main.js 应有确认超时常量');
    assert.ok(mainSrc.includes('60000'), '超时默认 60s');

    // hostkey-store.js 导出
    assert.ok(storeSrc.includes('function computeFingerprint'), 'hostkey-store 应有 computeFingerprint');
    assert.ok(storeSrc.includes('function checkHostKey'), 'hostkey-store 应有 checkHostKey');
    assert.ok(storeSrc.includes('function trustHostKey'), 'hostkey-store 应有 trustHostKey');

    // preload.js 桥接
    assert.ok(preloadSrc.includes('hostKeyAccept'), 'preload 应暴露 hostKeyAccept');
    assert.ok(preloadSrc.includes('hostKeyReject'), 'preload 应暴露 hostKeyReject');
    assert.ok(preloadSrc.includes("'hostkey:accept'"), 'preload 应 invoke hostkey:accept');
    assert.ok(preloadSrc.includes("'hostkey:reject'"), 'preload 应 invoke hostkey:reject');
    assert.ok(preloadSrc.includes('onHostKeyConfirm') && preloadSrc.includes('onHostKeyMismatch'), 'preload 应暴露事件监听');

    // renderer.js 弹窗
    assert.ok(rendererSrc.includes('onHostKeyConfirm'), 'renderer 应监听 confirm 事件');
    assert.ok(rendererSrc.includes('onHostKeyMismatch'), 'renderer 应监听 mismatch 事件');
    assert.ok(rendererSrc.includes('queueHostKeyDialog'), 'renderer 应有弹窗队列');
    assert.ok(rendererSrc.includes('hostKeyAccept('), 'renderer 应调用 hostKeyAccept');
    assert.ok(rendererSrc.includes('hostKeyReject('), 'renderer 应调用 hostKeyReject');
    assert.ok(rendererSrc.includes('hostKeyVerify: connConfig.hostKeyVerify !== false'), 'renderer 应透传 hostKeyVerify');
    assert.ok(rendererSrc.includes("$('#fHostKeyVerify').checked"), 'renderer handleConnect 应读取校验开关');

    // index.html / style.css
    assert.ok(htmlSrc.includes('id="hostKeyModal"'), 'index.html 应有主机密钥弹窗');
    assert.ok(htmlSrc.includes('id="fHostKeyVerify"'), 'index.html 应有校验开关');
    assert.ok(cssSrc.includes('.hostkey-modal'), 'style.css 应有弹窗样式');
    assert.ok(cssSrc.includes('.hostkey-warning'), 'style.css 应有危险警告样式');
  });

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
