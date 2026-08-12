/**
 * NimbusSSH - 断线自动重连策略 (纯 node, 无 Electron 依赖)
 * ============================================================
 * 职责:
 *   - 会话意外断开 (非用户主动 disconnect/quit) 后, 按指数退避自动重连:
 *     1s / 2s / 4s / 8s / 16s / 32s ... 单次延迟上限 32s。
 *   - 总重试上限可配置 (默认 5 次); 重连成功即重置退避计数。
 *   - 取消/中止: cancel() 立即清除退避定时器; shouldAbort() 在每个尝试前
 *     被调用 (用户主动断开 / 应用退出 / 会话被关闭时返回 true 即中止)。
 *   - 致命失败 (凭据解密失败/无凭据): connectFn 返回 { ok:false, fatal:true }
 *     时立即放弃, 不再退避重试。
 *   - 审计联动: 通过注入的 onAudit 回调上报 reconnect.attempt / reconnect.success
 *     / reconnect.failed (detail 含第 N 次尝试, 不含任何凭据/敏感信息)。
 *   - 状态联动: 通过注入的 onState 回调上报 connecting / attempt / waiting /
 *     failed / success / gaveup / canceled, 供渲染层展示「已断开 · 重连中 (N/M)」。
 *
 * 设计要点:
 *   - 本模块不 require('electron'), 定时器/connectFn/回调全部由调用方注入,
 *     tests/reconnect-test.js 可注入 mock 定时器与 mock 连接工厂 node 直跑。
 *   - 退避序列语义: 第 N 次尝试在「上一次失败后 delayForAttempt(N)」启动,
 *     即 1s, 2s, 4s, 8s, 16s, 32s(封顶), 32s, ... (指数退避, 上限 32s)。
 *   - 所有回调均容错: onAudit/onState/shouldAbort 内部异常不向业务路径传播。
 */

/**
 * 创建断线自动重连控制器。
 * @param {object} opts
 *   - maxAttempts: 总重试上限 (默认 5; 须为正整数)
 *   - baseDelayMs: 首次退避延迟 (默认 1000ms)
 *   - maxDelayMs:  单次延迟上限 (默认 32000ms)
 *   - connectFn:   async ({attempt}) => Promise<{ok:boolean, error?:string, fatal?:boolean}>
 *                  每次重连尝试; 返回 {ok:true} 表示重连成功; {ok:false, fatal:true}
 *                  表示不可重试的致命失败 (凭据问题), 立即放弃; 其余失败进入退避重试。
 *   - shouldAbort: () => boolean  每次尝试前/调度前调用; 返回 true 立即中止 (用户断开/退出)。
 *   - onAudit:     (entry) => void 审计回调 (reconnect.attempt/success/failed)。
 *   - onState:     (state) => void 状态回调 ({status, attempt, maxAttempts, delay?, error?})。
 *   - setTimeoutFn / clearTimeoutFn: 定时器注入 (测试用; 默认全局 setTimeout/clearTimeout)。
 * @returns {{
 *   start(): void,
 *   cancel(): void,
 *   reset(): void,
 *   isActive(): boolean,
 *   getAttempt(): number,
 *   delayForAttempt(n: number): number,
 *   maxAttempts: number,
 * }}
 */
