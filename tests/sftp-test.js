/**
 * NimbusSSH SFTP 功能集成测试
 * 使用与 src/main.js 中 SFTP 实现完全相同的调用方式 (promisify + 流式管道),
 * 验证: 目录列表 / 新建目录 / 上传 / 下载 / 重命名 / 递归删除 全链路.
 * 目标: 用户提供的真实服务器 (与 real-server-test.js 同一台)
 */
const { Client } = require('ssh2');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ===== 与 main.js 相同的服务器配置 =====
const CONFIG = {
  host: '172.16.11.10',
  port: 26810,
  username: 'root',
  password: 'CHANGE_ME_TEST_PASSWORD',
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3,
};

// ===== 以下函数与 main.js 中的 SFTP 实现保持一致 (验证真实可用性) =====

function joinRemotePath(parent, name) {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

function normalizeMtime(mtime) {
  if (mtime instanceof Date) return mtime.getTime();
  if (typeof mtime === 'number') return mtime > 1e12 ? mtime : mtime * 1000;
  return 0;
}

async function sftpList(sftp, remotePath) {
  const readdir = promisify(sftp.readdir).bind(sftp);
  const entries = await readdir(remotePath || '/');
  const items = [];
  for (const ent of entries || []) {
    const name = ent.filename;
    if (name === '.' || name === '..') continue;
    const attrs = ent.attrs || {};
    const isDir = !!(attrs.isDirectory && attrs.isDirectory());
    items.push({
      name,
      isDir,
      size: typeof attrs.size === 'number' ? attrs.size : 0,
      mtime: normalizeMtime(attrs.mtime),
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return { path: remotePath || '/', entries: items };
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

// ===== 与 main.js 修复后一致的递归删除 (lstat 判型 + 深度上限) =====
const MAX_DELETE_DEPTH = 50;

async function sftpRemove(sftp, remotePath, isDir, depth) {
  if (depth > MAX_DELETE_DEPTH) {
    throw new Error('目录嵌套过深, 已中止删除 (可能存在符号链接环)');
  }
  const unlink = promisify(sftp.unlink).bind(sftp);
  const rmdir = promisify(sftp.rmdir).bind(sftp);
  const readdir = promisify(sftp.readdir).bind(sftp);
  const lstat = promisify(sftp.lstat).bind(sftp);
  if (!isDir) {
    // 普通文件与符号链接统一 unlink
    await unlink(remotePath);
    return;
  }
  let entries = [];
  try {
    entries = await readdir(remotePath);
  } catch (e) { /* 按空目录处理 */ }
  for (const ent of entries) {
    if (ent.filename === '.' || ent.filename === '..') continue;
    const childPath = joinRemotePath(remotePath, ent.filename);
    // 子项判型用 lstat, 符号链接一律按文件删除
    let childIsDir = false;
    try {
      const st = await lstat(childPath);
      childIsDir = !!(st.isDirectory && st.isDirectory());
    } catch (e) {
      childIsDir = false;
    }
    await sftpRemove(sftp, childPath, childIsDir, depth + 1);
  }
  await rmdir(remotePath);
}

// ===== 测试主流程 =====
const TEST_DIR = '/tmp/nimbus-sftp-test';
const LOCAL_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-sftp-'));
const LOCAL_FILE = path.join(LOCAL_TMP, 'upload-sample.txt');
fs.writeFileSync(LOCAL_FILE, 'NIMBUS_SFTP_TEST_CONTENT_2026\n' + 'x'.repeat(1024), 'utf8');

let passCount = 0;
let failCount = 0;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function check(name, cond, extra = '') {
  if (cond) {
    passCount++;
    log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failCount++;
    log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function finish(code) {
  // 清理本地临时文件
  try { fs.rmSync(LOCAL_TMP, { recursive: true, force: true }); } catch (e) {}
  log('\n============================================');
  log(`SFTP 测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  log('============================================');
  process.exit(code);
}

const conn = new Client();

conn.on('ready', () => {
  log('✅ SSH 连接建立 (ready) — 密码认证通过');
  log('   打开 SFTP 通道 (与 main.js getSftp() 相同方式)...');

  conn.sftp((err, sftp) => {
    if (err) {
      log('❌ SFTP 通道打开失败: ' + err.message);
      conn.end();
      return;
    }
    log('✅ SFTP 通道打开成功, 开始执行测试...\n');

    (async () => {
      try {
        // 1. 目录列表 (根目录)
        const list1 = await sftpList(sftp, '/');
        check('sftpList("/")', list1.entries.length > 0, `共 ${list1.entries.length} 项`);
        const hasDir = list1.entries.some((x) => x.isDir);
        const hasMtime = list1.entries.every((x) => typeof x.mtime === 'number');
        check('目录条目带 isDir 标志', hasDir);
        check('目录条目 mtime 为数值(毫秒)', hasMtime);

        // 2. 新建目录
        await promisify(sftp.mkdir).bind(sftp)(TEST_DIR);
        check('sftpMkdir(TEST_DIR)', true);

        // 3. 上传文件
        const up = await streamTransfer(
          fs.createReadStream(LOCAL_FILE),
          sftp.createWriteStream(joinRemotePath(TEST_DIR, 'upload-sample.txt'))
        );
        check('sftpUpload (流式)', up.ok, up.error || '');

        // 4. 目录列表 (测试目录, 目录优先排序)
        const list2 = await sftpList(sftp, TEST_DIR);
        check('sftpList(TEST_DIR) 包含上传文件',
          list2.entries.some((x) => x.name === 'upload-sample.txt' && !x.isDir),
          `共 ${list2.entries.length} 项`);

        // 5. 下载文件并校验内容
        const dlPath = path.join(LOCAL_TMP, 'downloaded.txt');
        const dl = await streamTransfer(
          sftp.createReadStream(joinRemotePath(TEST_DIR, 'upload-sample.txt')),
          fs.createWriteStream(dlPath)
        );
        const dlContent = fs.readFileSync(dlPath, 'utf8');
        const srcContent = fs.readFileSync(LOCAL_FILE, 'utf8');
        check('sftpDownload (流式)', dl.ok && dlContent === srcContent, dl.error || '');

        // 6. 重命名
        await promisify(sftp.rename).bind(sftp)(
          joinRemotePath(TEST_DIR, 'upload-sample.txt'),
          joinRemotePath(TEST_DIR, 'renamed.txt')
        );
        const list3 = await sftpList(sftp, TEST_DIR);
        check('sftpRename',
          list3.entries.some((x) => x.name === 'renamed.txt') &&
          !list3.entries.some((x) => x.name === 'upload-sample.txt'));

        // 7. 符号链接回归: 删除链接不得误删链接目标内容 (QA #3)
        const realDir = joinRemotePath(TEST_DIR, 'real');
        const secretFile = joinRemotePath(realDir, 'secret.txt');
        const linkPath = joinRemotePath(TEST_DIR, 'link');
        await promisify(sftp.mkdir).bind(sftp)(realDir);
        await streamTransfer(
          fs.createReadStream(LOCAL_FILE),
          sftp.createWriteStream(secretFile)
        );
        // ssh2 symlink(targetPath, linkPath, cb)
        await promisify(sftp.symlink).bind(sftp)(realDir, linkPath);
        const linkStat = await promisify(sftp.lstat).bind(sftp)(linkPath);
        check('符号链接 lstat 判型为链接',
          !!(linkStat.isSymbolicLink && linkStat.isSymbolicLink()) &&
          !(linkStat.isDirectory && linkStat.isDirectory()));
        // 用 lstat 判型后按文件删除链接
        await sftpRemove(sftp, linkPath, false, 0);
        let secretOk = true;
        try {
          await promisify(sftp.stat).bind(sftp)(secretFile);
        } catch (e) {
          secretOk = false;
        }
        check('删除符号链接不影响链接目标内容', secretOk);
        let linkGone = false;
        try {
          await promisify(sftp.lstat).bind(sftp)(linkPath);
        } catch (e) {
          linkGone = true;
        }
        check('符号链接本身已删除', linkGone);

        // 8. 递归删除目录 (内含 real/secret.txt)
        await sftpRemove(sftp, TEST_DIR, true, 0);
        let deleted = false;
        try {
          await promisify(sftp.stat).bind(sftp)(TEST_DIR);
        } catch (e) {
          deleted = true;
        }
        check('sftpDelete 递归删除', deleted);

        log('\n> 全部 SFTP 用例执行完毕, 关闭连接');
      } catch (e) {
        failCount++;
        log('❌ 执行异常: ' + (e && e.message));
        // 尽力清理
        try { sftpRemove(sftp, TEST_DIR, true, 0); } catch (e2) {}
      } finally {
        conn.end();
      }
    })();
  });
});

conn.on('error', (err) => {
  log('❌ 连接失败: ' + err.message + ' (若服务器不可达, 请先确认可连接)');
  finish(failCount === 0 ? 1 : 1);
});

conn.on('close', () => {
  log('✅ SFTP 会话关闭');
  finish(failCount === 0 ? 0 : 1);
});

log(`启动 SFTP 集成测试 → ssh://${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`);
conn.connect(CONFIG);

setTimeout(() => {
  log('⚠️ 整体超时 (30s)');
  try { conn.end(); } catch (e) {}
  finish(1);
}, 30000);
