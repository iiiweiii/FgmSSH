/**
 * FgmSSH - PDF 内置 viewer 启用条件探针
 * 验证 Electron 31.7.7 内置 PDF viewer 的启用条件:
 *   P1: file:// 顶层 + plugins:true
 *   P2: nimbus-doc:// 顶层 + plugins:true
 *   P3: file:// iframe + plugins:true
 * 同时监听 will-download 判断是否退化为下载。
 */
const { app, BrowserWindow, protocol, net, session } = require('electron');
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-probe2-'));
const PDF_PATH = path.join(TMP, 'test.pdf');
fs.writeFileSync(PDF_PATH, makeMinimalPdf());
const PDF_VIEWER_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const PDF_FILE_URL = pathToFileURL(PDF_PATH).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const ses = session.defaultSession;
    const downloads = [];
    ses.on('will-download', (e, item) => {
      downloads.push(item.getFilename());
      item.cancel();
    });

    async function probeWin(name, url, webPrefs) {
      const win = new BrowserWindow({
        width: 900, height: 700, show: false,
        webPreferences: Object.assign({ nodeIntegration: false, contextIsolation: true, sandbox: false }, webPrefs),
      });
      try {
        await win.loadURL(url);
        await sleep(3500);
        const frames = win.webContents.mainFrame.frames.map((f) => f.url);
        const hasViewer = frames.some((u) => u.includes(PDF_VIEWER_ID));
        console.log(`\n=== ${name} ===`);
        console.log('  mainFrame.url:', win.webContents.getURL());
        console.log('  frames:', JSON.stringify(frames, null, 2));
        console.log('  downloads:', JSON.stringify(downloads));
        console.log('  => viewer:', hasViewer ? 'YES ✅' : 'NO ❌');
        return hasViewer;
      } catch (e) {
        console.log(`\n=== ${name} === 异常:`, e.message);
        return false;
      } finally {
        win.destroy();
      }
    }

    const p1 = await probeWin('P1: file:// 顶层 + plugins:true', PDF_FILE_URL, { plugins: true });
    downloads.length = 0;
    const p2 = await probeWin('P2: nimbus-doc:// 顶层 + plugins:true', 'nimbus-doc://nimbus-doc-test.pdf', { plugins: true });
    downloads.length = 0;
    const p3 = await probeWin('P3: file:// iframe + plugins:true',
      'data:text/html;charset=utf-8,' + encodeURIComponent('<div id="r">p3</div><iframe src="' + PDF_FILE_URL + '" style="width:800px;height:600px;"></iframe>'),
      { plugins: true });

    // 附加: 检查扩展是否存在
    const ext = ses.getExtension && await ses.getExtension(PDF_VIEWER_ID).catch(() => null);
    console.log('\n=== 扩展注册检查 ===');
    console.log('  pdfViewer extension:', ext ? ext.name : 'null/不可用');

    console.log('\n================ 汇总 ================');
    console.log('P1 (file顶层+plugins):', p1, '| P2 (custom顶层+plugins):', p2, '| P3 (file iframe+plugins):', p3);
    app.exit(0);
  } catch (e) {
    console.error('测试异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => {});