function createReconnectRunner(opts) {
  const o = opts || {};

  const maxAttempts = (Number.isInteger(o.maxAttempts) && o.maxAttempts > 0)
    ? o.maxAttempts
    : 5;
  const baseDelayMs = (Number.isFinite(o.baseDelayMs) && o.baseDelayMs > 0)
    ? o.baseDelayMs
    : 1000;
  const maxDelayMs = (Number.isFinite(o.maxDelayMs) && o.maxDelayMs > 0)
    ? o.maxDelayMs
    : 32000;
  const setTimeoutFn = (typeof o.setTimeoutFn === 'function') ? o.setTimeoutFn : setTimeout;
  const clearTimeoutFn = (typeof o.clearTimeoutFn === 'function') ? o.clearTimeoutFn : clearTimeout;
  const connectFn = (typeof o.connectFn === 'function')
    ? o.connectFn
    : async () => ({ ok: false, error: '未注入 connectFn' });
  const onAudit = (typeof o.onAudit === 'function') ? o.onAudit : () => {};
  const onState = (typeof o.onState === 'function') ? o.onState : () => {};
  const shouldAbort = (typeof o.shouldAbort === 'function') ? o.shouldAbort : () => false;

  let attempt = 0;      // 已发起/进行中的尝试序号 (成功或放弃后重置为 0)
  let timer = null;     // 当前退避定时器
  let active = false;   // 控制器是否在运行
  let canceled = false; // 取消标记

  /**
   * 安全调用注入回调: 内部异常不向业务路径传播。
   * @param {Function} cb
   * @param {Array} args
   */
  function safeCall(cb, args) {
    if (typeof cb !== 'function') return;
    try { cb.apply(null, args); } catch (e) { /* 回调异常忽略, 不打断重连流程 */ }
  }

  /**
   * 第 N 次尝试前的退避延迟 (指数退避, 上限 maxDelayMs)。
   * N=1 -> base; N=2 -> 2*base; N=3 -> 4*base; ...
   * @param {number} n 尝试序号 (从 1 开始)
   * @returns {number} 毫秒
   */
  function delayForAttempt(n) {
    const idx = Math.max(1, Math.min(Number(n) || 1, 30)); // 防溢出
    const exp = idx - 1;
    const delay = baseDelayMs * Math.pow(2, exp);
    return Math.min(maxDelayMs, delay);
  }

  /**
   * 执行一次重连尝试 (等待 connectFn 返回)。
   * 成功后: 重置退避计数并结束; 失败: 记审计 + 调度下一次退避 (或达到上限放弃)。
   * @returns {Promise<void>}
   */
  async function runAttempt() {
    if (canceled || !active) return;
    if (safeShouldAbort()) { cancel(); return; }

    attempt += 1;
    const current = attempt;
    safeCall(onState, [{ status: 'attempt', attempt: current, maxAttempts }]);
    safeCall(onAudit, [{
      type: 'reconnect.attempt',
      result: 'success',
      detail: `第 ${current}/${maxAttempts} 次重连尝试`,
    }]);

    let res;
    try {
      res = await connectFn({ attempt: current });
    } catch (e) {
      res = { ok: false, error: ((e && e.message) || '重连异常') };
    }
    // 尝试期间被取消 (用户关闭会话 / 应用退出): 静默结束
    if (canceled || !active) return;

    if (res && res.ok) {
      active = false;
      attempt = 0; // 重连成功: 重置退避计数
      safeCall(onAudit, [{
        type: 'reconnect.success',
        result: 'success',
        detail: `重连成功 (第 ${current} 次)`,
      }]);
      safeCall(onState, [{ status: 'success', attempt: current, maxAttempts }]);
      return;
    }

    const errMsg = (res && res.error) || '重连失败';
    safeCall(onAudit, [{
      type: 'reconnect.failed',
      result: 'failure',
      detail: `第 ${current}/${maxAttempts} 次重连失败: ${errMsg}`,
    }]);
    safeCall(onState, [{ status: 'failed', attempt: current, maxAttempts, error: errMsg }]);

    // 致命失败 (凭据解密失败/无凭据): 立即放弃, 不退避重试
    if (res && res.fatal) {
      active = false;
      attempt = 0;
      safeCall(onAudit, [{
        type: 'reconnect.failed',
        result: 'failure',
        detail: `重连放弃: ${errMsg}`,
      }]);
      safeCall(onState, [{ status: 'gaveup', attempt: current, maxAttempts, error: errMsg, fatal: true }]);
      return;
    }

    if (current >= maxAttempts) {
      active = false;
      attempt = 0;
      safeCall(onState, [{ status: 'gaveup', attempt: current, maxAttempts, error: errMsg }]);
      return;
    }
    scheduleNext();
  }

  /**
   * 调度下一次尝试 (退避延迟)。
   */
  function scheduleNext() {
    if (canceled || !active) return;
    if (safeShouldAbort()) { cancel(); return; }
    const next = attempt + 1;
    const delay = delayForAttempt(next);
    if (timer) clearTimeoutFn(timer);
    safeCall(onState, [{ status: 'waiting', attempt, maxAttempts, delay }]);
    timer = setTimeoutFn(() => {
      timer = null;
      runAttempt();
    }, delay);
  }

  /**
   * 包装 shouldAbort 的容错调用。
   * @returns {boolean}
   */
  function safeShouldAbort() {
    try {
      return !!shouldAbort();
    } catch (e) {
      return false; // 回调异常: 保守不中止 (由连接结果自然结束)
    }
  }

  /**
   * 启动重连流程 (幂等: 已在运行则忽略)。
   * 首次尝试同样经过 baseDelay 退避 (满足 1s/2s/4s... 序列语义)。
   */
  function start() {
    if (active) return;
    canceled = false;
    active = true;
    safeCall(onState, [{ status: 'connecting', attempt: 0, maxAttempts }]);
    scheduleNext();
  }

  /**
   * 取消重连: 清除定时器并停止后续尝试。
   * 幂等; 取消后仍可再次 start()。
   */
  function cancel() {
    canceled = true;
    active = false;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    safeCall(onState, [{ status: 'canceled', attempt, maxAttempts }]);
  }

  /**
   * 重置状态 (成功后由内部调用; 也可由外部手动重置退避计数)。
   */
  function reset() {
    attempt = 0;
    canceled = false;
  }

  return {
    start,
    cancel,
    reset,
    isActive: () => active,
    getAttempt: () => attempt,
    delayForAttempt,
    maxAttempts,
    _isCanceled: () => canceled,
  };
}

module.exports = { createReconnectRunner };
