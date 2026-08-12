/**
 * FgmSSH - 隧道/端口转发管理器 (纯 node, 无 Electron 依赖)
 * ============================================================
 * 职责:
 *   - 以「会话」为粒度维护隧道注册表: sessionKey -> Map<tunnelId, record>
 *   - 建立隧道: net.createServer 监听本地端口, 连接到来时经 ssh2 Client.forwardOut
 *     转发到远端 host:port (与 main.js 原有 createTunnel 行为一致, 此处为可测试封装)。
 *   - 查询/停止/会话清理: listTunnels / stopTunnel / stopAllTunnels
 *   - 连接建立后自动建立配置中的隧道: autoStartTunnels (逐个容错, 失败不抛出)
 *   - 审计联动: 通过注入的 onAudit 回调上报 tunnel.start / tunnel.stop / tunnel.error,
 *     target 统一为 `localhost:<localPort> -> <remoteHost>:<remotePort>`, 不含敏感信息。
 *
 * 设计要点:
 *   - 本模块不 require('electron'), net 通过 createTunnelManager({ net }) 注入,
 *     tests/tunnel-test.js 可注入 mock net / mock conn / 审计捕获器 node 直跑。
 *   - 所有回调均容错: 事件/审计回调内部异常不向业务路径传播。
 *   - 隧道生命周期: 会话关闭时调用 stopAllTunnels 关闭全部监听并清空注册表,
 *     防止本地端口泄漏。
 */

/**
 * 创建隧道管理器实例。
 * @param {object} opts
 *   - net: net 模块 (createServer 提供方); 未注入时 require('net')。
 *   - now: 时间戳函数 (默认 Date.now), 便于测试注入固定时间。
 * @returns {{
 *   startTunnel({sessionKey, conn, cfg, handlers}): Promise<{ok, tunnelId?, error?}>,
 *   autoStartTunnels({sessionKey, conn, tunnels, handlers, startFn?}): Promise<Array>,
 *   listTunnels(sessionKey): Array,
 *   stopTunnel(sessionKey, tunnelId, handlers?): {ok, error?},
 *   stopAllTunnels(sessionKey, handlers?): {ok, stopped},
 *   describeTarget(cfg): string,
 * }}
 */
