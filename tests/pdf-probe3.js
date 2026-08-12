/**
 * NimbusSSH - PDF 内置 viewer 启用条件探针 (v3)
 * 保留 disableHardwareAcceleration/disable-gpu (与线上一致),
 * 移除 disable-software-rasterizer, 验证内置 PDF viewer 是否可用。
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
  objs.push('4 0 obj\n<< /Length ' + streamLen + ' >>\nstream\n' + streamBody + 'endstream\nendobj\n');
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
  xref += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-pdf-probe3-'));
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
    ses.on('will-download', (e, item) => { downloads.push(item.getFilename()); item.cancel(); });

    async function probe(name, url, html) {
      const win = new BrowserWindow({
        width: 900, height: 700, show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, plugins: true },
      });
      try {
        if (html) await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        else await win.loadURL(url);
        await sleep(3500);
        const frames = win.webContents.mainFrame.frames.map((f) => f.url);
        const hasViewer = frames.some((u) => u.includes(PDF_VIEWER_ID));
        console.log('\n=== ' + name + ' ===');
        console.log('  frames:', JSON.stringify(frames));
        console.log('  downloads:', JSON.stringify(downloads));
        console.log('  => viewer:', hasViewer ? 'YES' : 'NO');
        return hasViewer;
      } catch (e) {
        console.log('\n=== ' + name + ' === 异常:', e.message);
        return false;
      } finally {
        win.destroy();
      }
    }

    const p1 = await probe('P1: file:// 顶层', PDF_FILE_URL);
    const p2 = await probe('P2: nimbus-doc:// 顶层', 'nimbus-doc://nimbus-doc-test.pdf');
    const p3 = await probe('P3: file:// iframe', null,
      '<div id="r">p3</div><iframe src="' + PDF_FILE_URL + '" style="width:800px;height:600px;"></iframe>');
    const p4 = await probe('P4: nimbus-doc:// iframe', null,
      '<div id="r">p4</div><iframe src="nimbus-doc://nimbus-doc-test.pdf" style="width:800px;height:600px;"></iframe>');

    console.log('\n================ 汇总 ================');
    console.log('P1(file顶层):', p1, 'P2(custom顶层):', p2, 'P3(file iframe):', p3, 'P4(custom iframe):', p4);
    app.exit(0);
  } catch (e) {
    console.error('异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => {});
