/**
 * QA 补充验证 — 磁盘卡片恢复「按使用率降序 Top 5」原逻辑 (独立于 monitor-test.js, 只读不改 src/)
 * 背景 (v1.1.0 / FgmSSH 更名): 磁盘卡片恢复 v21 之前逻辑 —— 不按白名单过滤, 所有挂载点
 * 按使用率从高到低排名, 显示 Top 5; 去掉「未匹配白名单」调试区。
 * 覆盖任务清单要求的验证点:
 *   1. 【关键】高使用率非白名单盘 + 低使用率挂载点 -> 全部按 Use% 降序, Top 5 截断
 *   2. maxItems 小值: 截断发生在排序之后 (返回使用率最高的前 N)
 *   3. fetchMonitorData: 不再透传 diskMountWhitelist / diskUnmatched (字段移除)
 *   4. 单一事实源: renderer/main 无白名单过滤残留 (grep 级断言)
 *   5. parseDfWithUnmatched 函数保留 (兼容既有测试/require), 白名单参数仍可用
 *   6. 归一化工具 normalizeMountPath 仍导出且行为不变
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
  // ---------- 1. 【关键】全部挂载点按使用率降序 Top 5 (不过滤白名单) ----------
  test('8 个挂载点 (含低使用率白名单盘): 全部按 Use% 降序, Top 5 截断', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   85G   15G  85% /opt/app\n' +
                '/dev/sda3       100G   81G   19G  81% /boot\n' +
                '/dev/sda4       100G   70G   30G  70% /srv\n' +
                '/dev/sda5       100G   55G   45G  55% /tmp\n' +
                '/dev/sda6       100G   21G   79G  21% /run\n' +
                '/dev/sdb1       500G    5G  495G   1% /root/autodl-fs\n' + // 白名单盘低使用率
                '/dev/sdc1        50G   10G   40G  20% /\n';               // 白名单根
    const rows = parseDf(out, 5);
    assert.strictEqual(rows.length, 5, 'Top 5 截断, 实际 ' + rows.length);
    assert.deepStrictEqual(
      rows.map((r) => r.mounted),
      ['/var/lib/docker', '/opt/app', '/boot', '/srv', '/tmp'],
      '全部挂载点按 Use% 降序 (90,85,81,70,55), 低使用率挂载点被截断'
    );
    assert.ok(!rows.some((r) => r.mounted === '/root/autodl-fs' && r.usedPct === 1),
      '低使用率盘不再因白名单被保留');
    assert.ok(!rows.some((r) => r.mounted === '/' && r.usedPct === 20),
      '根挂载点 (20%) 也在 Top 5 之外被截断');
  });

  // ---------- 2. maxItems 小值 ----------
  test('maxItems=1: 返回使用率最高的 1 个挂载点 (不过滤)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   81G   19G  81% /boot\n' +
                '/dev/sdb1       500G    1G  499G   1% /root/autodl-fs\n' +
                '/dev/sdc1        50G   10G   40G  20% /\n';
    const rows = parseDf(out, 1);
    assert.strictEqual(rows.length, 1, 'maxItems=1 截断后返回 1 条');
    assert.strictEqual(rows[0].mounted, '/var/lib/docker', '使用率最高 (90%) 的挂载点排最前');
    assert.strictEqual(rows[0].usedPct, 90);
  });

  // ---------- 3. fetchMonitorData 字段变更 ----------
  test('fetchMonitorData: 不再透传 diskMountWhitelist / diskUnmatched', async () => {
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
    assert.strictEqual(data.diskMountWhitelist, undefined, 'diskMountWhitelist 字段已移除');
    assert.strictEqual(data.diskUnmatched, undefined, 'diskUnmatched 字段已移除');
    assert.strictEqual(data.disks.length, 5, 'Top 5 截断');
    assert.deepStrictEqual(data.disks.map((d) => d.mounted), ['/var/lib/docker', '/opt/app', '/boot', '/srv', '/tmp'],
      '全部挂载点按 Use% 降序 Top 5');
    assert.ok(data.disks.some((d) => d.mounted === '/boot' && d.usedPct === 81),
      '高使用率非白名单盘必须出现在结果中');
  });

  // ---------- 4. 单一事实源: 无白名单过滤残留 ----------
  test('renderer/main 无白名单过滤残留; renderer 直接渲染 res.disks', () => {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(rendererSrc.includes('res.disks'), 'renderer 应直接引用 res.disks');
    assert.ok(!rendererSrc.includes('res.diskMountWhitelist'), 'renderer 不得再引用 diskMountWhitelist');
    assert.ok(!rendererSrc.includes('whitelistedDisks'), 'renderer 不得再含 whitelistedDisks');
    assert.ok(!rendererSrc.includes('未匹配白名单'), 'renderer 不得再含未匹配白名单调试区');
    assert.ok(!rendererSrc.includes('monitor-disk-unmatched'), 'renderer 不得再引用 monitor-disk-unmatched');
    for (const file of ['main.js', 'preload.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!src.includes('autodl-tmp'), file + ' 不应硬编码 /root/autodl-tmp');
      assert.ok(!src.includes('autodl-fs'), file + ' 不应硬编码 /root/autodl-fs');
    }
    const styleSrc = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
    assert.ok(!styleSrc.includes('monitor-disk-unmatched'), 'style.css 不得残留 monitor-disk-unmatched 样式');
  });

  // ---------- 5. parseDfWithUnmatched 函数保留 (兼容) ----------
  test('parseDfWithUnmatched 函数保留: 白名单参数仍可用 (兼容既有调用/测试)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sda2       200G  150G   40G  79% /home\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp\n' +
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n';
    const { matched, unmatched } = parser.parseDfWithUnmatched(out, undefined, WL);
    assert.strictEqual(matched.length, 3, '白名单内 3 个挂载点全部匹配');
    assert.ok(matched.every((r) => WL.includes(r.mounted)), 'matched 全部应在白名单内');
    assert.deepStrictEqual(unmatched.map((r) => r.mounted), ['/home'], '白名单外进入 unmatched');
    // 不传白名单 -> matched=全部, unmatched=[] (保持 parseDf 不过滤行为)
    const all = parser.parseDfWithUnmatched(out);
    assert.strictEqual(all.matched.length, 4, '不传白名单 = 不过滤');
    assert.strictEqual(all.unmatched.length, 0);
  });

  // ---------- 6. 归一化工具仍可用 ----------
  test('normalizeMountPath 仍导出且行为不变', () => {
    assert.strictEqual(typeof parser.normalizeMountPath, 'function');
    assert.strictEqual(parser.normalizeMountPath('/'), '/');
    assert.strictEqual(parser.normalizeMountPath('/root/autodl-tmp/'), '/root/autodl-tmp');
    assert.strictEqual(parser.normalizeMountPath(' /data with  space '), '/data with space');
    assert.strictEqual(parser.normalizeMountPath(null), '');
  });

  console.log(`\nqa-supplemental-diskwhitelist: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
