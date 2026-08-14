/**
 * FgmSSH - 服务器健康监控解析模块 (health-parser)
 * ============================================================
 * 职责:
 *   - 将远端常用命令输出 (uptime / free / df / top / hostname / os-release / date /
 *     nvidia-smi) 解析为结构化指标, 供健康监控面板渲染 (基本信息/GPU/CPU/内存/磁盘)。
 *   - fetchMonitorData: 通过依赖注入的 exec 回调并发采集全部指标, 单条命令失败
 *     不阻塞整体 (对应 section 置 null + errors 记录原因), 便于 node 直跑测试。
 *
 * 设计要点:
 *   - 本模块不依赖 Electron (纯 node), main.js 注入 exec (ssh2 conn.exec 封装) 即可复用;
 *     tests/monitor-test.js 用 mock exec 覆盖正常/边界输出。
 *   - 命令字符串全部为编译期常量 (无用户输入拼接), 不引入 shell 注入面。
 *   - 兼容 Linux 常见发行版 (procps / busybox) 输出差异; 解析失败返回 null, 渲染层降级展示。
 *   - GPU 监控 (v19.1+): 采集 nvidia-smi 固定 CSV 格式 (最稳), 无 nvidia-smi 时
 *     fetchMonitorData 置 data.gpu=null + errors.gpu, 渲染层展示降级文案, 不阻塞面板。
 *   - UMD 形态 (与其他纯逻辑模块一致): node 下 module.exports, 浏览器挂 window.HealthParser;
 *     渲染层 (renderer.js) 解析后端 ssh_monitor_fetch 返回的 raw 命令输出时使用。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HealthParser = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

// 单个数值 + 单位后缀 -> MB 数值 (兼容 free -k 无后缀 KB / free -h 带 K/M/G/T 后缀)
// 输入: "15" -> 15 KB -> 0.015 MB; "3.2Gi" -> 3.2*1024 MB; "1234K" -> ~1.2 MB
function parseMemValueToMB(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([KkMmGgTt]?)(?:[iI]?B?)?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num) || num < 0) return null;
  const unit = (m[2] || '').toLowerCase();
  let mb = 0;
  if (unit === '') mb = num / 1024;            // KB (free -k 无后缀 / busybox free 默认 KB)
  else if (unit === 'k') mb = num / 1024;      // K
  else if (unit === 'm') mb = num;             // M
  else if (unit === 'g') mb = num * 1024;      // G
  else if (unit === 't') mb = num * 1024 * 1024; // T
  return Math.round(mb * 100) / 100;
}

/**
 * 解析 uptime 输出 -> 负载 + 运行时长
 * 兼容:
 *   - procps:  " 12:34:56 up 1 day,  2:03,  2 users,  load average: 0.52, 0.58, 0.59"
 *   - 运行时长多格式: "up 3 hours, 5 minutes" / "up 5 min" / "up 2 hours" / "up 3 days"
 *   - macOS:   "load averages: 1.34 1.56 1.47"
 *   - /proc/loadavg: "0.52 0.58 0.59 1/123 45678"
 * @param {string} text
 * @returns {{load1:number, load5:number, load15:number, up:string}|null}
 */
function parseUptime(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let loadNums = null;
  let up = null;

  // 1) load average: a, b, c (Linux uptime) / load averages: a b c (macOS)
  const la = text.match(/load\s+average[s]?\s*:\s*([\d.,\s]+)/i);
  if (la) {
    const nums = la[1].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length > 0) {
      loadNums = nums.slice(0, 3).map(Number);
    }
  }
  // 2) /proc/loadavg: "0.52 0.58 0.59 1/123 45678" (前 3 个字段即负载)
  if (!loadNums) {
    const proc = text.match(/^\s*(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/);
    if (proc) loadNums = [Number(proc[1]), Number(proc[2]), Number(proc[3])];
  }
  // 3) up 时长: 从 "up " 起捕获, 终止于后续 "N user(s)" / "load average(s)" / 行尾。
  //    覆盖 "up 1 day,  2:03,  2 users" -> "1 day,  2:03"; "up 3 hours, 5 minutes,  1 user" -> "3 hours, 5 minutes";
  //    "up 5 min" / "up 2 hours" / "up 3 days" / "up 2 days, 1:02" 等常见格式。
  const upMatch = text.match(/up\s+(.*?)(?:\s*,\s*\d+\s+users?|\s*,\s*load\s+averages?|$)/i);
  if (upMatch) up = upMatch[1].trim();

  if (!loadNums) return null;
  const out = {
    load1: loadNums[0],
    load5: loadNums.length > 1 ? loadNums[1] : null,
    load15: loadNums.length > 2 ? loadNums[2] : null,
  };
  if (up) out.up = up;
  return out;
}

