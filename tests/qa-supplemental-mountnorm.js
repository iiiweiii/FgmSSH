/**
 * QA 补充验证 — 挂载点归一化匹配 + 诊断日志门控 (QA Engineer 编写, 只读不改 src/)
 *
 * 覆盖任务清单要求的补充验证点:
 *   1. 手工构造 df 输出含以下变体, 断言均能被白名单命中并保留 (不被 Top5 截断):
 *        /root/autodl-tmp/   (尾斜杠)
 *        /root/autodl-tmp    (尾空格)
 *        /root/autodl-tmp\r  (尾 CR)
 *        /root/autodl-tmp    (双尾空格, 含空格)
 *   2. 反向: /tmp (不在白名单)、/root/autodl_tmp (下划线变体) -> 不被白名单命中
 *      (另记录 /root/autodl  tmp 内部空白变体的规格说明, 见测试注释)
 *   3. normalizeMountPath 边界: '/' 不被去斜杠变空、'///' 折叠、'/a/b///c' 去尾、
 *      纯空格/null/undefined 容错
 *   4. 两侧实现逐字节一致 (health-parser 与 renderer 的 normalizeMountPath)
 *   5. 诊断日志门控: NIMBUS_DEV_DIAG='0'/NODE_ENV=production 静默, '1'/'true'/NODE_ENV=development 输出
 *   6. 静态: renderer 磁盘卡片标题为 "磁盘" (无 Top 5 残留); main.js dev 门控存在
 *
 * 运行: node tests/qa-supplemental-mountnorm.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const parser = require('../src/health-parser');
const { parseDf, normalizeMountPath, dfDiagEnabled } = parser;
const WL = parser.DISK_MOUNT_WHITELIST;
const ROOT = path.join(__dirname, '..');

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

// 捕获 console.log 输出的辅助 (诊断日志门控验证)
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

// 保存/恢复环境变量
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

// 通用 df 构造: 高使用率非白名单盘若干 + 1 条白名单变体行
function dfWithVariant(mountVariant, usePct) {
  return 'Filesystem      Size  Used Avail Use% Mounted on\n' +
    '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
    '/dev/sda2       100G   85G   15G  85% /opt/app\n' +
    '/dev/sda3       100G   81G   19G  81% /boot\n' +
    '/dev/sda4       100G   70G   30G  70% /srv\n' +
    '/dev/sda5       100G   55G   45G  55% /tmp\n' +
    `/dev/sdb1       300G  290G   -1G ${usePct}% ${mountVariant}\n` +
    '/dev/sdc1        50G   10G   40G  20% /\n';
}

function run() {
  // ================= A. df 变体正向命中 (且不被 Top5 截断) =================
  test('df: /root/autodl-tmp/ (尾斜杠) -> 白名单命中, 不被高使用率盘挤掉', () => {
    const rows = parseDf(dfWithVariant('/root/autodl-tmp/', 100), undefined, WL);
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp' && r.usedPct === 100),
      'trailing slash 变体应归一化为 /root/autodl-tmp 并保留');
    assert.ok(!rows.some((r) => r.mounted === '/boot'), '非白名单高使用率盘不得出现 (Top5 截断发生在过滤后)');
    assert.ok(rows.every((r) => WL.includes(r.mounted)), '全部应属于白名单');
  });

  test('df: /root/autodl-tmp  (尾空格) -> 白名单命中', () => {
    const rows = parseDf(dfWithVariant('/root/autodl-tmp ', 100), undefined, WL);
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp'), '尾空格应被 trim 掉并命中');
  });

  test('df: /root/autodl-tmp\\r (尾 CR) -> 白名单命中', () => {
    const rows = parseDf(dfWithVariant('/root/autodl-tmp\r', 100), undefined, WL);
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp'), '尾 CR 应被 trim 掉并命中');
  });

  test('df: /root/autodl-tmp   (双尾空格) -> 白名单命中', () => {
    const rows = parseDf(dfWithVariant('/root/autodl-tmp  ', 100), undefined, WL);
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp'), '双尾空格应被 trim 掉并命中');
  });

  test('df: CRLF 整行 (/root/autodl-tmp/ 后跟 \\r\\n) -> 白名单命中', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\r\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\r\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp/\r\n' +
                '/dev/sdc1        50G   10G   40G  20% /\r\n';
    const rows = parseDf(out, undefined, WL);
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp'), 'CRLF 行尾 + 尾斜杠应归一化命中');
  });

  test('df: 4 种正向变体全部出现在同一输出 -> 均保留 (不互相干扰)', () => {
    // 注: 传 maxItems=10 以容纳 6 条白名单行 (4 变体 + / + /root/autodl-fs)。
    // 默认 limit=5 时 1% 的 /root/autodl-fs 会被 slice(0,5) 合法截掉 —— 白名单只保证
    // 不被非白名单盘挤掉, 不保证超过 limit 的行数, 这是设计语义而非 Bug。
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   85G   15G  85% /opt/app\n' +
                '/dev/sda3       100G   81G   19G  81% /boot\n' +
                '/dev/sda4       100G   70G   30G  70% /srv\n' +
                '/dev/sda5       100G   55G   45G  55% /tmp\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp/\n' +
                '/dev/sdb2       300G  280G   20G  95% /root/autodl-tmp \n' +
                '/dev/sdb3       300G  270G   30G  90% /root/autodl-tmp\r\n' +
                '/dev/sdb4       300G  260G   40G  85% /root/autodl-tmp  \n' +
                '/dev/sdc1        50G   10G   40G  20% /\n' +
                '/dev/sdd1       500G    5G  495G   1% /root/autodl-fs\n';
    const rows = parseDf(out, 10, WL);
    // 重复挂载点均保留 (逐行 filter), 归一化后都应为 /root/autodl-tmp
    const tmpRows = rows.filter((r) => r.mounted === '/root/autodl-tmp');
    assert.strictEqual(tmpRows.length, 4, '4 种变体归一化后均命中 /root/autodl-tmp, 实际 ' + tmpRows.length);
    assert.ok(rows.some((r) => r.mounted === '/'), '根保留');
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-fs'), '/root/autodl-fs 保留');
    assert.ok(!rows.some((r) => r.mounted === '/boot'), '非白名单高使用率盘不得出现');
  });

  // ================= B. 反向不命中 =================
  test('反向: /tmp (不在白名单) -> 不命中', () => {
    const rows = parseDf(dfWithVariant('/tmp', 99), undefined, WL);
    assert.ok(!rows.some((r) => r.mounted === '/tmp'), '/tmp 不得显示');
  });

  test('反向: /root/autodl_tmp (下划线变体) -> 不命中', () => {
    const rows = parseDf(dfWithVariant('/root/autodl_tmp', 99), undefined, WL);
    assert.ok(!rows.some((r) => r.mounted === '/root/autodl_tmp'), '下划线变体不得被误匹配');
  });

  test('说明性: /root/autodl  tmp (内部双空格) -> 按规格不命中 (折叠为 /root/autodl tmp, 非 /root/autodl-tmp)', () => {
    // 规格: normalizeMountPath 折叠连续空白为单空格, 不改变连字符。
    // 因此 /root/autodl  tmp -> /root/autodl tmp, 与白名单 /root/autodl-tmp 不相等 -> 正确不命中。
    const rows = parseDf(dfWithVariant('/root/autodl  tmp', 99), undefined, WL);
    assert.strictEqual(normalizeMountPath('/root/autodl  tmp'), '/root/autodl tmp');
    assert.ok(!rows.some((r) => r.mounted === '/root/autodl tmp'), '内部空白变体按规格不命中');
  });

  // ================= C. normalizeMountPath 边界 =================
  test('normalizeMountPath: "/" 保留 (不被去斜杠变空)', () => {
    assert.strictEqual(normalizeMountPath('/'), '/');
  });

  test('normalizeMountPath: "///" 折叠为 "/"', () => {
    assert.strictEqual(normalizeMountPath('///'), '/');
  });

  test('normalizeMountPath: "/a/b///c" 内部斜杠不折叠 (仅去尾斜杠)', () => {
    assert.strictEqual(normalizeMountPath('/a/b///c'), '/a/b///c');
  });

  test('normalizeMountPath: "/a/b///c/" 去尾斜杠', () => {
    assert.strictEqual(normalizeMountPath('/a/b///c/'), '/a/b///c');
  });

  test('normalizeMountPath: 纯空格 -> 空串', () => {
    assert.strictEqual(normalizeMountPath('   '), '');
  });

  test('normalizeMountPath: 空串 -> 空串', () => {
    assert.strictEqual(normalizeMountPath(''), '');
  });

  test('normalizeMountPath: null/undefined -> 空串 (容错)', () => {
    assert.strictEqual(normalizeMountPath(null), '');
    assert.strictEqual(normalizeMountPath(undefined), '');
  });

  test('normalizeMountPath: 混合空白 "/root/autodl-tmp \\r\\n" -> 规范形式', () => {
    assert.strictEqual(normalizeMountPath('/root/autodl-tmp \r\n'), '/root/autodl-tmp');
  });

  test('normalizeMountPath: 数字输入容错 (String 化)', () => {
    assert.strictEqual(normalizeMountPath(123), '123');
  });

  // ================= D. 两侧实现逐字节一致 =================
  test('两侧 normalizeMountPath 源码逐字节一致 (health-parser vs renderer)', () => {
    const hpSrc = fs.readFileSync(path.join(ROOT, 'src', 'health-parser.js'), 'utf8');
    const reSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    const hpFn = hpSrc.match(/function normalizeMountPath\(s\) \{[\s\S]*?\n\}/);
    const reFn = reSrc.match(/function normalizeMountPath\(s\) \{[\s\S]*?\n\}/);
    assert.ok(hpFn && reFn, '两侧均应存在 normalizeMountPath');
    assert.strictEqual(reFn[0], hpFn[0], '函数体应逐字节一致');
  });

  test('两侧 normalizeMountPath 行为一致 (同批输入输出相同)', () => {
    const reSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    const reFn = reSrc.match(/function normalizeMountPath\(s\) \{[\s\S]*?\n\}/);
    assert.ok(reFn, 'renderer.js 未找到 normalizeMountPath');
    // eslint-disable-next-line no-eval
    const rendererFn = eval('(' + reFn[0] + ')');
    const inputs = [
      '/', '///', '/a/b///c', '/a/b///c/', '   ', '', null, undefined,
      '/root/autodl-tmp', '/root/autodl-tmp/', '/root/autodl-tmp ', '/root/autodl-tmp\r',
      '/root/autodl-tmp  ', '/root/autodl  tmp', '/root/autodl_tmp', '/tmp',
      '/root/autodl-tmp \r\n', 123, '  /root/autodl-fs  ', '/boot',
    ];
    for (const inp of inputs) {
      assert.strictEqual(rendererFn(inp), normalizeMountPath(inp),
        '输入 ' + JSON.stringify(inp) + ' 两侧输出不一致');
    }
  });

  // ================= E. 诊断日志门控 =================
  test('dfDiagEnabled: NIMBUS_DEV_DIAG=0 (模拟 prod) -> false 且 parseDf 零 console 输出', () => {
    withEnv({ NIMBUS_DEV_DIAG: '0', NODE_ENV: 'production' }, () => {
      assert.strictEqual(dfDiagEnabled(), false, 'NIMBUS_DEV_DIAG=0 应关闭诊断');
      const lines = captureLog(() => {
        parseDf('Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  10G  9G  1G  90% /\n', undefined, WL);
      });
      assert.strictEqual(lines.length, 0, 'prod 模拟应零 console 输出, 实际 ' + lines.length);
    });
  });

  test('dfDiagEnabled: NIMBUS_DEV_DIAG=1 -> true 且 parseDf 输出诊断行', () => {
    withEnv({ NIMBUS_DEV_DIAG: '1', NODE_ENV: '' }, () => {
      assert.strictEqual(dfDiagEnabled(), true, 'NIMBUS_DEV_DIAG=1 应开启诊断');
      const lines = captureLog(() => {
        parseDf('Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  10G  9G  1G  90% /\n', undefined, WL);
      });
      assert.ok(lines.length >= 3, '应输出 原始输出/rows/白名单/过滤后 诊断行, 实际 ' + lines.length);
      assert.ok(lines.some((l) => l.includes('[health-parser][df]')), '诊断行应带 [health-parser][df] 前缀');
    });
  });

  test('dfDiagEnabled: NODE_ENV=development -> true 且 parseDf 输出', () => {
    withEnv({ NIMBUS_DEV_DIAG: '', NODE_ENV: 'development' }, () => {
      assert.strictEqual(dfDiagEnabled(), true);
      const lines = captureLog(() => {
        parseDf('Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  10G  9G  1G  90% /\n', undefined, WL);
      });
      assert.ok(lines.length >= 1, 'development 应输出诊断');
    });
  });

  test('dfDiagEnabled: NODE_ENV=production 且无 NIMBUS_DEV_DIAG -> false', () => {
    withEnv({ NIMBUS_DEV_DIAG: '', NODE_ENV: 'production' }, () => {
      assert.strictEqual(dfDiagEnabled(), false);
    });
  });

  test('dfDiagEnabled: 默认 (node 直跑, 无环境变量) -> false', () => {
    withEnv({}, () => {
      assert.strictEqual(dfDiagEnabled(), false);
    });
  });

  test('dfDiagEnabled: NIMBUS_DEV_DIAG=true -> true; false/2/空串 -> false', () => {
    withEnv({ NIMBUS_DEV_DIAG: 'true', NODE_ENV: '' }, () => {
      assert.strictEqual(dfDiagEnabled(), true);
    });
    for (const v of ['false', '2', '']) {
      withEnv({ NIMBUS_DEV_DIAG: v, NODE_ENV: '' }, () => {
        assert.strictEqual(dfDiagEnabled(), false, 'NIMBUS_DEV_DIAG=' + JSON.stringify(v) + ' 应关闭');
      });
    }
  });

  // ================= F. 静态断言 (标题修正 + dev 门控) =================
  test('静态: renderer 磁盘卡片标题为 "磁盘" (无 Top 5 残留)', () => {
    const reSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(reSrc.includes('<h4>磁盘</h4>'), '磁盘卡片标题应为 <h4>磁盘</h4>');
    assert.ok(!/Top\s*5/i.test(reSrc), 'renderer.js 不得含 Top 5 / Top5 / Top-5');
  });

  test('静态: main/preload/index/style 均无 Top 5 残留', () => {
    for (const file of ['main.js', 'preload.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/Top\s*5/i.test(src), file + ' 不得含 Top 5');
    }
    for (const file of ['index.html', 'style.css']) {
      const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
      assert.ok(!/Top\s*5/i.test(src), 'src/' + file + ' 不得含 Top 5');
    }
  });

  test('静态: main.js 磁盘诊断默认开启 (未显式设置 NIMBUS_DEV_DIAG 时置 1, v23 起生产也开)', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/if \(process\.env\.NIMBUS_DEV_DIAG === undefined\) process\.env\.NIMBUS_DEV_DIAG = '1';/.test(mainSrc),
      'main.js 应在未显式设置 NIMBUS_DEV_DIAG 时默认开启诊断 (生产也开, 便于排查 df/白名单; 设 env=0 可关)');
  });

  test('静态: renderer 归一化后直接渲染 disks (不再按白名单过滤)', () => {
    const reSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(reSrc.includes('mounted: normalizeMountPath(d.mounted)'),
      'renderer 应在渲染前对 mounted 归一化');
    assert.ok(reSrc.includes('disks.map((d) => `'),
      'renderer 应直接基于 disks 数组渲染 (解析层已按 Use% 降序取前 5 条)');
    assert.ok(!reSrc.includes('DISK_MOUNT_WHITELIST'),
      'renderer 不得再引用 DISK_MOUNT_WHITELIST (白名单过滤已移除)');
    assert.ok(!reSrc.includes('whitelistedDisks'),
      'renderer 不得再含 whitelistedDisks');
  });

  console.log(`\nqa-supplemental-mountnorm: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
