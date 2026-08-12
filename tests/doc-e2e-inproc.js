/**
 * FgmSSH - 内置文档查看器 + 打开文档不多开终端 进程内端到端验证
 *
 * 环境约束: 本沙箱中外部 CDP (Node fetch/WebSocket) 无法连回被 spawn 的 Electron
 * 窗口 (网络隔离), 故采用「进程内集成测试」:
 *   - Electron 主进程 (本脚本) 实现与 main.js 等价的 IPC 后端 (真实 ssh2 SSH/SFTP)
 *   - 加载 真实 preload.js + 真实 src/index.html + 真实 src/renderer.js
 *   - 通过 webContents.executeJavaScript 驱动渲染层 (与外部 CDP 同能力, 无需网络)
 *   - 验证: 文本/PDF/DOCX/DOC 渲染, 打开文档不多开终端 (会话数保持 1), 标签切换, doc:save 写回
 *
 * 运行: unset NODE_OPTIONS ELECTRON_RUN_AS_NODE && npx electron tests/doc-e2e-inproc.js
 */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { Client } = require('ssh2');
const zlib = require('zlib');

const CWD = path.resolve(__dirname, '..');
const SERVER = {
  host: '172.16.11.10', port: 26810, username: 'root', password: 'CHANGE_ME_TEST_PASSWORD',
  readyTimeout: 20000, keepaliveInterval: 10000, keepaliveCountMax: 3,
};
const TEST_DIR = '/tmp/nimbus-doc-e2e';
const DOC_DIR = path.join(app.getPath('temp'), 'nimbus-docs-test');
const DOC_EXTENSIONS = ['.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts', '.html', '.css', '.xml', '.conf', '.ini', '.csv', '.pdf', '.docx', '.doc'];
const TEXT_DOC_EXTENSIONS = ['.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts', '.html', '.css', '.xml', '.conf', '.ini', '.csv'];

// 兼容模式: 与 main.js 一致, 必须在模块顶层尽早设置 (GPU 崩溃会导致应用退出)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

let passCount = 0;
let failCount = 0;
function check(name, cond, extra = '') {
  if (cond) { passCount++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failCount++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isSafeRemotePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  return !p.split('/').some((seg) => seg === '..');
}
function isSafeDocFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return filename.startsWith('nimbus-doc-');
}
function joinRemotePath(parent, name) {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

// ---- 最小 PDF / DOCX 生成器 ----
function makeMinimalPdf() {
  const header = '%PDF-1.4\n';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const streamBody = 'BT /F1 24 Tf 100 700 Td (Nimbus Doc E2E PDF) Tj ET\n';
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
      '<w:body><w:p><w:r><w:t>Nimbus Doc E2E DOCX</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>中文段落验证</w:t></w:r></w:p>' +
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
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
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

// ---- SSH/SFTP 会话管理 (与 main.js 等价的最小实现) ----
const sessions = new Map(); // key: `${winId}:${sessionId}`
let winId = 0;

function createSSHSession(sessionId, config) {
  const key = `${winId}:${sessionId}`;
  const session = { id: sessionId, conn: new Client(), stream: null, sftp: null, closed: false };
  sessions.set(key, session);
  const conn = session.conn;
  const sendEvent = (type, payload) => {
    const win = BrowserWindow.fromId(winId);
    if (win && !win.isDestroyed()) win.webContents.send('ssh:event', { sessionId, type, ...payload });
  };
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', rows: config.rows || 30, cols: config.cols || 120, env: { LANG: 'en_US.UTF-8' } }, (err, stream) => {
      if (err) { sendEvent('error', { message: 'shell 失败: ' + err.message }); return; }
      session.stream = stream;
      sendEvent('ready', { message: '连接成功' });
      stream.on('data', (d) => {
        const win = BrowserWindow.fromId(winId);
        if (win && !win.isDestroyed()) win.webContents.send('ssh:data', { sessionId, data: d.toString('utf8') });
      });
      stream.on('close', () => { sendEvent('closed', { message: '连接已关闭' }); cleanup(); });
      stream.on('error', (e) => sendEvent('error', { message: e.message }));
    });
  });
  conn.on('error', (err) => { sendEvent('error', { message: '连接失败: ' + err.message }); cleanup(); });
  conn.on('close', () => { if (!session.closed) sendEvent('closed', { message: '连接已关闭' }); cleanup(); });
  function cleanup() {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(key);
    try { if (session.sftp) session.sftp.end(); } catch (e) {}
    try { conn.end(); } catch (e) {}
    try { if (session.stream) session.stream.end(); } catch (e) {}
  }
  const connConfig = {
    host: config.host, port: Number(config.port) || 22, username: config.username,
    readyTimeout: 20000, keepaliveInterval: 10000, keepaliveCountMax: 3,
  };
  if (config.authMethod === 'password') connConfig.password = config.password;
  else if (config.authMethod === 'privateKey') { connConfig.privateKey = fs.readFileSync(config.privateKeyPath, 'utf8'); if (config.passphrase) connConfig.passphrase = config.passphrase; }
  else connConfig.agent = process.env.SSH_AUTH_SOCK;
  conn.connect(connConfig);
  return session;
}