/**
 * 解析 free 输出 -> 内存/交换分区 (MB)
 * 兼容:
 *   - free -k:  "Mem:  16258316 3456789 12800000 100000 4500000 8500000"
 *   - free -h:  "Mem:  15Gi  3.2Gi  11Gi  1.0Gi  4.3Gi  9.3Gi"
 *   - busybox:  "             total       used       free     shared    buffers     cached"
 *               "Mem:        16258316    3456789   12800000      100000     4500000    8500000"
 * Mem 列: total used free shared buffers cached; available 可选 (第 7 列, 新版 free -k)
 * Swap 列: total used free
 * @param {string} text
 * @returns {{totalMB:number, usedMB:number, freeMB:number, swapTotalMB:number, swapUsedMB:number, swapFreeMB:number}|null}
 */
function parseFree(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const memLine = text.split('\n').map((l) => l.trim()).find((l) => /^Mem:/i.test(l));
  if (!memLine) return null;
  const parts = memLine.split(/\s+/); // ['Mem:', ...]
  const vals = parts.slice(1).map(parseMemValueToMB);
  if (vals.length < 3 || vals.slice(0, 3).some((v) => v === null)) return null;

  const out = {
    totalMB: vals[0],
    usedMB: vals[1],
    freeMB: vals[2],
    swapTotalMB: null,
    swapUsedMB: null,
    swapFreeMB: null,
  };
  // 说明: 不额外提取 available 列 —— 新旧 free 第 6 列语义不同 (新版 available / 旧版 cached),
  // 渲染层仅展示 total/used/free + swap, 避免误导。

  const swapLine = text.split('\n').map((l) => l.trim()).find((l) => /^Swap:/i.test(l));
  if (swapLine) {
    const sv = swapLine.split(/\s+/).slice(1).map(parseMemValueToMB);
    if (sv.length >= 3 && sv.slice(0, 3).every((v) => v !== null)) {
      out.swapTotalMB = sv[0];
      out.swapUsedMB = sv[1];
      out.swapFreeMB = sv[2];
    }
  }
  return out;
}

// 磁盘挂载点白名单 (已废弃): 早期版本健康监控「磁盘」卡片按白名单过滤展示挂载点。
// 自 v1.1.0 (FgmSSH) 起恢复原逻辑 —— 全部挂载点按使用率降序展示 Top 5, 不再按白名单过滤,
// fetchMonitorData 已不再使用白名单路径。此常量仅保留导出以兼容既有测试与第三方 require。
// @deprecated 不要再在新代码中使用; 如需按挂载点过滤请直接调用 parseDf(text, max, whitelist)。
const DISK_MOUNT_WHITELIST = ['/', '/root/autodl-tmp', '/root/autodl-fs'];

/**
 * 归一化挂载点字符串 (白名单比较与展示的规范形式, parseDf 与 renderer 两端一致):
 *   - 去首尾空白 (防御 df 输出中的尾部空格/换行/回车)
 *   - 折叠连续空白为单个空格 (挂载点含空格时保持可读)
 *   - 去尾部斜杠 (df 可能输出 /root/autodl-tmp/), 但保留根 '/' 本身
 * 典型输入: "/root/autodl-tmp/  " -> "/root/autodl-tmp"; "/" -> "/"。
 * @param {*} s 原始挂载点 (可为 undefined/null)
 * @returns {string}
 */
