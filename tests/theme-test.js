/**
 * NimbusSSH 主题模块回归测试 (node 直跑, 不依赖 DOM/Electron)
 * 运行: node tests/theme-test.js
 * 覆盖 (Roadmap P2: light/dark/auto 三态 + 持久化 + xterm 同步):
 *   1. 首次启动读取 localStorage (light/dark/auto/损坏值回退 auto)
 *   2. 默认 auto 跟随系统 prefers-color-scheme (matchMedia mock)
 *   3. switchTheme 循环: light -> dark -> auto -> light, 并写回 storage
 *   4. xterm 同步: 切换/初始化时对所有活动实例调 setOption('theme', ...),
 *      深色主题与 renderer.js createTerminal 现有深色主题一致 (回归不破坏)
 *   5. 按钮状态更新 (dataset.theme / title / 图标)
 *   6. auto 模式下系统主题变化监听; 强制模式不受系统变化影响
 *   7. localStorage 异常 (getItem 抛错) 容错
 *   8. CHART_COLORS 双主题配色存在 (GPU 折线图注入用)
 */
const assert = require('assert');

const NimbusTheme = require('../src/theme');

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
  if (seed !== undefined) map.set(NimbusTheme.STORAGE_KEY, seed);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

// 记录每次 data-theme 设置的 mock document
function makeMockDoc() {
  const sets = [];
  return {
    documentElement: {
      setAttribute: (name, value) => { assert.strictEqual(name, 'data-theme'); sets.push(value); },
      getAttribute: (name) => (name === 'data-theme' ? sets[sets.length - 1] || null : null),
    },
    _sets: sets,
  };
}

// mock matchMedia: 可编程系统主题, 可触发 change 监听
function makeMockMatchMedia(systemDark) {
  const listeners = new Set();
  let matches = !!systemDark;
  const mql = {
    get matches() { return matches; },
    addEventListener: (type, cb) => { if (type === 'change') listeners.add(cb); },
    addListener: (cb) => { listeners.add(cb); },
    removeEventListener: () => {},
    removeListener: () => {},
    _set: (dark) => {
      matches = !!dark;
      listeners.forEach((cb) => cb({ matches: !!dark, media: '(prefers-color-scheme: dark)' }));
    },
  };
  const fn = () => mql; // 忽略 query, 始终返回同一 mql
  fn._mql = mql;
  return fn;
}

// mock xterm 实例: 记录 setOption('theme', ...) 调用
function makeMockTerm() {
  const calls = [];
  return {
    setOption: (name, value) => { calls.push({ name, value }); },
    _calls: calls,
  };
}

// mock 顶栏主题按钮
function makeMockButton() {
  const icon = { textContent: '' };
  const label = { textContent: '' };
  return {
    dataset: {},
    title: '',
    style: {},
    querySelector: (sel) => (sel === '.theme-state-icon' ? icon : label),
    _icon: icon,
    _label: label,
  };
}

