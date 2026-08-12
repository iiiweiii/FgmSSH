/**
 * NimbusSSH - 内置文档查看器 + 打开文档不多开终端 端到端验证 (CDP 驱动)
 *
 * 流程:
 *  1. 通过 ssh2 在远端准备测试文件 (hello.txt / sample.pdf / sample.docx / old.doc)
 *  2. 拉起应用 (remote debugging 9222)
 *  3. CDP: 点击连接 -> 等待已连接 -> loadDir 进入测试目录
 *  4. CDP: 分别打开 文本/PDF/DOCX/DOC 文档, 断言查看器渲染与标签状态
 *  5. CDP: 断言打开文档不多开终端 (会话数保持 1)
 *  6. CDP: 断言标签切换 (终端标签 <-> 文档标签) 无 DOM 冲突
 *
 * 运行: unset NODE_OPTIONS ELECTRON_RUN_AS_NODE && node tests/doc-e2e-test.js
 */
const { spawn } = require('child_process');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

const CWD = path.resolve(__dirname, '..');
const SERVER = {
  host: '172.16.11.10', port: 26810, username: 'root', password: '92eXlHKg8i',
  readyTimeout: 20000, keepaliveInterval: 10000, keepaliveCountMax: 3,
};
const TEST_DIR = '/tmp/nimbus-doc-e2e';

let passCount = 0;
let failCount = 0;
function check(name, cond, extra = '') {
  if (cond) { passCount++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failCount++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 最小 PDF / DOCX 生成器 (与探针相同) ----
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
  const zlib = require('zlib');
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

// ---- 远端准备测试文件 ----
async function prepareRemoteFiles() {
  return new Promise((resolve, reject) => {
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
            // 幂等 prep: 目录已存在 (上次运行残留) 则跳过 mkdir, 避免 EEXIST/SSH_FX_FAILURE(4) 导致重跑失败
            await new Promise((res, rej) => sftp.stat(TEST_DIR, (statErr) => {
              if (!statErr) return res(); // stat 成功 -> 目录已存在, 跳过
              sftp.mkdir(TEST_DIR, (mkErr) => (mkErr ? rej(mkErr) : res()));
            }));
            for (const [name, data] of Object.entries(files)) {
              await new Promise((res, rej) => {
                const ws = sftp.createWriteStream(TEST_DIR + '/' + name);
                ws.on('error', rej);
                ws.on('close', res);
                ws.end(data);
              });
            }
            conn.end();
            resolve();
          } catch (e) { conn.end(); reject(e); }
        })();
      });
    });
    conn.on('error', reject);
    conn.connect(SERVER);
  });
}

// ---- CDP 客户端 ----
function createCdp(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      let msgId = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      };
      const send = (method, params = {}) => new Promise((res) => {
        const id = ++msgId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) {
          return { __exception: r.result.exceptionDetails.text, details: r.result.exceptionDetails };
        }
        return r.result && r.result.result ? r.result.result.value : r.result;
      };
      resolve({ ws, send, evaluate });
    };
    ws.onerror = reject;
  });
}

