/**
 * NimbusSSH - 更新检查模块 (update-check)
 * ============================================================
 * 职责 (Roadmap 第一梯队 ③, 纯 node, 主进程使用):
 *   - 启动延迟静默检查 GitHub Releases API, 比对 tag_name 与本地版本。
 *   - 有新版本 -> 回调 onResult({hasUpdate:true, latest, tag, url});
 *     无新版本 / 失败 (离线/超时/无 tag) -> 静默 (onResult({ok:false,...})),
 *     由调用方决定审计与 UI 提示。
 *   - 不自动下载/不自动升级 (与 portable 单文件定位兼容)。
 *   - 定时: 默认启动一次 + 每 24h 一次 (intervalMs 可配置);
 *     autoCheck=false 时不启动任何定时器。
 *
 * 设计要点:
 *   - 纯 CommonJS, 不依赖 Electron; fetchFn / getVersion / 定时器全部可注入,
 *     便于 tests/ 下 node 直跑 (注入 fetch mock, 无真实网络)。
 *   - 版本比较 compareVersions: 兼容 v 前缀与预发布 tag (v1.2.3-beta.1);
 *     非语义化 tag 回退字符串比较 (确定性, 便于测试)。
 *   - 超时: 通过注入的 AbortController 实现 (fetch mock 也可直接 reject)。
 */

'use strict';

// GitHub API / Releases 页面 URL 构造 (owner/repo 由调用方注入配置常量)
const GITHUB_API = 'https://api.github.com/repos/';
const GITHUB_WEB = 'https://github.com/';

// 默认配置 (owner/repo 对应真实仓库; 调用方 main.js 总会显式注入, 此处仅为缺省兜底)
const DEFAULT_CONFIG = {
  owner: 'iiiweiii',
  repo: 'NimbusSSH',
  timeoutMs: 5000,        // 请求超时 (静默跳过)
  initialDelayMs: 4000,   // 启动延迟 (不阻塞启动)
  intervalMs: 24 * 3600 * 1000, // 每 24h 一次
  autoCheck: true,        // 总开关
  userAgent: 'nimbus-ssh-update-check',
};

/**
 * 归一化版本 tag: 去首尾空白 + 去掉 v/V 前缀。
 * @param {string} tag
 * @returns {string}
 */
function normalizeTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().replace(/^[vV]/, '');
}

/**
 * 解析语义化版本 (含预发布段)。
 * @param {string} tag
 * @returns {{major:number, minor:number, patch:number, pre:string|null}|null}
 */
function parseVersionParts(tag) {
  const t = normalizeTag(tag);
  const m = t.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.](.*))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? String(m[4]) : null,
  };
}

/**
 * 比较两个版本 tag (语义化; 非语义化回退字符串比较)。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 | 0 | 1 (a < b / a === b / a > b)
 */
