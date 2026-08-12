/**
 * FgmSSH - PDF 方案 A (iframe 内嵌 Chromium 内置 PDF viewer) 技术实测
 *
 * 目的: 验证 <iframe src="nimbus-doc://xxx.pdf"> 在 Electron 31 (Chromium 126) 中
 *       是否触发内置 PDF 查看器 (而非下载/空白), 以决定文档查看器 PDF 渲染方案:
 *       - 方案 A (零依赖): iframe 直接内嵌 PDF
 *       - 方案 B (pdfjs-dist): 自绘 canvas
 *
 * 检测信号: 内置 PDF viewer 是 chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai 扩展页,
 *           若 iframe 加载 PDF 成功渲染, webContents.mainFrame.frames 中应出现该扩展帧。
 *
 * 运行: unset NODE_OPTIONS ELECTRON_RUN_AS_NODE && npx electron tests/pdf-iframe-test.js
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// ---- 最小合法 PDF 生成器 (动态计算 xref 偏移, 避免手写错误) ----
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
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

// ---- 与 main.js 一致的兼容模式 (无 GPU 环境可用) ----
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

// ---- 与 main.js 一致的协议注册 ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-test-'));
const PDF_PATH = path.join(TMP, 'test.pdf');
fs.writeFileSync(PDF_PATH, makeMinimalPdf());

function isSafeDocFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return filename.startsWith('nimbus-doc-');
}

app.whenReady().then(async () => {
  try {
    protocol.handle('nimbus-doc', (request) => {
      const { host, pathname } = new URL(request.url);
      const raw = host || pathname;
      const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
      if (!isSafeDocFilename(filename)) return new Response('Not Found', { status: 404 });
      const filePath = path.join(TMP, filename.replace(/^nimbus-doc-/, ''));
      if (!fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    // 与线上一致的 CSP: 方案 A 需显式允许 frame-src nimbus-doc:
    const html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; img-src 'self' nimbus-preview: blob: data:; connect-src 'self' nimbus-preview: blob: data:; frame-src nimbus-doc:;" />
</head>
<body style="margin:0;background:#111;">
<div id="r">loading</div>
<iframe id="pdf" src="nimbus-doc://nimbus-doc-test.pdf" style="width:800px;height:600px;border:1px solid #333;"></iframe>
<script>
  document.getElementById('pdf').addEventListener('load', () => {
    try {
      const doc = document.getElementById('pdf').contentDocument;
      const embeds = doc ? doc.querySelectorAll('embed').length : -1;
      document.getElementById('r').textContent = 'LOADED embed=' + embeds + ' access=' + (doc ? 'yes' : 'cross-origin');
    } catch (e) {
      document.getElementById('r').textContent = 'LOADED access=throw';
    }
  });
</script>
</body></html>`;
    const HTML_PATH = path.join(TMP, 'page.html');
    fs.writeFileSync(HTML_PATH, html, 'utf8');

    const win = new BrowserWindow({
      width: 900, height: 700, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
    });

    await win.loadFile(HTML_PATH);
    // 等待 iframe 加载与 PDF viewer 扩展挂载
    await new Promise((r) => setTimeout(r, 4000));

    const frames = win.webContents.mainFrame.frames.map((f) => f.url);
    console.log('=== iframe 加载后 mainFrame.frames ===');
    frames.forEach((u, i) => console.log(`  [${i}] ${u}`));

    const pdfViewerId = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
    const hasPdfViewerFrame = frames.some((u) => u.includes(pdfViewerId));
    const hasDocFrame = frames.some((u) => u.includes('nimbus-doc://'));
    const bodyText = await win.webContents.executeJavaScript('document.getElementById("r").textContent');
    console.log('=== 检测结果 ===');
    console.log('  body 标记:', bodyText);
    console.log('  hasDocFrame   :', hasDocFrame);
    console.log('  hasPdfViewerFrame:', hasPdfViewerFrame);

    if (hasDocFrame && hasPdfViewerFrame) {
      console.log('\n结论: 方案 A 可行 ✅ — iframe 内嵌 nimbus-doc:// PDF 触发内置 PDF viewer 渲染');
    } else {
      console.log('\n结论: 方案 A 不可行 ❌ — 需回退方案 B (pdfjs-dist)');
    }
    app.exit(hasDocFrame && hasPdfViewerFrame ? 0 : 1);
  } catch (e) {
    console.error('测试异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => { /* 保持进程直到 app.exit */ });
