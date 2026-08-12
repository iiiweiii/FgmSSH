/**
 * NimbusSSH - PDF 方案 B (pdfjs-dist) 技术实测 - 渲染页脚本 (外部模块, 遵守 CSP script-src 'self')
 */
window.__result = 'pending';
const r = document.getElementById('r');
const stage = document.getElementById('stage');
const set = (s) => { window.__result = s; r.textContent = s; };

try {
  // 动态 import pdfjs: 相对路径基于 import.meta.url (模块自身位置 tests/ -> 项目 node_modules/)
  const pdfjs = await import('../node_modules/pdfjs-dist/build/pdf.min.mjs');
  set('imported: ' + (typeof pdfjs.getDocument));

  // S2: fetch worker 源码 -> blob URL (需 CSP worker-src blob:)
  let workerOk = false;
  try {
    const workerUrl = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const wr = await fetch(workerUrl);
    const code = await wr.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerSrc = blobUrl;
    set('workerSrc: blob (' + code.length + ' bytes)');
    workerOk = true;
  } catch (e) {
    set('worker fetch FAIL: ' + e.message);
  }

  if (workerOk) {
    try {
      const doc = await pdfjs.getDocument({ url: 'nimbus-doc://nimbus-doc-test.pdf' }).promise;
      set('opened, pages=' + doc.numPages);
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      stage.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      set('RENDERED OK pages=' + doc.numPages + ' size=' + canvas.width + 'x' + canvas.height);
    } catch (e) {
      set('RENDER FAIL: ' + (e && e.message));
    }
  }
} catch (e) {
  set('FATAL: ' + (e && e.message));
}
