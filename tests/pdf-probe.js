/**
 * NimbusSSH - PDF 方案 A 深入探针 (对照实验)
 * 场景:
 *   S1: file:// PDF 顶层导航 (控制组, 应显示内置 viewer)
 *   S2: file:// PDF 在 iframe 内
 *   S3: nimbus-doc:// PDF 在 iframe 内 (plugins:true)
 *   S4: nimbus-doc:// PDF 顶层导航 (自定义协议 viewer 是否可用)
 * 检测: webContents.mainFrame.frames 中是否出现 PDF viewer 扩展帧
 *       (mhjfbmdgcfjbbpaeojofohoefgiehjai)
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

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

protocol.registerSchemesAsPrivileged([
  { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-probe-'));
const PDF_PATH = path.join(TMP, 'test.pdf');
fs.writeFileSync(PDF_PATH, makeMinimalPdf());

const PDF_VIEWER_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const PDF_FILE_URL = pathToFileURL(PDF_PATH).toString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(name, html, webPrefs = {}) {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: Object.assign({ nodeIntegration: false, contextIsolation: true, sandbox: false }, webPrefs),
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(3500);
    const frames = win.webContents.mainFrame.frames.map((f) => f.url);
    const hasViewer = frames.some((u) => u.includes(PDF_VIEWER_ID));
    const pdfFrames = frames.filter((u) => u.includes('.pdf') || u.includes(PDF_VIEWER_ID));
    let marker = 'n/a';
    try { marker = await win.webContents.executeJavaScript('document.getElementById("r") ? document.getElementById("r").textContent : "no-r"'); } catch (e) {}
    console.log(`\n=== ${name} ===`);
    console.log('  frames:', JSON.stringify(pdfFrames, null, 2));
    console.log('  marker:', marker);
    console.log('  => PDF viewer 渲染:', hasViewer ? 'YES ✅' : 'NO ❌');
    return hasViewer;
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    protocol.handle('nimbus-doc', (request) => {
      const { host, pathname } = new URL(request.url);
      const raw = host || pathname;
      const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
      const filePath = path.join(TMP, filename.replace(/^nimbus-doc-/, ''));
      if (!fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    const plain = '<div id="r">plain</div>';
    // S1: file:// 顶层导航
    const s1 = await probe('S1: file:// PDF 顶层导航', plain);
    // S1b: 通过 win.loadURL 顶层加载 PDF
    const win1 = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: false } });
    await win1.loadURL(PDF_FILE_URL);
    await sleep(3500);
    const s1b = win1.webContents.mainFrame.frames.some((f) => f.url.includes(PDF_VIEWER_ID));
    console.log(`\n=== S1b: loadURL(file://pdf) ===\n  => PDF viewer 渲染: ${s1b ? 'YES ✅' : 'NO ❌'}`);
    win1.destroy();

    // S2: file:// iframe
    const s2 = await probe('S2: file:// PDF 在 iframe 内',
      '<div id="r">S2</div><iframe src="' + PDF_FILE_URL + '" style="width:800px;height:600px;"></iframe>');

    // S3: nimbus-doc:// iframe + plugins
    const s3 = await probe('S3: nimbus-doc:// PDF iframe (plugins:true)',
      '<div id="r">S3</div><iframe src="nimbus-doc://nimbus-doc-test.pdf" style="width:800px;height:600px;"></iframe>',
      { plugins: true });

    // S4: nimbus-doc:// 顶层导航
    const win4 = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: false } });
    await win4.loadURL('nimbus-doc://nimbus-doc-test.pdf');
    await sleep(3500);
    const s4 = win4.webContents.mainFrame.frames.some((f) => f.url.includes(PDF_VIEWER_ID));
    console.log(`\n=== S4: loadURL(nimbus-doc://pdf) 顶层 ===\n  => PDF viewer 渲染: ${s4 ? 'YES ✅' : 'NO ❌'}`);
    win4.destroy();

    console.log('\n================ 汇总 ================');
    console.log('S1 (file 顶层):', s1, '| S1b (loadURL file):', s1b, '| S2 (file iframe):', s2, '| S3 (custom iframe):', s3, '| S4 (custom 顶层):', s4);
    console.log('结论: iframe 可行 =', s2 || s3, '; 自定义协议可用 =', s3 || s4);
    app.exit(0);
  } catch (e) {
    console.error('测试异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => {});
