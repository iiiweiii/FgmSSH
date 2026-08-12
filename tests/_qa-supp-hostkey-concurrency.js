#!/usr/bin/env node
/**
 * QA 补充验证 (不属正式套件): 两会话并发首次连接 -> 各自独立弹窗, 不串台。
 * 复用 hostkey-verifier-test 的 vm 沙箱方法加载真实 main.js。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const store = require('../src/hostkey-store');

const CWD = path.join(__dirname, '..');
const FIXTURE_BUF = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIF82X3M7p/KqIf2PMW7y/wqHi1QOH7zdki35eUUuz1+M', 'base64');
const FIXTURE_SHA = store.computeFingerprint(FIXTURE_BUF).sha256;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function makeFakeTimers() {
  const timers = [];
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeoutFn: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    _timers: timers,
  };
}

class MockClient {
  constructor() { this._handlers = {}; this._cfg = null; }
  on(evt, fn) { this._handlers[evt] = fn; return this; }
  connect(cfg) { this._cfg = cfg; }
  end() {}
  shell(args, cb) { if (typeof cb === 'function') cb(new Error('mock-no-shell')); }
  exec(cmd, cb) { if (typeof cb === 'function') cb(new Error('mock-no-exec')); }
}

function createSandbox() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-qaconc-'));
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
      whenReady: () => new Promise(() => {}),
      on: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
    },
    BrowserWindow: {
      fromId: (id) => windows.get(Number(id)) || null,
      getAllWindows: () => [],
    },
    ipcMain: { handle: (channel, fn) => { ipcHandlers[channel] = fn; } },
    dialog: {}, shell: {},
    protocol: { registerSchemesAsPrivileged: () => {} },
    net: {}, safeStorage: {},
    Tray: function () {}, Menu: {},
  };
  const mockRequire = (id) => {
    if (id === 'electron') return mockElectron;
    if (id === 'ssh2') return { Client: MockClient };
    if (id === './src/audit-log') {
      return { logAudit: (e) => auditEntries.push(e), initAuditLog: () => ({}), queryAudit: async () => ({ total: 0, items: [] }), flush: async () => {}, _resetForTest: () => {} };
    }
    if (id.startsWith('./') || id.startsWith('../')) return require(path.resolve(CWD, id));
    return require(id);
  };
  const sandbox = {
    require: mockRequire, module: { exports: {} }, exports: {},
    __dirname: CWD, __filename: path.join(CWD, 'main.js'),
    console, process, Buffer,
    setTimeout: timers.setTimeoutFn, clearTimeout: timers.clearTimeoutFn,
    setInterval: () => 0, clearInterval: () => {},
    URL,
  };
  sandbox.globalThis = sandbox;
  const source = fs.readFileSync(path.join(CWD, 'main.js'), 'utf8') +
    '\n;globalThis.__nimbusTest = { createSSHSession, sessions, cleanupSession };';
  vm.runInNewContext(source, sandbox, { filename: 'main.js' });
  windows.set(1, { isDestroyed: () => false, webContents: { send: (channel, payload) => { if (!sent[channel]) sent[channel] = []; sent[channel].push(payload); } } });
  return { knownHostsFile, sent, ipcHandlers, auditEntries, timers, ex: sandbox.__nimbusTest,
    makeSession: (config, sessionId) => {
      const res = sandbox.__nimbusTest.createSSHSession(1, sessionId, config);
      const session = sandbox.__nimbusTest.sessions.get(`1:${sessionId}`);
      return { res, session, connConfig: session.conn._cfg };
    } };
}

(async () => {
  const sb = createSandbox();
  const cfgA = { host: 'host-a.example', port: 22, username: 'u', authMethod: 'password', password: 'x' };
  const cfgB = { host: 'host-b.example', port: 22, username: 'u', authMethod: 'password', password: 'x' };

  // 两个会话几乎同时发起首次连接
  const sA = sb.makeSession(cfgA, 'sessA');
  const sB = sb.makeSession(cfgB, 'sessB');
  const cbA = new Promise((r) => sA.connConfig.hostVerifier(FIXTURE_BUF, (ok) => r(ok)));
  const cbB = new Promise((r) => sB.connConfig.hostVerifier(FIXTURE_BUF, (ok) => r(ok)));

  // 各发一次 confirm, 事件带各自 sessionId, 不串台
  const confirms = sb.sent['hostkey:confirm'];
  check('两个会话各发一次 confirm (共 2)', confirms.length === 2, confirms.length);
  check('confirm A sessionId=sessA', confirms.some((e) => e.sessionId === 'sessA' && e.host === 'host-a.example'));
  check('confirm B sessionId=sessB', confirms.some((e) => e.sessionId === 'sessB' && e.host === 'host-b.example'));
  check('A 事件不携带 B 的主机', !confirms.some((e) => e.sessionId === 'sessA' && e.host === 'host-b.example'));

  // 只接受 A -> B 仍挂起等待; A 的库只落 host-a
  const acceptA = await sb.ipcHandlers['hostkey:accept']({ sender: { id: 1 } }, { sessionId: 'sessA', override: false });
  check('accept A ok', acceptA.ok === true);
  check('A callback(true)', await cbA === true);
  check('B 仍未解决 (无回调返回值 = pending)', sB.session.hostKeyState.pending === true, sB.session.hostKeyState.pending);
  const map = store.loadKnownHosts(sb.knownHostsFile);
  check('库只写入 host-a.example:22', !!map['host-a.example:22'] && !map['host-b.example:22'], JSON.stringify(Object.keys(map)));

  // 拒绝 B -> callback(false) 且审计两条 reject/accept 类型正确
  const rejectB = await sb.ipcHandlers['hostkey:reject']({ sender: { id: 1 } }, { sessionId: 'sessB' });
  check('reject B ok', rejectB.ok === true);
  check('B callback(false)', await cbB === false);
  const acc = sb.auditEntries.filter((e) => e.type === 'hostkey.accept');
  const rej = sb.auditEntries.filter((e) => e.type === 'hostkey.reject');
  check('审计 accept x1 / reject x1', acc.length === 1 && rej.length === 1, `acc=${acc.length} rej=${rej.length}`);

  console.log(`\n==== 补充: 两会话并发 ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
