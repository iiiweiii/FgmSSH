/**
 * FgmSSH - 常用命令收藏模块 (fav-commands)
 * ============================================================
 * 职责:
 *   - 常用命令收藏的纯逻辑: localStorage 持久化 (key: nimbus.favCommands)
 *   - 列表模型: [{ name, cmd, ts }] (ts 为添加时间戳, 唯一标识, 删除用)
 *   - 命令发送: 原样追加 \r 提交 (与终端回车行为一致), 不做变量/模板解析
 *   - 安全: 列表渲染统一 escapeHtml (防 XSS); 空命令不添加
 *
 * 设计要点:
 *   - 不依赖 DOM / window / Electron; storage 与 write 由调用方注入,
 *     便于 tests/ 下 node 直跑 (注入 mock localStorage / 捕获 write 调用)。
 *   - UMD 形态: node 下 module.exports 导出; 浏览器 (renderer) 下挂载 window.FavCommands,
 *     renderer.js 以 window.localStorage 实例化, write 绑定到
 *     window.nimbus.write(当前活动会话 sessionId, cmd + '\r')。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FavCommands = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'nimbus.favCommands';
  const MAX_ITEMS = 100;      // 收藏上限 (防 localStorage 膨胀)
  const MAX_NAME_LEN = 60;    // 名称长度上限
  const MAX_CMD_LEN = 2000;   // 命令长度上限 (避免误存超长粘贴)

  /**
   * 创建收藏命令实例。
   * @param {object} opts
   *   - storage: 类 localStorage 对象 ({getItem, setItem}); 未注入则读写为内存空操作
   *   - write:   (cmd: string) => Promise — 发送命令到终端 (追加 \r 由 send 完成)
   *   - now:     () => number — 可选时间戳函数 (测试注入), 默认 Date.now
   */
  function createFavCommands(opts) {
    const o = opts || {};
    const store = (o.storage && typeof o.storage.getItem === 'function' && typeof o.storage.setItem === 'function')
      ? o.storage
      : null;
    const writeFn = (typeof o.write === 'function') ? o.write : null;
    const nowFn = (typeof o.now === 'function') ? o.now : Date.now;

    function nowTs() {
      try {
        const v = nowFn();
        return typeof v === 'number' && v > 0 ? v : Date.now();
      } catch (e) {
        return Date.now();
      }
    }

    // 合法条目: 对象 + 非空 cmd
    function isValidItem(item) {
      return !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof item.cmd === 'string' &&
        item.cmd.trim() !== '';
    }

    // 归一化: 名称截断/trim, 命令原样保留 (长度截断), ts 补齐
    function normalizeItem(item) {
      const name = String(item.name || '').trim().slice(0, MAX_NAME_LEN);
      return {
        name,
        cmd: String(item.cmd).slice(0, MAX_CMD_LEN),
        ts: (typeof item.ts === 'number' && item.ts > 0) ? item.ts : nowTs(),
      };
    }

    /**
     * 读取收藏列表 (容错: 损坏 JSON / 非数组 -> 空列表)。
     * @returns {object[]}
     */
    function load() {
      if (!store) return [];
      try {
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(isValidItem).map(normalizeItem);
      } catch (e) {
        return [];
      }
    }

    /**
     * 保存列表 (清洗 + 截断上限; 存储失败静默, 返回保存后的列表)。
     * @param {object[]} list
     * @returns {object[]}
     */
    function save(list) {
      if (!store) return (Array.isArray(list) ? list : []).filter(isValidItem).map(normalizeItem).slice(0, MAX_ITEMS);
      const clean = (Array.isArray(list) ? list : [])
        .filter(isValidItem)
        .map(normalizeItem)
        .slice(0, MAX_ITEMS);
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(clean));
      } catch (e) {
        // 存储失败 (配额/禁用): 静默, 返回内存列表
      }
      return clean;
    }

    /**
     * 添加收藏。空命令不添加 (返回 empty_cmd)。
     * @param {string} name - 名称 (可选, 缺省取命令前缀)
     * @param {string} cmd  - 命令文本 (必须非空)
     * @returns {{ok: boolean, error?: string, item?: object, list: object[]}}
     */
    function add(name, cmd) {
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        return { ok: false, error: 'empty_cmd', list: load() };
      }
      const item = normalizeItem({ name: String(name || ''), cmd });
      const list = load();
      list.push(item);
      return { ok: true, item, list: save(list) };
    }

    /**
     * 删除收藏 (按 ts 唯一标识; 不存在则幂等成功)。
     * @param {number} ts
     * @returns {{ok: boolean, list: object[]}}
     */
    function remove(ts) {
      const target = typeof ts === 'number' ? ts : Number(ts);
      const list = load().filter((it) => it.ts !== target);
      return { ok: true, list: save(list) };
    }

    /**
     * 发送命令到终端 (原样 + \r 提交, 不解析变量/模板)。
     * 无 write 注入返回 no_write; 空命令返回 empty_cmd。
     * @param {string} cmd
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    function send(cmd) {
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        return Promise.resolve({ ok: false, error: 'empty_cmd' });
      }
      if (!writeFn) return Promise.resolve({ ok: false, error: 'no_write' });
      try {
        return Promise.resolve(writeFn(cmd + '\r'));
      } catch (e) {
        return Promise.resolve({ ok: false, error: 'write_error' });
      }
    }

    /**
     * HTML 转义 (防 XSS; 列表渲染唯一转义入口)。
     * @param {*} s
     * @returns {string}
     */
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    /**
     * 渲染为 HTML 列表 (名称 + 命令 + 发送/删除按钮; 全部字段经 escapeHtml)。
     * @param {object[]} [list] - 缺省从 storage 读取
     * @returns {string}
     */
    function renderList(list) {
      const items = Array.isArray(list) ? list : load();
      if (items.length === 0) return '<div class="fav-empty">暂无收藏命令</div>';
      return items.map((it) => `
      <div class="fav-item" data-ts="${escapeHtml(it.ts)}">
        <button class="fav-item-send" title="发送到当前终端">
          <span class="fav-item-name">${escapeHtml(it.name || '')}</span>
          <span class="fav-item-cmd">${escapeHtml(it.cmd)}</span>
        </button>
        <button class="fav-item-del" data-ts="${escapeHtml(it.ts)}" title="删除">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`).join('');
    }

    return {
      STORAGE_KEY,
      MAX_ITEMS,
      load,
      save,
      add,
      remove,
      send,
      escapeHtml,
      renderList,
      isValidItem,
      normalizeItem,
    };
  }

  return { createFavCommands, STORAGE_KEY, MAX_ITEMS };
}));