function getSftp(sessionId) {
  const key = `${winId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session || !session.conn) return Promise.reject(new Error('会话不存在或未就绪'));
  if (session.sftp) return Promise.resolve(session.sftp);
  return new Promise((resolve, reject) => {
    session.conn.sftp((err, sftp) => {
      if (err) { reject(new Error('SFTP 初始化失败: ' + err.message)); return; }
      session.sftp = sftp;
      resolve(sftp);
    });
  });
}

function downloadToFile(sftp, remotePath, localPath) {
  return new Promise((resolve) => {
    const rs = sftp.createReadStream(remotePath);
    const ws = fs.createWriteStream(localPath);
    let settled = false;
    const settle = (ok, error) => { if (!settled) { settled = true; resolve(ok ? { ok: true } : { ok: false, error }); } };
    rs.on('error', (err) => { ws.destroy(); fs.unlink(localPath, () => {}); settle(false, '下载失败: ' + err.message); });
    ws.on('error', (err) => { rs.destroy(); fs.unlink(localPath, () => {}); settle(false, '写入本地文件失败: ' + err.message); });
    ws.on('close', () => settle(true));
    rs.pipe(ws);
  });
}

// ---- IPC 注册 (与 main.js 等价) ----
function registerIpc() {
  ipcMain.handle('ssh:connect', (e, { sessionId, config }) => { winId = e.sender.id; createSSHSession(sessionId, config); return { ok: true }; });
  ipcMain.handle('ssh:write', (e, { sessionId, data }) => {
    const session = sessions.get(`${e.sender.id}:${sessionId}`);
    if (session && session.stream && !session.stream.destroyed) { session.stream.write(data); return { ok: true }; }
    return { ok: false, error: '会话不存在' };
  });
  ipcMain.handle('ssh:resize', () => ({ ok: true }));
  ipcMain.handle('ssh:disconnect', (e, { sessionId }) => {
    const key = `${e.sender.id}:${sessionId}`;
    const session = sessions.get(key);
    if (session) { session.closed = true; try { if (session.sftp) session.sftp.end(); } catch (x) {} try { session.conn.end(); } catch (x) {} sessions.delete(key); }
    return { ok: true };
  });
  ipcMain.handle('sftp:list', async (e, { sessionId, path: p }) => {
    try {
      const sftp = await getSftp(sessionId);
      const entries = await new Promise((res, rej) => sftp.readdir(p || '/', (err, list) => (err ? rej(err) : res(list))));
      const items = [];
      for (const ent of entries || []) {
        if (ent.filename === '.' || ent.filename === '..') continue;
        const a = ent.attrs || {};
        items.push({ name: ent.filename, isDir: !!(a.isDirectory && a.isDirectory()), isSymlink: !!(a.isSymbolicLink && a.isSymbolicLink()), size: typeof a.size === 'number' ? a.size : 0, mtime: a.mtime instanceof Date ? a.mtime.getTime() : (typeof a.mtime === 'number' ? a.mtime : 0) });
      }
      items.sort((x, y) => (x.isDir !== y.isDir ? (x.isDir ? -1 : 1) : x.name.toLowerCase().localeCompare(y.name.toLowerCase())));
      return { ok: true, path: p || '/', entries: items };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('sftp:cdSync', () => ({ ok: false, error: '测试环境跳过' }));
  ipcMain.handle('doc:open', async (e, { sessionId, remotePath }) => {
    try {
      if (!isSafeRemotePath(remotePath)) return { ok: false, error: '路径包含非法段 (..)' };
      const ext = path.extname(remotePath || '').toLowerCase();
      if (!DOC_EXTENSIONS.includes(ext)) return { ok: false, error: '不支持打开该文件类型' };
      const sftp = await getSftp(sessionId);
      const filename = `nimbus-doc-${randomUUID()}${ext}`;
      const localPath = path.join(DOC_DIR, filename);
      const dl = await downloadToFile(sftp, remotePath, localPath);
      if (!dl.ok) return dl;
      return { ok: true, url: `nimbus-doc://${filename}`, name: String(remotePath).split('/').pop(), filename, ext, isText: TEXT_DOC_EXTENSIONS.includes(ext) };
    } catch (err) { return { ok: false, error: err.message || '打开文档失败' }; }
  });
  ipcMain.handle('doc:save', (e, { sessionId, remotePath, content }) => {
    if (!isSafeRemotePath(remotePath)) return { ok: false, error: '路径包含非法段 (..)' };
    if (typeof content !== 'string') return { ok: false, error: '文档内容无效' };
    return new Promise((resolve) => {
      getSftp(sessionId).then((sftp) => {
        const ws = sftp.createWriteStream(remotePath);
        let settled = false;
        const settle = (ok, error) => { if (!settled) { settled = true; resolve(ok ? { ok: true } : { ok: false, error }); } };
        ws.on('error', (err) => settle(false, '保存失败: ' + err.message));
        ws.on('close', () => settle(true));
        ws.end(content, 'utf8');
      }).catch((err) => resolve({ ok: false, error: err.message }));
    });
  });
  ipcMain.handle('doc:close', (e, filename) => {
    if (!isSafeDocFilename(filename)) return { ok: false, error: '非法的文档文件名' };
    const localPath = path.join(DOC_DIR, filename);
    try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('store:load', () => []);
  ipcMain.handle('store:save', () => ({ ok: true }));
  ipcMain.handle('dialog:selectFile', () => ({ ok: false, paths: [] }));
  ipcMain.handle('dialog:selectSavePath', () => ({ ok: false }));
  ipcMain.handle('dialog:selectKey', () => ({ ok: false }));
  ipcMain.handle('ssh:chooseSshAgent', () => ({ ok: true, agentAvailable: false }));
  ipcMain.handle('preview:open', () => ({ ok: false, error: '测试环境跳过' }));
  ipcMain.handle('shell:openExternal', () => ({ ok: true }));
}

// ---- 主流程 ----
async function main() {
  try { fs.mkdirSync(DOC_DIR, { recursive: true }); } catch (e) {}
  protocol.registerSchemesAsPrivileged([
    { scheme: 'nimbus-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'nimbus-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);

  // 兼容模式已在模块顶层设置; 等 app ready 后再进行网络操作 (Electron 网络栈就绪)
  await app.whenReady();

  // 通过 ssh2 直连准备远端测试文件 (带重试: 服务器连接数可能未释放)
  console.log('[1] 准备远端测试文件...');
  let prepOk = false;
  for (let attempt = 1; attempt <= 3 && !prepOk; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const conn = new Client();
        const files = {
          'hello.txt': Buffer.from('Hello Nimbus Doc Viewer\n第二行中文内容\nline3: 12345\n', 'utf8'),
          'sample.pdf': makeMinimalPdf(),
          'sample.docx': makeMinimalDocx(),
          'old.doc': Buffer.from('fake doc binary', 'latin1'),
        };
        conn.on('ready', () => {
          conn.sftp((err, sftp) => {
            if (err) { conn.end(); return reject(err); }
            (async () => {
              try {
                // 幂等 prep: 目录已存在 (上次运行残留) 则跳过 mkdir, 避免 EEXIST 导致重跑失败
                await new Promise((res, rej) => sftp.stat(TEST_DIR, (statErr) => {
                  if (!statErr) return res(); // stat 成功 -> 目录已存在, 跳过
                  sftp.mkdir(TEST_DIR, (mkErr) => (mkErr ? rej(mkErr) : res()));
                }));
                for (const [name, data] of Object.entries(files)) {
                  await new Promise((res, rej) => {
                    const ws = sftp.createWriteStream(TEST_DIR + '/' + name);
                    ws.on('error', rej); ws.on('close', res); ws.end(data);
                  });
                }
                conn.end(); resolve();
              } catch (e) { conn.end(); reject(e); }
            })();
          });
        });
        conn.on('error', reject);
        conn.connect(Object.assign({}, SERVER, { debug: (m) => { if (attempt === 1) console.log('[ssh-debug]', m.slice(0, 160)); } }));
      });
      prepOk = true;
      console.log('    OK (attempt ' + attempt + ')');
    } catch (e) {
      console.log('    重试 ' + attempt + ' 失败: ' + e.message);
      if (attempt < 3) await sleep(5000);
      else throw e;
    }
  }

  protocol.handle('nimbus-preview', () => new Response('Not Found', { status: 404 }));
  protocol.handle('nimbus-doc', (request) => {
    try {
      const { host, pathname } = new URL(request.url);
      const raw = host || pathname;
      const filename = decodeURIComponent(String(raw).replace(/^\/+/, ''));
      if (!isSafeDocFilename(filename)) return new Response('Not Found', { status: 404 });
      const filePath = path.join(DOC_DIR, filename);
      if (!fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (e) { return new Response('Not Found', { status: 404 }); }
  });
  registerIpc();

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(CWD, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  winId = win.webContents.id;
  win.webContents.on('console-message', (e, level, message) => {
    // 只打印错误级
    if (level >= 2) console.log('[renderer]', message);
  });
  await win.loadFile(path.join(CWD, 'src', 'index.html'));
  // 保持隐藏: 本环境 GPU 受限, show() 可能触发崩溃; canvas 在隐藏窗口同样渲染
  // win.show();

  const ev = async (expr) => {
    const r = await win.webContents.executeJavaScript(expr, true);
    return r;
  };

  console.log('[2] 通过渲染层连接 SSH...');
  const connectRes = await ev(`(async function(){
    const conn = { id: 'c_test', name: 'wc', host: '${SERVER.host}', port: ${SERVER.port}, username: 'root', authMethod: 'password', password: '${SERVER.password}' };
    await openSession(conn);
    return 'OK';
  })()`);
  check('openSession 发起', connectRes === 'OK', String(connectRes));

  let connected = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await ev(`(function(){ const t=document.getElementById('statusText'); return t?t.textContent:''; })()`);
    if (st === '已连接') { connected = true; break; }
  }
  check('SSH 连接建立 (已连接)', connected);
  await sleep(1200);

  console.log('[3] 进入测试目录...');
  const sid = await ev(`(function(){ const sids=[...sessions.keys()].filter(k=>!k.startsWith('c_')); return sids[0]||null; })()`);
  check('获得会话 sessionId', !!sid, String(sid));
  await ev(`loadDir('${sid}', '${TEST_DIR}')`);
  await sleep(1000);
  const entries = await ev(`(function(){ const s=currentSftpSession(); return s? s.fileEntries.map(e=>e.name).sort(): []; })()`);
  console.log('    目录条目:', JSON.stringify(entries));
  check('SFTP 列表含测试文件', Array.isArray(entries) && ['hello.txt','sample.pdf','sample.docx','old.doc'].every((n) => entries.includes(n)));

  console.log('[4] 打开 hello.txt (文本)...');
  await ev(`(async function(){ const s=currentSftpSession(); openDocViewer(s, s.fileEntryMap.get('hello.txt')); return 'OK'; })()`);
  await sleep(1500);
  const textState = await ev(`(function(){
    const ta = document.getElementById('docTextArea');
    return {
      docViewerVisible: document.getElementById('docViewer').style.display,
      docTabCount: document.querySelectorAll('.tab.doc-tab').length,
      textarea: !!ta,
      textLen: ta ? ta.value.length : -1,
      title: document.getElementById('docTitleName').textContent,
      saveBtnVisible: document.getElementById('docSaveBtn').style.display,
      activeTabName: document.querySelector('.tab.active .tab-name') ? document.querySelector('.tab.active .tab-name').textContent : '',
    };
  })()`);
  console.log('    textState:', JSON.stringify(textState));
  check('docViewer 显示', textState && textState.docViewerVisible === 'flex');
  check('文档标签创建', textState && textState.docTabCount >= 1);
  check('文本 textarea 渲染', textState && textState.textarea && textState.textLen > 0, 'len=' + (textState && textState.textLen));
  check('标题为文件名', textState && textState.title === 'hello.txt');
  check('文本类显示保存按钮', textState && textState.saveBtnVisible === '');
  check('当前激活标签是文档标签', textState && String(textState.activeTabName).includes('hello.txt'));

  console.log('[5] 打开文档不多开终端断言 (已删除状态保持)...');
  const sessionState = await ev(`(function(){
    const sids = [...sessions.keys()].filter(k=>!k.startsWith('c_'));
    return { count: sids.length, objs: sids.map(id => { const s = sessions.get(id); return { id, name: s.name, status: s.status, docCwd: s.docCwd || null, connId: s.connId }; }) };
  })()`);
  console.log('    会话状态:', JSON.stringify(sessionState));
  check('打开文档不多开终端 (会话数=1)', sessionState && sessionState.count === 1, 'count=' + (sessionState && sessionState.count));
  check('所有会话均为手动连接 (无自动终端 connId=null)', sessionState && sessionState.objs.every((o) => o.connId !== null));
  check('docCwd 无残留 (null)', sessionState && sessionState.objs.every((o) => o.docCwd === null));

  console.log('[6] 文本编辑保存...');
  const saveRes = await ev(`(async function(){
    const ta = document.getElementById('docTextArea');
    ta.value = ta.value + '\\n# APPENDED_BY_E2E';
    const doc = docTabs.get(activeDocId);
    const r = await window.nimbus.docSave(doc.sessionId, doc.remotePath, ta.value);
    return { ok: r.ok, error: r.error || '' };
  })()`);
  check('docSave 返回 ok', saveRes && saveRes.ok === true, saveRes && saveRes.error);
  await sleep(600);

  console.log('[7] 打开 sample.pdf (pdfjs)...');
  await ev(`(async function(){ const s=currentSftpSession(); openDocViewer(s, s.fileEntryMap.get('sample.pdf')); return 'OK'; })()`);
  let pdfOk = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const st = await ev(`(function(){
      const stage = document.querySelector('.pdf-stage');
      const canvas = stage ? stage.querySelector('canvas') : null;
      return { canvas: !!canvas, w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0, label: document.getElementById('pdfPageLabel') ? document.getElementById('pdfPageLabel').textContent : '' };
    })()`);
    if (st && st.canvas && st.w > 0) { pdfOk = true; console.log('    PDF canvas:', JSON.stringify(st)); break; }
  }
  check('PDF canvas 渲染成功', pdfOk);

  console.log('[8] 打开 sample.docx (mammoth)...');
  await ev(`(async function(){ const s=currentSftpSession(); openDocViewer(s, s.fileEntryMap.get('sample.docx')); return 'OK'; })()`);
  let docxOk = false;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const st = await ev(`(function(){
      const c = document.querySelector('.docx-content');
      return c ? { html: c.innerHTML.length, text: c.textContent.replace(/\\s+/g,' ').trim() } : null;
    })()`);
    if (st && st.html > 0) { docxOk = true; console.log('    docx:', JSON.stringify(st)); break; }
  }
  check('DOCX 渲染成功', docxOk);

  console.log('[9] 打开 old.doc (提示转存)...');
  await ev(`(async function(){ const s=currentSftpSession(); openDocViewer(s, s.fileEntryMap.get('old.doc')); return 'OK'; })()`);
  await sleep(800);
  const docState = await ev(`(function(){
    const e = document.querySelector('.doc-error');
    return e ? e.textContent : '';
  })()`);
  check('.doc 提示转存', typeof docState === 'string' && docState.includes('暂不支持'), String(docState));

  console.log('[10] 标签切换 (终端 <-> 文档)...');
  const switchTest = await ev(`(async function(){
    const out = {};
    const termTab = document.querySelector('.tab:not(.doc-tab)');
    if (termTab) { termTab.click(); await new Promise(r=>setTimeout(r,300)); }
    out.termActive = {
      docViewer: document.getElementById('docViewer').style.display,
      terminalArea: document.getElementById('terminalArea').style.display,
      hostVisible: [...document.querySelectorAll('.terminal-host')].filter(h=>h.style.display!=='none').length,
      activeTab: document.querySelector('.tab.active .tab-name') ? document.querySelector('.tab.active .tab-name').textContent : '',
    };
    const docTabsEl = document.querySelectorAll('.tab.doc-tab');
    if (docTabsEl.length) { docTabsEl[docTabsEl.length-1].click(); await new Promise(r=>setTimeout(r,300)); }
    out.docActive = {
      docViewer: document.getElementById('docViewer').style.display,
      terminalArea: document.getElementById('terminalArea').style.display,
      activeTab: document.querySelector('.tab.active .tab-name') ? document.querySelector('.tab.active .tab-name').textContent : '',
    };
    out.docTabCount = docTabsEl.length;
    return out;
  })()`);
  console.log('    切换结果:', JSON.stringify(switchTest));
  check('终端标签激活 -> docViewer 隐藏', switchTest && switchTest.termActive.docViewer === 'none' && switchTest.termActive.hostVisible >= 1);
  check('文档标签激活 -> docViewer 显示', switchTest && switchTest.docActive.docViewer === 'flex' && switchTest.docActive.terminalArea === 'none');
  check('多文档标签并存 (4 个文档)', switchTest && switchTest.docTabCount === 4, 'count=' + (switchTest && switchTest.docTabCount));

  console.log('[11] 关闭文档标签...');
  const closeTest = await ev(`(async function(){
    const first = [...docTabs.keys()][0];
    await closeDocTab(first);
    return { afterCount: docTabs.size, viewerDisplay: document.getElementById('docViewer').style.display };
  })()`);
  console.log('    关闭结果:', JSON.stringify(closeTest));
  check('closeDocTab 移除标签', closeTest && closeTest.afterCount === 3, 'after=' + (closeTest && closeTest.afterCount));
  check('关闭后查看器仍显示 (还有其他文档)', closeTest && closeTest.viewerDisplay === 'flex');

  console.log('\n============================================');
  console.log(`文档查看器 E2E 测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  console.log('============================================');
  try { fs.rmSync(DOC_DIR, { recursive: true, force: true }); } catch (e) {}
  app.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e && e.stack || e); app.exit(2); });