function normalizeMountPath(s) {
  if (s === undefined || s === null) return '';
  let out = String(s).trim().replace(/\s+/g, ' ');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

// 磁盘解析诊断开关: NODE_ENV=development 或 NIMBUS_DEV_DIAG=1/true 时, parseDf 输出 df
// 原始行/解析 rows/过滤结果/未匹配白名单到 console (main.js 默认置 NIMBUS_DEV_DIAG=1,
// v23 起生产也开, 便于排查 df/白名单问题; 设 env=0 可关)。
// 修复: 浏览器环境无 process (WebView2), 直接引用 process.env 会抛 ReferenceError,
// 导致 parseDf -> parseMonitorResults 整体中断, 监控面板无数据。
function dfDiagEnabled() {
  try {
    return typeof process !== 'undefined' && !!process.env &&
      (process.env.NODE_ENV === 'development' ||
        process.env.NIMBUS_DEV_DIAG === '1' ||
        process.env.NIMBUS_DEV_DIAG === 'true');
  } catch (e) {
    return false;
  }
}

/**
 * 解析 df -h -P 输出 -> 磁盘挂载点列表 (按 Use% 降序, 最多 maxItems 条)
 * POSIX 单行格式: "Filesystem  Size  Used Avail Use% Mounted on"
 *                "/dev/sda1   99G   45G   49G  48% /"
 * @param {string} text
 * @param {number} [maxItems] 返回条数上限 (默认 5)
 * @param {string[]} [whitelist] 可选挂载点白名单。传入后先按白名单过滤, 再排序/截断
 *   (保证白名单内的挂载点不会被 Top-N 截断); 不传/空数组 -> 不过滤, 保持原行为。
 *   注意: fetchMonitorData 自 v1.1.0 起不再传白名单 (磁盘卡片恢复「全部挂载点按使用率
 *   降序 Top 5」), 白名单参数仅供需要过滤的调用方自行使用。
 * @returns {Array<{filesystem:string, size:string, used:string, avail:string, usePct:string, usedPct:number, mounted:string}>}
 */
function parseDf(text, maxItems, whitelist) {
  return parseDfWithUnmatched(text, maxItems, whitelist).matched;
}

/**
 * 单遍解析 df 输出并划分 白名单内/白名单外 挂载点 (parseDf 与磁盘卡片「未匹配白名单」
 * 调试区共用同一批 rows, 避免重复解析)。
 * @deprecated 自 v1.1.0 (FgmSSH) 起 fetchMonitorData 不再使用白名单路径, 磁盘卡片改为
 *   全部挂载点按使用率降序 Top 5; 本函数保留 (parseDf 依赖其实现, 且兼容既有测试/require),
 *   新代码请直接使用 parseDf。
 * 与 parseDf 同语义:
 *   - matched:   白名单内挂载点, 按 Use% 降序, 截断 limit (保证白名单不被 Top-N 挤掉)
 *   - unmatched: 白名单外挂载点, 按 Use% 降序, 不截断
 * 不传/空 whitelist -> matched=全部 rows, unmatched=[] (保持 parseDf 不过滤行为)。
 * @param {string} text
 * @param {number} [maxItems]
 * @param {string[]} [whitelist]
 * @returns {{matched:Array, unmatched:Array}}
 */
function parseDfWithUnmatched(text, maxItems, whitelist) {
  const limit = (typeof maxItems === 'number' && maxItems > 0) ? maxItems : 5;
  if (typeof text !== 'string' || !text.trim()) return { matched: [], unmatched: [] };
  const diag = dfDiagEnabled();
  if (diag) console.log('[health-parser][df] 原始输出:\n' + text);
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^Filesystem\s/.test(line)) continue;
    // 兼容行首 filesystem 前有前导空格 (df 列对齐) 已由 trim 处理
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue; // 少于 Filesystem Size Used Avail Use% Mount 的列, 跳过
    const filesystem = parts[0];
    const size = parts[1];
    const used = parts[2];
    const avail = parts[3];
    const usePctRaw = parts[4];
    // 挂载点归一化 (trim + 折叠连续空白 + 去尾斜杠, 保留根 '/'): 保证与白名单比较不受
    // 尾部空格/换行/trailing slash 影响; 返回的 mounted 一律为规范形式, 渲染层展示一致。
    const mounted = normalizeMountPath(parts.slice(5).join(' ')); // 挂载点可能含空格
    const pctMatch = String(usePctRaw).match(/(\d+(?:\.\d+)?)%?/);
    const usedPct = pctMatch ? parseFloat(pctMatch[1]) : null;
    rows.push({ filesystem, size, used, avail, usePct: usePctRaw, usedPct, mounted });
  }
  if (diag) console.log('[health-parser][df] 解析 rows:', JSON.stringify(rows.map((r) => ({ filesystem: r.filesystem, mounted: r.mounted, usedPct: r.usedPct }))));
  // 可选白名单过滤: 白名单自身也归一化后比较 (两侧一致), 且在排序/截断前执行,
  // 保证白名单内的挂载点不会被 Top-N 截断; 不传/空数组 -> 不过滤, 保持原行为。
  const normWhitelist = (Array.isArray(whitelist) && whitelist.length > 0)
    ? whitelist.map(normalizeMountPath)
    : null;
  const matched = [];
  const unmatched = [];
  for (const r of rows) {
    if (!normWhitelist || normWhitelist.includes(r.mounted)) matched.push(r);
    else unmatched.push(r);
  }
  if (diag) {
    console.log('[health-parser][df] 白名单(归一化):', JSON.stringify(normWhitelist));
    console.log('[health-parser][df] 过滤后:', JSON.stringify(matched.map((r) => r.mounted)), '共', matched.length, '条');
    console.log('[health-parser][df] 未匹配白名单:', JSON.stringify(unmatched.map((r) => r.mounted)), '共', unmatched.length, '条');
  }
  // 按使用率降序 (null 视为 0), 便于展示最紧张的挂载点
  matched.sort((a, b) => ((b.usedPct || 0) - (a.usedPct || 0)));
  unmatched.sort((a, b) => ((b.usedPct || 0) - (a.usedPct || 0)));
  return { matched: matched.slice(0, limit), unmatched };
}