async function run() {
  // ---------- 1. 首次启动读取 localStorage ----------
  await test('首次启动: storage 缺省 -> auto, 跟随系统深色', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage(),
      doc,
      matchMedia: makeMockMatchMedia(true), // 系统深色
      getTerminals: () => [],
    });
    const applied = ctrl.init();
    assert.strictEqual(applied, 'dark');
    assert.strictEqual(ctrl.getPreference(), 'auto');
    assert.strictEqual(ctrl.currentTheme(), 'dark');
    assert.deepStrictEqual(doc._sets, ['dark'], 'data-theme 应设为 dark');
  });

  await test('首次启动: storage 缺省 + 系统浅色 -> data-theme=light', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage(),
      doc,
      matchMedia: makeMockMatchMedia(false), // 系统浅色
      getTerminals: () => [],
    });
    const applied = ctrl.init();
    assert.strictEqual(applied, 'light');
    assert.deepStrictEqual(doc._sets, ['light']);
  });

  await test('首次启动: storage=light -> 强制浅色 (系统深色也无效)', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('light'),
      doc,
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
    });
    ctrl.init();
    assert.strictEqual(ctrl.getPreference(), 'light');
    assert.strictEqual(ctrl.currentTheme(), 'light');
    assert.deepStrictEqual(doc._sets, ['light']);
  });

  await test('首次启动: storage=dark -> 强制深色', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('dark'),
      doc,
      matchMedia: makeMockMatchMedia(false),
      getTerminals: () => [],
    });
    ctrl.init();
    assert.strictEqual(ctrl.currentTheme(), 'dark');
    assert.deepStrictEqual(doc._sets, ['dark']);
  });

  await test('首次启动: storage=auto + 系统浅色 -> data-theme=light', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('auto'),
      doc,
      matchMedia: makeMockMatchMedia(false),
      getTerminals: () => [],
    });
    ctrl.init();
    assert.strictEqual(ctrl.getPreference(), 'auto');
    assert.strictEqual(ctrl.currentTheme(), 'light');
  });

  await test('首次启动: 损坏 storage 值 -> 回退 auto', () => {
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('purple'),
      doc,
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
    });
    ctrl.init();
    assert.strictEqual(ctrl.getPreference(), 'auto', '损坏值应回退 auto');
    assert.strictEqual(ctrl.currentTheme(), 'dark');
  });

  await test('容错: storage.getItem 抛异常 -> 不崩溃, 回退 auto', () => {
    const doc = makeMockDoc();
    const storage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => {},
    };
    const ctrl = NimbusTheme.createThemeController({
      storage,
      doc,
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
    });
    assert.doesNotThrow(() => ctrl.init());
    assert.strictEqual(ctrl.getPreference(), 'auto');
    assert.strictEqual(ctrl.currentTheme(), 'dark');
  });

  // ---------- 2. switchTheme 循环 + 持久化 ----------
  await test('switchTheme: light -> dark -> auto -> light, 且写回 storage', () => {
    const storage = makeMockStorage('light');
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage,
      doc,
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
    });
    ctrl.init();
    assert.strictEqual(ctrl.currentTheme(), 'light');

    const t1 = ctrl.switchTheme();
    assert.strictEqual(t1, 'dark');
    assert.strictEqual(ctrl.getPreference(), 'dark');
    assert.strictEqual(storage.getItem(NimbusTheme.STORAGE_KEY), 'dark');

    const t2 = ctrl.switchTheme();
    assert.strictEqual(t2, 'dark', 'auto + 系统深色 -> 实际 dark');
    assert.strictEqual(ctrl.getPreference(), 'auto');
    assert.strictEqual(storage.getItem(NimbusTheme.STORAGE_KEY), 'auto');

    const t3 = ctrl.switchTheme();
    assert.strictEqual(t3, 'light');
    assert.strictEqual(ctrl.getPreference(), 'light');
    assert.strictEqual(storage.getItem(NimbusTheme.STORAGE_KEY), 'light');
  });

  await test('setPreference: 非法值 -> 归一化为 auto 并写回', () => {
    const storage = makeMockStorage();
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage,
      doc,
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
    });
    ctrl.init();
    ctrl.setPreference('neon');
    assert.strictEqual(ctrl.getPreference(), 'auto');
    assert.strictEqual(storage.getItem(NimbusTheme.STORAGE_KEY), 'auto');
  });

  // ---------- 3. xterm 同步 ----------
  await test('xterm 同步: setPreference(light) 对所有实例 setOption(theme, light)', () => {
    const t1 = makeMockTerm();
    const t2 = makeMockTerm();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage(),
      doc: makeMockDoc(),
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [t1, t2],
    });
    ctrl.init();
    t1._calls.length = 0;
    t2._calls.length = 0;

    ctrl.setPreference('light');
    assert.strictEqual(t1._calls.length, 1);
    assert.strictEqual(t1._calls[0].name, 'theme');
    assert.deepStrictEqual(t1._calls[0].value, NimbusTheme.XTERM_THEMES.light);
    assert.strictEqual(t2._calls.length, 1);
    assert.deepStrictEqual(t2._calls[0].value, NimbusTheme.XTERM_THEMES.light);

    ctrl.setPreference('dark');
    assert.strictEqual(t1._calls.length, 2);
    assert.deepStrictEqual(t1._calls[1].value, NimbusTheme.XTERM_THEMES.dark);
  });

  await test('xterm 同步: 初始化即按当前主题设置 (storage=light 且已有实例)', () => {
    const t1 = makeMockTerm();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('light'),
      doc: makeMockDoc(),
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [t1],
    });
    ctrl.init();
    assert.strictEqual(t1._calls.length, 1);
    assert.deepStrictEqual(t1._calls[0].value, NimbusTheme.XTERM_THEMES.light);
  });

  await test('回归: 深色 xterm 主题与 renderer.js createTerminal 现有深色主题一致', () => {
    const dark = NimbusTheme.XTERM_THEMES.dark;
    assert.strictEqual(dark.background, '#0e1116');
    assert.strictEqual(dark.foreground, '#e6eaf0');
    assert.strictEqual(dark.cursor, '#4f8cff');
    assert.strictEqual(dark.cursorAccent, '#0e1116');
    assert.strictEqual(dark.selectionBackground, 'rgba(79, 140, 255, 0.35)');
    assert.strictEqual(dark.black, '#0e1116');
    assert.strictEqual(dark.red, '#ff5d5d');
    assert.strictEqual(dark.green, '#3ecf8e');
    assert.strictEqual(dark.yellow, '#f5b64c');
    assert.strictEqual(dark.blue, '#5f9aff');
    assert.strictEqual(dark.magenta, '#c792ea');
    assert.strictEqual(dark.cyan, '#4dd0e1');
    assert.strictEqual(dark.white, '#e6eaf0');
    assert.strictEqual(dark.brightBlack, '#5c6673');
    assert.strictEqual(dark.brightWhite, '#ffffff');
  });

  await test('xterm 同步: 实例 setOption 抛异常不影响其他实例', () => {
    const bad = { setOption: () => { throw new Error('boom'); } };
    const good = makeMockTerm();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage(),
      doc: makeMockDoc(),
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [bad, good],
    });
    assert.doesNotThrow(() => ctrl.setPreference('light'));
    assert.strictEqual(good._calls.length, 1, '异常实例不应阻断其余实例同步');
  });

  // ---------- 4. 按钮状态 ----------
  await test('按钮更新: dataset.theme / title / 图标随偏好变化', () => {
    const btn = makeMockButton();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('auto'),
      doc: makeMockDoc(),
      matchMedia: makeMockMatchMedia(true),
      getTerminals: () => [],
      button: btn,
    });
    ctrl.init();
    assert.strictEqual(btn.dataset.theme, 'auto');
    assert.ok(btn.title.includes('自动'), 'title 应包含偏好标签');
    assert.ok(btn.title.includes('深色'), 'title 应包含当前生效主题');
    assert.strictEqual(btn._icon.textContent, '◐');

    ctrl.setPreference('light');
    assert.strictEqual(btn.dataset.theme, 'light');
    assert.ok(btn.title.includes('浅色'));
    assert.strictEqual(btn._icon.textContent, '☀');

    ctrl.setPreference('dark');
    assert.strictEqual(btn.dataset.theme, 'dark');
    assert.strictEqual(btn._icon.textContent, '☾');
  });

  // ---------- 5. auto 系统主题监听 ----------
  await test('auto: 系统主题变化 -> 重新应用 (浅->深->浅)', () => {
    const mm = makeMockMatchMedia(true);
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('auto'),
      doc,
      matchMedia: mm,
      getTerminals: () => [],
    });
    ctrl.init();
    assert.deepStrictEqual(doc._sets, ['dark']);

    mm._mql._set(false); // 系统切到浅色
    assert.strictEqual(ctrl.currentTheme(), 'light');
    assert.deepStrictEqual(doc._sets, ['dark', 'light']);

    mm._mql._set(true); // 系统切回深色
    assert.strictEqual(ctrl.currentTheme(), 'dark');
    assert.deepStrictEqual(doc._sets, ['dark', 'light', 'dark']);
  });

  await test('强制模式: 系统主题变化不影响已应用的 data-theme', () => {
    const mm = makeMockMatchMedia(true);
    const doc = makeMockDoc();
    const ctrl = NimbusTheme.createThemeController({
      storage: makeMockStorage('dark'),
      doc,
      matchMedia: mm,
      getTerminals: () => [],
    });
    ctrl.init();
    assert.deepStrictEqual(doc._sets, ['dark']);

    mm._mql._set(false); // 系统切浅色, 强制 dark 不应变化
    assert.strictEqual(ctrl.currentTheme(), 'dark');
    assert.deepStrictEqual(doc._sets, ['dark'], '强制 dark 下不应因系统变化重设');
  });

  // ---------- 6. 纯函数 + 图表配色 ----------
  await test('normalize: 仅接受 light/dark/auto, 其余回退 auto', () => {
    assert.strictEqual(NimbusTheme.normalize('light'), 'light');
    assert.strictEqual(NimbusTheme.normalize('dark'), 'dark');
    assert.strictEqual(NimbusTheme.normalize('auto'), 'auto');
    assert.strictEqual(NimbusTheme.normalize(null), 'auto');
    assert.strictEqual(NimbusTheme.normalize(undefined), 'auto');
    assert.strictEqual(NimbusTheme.normalize(''), 'auto');
    assert.strictEqual(NimbusTheme.normalize('LIGHT'), 'auto');
    assert.strictEqual(NimbusTheme.normalize('purple'), 'auto');
    assert.strictEqual(NimbusTheme.normalize(42), 'auto');
  });

  await test('resolveTheme: auto 跟随系统, 强制覆盖系统', () => {
    assert.strictEqual(NimbusTheme.resolveTheme('auto', 'light'), 'light');
    assert.strictEqual(NimbusTheme.resolveTheme('auto', 'dark'), 'dark');
    assert.strictEqual(NimbusTheme.resolveTheme('auto', null), 'dark', '无系统信息按深色兜底');
    assert.strictEqual(NimbusTheme.resolveTheme('light', 'dark'), 'light');
    assert.strictEqual(NimbusTheme.resolveTheme('dark', 'light'), 'dark');
  });

  await test('CHART_COLORS: dark/light 双主题配色齐全 (GPU 折线图注入用)', () => {
    assert.ok(NimbusTheme.CHART_COLORS.dark, '缺 dark 配色');
    assert.ok(NimbusTheme.CHART_COLORS.light, '缺 light 配色');
    ['util', 'mem', 'grid', 'text', 'axis'].forEach((k) => {
      assert.ok(typeof NimbusTheme.CHART_COLORS.dark[k] === 'string' && NimbusTheme.CHART_COLORS.dark[k].length > 0, 'dark.' + k);
      assert.ok(typeof NimbusTheme.CHART_COLORS.light[k] === 'string' && NimbusTheme.CHART_COLORS.light[k].length > 0, 'light.' + k);
    });
    assert.strictEqual(NimbusTheme.CHART_COLORS.dark.util, '#4f8cff', 'dark util 应与 gpu-chart 原常量一致');
  });

  // ---------- 汇总 ----------
  console.log('\n主题模块测试完成: ' + passed + ' 通过, ' + failed + ' 失败');
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run();