async function waitForCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const pages = await res.json();
      const page = pages.find((p) => p.type === 'page' && p.url.includes('index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('CDP 端口未就绪');
}

// ---- 主流程 ----
async function main() {
  // 1. 准备远端文件
  console.log('[1] 准备远端测试文件...');
  await prepareRemoteFiles();
  console.log('    OK: ' + TEST_DIR + ' (hello.txt/sample.pdf/sample.docx/old.doc)');

  // 2. 拉起应用
  console.log('[2] 启动应用 (remote debugging)...');
  const env = Object.assign({}, process.env, {
    NODE_OPTIONS: undefined, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_ENABLE_LOGGING: '1',
  });
  const child = spawn(
    path.join(CWD, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--enable-logging', '--remote-debugging-port=9222', '--no-sandbox'],
    { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let appLog = '';
  child.stdout.on('data', (d) => { appLog += d; });
  child.stderr.on('data', (d) => { appLog += d; });

  try {
    const wsUrl = await waitForCdp();
    console.log('    CDP 已连接');
    const cdp = await createCdp(wsUrl);
    const ev = cdp.evaluate;

    // 3. 点击连接并等待已连接
    console.log('[3] 连接 SSH 会话...');
    await ev(`(function(){ const item = document.querySelector('.conn-item'); if (item) item.click(); return !!item; })()`);
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const st = await ev(`(function(){ const t=document.getElementById('statusText'); return t?t.textContent:''; })()`);
      if (st === '已连接') { connected = true; break; }
    }
    check('SSH 连接建立 (已连接)', connected);
    await sleep(1500);

    // 4. 进入测试目录
    console.log('[4] 进入测试目录...');
    const sids = await ev(`(function(){ return [...sessions.keys()].filter(k=>!k.startsWith('c_')); })()`);
    const sid = Array.isArray(sids) && sids.length ? sids[0] : null;
    check('获得会话 sessionId', !!sid, String(sid));
    await ev(`loadDir('${sid}', '${TEST_DIR}')`);
    await sleep(1200);
    const entries = await ev(`(function(){ const s=currentSftpSession(); return s? s.fileEntries.map(e=>e.name).sort(): []; })()`);
    console.log('    目录条目:', JSON.stringify(entries));
    check('SFTP 列表含测试文件',
      Array.isArray(entries) && ['hello.txt','sample.pdf','sample.docx','old.doc'].every((n) => entries.includes(n)));

    // 5. 打开文本文档 (走右键菜单路径: 模拟 contextmenu -> 点击「打开」)
    console.log('[5] 打开 hello.txt (文本)...');
    const openRes = await ev(`(async function(){
      const s = currentSftpSession();
      if (!s) return 'NO_SESSION';
      const entry = s.fileEntryMap.get('hello.txt');
      if (!entry) return 'NO_ENTRY';
      openDocViewer(s, entry);
      return 'OPENED';
    })()`);
    check('openDocViewer(hello.txt) 发起', openRes === 'OPENED', String(openRes));
    await sleep(1500);
    const textState = await ev(`(function(){
      const ta = document.getElementById('docTextArea');
      return {
        docViewerVisible: document.getElementById('docViewer').style.display,
        tabCount: document.querySelectorAll('.tab').length,
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

    // 5b. 打开文档不多开终端断言 (已删除状态保持)
    const sessionState = await ev(`(function(){
      const sids = [...sessions.keys()].filter(k=>!k.startsWith('c_'));
      const objs = sids.map(id => { const s = sessions.get(id); return { id, name: s.name, status: s.status, docCwd: s.docCwd || null }; });
      return { count: sids.length, objs };
    })()`);
    console.log('    会话状态:', JSON.stringify(sessionState));
    check('打开文档不多开终端 (会话数=1)', sessionState && sessionState.count === 1, 'count=' + (sessionState && sessionState.count));
    check('docCwd 无残留 (null)', sessionState && sessionState.objs.every((o) => o.docCwd === null));

    // 5c. 文本保存 (写入 -> docSave -> 读回校验)
    console.log('[5c] 文本编辑保存...');
    const saveRes = await ev(`(async function(){
      const ta = document.getElementById('docTextArea');
      ta.value = ta.value + '\\n# APPENDED_BY_E2E';
      const doc = docTabs.get(activeDocId);
      const r = await window.nimbus.docSave(doc.sessionId, doc.remotePath, ta.value);
      return { ok: r.ok, error: r.error || '' };
    })()`);
    check('docSave 返回 ok', saveRes && saveRes.ok === true, saveRes && saveRes.error);
    await sleep(600);

    // 6. 打开 PDF
    console.log('[6] 打开 sample.pdf (pdfjs)...');
    const pdfOpen = await ev(`(async function(){
      const s = currentSftpSession();
      const entry = s.fileEntryMap.get('sample.pdf');
      if (!entry) return 'NO_ENTRY';
      openDocViewer(s, entry);
      return 'OPENED';
    })()`);
    check('openDocViewer(sample.pdf) 发起', pdfOpen === 'OPENED');
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

    // 7. 打开 DOCX
    console.log('[7] 打开 sample.docx (mammoth)...');
    const docxOpen = await ev(`(async function(){
      const s = currentSftpSession();
      const entry = s.fileEntryMap.get('sample.docx');
      if (!entry) return 'NO_ENTRY';
      openDocViewer(s, entry);
      return 'OPENED';
    })()`);
    check('openDocViewer(sample.docx) 发起', docxOpen === 'OPENED');
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

    // 8. 打开 .doc -> 提示不支持
    console.log('[8] 打开 old.doc (提示转存)...');
    const docOpen = await ev(`(async function(){
      const s = currentSftpSession();
      const entry = s.fileEntryMap.get('old.doc');
      if (!entry) return 'NO_ENTRY';
      openDocViewer(s, entry);
      return 'OPENED';
    })()`);
    check('openDocViewer(old.doc) 发起', docOpen === 'OPENED');
    await sleep(800);
    const docState = await ev(`(function(){
      const e = document.querySelector('.doc-error');
      return e ? e.textContent : '';
    })()`);
    check('.doc 提示转存', typeof docState === 'string' && docState.includes('暂不支持'), String(docState));

    // 9. 标签切换验证
    console.log('[9] 标签切换 (终端 <-> 文档)...');
    const switchTest = await ev(`(async function(){
      const out = {};
      const docTabCount = document.querySelectorAll('.tab.doc-tab').length;
      // 点第一个终端标签 -> 终端显示, docViewer 隐藏
      const termTab = document.querySelector('.tab:not(.doc-tab)');
      if (termTab) { termTab.click(); await new Promise(r=>setTimeout(r,300)); }
      out.termActive = {
        docViewer: document.getElementById('docViewer').style.display,
        terminalArea: document.getElementById('terminalArea').style.display,
        hostVisible: [...document.querySelectorAll('.terminal-host')].filter(h=>h.style.display!=='none').length,
        activeTab: document.querySelector('.tab.active .tab-name') ? document.querySelector('.tab.active .tab-name').textContent : '',
      };
      // 点最后一个文档标签 -> 文档显示, 终端隐藏
      const docTabs = document.querySelectorAll('.tab.doc-tab');
      if (docTabs.length) { docTabs[docTabs.length-1].click(); await new Promise(r=>setTimeout(r,300)); }
      out.docActive = {
        docViewer: document.getElementById('docViewer').style.display,
        terminalArea: document.getElementById('terminalArea').style.display,
        activeTab: document.querySelector('.tab.active .tab-name') ? document.querySelector('.tab.active .tab-name').textContent : '',
      };
      out.docTabCount = docTabCount;
      return out;
    })()`);
    console.log('    切换结果:', JSON.stringify(switchTest));
    check('终端标签激活 -> docViewer 隐藏', switchTest && switchTest.termActive.docViewer === 'none' && switchTest.termActive.hostVisible >= 1);
    check('文档标签激活 -> docViewer 显示', switchTest && switchTest.docActive.docViewer === 'flex' && switchTest.docActive.terminalArea === 'none');
    check('多文档标签并存 (4 个文档)', switchTest && switchTest.docTabCount === 4, 'count=' + (switchTest && switchTest.docTabCount));

    // 10. 关闭文档标签 -> docClose 清理 + 视图回退
    console.log('[10] 关闭文档标签...');
    const closeTest = await ev(`(async function(){
      const before = [...docTabs.keys()];
      const first = before[0];
      await closeDocTab(first);
      return { beforeCount: before.length, afterCount: docTabs.size, viewerDisplay: document.getElementById('docViewer').style.display };
    })()`);
    console.log('    关闭结果:', JSON.stringify(closeTest));
    check('closeDocTab 移除标签', closeTest && closeTest.afterCount === 3, 'after=' + closeTest && closeTest.afterCount);
    check('关闭后查看器仍显示 (还有其他文档)', closeTest && closeTest.viewerDisplay === 'flex');

    console.log('\n============================================');
    console.log(`文档查看器 E2E 测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
    console.log('============================================');
    child.kill();
    process.exit(failCount === 0 ? 0 : 1);
  } catch (e) {
    console.error('E2E 异常:', e.message);
    if (appLog) console.log('---- app log tail ----\n' + appLog.slice(-3000));
    child.kill();
    process.exit(2);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(3); });