/**
 * 解析 top -bn1 的 %Cpu 行 (或 mpstat 的 all 汇总行) -> CPU 使用率 (%)
 * 兼容:
 *   - procps:  "%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st"
 *   - 空格分隔: "%Cpu(s):  3.1 us  0.7 sy  95.8 id  0.3 wa" (busybox / 老版本 / 单核, 无逗号)
 *   - 多核:    "%Cpu0 :  ..." / "%Cpu1 :  ..." (取第一个 %Cpu 行)
 *   - mpstat:  "Average:  all  3.05  0.00  0.71  0.00  0.00  0.00  0.00  0.00  0.00  96.24"
 *              (列: %usr %nice %sys %iowait %irq %soft %steal %guest %gnice %idle)
 * @param {string} text
 * @returns {{user:number, system:number, idle:number, nice:number, iowait:number, steal:number}|null}
 */
function parseTopCpu(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split('\n');

  // 1) top 格式: 找第一个 %Cpu 行 (兼容 %Cpu(s) / %Cpu0 / %Cpu0 : 等)
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!/^%Cpu/i.test(line) || !line.includes(':')) continue;
    const rest = line.slice(line.indexOf(':') + 1);
    const pairs = {};
    // 1) procps 标准逗号分隔: "3.1 us,  0.7 sy, ..." (值+单位在同一 token)
    const tokens = rest.split(',').map((t) => t.trim()).filter(Boolean);
    for (const tok of tokens) {
      const m = tok.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
      if (m) {
        const key = m[2].toLowerCase();
        const val = parseFloat(m[1]);
        if (isFinite(val)) pairs[key] = val;
      }
    }
    // 2) 逗号切分解析不到 us/sy/id 时回退: 空格分隔 (busybox top / 老版本 / 单核输出)
    //    形如 "3.1 us  0.7 sy  95.8 id  0.3 wa" -> 数值与单位是相邻独立 token, 需配对
    if (pairs.us === undefined && pairs.sy === undefined && pairs.id === undefined) {
      const spaceTokens = rest.split(/\s+/).filter(Boolean);
      for (let i = 0; i < spaceTokens.length - 1; i++) {
        const numMatch = spaceTokens[i].match(/^([\d.]+)$/);
        const unitMatch = spaceTokens[i + 1].match(/^([a-zA-Z]+)$/);
        if (numMatch && unitMatch) {
          const key = unitMatch[1].toLowerCase();
          const val = parseFloat(numMatch[1]);
          if (isFinite(val)) pairs[key] = val;
        }
      }
    }
    // 需要至少 us/sy/id 之一 (busybox top 无 %Cpu 行, 跳过)
    if (pairs.us !== undefined || pairs.sy !== undefined || pairs.id !== undefined) {
      return {
        user: pairs.us !== undefined ? pairs.us : null,
        system: pairs.sy !== undefined ? pairs.sy : null,
        idle: pairs.id !== undefined ? pairs.id : null,
        nice: pairs.ni !== undefined ? pairs.ni : null,
        iowait: pairs.wa !== undefined ? pairs.wa : null,
        steal: pairs.st !== undefined ? pairs.st : null,
      };
    }
  }

  // 2) mpstat 格式: "Average:  all  3.05  0.00  0.71 ..." (无 %Cpu 行时尝试)
  const mpLine = lines.map((l) => l.trim()).find((l) => /^Average:.*\ball\b/.test(l) || /^\d{2}:\d{2}:\d{2}\s+ALL\b/i.test(l));
  if (mpLine) {
    const parts = mpLine.split(/\s+/).filter(Boolean);
    // 期望: [Average:, all, usr, nice, sys, iowait, irq, soft, steal, guest, gnice, idle]
    const idxAll = parts.findIndex((p) => p.toLowerCase() === 'all');
    if (idxAll >= 0 && parts.length >= idxAll + 11) {
      const num = (i) => { const v = parseFloat(parts[i]); return isFinite(v) ? v : null; };
      const user = num(idxAll + 1);      // %usr
      const nice = num(idxAll + 2);      // %nice
      const system = num(idxAll + 3);    // %sys
      const iowait = num(idxAll + 4);    // %iowait
      const steal = num(idxAll + 7);     // %steal
      const idle = num(idxAll + 10);     // %idle
      if (user !== null || system !== null || idle !== null) {
        return { user, system, idle, nice, iowait, steal };
      }
    }
  }
  return null;
}

