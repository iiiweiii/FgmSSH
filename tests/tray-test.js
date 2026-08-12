/**
 * NimbusSSH 托盘最小化 + 后台保活回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/tray-test.js
 * 需求 (Roadmap 任务 2, P1 行为变更):
 *   - 主窗口关闭按钮 -> 最小化到系统托盘 (win.hide), 不退出进程, 不清理任何会话
 *   - 托盘: 双击恢复窗口; 右键菜单「显示主窗口/退出」(退出才真正清理会话 + 进程退出)
 *   - 单实例锁 + second-instance 恢复窗口
 *   - Ctrl+Q / 退出入口走同一 quitApp 路径
 *   - 会话清理只在真退出路径 (before-quit cleanupAllSessions), close 不再清理
 * 断言策略: main.js 静态断言 (单实例锁 / isQuitting / close 拦截 / 清理集中) + 纯逻辑模拟
 * (把 close 拦截判定逻辑提取为闭包函数, 验证非退出时 preventDefault+hide、退出时放行)。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

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

// ---------- 纯逻辑模拟: close 事件拦截判定 (与 main.js win.on('close') 同构) ----------
function makeCloseGuard(initialQuitting) {
  let isQuitting = initialQuitting;
  const events = [];
  const win = {
    hidden: false,
    hide() { this.hidden = true; events.push('hide'); },
    destroy() { events.push('destroy'); },
  };
  return {
    win,
    events,
    setQuitting(v) { isQuitting = v; },
    onClose(e) {
      if (isQuitting) return; // 放行
      e.preventDefault();
      win.hide();
      events.push('minimize-to-tray');
    },
  };
}

function run() {
  // ================= 静态断言: main.js =================

  test('main.js 从 electron 引入 Tray 与 Menu', () => {
    assert.ok(/const\s*\{\s*[^}]*\bTray\b[^}]*\}/.test(mainSrc), '未从 electron 引入 Tray');
    assert.ok(/const\s*\{\s*[^}]*\bMenu\b[^}]*\}/.test(mainSrc), '未从 electron 引入 Menu');
  });

  test('存在 isQuitting 标志 (let isQuitting = false)', () => {
    assert.ok(/let\s+isQuitting\s*=\s*false/.test(mainSrc), '未定义 isQuitting 标志');
  });

  test('主窗口 close 事件拦截为 hide (非退出时 preventDefault + hide)', () => {
    assert.ok(/win\.on\('close'/.test(mainSrc), '缺少 win.on(close) 处理');
    assert.ok(/if\s*\(\s*isQuitting\s*\)\s*return/.test(mainSrc), '缺少 isQuitting 放行分支');
    assert.ok(/e\.preventDefault\(\)/.test(mainSrc), 'close 未 preventDefault (未拦截关闭)');
    assert.ok(/win\.hide\(\)/.test(mainSrc), 'close 未调用 win.hide() (未最小化到托盘)');
  });

  test('托盘创建失败降级: 无托盘时 close 走 quitApp (避免窗口隐藏后无法恢复)', () => {
    const closeMatch = mainSrc.match(/win\.on\('close'[\s\S]*?\n\s*\}\);/);
    assert.ok(closeMatch, '缺少 close 处理块');
    assert.ok(/if\s*\(\s*!tray\s*\)\s*\{\s*quitApp\(\);\s*return;\s*\}/.test(closeMatch[0]), 'close 未提供无托盘降级 (quitApp)');
  });

  test('会话清理不再位于窗口 close/closed 路径 (清理集中在真退出)', () => {
    // 旧实现: win.on('closed') 内直接循环清理 sessions + stopAllTunnels
    const closedBlockMatch = mainSrc.match(/win\.on\('closed'\s*,\(\)\s*=>\s*\{[\s\S]*?\n\s*\}\);/);
    if (closedBlockMatch) {
      const block = closedBlockMatch[0];
      assert.ok(!block.includes('sessions.entries'), 'closed 事件内不得再遍历 sessions 清理');
      assert.ok(!block.includes('stopAllTunnels'), 'closed 事件内不得再清理隧道');
      assert.ok(!block.includes('conn.end'), 'closed 事件内不得再关闭连接');
    }
    // 清理逻辑应集中在 cleanupAllSessions 且由 before-quit 触发
    assert.ok(mainSrc.includes('function cleanupAllSessions'), '缺少 cleanupAllSessions 函数');
    assert.ok(/app\.on\('before-quit'[\s\S]{0,200}cleanupAllSessions/.test(mainSrc), 'before-quit 未调用 cleanupAllSessions');
  });

  test('cleanupAllSessions 包含审计 + 隧道清理 + 连接关闭', () => {
    const fnStart = mainSrc.indexOf('function cleanupAllSessions');
    assert.ok(fnStart >= 0, 'cleanupAllSessions 不存在');
    const fnBlock = mainSrc.slice(fnStart, fnStart + 1400);
    assert.ok(fnBlock.includes('auditDisconnectLogged'), 'cleanupAllSessions 缺少断开审计');
    assert.ok(fnBlock.includes('stopAllTunnels'), 'cleanupAllSessions 缺少隧道清理');
    assert.ok(fnBlock.includes('sftp.end'), 'cleanupAllSessions 缺少 SFTP 关闭');
    assert.ok(fnBlock.includes('conn.end'), 'cleanupAllSessions 缺少 SSH 连接关闭');
    assert.ok(fnBlock.includes('sessions.clear'), 'cleanupAllSessions 缺少会话表清空');
  });

  test('单实例锁存在 (requestSingleInstanceLock) 且 second-instance 恢复窗口', () => {
    assert.ok(/app\.requestSingleInstanceLock\(\)/.test(mainSrc), '缺少 requestSingleInstanceLock');
    assert.ok(/app\.on\('second-instance'/.test(mainSrc), '缺少 second-instance 处理器');
    assert.ok(/showMainWindow\(\)/.test(mainSrc), 'second-instance 未调用 showMainWindow');
  });

  test('托盘创建 (createTray) 含双击恢复 + 右键菜单 显示/退出', () => {
    assert.ok(mainSrc.includes('function createTray'), '缺少 createTray');
    assert.ok(/new\s+Tray\(/.test(mainSrc), '未创建 Tray 实例');
    assert.ok(/tray\.on\('double-click',\s*showMainWindow\)/.test(mainSrc), '托盘缺少双击恢复');
    assert.ok(/显示主窗口/.test(mainSrc), '托盘菜单缺少「显示主窗口」');
    assert.ok(/退出/.test(mainSrc), '托盘菜单缺少「退出」');
    assert.ok(/label:\s*'退出',\s*click:\s*quitApp/.test(mainSrc), '托盘「退出」未绑定 quitApp');
  });

  test('quitApp 为唯一真退出入口 (置 isQuitting + app.quit)', () => {
    assert.ok(mainSrc.includes('function quitApp'), '缺少 quitApp');
    const fnStart = mainSrc.indexOf('function quitApp');
    const fnBlock = mainSrc.slice(fnStart, fnStart + 500);
    assert.ok(fnBlock.includes('isQuitting = true'), 'quitApp 未置 isQuitting=true');
    assert.ok(fnBlock.includes('app.quit()'), 'quitApp 未调用 app.quit()');
  });

  test('Ctrl+Q 走同一退出路径 (before-input-event 拦截 -> quitApp)', () => {
    assert.ok(mainSrc.includes('before-input-event'), '缺少 before-input-event');
    assert.ok(/input\.key\.toLowerCase\(\)\s*===\s*'q'/.test(mainSrc), '未拦截 Q 键');
    assert.ok(/quitApp\(\)/.test(mainSrc), 'Ctrl+Q 未调用 quitApp');
  });

  test('window-all-closed 不再无条件退出 (托盘保活: 由 isQuitting 守卫)', () => {
    const match = mainSrc.match(/app\.on\('window-all-closed'[\s\S]*?\n\}\);/);
    assert.ok(match, '缺少 window-all-closed 处理器');
    const block = match[0];
    assert.ok(/if\s*\(\s*isQuitting\s*\)\s*app\.quit\(\)/.test(block), 'window-all-closed 未按 isQuitting 守卫');
  });

  test('before-quit 置 isQuitting=true 放行 close 流程', () => {
    const match = mainSrc.match(/app\.on\('before-quit'[\s\S]*?\n\}\);/);
    assert.ok(match, '缺少 before-quit 处理器');
    assert.ok(/isQuitting\s*=\s*true/.test(match[0]), 'before-quit 未置 isQuitting=true');
  });

  test('will-quit 销毁托盘图标', () => {
    const match = mainSrc.match(/app\.on\('will-quit'[\s\S]*?\n\}\);/);
    assert.ok(match, '缺少 will-quit 处理器');
    assert.ok(/tray\.destroy/.test(match[0]), 'will-quit 未销毁托盘图标');
  });

  test('生命周期审计 app.lifecycle 埋点存在且无敏感信息', () => {
    const matches = mainSrc.match(/app\.lifecycle/g);
    assert.ok(matches && matches.length >= 4, 'app.lifecycle 审计埋点不足 (应有托盘创建/隐藏/恢复/退出等)');
    // 审计 detail 仅固定文案, 不含命令输出/凭据
    assert.ok(!/app\.lifecycle[\s\S]{0,300}password/.test(mainSrc), 'app.lifecycle 埋点不得涉及凭据');
  });

  // ================= 纯逻辑模拟: close 拦截判定 =================
  test('逻辑: 非退出时 close -> preventDefault + hide (最小化到托盘, 不销毁)', () => {
    const guard = makeCloseGuard(false);
    const e = { preventDefault() { guard.events.push('preventDefault'); } };
    guard.onClose(e);
    assert.ok(guard.events.includes('preventDefault'), '非退出时应 preventDefault');
    assert.ok(guard.events.includes('hide'), '非退出时应 hide');
    assert.ok(!guard.events.includes('destroy'), '非退出时不得销毁窗口');
    assert.ok(guard.events.includes('minimize-to-tray'), '非退出时应记录最小化到托盘');
  });

  test('逻辑: 退出时 close -> 放行 (不 preventDefault, 不 hide)', () => {
    const guard = makeCloseGuard(true);
    const e = { preventDefault() { guard.events.push('preventDefault'); } };
    guard.onClose(e);
    assert.ok(!guard.events.includes('preventDefault'), '退出时应放行 close');
    assert.ok(!guard.events.includes('hide'), '退出时不应 hide');
  });

  test('逻辑: 从非退出切换到退出 (quitApp 语义) 后 close 放行', () => {
    const guard = makeCloseGuard(false);
    const e = { preventDefault() { guard.events.push('preventDefault'); } };
    guard.onClose(e); // 隐藏到托盘
    guard.setQuitting(true); // 模拟 quitApp 置 isQuitting
    guard.onClose(e);        // 再次 close -> 应放行
    const preventCount = guard.events.filter((x) => x === 'preventDefault').length;
    assert.strictEqual(preventCount, 1, '仅首次 close 应被拦截, 退出后应放行');
  });

  test('逻辑: 无托盘时 close -> quitApp 真退出 (不隐藏不残留)', () => {
    // 模拟 main.js close 分支: if (!tray) { quitApp(); return; }
    let isQuitting = false;
    let quitCalled = false;
    const events = [];
    const win = { hide() { events.push('hide'); } };
    const onClose = (e) => {
      if (isQuitting) return;
      if (!trayRef) { isQuitting = true; quitCalled = true; return; } // quitApp 语义
      e.preventDefault();
      win.hide();
    };
    let trayRef = null; // 托盘创建失败
    const e = { preventDefault() { events.push('preventDefault'); } };
    onClose(e);
    assert.ok(quitCalled, '无托盘时应触发 quitApp');
    assert.ok(!events.includes('hide'), '无托盘时不应隐藏窗口');
    assert.ok(isQuitting, 'quitApp 应置 isQuitting=true');
  });

  console.log(`\ntray-test: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