function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) {
    const na = normalizeTag(a);
    const nb = normalizeTag(b);
    if (na === nb) return 0;
    return na < nb ? -1 : 1;
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 预发布: 无预发布段 > 有预发布段 (标准语义化)
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  // 逐段比较 (数字段按数值, 字母段按字典序; 数字段 < 字母段)
  const as = pa.pre.split(/[.-]/);
  const bs = pb.pre.split(/[.-]/);
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xn !== null) {
      return -1; // 数字段 < 字母段
    } else if (yn !== null) {
      return 1;
    } else {
      const c = x.localeCompare(y);
      if (c !== 0) return c < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 创建更新检查器 (工厂, 依赖全部可注入)。
 * @param {object} opts
 *   - getVersion: () => string   本地版本号
 *   - fetchFn: (url, init) => Promise<Response>  缺省由调用方注入 (main 用 net.fetch)
 *   - audit: (entry) => void     审计回调 (type: 'update.check')
 *   - onResult: (res) => void    检查完成回调 (成功/失败均回调, 供 UI/审计)
 *   - autoCheck / initialDelayMs / intervalMs / timeoutMs / owner / repo / userAgent
 *   - setTimeoutFn / clearTimeoutFn / setIntervalFn / clearIntervalFn (测试注入)
 * @returns {{checkOnce: Function, start: Function, stop: Function, compareVersions: Function}}
 */
function createUpdateChecker(opts) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, opts || {});
  const fetchFn = cfg.fetchFn || (() => Promise.reject(new Error('no_fetch_fn')));
  const setTimeoutFn = cfg.setTimeoutFn || setTimeout;
  const clearTimeoutFn = cfg.clearTimeoutFn || clearTimeout;
  const setIntervalFn = cfg.setIntervalFn || setInterval;
  const clearIntervalFn = cfg.clearIntervalFn || clearInterval;
  const audit = (typeof cfg.audit === 'function') ? cfg.audit : function () {};
  const onResult = (typeof cfg.onResult === 'function') ? cfg.onResult : function () {};

  const apiUrl = () => GITHUB_API + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/releases/latest';
  const releasesUrl = () => GITHUB_WEB + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/releases';

  let running = false;
  let intervalTimer = null;
  let initialTimer = null;

  /**
   * 执行一次更新检查 (静默失败, 返回结构化结果)。
   * @returns {Promise<{ok:boolean, hasUpdate?:boolean, current?:string, latest?:string, tag?:string, url?:string, error?:string}>}
   */
  async function checkOnce() {
    if (running) return { ok: false, error: 'already_running' };
    running = true;
    let timer = null;
    try {
      let controller = null;
      let signal;
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        signal = controller.signal;
        timer = setTimeoutFn(() => {
          try { controller.abort(); } catch (e) {}
        }, cfg.timeoutMs);
      }
      const init = {
        headers: { 'User-Agent': cfg.userAgent || DEFAULT_CONFIG.userAgent, Accept: 'application/vnd.github+json' },
      };
      if (signal) init.signal = signal;
      const res = await fetchFn(apiUrl(), init);
      if (timer) clearTimeoutFn(timer);
      if (!res || !res.ok) {
        const status = (res && res.status) || 0;
        throw new Error('http_' + status);
      }
      const data = await res.json();
      const tag = (data && typeof data.tag_name === 'string') ? data.tag_name : '';
      if (!tag) throw new Error('no_tag');
      const current = String(cfg.getVersion ? cfg.getVersion() : '0.0.0');
      const cmp = compareVersions(tag, current);
      const result = {
        ok: true,
        hasUpdate: cmp > 0,
        current,
        latest: tag,
        tag,
        url: (data && typeof data.html_url === 'string' && data.html_url) || releasesUrl(),
      };
      return result;
    } catch (err) {
      return { ok: false, error: ((err && err.message) || 'unknown') };
    } finally {
      if (timer) clearTimeoutFn(timer);
      running = false;
    }
  }

  // 首次检查 + 排程后续周期
  function runAndSchedule() {
    checkOnce().then((res) => {
      audit(res);
      onResult(res);
    });
    if (cfg.intervalMs > 0) {
      intervalTimer = setIntervalFn(() => {
        checkOnce().then((res) => {
          audit(res);
          onResult(res);
        });
      }, cfg.intervalMs);
    }
  }

  /**
   * 启动: 延迟 initialDelayMs 后首次检查, 之后每 intervalMs 一次。
   * autoCheck=false 或已启动 -> 幂等 no-op。
   */
  function start() {
    if (!cfg.autoCheck) return;
    if (initialTimer || intervalTimer) return;
    if (cfg.initialDelayMs > 0) {
      initialTimer = setTimeoutFn(() => {
        initialTimer = null;
        runAndSchedule();
      }, cfg.initialDelayMs);
    } else {
      runAndSchedule();
    }
  }

  /** 停止全部定时器 (幂等)。 */
  function stop() {
    if (initialTimer) { clearTimeoutFn(initialTimer); initialTimer = null; }
    if (intervalTimer) { clearIntervalFn(intervalTimer); intervalTimer = null; }
  }

  return {
    checkOnce,
    start,
    stop,
    compareVersions,
    normalizeTag,
    isRunning: () => running,
    apiUrl,
    releasesUrl,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  GITHUB_API,
  GITHUB_WEB,
  normalizeTag,
  parseVersionParts,
  compareVersions,
  createUpdateChecker,
};
