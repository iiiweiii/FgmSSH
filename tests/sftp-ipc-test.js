/**
 * FgmSSH SFTP IPC 层回归冒烟测试
 * 背景: main.js 依赖 Electron, 无法在纯 node 中 require。
 *       本测试复刻 main.js 的「本地路径登记表」机制 (approvedLocalPaths),
 *       验证 上传/下载 的 对话框登记 → 传输消费 → 未登记拒绝 完整行为链路,
 *       并连真实服务器验证多选上传真实传输可用。
 * 覆盖 QA 回归点: ① approvePath 移除后 selectFile 登记链路 ④ isSafeRemotePath 删除校验
 */
const { Client } = require('ssh2');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ===== 与 real-server-test.js 相同的真实服务器 =====
const CONFIG = {
  host: '172.16.11.10',
  port: 26810,
  username: 'root',
  password: 'CHANGE_ME_TEST_PASSWORD',
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3,
};

// ===== 复刻 main.js: 本地路径登记表机制 =====
const approvedLocalPaths = new Set();

// 对应 main.js dialog:selectFile (系统对话框多选登记)
function mockSelectFile(paths) {
  const arr = Array.isArray(paths) ? paths : [paths];
  for (const p of arr) approvedLocalPaths.add(p);
  return { ok: true, paths: arr };
}

// 对应 main.js dialog:selectSavePath (保存对话框单选登记)
function mockSelectSavePath(p) {
  approvedLocalPaths.add(p);
  return { ok: true, path: p };
}

// 对应 main.js sftpUpload/sftpDownload 入口的登记校验 (命中后消费移除)
function assertApprovedLocalPath(localPath) {
  if (!approvedLocalPaths.has(localPath)) return { ok: false, error: '路径未经过确认' };
  approvedLocalPaths.delete(localPath);
  return { ok: true };
}

// 复刻 main.js isSafeRemotePath (delete/mkdir/rename 的路径清洗)
function isSafeRemotePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  return !p.split('/').some((seg) => seg === '..');
}

// 复刻 main.js sftpUpload 的登记校验 + 真实流式上传
async function guardedUpload(sftp, localPath, remotePath) {
  const check = assertApprovedLocalPath(localPath);
  if (!check.ok) return check;
  if (!fs.existsSync(localPath)) return { ok: false, error: '本地文件不存在' };
  return streamTransfer(fs.createReadStream(localPath), sftp.createWriteStream(remotePath));
}

// 复刻 main.js sftpDownload 的登记校验 + 真实流式下载
async function guardedDownload(sftp, remotePath, localPath) {
  const check = assertApprovedLocalPath(localPath);
  if (!check.ok) return check;
  return streamTransfer(sftp.createReadStream(remotePath), fs.createWriteStream(localPath));
}

function streamTransfer(reader, writer) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true } : { ok: false, error });
    };
    reader.on('error', (err) => settle(false, err.message));
    writer.on('error', (err) => settle(false, err.message));
    writer.on('close', () => settle(true));
    reader.pipe(writer);
  });
}

// 复刻 main.js 递归删除 (lstat 判型 + 深度上限), 用于测试清理
const MAX_DELETE_DEPTH = 50;
async function sftpRemove(sftp, remotePath, isDir, depth) {
  if (depth > MAX_DELETE_DEPTH) throw new Error('目录嵌套过深');
  const unlink = promisify(sftp.unlink).bind(sftp);
  const rmdir = promisify(sftp.rmdir).bind(sftp);
  const readdir = promisify(sftp.readdir).bind(sftp);
  const lstat = promisify(sftp.lstat).bind(sftp);
  if (!isDir) {
    await unlink(remotePath);
    return;
  }
  let entries = [];
  try {
    entries = await readdir(remotePath);
  } catch (e) { /* 空目录 */ }
  for (const ent of entries) {
    if (ent.filename === '.' || ent.filename === '..') continue;
    const childPath = remotePath.replace(/\/+$/, '') + '/' + ent.filename;
    let childIsDir = false;
    try {
      const st = await lstat(childPath);
      childIsDir = !!(st.isDirectory && st.isDirectory());
    } catch (e) { childIsDir = false; }
    await sftpRemove(sftp, childPath, childIsDir, depth + 1);
  }
  await rmdir(remotePath);
}

// ===== 测试基础设施 =====
const TEST_DIR = '/tmp/nimbus-sftp-ipc-test';
const LOCAL_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-ipc-'));
const LOCAL_A = path.join(LOCAL_TMP, 'a.txt');
const LOCAL_B = path.join(LOCAL_TMP, 'b.txt');
const LOCAL_C = path.join(LOCAL_TMP, 'c.txt');
fs.writeFileSync(LOCAL_A, 'FILE_A_CONTENT\n', 'utf8');
fs.writeFileSync(LOCAL_B, 'FILE_B_CONTENT\n', 'utf8');
fs.writeFileSync(LOCAL_C, 'FILE_C_CONTENT\n', 'utf8');

