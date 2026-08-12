/**
 * NimbusSSH GPU 监控折线图模块回归测试 (node 直跑, 不依赖 Electron / DOM)
 * 运行: node tests/gpu-chart-test.js
 * 覆盖:
 *   1. createGpuHistory: 滚动窗口上限 (60 点不无限增长) / push 返回值 / clear
 *   2. buildGpuChartSvg: 0/1/N 个采样点的 SVG 输出
 *   3. 折线数据: 至少 2 条线 (util 主 + memPct 副) / Y 轴 0-100% / X 轴时间标签
 *   4. 边界: null 指标跳过 / 越界值钳制到 0-100 / 非法时间戳标签为空
 */
'use strict';
const assert = require('assert');
const gpuChart = require('../src/gpu-chart');

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
  // ---------- 1. createGpuHistory 滚动窗口 ----------
  test('createGpuHistory: 默认窗口上限 60, push 超出后丢弃最旧点 (不无限增长)', () => {
    const h = gpuChart.createGpuHistory();
    assert.strictEqual(h.max, 60);
    for (let i = 0; i < 70; i++) h.push(1000 + i * 5000, i % 100, 50);
    assert.strictEqual(h.length(), 60, '超过 60 点后应裁剪');
    assert.strictEqual(h.points[0].t, 1000 + 10 * 5000, '最旧的 10 点应被丢弃');
    assert.strictEqual(h.points[59].t, 1000 + 69 * 5000, '最新的点应保留');
  });

  test('createGpuHistory: 自定义窗口上限', () => {
    const h = gpuChart.createGpuHistory({ max: 5 });
    for (let i = 0; i < 8; i++) h.push(i, i, i);
    assert.strictEqual(h.length(), 5);
    assert.strictEqual(h.points[0].t, 3);
  });

  test('createGpuHistory: 非法/缺失值归一化为 null, 合法数字保留', () => {
    const h = gpuChart.createGpuHistory({ max: 10 });
    h.push(Date.now(), null, undefined);
    assert.strictEqual(h.points[0].util, null);
    assert.strictEqual(h.points[0].memPct, null);
    h.push(Date.now(), '45', 12.5);
    assert.strictEqual(h.points[1].util, 45);
    assert.strictEqual(h.points[1].memPct, 12.5);
  });

  test('createGpuHistory: clear 清空窗口', () => {
    const h = gpuChart.createGpuHistory();
    h.push(1, 10, 20);
    h.clear();
    assert.strictEqual(h.length(), 0);
  });

  // ---------- 2. buildGpuChartSvg ----------
  test('buildGpuChartSvg: 60 个采样点 -> SVG + 2 条折线 + Y 网格 + X 时间标签', () => {
    const pts = [];
    const t0 = Date.parse('2026-08-12T10:00:00');
    for (let i = 0; i < 60; i++) pts.push({ t: t0 + i * 5000, util: (i % 100), memPct: 20 + (i % 60) });
    const svg = gpuChart.buildGpuChartSvg(pts);
    assert.ok(svg.startsWith('<svg'), '应以 <svg 开头');
    assert.ok(svg.includes('viewBox'), '应含 viewBox');
    const polylines = (svg.match(/<polyline/g) || []).length;
    assert.ok(polylines >= 2, '应至少 2 条折线 (util + memPct), 实际 ' + polylines);
    // Y 轴 0-100%: 0%/100% 刻度应存在
    assert.ok(svg.includes('>100%<'), 'Y 轴应含 100% 刻度');
    assert.ok(svg.includes('>0%<'), 'Y 轴应含 0% 刻度');
    // X 轴时间标签: 至少出现起始/结束时间
    assert.ok(svg.includes('10:00:00'), 'X 轴应含起始时间标签');
    assert.ok(svg.includes('10:04:55'), 'X 轴应含结束时间标签');
    // 图例
    assert.ok(svg.includes('GPU 利用率'), '应含利用率图例');
    assert.ok(svg.includes('显存占用'), '应含显存占用图例');
  });

  test('buildGpuChartSvg: 0 个采样点 -> 占位文案 (不生成折线)', () => {
    const svg = gpuChart.buildGpuChartSvg([]);
    assert.ok(svg.includes('等待采样数据'), '0 点应显示等待采样文案');
    assert.ok(!svg.startsWith('<svg'), '0 点不应生成 svg');
  });

  test('buildGpuChartSvg: 1 个采样点 -> 圆点表示', () => {
    const svg = gpuChart.buildGpuChartSvg([{ t: Date.now(), util: 42, memPct: 30 }]);
    assert.ok(svg.startsWith('<svg'), '1 点应生成 svg');
    assert.ok(svg.includes('<circle'), '1 点应用圆点表示');
    assert.ok(!svg.includes('<polyline'), '1 点不应生成折线');
  });

  test('buildGpuChartSvg: null 指标跳过折线点, 不生成假 0 值', () => {
    const t0 = Date.now();
    const pts = [
      { t: t0, util: 10, memPct: 10 },
      { t: t0 + 5000, util: null, memPct: null },
      { t: t0 + 10000, util: 20, memPct: 20 },
    ];
    const svg = gpuChart.buildGpuChartSvg(pts);
    assert.ok(svg.includes('<polyline'), '应生成折线 (仅含有效点)');
    assert.ok(!svg.includes('0,0'), '不应出现假 0 值折线点');
  });

  test('buildGpuChartSvg: 越界值钳制到 0-100 (Y 轴统一 0-100%)', () => {
    const svg = gpuChart.buildGpuChartSvg([
      { t: Date.now(), util: 150, memPct: -20 },
      { t: Date.now() + 5000, util: 50, memPct: 50 },
    ]);
    assert.ok(svg.startsWith('<svg'), '越界值不应导致异常');
  });

  test('buildGpuChartSvg: 全部非法时间戳 -> 降级为等待采样文案 (不抛错)', () => {
    const svg = gpuChart.buildGpuChartSvg([
      { t: 'not-a-date', util: 1, memPct: 1 },
      { t: 'also-bad', util: 2, memPct: 2 },
    ]);
    assert.ok(svg.includes('等待采样数据'), '非法时间戳应降级为等待采样文案');
  });

  test('buildGpuChartSvg: 混合合法/非法时间戳 -> 仅合法点生成折线 (不抛错)', () => {
    const t0 = Date.now();
    const svg = gpuChart.buildGpuChartSvg([
      { t: t0, util: 10, memPct: 10 },
      { t: 'bad', util: 50, memPct: 50 },
      { t: t0 + 5000, util: 20, memPct: 20 },
    ]);
    assert.ok(svg.startsWith('<svg'), '含合法时间戳时仍应生成 svg');
    assert.ok(svg.includes('<polyline'), '应生成折线 (跳过非法时间戳点)');
  });

  test('timeLabel: 时间戳 -> HH:MM:SS (本地时区)', () => {
    const t = Date.parse('2026-08-12T10:05:09'); // 无 Z 后缀 = 本地时区
    assert.strictEqual(gpuChart.timeLabel(t), '10:05:09');
    assert.strictEqual(gpuChart.timeLabel(null), '');
    assert.strictEqual(gpuChart.timeLabel('bad'), '');
  });

  console.log(`\ngpu-chart-test: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
