/**
 * 验证 xterm 样式是否注入到页面
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await listRes.json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

  const diag = await evaluate(`
    (function() {
      const styles = document.querySelectorAll('style');
      const links = document.querySelectorAll('link[rel=stylesheet]');
      let xtermStyleFound = false;
      let xtermStyleContent = '';
      styles.forEach((s) => {
        if (s.textContent.includes('.xterm-viewport')) {
          xtermStyleFound = true;
          xtermStyleContent = s.textContent.slice(0, 200);
        }
      });
      const adopted = document.adoptedStyleSheets ? document.adoptedStyleSheets.length : -1;
      // 检查是否有样式表包含 xterm 规则
      let adoptedHasXterm = false;
      try {
        if (document.adoptedStyleSheets) {
          document.adoptedStyleSheets.forEach((ss) => {
            try {
              for (const rule of ss.cssRules) {
                if (rule.cssText && rule.cssText.includes('.xterm-viewport')) { adoptedHasXterm = true; break; }
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return {
        styleTagCount: styles.length,
        linkCount: links.length,
        linkHrefs: [...links].map((l) => l.href.split('/').pop()),
        xtermStyleTagFound: xtermStyleFound,
        xtermStyleContent: xtermStyleContent,
        adoptedStyleSheetsCount: adopted,
        adoptedHasXterm: adoptedHasXterm,
        // 检查关键类样式是否生效
        viewportPosition: getComputedStyle(document.querySelector('.xterm-viewport') || document.body).position,
      };
    })();
  `);
  console.log(JSON.stringify(diag, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