/**
 * 解析 /etc/os-release -> 发行版名称 (PRETTY_NAME 优先, NAME 兜底)
 * @param {string} text
 * @returns {string|null}
 */
function parseOsRelease(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^PRETTY_NAME\s*=/.test(line)) {
      const v = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^NAME\s*=/.test(line)) {
      const v = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return null;
}

// ---------- GPU 监控 (nvidia-smi) ----------

// 推荐采集命令 (固定 CSV 格式最稳): 字段顺序 = name, utilization.gpu, memory.used,
// memory.total, temperature.gpu, power.draw; nounits 去掉单位后缀 (memory 单位 MiB, 与 MB 同量级)。
// 单命令无管道/无 shell 元字符, 经 ssh2 conn.exec 在服务端默认 shell 执行, 无注入面。
const NVIDIA_SMI_QUERY = 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits';

// 简单的 CSV 行切分 (支持双引号包裹字段, nvidia-smi 在字段含逗号时会对字段加引号)
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

// 提取 nvidia-smi 数值指标: 兼容 "45" / "180.5" / "67 °C" / "5120 MiB" / "[N/A]" / "[Not Supported]"
function nvidiaNum(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 无数据占位符: [N/A] / N/A / [Not Supported] / NaN / [Unknown]
  if (/^\[?[Nn][Aa]\]?$/.test(s) || /not supported|unknown|nan/i.test(s)) return null;
  const m = s.match(/[\d.]+/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return isFinite(v) ? v : null;
}

// 解析单行 CSV 输出 -> GPU 对象 (字段不足/无名称 -> null)
function parseNvidiaSmiCsvLine(line) {
  const fields = splitCsvLine(line);
  if (fields.length < 2) return null;
  const name = (fields[0] || '').trim();
  if (!name) return null;
  const util = nvidiaNum(fields[1]);
  const memUsed = nvidiaNum(fields[2]);
  const memTotal = nvidiaNum(fields[3]);
  const temp = nvidiaNum(fields[4]);
  const power = nvidiaNum(fields[5]);
  const memPct = (memUsed !== null && memTotal !== null && memTotal > 0)
    ? Math.round((memUsed / memTotal) * 1000) / 10
    : null;
  return { name, util, memUsed, memTotal, memPct, temp, power, available: true };
}

// 标准表格输出降级解析 (best-effort):
// 设备行 "|   0  NVIDIA GeForce RTX 3080  On   | 00000000:01:00.0 Off | ..."
// 指标行 "| 30%   67C    P0    180W / 320W |   5120MiB / 10240MiB |     45%      Default |"
function parseNvidiaSmiTable(lines) {
  const gpus = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 设备行: 识别 "GPU 0" 或行首数字 + 名称 + On/Off
    const devMatch = line.match(/(?:GPU\s+)?(\d+)\s+([A-Za-z0-9][^|]*?)\s+(?:On|Off)\s*\|/);
    if (devMatch) {
      const name = devMatch[2].trim();
      current = { name, util: null, memUsed: null, memTotal: null, memPct: null, temp: null, power: null, available: true };
      gpus.push(current);
      continue;
    }
    // 指标行: 至少包含 MiB 内存占用才处理 (避免误匹配其它行)
    const memMatch = line.match(/([\d.]+)\s*MiB\s*\/\s*([\d.]+)\s*MiB/i);
    if (!memMatch) continue;
    if (!current) {
      current = { name: 'GPU', util: null, memUsed: null, memTotal: null, memPct: null, temp: null, power: null, available: true };
      gpus.push(current);
    }
    current.memUsed = parseFloat(memMatch[1]);
    current.memTotal = parseFloat(memMatch[2]);
    current.memPct = current.memTotal > 0 ? Math.round((current.memUsed / current.memTotal) * 1000) / 10 : null;
    // 温度: "67C" / "67 C" / "67°C"
    const tempMatch = line.match(/([\d.]+)\s*C(?:elsius)?\b/i);
    if (tempMatch) current.temp = parseFloat(tempMatch[1]);
    // 功耗: "180W / 320W"
    const powerMatch = line.match(/([\d.]+)\s*W\s*\/\s*([\d.]+)\s*W/i);
    if (powerMatch) current.power = parseFloat(powerMatch[1]);
    // 利用率: 第三列 "45% Default" / "45% Off" (Fan 列也在行首, 用 % + 关键字避免误取)
    const utilMatch = line.match(/([\d.]+)%\s+(?:Default|Off|Compute|On|MIG)/i);
    if (utilMatch) current.util = parseFloat(utilMatch[1]);
  }
  return gpus;
}

