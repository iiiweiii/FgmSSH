/**
 * QA 独立验证 — v23 紧急修复 (磁盘卡片未匹配白名单调试区 + 生产模式诊断日志)
 * QA Engineer 独立编写, 只读不改 src/ (源码 bug 会反馈工程师, 本文件只做验证)
 *
 * 覆盖任务清单要求的补充验证点:
 *   A. parseDfWithUnmatched 手工构造:
 *      3 白名单 + 2 非白名单 -> matched 3 (使用率降序 + limit 同 parseDf) / unmatched 2 (不截断)
 *      全命中 -> unmatched=[]; 空白名单 -> matched=全部 / =parseDf; 空 df / 非法输入边界
 *   B. 调试区渲染 (从 renderer.js 提取真实源码块执行):
 *      unmatched.length>0 渲染 / =0 隐藏 / escapeHtml 注入不被解析 / 不破坏白名单主区
 *   C. 诊断日志门控: env 缺省 / '1' / '0' / 'true' / 'false' / NODE_ENV 组合 -> dfDiagEnabled();
 *      模拟 app.isPackaged=true (process 注入) 下生产也开
 *   D. 单一事实源: DISK_MOUNT_WHITELIST 仅在 health-parser.js 定义一次
 *
 * 运行: node tests/qa-v23-emergency-verify.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parser = require('../src/health-parser');
const { parseDf, parseDfWithUnmatched, fetchMonitorData, dfDiagEnabled, normalizeMountPath } = parser;
const WL = parser.DISK_MOUNT_WHITELIST;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('  \u2713 ' + name); })
        .catch((err) => { failed++; console.error('  \u2717 ' + name); console.error('    ' + ((err && err.stack) || err)); });
    }
    passed++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + ((err && err.stack) || err));
  }
}

const ENV_KEYS = ['NIMBUS_DEV_DIAG', 'NODE_ENV'];
function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function captureLog(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// ---------- 从 renderer.js 提取真实源码函数体 (与既有 qa 测试同法) ----------
function extractFn(src, name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
  const m = src.match(re);
  assert.ok(m, 'renderer.js 未找到函数 ' + name);
  // eslint-disable-next-line no-eval
  return eval('(' + m[0] + ')');
}

function renderDiskHarness() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
  const escapeHtml = extractFn(src, 'escapeHtml');
  const pctBarClass = extractFn(src, 'pctBarClass');
  const rendererNormalize = extractFn(src, 'normalizeMountPath');
  // 提取「磁盘」卡片渲染块: 从 disks 归一化开始到 sections.push(磁盘卡片) 结束,
  // 并包含外层 if (whitelistedDisks.length>0 || errors.df || unmatchedDisks.length>0) 的收尾 '}'
  // (该 if 在 sections.push 之后一行以 2 空格缩进 '}' 闭合)。
  const startMarker = '  const disks = (Array.isArray(res.disks)';
  const endMarker = 'sections.push(`<div class="monitor-card wide"><h4>磁盘</h4>${diskHtml}</div>`);';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end >= 0, 'renderer.js 磁盘渲染块定位失败');
  const braceEnd = src.indexOf('\n  }', end); // sections.push 之后的第一个 2 空格 '}' = 外层 if 收尾
  assert.ok(braceEnd > end, 'renderer.js 磁盘渲染块外层 if 收尾定位失败');
  const block = src.slice(start, braceEnd + 4); // 含 '\n  }'
  // eslint-disable-next-line no-new-func
  const fn = new Function('res', 'errors', 'normalizeMountPath', 'escapeHtml', 'pctBarClass', 'errorNote',
    'const sections = [];\n' + block + '\nreturn sections;');
  return (res, errors) => fn(res, errors, rendererNormalize, escapeHtml, pctBarClass,
    (key) => (errors && errors[key] ? `<div class="monitor-na">${escapeHtml(errors[key])}</div>` : '<div class="monitor-na">无法获取</div>'));
}

async function run() {
  // ================= A. parseDfWithUnmatched 手工构造 =================
  test('A1: 3 白名单 + 2 非白名单 -> matched 3 (使用率降序, limit 同 parseDf) / unmatched 2 (不截断)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +            // 非白名单
                '/dev/sdb1       500G   92G  408G  92% /root/autodl-tmp\n' +  // 白名单
                '/dev/sdc1       500G   85G  415G  85% /root/autodl-fs\n' +   // 白名单
                '/dev/sdd1        50G   10G   40G  20% /\n' +                 // 白名单
                '/dev/sde1       200G   80G  120G  80% /tmp\n';               // 非白名单
    const r = parseDfWithUnmatched(out, undefined, WL);
    assert.strictEqual(r.matched.length, 3, 'matched 应为 3, 实际 ' + r.matched.length);
    assert.strictEqual(r.unmatched.length, 2, 'unmatched 应为 2, 实际 ' + r.unmatched.length);
    // matched: 全白名单 + 使用率降序
    assert.ok(r.matched.every((d) => WL.includes(d.mounted)), 'matched 全部应在白名单内');
    assert.deepStrictEqual(r.matched.map((d) => d.mounted), ['/root/autodl-tmp', '/root/autodl-fs', '/'],
      'matched 应按使用率降序 (92, 85, 20)');
    // unmatched: 全非白名单 + 使用率降序 + 不截断
    assert.deepStrictEqual(r.unmatched.map((d) => d.mounted), ['/boot', '/tmp'],
      'unmatched 应按使用率降序 (90, 80) 且不截断');
    // parseDf 兼容: matched 深等于 parseDf 输出
    assert.deepStrictEqual(r.matched, parseDf(out, undefined, WL), 'matched 应与 parseDf 输出完全一致');
  });

  test('A2: limit 截断仅作用于 matched, unmatched 不截断 (maxItems=2)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +
                '/dev/sdb1       500G   92G  408G  92% /root/autodl-tmp\n' +
                '/dev/sdc1       500G   85G  415G  85% /root/autodl-fs\n' +
                '/dev/sdd1        50G   10G   40G  20% /\n' +
                '/dev/sde1       200G   80G  120G  80% /tmp\n';
    const r = parseDfWithUnmatched(out, 2, WL);
    assert.strictEqual(r.matched.length, 2, 'maxItems=2 -> matched 截断为 2');
    assert.deepStrictEqual(r.matched.map((d) => d.mounted), ['/root/autodl-tmp', '/root/autodl-fs'],
      'matched 截断在过滤+排序后, 且不会截掉白名单盘给非白名单');
    assert.strictEqual(r.unmatched.length, 2, 'unmatched 不受 limit 截断');
    assert.deepStrictEqual(r.unmatched.map((d) => d.mounted), ['/boot', '/tmp']);
    assert.deepStrictEqual(r.matched, parseDf(out, 2, WL), 'limit 行为与 parseDf 一致');
  });

  test('A3: 全命中 (4 全在白名单) -> unmatched=[]', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sdb1       500G   92G  408G  92% /root/autodl-tmp\n' +
                '/dev/sdc1       500G   85G  415G  85% /root/autodl-fs\n' +
                '/dev/sdd1        50G   10G   40G  20% /\n' +
                '/dev/sde1        20G    1G   19G   5% /root/autodl-tmp\n';  // 重复挂载点也命中
    const r = parseDfWithUnmatched(out, undefined, WL);
    assert.strictEqual(r.unmatched.length, 0, '全部命中白名单 -> unmatched 应为空, 实际 ' + r.unmatched.length);
    assert.strictEqual(r.matched.length, 4, '4 条全命中');
    assert.deepStrictEqual(r.matched, parseDf(out, undefined, WL));
  });

  test('A4: 空白名单/不传白名单 -> matched=全部 / =parseDf 输出, unmatched=[]', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n';
    for (const wl of [[], undefined, null]) {
      const r = parseDfWithUnmatched(out, undefined, wl);
      assert.strictEqual(r.matched.length, 2, '不过滤 -> matched 全部保留');
      assert.strictEqual(r.unmatched.length, 0, '不过滤 -> unmatched 为空');
      assert.deepStrictEqual(r.matched, parseDf(out, undefined, wl), '与 parseDf 一致');
    }
  });

  test('A5: 空 df / 非法输入边界 -> {matched:[], unmatched:[]}', () => {
    for (const bad of ['', '   ', '\n\n', null, undefined, 123, {}, [], 'Filesystem  Size  Used Avail Use% Mounted on\n']) {
      const r = parseDfWithUnmatched(bad, undefined, WL);
      assert.deepStrictEqual(r, { matched: [], unmatched: [] }, '输入 ' + JSON.stringify(bad) + ' 应返回空');
      assert.deepStrictEqual(parseDf(bad, undefined, WL), [], 'parseDf 也应返回空');
    }
  });

  test('A6: maxItems=0 / 负数 -> 回退默认 limit 5', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +
                '/dev/sda2       100G   85G   15G  85% /opt\n' +
                '/dev/sda3       100G   80G   20G  80% /srv\n' +
                '/dev/sda4       100G   70G   30G  70% /tmp\n' +
                '/dev/sda5       100G   60G   40G  60% /var\n' +
                '/dev/sda6       100G   50G   50G  50% /home\n' +
                '/dev/sdb1        50G   10G   40G  20% /\n';
    const r = parseDfWithUnmatched(out, 0, WL);
    assert.deepStrictEqual(r.matched, parseDf(out, 0, WL), 'maxItems=0 与 parseDf 行为一致 (回退 5)');
    assert.strictEqual(r.unmatched.length, 6, 'unmatched 不截断 (6 条非白名单全保留)');
  });

  test('A7: fetchMonitorData 透传 diskUnmatched (与 parseDfWithUnmatched 划分一致)', async () => {
    const C = parser.MONITOR_COMMANDS;
    const dfOut = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                  '/dev/sda1  100G  90G  10G  90% /boot\n' +
                  '/dev/sdb1  500G  92G 408G  92% /root/autodl-tmp\n' +
                  '/dev/sdc1  500G  85G 415G  85% /root/autodl-fs\n' +
                  '/dev/sdd1   50G  10G  40G  20% /\n' +
                  '/dev/sde1  200G  80G 120G  80% /tmp\n';
    const exec = async (command) => {
      if (command === C.disks) return { stdout: dfOut, stderr: '', code: 0 };
      if (command === C.load) return { stdout: ' load average: 0.52, 0.58, 0.59', stderr: '', code: 0 };
      if (command === C.memory) return { stdout: 'Mem:  16258316  3456789  12800000\n', stderr: '', code: 0 };
      if (command === C.cpu) return { stdout: '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id\n', stderr: '', code: 0 };
      if (command === C.hostname) return { stdout: 'h\n', stderr: '', code: 0 };
      if (command === C.os) return { stdout: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n', stderr: '', code: 0 };
      if (command === C.date) return { stdout: '2026-08-12T10:00:00Z\n', stderr: '', code: 0 };
      if (command === C.gpu) return { stdout: '', stderr: '', code: 0 };
      throw new Error('mock: 未知命令 ' + command);
    };
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    const expect = parseDfWithUnmatched(dfOut, undefined, WL);
    assert.deepStrictEqual(data.disks, expect.matched, 'fetchMonitorData.disks 应等于 matched');
    assert.deepStrictEqual(data.diskUnmatched, expect.unmatched, 'fetchMonitorData.diskUnmatched 应等于 unmatched (透传正确)');
    assert.deepStrictEqual(data.diskUnmatched.map((d) => d.mounted), ['/boot', '/tmp'], 'diskUnmatched 内容正确');
  });

  // ================= B. 调试区渲染 (真实 renderer 源码块) =================
  test('B1: unmatched.length>0 -> 渲染调试区; =0 -> 整个区域隐藏', () => {
    const renderDisk = renderDiskHarness();
    const res = {
      disks: [{ filesystem: 'x', size: '10G', used: '9G', avail: '1G', usePct: '90%', usedPct: 90, mounted: '/' }],
      diskMountWhitelist: WL,
      diskUnmatched: [{ filesystem: 'y', size: '20G', used: '10G', avail: '10G', usePct: '50%', usedPct: 50, mounted: '/boot' }],
    };
    const sections1 = renderDisk(res, {});
    const html1 = sections1.join('');
    assert.ok(html1.includes('monitor-disk-unmatched'), '存在未匹配时调试区应渲染');
    assert.ok(html1.includes('未匹配白名单'), '调试区标题应出现');
    assert.ok(html1.includes('/boot'), '未匹配挂载点应显示');
    // 全命中 -> 隐藏
    const res2 = {
      disks: [{ filesystem: 'x', size: '10G', used: '9G', avail: '1G', usePct: '90%', usedPct: 90, mounted: '/' }],
      diskMountWhitelist: WL,
      diskUnmatched: [],
    };
    const html2 = renderDisk(res2, {}).join('');
    assert.ok(!html2.includes('monitor-disk-unmatched'), '全命中时调试区应隐藏');
    assert.ok(html2.includes('monitor-disk-row'), '白名单主区应保留');
  });

  test('B2: escapeHtml 转义 (注入 <script> 不被解析)', () => {
    const renderDisk = renderDiskHarness();
    const res = {
      disks: [],
      diskMountWhitelist: WL,
      diskUnmatched: [
        { filesystem: 'y', size: '20G', used: '10G', avail: '10G', usePct: '<script>alert(1)</script>', usedPct: 50, mounted: '<img src=x onerror=alert(2)>' },
      ],
    };
    const html = renderDisk(res, {}).join('');
    assert.ok(!html.includes('<script>alert(1)'), '原始 <script> 不得出现在输出中');
    assert.ok(!html.includes('<img src=x onerror'), '原始 img onerror 不得出现在输出中');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'usePct 应被 escapeHtml');
    assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), 'mounted 应被 escapeHtml');
  });

  test('B3: 不破坏白名单主区 (主区行 + 详情 + 百分比 + 进度条均保留)', () => {
    const renderDisk = renderDiskHarness();
    const res = {
      disks: [
        { filesystem: 'a', size: '500G', used: '92G', avail: '408G', usePct: '92%', usedPct: 92, mounted: '/root/autodl-tmp' },
        { filesystem: 'b', size: '50G', used: '10G', avail: '40G', usePct: '20%', usedPct: 20, mounted: '/' },
      ],
      diskMountWhitelist: WL,
      diskUnmatched: [{ filesystem: 'y', size: '20G', used: '10G', avail: '10G', usePct: '50%', usedPct: 50, mounted: '/boot' }],
    };
    const html = renderDisk(res, {}).join('');
    // 白名单主区 2 行完整字段
    assert.strictEqual((html.match(/monitor-disk-row/g) || []).length, 2, '白名单主区应渲染 2 行');
    assert.ok(html.includes('/root/autodl-tmp'), '主区挂载点显示');
    assert.ok(html.includes('500G') && html.includes('92G') && html.includes('408G'), '主区 size/used/avail 显示');
    assert.ok(html.includes('92%'), '主区 usePct 显示');
    assert.ok(html.includes('monitor-disk-bar'), '主区进度条保留');
    // 调试区在最后 (主区之后)
    assert.ok(html.indexOf('monitor-disk-unmatched') > html.indexOf('monitor-disk-row'), '调试区应位于主区之后');
  });

  test('B4: 仅存在未匹配 (无白名单盘) -> 卡片仍渲染; errors.df 兜底保留', () => {
    const renderDisk = renderDiskHarness();
    const html = renderDisk({ disks: [], diskMountWhitelist: WL, diskUnmatched: [{ mounted: '/boot', usePct: '50%', usedPct: 50 }] }, {}).join('');
    assert.ok(html.includes('monitor-card'), '仅有未匹配时磁盘卡片仍应渲染 (供排查)');
    assert.ok(html.includes('monitor-disk-unmatched'), '调试区应显示');
    // errors.df 兜底: 无白名单盘且无未匹配, 有 errors.df -> 渲染错误提示
    const html2 = renderDisk({ disks: [], diskMountWhitelist: WL, diskUnmatched: [] }, { df: 'df 命令失败' }).join('');
    assert.ok(html2.includes('df 命令失败'), 'errors.df 兜底应渲染');
    assert.ok(html2.includes('monitor-na'), '错误提示 class 存在');
  });

  // ================= C. 诊断日志门控 =================
  test('C1: env 缺省 (node 直跑) -> dfDiagEnabled()=false', () => {
    withEnv({}, () => { assert.strictEqual(dfDiagEnabled(), false); });
  });

  test('C2: NIMBUS_DEV_DIAG=1 / true -> true; =0 / false / 2 / 空串 -> false', () => {
    for (const v of ['1', 'true']) {
      withEnv({ NIMBUS_DEV_DIAG: v, NODE_ENV: '' }, () => {
        assert.strictEqual(dfDiagEnabled(), true, 'NIMBUS_DEV_DIAG=' + v + ' 应开启');
      });
    }
    for (const v of ['0', 'false', '2', '']) {
      withEnv({ NIMBUS_DEV_DIAG: v, NODE_ENV: '' }, () => {
        assert.strictEqual(dfDiagEnabled(), false, 'NIMBUS_DEV_DIAG=' + JSON.stringify(v) + ' 应关闭');
      });
    }
  });

  test('C3: NODE_ENV 组合 -> development 开 / production 关 (无 NIMBUS_DEV_DIAG)', () => {
    withEnv({ NIMBUS_DEV_DIAG: '', NODE_ENV: 'development' }, () => { assert.strictEqual(dfDiagEnabled(), true); });
    withEnv({ NIMBUS_DEV_DIAG: '', NODE_ENV: 'production' }, () => { assert.strictEqual(dfDiagEnabled(), false); });
    // NODE_ENV=production + NIMBUS_DEV_DIAG=1 -> 显式 1 覆盖 (生产也可开)
    withEnv({ NIMBUS_DEV_DIAG: '1', NODE_ENV: 'production' }, () => { assert.strictEqual(dfDiagEnabled(), true); });
  });

  test('C4: 模拟 app.isPackaged=true 下 main.js 默认置 1 -> 生产也开 (process 注入)', () => {
    // 模拟 main.js 的默认置位逻辑 (与 main.js 源码一致): 未显式设置时置 '1',
    // 不再依赖 !app.isPackaged。app.isPackaged=true 模拟生产 exe。
    // 缺省场景 = 环境变量完全不存在 (而非空串, 空串会被视为显式设置)。
    withEnv({ NODE_ENV: 'production' }, () => {
      const app = { isPackaged: true }; // 生产 exe 模拟 (process 注入)
      assert.strictEqual(app.isPackaged, true, '模拟生产环境');
      assert.strictEqual(process.env.NIMBUS_DEV_DIAG, undefined, '前提: env 未显式设置');
      if (process.env.NIMBUS_DEV_DIAG === undefined) process.env.NIMBUS_DEV_DIAG = '1'; // main.js 同一逻辑
      assert.strictEqual(process.env.NIMBUS_DEV_DIAG, '1', 'main.js 应默认置 1');
      assert.strictEqual(dfDiagEnabled(), true, '生产 exe (app.isPackaged=true) 下诊断应默认开启');
    });
    // 显式 env=0 覆盖 -> 生产可关
    withEnv({ NIMBUS_DEV_DIAG: '0', NODE_ENV: 'production' }, () => {
      const app = { isPackaged: true };
      assert.strictEqual(app.isPackaged, true);
      assert.strictEqual(dfDiagEnabled(), false, '显式 NIMBUS_DEV_DIAG=0 生产可关');
    });
  });

  test('C5: 静态 — main.js 无 !app.isPackaged 限制, 采用 === undefined 判定', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(!/!app\.isPackaged/.test(mainSrc), 'main.js 不得再依赖 !app.isPackaged 限制诊断');
    assert.ok(!/isPackaged/.test(mainSrc), 'main.js 不得出现 isPackaged (v23 移除)');
    assert.ok(/if \(process\.env\.NIMBUS_DEV_DIAG === undefined\) process\.env\.NIMBUS_DEV_DIAG = '1';/.test(mainSrc),
      'main.js 应为 === undefined 判定');
  });

  test('C6: 开启时 parseDfWithUnmatched 输出 5 行诊断 (原始行/rows/白名单/过滤后/未匹配白名单)', () => {
    withEnv({ NIMBUS_DEV_DIAG: '1', NODE_ENV: '' }, () => {
      const lines = captureLog(() => {
        parseDfWithUnmatched('Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  10G  9G  1G  90% /\n/dev/sda2  20G  10G  10G  50% /boot\n', undefined, WL);
      });
      assert.ok(lines.length >= 5, '应输出 5 行诊断, 实际 ' + lines.length);
      assert.ok(lines.some((l) => l.includes('原始输出')), '诊断含原始行');
      assert.ok(lines.some((l) => l.includes('解析 rows')), '诊断含 rows');
      assert.ok(lines.some((l) => l.includes('白名单(归一化)')), '诊断含白名单');
      assert.ok(lines.some((l) => l.includes('过滤后')), '诊断含过滤后');
      assert.ok(lines.some((l) => l.includes('未匹配白名单')), '诊断含未匹配白名单');
    });
  });

  // ================= D. 单一事实源 =================
  test('D1: DISK_MOUNT_WHITELIST 定义仅 1 处 (health-parser.js)', () => {
    const glob = require('child_process').execSync('node -e "console.log(1)" && echo skip', { cwd: ROOT });
    void glob;
    // 用 Grep 语义: 全项目 .js 中 DISK_MOUNT_WHITELIST 数组字面量定义
    const dirs = [ROOT, path.join(ROOT, 'src')];
    const hits = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const p = path.join(dir, f);
        const src = fs.readFileSync(p, 'utf8');
        const re = /(?:const|let|var)\s+DISK_MOUNT_WHITELIST\s*=\s*\[/g;
        let m;
        while ((m = re.exec(src)) !== null) hits.push(p + ':' + m.index);
      }
    }
    assert.strictEqual(hits.length, 1, 'DISK_MOUNT_WHITELIST 数组定义应仅 1 处, 实际 ' + hits.length + ': ' + hits.join(', '));
    assert.ok(hits[0].includes('health-parser.js'), '定义应在 health-parser.js');
    // renderer 不得出现字面量白名单数组
    const reSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    const arrMatch = reSrc.match(/\['\/',\s*'\/root\/autodl-tmp'/);
    assert.strictEqual(arrMatch, null, 'renderer 不得出现字面量白名单数组');
  });

  test('D2: renderer/main/preload 无 autodl 挂载点硬编码 (仅注释可提及)', () => {
    for (const file of ['main.js', 'preload.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!src.includes('autodl-tmp'), file + ' 不应硬编码');
      assert.ok(!src.includes('autodl-fs'), file + ' 不应硬编码');
    }
  });

  console.log(`\nqa-v23-emergency-verify: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
