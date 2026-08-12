/**
 * FgmSSH - PDF 方案 B (pdfjs-dist) 技术实测
 *
 * 目的: 验证 pdfjs-dist 在 Electron 31.7.7 + 本项目 CSP 约束下能否正常渲染 PDF:
 *   - CSP script-src 'self' (模块动态 import 来自 node_modules 相对路径)
 *   - Worker 策略对比:
 *     S1: GlobalWorkerOptions.workerSrc = 相对路径 (file:// worker, 需 CSP worker-src 'self')
 *     S2: fetch worker 源码 -> blob URL (需 CSP worker-src blob:)
 *   - getDocument({url: nimbus-doc://...}) 走自定义协议 (supportFetchAPI)
 *
 * 运行: unset NODE_OPTIONS ELECTRON_RUN_AS_NODE && npx electron tests/pdf-probe4-pdfjs.js
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// ---- 最小合法 PDF (与 pdf-iframe-test.js 相同生成器) ----
function makeMinimalPdf() {
  const header = '%PDF-1.4\n';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const streamBody = 'BT /F1 24 Tf 100 700 Td (Hello PDF Viewer) Tj ET\n';
  const streamLen = Buffer.byteLength(streamBody, 'latin1');
  objs.push(`4 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamBody}endstream\nendobj\n`);
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  const chunks = [Buffer.from(header, 'latin1')];
  const offsets = [0];
  for (const s of objs) {
    const buf = Buffer.from(s, 'latin1');
    offsets.push(chunks.reduce((n, c) => n + c.length, 0));
    chunks.push(buf);
  }
  const xrefOffset = chunks.reduce((n, c) => n + c.length, 0);
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

// ---- 与 main.js 一致: 特权协议注册 + 兼容模式 ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-probe4-'));
const PDF_PATH = path.join(TMP, 'nimbus-doc-test.pdf');
fs.writeFileSync(PDF_PATH, makeMinimalPdf());

function isSafeDocFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return filename.startsWith('nimbus-doc-');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    protocol.handle('nimbus-doc', (request) => {
      try {
        const { host, pathname } = new URL(request.url);
        const raw = host || pathname;
        const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
        if (!isSafeDocFilename(filename)) return new Response('Not Found', { status: 404 });
        const filePath = path.join(TMP, filename);
        if (!fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
        return net.fetch(pathToFileURL(filePath).toString());
      } catch (e) {
        return new Response('Not Found', { status: 404 });
      }
    });

    const csp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self' data:",
      "img-src 'self' nimbus-preview: blob: data:",
      "connect-src 'self' nimbus-preview: nimbus-doc: blob: data:",
      "worker-src 'self' blob:",
    ].join('; ');

    const renderScriptUrl = pathToFileURL(path.join(__dirname, 'pdf-probe4-render.mjs')).toString();
    const html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}" />
</head>
<body style="margin:0;background:#111;color:#eee;font-family:monospace;">
<div id="r" style="padding:8px;">booting</div>
<div id="stage" style="width:700px;height:800px;border:1px solid #333;position:relative;"></div>
<script type="module" src="${renderScriptUrl}"></script>
</body></html>`;
    const HTML_PATH = path.join(TMP, 'page.html');
    fs.writeFileSync(HTML_PATH, html, 'utf8');

    const win = new BrowserWindow({
      width: 800, height: 900, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
    });
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer console]', message);
    });
    await win.loadFile(HTML_PATH);
    await sleep(6000);

    const result = await win.webContents.executeJavaScript('window.__result');
    console.log('=== 结果 ===');
    console.log('  ', result);
    if (result && result.startsWith('RENDERED OK')) {
      console.log('\n结论: 方案 B 可行 ✅ — pdfjs-dist + blob worker + nimbus-doc:// 渲染成功');
      app.exit(0);
    } else {
      console.log('\n结论: 方案 B 失败 ❌ — 需要调整 worker 策略');
      app.exit(1);
    }
  } catch (e) {
    console.error('测试异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => {});
