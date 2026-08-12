/**
 * NimbusSSH 操作日志面板关闭按钮位置回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/audit-closebtn-test.js
 * 需求 (Roadmap 任务 1): 关闭按钮与「操作日志」标题同行右侧 (右上角), 符合常规弹窗交互。
 * 实现: 关闭按钮放入 .audit-header-actions (h3 的同行右侧), .modal-header flex
 *       space-between 将其推至最右; 筛选行 (.audit-filters, width:100%) 换行到第二行。
 * 断言 (静态, 视实现选最简断言):
 *   1. #auditCloseBtn 存在于 .audit-header 内部
 *   2. 关闭按钮与标题 h3 同级 (位于 .audit-header-actions 内, 而非 .audit-filters 内)
 *   3. 关闭按钮 DOM 顺序在 h3 之后、筛选行之前 (同行右侧)
 *   4. style.css 提供 .audit-header-actions flex 布局 (display:flex + flex-shrink:0)
 *   5. 不依赖新增 JS: #auditCloseBtn 仍保留原 id/class, renderer 绑定无需改动
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + ((err && err.stack) || err));
  }
}

// 简易 HTML 标签解析辅助: 提取 <tag ...> 内联属性 (用于定位 id 所在行)
function lineOf(substr) {
  const idx = html.indexOf(substr);
  assert.ok(idx >= 0, `index.html 中未找到: ${substr}`);
  return html.slice(0, idx).split('\n').length;
}

function run() {
  // ---------- 1. 关闭按钮存在且位于 .audit-header 内 ----------
  test('#auditCloseBtn 存在于 .audit-header 内部', () => {
    const headerStart = html.indexOf('class="modal-header audit-header"');
    assert.ok(headerStart >= 0, '.audit-header 不存在');
    const headerEnd = html.indexOf('</div>', headerStart);
    const headerBlock = html.slice(headerStart, headerEnd);
    assert.ok(headerBlock.includes('id="auditCloseBtn"'), '.audit-header 内未找到 #auditCloseBtn');
    // 必须在整个 audit 面板内 (与 auditOverlay 同级容器内)
    assert.ok(html.includes('id="auditCloseBtn"'), 'index.html 中不存在 #auditCloseBtn');
  });

  // ---------- 2. 关闭按钮与标题同级 (不在 .audit-filters 内) ----------
  test('关闭按钮与 h3 同级, 不在 .audit-filters 内', () => {
    // 提取 .audit-header 片段
    const headerStart = html.indexOf('class="modal-header audit-header"');
    const headerEnd = html.indexOf('class="audit-body"');
    assert.ok(headerStart >= 0 && headerEnd > headerStart, '.audit-header 片段提取失败');
    const headerBlock = html.slice(headerStart, headerEnd);

    // h3 与关闭按钮都直接位于 header 顶层 (按钮在 .audit-header-actions 容器内, 与 h3 是兄弟层级)
    assert.ok(/<h3>操作日志<\/h3>/.test(headerBlock), '标题 h3 不存在');
    const btnIdx = headerBlock.indexOf('id="auditCloseBtn"');
    const filtersIdx = headerBlock.indexOf('class="audit-filters"');
    assert.ok(btnIdx >= 0, '关闭按钮不在 header 内');
    assert.ok(filtersIdx >= 0, '筛选容器 .audit-filters 不存在');
    // 关闭按钮位置在 .audit-filters 声明之前 -> 位于标题行, 不被筛选行挤到下一行
    assert.ok(btnIdx < filtersIdx, '关闭按钮必须出现在 .audit-filters 之前 (标题行右侧)');
  });

  // ---------- 3. 关闭按钮与 h3 同行 (h3 之后、筛选行之前) ----------
  test('关闭按钮 DOM 顺序: h3 -> 关闭按钮 -> 筛选行', () => {
    const headerStart = html.indexOf('class="modal-header audit-header"');
    const headerEnd = html.indexOf('class="audit-body"');
    const headerBlock = html.slice(headerStart, headerEnd);
    const h3Idx = headerBlock.indexOf('<h3>操作日志</h3>');
    const btnIdx = headerBlock.indexOf('id="auditCloseBtn"');
    const filtersIdx = headerBlock.indexOf('class="audit-filters"');
    assert.ok(h3Idx >= 0 && btnIdx > h3Idx, '关闭按钮必须在标题之后');
    assert.ok(btnIdx < filtersIdx, '关闭按钮必须在筛选行之前 (保证与标题同行)');
  });

  // ---------- 4. CSS 提供 .audit-header-actions flex 布局 ----------
  test('style.css 提供 .audit-header-actions (display:flex + flex-shrink:0)', () => {
    assert.ok(css.includes('.audit-header-actions'), '缺少 .audit-header-actions 规则');
    const ruleStart = css.indexOf('.audit-header-actions');
    const ruleBlock = css.slice(ruleStart, ruleStart + 200);
    assert.ok(/display:\s*flex/.test(ruleBlock), '.audit-header-actions 未设置 display:flex');
    assert.ok(/flex-shrink:\s*0/.test(ruleBlock), '.audit-header-actions 未设置 flex-shrink:0');
  });

  // ---------- 5. 标题行两端对齐依赖 .modal-header space-between ----------
  test('.modal-header 提供 justify-content: space-between (标题行两端对齐)', () => {
    assert.ok(css.includes('.modal-header {'), '缺少 .modal-header 规则');
    const ruleStart = css.indexOf('.modal-header {');
    const ruleBlock = css.slice(ruleStart, ruleStart + 300);
    assert.ok(/justify-content:\s*space-between/.test(ruleBlock), '.modal-header 未设置 space-between');
  });

  // ---------- 6. 不新增 JS 依赖: 按钮 id/class 复用 ----------
  test('#auditCloseBtn 保留原 id/class (modal-close), renderer 绑定可复用', () => {
    assert.ok(/<button class="icon-btn modal-close" id="auditCloseBtn"/.test(html), '关闭按钮 class 或 id 被改动');
    // renderer.js 仍绑定该 id
    const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(renderer.includes("$('#auditCloseBtn').addEventListener('click', closeAuditPanel)"), 'renderer 对 auditCloseBtn 的绑定丢失');
  });

  // ---------- 7. 遮罩点击 / Esc 关闭交互保留 ----------
  test('遮罩点击 / Esc 关闭交互保留 (renderer 未删 auditOverlay/Esc 分支)', () => {
    const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(renderer.includes("$('#auditOverlay').addEventListener('click'"), 'auditOverlay 遮罩点击关闭丢失');
    assert.ok(renderer.includes("closeAuditPanel()"), 'closeAuditPanel 引用丢失');
    assert.ok(renderer.includes("if ($('#auditOverlay').style.display === 'flex') {"), 'Esc 关闭 audit 分支丢失');
  });

  console.log(`\naudit-closebtn-test: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
