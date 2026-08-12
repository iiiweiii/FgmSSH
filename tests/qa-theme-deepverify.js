/**
 * QA 补充验证: XTERM_THEMES.dark 与 renderer.js createTerminal 现有深色主题逐字一致
 * + renderer.js buildGpuChartOpts 深浅配色返回正确 (提取真实源码执行)
 * + renderer.js getTerminals 去重逻辑审查
 * 运行: node tests/qa-theme-deepverify.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const theme = require('../src/theme');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (err) { failed++; console.error('  \u2717 ' + name); console.error('    ' + err.message); }
}

const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');

// ---- 1. 从 renderer.js 提取 createTerminal 的 theme: {...} 对象 ----
const themeBlock = rendererSrc.match(/theme:\s*\{([\s\S]*?)\}\s*,\s*scrollback/);
assert.ok(themeBlock, '未找到 createTerminal 的 theme 块');
const rendererThemeObj = {};
{
  const varRe = /(\w+)\s*:\s*('[^']*'|"[^"]*")/g;
  let vm;
  while ((vm = varRe.exec(themeBlock[1])) !== null) {
    rendererThemeObj[vm[1]] = vm[2].slice(1, -1);
  }
}

check('XTERM_THEMES.dark 与 renderer.js createTerminal 深色主题逐字一致 (深比较)', () => {
  const dark = theme.XTERM_THEMES.dark;
  assert.deepStrictEqual(
    Object.keys(dark).sort(),
    Object.keys(rendererThemeObj).sort(),
    '键集合不一致'
  );
  for (const k of Object.keys(dark)) {
    assert.strictEqual(dark[k], rendererThemeObj[k], '键 ' + k + ' 值不一致: theme.js=' + dark[k] + ' renderer.js=' + rendererThemeObj[k]);
  }
});

check('XTERM_THEMES.light 关键值抽查 (白底深字 VSCode Light ANSI 16 色)', () => {
  const light = theme.XTERM_THEMES.light;
  assert.strictEqual(light.background, '#ffffff');
  assert.strictEqual(light.foreground, '#24292f');
  assert.strictEqual(light.cursor, '#0969da');
  // ANSI 16 色全键存在
  const ansiKeys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  for (const k of ansiKeys) {
    assert.ok(typeof light[k] === 'string' && light[k].length > 0, 'light.' + k + ' 缺失');
  }
});

// ---- 2. 提取 renderer.js buildGpuChartOpts 源码并执行 (mock window.NimbusTheme/themeController) ----
check('renderer.js buildGpuChartOpts 源码存在', () => {
  const m = rendererSrc.match(/function buildGpuChartOpts\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '未找到 buildGpuChartOpts 函数');
});

function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}'));
  return m ? m[1] : null;
}

// 模拟 renderer 全局: themeController.currentTheme() 与 window.NimbusTheme.CHART_COLORS
function simulateBuildGpuChartOpts(currentThemeVal) {
  const body = extractFn(rendererSrc, 'buildGpuChartOpts');
  assert.ok(body, '无法提取 buildGpuChartOpts 函数体');
  const globals = {
    themeController: { currentTheme: () => currentThemeVal },
    window: { NimbusTheme: theme },
  };
  const fn = new Function('themeController', 'window', '"use strict"; return (function buildGpuChartOpts() {' + body + '\n});');
  return fn(globals.themeController, globals.window)();
}

check('buildGpuChartOpts: 深色主题 -> 返回 CHART_COLORS.dark', () => {
  const r = simulateBuildGpuChartOpts('dark');
  assert.ok(r && r.colors, '应返回 { colors }');
  assert.deepStrictEqual(r.colors, theme.CHART_COLORS.dark);
});

check('buildGpuChartOpts: 浅色主题 -> 返回 CHART_COLORS.light', () => {
  const r = simulateBuildGpuChartOpts('light');
  assert.deepStrictEqual(r.colors, theme.CHART_COLORS.light);
});

check('buildGpuChartOpts: 未知主题 -> 回退 CHART_COLORS.dark', () => {
  const r = simulateBuildGpuChartOpts('neon');
  assert.deepStrictEqual(r.colors, theme.CHART_COLORS.dark, '未知主题应回退 dark 配色');
});

// ---- 3. gpu-chart.js 缺省回退: 不传 opts.colors 仍用深色常量 (旧调用不破坏) ----
check('gpu-chart: 缺省 colors -> SVG 使用深色常量 (旧调用不破坏)', () => {
  const GpuChart = require('../src/gpu-chart');
  const pts = [{ t: 1000, util: 50, memPct: 30 }, { t: 2000, util: 60, memPct: 40 }];
  const svg = GpuChart.buildGpuChartSvg(pts);
  assert.ok(svg.includes('#4f8cff'), 'util 曲线应使用深色常量 #4f8cff');
  assert.ok(svg.includes('#3ecf8e'), 'mem 曲线应使用深色常量 #3ecf8e');
});

check('gpu-chart: 注入 light 配色 -> SVG 使用浅色配色', () => {
  const GpuChart = require('../src/gpu-chart');
  const pts = [{ t: 1000, util: 50, memPct: 30 }, { t: 2000, util: 60, memPct: 40 }];
  const svg = GpuChart.buildGpuChartSvg(pts, { colors: theme.CHART_COLORS.light });
  assert.ok(svg.includes(theme.CHART_COLORS.light.util), 'util 应使用 light 配色');
  assert.ok(svg.includes(theme.CHART_COLORS.light.mem), 'mem 应使用 light 配色');
  assert.ok(!svg.includes('#4f8cff'), 'light 下不应残留深色 util 常量');
});

// ---- 4. getTerminals 去重审查: renderer 注入逻辑按 term 对象去重 ----
check('renderer getTerminals: 按 term 对象身份去重 (Set)', () => {
  const m = rendererSrc.match(/getTerminals:\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\},\s*\n\s*button/);
  assert.ok(m, '未找到 getTerminals 注入块');
  const block = m[0];
  assert.ok(block.includes('new Set()'), '应使用 Set 去重');
  assert.ok(block.includes('seen.has(s.term)'), '应按 s.term 去重');
  assert.ok(block.includes('seen.add(s.term)'), '应记录已见 term');
});

// 模拟执行 getTerminals 去重逻辑: 同一 term 被两个 session 引用只返回一次
check('getTerminals 去重行为: 同 term 多 session 引用只返回一次', () => {
  // 从 renderer.js 提取 getTerminals 注入函数体
  const fnM = rendererSrc.match(/getTerminals:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\n\s*button/);
  assert.ok(fnM, '无法提取 getTerminals 函数体');
  const body = fnM[1];
  const termA = { id: 'termA' };
  const termB = { id: 'termB' };
  const sessions = new Map([
    ['s1', { sessionId: 's1', connId: 'c1', term: termA }],
    ['s2', { sessionId: 's2', connId: 'c1', term: termA }], // 同一 term 双 session (connId 同)
    ['s3', { sessionId: 's3', connId: 'c2', term: termB }],
  ]);
  const fn = new Function('sessions', '"use strict"; return (function() {' + body + '\n});');
  const terms = fn(sessions)();
  assert.strictEqual(terms.length, 2, '应去重为 2 个实例');
  assert.strictEqual(terms[0], termA);
  assert.strictEqual(terms[1], termB);
});

console.log('\n主题深比较验证完成: ' + passed + ' 通过, ' + failed + ' 失败');
if (failed > 0) process.exitCode = 1;
