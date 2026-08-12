/**
 * QA 补充验证: style.css 变量集完备性 (Roadmap P2 浅色/深色主题)
 * ============================================================
 * 1. 收集 style.css 中全部 var(--x) 引用
 * 2. 断言 :root[data-theme="dark"] 与默认 :root 都定义了所有引用变量
 * 3. 断言 :root[data-theme="dark"] 兜底值 == 默认 :root 值 (深色外观零变化)
 * 4. 断言 :root[data-theme="light"] 定义了所有引用变量
 * 5. 未设置 data-theme 时保持纯深色 (默认 :root 即深色, 兼容旧版)
 * 运行: node tests/qa-theme-css-verify.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'src', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');

// ---- 1. 提取所有 var(--x) 引用 (含 var(--x, fallback) 形式) ----
const varRefs = new Set();
const refRe = /var\(\s*(--[\w-]+)/g;
let m;
while ((m = refRe.exec(css)) !== null) varRefs.add(m[1]);

// ---- 2. 提取三个变量块 ----
// 默认 :root (含 :root, :root[data-theme="dark"] 联合选择器)
function extractVars(selectorRe) {
  const blocks = [];
  const re = new RegExp(selectorRe + '\\s*\\{([^}]*)\\}', 'g');
  let match;
  while ((match = re.exec(css)) !== null) blocks.push(match[1]);
  const vars = {};
  for (const block of blocks) {
    const varRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let vm;
    while ((vm = varRe.exec(block)) !== null) vars[vm[1]] = vm[2].trim();
  }
  return vars;
}

// 默认 :root 与 :root[data-theme="dark"] 是联合选择器, 提取时需把两组都算上再合并
// 注意: 文件中是 `:root, :root[data-theme="dark"] { ... }` 单块, 直接匹配该块即可
const defaultBlockMatch = css.match(/:root\s*,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
assert.ok(defaultBlockMatch, '未找到 `:root, :root[data-theme="dark"]` 联合块');
const defaultVars = {};
{
  const varRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let vm;
  while ((vm = varRe.exec(defaultBlockMatch[1])) !== null) defaultVars[vm[1]] = vm[2].trim();
}

const lightMatch = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/);
assert.ok(lightMatch, '未找到 :root[data-theme="light"] 块');
const lightVars = {};
{
  const varRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let vm;
  while ((vm = varRe.exec(lightMatch[1])) !== null) lightVars[vm[1]] = vm[2].trim();
}

// 显式独立 :root[data-theme="dark"] 兜底块 (若存在, 用于二次校验)
const darkOnlyMatch = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const darkOnlyVars = {};
if (darkOnlyMatch) {
  const varRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let vm;
  while ((vm = varRe.exec(darkOnlyMatch[1])) !== null) darkOnlyVars[vm[1]] = vm[2].trim();
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (err) { failed++; console.error('  \u2717 ' + name); console.error('    ' + err.message); }
}

console.log('CSS 变量引用总数: ' + varRefs.size);
console.log('默认 :root 定义: ' + Object.keys(defaultVars).length);
console.log('light 定义: ' + Object.keys(lightVars).length);

// ---- 3. 断言默认 :root 定义了全部引用变量 ----
check('默认 :root 定义全部 var() 引用变量', () => {
  const missing = [...varRefs].filter((v) => !(v in defaultVars));
  assert.deepStrictEqual(missing, [], '默认 :root 缺少: ' + missing.join(', '));
});

// ---- 4. 断言 light 定义了全部引用变量 ----
check('浅色 :root[data-theme="light"] 定义全部 var() 引用变量', () => {
  const missing = [...varRefs].filter((v) => !(v in lightVars));
  assert.deepStrictEqual(missing, [], 'light 缺少: ' + missing.join(', '));
});

// ---- 5. 断言 dark 兜底值 == 默认 :root 值 (深色外观零变化) ----
check(':root[data-theme="dark"] 联合块与默认 :root 值一致 (深色零变化)', () => {
  // 联合块即默认块, 此处校验文件里确实是用联合选择器而非独立兜底
  assert.ok(defaultBlockMatch, 'dark 兜底应为联合选择器 `:root, :root[data-theme="dark"]`');
});

// 若存在独立 dark 块, 校验其值 == 默认块值
if (darkOnlyVars) {
  check('独立 :root[data-theme="dark"] 块值与默认 :root 一致', () => {
    const diffs = [];
    for (const k of Object.keys(defaultVars)) {
      if (darkOnlyVars[k] !== undefined && darkOnlyVars[k] !== defaultVars[k]) diffs.push(k + ': ' + darkOnlyVars[k] + ' != ' + defaultVars[k]);
    }
    assert.deepStrictEqual(diffs, [], 'dark 独立块差异: ' + diffs.join('; '));
  });
}

// ---- 6. 新旧硬编码色主题化: 深色值 == 原硬编码值 (抽查) ----
check('主题化变量深色值与原硬编码色一致 (抽查关键项)', () => {
  const expectations = {
    '--scroll-thumb': '#2d3542',
    '--scroll-thumb-hover': '#3a4454',
    '--overlay-mask': 'rgba(5, 8, 12, 0.65)',
    '--preview-stage-bg': 'rgba(0, 0, 0, 0.25)',
    '--preview-img-bg': '#000',
    '--nav-btn-bg': 'rgba(20, 26, 34, 0.75)',
    '--btn-ghost-hover': '#2a3340',
    '--pdf-stage-bg': '#0a0d12',
    '--sftp-loading-bg': 'rgba(14, 17, 22, 0.6)',
    '--shadow-top': '0 -10px 30px rgba(0, 0, 0, 0.4)',
  };
  const diffs = [];
  for (const [k, v] of Object.entries(expectations)) {
    if (defaultVars[k] !== v) diffs.push(k + '=' + defaultVars[k] + ' (期望 ' + v + ')');
  }
  assert.deepStrictEqual(diffs, [], '深色值不一致: ' + diffs.join('; '));
});

// ---- 7. 未设置 data-theme 时保持纯深色: 默认 :root 变量值即深色 ----
check('未设置 data-theme 时默认变量集为深色 (兼容旧版)', () => {
  assert.strictEqual(defaultVars['--bg'], '#0e1116');
  assert.strictEqual(defaultVars['--text'], '#e6eaf0');
  assert.strictEqual(defaultVars['--accent'], '#4f8cff');
});

// ---- 8. light 关键变量抽查 (VSCode Light 风格) ----
check('light 关键变量抽查 (VSCode Light 风格)', () => {
  assert.strictEqual(lightVars['--bg'], '#ffffff');
  assert.strictEqual(lightVars['--bg-sidebar'], '#f3f4f6');
  assert.strictEqual(lightVars['--text'], '#1f2430');
  assert.strictEqual(lightVars['--accent'], '#2f6fed');
});

console.log('\nCSS 变量验证完成: ' + passed + ' 通过, ' + failed + ' 失败');
if (failed > 0) process.exitCode = 1;
