#!/usr/bin/env node
/**
 * FgmSSH - Roadmap ③ SFTP 拖拽上传 测试 (node 直跑, 无需 Electron)
 *
 * 1) 静态断言 (读取真实源码):
 *    - preload.js  暴露 getPathForFile (webUtils.getPathForFile) 与 sftpRegisterUploadPaths
 *    - main.js     提供 sftp:registerUploadPaths 且仅登记存在的普通文件到 approvedLocalPaths
 *    - src/renderer.js 绑定 dragenter/dragover/dragleave/drop、高亮类 sftp-drop-active、
 *                      getPathForFile 取路径、登记后复用 uploadLocalPaths (无重复上传循环)
 *    - src/style.css 含 .sftp-panel.sftp-drop-active
 *    - src/index.html 空目录提示文案 sftp-drop-hint
 * 2) 逻辑测试 (vm 沙箱运行真实 renderer.js 函数, mock window.nimbus / document):
 *    - uploadLocalPaths 串行上传 + 失败 toast + 成功 toast + 目录刷新
 *    - 会话中途关闭 -> 停止后续上传
 *    - 空文件列表 -> 直接返回 0
 *    - handleSftpDrop 未连接 -> 忽略 + toast, 不触发上传
 *    - handleSftpDrop 多文件 -> 取路径/去重/目录忽略/登记/串行上传
 *    - 上传进行中二次 drop -> 忽略 (busy guard)
 *    - dragenter 高亮开关 (已连接加高亮, 未连接不加)
 *
 * 用法: node tests/dragdrop-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');

const preloadSrc = read('preload.js');
const mainSrc = read('main.js');
const rendererSrc = read('src/renderer.js');
const cssSrc = read('src/style.css');
const htmlSrc = read('src/index.html');

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

// 提取源码中指定函数的完整文本 (含函数签名, 花括号配平)
function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

// 构造可运行真实 renderer.js 的 vm 沙箱 (仅需加载期即可用的最小 DOM 桩)
function makeSandbox() {
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

// 在沙箱内执行表达式并返回结果 (可访问 renderer 内部的 let/const 绑定)
function evalIn(sandboxBox, code) {
  return vm.runInContext(code, sandboxBox.ctx);
}

async function main() {
  // ================= 静态断言 =================
  section('静态断言: preload.js (取路径 + 登记桥接)');
  check('preload 引入 webUtils', /const\s*\{\s*contextBridge,\s*ipcRenderer,\s*webUtils\s*\}\s*=\s*require\(['"]electron['"]\)/.test(preloadSrc));
  check('preload 暴露 getPathForFile', /getPathForFile:\s*\(file\)\s*=>/.test(preloadSrc));
  check('getPathForFile 同步调用 webUtils.getPathForFile', /webUtils\.getPathForFile\(file\)/.test(preloadSrc));
  check('getPathForFile 异常兜底返回空串', /catch\s*\(err\)\s*\{\s*return\s*['"]{2};?\s*\}/.test(preloadSrc));
  check('preload 暴露 sftpRegisterUploadPaths', /sftpRegisterUploadPaths:\s*\(paths\)\s*=>/.test(preloadSrc));
  check('登记通道指向 sftp:registerUploadPaths', /sftp:registerUploadPaths/.test(preloadSrc));

  section('静态断言: main.js (路径登记安全入口)');
  check('main 注册 sftp:registerUploadPaths handler', /ipcMain\.handle\(['"]sftp:registerUploadPaths['"]/.test(mainSrc));
  check('登记前用 fs.statSync 校验', /fs\.statSync\(p\)/.test(mainSrc));
  check('仅登记普通文件 (过滤目录)', /st\.isFile\(\)/.test(mainSrc));
  check('登记写入 approvedLocalPaths', /approvedLocalPaths\.add\(p\)/.test(mainSrc));
  check('返回 accepted 列表供渲染层消费', /return\s*\{\s*ok:\s*true,\s*count:\s*accepted\.length,\s*accepted\s*\}/.test(mainSrc));

  section('静态断言: src/renderer.js (拖拽交互)');
  check('绑定 dragenter', /addEventListener\(['"]dragenter['"],\s*onSftpDragEnter\)/.test(rendererSrc));
  check('绑定 dragover', /addEventListener\(['"]dragover['"],\s*onSftpDragOver\)/.test(rendererSrc));
  check('绑定 dragleave', /addEventListener\(['"]dragleave['"],\s*onSftpDragLeave\)/.test(rendererSrc));
  check('绑定 drop', /addEventListener\(['"]drop['"],\s*handleSftpDrop\)/.test(rendererSrc));
  check('高亮类 sftp-drop-active 存在', /sftp-drop-active/.test(rendererSrc));
  check('调用 window.nimbus.getPathForFile 取路径', /window\.nimbus\.getPathForFile\(file\)/.test(rendererSrc));
  check('调用 window.nimbus.sftpRegisterUploadPaths 登记', /window\.nimbus\.sftpRegisterUploadPaths\(localPaths\)/.test(rendererSrc));
  check('声明共享串行上传函数 uploadLocalPaths', /async\s+function\s+uploadLocalPaths\s*\(/.test(rendererSrc));
  check('拖拽未连接守卫 currentSftpSession()', /if\s*\(!currentSftpSession\(\)\)\s*return/.test(rendererSrc));
  check('busy guard sftpDragUploading', /sftpDragUploading/.test(rendererSrc));
  check('init 中接入 initSftpDragDrop()', /initSftpDragDrop\(\);/.test(rendererSrc));
  check('全局阻止页面默认拖放行为', /window\.addEventListener\(['"]dragover['"],\s*\(e\)\s*=>\s*e\.preventDefault\(\)\)/.test(rendererSrc));

  section('静态断言: 无重复上传逻辑 (复用 uploadLocalPaths)');
  const triggerFn = extractFunction(rendererSrc, 'triggerUpload');
  check('triggerUpload 可提取', !!triggerFn);
  if (triggerFn) {
    check('triggerUpload 复用 uploadLocalPaths(session, res.paths)', /uploadLocalPaths\(session,\s*res\.paths\)/.test(triggerFn));
    check('triggerUpload 不再内联 sftpUpload 循环', !/window\.nimbus\.sftpUpload/.test(triggerFn));
  }
  const dropFn = extractFunction(rendererSrc, 'handleSftpDrop');
  check('handleSftpDrop 可提取', !!dropFn);
  if (dropFn) {
    check('handleSftpDrop 复用 uploadLocalPaths(session, accepted)', /uploadLocalPaths\(session,\s*accepted\)/.test(dropFn));
    check('handleSftpDrop 不内联 sftpUpload (走共享链路)', !/window\.nimbus\.sftpUpload/.test(dropFn));
  }

  section('静态断言: src/style.css + src/index.html');
  check('style 含 .sftp-panel.sftp-drop-active', /\.sftp-panel\.sftp-drop-active/.test(cssSrc));
  check('style 高亮使用主题色 outline', /outline:\s*2px\s+dashed\s+var\(--accent\)/.test(cssSrc));
  check('index.html 空目录拖拽提示 sftp-drop-hint', /sftp-drop-hint/.test(htmlSrc));

  // ================= 逻辑测试 =================
  section('逻辑: uploadLocalPaths 串行 + 失败/成功 toast + 目录刷新');
  {
    const sb = makeSandbox();
    const calls = [];
    const toasts = [];
    let loaded = null;
    sb.sandbox.window.nimbus.sftpUpload = async (sid, local, remote) => {
      calls.push({ sid, local, remote });
      return remote.endsWith('b.txt') ? { ok: false, error: 'BOOM' } : { ok: true };
    };
    sb.sandbox.toast = (msg, type) => toasts.push({ msg, type });
    sb.sandbox.loadDir = async (sid, p) => { loaded = { sid, p }; };
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/home/u" }); currentSftpSessionId = "s1";`);
    const ret = await evalIn(sb, `uploadLocalPaths(sessions.get("s1"), ["C:/a.txt", "C:/b.txt"])`);
    check('返回成功数 = 1', ret === 1, 'got ' + ret);
    check('串行调用 2 次且顺序正确', calls.length === 2 && calls[0].local === 'C:/a.txt' && calls[1].local === 'C:/b.txt');
    check('remotePath 拼接当前目录', calls.every((c) => c.remote.startsWith('/home/u/')));
    check('失败 toast 展示错误', toasts.some((t) => t.type === 'error' && t.msg.includes('BOOM')));
    check('成功 toast 汇总数量', toasts.some((t) => t.type === 'success' && t.msg.includes('已上传 1 个文件')));
    check('成功后刷新当前目录', !!loaded && loaded.p === '/home/u');
  }

  section('逻辑: 会话中途关闭 -> 停止后续上传');
  {
    const sb = makeSandbox();
    const calls = [];
    sb.sandbox.window.nimbus.sftpUpload = async (sid, local, remote) => {
      calls.push(local);
      evalIn(sb, 'sessions.delete("s1")'); // 模拟首个文件上传期间会话关闭
      return { ok: true };
    };
    sb.sandbox.toast = () => {};
    sb.sandbox.loadDir = async () => {};
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/home/u" });`);
    await evalIn(sb, `uploadLocalPaths(sessions.get("s1"), ["C:/a.txt", "C:/b.txt", "C:/c.txt"])`);
    check('仅上传 1 个文件即停止', calls.length === 1 && calls[0] === 'C:/a.txt', 'got ' + calls.length);
  }

  section('逻辑: 空文件列表 -> 直接返回 0, 无调用');
  {
    const sb = makeSandbox();
    let uploaded = 0;
    let toasted = 0;
    sb.sandbox.window.nimbus.sftpUpload = async () => { uploaded++; return { ok: true }; };
    sb.sandbox.toast = () => { toasted++; };
    sb.sandbox.loadDir = async () => {};
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/" });`);
    const ret = await evalIn(sb, `uploadLocalPaths(sessions.get("s1"), [])`);
    check('返回 0', ret === 0);
    check('不触发上传', uploaded === 0);
    check('不弹 toast', toasted === 0);
  }

  section('逻辑: handleSftpDrop 未连接 -> 忽略 + toast, 不触发上传');
  {
    const sb = makeSandbox();
    const toasts = [];
    let uploaded = 0;
    sb.sandbox.window.nimbus.sftpUpload = async () => { uploaded++; return { ok: true }; };
    sb.sandbox.toast = (msg, type) => toasts.push({ msg, type });
    sb.sandbox.loadDir = async () => {};
    // 无任何会话 (currentSftpSessionId = null)
    const evt = { preventDefault: () => {}, dataTransfer: { files: [{ name: 'a.txt' }], items: [] } };
    await evalIn(sb, 'handleSftpDrop')(evt);
    check('不触发上传', uploaded === 0);
    check('提示请先连接会话', toasts.some((t) => t.msg.includes('请先连接会话')));
  }

  section('逻辑: handleSftpDrop 多文件 -> 取路径/去重/目录忽略/登记/串行上传');
  {
    const sb = makeSandbox();
    const getPathCalls = [];
    const uploadCalls = [];
    const toasts = [];
    sb.sandbox.window.nimbus = {
      getPathForFile: (file) => {
        getPathCalls.push(file.name);
        return file.name === 'dir' ? 'C:/dir' : 'C:/' + file.name;
      },
      sftpRegisterUploadPaths: async (paths) => {
        const accepted = paths.filter((p) => !p.endsWith('/dir') && !p.endsWith('\\dir'));
        return { ok: true, count: accepted.length, accepted };
      },
      sftpUpload: async (sid, local, remote) => {
        uploadCalls.push({ sid, local, remote });
        return { ok: true };
      },
    };
    sb.sandbox.toast = (msg, type) => toasts.push({ msg, type });
    sb.sandbox.loadDir = async () => {};
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/data" }); currentSftpSessionId = "s1";`);
    const files = [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'dir' }];
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
    ];
    const evt = { preventDefault: () => {}, dataTransfer: { files, items } };
    await evalIn(sb, 'handleSftpDrop')(evt);
    check('对每个 File 调 getPathForFile', getPathCalls.length === 3);
    check('目录被过滤, 只上传 2 个文件', uploadCalls.length === 2, 'got ' + uploadCalls.length);
    check('上传到当前目录 /data', uploadCalls.every((c) => c.remote.startsWith('/data/')));
    check('忽略文件夹 toast', toasts.some((t) => t.msg.includes('已忽略 1 个文件夹')));
    check('busy 标记复位', evalIn(sb, 'sftpDragUploading') === false);
  }

  section('逻辑: 上传进行中二次 drop -> 忽略 (busy guard)');
  {
    const sb = makeSandbox();
    const uploadCalls = [];
    const toasts = [];
    sb.sandbox.window.nimbus = {
      getPathForFile: (file) => 'C:/' + file.name,
      sftpRegisterUploadPaths: async (paths) => ({ ok: true, count: paths.length, accepted: paths }),
      sftpUpload: async (sid, local, remote) => { uploadCalls.push(local); return { ok: true }; },
    };
    sb.sandbox.toast = (msg, type) => toasts.push({ msg, type });
    sb.sandbox.loadDir = async () => {};
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/" }); currentSftpSessionId = "s1"; sftpDragUploading = true;`);
    const evt = { preventDefault: () => {}, dataTransfer: { files: [{ name: 'x.txt' }], items: [] } };
    await evalIn(sb, 'handleSftpDrop')(evt);
    check('不触发上传', uploadCalls.length === 0);
    check('提示稍候', toasts.some((t) => t.msg.includes('仍在进行')));
  }

  section('逻辑: dragenter 高亮开关');
  {
    const sb = makeSandbox();
    const panelEl = sb.sandbox.document.querySelector('#sftpPanel');
    evalIn(sb, `sessions.set("s1", { sessionId: "s1", status: "connected", currentPath: "/" }); currentSftpSessionId = "s1";`);
    const enterEvt = { preventDefault: () => {}, dataTransfer: {} };
    evalIn(sb, 'onSftpDragEnter')(enterEvt);
    check('已连接: dragenter 加高亮类', panelEl.classList.contains('sftp-drop-active'));
    const leaveEvt = { preventDefault: () => {} };
    evalIn(sb, 'onSftpDragLeave')(leaveEvt);
    check('dragleave 移除高亮类', !panelEl.classList.contains('sftp-drop-active'));
    // 未连接时不加高亮
    evalIn(sb, 'currentSftpSessionId = null; sftpDragDepth = 0;');
    evalIn(sb, 'onSftpDragEnter')(enterEvt);
    check('未连接: dragenter 不加高亮类', !panelEl.classList.contains('sftp-drop-active'));
  }

  // ================= 汇总 =================
  console.log(`\n==== 结果: ${passed} 通过, ${failed} 失败 ====`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(2);
});
