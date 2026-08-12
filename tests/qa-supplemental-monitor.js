/**
 * QA 补充验证 (独立于 monitor-test.js, 由 QA Engineer 编写, 只读不改 src/)
 * 覆盖任务清单要求的补充验证点:
 *   1. %Cpu us+sy 计算: 构造 %Cpu(s) 边界行, 验证解析数值 + 渲染层 us+sy 公式
 *   2. df Use% 含 % 号 (含 100%、小数、无 % 号) + tmpfs 多挂载点
 *   3. free 单位转换边界 (_parseMemValueToMB): 无后缀 KB / K / M / G / T / GiB / 0B
 *   4. uptime 多格式 (up 3 hours, 5 minutes; 多空格)
 *   5. os-release 引号 (单引号 / 无引号 / PRETTY_NAME 带引号内容含 =)
 *   6. 端口/会话残留风险静态断言: 隐藏路径零清理 (与 tray-test 互补的 grep 级断言)
 * 运行: node tests/qa-supplemental-monitor.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const parser = require('../src/health-parser');
const { parseUptime, parseFree, parseDf, parseTopCpu, parseOsRelease, _parseMemValueToMB } = parser;

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

function run() {
  // ---------- 1. %Cpu us+sy 计算 ----------
  test('%Cpu us+sy: 渲染层公式 user+system = busy (10.5+5.2=15.7)', () => {
    const out = 'top - 12:00:01 up 1:02,  1 user,  load average: 0.10, 0.20, 0.30\n' +
                '%Cpu(s): 10.5 us,  5.2 sy,  0.0 ni, 83.9 id,  0.2 wa,  0.0 hi,  0.1 si,  0.1 st\n';
    const r = parseTopCpu(out);
    assert.ok(r);
    const busy = (r.user !== null && r.system !== null) ? Math.min(100, Math.max(0, r.user + r.system)) : null;
    assert.strictEqual(busy, 15.7);
    assert.strictEqual(r.idle, 83.9);
    assert.strictEqual(r.steal, 0.1);
  });

  test('%Cpu 单核无逗号分隔 (空格分隔 tokens) 仍可解析', () => {
    const out = '%Cpu(s):  3.1 us  0.7 sy  95.8 id  0.3 wa\n';
    const r = parseTopCpu(out);
    assert.ok(r, '空格分隔应可解析');
    assert.strictEqual(r.user, 3.1);
    assert.strictEqual(r.system, 0.7);
    assert.strictEqual(r.idle, 95.8);
  });

  test('%Cpu 100% idle 边界 (0 使用) + us+sy=0', () => {
    const out = '%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n';
    const r = parseTopCpu(out);
    assert.ok(r);
    assert.strictEqual(r.user + r.system, 0);
    assert.strictEqual(r.idle, 100.0);
  });

  // ---------- 2. df Use% 含 % 号 / tmpfs / 多挂载点 ----------
  test('df: Use% 含 % (100%、小数 48.5%、无 % 号兜底) + tmpfs 多挂载点', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48.5% /\n' +
                'tmpfs           7.8G  7.8G     0  100% /dev/shm\n' +
                'tmpfs           7.8G  1.2M  7.8G   1% /run\n' +
                '/dev/sdb1       500G  400G   70G   85 /data\n'; // 无 % 号 (异常但可解析)
    const rows = parseDf(out);
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].mounted, '/dev/shm');
    assert.strictEqual(rows[0].usedPct, 100);
    assert.strictEqual(rows[0].usePct, '100%');
    assert.strictEqual(rows[1].usedPct, 85);
    assert.strictEqual(rows[2].usedPct, 48.5);
    assert.strictEqual(rows[3].usedPct, 1);
    // tmpfs 行不丢失, 但排序后 Use% 低者靠后
    assert.strictEqual(rows[3].filesystem, 'tmpfs');
  });

  test('df: 挂载点含空格 + 100% 时 avail=-1G 保留原值', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sdc1       300G  290G   -1G 100% /full with space\n';
    const rows = parseDf(out);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mounted, '/full with space');
    assert.strictEqual(rows[0].avail, '-1G');
    assert.strictEqual(rows[0].usedPct, 100);
  });

  // ---------- 3. free 单位转换边界 ----------
  test('free: _parseMemValueToMB 单位转换 (K/M/G/T/GiB/0B/无后缀)', () => {
    assert.strictEqual(_parseMemValueToMB('16258316'), Math.round((16258316 / 1024) * 100) / 100); // KB
    assert.strictEqual(_parseMemValueToMB('2048K'), 2);
    assert.strictEqual(_parseMemValueToMB('512M'), 512);
    assert.strictEqual(_parseMemValueToMB('1.5G'), 1536);
    assert.strictEqual(_parseMemValueToMB('2T'), 2 * 1024 * 1024);
    assert.strictEqual(_parseMemValueToMB('3.2Gi'), 3.2 * 1024);
    assert.strictEqual(_parseMemValueToMB('0B'), 0);
    assert.strictEqual(_parseMemValueToMB('0'), 0);
    assert.strictEqual(_parseMemValueToMB(null), null);
    assert.strictEqual(_parseMemValueToMB(''), null);
    assert.strictEqual(_parseMemValueToMB('abc'), null);
    assert.strictEqual(_parseMemValueToMB('-5M'), null); // 负数拒绝
  });

  test('free: 新版 free -k (含 available 第 6 列) 不提取 available 但正常解析 3 列', () => {
    const out = '              total        used        free      shared  buff/cache   available\n' +
                'Mem:        16258316     3456789    12800000      100000     4500000    8500000\n' +
                'Swap:        8388604           0     8388604\n';
    const r = parseFree(out);
    assert.ok(r);
    assert.strictEqual(r.totalMB, Math.round((16258316 / 1024) * 100) / 100);
    assert.strictEqual(r.usedMB, Math.round((3456789 / 1024) * 100) / 100);
    assert.ok(!('availableMB' in r), '不得提取语义有歧义的 available 列');
  });

  // ---------- 4. uptime 多格式 ----------
  test('uptime: "up 3 hours, 5 minutes" 运行时长格式', () => {
    const r = parseUptime(' 09:15:00 up 3 hours, 5 minutes,  1 user,  load average: 0.00, 0.01, 0.05');
    assert.ok(r);
    assert.strictEqual(r.up, '3 hours, 5 minutes');
    assert.strictEqual(r.load1, 0);
    assert.strictEqual(r.load15, 0.05);
  });

  test('uptime: 多空格与仅 1 个负载值 (load5/load15 -> null)', () => {
    const r = parseUptime('up 1 day,  2:03,  2 users,  load average: 0.52');
    assert.ok(r);
    assert.strictEqual(r.load1, 0.52);
    assert.strictEqual(r.load5, null);
    assert.strictEqual(r.load15, null);
  });

  // ---------- 5. os-release 引号 ----------
  test('os-release: 单引号 / 无引号 / PRETTY_NAME 值内含 =', () => {
    assert.strictEqual(parseOsRelease("PRETTY_NAME='Rocky Linux 9.3 (Blue Onyx)'\nID=rocky\n"), 'Rocky Linux 9.3 (Blue Onyx)');
    assert.strictEqual(parseOsRelease('PRETTY_NAME=Alpine Linux v3.19\n'), 'Alpine Linux v3.19');
    assert.strictEqual(parseOsRelease('NAME="Custom OS = Test"\n'), 'Custom OS = Test'); // NAME 兜底
  });

  // ---------- 6. 隐藏路径零清理静态断言 (grep 级, 与 tray-test 互补) ----------
  test('静态: close->hide 隐藏路径不含任何会话/隧道清理调用', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const start = mainSrc.indexOf('win.on(\'close\'');
    const end = mainSrc.indexOf('win.on(\'closed\'');
    const block = mainSrc.slice(start, end);
    for (const bad of ['stopAllTunnels', 'sessions.clear', 'sessions.delete', 'conn.end', 'sftp.end', 'cleanupAllSessions']) {
      assert.ok(!block.includes(bad), `隐藏路径不得出现 ${bad}`);
    }
    // 隐藏路径应有 preventDefault + hide
    assert.ok(block.includes('e.preventDefault()'));
    assert.ok(block.includes('win.hide()'));
  });

  test('静态: cleanupAllSessions 仅由 before-quit 调用 (唯一调用点)', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    // 仅统计真正的调用语句 (cleanupAllSessions();), 排除函数声明行
    // "function cleanupAllSessions() {" 与注释中的提及 (此前误用 includes 会把声明行计入)。
    const calls = mainSrc.split('\n').filter((l) => /^\s*cleanupAllSessions\(\)\s*;/.test(l)).length;
    assert.strictEqual(calls, 1, 'cleanupAllSessions() 调用点应恰为 1 (before-quit 内)');
  });

  console.log(`\nqa-supplemental-monitor: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
