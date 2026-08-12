/**
 * NimbusSSH - GPU 监控折线图模块 (gpu-chart)
 * ============================================================
 * 职责:
 *   - GPU 折线图所需的纯逻辑: 滚动采样窗口管理 + 零依赖 SVG 折线图生成。
 *   - 滚动窗口: 最近 60 个采样点 (60×5s = 5 分钟), 与健康监控 5s 自动刷新联动;
 *     每次刷新成功即 push 一点, 超出上限自动丢弃最旧点 (不无限增长)。
 *   - SVG 折线图: 至少 2 条线 —— GPU 利用率 % (主) 与显存占用 % (副),
 *     Y 轴统一 0-100%, X 轴显示时间刻度 (最近 5 分钟), 颜色与深色主题协调。
 *
 * 设计要点:
 *   - 不依赖 DOM / window / Electron; UMD 形态: node 下 module.exports,
 *     浏览器 (renderer) 下挂载 window.GpuChart, 便于 tests/ 下 node 直跑。
 *   - 采样点结构: { t: 时间戳(ms), util: 利用率%, memPct: 显存占用% };
 *     值可能为 null (nvidia-smi 对个别指标返回 [N/A]), 折线跳过 null 点。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GpuChart = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_MAX_POINTS = 60; // 60×5s = 5 分钟滚动窗口

  // 主题色 (与 src/style.css :root 保持一致)
  const COLOR_UTIL = '#4f8cff';    // --accent 蓝: GPU 利用率主曲线
  const COLOR_MEM = '#3ecf8e';     // --green 绿: 显存占用副曲线
  const COLOR_GRID = '#1f2733';    // --border-soft
  const COLOR_TEXT = '#5c6673';    // --text-faint
  const COLOR_AXIS = '#2d3542';    // 坐标轴/基线

  // 数值归一化: 合法有限数字返回 number, 否则 null
  function toNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // 时间戳 -> HH:MM:SS (X 轴刻度标签; 非法时间戳回退为空串)
  function timeLabel(ms) {
    const t = toNum(ms);
    if (t === null || isNaN(new Date(t).getTime())) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * 创建 GPU 采样滚动窗口。
   * @param {object} [opts] - { max: 窗口上限 (默认 60) }
   * @returns {{
   *   max: number,
   *   points: Array<{t:number, util:number|null, memPct:number|null}>,
   *   push: (t:number, util:number|null, memPct:number|null) => Array,
   *   clear: () => Array,
   *   length: () => number
   * }}
   */
  function createGpuHistory(opts) {
    const max = (opts && typeof opts.max === 'number' && opts.max > 0) ? Math.floor(opts.max) : DEFAULT_MAX_POINTS;
    const points = [];

    /**
     * 追加一个采样点并裁剪窗口 (超出上限丢弃最旧点, 不无限增长)。
     * @param {number} t - 时间戳 (ms)
     * @param {number|null} util - GPU 利用率 %
     * @param {number|null} memPct - 显存占用 %
     * @returns {Array} 当前窗口数组
     */
    function push(t, util, memPct) {
      points.push({ t: toNum(t), util: toNum(util), memPct: toNum(memPct) });
      if (points.length > max) points.splice(0, points.length - max);
      return points;
    }

    /** 清空窗口 (面板重新打开时重置, 避免展示过期的稀疏采样)。 */
    function clear() {
      points.length = 0;
      return points;
    }

    return {
      max,
      points,
      push,
      clear,
      length: () => points.length,
    };
  }

  // 构建一条折线的 points 字符串 (跳过 null 值, 避免折线掉到 0 造成误导)
  function linePointsString(pts, key, toX, toY) {
    const parts = [];
    for (let i = 0; i < pts.length; i++) {
      const v = toNum(pts[i][key]);
      if (v === null) continue;
      parts.push(`${toX(i).toFixed(2)},${toY(v).toFixed(2)}`);
    }
    return parts.join(' ');
  }

  /**
   * 生成 GPU 折线图 SVG 字符串 (零依赖, 纯字符串拼接)。
   * - Y 轴 0-100% (统一刻度, 利用率与显存占用同尺度, 直观可比)
   * - X 轴时间刻度: 按实际采样时间范围均匀分布 (最多 6 个 HH:MM:SS 标签)
   * - 2 条折线: util (蓝) / memPct (绿); 0/1 个采样点时降级提示
   * - 颜色可注入: opts.colors = { util, mem, grid, text, axis },
   *   缺省回退深色常量 (与旧版一致); 浅色主题由 renderer 传入 (src/theme.js CHART_COLORS.light)
   * @param {Array<{t:number, util:number|null, memPct:number|null}>} pts
   * @param {object} [opts] - { width, height, colors } 可选画布尺寸/配色
   * @returns {string} SVG 字符串 (无采样点时返回占位文案)
   */
  function buildGpuChartSvg(pts, opts) {
    const o = opts || {};
    const W = (typeof o.width === 'number' && o.width > 0) ? o.width : 640;
    const H = (typeof o.height === 'number' && o.height > 0) ? o.height : 150;
    const pad = { top: 10, right: 12, bottom: 22, left: 36 };
    const plotLeft = pad.left;
    const plotRight = W - pad.right;
    const plotTop = pad.top;
    const plotBottom = H - pad.bottom;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;
    const arr = Array.isArray(pts) ? pts.filter((p) => p && toNum(p.t) !== null) : [];
    const maxY = 100;

    // 主题色: 注入优先, 缺省回退深色常量 (保证旧调用方/旧测试不破坏)
    const col = o.colors || {};
    const C = {
      util: col.util || COLOR_UTIL,
      mem: col.mem || COLOR_MEM,
      grid: col.grid || COLOR_GRID,
      text: col.text || COLOR_TEXT,
      axis: col.axis || COLOR_AXIS,
    };

    if (arr.length === 0) {
      return '<div class="gpu-chart-empty">等待采样数据... (开启自动刷新后每 5 秒采集一次)</div>';
    }

    const toY = (v) => plotBottom - (plotH * clamp(toNum(v) === null ? 0 : toNum(v), 0, maxY)) / maxY;
    const toX = (i) => (arr.length > 1 ? plotLeft + (plotW * i) / (arr.length - 1) : plotLeft + plotW / 2);

    // Y 轴网格 + 刻度标签 (0/25/50/75/100)
    let grid = '';
    for (let v = 0; v <= 100; v += 25) {
      const y = toY(v);
      grid += `<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="${C.grid}" stroke-width="1"/>`;
      grid += `<text x="${plotLeft - 6}" y="${(y + 3).toFixed(2)}" text-anchor="end" font-size="9" fill="${C.text}" font-family="Consolas, monospace">${v}%</text>`;
    }

    // X 轴时间刻度: 按采样时间范围均匀取最多 6 个标签
    let xTicks = '';
    const t0 = toNum(arr[0].t);
    const t1 = toNum(arr[arr.length - 1].t);
    if (t0 !== null && t1 !== null && t1 >= t0) {
      const ticks = 6;
      for (let i = 0; i < ticks; i++) {
        const t = t0 + ((t1 - t0) * i) / (ticks - 1);
        // 找到该时刻最近采样点索引 (均匀按时间而非按索引, 体现真实 5 分钟窗口)
        let idx = 0;
        let best = Infinity;
        for (let j = 0; j < arr.length; j++) {
          const diff = Math.abs(toNum(arr[j].t) - t);
          if (diff < best) { best = diff; idx = j; }
        }
        const x = toX(idx);
        const label = timeLabel(t);
        xTicks += `<text x="${x.toFixed(2)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${C.text}" font-family="Consolas, monospace">${label}</text>`;
      }
    }

    // 基线 + 边框
    const axes = `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${C.axis}" stroke-width="1"/>` +
      `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${C.axis}" stroke-width="1"/>`;

    // 折线: 至少 2 条 (util 主 / memPct 副); 1 个点时用圆点表示
    let series = '';
    if (arr.length === 1) {
      const p = arr[0];
      const cx = toX(0);
      const u = toNum(p.util);
      const m = toNum(p.memPct);
      if (u !== null) series += `<circle cx="${cx.toFixed(2)}" cy="${toY(u).toFixed(2)}" r="3" fill="${C.util}"/>`;
      if (m !== null) series += `<circle cx="${cx.toFixed(2)}" cy="${toY(m).toFixed(2)}" r="3" fill="${C.mem}"/>`;
    } else {
      const utilPts = linePointsString(arr, 'util', toX, toY);
      const memPts = linePointsString(arr, 'memPct', toX, toY);
      if (utilPts) series += `<polyline fill="none" stroke="${C.util}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${utilPts}"/>`;
      if (memPts) series += `<polyline fill="none" stroke="${C.mem}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${memPts}"/>`;
    }

    // 图例
    const legend = `<g font-size="9.5" fill="${C.text}" font-family="Segoe UI, Microsoft YaHei, sans-serif">` +
      `<rect x="${plotLeft}" y="${plotTop - 8}" width="8" height="8" rx="2" fill="${C.util}"/><text x="${plotLeft + 12}" y="${plotTop - 1}">GPU 利用率</text>` +
      `<rect x="${plotLeft + 86}" y="${plotTop - 8}" width="8" height="8" rx="2" fill="${C.mem}"/><text x="${plotLeft + 98}" y="${plotTop - 1}">显存占用</text>` +
      `</g>`;

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GPU 利用率与显存占用折线图">${grid}${xTicks}${axes}${series}${legend}</svg>`;
  }

  return {
    DEFAULT_MAX_POINTS,
    createGpuHistory,
    buildGpuChartSvg,
    timeLabel,
    toNum,
  };
}));
