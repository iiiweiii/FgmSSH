/**
 * cd-sync-restore-test.js
 * QA 针对性验证: 「右键菜单 cd 进入文件夹 + 终端同步 cd」恢复修复
 *
 * 验证范围:
 *  A. 静态断言 (读取 src/renderer.js 源码文本):
 *     1. 右键菜单 cd 分支 -> enterDir(..., { syncTerminal: true })
 *     2. 双击进入目录 -> enterDir(...) 不带 syncTerminal (仅面板)
 *     3. loadDir 成功回调仅在 opts.syncTerminal===true 时调用 syncTerminalCwd
 *     4. 后退/路径跳转/刷新/mkdir/上传/重命名/R3 cdSync 跟随 均不触发 syncTerminalCwd
 *     5. syncTerminalCwd 注入通道 = window.nimbus.write (不经 term.onData/term.write/term.paste
 *        -> 不触发 R3 旁路 handleTerminalInputLine -> 无反馈回路)
 *     6. 无残留死代码 (syncTerminalCwd 定义 1 处、调用 1 处)
 *  B. 单元断言 (从源码提取真实 syncTerminalCwd 函数, vm 沙箱执行):
 *     1. 单引号转义正确: /home/it's dir -> cd '/home/it'\''s dir'\r
 *     2. 普通路径 / 根路径 / 空路径 安全
 *     3. 终端未就绪 (无 term / 未连接) -> 静默跳过, 不写
 *     4. 竞态守卫 currentPath !== targetPath -> 跳过, 不写
 *     5. IPC 异常 (write reject) -> catch 兜底, 无未处理拒绝
 *     6. session 为空 -> 不抛异常
 *
 * 运行: node tests/cd-sync-restore-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'renderer.js');
const RENDERER = fs.readFileSync(RENDERER_PATH, 'utf8');

let passCount = 0;
let failCount = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 统计字符串出现次数
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

console.log('============================================');
console.log('A. 静态断言 (src/renderer.js 源码文本)');
console.log('============================================');

// ---- A1. 右键菜单 cd 分支 ----
{
  const cdBranch = /action === 'cd'[\s\S]*?enterDir\(session,\s*entry\.name,\s*\{\s*syncTerminal:\s*true\s*\}\)/;
  check('右键菜单 cd 分支调用 enterDir(entry.name, {syncTerminal:true})', cdBranch.test(RENDERER));
  // 同时确认 entry.isDir 校验仍在
  const cdBranchIsDir = /action === 'cd'[\s\S]*?if\s*\(\s*entry\.isDir\s*\)\s*enterDir\(session,\s*entry\.name,\s*\{\s*syncTerminal:\s*true\s*\}\)/;
  check('右键菜单 cd 分支保留 isDir 校验', cdBranchIsDir.test(RENDERER));
}

// ---- A2. 双击进入目录不带 syncTerminal ----
{
  // 双击委托: entry.isDir -> enterDir(session, entry.name) 无第三参
  const dblclick = /addEventListener\('dblclick'[\s\S]*?if\s*\(\s*entry\.isDir\s*\)\s*\{[\s\S]*?enterDir\(session,\s*entry\.name\)\s*;/;
  check('双击进入目录 enterDir 不带 syncTerminal (仅面板)', dblclick.test(RENDERER));
  // 双击分支内不得出现 syncTerminal
  const dblclickBlock = RENDERER.match(/addEventListener\('dblclick'[\s\S]*?enterDir\(session,\s*entry\.name\)[\s\S]{0,120}/);
  check('双击分支无 syncTerminal 字样', !!dblclickBlock && !dblclickBlock[0].includes('syncTerminal'));
}

// ---- A3. loadDir 成功回调仅在 syncTerminal===true 时调用 syncTerminalCwd ----
{
  const guard = /if\s*\(\s*opts\.syncTerminal\s*===\s*true\s*\)\s*\{\s*syncTerminalCwd\(session,\s*res\.path\)\s*;\s*\}/;
  check('loadDir 成功回调 syncTerminal===true 守卫', guard.test(RENDERER));
  // syncTerminalCwd 调用点应恰好 1 处 (loadDir 内), 定义 1 处
  const callCount = countOccurrences(RENDERER, 'syncTerminalCwd(session, res.path)');
  check('syncTerminalCwd 调用点 = 1 (loadDir 内)', callCount === 1, 'count=' + callCount);
  const defCount = countOccurrences(RENDERER, 'function syncTerminalCwd(');
  check('syncTerminalCwd 定义 = 1 (无重复/死代码)', defCount === 1, 'count=' + defCount);
}

// ---- A4. 其他入口不触发 syncTerminalCwd ----
{
  // 所有 loadDir 调用点
  const loadDirCalls = RENDERER.match(/loadDir\([\s\S]*?\)/g) || [];
  // 过滤出带 syncTerminal 的调用
  const syncCalls = loadDirCalls.filter((s) => s.includes('syncTerminal'));
  // 静态断言: 全文件 'syncTerminal: true' 恰好出现 1 次 (仅右键菜单 cd)
  const syncTrueCount = countOccurrences(RENDERER, 'syncTerminal: true');
  check("syncTerminal: true 全文件仅 1 处 (右键菜单 cd)", syncTrueCount === 1, 'count=' + syncTrueCount);
  // goBack 使用 pushHistory:false 而非 syncTerminal
  check('goBack 不触发 syncTerminal', /function goBack[\s\S]*?loadDir\(session\.sessionId,\s*session\.history\[session\.historyIndex\],\s*\{\s*pushHistory:\s*false\s*\}\)/.test(RENDERER));
  // refreshDir 不带 opts
  check('refreshDir 不触发 syncTerminal', /function refreshDir[\s\S]*?loadDir\(session\.sessionId,\s*session\.currentPath\)\s*;/.test(RENDERER));
  // 路径输入框跳转不带 opts
  check('路径输入框跳转不触发 syncTerminal', /addEventListener\('keydown'[\s\S]*?loadDir\(s\.sessionId,\s*p\)/.test(RENDERER));
  // R3 cdSync 跟随 loadDir(session.sessionId, res.path) 不带 opts
  check('R3 终端cd跟随不触发 syncTerminal', /sftpCdSync\(session\.sessionId,\s*rawPath\)[\s\S]*?loadDir\(session\.sessionId,\s*res\.path\)/.test(RENDERER));
}

// ---- A5. syncTerminalCwd 注入通道不经过 term.onData / R3 旁路 ----
{
  const fnSrc = RENDERER.match(/function syncTerminalCwd\(session, targetPath\) \{[\s\S]*?\n\}/);
  check('可提取 syncTerminalCwd 函数体', !!fnSrc);
  if (fnSrc) {
    const body = fnSrc[0];
    check('注入通道为 window.nimbus.write', /window\.nimbus\.write\(session\.sessionId,\s*'cd '\s*\+\s*quoted\s*\+\s*'\\r'\)/.test(body));
    check('不使用 term.write / term.paste', !body.includes('term.write') && !body.includes('term.paste'));
    check('不调用 handleTerminalInputLine (不触发 R3 旁路)', !body.includes('handleTerminalInputLine'));
    check('不调用 sftpCdSync (无面板二次导航)', !body.includes('sftpCdSync'));
    check('使用单引号 shell 转义 (replace(/\'/g, "\'\\\'\'"))', body.includes("targetPath.replace(/'/g, \"'\\\\''\")"));
    check('IPC 异常 catch 兜底', body.includes('.catch(() => {})'));
  }
}

// ---- A6. 其他静态: enterDir 第三参透传 ----
{
  check('enterDir 签名含 opts = {} 第三参', /function enterDir\(session,\s*name,\s*opts\s*=\s*\{\}\)/.test(RENDERER));
  check('enterDir 透传 opts 给 loadDir', /function enterDir[\s\S]*?loadDir\(session\.sessionId,\s*joinRemotePath\(session\.currentPath,\s*name\),\s*opts\)/.test(RENDERER));
}

console.log('');
console.log('============================================');
console.log('B. 单元断言 (提取真实 syncTerminalCwd 执行)');
console.log('============================================');

// 提取真实函数并在 vm 沙箱中执行
const fnMatch = RENDERER.match(/function syncTerminalCwd\(session, targetPath\) \{[\s\S]*?\n\}/);
const sandbox = {
  console,
  window: { nimbus: { write: null } },
};
vm.createContext(sandbox);
vm.runInContext(fnMatch[0], sandbox);
const syncTerminalCwd = sandbox.syncTerminalCwd;

// 构造测试会话
function makeSession(overrides = {}) {
  return Object.assign({
    sessionId: 's_test',
    term: { onData() {} },           // 仅表示 term 存在
    status: 'connected',
    currentPath: '/',
  }, overrides);
}

// 返回一个可捕获 write 调用的 mock
function makeWriteMock(reject = false) {
  const calls = [];
  const mock = (sessionId, data) => {
    calls.push({ sessionId, data });
    return reject ? Promise.reject(new Error('ipc failed')) : Promise.resolve({ ok: true });
  };
  return { calls, mock };
}

(async () => {
  // B1. 单引号转义
  {
    const w = makeWriteMock();
    sandbox.window.nimbus.write = w.mock;
    syncTerminalCwd(makeSession({ currentPath: "/home/it's dir" }), "/home/it's dir");
    check('单引号路径转义正确', w.calls.length === 1 && w.calls[0].data === "cd '/home/it'\\''s dir'\r",
      JSON.stringify(w.calls[0] && w.calls[0].data));
  }

  // B2. 普通路径 / 根路径
  {
    const w1 = makeWriteMock();
    sandbox.window.nimbus.write = w1.mock;
    syncTerminalCwd(makeSession({ currentPath: '/var/www' }), '/var/www');
    check('普通路径', w1.calls.length === 1 && w1.calls[0].data === "cd '/var/www'\r", JSON.stringify(w1.calls[0] && w1.calls[0].data));

    const w2 = makeWriteMock();
    sandbox.window.nimbus.write = w2.mock;
    syncTerminalCwd(makeSession({ currentPath: '/' }), '/');
    check('根路径', w2.calls.length === 1 && w2.calls[0].data === "cd '/'\r", JSON.stringify(w2.calls[0] && w2.calls[0].data));
  }

  // B3. 空路径安全 (不抛异常; 生产路径经 normalizeRemotePath 不会为空)
  {
    const w = makeWriteMock();
    sandbox.window.nimbus.write = w.mock;
    let threw = false;
    try {
      syncTerminalCwd(makeSession({ currentPath: '' }), '');
    } catch (e) {
      threw = true;
    }
    check('空路径不抛异常', !threw && w.calls.length === 1 && w.calls[0].data === "cd ''\r", JSON.stringify(w.calls[0] && w.calls[0].data));
  }

  // B4. 终端未就绪 / 未连接 -> 静默跳过
  {
    const w = makeWriteMock();
    sandbox.window.nimbus.write = w.mock;
    syncTerminalCwd(makeSession({ term: null }), '/x');
    check('无 term 时跳过', w.calls.length === 0);

    syncTerminalCwd(makeSession({ status: 'connecting', currentPath: '/x' }), '/x');
    check('未连接时跳过', w.calls.length === 0);

    syncTerminalCwd(makeSession({ status: 'closed', currentPath: '/x' }), '/x');
    check('已关闭时跳过', w.calls.length === 0);
  }

  // B5. 竞态守卫: currentPath !== targetPath -> 跳过
  {
    const w = makeWriteMock();
    sandbox.window.nimbus.write = w.mock;
    syncTerminalCwd(makeSession({ currentPath: '/other' }), '/target');
    check('currentPath !== targetPath 跳过 (竞态双保险)', w.calls.length === 0);
  }

  // B6. IPC 异常 catch 兜底 (无未处理拒绝)
  {
    const w = makeWriteMock(true);
    sandbox.window.nimbus.write = w.mock;
    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    syncTerminalCwd(makeSession({ currentPath: '/x' }), '/x');
    // 等待微任务, 确认 .catch 已消费拒绝
    await new Promise((r) => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    check('write reject 被 catch 兜底 (无 unhandledRejection)', unhandled === null, unhandled ? String(unhandled) : '');
  }

  // B7. session 为空 -> 不抛异常
  {
    let threw = false;
    try {
      syncTerminalCwd(null, '/x');
    } catch (e) {
      threw = true;
    }
    check('session=null 不抛异常', !threw);
  }

  console.log('');
  console.log('============================================');
  console.log(`cd-sync-restore 验证结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  console.log('============================================');
  process.exit(failCount === 0 ? 0 : 1);
})();