/**
 * 解析 nvidia-smi 输出 -> GPU 结构化数据。
 * 主路径: 固定 CSV 格式 (--query-gpu=... --format=csv,noheader,nounits);
 * 降级路径: 标准表格输出 (best-effort 尝试解析)。
 * 无 nvidia-smi / 无可用数据 -> null (渲染层展示降级文案, 不阻塞面板)。
 * @param {string} text
 * @returns {{available:boolean, gpus:Array<{name:string, util:number|null, memUsed:number|null,
 *   memTotal:number|null, memPct:number|null, temp:number|null, power:number|null, available:boolean}>}|null}
 */
function parseNvidiaSmi(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // 常见不可用输出: command not found / 无 NVIDIA 设备 / 驱动失败
  const joined = lines.join('\n');
  if (/command not found|no devices were found|nvidia-smi has failed/i.test(joined)) return null;

  // 1) CSV 格式: 每行一条 GPU (表格输出的装饰行含 | 直接跳过)
  const gpus = [];
  for (const line of lines) {
    if (line.includes('|')) continue;
    const g = parseNvidiaSmiCsvLine(line);
    if (g) gpus.push(g);
  }
  if (gpus.length > 0) return { available: true, gpus };

  // 2) 标准表格输出降级
  const tableGpus = parseNvidiaSmiTable(lines);
  if (tableGpus.length > 0) return { available: true, gpus: tableGpus };

  return null;
}

// 采集命令表 (全部编译期常量, 无用户输入; ssh2 exec 经服务端 shell 执行,
// 单命令无管道, 规避非标准 shell 的管道解析差异)。
// key = 语义 section (load/memory/disks/cpu/hostname/os/date), value = 命令字符串;
// 错误收集与结果字段均以 section 为键, 保证 errors 与 data 字段命名一致。
const MONITOR_COMMANDS = {
  load: 'uptime',
  memory: 'free -k',
  disks: 'df -h -P',
  cpu: 'top -bn1',
  hostname: 'hostname',
  os: 'cat /etc/os-release',
  date: 'date -u +%Y-%m-%dT%H:%M:%SZ',
  gpu: NVIDIA_SMI_QUERY,
};

/**
 * 由「section -> 命令原始 stdout」映射组装结构化监控数据 (纯函数)。
 * 供渲染层解析后端 `ssh_monitor_fetch` 返回的 raw 分组使用 (修复: 原实现后端只回 raw、
 * 前端未接入解析, 导致监控面板无数据显示)。
 * @param {object} results - { section: stdout字符串 } (如 raw 中每项的 .stdout)
 * @param {string} [identity] - 会话标识 (username@host), 原样返回供渲染层展示
 * @param {object} [execErrors] - 执行阶段收集的 section -> 原因, 合并进 errors
 * @returns {{
 *   identity: string, fetchedAt: string,
 *   info: {hostname: string|null, os: string|null, date: string|null},
 *   load: object|null, memory: object|null, disks: object[], cpu: object|null,
 *   gpu: {available:boolean, gpus:object[]}|null,
 *   errors: {[section:string]: string}
 * }}
 */
