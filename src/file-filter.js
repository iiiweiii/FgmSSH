/**
 * FgmSSH - SFTP 文件搜索/过滤模块 (file-filter)
 * ============================================================
 * 职责 (Roadmap 第三梯队 ①, 纯逻辑增量):
 *   - 客户端即时过滤: 对已加载的当前目录条目做不区分大小写子串过滤 (纯渲染层, 不触网)。
 *   - 服务端递归搜索: 构造 `find <cwd> -maxdepth N -iname "*keyword*" -print` 命令
 *     (防注入: 关键字白名单过滤 + 路径单引号转义 + maxdepth 上限钳制),
 *     以及解析 find 输出为结构化结果列表。
 *
 * 设计要点:
 *   - 不依赖 DOM / window / Electron; UMD 形态: node 下 module.exports,
 *     浏览器 (renderer) 下挂载 window.FileFilter, 便于 tests/ 下 node 直跑。
 *   - 安全边界 (与 main.js sftp:search 配合):
 *     * 关键字 sanitizeFindKeyword 只保留 [A-Za-z0-9._-] 与 CJK 字符 (白名单),
 *       长度上限 64; 其余字符一律剔除 -> find 命令中无 shell 元字符可注入。
 *     * cwd 必须为以 / 开头的绝对路径且不含 .. 段 (isSafeRemotePath 同语义)。
 *     * maxdepth 钳制到 1..3 (防爆量)。
 *     * 超时/输出上限由 main.js execSSHCommand 承担 (默认 8s / 64KB)。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FileFilter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 递归搜索最大深度 (防爆量; 钳制到 1..3)
  const DEFAULT_MAX_DEPTH = 3;
  const MAX_DEPTH_LIMIT = 3;
  const MIN_DEPTH_LIMIT = 1;
  // 关键字长度上限
  const MAX_KEYWORD_LEN = 64;
  // 递归搜索结果返回上限 (输出本身受 64KB 限制, 这里再兜一层防渲染卡顿)
  const MAX_RESULTS = 200;

  // 关键字白名单: 字母/数字/点/下划线/连字符 + CJK 常用区。其余字符 (含空格/引号/分号/
  // $ 等 shell 元字符) 一律剔除, 使关键字在 find -iname 模式内无注入面。
  function sanitizeFindKeyword(keyword) {
    if (typeof keyword !== 'string') return '';
    const k = keyword.trim();
    if (k.length === 0 || k.length > MAX_KEYWORD_LEN) return '';
    return k.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '');
  }

  // 校验递归搜索目标目录: 必须为以 / 开头的绝对路径, 且不含 .. 段
  function isSafeSearchCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return false;
    if (!cwd.startsWith('/')) return false;
    return !cwd.split('/').some((seg) => seg === '..');
  }

  // 单引号 shell 转义 (与 renderer.syncTerminalCwd 同语义; cwd 已通过白名单前置校验,
  // 此处作为纵深防御)
  function shellSingleQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  /**
   * 构造 find 递归搜索命令 (防注入)。
   * @param {string} cwd     - 搜索起始目录 (绝对路径, 以 / 开头, 无 .. 段)
   * @param {string} keyword - 搜索关键字 (经白名单过滤)
   * @param {object} [opts]  - { maxDepth: 1..3 }
   * @returns {string|null}  非法输入返回 null (调用方静默/提示)
   */
  function buildFindCommand(cwd, keyword, opts) {
    if (!isSafeSearchCwd(cwd)) return null;
    const kw = sanitizeFindKeyword(keyword);
    if (!kw) return null;
    let depth = Number((opts && opts.maxDepth) != null ? opts.maxDepth : DEFAULT_MAX_DEPTH);
    if (!Number.isFinite(depth)) depth = DEFAULT_MAX_DEPTH;
    depth = Math.max(MIN_DEPTH_LIMIT, Math.min(MAX_DEPTH_LIMIT, Math.floor(depth)));
    // 关键字已白名单化 (无 shell 元字符), 外层单引号仅为防 glob 意外展开/词分割;
    // cwd 走单引号转义。命令本身不含任何用户可控的 shell 元字符。
    return `find ${shellSingleQuote(cwd)} -maxdepth ${depth} -iname '*${kw}*' -print`;
  }

  /**
   * 解析 find -print 输出为结果列表。
   * 输出形态: 每行一个绝对路径 (find 以 cwd 开头输出绝对路径);
   * 过滤: 空行 / cwd 自身 / Permission denied 提示行 / 非绝对路径。
   * @param {string} output - find 原始 stdout
   * @param {string} cwd    - 搜索起始目录 (用于 ./ 前缀归一化)
   * @returns {Array<{path:string, name:string, dir:string}>}
   */
  function parseFindOutput(output, cwd) {
    const base = (typeof cwd === 'string' && cwd.startsWith('/')) ? cwd : '/';
    const results = [];
    const lines = String(output || '').split('\n');
    for (const line of lines) {
      const p = String(line).trim();
      if (!p) continue;
      if (p === base) continue;
      if (/permission denied/i.test(p)) continue;
      // 兼容部分实现输出 ./xxx 形态: 归一化为 cwd 下绝对路径
      let full = p;
      if (p.startsWith('./')) {
        full = base === '/' ? p.slice(1) : base + p.slice(1);
      }
      if (!full.startsWith('/')) continue;
      // 剔除尾斜杠 (目录条目)
      while (full.length > 1 && full.endsWith('/')) full = full.slice(0, -1);
      const parts = full.split('/');
      const name = parts.pop() || full;
      const dir = parts.join('/') || '/';
      if (!name) continue;
      results.push({ path: full, name, dir });
    }
    // 去重 (find 在某些平台可能重复输出) + 截断
    const seen = new Set();
    const unique = [];
    for (const r of results) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      unique.push(r);
      if (unique.length >= MAX_RESULTS) break;
    }
    return unique;
  }

  /**
   * 客户端即时过滤: 对已加载的当前目录条目做不区分大小写子串过滤 (纯渲染层)。
   * 空关键字 -> 返回原列表副本 (清空恢复全部); 非数组 -> 空数组。
   * @param {Array<{name:string}>} entries
   * @param {string} keyword
   * @returns {Array}
   */
  function filterEntries(entries, keyword) {
    const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
    if (!kw) return Array.isArray(entries) ? entries.slice() : [];
    if (!Array.isArray(entries)) return [];
    return entries.filter((en) => en && typeof en.name === 'string' && en.name.toLowerCase().includes(kw));
  }

  /**
   * 计算关键字在原始名称中的匹配区间 (不区分大小写), 供渲染层高亮命中子串。
   * @param {string} name
   * @param {string} keyword
   * @returns {{start:number, end:number}|null} 未命中返回 null
   */
  function matchRange(name, keyword) {
    if (typeof name !== 'string' || typeof keyword !== 'string' || !keyword) return null;
    const idx = name.toLowerCase().indexOf(keyword.trim().toLowerCase());
    if (idx === -1) return null;
    return { start: idx, end: idx + keyword.trim().length };
  }

  return {
    DEFAULT_MAX_DEPTH,
    MAX_DEPTH_LIMIT,
    MIN_DEPTH_LIMIT,
    MAX_KEYWORD_LEN,
    MAX_RESULTS,
    sanitizeFindKeyword,
    isSafeSearchCwd,
    buildFindCommand,
    parseFindOutput,
    filterEntries,
    matchRange,
  };
}));
