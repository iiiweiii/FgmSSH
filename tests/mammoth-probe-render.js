/**
 * NimbusSSH - mammoth 探针渲染脚本 (经典 script, 遵守 CSP script-src 'self')
 */
window.__result = 'pending';
const r = document.getElementById('r');
const out = document.getElementById('out');
const set = (s) => { window.__result = s; r.textContent = s; };

(async () => {
  try {
    if (typeof window.mammoth === 'undefined' || typeof window.mammoth.convertToHtml !== 'function') {
      set('mammoth NOT LOADED: ' + (typeof window.mammoth));
      return;
    }
    set('mammoth loaded: ' + typeof window.mammoth.convertToHtml);

    let buf = null;
    try {
      const res = await fetch('nimbus-doc://nimbus-doc-test.docx');
      if (!res.ok) { set('fetch FAIL: ' + res.status); return; }
      buf = await res.arrayBuffer();
      set('fetched arrayBuffer: ' + buf.byteLength + ' bytes');
    } catch (e) {
      set('FETCH FAIL: ' + (e && e.message));
      return;
    }

    if (buf) {
      try {
        const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
        out.innerHTML = result.value || '(empty)';
        const text = (result.value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        set('CONVERTED OK: ' + text);
      } catch (e) {
        set('CONVERT FAIL: ' + (e && e.message));
      }
    }
  } catch (e) {
    set('FATAL: ' + (e && e.message));
  }
})();