function createTunnelManager(opts) {
  const deps = opts || {};
  const netImpl = deps.net || require('net');
  const nowFn = (typeof deps.now === 'function') ? deps.now : () => Date.now();

  // 会话注册表: sessionKey -> Map<tunnelId, record>
  // record = { id, cfg:{localPort,remoteHost,remotePort,name}, status, createdAt, error, server }
  const registries = new Map();
  let idSeq = 0;

  /**
   * 生成隧道 ID: t_<时间戳36进制>_<自增>
   * @returns {string}
   */
  function tunnelId() {
    idSeq += 1;
    return 't_' + Date.now().toString(36) + '_' + idSeq.toString(36);
  }

  /**
   * 获取会话注册表 (不存在时按 create 决定是否新建)。
   * @param {string} sessionKey
   * @param {boolean} create
   * @returns {Map|null}
   */
  function getRegistry(sessionKey, create) {
    let reg = registries.get(sessionKey);
    if (!reg && create) {
      reg = new Map();
      registries.set(sessionKey, reg);
    }
    return reg || null;
  }

  /**
   * 归一化隧道配置: 远端主机为空默认 127.0.0.1。
   * @param {object} cfg
   * @returns {{localPort:number, remoteHost:string, remotePort:number, name:string}}
   */
  function describe(cfg) {
    const src = (cfg && typeof cfg === 'object') ? cfg : {};
    return {
      localPort: Number(src.localPort),
      remoteHost: (typeof src.remoteHost === 'string' && src.remoteHost.trim() !== '')
        ? src.remoteHost.trim()
        : '127.0.0.1',
      remotePort: Number(src.remotePort),
      name: (typeof src.name === 'string') ? src.name : '',
    };
  }

  /**
   * 隧道审计 target 描述: `localhost:<localPort> -> <remoteHost>:<remotePort>`
   * @param {{localPort:number, remoteHost:string, remotePort:number}} cfg
   * @returns {string}
   */
  function describeTarget(cfg) {
    const c = describe(cfg);
    return `localhost:${c.localPort} -> ${c.remoteHost}:${c.remotePort}`;
  }

  /**
   * 安全调用回调 (事件/审计): 回调内部异常不向业务路径传播。
   * @param {Function} cb
   * @param {Array} args
   */
  function safeCall(cb, args) {
    if (typeof cb !== 'function') return;
    try { cb.apply(null, args); } catch (e) { /* 回调异常忽略, 不打断隧道流程 */ }
  }

  /**
   * 建立一条隧道并登记到会话注册表。
   * 与 main.js 原有 createTunnel 行为一致: net.createServer + conn.forwardOut,
   * 监听 127.0.0.1:<localPort>; 成功/失败均返回结构化结果。
   * @param {object} p
   *   - sessionKey: `${winId}:${sessionId}`
   *   - conn: ssh2 Client 实例 (需已连接, 提供 forwardOut)
   *   - cfg: { localPort, remoteHost?, remotePort, name? }
   *   - handlers: { onEvent?, onAudit?, isSessionAlive? }
   * @returns {Promise<{ok:boolean, tunnelId?:string, error?:string}>}
   */
  function startTunnel({ sessionKey, conn, cfg, handlers }) {
    const h = handlers || {};
    const onEvent = h.onEvent || (() => {});
    const onAudit = h.onAudit || (() => {});
    const isAlive = (typeof h.isSessionAlive === 'function') ? h.isSessionAlive : () => true;

    const norm = describe(cfg);
    const target = describeTarget(norm);

    // 端口合法性校验 (失败记审计, 不创建监听)
    if (!Number.isInteger(norm.localPort) || norm.localPort < 1 || norm.localPort > 65535) {
      const err = `本地端口无效: ${cfg.localPort}`;
      safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: err }]);
      return Promise.resolve({ ok: false, error: err });
    }
    if (!Number.isInteger(norm.remotePort) || norm.remotePort < 1 || norm.remotePort > 65535) {
      const err = `远端端口无效: ${cfg.remotePort}`;
      safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: err }]);
      return Promise.resolve({ ok: false, error: err });
    }

    // 同会话内本地端口重复检查 (仅对运行中的记录)
    const reg = getRegistry(sessionKey, true);
    for (const rec of reg.values()) {
      if (rec.status === 'running' && rec.cfg.localPort === norm.localPort) {
        const err = `本地端口 ${norm.localPort} 已在该会话中使用`;
        safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: err }]);
        return Promise.resolve({ ok: false, error: err });
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const id = tunnelId();
      const record = {
        id,
        cfg: norm,
        status: 'starting',
        createdAt: nowFn(),
        error: null,
        server: null,
      };
      reg.set(id, record);

      // 创建本地监听 (与原有 createTunnel 一致: 收到连接 -> forwardOut 到远端)
      let server;
      try {
        server = netImpl.createServer((socket) => {
          try {
            conn.forwardOut('127.0.0.1', norm.localPort, norm.remoteHost, norm.remotePort, (err, stream) => {
              if (err) {
                try { socket.destroy(); } catch (e) {}
                return;
              }
              try { socket.pipe(stream).pipe(socket); } catch (e) {}
            });
          } catch (e) {
            try { socket.destroy(); } catch (e2) {}
          }
        });
      } catch (e) {
        reg.delete(id);
        const err = `创建隧道监听失败: ${(e && e.message) || e}`;
        safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: err }]);
        settle({ ok: false, error: err });
        return;
      }
      record.server = server;

      // 监听/运行错误 (端口被占用等): 标记失败 + 审计 + 清理登记
      server.on('error', (err) => {
        const msg = (err && err.message) || '隧道错误';
        record.status = 'failed';
        record.error = msg;
        try { server.close(); } catch (e) {}
        reg.delete(id);
        safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: msg }]);
        safeCall(onEvent, [{ type: 'tunnel-error', tunnelId: id, message: `${target} 失败: ${msg}` }]);
        settle({ ok: false, error: msg });
      });

      server.listen(norm.localPort, '127.0.0.1', () => {
        // 会话已关闭/重建: 立即停止, 避免端口泄漏
        if (!isAlive()) {
          try { server.close(); } catch (e) {}
          reg.delete(id);
          settle({ ok: false, error: '会话已关闭, 隧道未建立' });
          return;
        }
        record.status = 'running';
        safeCall(onAudit, [{
          type: 'tunnel.start',
          target,
          result: 'success',
          detail: `隧道已建立: ${target}`,
        }]);
        safeCall(onEvent, [{ type: 'tunnel', tunnelId: id, message: `隧道已建立: ${target}` }]);
        settle({ ok: true, tunnelId: id });
      });
    });
  }

  /**
   * 连接建立后自动建立配置中的隧道 (逐个容错)。
   * - 隧道创建失败不抛出, 不阻塞后续隧道与连接流程;
   * - 内部 startTunnel 已负责审计 tunnel.start / tunnel.error;
   * - startFn 注入用于测试断言 (默认内部 startTunnel)。
   * @param {object} p
   *   - sessionKey, conn, tunnels (array of {localPort, remoteHost?, remotePort, name?})
   *   - handlers: 同 startTunnel
   *   - startFn?: 可选创建函数 (默认内部 startTunnel), 测试注入 mock
   * @returns {Promise<Array<{cfg, ok, tunnelId?, error?}>>}
   */
  async function autoStartTunnels({ sessionKey, conn, tunnels, handlers, startFn }) {
    const h = handlers || {};
    const onAudit = h.onAudit || (() => {});
    const start = (typeof startFn === 'function') ? startFn : (p2) => startTunnel(p2);
    const list = Array.isArray(tunnels) ? tunnels : [];
    const results = [];
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      const cfg = {
        localPort: t.localPort,
        remoteHost: (typeof t.remoteHost === 'string' && t.remoteHost.trim() !== '')
          ? t.remoteHost.trim()
          : '127.0.0.1',
        remotePort: t.remotePort,
        name: (typeof t.name === 'string') ? t.name : '',
      };
      let res;
      try {
        res = await start({ sessionKey, conn, cfg, handlers: h });
      } catch (e) {
        // 创建函数抛出 (异常路径): 审计 tunnel.error, 继续后续隧道, 不向连接流程传播
        const target = describeTarget(cfg);
        const errMsg = (e && e.message) || '隧道创建异常';
        safeCall(onAudit, [{ type: 'tunnel.error', target, result: 'failure', detail: errMsg }]);
        res = { ok: false, error: errMsg };
      }
      results.push({
        cfg,
        ok: !!(res && res.ok),
        tunnelId: res && res.tunnelId,
        error: res && res.error,
      });
    }
    return results;
  }

  /**
   * 查询会话隧道列表 (公开字段, 按创建时间升序)。
   * @param {string} sessionKey
   * @returns {Array<{id, localPort, remoteHost, remotePort, name, status, createdAt, error}>}
   */
  function listTunnels(sessionKey) {
    const reg = getRegistry(sessionKey, false);
    if (!reg) return [];
    return [...reg.values()]
      .map((rec) => ({
        id: rec.id,
        localPort: rec.cfg.localPort,
        remoteHost: rec.cfg.remoteHost,
        remotePort: rec.cfg.remotePort,
        name: rec.cfg.name,
        status: rec.status,
        createdAt: rec.createdAt,
        error: rec.error,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 停止隧道并移除登记 (按 tunnelId, 兼容按 localPort)。
   * 停止后从列表移除 (测试约定); 审计 tunnel.stop。
   * @param {string} sessionKey
   * @param {string|number} tunnelId - 隧道 ID 或本地端口
   * @param {object} handlers - { onAudit?, onEvent? }
   * @returns {{ok:boolean, error?:string}}
   */
  function stopTunnel(sessionKey, tunnelId, handlers) {
    const h = handlers || {};
    const onAudit = h.onAudit || (() => {});
    const onEvent = h.onEvent || (() => {});
    const reg = getRegistry(sessionKey, false);
    if (!reg) return { ok: false, error: '会话不存在' };

    let record = reg.get(String(tunnelId));
    if (!record) {
      // 兼容按本地端口停止
      const byPort = [...reg.values()].find((r) => r.cfg.localPort === Number(tunnelId));
      if (!byPort) return { ok: false, error: '隧道不存在' };
      record = byPort;
    }

    const norm = record.cfg;
    const wasRunning = record.status === 'running';
    try { if (record.server) record.server.close(); } catch (e) {}
    reg.delete(record.id);

    safeCall(onAudit, [{
      type: 'tunnel.stop',
      target: describeTarget(norm),
      result: 'success',
      detail: wasRunning
        ? `隧道已停止: ${describeTarget(norm)}`
        : `隧道已移除: ${describeTarget(norm)}`,
    }]);
    safeCall(onEvent, [{
      type: 'tunnel-stopped',
      tunnelId: record.id,
      message: `隧道已停止: ${describeTarget(norm)}`,
    }]);
    return { ok: true };
  }

  /**
   * 会话关闭清理: 关闭全部监听并清空注册表。
   * 对每条运行/启动中的隧道记 audit tunnel.stop (detail 标注会话关闭)。
   * @param {string} sessionKey
   * @param {object} handlers - { onAudit? }
   * @returns {{ok:boolean, stopped:number}}
   */
  function stopAllTunnels(sessionKey, handlers) {
    const h = handlers || {};
    const onAudit = h.onAudit || (() => {});
    const reg = getRegistry(sessionKey, false);
    if (!reg) return { ok: true, stopped: 0 };

    const records = [...reg.values()];
    let stopped = 0;
    for (const rec of records) {
      const wasActive = rec.status === 'running' || rec.status === 'starting';
      if (wasActive) stopped += 1;
      try { if (rec.server) rec.server.close(); } catch (e) {}
      if (wasActive) {
        safeCall(onAudit, [{
          type: 'tunnel.stop',
          target: describeTarget(rec.cfg),
          result: 'success',
          detail: `会话关闭, 隧道已停止: ${describeTarget(rec.cfg)}`,
        }]);
      }
    }
    reg.clear();
    return { ok: true, stopped };
  }

  return {
    startTunnel,
    autoStartTunnels,
    listTunnels,
    stopTunnel,
    stopAllTunnels,
    describeTarget,
  };
}

module.exports = { createTunnelManager };