let passCount = 0;
let failCount = 0;

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function check(name, cond, extra = '') {
  if (cond) { passCount++; log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failCount++; log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
function finish(code) {
  try { fs.rmSync(LOCAL_TMP, { recursive: true, force: true }); } catch (e) {}
  log('\n============================================');
  log(`SFTP IPC 冒烟测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  log('============================================');
  process.exit(code);
}

const conn = new Client();

conn.on('ready', () => {
  log('✅ SSH 连接建立 (ready)');
  conn.sftp((err, sftp) => {
    if (err) {
      log('❌ SFTP 通道打开失败: ' + err.message);
      conn.end();
      return;
    }
    log('✅ SFTP 通道打开成功, 开始执行 IPC 行为断言...\n');

    (async () => {
      try {
        await promisify(sftp.mkdir).bind(sftp)(TEST_DIR);

        // 1. 未登记路径上传 → 拒绝 (不发起传输)
        const reject1 = await guardedUpload(sftp, LOCAL_A, TEST_DIR + '/a.txt');
        check('未登记路径上传被拒', !reject1.ok && reject1.error === '路径未经过确认', reject1.error || '');
        let notCreated = true;
        try { await promisify(sftp.stat).bind(sftp)(TEST_DIR + '/a.txt'); notCreated = false; } catch (e) {}
        check('被拒后远端未创建文件', notCreated);

        // 2. dialog:selectFile 登记 (单选) → 上传成功
        const sel1 = mockSelectFile([LOCAL_A]);
        check('selectFile 返回 {ok, paths}', sel1.ok && Array.isArray(sel1.paths) && sel1.paths.length === 1);
        const up1 = await guardedUpload(sftp, LOCAL_A, TEST_DIR + '/a.txt');
        check('登记后上传成功', up1.ok, up1.error || '');

        // 3. 消费型防重放: 同一路径未重新登记 → 再次上传被拒
        const reject2 = await guardedUpload(sftp, LOCAL_A, TEST_DIR + '/a-dup.txt');
        check('同一路径未重新登记被拒(防重放)', !reject2.ok && reject2.error === '路径未经过确认');

        // 4. 多选登记 → 逐个上传成功
        const sel2 = mockSelectFile([LOCAL_B, LOCAL_C]);
        check('selectFile 多选返回数组', sel2.ok && sel2.paths.length === 2);
        const upB = await guardedUpload(sftp, LOCAL_B, TEST_DIR + '/b.txt');
        const upC = await guardedUpload(sftp, LOCAL_C, TEST_DIR + '/c.txt');
        check('多选逐个上传成功', upB.ok && upC.ok, (upB.error || '') + (upC.error || ''));

        // 5. 远端列表断言 3 个文件
        const list = await promisify(sftp.readdir).bind(sftp)(TEST_DIR);
        const names = list.map((x) => x.filename);
        check('远端存在 a/b/c 三个文件',
          names.includes('a.txt') && names.includes('b.txt') && names.includes('c.txt'),
          names.join(','));

        // 6. 未登记下载 → 拒绝
        const dlLocal = path.join(LOCAL_TMP, 'dl.txt');
        const dlReject = await guardedDownload(sftp, TEST_DIR + '/a.txt', dlLocal);
        check('未登记下载被拒', !dlReject.ok && dlReject.error === '路径未经过确认');
        check('被拒后本地未生成文件', !fs.existsSync(dlLocal));

        // 7. dialog:selectSavePath 登记 → 下载成功
        mockSelectSavePath(dlLocal);
        const dlOk = await guardedDownload(sftp, TEST_DIR + '/a.txt', dlLocal);
        const dlContent = fs.readFileSync(dlLocal, 'utf8');
        check('登记后下载成功且内容一致', dlOk.ok && dlContent === 'FILE_A_CONTENT\n', dlOk.error || '');

        // 8. 路径清洗: delete 前 isSafeRemotePath 拒绝 ..
        check('isSafeRemotePath 拒绝 .. 段', !isSafeRemotePath('/tmp/../etc'));
        check('isSafeRemotePath 接受正常路径', isSafeRemotePath('/tmp/nimbus-sftp-ipc-test'));
        check('isSafeRemotePath 拒绝空/超长', !isSafeRemotePath('') && !isSafeRemotePath('x'.repeat(4097)));

        // 清理远端
        await sftpRemove(sftp, TEST_DIR, true, 0);
        let cleaned = false;
        try { await promisify(sftp.stat).bind(sftp)(TEST_DIR); } catch (e) { cleaned = true; }
        check('远端测试目录已清理', cleaned);

        log('\n> 全部 IPC 冒烟用例执行完毕');
      } catch (e) {
        failCount++;
        log('❌ 执行异常: ' + (e && e.message));
        try { sftpRemove(sftp, TEST_DIR, true, 0); } catch (e2) {}
      } finally {
        conn.end();
      }
    })();
  });
});

conn.on('error', (err) => {
  log('❌ 连接失败: ' + err.message + ' (若服务器不可达, 请先确认可连接)');
  finish(1);
});
conn.on('close', () => {
  log('✅ SFTP 会话关闭');
  finish(failCount === 0 ? 0 : 1);
});

log(`启动 SFTP IPC 冒烟测试 → ssh://${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`);
conn.connect(CONFIG);

setTimeout(() => {
  log('⚠️ 整体超时 (30s)');
  try { conn.end(); } catch (e) {}
  finish(1);
}, 30000);
