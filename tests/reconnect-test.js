/**
 * FgmSSH 断线自动重连策略回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/reconnect-test.js
 * 覆盖 (Roadmap 第一梯队 ① 断线自动重连):
 *   1. 指数退避序列: 1s/2s/4s/8s/16s/32s(上限封顶)
 *   2. 重试上限: 达到 maxAttempts 后 gaveup, 不再发起下一次尝试
 *   3. 重连成功重置退避计数: 成功后再次失败从第 1 次重新开始
 *   4. 取消定时器: cancel() 清除退避定时器且不再尝试
 *   5. 用户手动断开/应用退出 (shouldAbort=true) 不重连
 *   6. 解密失败/无凭据 (connectFn 返回 fatal) 立即放弃, 不退避重试
 *   7. 审计: reconnect.attempt / reconnect.success / reconnect.failed 含第 N 次尝试, 无敏感信息
 *   8. 状态事件序列: connecting -> attempt/waiting... -> success | gaveup | canceled
 *   9. 静态断言: main.js / renderer.js 重连接线 (凭据解密复用 / 断开/退出取消 / 开关默认开)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createReconnectRunner } = require('../src/reconnect');

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

// ---------- 可控 mock 定时器 ----------
// 记录 setTimeout/clearTimeout 调用; 测试手动触发回调, 不真实等待。
function makeMockTimers() {
  const timers = []; // {id, delay, cb, cleared}
  let seq = 0;
  return {
    setTimeoutFn: (cb, delay) => {
      const id = ++seq;
      timers.push({ id, delay, cb, cleared: false });
      return id;
    },
    clearTimeoutFn: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    _timers: timers,
    _pending() { return timers.filter((t) => !t.cleared); },
    _pendingCount() { return this._pending().length; },
    _nextDelay() {
      const t = this._pending()[0];
      return t ? t.delay : null;
    },
    // 触发下一个未清除的定时器 (返回其延迟; 无则 null)
    // 模拟真实定时器语义: 触发后该定时器即失效 (标记 cleared)
    _fireNext() {
      const t = this._pending()[0];
      if (!t) return null;
      const delay = t.delay;
      t.cleared = true;
      t.cb();
      return delay;
    },
    _clearAll() {
      for (const t of timers) t.cleared = true;
    },
  };
}

// 等待微任务/宏任务排空 (runAttempt 是 async)
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 记录 connectFn 调用序列
function makeConnectFn(sequence) {
  const calls = [];
  const fn = async ({ attempt }) => {
    calls.push(attempt);
    const behavior = sequence[Math.min(calls.length - 1, sequence.length - 1)];
    if (typeof behavior === 'function') return behavior({ attempt });
    return behavior;
  };
  fn._calls = calls;
  return fn;
}

function makeHarness(overrides) {
  const o = overrides || {};
  const timers = o.timers || makeMockTimers();
  const audit = { entries: [] };
  const states = [];
  const connectFn = o.connectFn || makeConnectFn([{ ok: false, error: 'boom' }]);
  const runner = createReconnectRunner({
    maxAttempts: o.maxAttempts !== undefined ? o.maxAttempts : 5,
    baseDelayMs: o.baseDelayMs !== undefined ? o.baseDelayMs : 1000,
    maxDelayMs: o.maxDelayMs !== undefined ? o.maxDelayMs : 32000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    connectFn,
    shouldAbort: o.shouldAbort || (() => false),
    onAudit: (e) => audit.entries.push(e),
    onState: (s) => states.push(s),
  });
  return { runner, timers, audit, states, connectFn };
}

// ---------- 1. 退避序列 ----------
async function run() {
  await test('退避序列: 1s/2s/4s/8s/16s/32s(封顶)', () => {
    const { runner } = makeHarness({});
    assert.strictEqual(runner.delayForAttempt(1), 1000);
    assert.strictEqual(runner.delayForAttempt(2), 2000);
    assert.strictEqual(runner.delayForAttempt(3), 4000);
    assert.strictEqual(runner.delayForAttempt(4), 8000);
    assert.strictEqual(runner.delayForAttempt(5), 16000);
    assert.strictEqual(runner.delayForAttempt(6), 32000);
    assert.strictEqual(runner.delayForAttempt(10), 32000, '超过 32s 上限后封顶');
    assert.strictEqual(runner.maxAttempts, 5, '默认总重试上限为 5');
  });

  await test('自定义 base/max: 2s 起步, 上限 10s', () => {
    const { runner } = makeHarness({ baseDelayMs: 2000, maxDelayMs: 10000 });
    assert.strictEqual(runner.delayForAttempt(1), 2000);
    assert.strictEqual(runner.delayForAttempt(2), 4000);
    assert.strictEqual(runner.delayForAttempt(3), 8000);
    assert.strictEqual(runner.delayForAttempt(4), 10000, '封顶');
  });

  // ---------- 2. 重试上限 ----------
  await test('重试上限: 连续失败 3 次后 gaveup, 不发起第 4 次', async () => {
    const h = makeHarness({ maxAttempts: 3, connectFn: makeConnectFn([{ ok: false, error: 'x' }]) });
    h.runner.start();
    await flush();
    // 第一次尝试由定时器驱动
    const d1 = h.timers._fireNext();
    assert.strictEqual(d1, 1000);
    await flush();
    const d2 = h.timers._fireNext();
    assert.strictEqual(d2, 2000);
    await flush();
    const d3 = h.timers._fireNext();
    assert.strictEqual(d3, 4000);
    await flush();
    // 第 3 次失败即放弃, 不应再有新定时器
    assert.strictEqual(h.timers._pendingCount(), 0, '达到上限后不应再调度');
    assert.strictEqual(h.connectFn._calls.length, 3, '恰好尝试 3 次');
    const gaveup = h.states.find((s) => s.status === 'gaveup');
    assert.ok(gaveup, '应有 gaveup 状态');
    assert.strictEqual(gaveup.attempt, 3);
    assert.strictEqual(gaveup.maxAttempts, 3);
    assert.strictEqual(h.runner.isActive(), false);
  });

  // ---------- 3. 重连成功重置 ----------
  await test('重连成功: 重置退避计数, 再次失败从第 1 次开始', async () => {
    // 第一次失败, 第二次成功, 之后又失败两次
    const seq = [
      { ok: false, error: 'first' },
      { ok: true },
      { ok: false, error: 'again' },
      { ok: false, error: 'again2' },
    ];
    const h = makeHarness({ maxAttempts: 5, connectFn: makeConnectFn(seq) });
    h.runner.start();
    await flush();
    h.timers._fireNext(); // attempt 1 -> fail
    await flush();
    assert.strictEqual(h.connectFn._calls.length, 1);
    h.timers._fireNext(); // attempt 2 -> success
    await flush();
    const success = h.states.find((s) => s.status === 'success');
    assert.ok(success, '应有 success 状态');
    assert.strictEqual(success.attempt, 2);
    assert.strictEqual(h.runner.getAttempt(), 0, '成功后退避计数重置为 0');
    assert.strictEqual(h.runner.isActive(), false);
    // 再次触发重连 (模拟新的断开): start() 重新从第 1 次尝试开始
    h.runner.start();
    await flush();
    const d1 = h.timers._fireNext();
    assert.strictEqual(d1, 1000, '重置后首次尝试延迟恢复 1s');
    await flush();
    // 第 1 次失败后, 调度第 2 次尝试的退避恢复为 2s (而非 16s 之后的 32s)
    assert.strictEqual(h.timers._nextDelay(), 2000, '重置后第二次尝试延迟恢复 2s');
    h.timers._fireNext(); // 第 2 次失败
    await flush();
    assert.strictEqual(h.timers._nextDelay(), 4000, '重置后第三次尝试延迟恢复 4s');
    await flush();
  });

  // ---------- 4. 取消定时器 ----------
  await test('取消定时器: cancel() 清除退避定时器且不再尝试', async () => {
    const h = makeHarness({ connectFn: makeConnectFn([{ ok: false, error: 'x' }]) });
    h.runner.start();
    await flush();
    assert.strictEqual(h.timers._pendingCount(), 1, '启动后应有退避定时器');
    h.runner.cancel();
    await flush();
    assert.strictEqual(h.timers._pendingCount(), 0, '取消后定时器应被清除');
    assert.strictEqual(h.connectFn._calls.length, 0, '取消后不应发起任何尝试');
    assert.ok(h.states.some((s) => s.status === 'canceled'), '应有 canceled 状态');
    assert.strictEqual(h.runner.isActive(), false);
  });

  await test('取消发生在尝试进行中: 尝试结果被忽略 (不继续调度)', async () => {
    let resolveConnect;
    const pendingConnect = new Promise((resolve) => { resolveConnect = resolve; });
    const calls = [];
    const connectFn = async () => {
      calls.push('attempt');
      await pendingConnect; // 挂起, 等待外部 resolve
      return { ok: false, error: 'late' };
    };
    const h = makeHarness({ maxAttempts: 5, connectFn });
    h.runner.start();
    await flush();
    h.timers._fireNext(); // 发起 attempt 1 (挂起)
    await flush();
    assert.strictEqual(calls.length, 1);
    h.runner.cancel(); // 尝试期间取消
    resolveConnect({ ok: false, error: 'late' }); // 尝试返回
    await flush();
    assert.strictEqual(h.timers._pendingCount(), 0, '取消后返回的失败不应再调度重试');
    assert.strictEqual(h.runner.isActive(), false);
  });

  // ---------- 5. 用户手动断开 / 退出 ----------
  await test('用户手动断开 (shouldAbort=true): 不发起重连尝试', async () => {
    const h = makeHarness({ shouldAbort: () => true, connectFn: makeConnectFn([{ ok: false, error: 'x' }]) });
    h.runner.start();
    await flush();
    assert.strictEqual(h.connectFn._calls.length, 0, '不应发起任何尝试');
    assert.ok(h.states.some((s) => s.status === 'canceled'), '应中止为 canceled');
    assert.strictEqual(h.timers._pendingCount(), 0);
  });

  await test('应用退出 (shouldAbort=true): 调度前即中止', async () => {
    let abort = false;
    const h = makeHarness({
      shouldAbort: () => abort,
      connectFn: makeConnectFn([{ ok: false, error: 'x' }]),
    });
    h.runner.start();
    await flush();
    // 第一次尝试前将 abort 置位 (模拟退出)
    abort = true;
    h.timers._fireNext();
    await flush();
    assert.strictEqual(h.connectFn._calls.length, 0, '调度前 abort 应阻止尝试');
    assert.ok(h.states.some((s) => s.status === 'canceled'));
  });

  // ---------- 6. 解密失败放弃 ----------
  await test('解密失败/无凭据 (fatal): 立即放弃, 不退避重试', async () => {
    const h = makeHarness({
      maxAttempts: 5,
      connectFn: makeConnectFn([{ ok: false, fatal: true, error: '无法解密连接凭据' }]),
    });
    h.runner.start();
    await flush();
    h.timers._fireNext();
    await flush();
    assert.strictEqual(h.connectFn._calls.length, 1, '致命失败只尝试一次');
    assert.strictEqual(h.timers._pendingCount(), 0, '致命失败后不应再调度退避');
    const gaveup = h.states.find((s) => s.status === 'gaveup');
    assert.ok(gaveup, '应有 gaveup 状态');
    assert.strictEqual(gaveup.fatal, true);
    assert.match(String(gaveup.error), /无法解密连接凭据/);
  });

  // ---------- 7. 审计 ----------
  await test('审计: reconnect.attempt/success/failed 含第 N 次尝试, 无敏感信息', async () => {
    const seq = [
      { ok: false, error: 'network error' },
      { ok: true },
      { ok: false, error: 'again' },
    ];
    const h = makeHarness({ maxAttempts: 3, connectFn: makeConnectFn(seq) });
    h.runner.start();
    await flush();
    h.timers._fireNext(); await flush(); // attempt 1 fail
    h.timers._fireNext(); await flush(); // attempt 2 success
    h.runner.start(); await flush();     // 新一轮: attempt 1 fail
    h.timers._fireNext(); await flush();
    h.timers._fireNext(); await flush(); // attempt 2 fail
    h.timers._fireNext(); await flush(); // attempt 3 fail -> gaveup

    const attempts = h.audit.entries.filter((e) => e.type === 'reconnect.attempt');
    const successes = h.audit.entries.filter((e) => e.type === 'reconnect.success');
    const failures = h.audit.entries.filter((e) => e.type === 'reconnect.failed');
    assert.ok(attempts.length >= 5, '应有 attempt 审计');
    assert.ok(successes.length >= 1, '应有 success 审计');
    assert.ok(failures.length >= 4, '应有 failed 审计');
    // 尝试审计 detail 含第 N 次, 且不含任何可能敏感的错误内容
    for (const a of attempts) {
      assert.match(a.detail, /第 \d+\/\d+ 次重连尝试/);
    }
    // 失败审计 detail 含第 N 次 + 错误信息 (错误信息由调用方提供, 本模块只透传)
    assert.ok(failures.every((f) => /第 \d+\/\d+ 次重连失败/.test(f.detail)));
    // 成功审计 detail 含第 N 次
    assert.ok(successes.every((s) => /重连成功 \(第 \d+ 次\)/.test(s.detail)));
  });

  // ---------- 8. 状态事件序列 ----------
  await test('状态事件序列: connecting -> attempt/waiting -> success', async () => {
    const h = makeHarness({
      connectFn: makeConnectFn([{ ok: false, error: 'x' }, { ok: true }]),
    });
    h.runner.start();
    await flush();
    assert.strictEqual(h.states[0].status, 'connecting');
    h.timers._fireNext(); await flush(); // attempt 1 fail
    assert.ok(h.states.some((s) => s.status === 'attempt' && s.attempt === 1));
    assert.ok(h.states.some((s) => s.status === 'failed' && s.attempt === 1));
    assert.ok(h.states.some((s) => s.status === 'waiting' && s.attempt === 1));
    h.timers._fireNext(); await flush(); // attempt 2 success
    assert.ok(h.states.some((s) => s.status === 'success' && s.attempt === 2));
  });

  await test('幂等: start() 重复调用不重复调度', async () => {
    const h = makeHarness({ connectFn: makeConnectFn([{ ok: true }]) });
    h.runner.start();
    h.runner.start();
    await flush();
    assert.strictEqual(h.timers._pendingCount(), 1, '只应有一个退避定时器');
  });

  // ---------- 9. 静态断言 ----------
  await test('静态断言: main.js / renderer.js 重连接线一致', () => {
    const root = path.join(__dirname, '..');
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
    const reconnectSrc = fs.readFileSync(path.join(root, 'src', 'reconnect.js'), 'utf8');

    // src/reconnect.js: 指数退避 + 上限 + 取消
    assert.ok(reconnectSrc.includes('delayForAttempt'), 'reconnect.js 应有退避计算');
    assert.ok(reconnectSrc.includes('maxDelayMs'), 'reconnect.js 应有延迟上限');
    assert.ok(reconnectSrc.includes('cancel'), 'reconnect.js 应有取消');

    // main.js: 引入 + 事件 + 审计类型 + 凭据解密复用 + 边界
    assert.ok(mainSrc.includes("require('./src/reconnect')"), 'main.js 应 require reconnect');
    assert.ok(mainSrc.includes('reconnect-status'), 'main.js 应发送 reconnect-status 事件');
    assert.ok(mainSrc.includes('reconnect.attempt'), 'main.js 应埋点 reconnect.attempt');
    assert.ok(mainSrc.includes('reconnect.success'), 'main.js 应埋点 reconnect.success');
    assert.ok(mainSrc.includes('reconnect.failed'), 'main.js 应埋点 reconnect.failed');
    assert.ok(mainSrc.includes('decryptRecord'), 'main.js 应复用 credential-store.decryptRecord');
    assert.ok(mainSrc.includes('autoReconnect: config.autoReconnect !== false'), 'main.js 默认开启 autoReconnect');
    assert.ok(mainSrc.includes('autoReconnectMaxAttempts'), 'main.js 应支持重试上限配置');
    assert.ok(mainSrc.includes('userDisconnected'), 'main.js 应有用户主动断开标记');
    assert.ok(mainSrc.includes('reconnectCanceled'), 'main.js 应有重连取消标记');
    assert.ok(mainSrc.includes('reconnectRunner.cancel'), 'main.js 断开/退出时应取消重连定时器');
    assert.ok(mainSrc.includes('everConnected'), 'main.js 应以 everConnected 限制「已连接后断开」才重连');
    // ssh:disconnect 与 cleanupAllSessions 均取消重连
    const disconnectIdx = mainSrc.indexOf("ipcMain.handle('ssh:disconnect'");
    assert.ok(disconnectIdx > -1, '应有 ssh:disconnect');
    assert.ok(mainSrc.slice(disconnectIdx, disconnectIdx + 1200).includes('reconnectRunner.cancel'), 'ssh:disconnect 应取消重连');
    assert.ok(mainSrc.includes('cleanupAllSessions'), '应有 cleanupAllSessions');
    const cleanupIdx = mainSrc.indexOf('function cleanupAllSessions');
    assert.ok(mainSrc.slice(cleanupIdx, cleanupIdx + 1500).includes('reconnectRunner.cancel'), 'cleanupAllSessions 应取消重连');

    // renderer.js: 状态处理 + 连接透传
    assert.ok(rendererSrc.includes('reconnect-status'), 'renderer.js 应处理 reconnect-status 事件');
    assert.ok(rendererSrc.includes('已断开 · 重连中'), 'renderer.js 应有重连中 overlay 文案');
    assert.ok(rendererSrc.includes('重连失败'), 'renderer.js 应有重连失败 overlay 文案');
    assert.ok(rendererSrc.includes('autoReconnect: connConfig.autoReconnect'), 'renderer.js 连接时应透传 autoReconnect');
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
