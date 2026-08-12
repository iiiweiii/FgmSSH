/**
 * FgmSSH - mammoth (docx -> html) 技术实测
 *
 * 目的: 验证 mammoth.browser.js 在 Electron 31 + CSP script-src 'self' 下:
 *   - 经典 script 外部文件加载 (与 xterm 相同方式, 来自 node_modules)
 *   - fetch nimbus-doc:// 自定义协议取 docx arrayBuffer -> convertToHtml
 *
 * 运行: unset NODE_OPTIONS ELECTRON_RUN_AS_NODE && npx electron tests/mammoth-probe.js
 */
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const zlib = require('zlib');

// ---- 最小合法 docx 生成器 (store 方法 zip, 零依赖) ----
function makeMinimalDocx() {
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Hello Mammoth DOCX</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第二段中文</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const data = Buffer.from(files[name], 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const localOffset = offset;
    const crc = zlib.crc32(data) >>> 0;
    const size = data.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);   // UTF-8 flag
    header.writeUInt16LE(0, 8);        // stored
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBuf, data);
    offset += 30 + nameBuf.length + data.length;
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(size, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  chunks.push(centralBuf, eocd);
  return Buffer.concat(chunks);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-docx-probe-'));
const DOCX_PATH = path.join(TMP, 'nimbus-doc-test.docx');
fs.writeFileSync(DOCX_PATH, makeMinimalDocx());

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

    const renderScriptUrl = pathToFileURL(path.join(__dirname, 'mammoth-probe-render.js')).toString();
    const mammothScriptUrl = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'mammoth', 'mammoth.browser.js')).toString();
    const html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}" />
</head>
<body style="margin:0;background:#111;color:#eee;font-family:monospace;">
<div id="r" style="padding:8px;">booting</div>
<div id="out" style="padding:8px;border:1px solid #333;margin:8px;"></div>
<script src="${mammothScriptUrl}"></script>
<script src="${renderScriptUrl}"></script>
</body></html>`;
    const HTML_PATH = path.join(TMP, 'page.html');
    fs.writeFileSync(HTML_PATH, html, 'utf8');

    const win = new BrowserWindow({
      width: 800, height: 600, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
    });
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer console]', message);
    });
    await win.loadFile(HTML_PATH);
    await sleep(5000);

    const result = await win.webContents.executeJavaScript('window.__result');
    console.log('=== 结果 ===');
    console.log('  ', result);
    if (result && result.startsWith('CONVERTED OK')) {
      console.log('\n结论: mammoth 可行 ✅ — 外部 script 加载 + nimbus-doc:// arrayBuffer -> html 成功');
      app.exit(0);
    } else {
      console.log('\n结论: mammoth 失败 ❌');
      app.exit(1);
    }
  } catch (e) {
    console.error('测试异常:', e);
    app.exit(2);
  }
});

app.on('window-all-closed', () => {});
