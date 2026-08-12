#!/usr/bin/env node
/**
 * NimbusSSH - Roadmap ③ SFTP 拖拽上传 安全闸门补充验证 (QA 独立编写, node 直跑)
 *
 * 目标: 对 dragdrop-test.js 未覆盖的主进程「登记→消费」机制做补充验证:
 *   1) sftp:registerUploadPaths 登记入口安全性 (提取 main.js 真实 handler, vm 沙箱执行):
 *      - 目录被拒 / 不存在被拒 / 重复被拒 / 非字符串与空串被拒 / 非数组参数返回失败
 *      - 单次登记上限 500 (超上限截断, 不膨胀 Set)
 *   2) 登记后 sftp:upload 消费 (提取 main.js 真实 sftpUpload, vm 沙箱执行):
 *      - 未登记路径被拒 ('路径未经过确认')
 *      - 登记后上传守卫放行且消费即删 (approvedLocalPaths 移除)
 *      - 消费后同一路径再次上传被拒 (防重放)
 *   3) 渲染层拖拽未连接会话 -> 忽略且无任何 IPC 调用
 *      (sftpRegisterUploadPaths / sftpUpload 均不触发)
 *
 * 用法: node tests/qa-supplemental-dragdrop.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const mainSrc = read('main.js');
const rendererSrc = read('src/renderer.js');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

// 从源码提取从 marker 开始的完整代码块 (花括号配平)
function extractBlock(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const start = src.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(idx, i + 1);
}

// 提取箭头函数调用 (签名可能含解构, 先定位 => 再取函数体; 补上调用收尾右括号)
function extractArrowBlock(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const arrowIdx = src.indexOf('=>', idx);
  if (arrowIdx < 0) return null;
  const start = src.indexOf('{', arrowIdx);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  // 函数体结束后补上调用语句的收尾右括号 (ipcMain.handle(..., fn) 的 ')')
  const closeParen = src.indexOf(')', i + 1);
  const end = closeParen > i ? closeParen + 1 : i + 1;
  return src.slice(idx, end);
}

// 渲染层最小沙箱 (与 dragdrop-test 同构, 增加 IPC 调用计数)
function makeRendererSandbox() {
  function makeFakeEl() {
    const classes = new Set();
    return {
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const add = force === undefined ? !classes.has(c) : !!force;
          if (add) classes.add(c); else classes.delete(c);
          return add;
        },
      },
      _classes: classes,
      appendChild() { return this; },
      remove() {},
      addEventListener() {},
      closest() { return null; },
      querySelector() { return null; },
      set innerHTML(v) {}, // eslint-disable-line no-unused-vars
      get innerHTML() { return ''; },
    };
  }
  const bodyEl = makeFakeEl();
  const documentMock = {
    querySelector: () => bodyEl,
    querySelectorAll: () => [],
    createElement: () => makeFakeEl(),
    addEventListener: () => {},
    body: bodyEl,
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { addEventListener: () => {}, nimbus: {} },
    document: documentMock,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { platform: 'test' },
    confirm: () => true,
    alert: () => {},
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(rendererSrc, ctx, { filename: 'src/renderer.js' });
  return { ctx, sandbox };
}

async function main() {
  // ---------- 临时文件布局 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-dd-qa-'));
  const f1 = path.join(tmp, 'ok1.txt');
  const f2 = path.join(tmp, 'ok2.txt');
  fs.writeFileSync(f1, 'x');
  fs.writeFileSync(f2, 'y');
  const dir = path.join(tmp, 'subdir');
  fs.mkdirSync(dir);
  const missing = path.join(tmp, 'missing.txt');

  // ---------- 1) 登记入口安全性 (真实 handler) ----------
  section('登记入口安全性: sftp:registerUploadPaths (真实 main.js handler)');
  let regHandler = null;
  const approvedLocalPaths = new Set();
  const mainSandbox = {
    console,
    fs,
    approvedLocalPaths,
    ipcMain: { handle: (ch, fn) => { if (ch === 'sftp:registerUploadPaths') regHandler = fn; } },
  };
  const mainCtx = vm.createContext(mainSandbox);
  // handler 签名含解构 { paths }, 需先定位箭头 => 再取函数体起始花括号
  const handlerSrc = extractArrowBlock(mainSrc, "ipcMain.handle('sftp:registerUploadPaths', (e, { paths }) => {");
  check('提取真实 sftp:registerUploadPaths handler', !!handlerSrc);
  if (!handlerSrc) { failed++; return; }
  vm.runInContext(handlerSrc, mainCtx, { filename: 'main.js' });
  check('handler 已注册到 ipcMain', typeof regHandler === 'function');

  // 正常文件登记
  let r = regHandler({}, { paths: [f1, f2] });
  check('正常文件登记成功', r.ok === true && r.count === 2 && r.accepted.length === 2);
  check('登记写入 approvedLocalPaths', approvedLocalPaths.has(f1) && approvedLocalPaths.has(f2));

  // 目录被拒
  const beforeDir = approvedLocalPaths.size;
  r = regHandler({}, { paths: [dir] });
  check('目录被拒 (不登记)', r.ok === true && r.count === 0 && !approvedLocalPaths.has(dir) && approvedLocalPaths.size === beforeDir);

  // 不存在被拒
  const beforeMiss = approvedLocalPaths.size;
  r = regHandler({}, { paths: [missing] });
  check('不存在路径被拒', r.ok === true && r.count === 0 && !approvedLocalPaths.has(missing) && approvedLocalPaths.size === beforeMiss);

  // 已登记重复被拒
  r = regHandler({}, { paths: [f1] });
  check('已登记重复被拒 (count=0)', r.ok === true && r.count === 0);

  // 同一数组内重复只计一次
  r = regHandler({}, { paths: [f1, f1, f2, f2] });
  check('数组内重复只计一次 (已登记全跳过)', r.ok === true && r.count === 0);

  // 非字符串 / 空串被拒 (用全新文件验证, 避免与已登记重复干扰)
  const f4 = path.join(tmp, 'mixed.txt');
  fs.writeFileSync(f4, 'm');
  r = regHandler({}, { paths: [123, '', null, undefined, f4] });
  check('非字符串/空串被拒, 仅合法路径计数', r.ok === true && r.count === 1 && r.accepted.length === 1 && r.accepted[0] === f4);

  // 非数组参数
  r = regHandler({}, { paths: 'not-array' });
  check('非数组参数返回失败', r.ok === false);

  // 上限 500: 构造 510 个真实文件, 仅登记前 500
  const many = [];
  for (let i = 0; i < 510; i++) {
    const p = path.join(tmp, `bulk_${i}.txt`);
    fs.writeFileSync(p, String(i));
    many.push(p);
  }
  const beforeCap = approvedLocalPaths.size;
  r = regHandler({}, { paths: many });
  check('超 500 上限被截断 (accepted=500)', r.ok === true && r.count === 500 && r.accepted.length === 500);
  check('Set 未膨胀超过 500 增量', approvedLocalPaths.size - beforeCap === 500);
  const last500 = many[499]; // 第 500 个 (index 499) 应已登记
  const firstOver = many[500]; // 第 501 个 (index 500) 应被截断
  check('第 500 个边界已登记', approvedLocalPaths.has(last500));
  check('第 501 个起被截断 (未登记)', !approvedLocalPaths.has(firstOver));

  // ---------- 2) 消费即删 + 防重放 (真实 sftpUpload) ----------
  section('登记后 sftp:upload 消费: 消费即删 + 防重放 (真实 main.js sftpUpload)');
  let getSftpCalls = 0;
  mainSandbox.getSftp = async () => { getSftpCalls++; throw new Error('AFTER-GUARD'); };
  const uploadSrc = extractBlock(mainSrc, 'async function sftpUpload(winId, sessionId, localPath, remotePath) {');
  check('提取真实 sftpUpload 函数', !!uploadSrc);
  if (!uploadSrc) { failed++; return; }
  vm.runInContext(uploadSrc, mainCtx, { filename: 'main.js' });

  // 未登记路径 -> 拒绝, 不触达 getSftp
  getSftpCalls = 0;
  const unreg = await mainCtx.sftpUpload(1, 's1', path.join(tmp, 'unregistered.txt'), '/tmp/u.txt');
  check('未登记路径被拒 (路径未经过确认)', unreg.ok === false && unreg.error === '路径未经过确认');
  check('拒绝时未触达 SFTP 通道', getSftpCalls === 0);

  // 登记 -> 上传守卫放行 (消费即删), getSftp 被触达证明守卫通过
  const f3 = path.join(tmp, 'consume.txt');
  fs.writeFileSync(f3, 'consume');
  regHandler({}, { paths: [f3] });
  check('登记后 approvedLocalPaths 含 f3', approvedLocalPaths.has(f3));
  getSftpCalls = 0;
  try {
    await mainCtx.sftpUpload(1, 's1', f3, '/tmp/consume.txt');
    check('登记后上传守卫放行并调用 getSftp', true); // 若未放行会返回 ok:false 且不抛
  } catch (err) {
    check('登记后上传守卫放行并调用 getSftp', err && err.message === 'AFTER-GUARD');
  }
  check('消费后 approvedLocalPaths 已移除 f3 (消费即删)', !approvedLocalPaths.has(f3));
  check('守卫放行后触达 SFTP 通道', getSftpCalls === 1);

  // 消费后再次上传同一路径 -> 防重放拒绝
  getSftpCalls = 0;
  const replay = await mainCtx.sftpUpload(1, 's1', f3, '/tmp/consume.txt');
  check('消费后复用被拒 (防重放)', replay.ok === false && replay.error === '路径未经过确认');
  check('防重放拒绝未触达 SFTP 通道', getSftpCalls === 0);

  // ---------- 3) 渲染层未连接 drop -> 无 IPC ----------
  section('渲染层: 未连接会话 drop -> 忽略且无任何 IPC 调用');
  {
    const sb = makeRendererSandbox();
    const calls = { register: 0, upload: 0 };
    sb.sandbox.window.nimbus = {
      getPathForFile: (file) => 'C:/' + file.name,
      sftpRegisterUploadPaths: async () => { calls.register++; return { ok: true, count: 0, accepted: [] }; },
      sftpUpload: async () => { calls.upload++; return { ok: true }; },
    };
    sb.sandbox.toast = () => {};
    sb.sandbox.loadDir = async () => {};
    // 无任何会话
    const evt = { preventDefault: () => {}, dataTransfer: { files: [{ name: 'a.txt' }], items: [] } };
    await vm.runInContext('handleSftpDrop', sb.ctx)(evt);
    check('未连接 drop 不调用 sftpRegisterUploadPaths', calls.register === 0, 'got ' + calls.register);
    check('未连接 drop 不调用 sftpUpload', calls.upload === 0, 'got ' + calls.upload);
  }

  // 清理临时目录
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

  // ---------- 汇总 ----------
  console.log(`\n==== 补充验证结果: ${passed} 通过, ${failed} 失败 ====`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(2);
});
