/**
 * CDP 调研脚本: 自动连接 wc 后抓取终端 DOM 的真实运行数据
 * 用于定位终端内容下移的真实根因
 */
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 获取页面列表
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await listRes.json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('index.html'));
  if (!page) { console.error('未找到页面'); process.exit(1); }
  console.log('页面:', page.url);

  // 2. WebSocket 连接
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : r.result;
  };

  // 3. 点击第一个连接建立 SSH
  const clickResult = await evaluate(`
    (async () => {
      const item = document.querySelector('.conn-item');
      if (!item) return 'NO_CONN_ITEM';
      item.click();
      return 'CLICKED';
    })();
  `);
  console.log('点击连接:', clickResult);

  // 4. 等待连接建立
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const st = await evaluate(`(function(){ const s=[...document.querySelectorAll('.tab')]; const t=document.getElementById('statusText'); return {tabs:s.length, status: t?t.textContent:''}; })()`);
    console.log(`等待连接 (${i}):`, JSON.stringify(st));
    if (st && st.status === '已连接') break;
  }

  await sleep(2000); // 等终端渲染稳定

  // 5. 抓取终端 DOM 真实数据
  const diag = await evaluate(`
    (function() {
      const hostEl = document.querySelector('.terminal-host');
      const contentEl = document.querySelector('.terminal-content');
      const xtermEl = document.querySelector('.xterm');
      const viewport = document.querySelector('.xterm-viewport');
      const screen = document.querySelector('.xterm-screen');
      const canvas = document.querySelector('.xterm-canvas-layer canvas') || document.querySelector('canvas');
      const textLayer = document.querySelector('.xterm-text-layer');
      const cursorLayer = document.querySelector('.xterm-cursor-layer');

      const rect = (el) => el ? { top: Math.round(el.getBoundingClientRect().top), height: Math.round(el.getBoundingClientRect().height) } : null;
      const cs = (el) => {
        if (!el) return null;
        const c = getComputedStyle(el);
        return {
          position: c.position, top: c.top, height: c.height,
          paddingTop: c.paddingTop, marginTop: c.marginTop,
          transform: c.transform, boxSizing: c.boxSizing,
          display: c.display, flexShrink: c.flexShrink,
        };
      };

      // 找到 tabbar 底部作为参照
      const tabbar = document.querySelector('.tabbar');
      const terminalArea = document.getElementById('terminalArea');

      return {
        tabbarBottom: tabbar ? Math.round(tabbar.getBoundingClientRect().bottom) : null,
        terminalArea: rect(terminalArea),
        hostEl: rect(hostEl),
        contentEl: rect(contentEl),
        xtermEl: rect(xtermEl),
        viewport: rect(viewport),
        screen: rect(screen),
        canvas: rect(canvas),
        textLayer: rect(textLayer),
        cursorLayer: rect(cursorLayer),
        hostCs: cs(hostEl),
        contentCs: cs(contentEl),
        xtermCs: cs(xtermEl),
        viewportCs: cs(viewport),
        screenCs: cs(screen),
        textLayerCs: cs(textLayer),
        viewportScrollTop: viewport ? viewport.scrollTop : null,
        screenInlineHeight: screen ? screen.style.height : null,
        dpr: window.devicePixelRatio,
        winZoom: window.devicePixelRatio,
      };
    })();
  `);

  console.log('=== 终端 DOM 真实数据 ===');
  console.log(JSON.stringify(diag, null, 2));

  // 6. 查询第一行文本的实际渲染位置
  const rowPos = await evaluate(`
    (function() {
      const textLayer = document.querySelector('.xterm-text-layer');
      if (!textLayer) return 'no textLayer';
      const rows = textLayer.querySelectorAll('div');
      const out = [];
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        const r = rows[i].getBoundingClientRect();
        out.push({ i, top: Math.round(r.top), height: Math.round(r.height), text: rows[i].textContent.slice(0, 30) });
      }
      return out;
    })();
  `);
  console.log('=== 前 3 行文本位置 ===');
  console.log(JSON.stringify(rowPos, null, 2));

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
