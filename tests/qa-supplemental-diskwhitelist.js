/**
 * QA 补充验证 — 磁盘挂载点白名单过滤 (独立于 monitor-test.js, 由 QA Engineer 编写, 只读不改 src/)
 * 覆盖任务清单要求的补充验证点:
 *   1. 【关键设计】高使用率非白名单盘 (/boot 81%、/run 21%) + 低使用率白名单盘
 *      (/root/autodl-fs 1%) -> 断言白名单盘不被 Top-N 截断 (先过滤再排序/截断)
 *   2. 白名单盘在 df 输出中缺失 -> 不显示
 *   3. 空 whitelist -> 不过滤 (保持原行为)
 *   4. 重复挂载点 (df 中同一挂载点多行) -> 均保留且按使用率降序
 *   5. '/' 精确匹配边界: '/' 只匹配根挂载点, 不误匹配 /root、/root/autodl-* 等
 *   6. fetchMonitorData: 白名单盘低使用率 + 大量高使用率非白名单盘 -> disks 仍含白名单盘
 *   7. 单一事实源: renderer/main/preload 无第二份硬编码挂载点列表 (grep 级断言)
 *   8. 渲染层缺失 diskMountWhitelist -> 退回不过滤 (兼容旧响应)
 *   9. 白名单归一化: trailing slash / 前后空格 / 多空格折叠仍匹配; 下划线变体不误匹配;
 *      fetchMonitorData 全链路 (tmp 带 trailing slash 仍透传保留)
 * 运行: node tests/qa-supplemental-diskwhitelist.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const parser = require('../src/health-parser');
const { parseDf, fetchMonitorData } = parser;

const ROOT = path.join(__dirname, '..');
const WL = parser.DISK_MOUNT_WHITELIST;

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

function run() {
  // ---------- 1. 【关键】Top-N 不截断白名单盘 (先过滤再排序/截断) ----------
  test('白名单盘低使用率 1% 不被高使用率非白名单盘挤掉 (Top 5 截断发生在过滤后)', () => {
    // 8 行: 6 个高使用率非白名单盘 + 1 个低使用率白名单盘 + 1 个根 (白名单, 低使用率)
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   85G   15G  85% /opt/app\n' +
                '/dev/sda3       100G   81G   19G  81% /boot\n' +           // 非白名单高使用率
                '/dev/sda4       100G   70G   30G  70% /srv\n' +
                '/dev/sda5       100G   55G   45G  55% /tmp\n' +
                '/dev/sda6       100G   21G   79G  21% /run\n' +           // 非白名单中使用率
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n' + // 白名单低使用率
                '/dev/sdc1        50G   10G   40G  20% /\n';               // 白名单根
    const rows = parseDf(out, undefined, WL);
    // 只输出 2 个白名单盘, 高使用率非白名单盘一律不显示
    assert.strictEqual(rows.length, 2, '只应输出白名单内的 2 个挂载点, 实际 ' + rows.length);
    assert.deepStrictEqual(
      rows.map((r) => r.mounted).sort(),
      ['/', '/root/autodl-fs'],
      '低使用率白名单盘必须保留'
    );
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-fs' && r.usedPct === 1),
      '/root/autodl-fs 使用率 1% 仍必须显示 (不被 Top5 截断)');
    assert.ok(rows.every((r) => WL.includes(r.mounted)), '全部应属于白名单');
  });

  test('白名单盘低使用率 + maxItems 小值: 过滤仍先于截断, 白名单盘不丢', () => {
    // 即使 maxItems=1, 过滤后只剩 1 个白名单盘 -> 仍返回它 (而不是被 90% 的非白名单盘占据)
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   81G   19G  81% /boot\n' +
                '/dev/sdb1       500G    1G  499G   1% /root/autodl-fs\n' +
                '/dev/sdc1        50G   10G   40G  20% /\n';
    const rows = parseDf(out, 1, WL);
    // 说明: slice(0, limit) 在过滤+排序之后, 因此 maxItems=1 时实际返回 1 条 ——
    // 但该条必须是白名单盘, 且绝不能是 90% 的非白名单盘 (/var/lib/docker 必须先被过滤)。
    assert.strictEqual(rows.length, 1, 'maxItems=1 截断发生在过滤后, 返回 1 条');
    assert.ok(rows.every((r) => WL.includes(r.mounted)), '截断后返回的必须是白名单盘');
    assert.strictEqual(rows[0].mounted, '/', '过滤后按使用率降序: / (20%) 优先于 /root/autodl-fs (1%)');
    assert.ok(!rows.some((r) => r.mounted === '/var/lib/docker'), '非白名单高使用率盘不得出现在结果中');
  });

  // ---------- 2. 白名单盘缺失 -> 不显示 ----------
  test('白名单挂载点不在 df 输出中 -> 不显示 (仅输出实际存在的白名单盘)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /\n' +
                '/dev/sda2       100G   81G   19G  81% /boot\n';
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 1, 'df 中只有 / 在白名单内');
    assert.strictEqual(rows[0].mounted, '/');
  });

  // ---------- 3. 空 whitelist -> 不过滤 ----------
  test('空数组 whitelist -> 不过滤 (保持原行为)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +
                '/dev/sda2       100G   21G   79G  21% /run\n' +
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, []);
    assert.strictEqual(rows.length, 3, '空白名单 = 不过滤, 全部保留');
    assert.strictEqual(rows[0].mounted, '/boot', '按使用率降序');
    assert.strictEqual(rows[1].mounted, '/run');
    assert.strictEqual(rows[2].mounted, '/root/autodl-fs');
  });

  test('不传 whitelist (undefined) -> 不过滤 (保持原行为)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /boot\n' +
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n';
    const rows = parseDf(out);
    assert.strictEqual(rows.length, 2, '不传白名单 = 不过滤');
  });

  // ---------- 4. 重复挂载点 ----------
  test('重复挂载点 (df 多行同挂载点): 均保留且按使用率降序', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        50G   10G   40G  20% /\n' +
                '/dev/overlay     50G   25G   25G  50% /\n' +      // 根重复 (overlay)
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 3, '重复挂载点均保留 (过滤是逐行 filter, 不按挂载点去重)');
    assert.strictEqual(rows[0].usedPct, 50, '同一挂载点多行按使用率降序排列');
    assert.strictEqual(rows[0].mounted, '/');
    assert.strictEqual(rows[2].mounted, '/root/autodl-fs');
  });

  // ---------- 5. '/' 精确匹配边界 ----------
  test("'/' 精确匹配: 只匹配根挂载点, 不误匹配 /root、/root/autodl-tmp 等", () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        50G   10G   40G  20% /\n' +
                '/dev/sda2       100G   90G   10G  90% /root\n' +           // 非白名单 (精确不匹配)
                '/dev/sda3       100G   81G   19G  81% /root/autodl-tmp\n' + // 白名单
                '/dev/sda4        20G    1G   19G   5% /root2\n';           // 非白名单
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 2, '仅 / 与 /root/autodl-tmp 应显示');
    assert.deepStrictEqual(rows.map((r) => r.mounted).sort(), ['/', '/root/autodl-tmp']);
    // 精确匹配验证: '/root' 不是 '/' 的子串误配
    assert.ok(!rows.some((r) => r.mounted === '/root'), "'/root' 不得被 '/' 白名单误匹配 (includes 是精确字符串匹配)");
    assert.ok(!rows.some((r) => r.mounted === '/root2'), "'/root2' 不得被 '/' 白名单误匹配");
  });

  // ---------- 6. fetchMonitorData: 白名单盘低使用率不被大量高使用率非白名单盘挤掉 ----------
  test('fetchMonitorData: disks 含低使用率白名单盘, 高使用率非白名单盘被过滤', async () => {
    const C = parser.MONITOR_COMMANDS;
    const exec = async (command) => {
      if (command === C.disks) {
        return { stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                         '/dev/sda1  100G  90G  10G  90% /var/lib/docker\n' +
                         '/dev/sda2  100G  85G  15G  85% /opt/app\n' +
                         '/dev/sda3  100G  81G  19G  81% /boot\n' +
                         '/dev/sda4  100G  70G  30G  70% /srv\n' +
                         '/dev/sda5  100G  55G  45G  55% /tmp\n' +
                         '/dev/sda6  100G  21G  79G  21% /run\n' +
                         '/dev/sdb1  500G   5G 495G   1% /root/autodl-fs\n' +
                         '/dev/sdc1   50G  10G  40G  20% /\n', stderr: '', code: 0 };
      }
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
    assert.deepStrictEqual(data.diskMountWhitelist, WL, 'diskMountWhitelist 应原样透传');
    assert.strictEqual(data.disks.length, 2, '仅 2 个白名单盘 (6 个高使用率非白名单盘被过滤)');
    assert.ok(data.disks.some((d) => d.mounted === '/root/autodl-fs' && d.usedPct === 1),
      '低使用率白名单盘在 fetchMonitorData 中必须保留');
    assert.ok(data.disks.every((d) => WL.includes(d.mounted)), 'disks 全部应在白名单内');
    assert.ok(!data.disks.some((d) => d.mounted === '/boot'), '高使用率非白名单盘不得出现');
  });

  // ---------- 7. 单一事实源: 无第二份硬编码列表 ----------
  test('单一事实源: main/preload 无 autodl 挂载点硬编码; renderer 仅注释提及 (代码零重复)', () => {
    for (const file of ['main.js', 'preload.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!src.includes('autodl-tmp'), file + ' 不应硬编码 /root/autodl-tmp');
      assert.ok(!src.includes('autodl-fs'), file + ' 不应硬编码 /root/autodl-fs');
    }
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    // 允许注释中出现 (说明性), 但代码中的白名单必须来自 res.diskMountWhitelist 而非字面量数组
    assert.ok(rendererSrc.includes('res.diskMountWhitelist'), 'renderer 白名单应来自 IPC 透传');
    assert.ok(rendererSrc.includes('disks.filter((d) => DISK_MOUNT_WHITELIST.includes(d.mounted))'),
      'renderer 过滤应基于透传字段');
    assert.ok(rendererSrc.includes('DISK_MOUNT_WHITELIST = (res && Array.isArray(res.diskMountWhitelist))'),
      'renderer 白名单变量应赋值为透传字段而非硬编码字面量');
    // 确保 renderer 中不存在字面量数组形式的第二份白名单
    const arrMatch = rendererSrc.match(/\['\/',\s*'\/root\/autodl-tmp'/);
    assert.strictEqual(arrMatch, null, 'renderer 不得出现字面量白名单数组');
  });

  // ---------- 8. 渲染层缺失 diskMountWhitelist -> 退回不过滤 ----------
  test('渲染层兼容旧响应: res.diskMountWhitelist 缺失 -> 退回不过滤 (disks 原样渲染)', () => {
    // 渲染层逻辑: DISK_MOUNT_WHITELIST 为 null 时 whitelistedDisks = disks
    // (静态验证代码路径, 不加载 DOM)
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    const whitelistDecl = rendererSrc.match(/const DISK_MOUNT_WHITELIST = \(res && Array\.isArray\(res\.diskMountWhitelist\)\) \? res\.diskMountWhitelist : null;/);
    assert.ok(whitelistDecl, '缺失时 DISK_MOUNT_WHITELIST 应为 null (退回不过滤)');
    const fallback = rendererSrc.match(/const whitelistedDisks = DISK_MOUNT_WHITELIST\s*\?\s*disks\.filter\(\(d\) => DISK_MOUNT_WHITELIST\.includes\(d\.mounted\)\)\s*:\s*disks;/);
    assert.ok(fallback, 'null 时应退回原 disks (兼容旧响应)');
  });

  // ---------- 9. 白名单归一化 (trailing slash / 前后空格 / 下划线变体) ----------
  test('归一化: /root/autodl-tmp/ (trailing slash) + 尾部空格 -> 仍匹配白名单', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        50G   10G   40G  20% /\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp/   \n' + // trailing slash + 尾空格
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 3, '归一化后 3 个白名单挂载点全部保留');
    assert.deepStrictEqual(rows.map((r) => r.mounted).sort(), ['/', '/root/autodl-fs', '/root/autodl-tmp']);
    const tmp = rows.find((r) => r.mounted === '/root/autodl-tmp');
    assert.ok(tmp && tmp.usedPct === 100, 'trailing slash 版本归一化后 usedPct 正常');
  });

  test('归一化: 行首空格 + mounted 前/后空格 + 多空格折叠', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '   /dev/sda1     50G   10G   40G  20% /   \n' +             // 行首空格 + mounted 尾空格
                '   /dev/sdb1    300G  290G   -1G 100%  /root/autodl-tmp \n' + // mounted 前/后空格
                '   /dev/sdc1    100G   80G   20G  88% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 3, '空格变体归一化后全部匹配白名单');
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp'), '前后空格不影响匹配');
    assert.ok(rows.some((r) => r.mounted === '/'), '根挂载点保持 "/"');
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-fs'), '/root/autodl-fs 应保留');
  });

  test('归一化: 下划线变体 /root/autodl_tmp 不被误匹配 (证明归一化不过度)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        50G   10G   40G  20% /\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl_tmp\n' + // 下划线, 非白名单
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, WL);
    assert.strictEqual(rows.length, 2, '/root/autodl_tmp (下划线) 不在白名单内, 不得显示');
    assert.ok(!rows.some((r) => r.mounted === '/root/autodl_tmp'), '下划线变体不得被误匹配');
    assert.deepStrictEqual(rows.map((r) => r.mounted).sort(), ['/', '/root/autodl-fs']);
  });

  test('归一化: fetchMonitorData 透传 —— df 中 tmp 带 trailing slash 仍出现在 disks', async () => {
    const C = parser.MONITOR_COMMANDS;
    const exec = async (command) => {
      if (command === C.disks) {
        return { stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                         '/dev/sda1  100G  90G  10G  90% /var/lib/docker\n' +
                         '/dev/sda2  100G  85G  15G  85% /opt/app\n' +
                         '/dev/sdb1  500G  92G 408G  92% /root/autodl-tmp/\n' +
                         '/dev/sdc1  500G   5G 495G   1% /root/autodl-fs\n' +
                         '/dev/sdd1   50G  10G  40G  20% /\n', stderr: '', code: 0 };
      }
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
    assert.ok(data.disks.some((d) => d.mounted === '/root/autodl-tmp' && d.usedPct === 92),
      'df 中 /root/autodl-tmp/ (trailing slash) 归一化后必须出现在 disks');
    assert.ok(data.disks.every((d) => data.diskMountWhitelist.includes(d.mounted)), 'disks 全部应在白名单内');
    assert.ok(!data.disks.some((d) => d.mounted === '/var/lib/docker'), '高使用率非白名单盘不得出现');
  });

  console.log(`\nqa-supplemental-diskwhitelist: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