function parseMonitorResults(results, identity, execErrors) {
  const errors = Object.assign({}, execErrors || {});
  const src = (results && typeof results === 'object') ? results : {};

  // 磁盘: 全部挂载点按使用率降序, 截断 Top 5 (v21 之前原逻辑, 不按白名单过滤)。
  // 注: parseDfWithUnmatched / DISK_MOUNT_WHITELIST / diskUnmatched / diskMountWhitelist
  // 已废弃 —— 函数本体与导出保留 (兼容既有测试与 require), 但这里不再走白名单路径。
  const disks = src.disks ? parseDf(src.disks, 5) : [];

  const data = {
    identity: identity || '',
    fetchedAt: new Date().toISOString(),
    info: {
      hostname: src.hostname ? src.hostname.trim() || null : null,
      os: src.os ? parseOsRelease(src.os) : null,
      date: src.date ? src.date.trim() || null : null,
    },
    load: src.load ? parseUptime(src.load) : null,
    memory: src.memory ? parseFree(src.memory) : null,
    disks,
    cpu: src.cpu ? parseTopCpu(src.cpu) : null,
    gpu: src.gpu ? parseNvidiaSmi(src.gpu) : null,
    errors,
  };

  // 解析失败 (命令成功但输出无法解析): 记录到 errors, 便于渲染层展示降级原因
  if (src.load && !data.load) errors.load = '负载输出无法解析';
  if (src.memory && !data.memory) errors.memory = '内存输出无法解析';
  if (src.cpu && !data.cpu) errors.cpu = 'CPU 输出无法解析';
  if (src.os && !data.info.os) errors.os = '系统信息无法解析';
  if (src.gpu && !data.gpu) errors.gpu = 'GPU 输出无法解析';

  return data;
}

/**
 * 并发采集服务器健康指标 (依赖注入 exec, 便于单元测试)。
 * @param {object} opts
 * @param {(command:string)=>Promise<{stdout:string, stderr:string, code:number|null}>} opts.exec
 *   执行单条命令并返回输出的函数 (main.js 注入 ssh2 conn.exec 封装)。
 * @param {string} [opts.identity] 会话标识 (username@host), 原样返回供渲染层展示
 * @returns {Promise<{
 *   identity: string, fetchedAt: string,
 *   info: {hostname: string|null, os: string|null, date: string|null},
 *   load: object|null, memory: object|null, disks: object[], cpu: object|null,
 *   gpu: {available:boolean, gpus:object[]}|null,
 *   errors: {[section:string]: string}
 * }>}
 */
async function fetchMonitorData({ exec, identity }) {
  if (typeof exec !== 'function') throw new Error('exec 注入缺失');
  const errors = {};
  const results = {};

  // 每条命令独立 try/catch: 单条失败 -> errors[section] = 原因, 不阻塞整体
  await Promise.all(Object.keys(MONITOR_COMMANDS).map(async (section) => {
    try {
      const res = await exec(MONITOR_COMMANDS[section]);
      if (!res || typeof res.stdout !== 'string') {
        errors[section] = '命令无输出';
        return;
      }
      results[section] = res.stdout;
      if (res.stderr && res.stderr.trim()) {
        errors[section] = (res.stderr || '').trim().slice(0, 200);
      }
    } catch (err) {
      errors[section] = (err && err.message) ? String(err.message).slice(0, 200) : '执行失败';
    }
  }));

  return parseMonitorResults(results, identity, errors);
}

  return {
    parseUptime,
    parseFree,
    parseDf,
    parseDfWithUnmatched,
    parseTopCpu,
    parseOsRelease,
    parseNvidiaSmi,
    fetchMonitorData,
    parseMonitorResults,
    MONITOR_COMMANDS,
    NVIDIA_SMI_QUERY,
    DISK_MOUNT_WHITELIST,
    normalizeMountPath,
    dfDiagEnabled,
    _parseMemValueToMB: parseMemValueToMB,
  };
}));
