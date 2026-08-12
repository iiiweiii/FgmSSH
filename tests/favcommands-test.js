/**
 * FgmSSH 常用命令收藏模块回归测试 (node 直跑, 不依赖 DOM/Electron)
 * 运行: node tests/favcommands-test.js
 * 覆盖:
 *   1. localStorage 读写往返 (add -> load, 持久化到 mock storage)
 *   2. 点击调用 write: send(cmd) 调用注入的 write(cmd + '\r') (终端回车提交)
 *   3. 空命令过滤: add('', '   ') 拒绝; send('') 拒绝
 *   4. XSS 转义: renderList 输出的名称/命令均被 escapeHtml, 不含原始 <script>
 *   5. 删除 (按 ts); 损坏 JSON 容错; 上限截断
 *   6. 未注入 write / 无 storage 时的降级行为
 */
const assert = require('assert');

const { createFavCommands, STORAGE_KEY } = require('../src/fav-commands');

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

// 内存版 localStorage (与浏览器接口形状一致)
function makeMockStorage(seed) {
  const map = new Map();
  if (seed !== undefined) map.set(STORAGE_KEY, seed);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

// 固定递增时间戳 (测试删除/排序用)
function makeClock() {
  let t = 1000;
  return () => (t += 1000);
}

async function run() {
  // ---------- 1. localStorage 读写往返 ----------
  await test('add -> load 往返: 持久化到 localStorage (含 name/cmd/ts)', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    const r = fc.add('查日志', 'tail -f /var/log/app.log');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.list.length, 1);
    assert.strictEqual(r.item.name, '查日志');
    assert.strictEqual(r.item.cmd, 'tail -f /var/log/app.log');
    assert.ok(typeof r.item.ts === 'number', 'ts 应为数字');
    // 新实例读回 (模拟刷新页面)
    const fc2 = createFavCommands({ storage, now: makeClock() });
    const loaded = fc2.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].name, '查日志');
    assert.strictEqual(loaded[0].cmd, 'tail -f /var/log/app.log');
    assert.strictEqual(loaded[0].ts, r.item.ts);
  });

  // ---------- 2. 点击调用 write ----------
  await test('send(cmd): 调用注入 write, 参数为 cmd + \'\\r\' (shell 回车提交)', async () => {
    const calls = [];
    const fc = createFavCommands({
      storage: makeMockStorage(),
      write: (data) => { calls.push(data); return Promise.resolve({ ok: true }); },
    });
    const res = await fc.send('df -h');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], 'df -h\r', '应追加 \\r 提交');
  });

  await test('send(cmd): 命令原样发送, 不做变量/模板解析', async () => {
    const calls = [];
    const fc = createFavCommands({
      storage: makeMockStorage(),
      write: (data) => { calls.push(data); return Promise.resolve({ ok: true }); },
    });
    const cmd = 'echo $HOME && ls ${HOME} `pwd`';
    await fc.send(cmd);
    assert.strictEqual(calls[0], cmd + '\r', '命令文本应原样发送');
  });

  await test('send 返回 write 的结果 (no_session 等透传)', async () => {
    const fc = createFavCommands({
      storage: makeMockStorage(),
      write: () => Promise.resolve({ ok: false, error: 'no_session' }),
    });
    const res = await fc.send('top');
    assert.deepStrictEqual(res, { ok: false, error: 'no_session' });
  });

  // ---------- 3. 空命令过滤 ----------
  await test('add: 空命令不添加 (返回 empty_cmd, 列表不变)', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    fc.add('ok', 'ls');
    const r1 = fc.add('bad', '');
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, 'empty_cmd');
    const r2 = fc.add('bad2', '   ');
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error, 'empty_cmd');
    assert.strictEqual(fc.load().length, 1, '空命令不应加入列表');
  });

  await test('send: 空命令拒绝且不调用 write', async () => {
    let called = 0;
    const fc = createFavCommands({
      storage: makeMockStorage(),
      write: () => { called++; return Promise.resolve({ ok: true }); },
    });
    const res = await fc.send('  ');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'empty_cmd');
    assert.strictEqual(called, 0, '空命令不应调用 write');
  });

  // ---------- 4. XSS 转义 ----------
  await test('renderList: 名称/命令经 escapeHtml, 不含原始 <script>', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    fc.add('<script>alert(1)</script>', 'rm -rf <img src=x onerror=alert(2)>');
    const html = fc.renderList(fc.load());
    assert.ok(!html.includes('<script>'), '不应包含原始 <script> 标签');
    assert.ok(!html.includes('<img'), '不应包含原始 <img 标签');
    assert.ok(html.includes('&lt;script&gt;'), '应包含转义后的 &lt;script&gt;');
    assert.ok(html.includes('&lt;img'), '应包含转义后的 &lt;img');
    // escapeHtml 单测
    assert.strictEqual(fc.escapeHtml('<b>"x"&\'y\''), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });

  await test('renderList: ts 也经 escapeHtml (纵深防御, data-ts 不注入)', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    // 直接注入带 HTML 元字符的 ts (绕过 load 归一化的防御场景)
    const list = [{ name: 'n', cmd: 'ls', ts: '1"><img src=x onerror=alert(1)>' }];
    const html = fc.renderList(list);
    assert.ok(!html.includes('<img'), 'ts 不应注入原始 <img');
    assert.ok(html.includes('&quot;') && html.includes('&gt;'), 'ts 应被转义 (&quot;/&gt;)');
    assert.ok(html.includes('data-ts="1&quot;&gt;&lt;img'), 'data-ts 应包含转义后的值');
  });

  // ---------- 5. 删除 / 容错 / 上限 ----------
  await test('remove: 按 ts 删除 (不存在幂等)', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    const a = fc.add('a', 'cmd-a').item;
    const b = fc.add('b', 'cmd-b').item;
    const r = fc.remove(a.ts);
    assert.strictEqual(r.ok, true);
    const loaded = fc.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].ts, b.ts);
    // 重复删除幂等
    fc.remove(a.ts);
    assert.strictEqual(fc.load().length, 1);
  });

  await test('损坏 JSON / 非数组 -> load 返回空列表, 不抛', () => {
    const fc = createFavCommands({ storage: makeMockStorage('{corrupted json!!') });
    assert.deepStrictEqual(fc.load(), []);
    const fc2 = createFavCommands({ storage: makeMockStorage('{"a":1}') });
    assert.deepStrictEqual(fc2.load(), []);
    // 存储为字符串数组 -> 过滤非法项
    const fc3 = createFavCommands({ storage: makeMockStorage(JSON.stringify(['x', { name: 'n', cmd: 'c', ts: 1 }])) });
    assert.strictEqual(fc3.load().length, 1);
    assert.strictEqual(fc3.load()[0].cmd, 'c');
  });

  await test('save: 超过上限截断 (MAX_ITEMS)', () => {
    const storage = makeMockStorage();
    const fc = createFavCommands({ storage, now: makeClock() });
    for (let i = 0; i < fc.MAX_ITEMS + 20; i++) {
      fc.add('n' + i, 'cmd-' + i);
    }
    assert.strictEqual(fc.load().length, fc.MAX_ITEMS);
  });

  // ---------- 6. 降级行为 ----------
  await test('未注入 write: send 返回 no_write, 不抛', async () => {
    const fc = createFavCommands({ storage: makeMockStorage() });
    const res = await fc.send('ls');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'no_write');
  });

  await test('未注入 storage: add/load 内存工作 (不抛)', () => {
    const fc = createFavCommands();
    const r = fc.add('x', 'ls');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(fc.load(), [], '无 storage 时 load 返回空 (不持久化)');
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
