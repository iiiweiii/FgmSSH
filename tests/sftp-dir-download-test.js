/**
 * FgmSSH SFTP 文件夹打包下载 (ZIP) 集成测试
 * 背景: main.js 依赖 Electron, 无法在纯 node 中 require。
 *       本测试复刻 main.js 新增的「自写 ZIP 写入器」全部函数 (与 main.js 保持一致),
 *       连真实服务器验证: 递归打包 / 目录层级 / 空文件夹 / 5MB 大文件流式 / 进度回调 / 错误映射。
 * 校验方式: 自写 ZIP central directory 解析器 (独立读取, 不依赖系统 unzip)。
 */
const { Client } = require('ssh2');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

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

// ===== 以下 ZIP 打包函数与 main.js 完全一致 (镜像, 验证真实可用性) =====
const MAX_DOWNLOAD_DEPTH = 100;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_DD_SIG = 0x08074b50;
const ZIP_FLAG_DATADESC = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

function zipWriteU16(buf, offset, value) { buf.writeUInt16LE(value & 0xffff, offset); }
function zipWriteU32(buf, offset, value) { buf.writeUInt32LE(value >>> 0, offset); }

function dosDateTime(ms) {
  const d = (ms && !isNaN(new Date(ms).getTime())) ? new Date(ms) : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function zipBuildLocalHeader(zipPath, isDir, mtimeMs) {
  const nameBuf = Buffer.from(zipPath, 'utf8');
  const header = Buffer.alloc(30);
  zipWriteU32(header, 0, ZIP_LOCAL_SIG);
  zipWriteU16(header, 4, 20);
  zipWriteU16(header, 6, isDir ? ZIP_FLAG_UTF8 : (ZIP_FLAG_UTF8 | ZIP_FLAG_DATADESC));
  zipWriteU16(header, 8, isDir ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE);
  const dt = dosDateTime(mtimeMs);
  zipWriteU16(header, 10, dt.time);
  zipWriteU16(header, 12, dt.date);
  zipWriteU32(header, 14, 0);
  zipWriteU32(header, 18, 0);
  zipWriteU32(header, 22, 0);
  zipWriteU16(header, 26, nameBuf.length);
  zipWriteU16(header, 28, 0);
  return Buffer.concat([header, nameBuf]);
}

function zipBuildCentralEntry(zipPath, isDir, mtimeMs, crc, compressedSize, uncompressedSize, localOffset) {
  const nameBuf = Buffer.from(zipPath, 'utf8');
  const buf = Buffer.alloc(46);
  zipWriteU32(buf, 0, ZIP_CENTRAL_SIG);
  zipWriteU16(buf, 4, 20);
  zipWriteU16(buf, 6, 20);
  zipWriteU16(buf, 8, isDir ? ZIP_FLAG_UTF8 : (ZIP_FLAG_UTF8 | ZIP_FLAG_DATADESC));
  zipWriteU16(buf, 10, isDir ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE);
  const dt = dosDateTime(mtimeMs);
  zipWriteU16(buf, 12, dt.time);
  zipWriteU16(buf, 14, dt.date);
  zipWriteU32(buf, 16, crc >>> 0);
  zipWriteU32(buf, 20, compressedSize >>> 0);
  zipWriteU32(buf, 24, uncompressedSize >>> 0);
  zipWriteU16(buf, 28, nameBuf.length);
  zipWriteU16(buf, 30, 0);
  zipWriteU16(buf, 32, 0);
  zipWriteU16(buf, 34, 0);
  zipWriteU16(buf, 36, 0);
  zipWriteU32(buf, 38, isDir ? 0x10 : 0);
  zipWriteU32(buf, 42, localOffset >>> 0);
  return Buffer.concat([buf, nameBuf]);
}

function zipBuildEocd(centralSize, centralOffset, entryCount) {
  const buf = Buffer.alloc(22);
  zipWriteU32(buf, 0, ZIP_EOCD_SIG);
  zipWriteU16(buf, 4, 0);
  zipWriteU16(buf, 6, 0);
  zipWriteU16(buf, 8, Math.min(0xffff, entryCount));
  zipWriteU16(buf, 10, Math.min(0xffff, entryCount));
  zipWriteU32(buf, 12, centralSize >>> 0);
  zipWriteU32(buf, 16, centralOffset >>> 0);
  zipWriteU16(buf, 20, 0);
  return buf;
}

function joinRemotePath(parent, name) {
  if (!parent || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

function normalizeMtime(mtime) {
  if (mtime instanceof Date) return mtime.getTime();
  if (typeof mtime === 'number') return mtime > 1e12 ? mtime : mtime * 1000;
  return 0;
}

async function sftpListRecursive(sftp, remotePath, opts) {
  const onProgress = (opts && opts.onProgress) || function () {};
  const depthLimit = (opts && opts.depthLimit) || MAX_DOWNLOAD_DEPTH;
  const rootZip = (opts && opts.rootZip) || '';
  const result = [];
  let scanned = 0;

  async function walk(dirRemote, dirZip, depth) {
    if (depth > depthLimit) {
      throw new Error(`目录嵌套过深 (超过 ${depthLimit} 层), 已中止打包 (可能存在符号链接环)`);
    }
    const readdir = promisify(sftp.readdir).bind(sftp);
    const lstat = promisify(sftp.lstat).bind(sftp);
    let raw = [];
    try {
      raw = await readdir(dirRemote);
    } catch (e) {
      throw new Error(`读取目录失败 ${dirRemote}: ${e.message}`);
    }
    const items = [];
    for (const ent of raw || []) {
      const name = ent.filename;
      if (name === '.' || name === '..') continue;
      const childRemote = joinRemotePath(dirRemote, name);
      let isDir = false;
      let mtime = 0;
      try {
        const st = await lstat(childRemote);
        isDir = !!(st.isDirectory && st.isDirectory());
        mtime = normalizeMtime(st.mtime);
      } catch (e) {
        isDir = false;
      }
      items.push({ name, remotePath: childRemote, isDir, mtime });
    }
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const it of items) {
      const zipPath = dirZip ? `${dirZip}/${it.name}` : it.name;
      result.push({ zipPath, remotePath: it.remotePath, isDir: it.isDir, mtime: it.mtime });
      scanned++;
      if (scanned % 50 === 0) onProgress({ phase: 'listing', scanned });
      if (it.isDir) {
        await walk(it.remotePath, zipPath, depth + 1);
      }
    }
  }

  await walk(remotePath, rootZip, 0);
  onProgress({ phase: 'listing', scanned });
  return result;
}

function zipWriteFileEntry(sftp, ws, remotePath, zipPath, mtimeMs) {
  return new Promise((resolve, reject) => {
    ws.write(zipBuildLocalHeader(zipPath, false, mtimeMs));

    const rs = sftp.createReadStream(remotePath);
    const deflater = zlib.createDeflateRaw({ level: 6 });
    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    let settled = false;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { rs.destroy(); } catch (e) {}
        try { deflater.destroy(); } catch (e) {}
        reject(err);
      } else {
        resolve({ crc: crc >>> 0, compressedSize: compressedSize >>> 0, uncompressedSize: uncompressedSize >>> 0 });
      }
    };

    rs.on('error', settle);
    deflater.on('error', settle);
    ws.on('error', settle);
    rs.on('data', (chunk) => {
      uncompressedSize += chunk.length;
      crc = zlib.crc32(chunk, crc);
    });
    deflater.on('data', (chunk) => { compressedSize += chunk.length; });
    deflater.on('end', () => {
      const dd = Buffer.alloc(16);
      zipWriteU32(dd, 0, ZIP_DD_SIG);
      zipWriteU32(dd, 4, crc >>> 0);
      zipWriteU32(dd, 8, compressedSize >>> 0);
      zipWriteU32(dd, 12, uncompressedSize >>> 0);
      ws.write(dd);
      settle(null);
    });
    rs.pipe(deflater).pipe(ws, { end: false });
  });
}

function friendlyZipDownloadError(err, remotePath) {
  const msg = (err && err.message) || String(err);
  const lower = String(msg).toLowerCase();
  const name = String(remotePath).split('/').filter(Boolean).pop() || remotePath;
  if (lower.includes('eacces') || lower.includes('permission denied')) {
    return `没有权限读取 ${name}`;
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return `文件不存在或已被删除: ${name}`;
  }
  if (lower.includes('enospc') || lower.includes('no space left')) {
    return '本地磁盘空间不足，无法完成打包';
  }
  if (lower.includes('eisdir')) {
    return `无法读取目录内容: ${name}`;
  }
  return `打包下载失败: ${msg}`;
}

async function sftpDownloadFolder(sftp, remotePath, localZipPath, onProgress) {
  if (!remotePath || !localZipPath) {
    throw new Error('参数不完整: 缺少远端或本地路径');
  }
  const rootName = String(remotePath).split('/').filter(Boolean).pop() || 'folder';

  let children;
  try {
    children = await sftpListRecursive(sftp, remotePath, { onProgress, rootZip: rootName });
  } catch (e) {
    throw new Error(friendlyZipDownloadError(e, remotePath));
  }
  const entries = [{ zipPath: rootName, remotePath, isDir: true, mtime: Date.now() }].concat(children);
  const fileCount = entries.reduce((n, x) => n + (x.isDir ? 0 : 1), 0);

  try { fs.mkdirSync(path.dirname(localZipPath), { recursive: true }); } catch (e) {}

  const ws = fs.createWriteStream(localZipPath);
  const centralChunks = [];
  let offset = 0;
  let doneFiles = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let currentRemote = remotePath;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch (e) {}
      fs.unlink(localZipPath, () => {});
      reject(new Error(friendlyZipDownloadError(err, currentRemote)));
    };

    ws.on('error', fail);
    ws.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true });
    });

    (async () => {
      try {
        for (const entry of entries) {
          currentRemote = entry.remotePath;
          const localOffset = offset;
          if (entry.isDir) {
            const dirPath = entry.zipPath.endsWith('/') ? entry.zipPath : entry.zipPath + '/';
            const localHeader = zipBuildLocalHeader(dirPath, true, entry.mtime);
            ws.write(localHeader);
            offset += localHeader.length;
            centralChunks.push(zipBuildCentralEntry(dirPath, true, entry.mtime, 0, 0, 0, localOffset));
          } else {
            const result = await zipWriteFileEntry(sftp, ws, entry.remotePath, entry.zipPath, entry.mtime);
            offset += 30 + Buffer.byteLength(entry.zipPath, 'utf8') + 16 + result.compressedSize;
            centralChunks.push(zipBuildCentralEntry(
              entry.zipPath, false, entry.mtime,
              result.crc, result.compressedSize, result.uncompressedSize, localOffset
            ));
            doneFiles++;
            if (onProgress) {
              onProgress({ phase: 'packing', done: doneFiles, total: fileCount, currentName: entry.zipPath });
            }
          }
        }
        const centralBuf = Buffer.concat(centralChunks);
        const centralOffset = offset;
        ws.write(centralBuf);
        ws.write(zipBuildEocd(centralBuf.length, centralOffset, centralChunks.length));
        ws.end();
      } catch (e) {
        fail(e);
      }
    })();
  });
}

// ===== 独立 ZIP 解析器 (校验用, 不依赖系统 unzip) =====
function readZipCentralDirectory(filePath) {
  const buf = fs.readFileSync(filePath);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('EOCD not found');
  const entryCount = buf.readUInt16LE(eocdPos + 10);
  const centralOffset = buf.readUInt32LE(eocdPos + 16);
  const entries = [];
  let pos = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) throw new Error('bad central sig at ' + pos);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, crc, compSize, uncompSize, externalAttrs, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 按 central directory 记录的 local offset 定位并解压单条文件内容
function extractZipEntry(filePath, entry) {
  const buf = fs.readFileSync(filePath);
  const pos = entry.localOffset;
  if (buf.readUInt32LE(pos) !== ZIP_LOCAL_SIG) throw new Error('bad local sig at ' + pos);
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const dataStart = pos + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + entry.compSize);
  return entry.method === ZIP_METHOD_DEFLATE ? zlib.inflateRawSync(comp) : comp;
}

// ===== 测试基础设施 =====
const TEST_ROOT = '/tmp/nimbus-dld';
const TEST_EMPTY = '/tmp/nimbus-dld-empty';
const LOCAL_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-dld-'));
const LOCAL_ZIP = path.join(LOCAL_TMP, 'nimbus-dld.zip');
const LOCAL_EMPTY_ZIP = path.join(LOCAL_TMP, 'empty.zip');

// 确定性伪随机 5MB (低压缩比, 验证流式 deflate 真实往返)
function makePseudoRandomBuf(size, seed) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

const BIG_SIZE = 5 * 1024 * 1024;
const BIG_SEED = 0x12345678;
const BIG_BUF = makePseudoRandomBuf(BIG_SIZE, BIG_SEED);
const BIG_CRC = zlib.crc32(BIG_BUF) >>> 0;
const BIG_LOCAL = path.join(LOCAL_TMP, 'big.bin');
fs.writeFileSync(BIG_LOCAL, BIG_BUF);

const SMALL_LOCAL = path.join(LOCAL_TMP, 'a.txt');
fs.writeFileSync(SMALL_LOCAL, 'AAAA_CONTENT_2026\n' + 'z'.repeat(2048), 'utf8');

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
  log(`SFTP 文件夹打包下载测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  log('============================================');
  process.exit(code);
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

// 与 main.js 一致的递归删除 (清理用)
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
  try { entries = await readdir(remotePath); } catch (e) {}
  for (const ent of entries) {
    if (ent.filename === '.' || ent.filename === '..') continue;
    const childPath = joinRemotePath(remotePath, ent.filename);
    let childIsDir = false;
    try {
      const st = await lstat(childPath);
      childIsDir = !!(st.isDirectory && st.isDirectory());
    } catch (e) { childIsDir = false; }
    await sftpRemove(sftp, childPath, childIsDir, depth + 1);
  }
  await rmdir(remotePath);
}

// 幂等清理: 删除可能残留的测试目录 (上次异常中断后重跑不报错)
async function cleanupTestDirs(sftp) {
  const stat = promisify(sftp.stat).bind(sftp);
  for (const p of [TEST_ROOT, TEST_EMPTY]) {
    try {
      const st = await stat(p);
      if (st && st.isDirectory && st.isDirectory()) {
        await sftpRemove(sftp, p, true, 0);
      }
    } catch (e) { /* 不存在则跳过 */ }
  }
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
    log('✅ SFTP 通道打开成功, 开始执行文件夹打包下载测试...\n');

    (async () => {
      try {
        // 幂等清理残留目录 (上次异常中断后可重跑)
        await cleanupTestDirs(sftp);

        // ---- 准备测试目录树 ----
        const subDir = joinRemotePath(TEST_ROOT, 'sub');
        const deepDir = joinRemotePath(subDir, 'deep');
        const innerFile = joinRemotePath(subDir, 'inner.txt');
        await promisify(sftp.mkdir).bind(sftp)(TEST_ROOT);
        await promisify(sftp.mkdir).bind(sftp)(subDir);
        await promisify(sftp.mkdir).bind(sftp)(deepDir);     // 空子目录
        await promisify(sftp.mkdir).bind(sftp)(joinRemotePath(TEST_ROOT, 'empty')); // 空目录
        await streamTransfer(
          fs.createReadStream(SMALL_LOCAL),
          sftp.createWriteStream(joinRemotePath(TEST_ROOT, 'a.txt'))
        );
        await streamTransfer(
          fs.createReadStream(BIG_LOCAL),
          sftp.createWriteStream(joinRemotePath(TEST_ROOT, 'big.bin'))
        );
        await streamTransfer(
          fs.createReadStream(SMALL_LOCAL),
          sftp.createWriteStream(innerFile)
        );
        log('  测试目录树已创建 (sub/deep 空目录 + empty 空目录 + a.txt + big.bin 5MB + sub/inner.txt)\n');

        // ---- 1. 常规打包下载 ----
        const progress = [];
        const onProgress = (info) => progress.push(info);
        const dl = await sftpDownloadFolder(sftp, TEST_ROOT, LOCAL_ZIP, onProgress);
        check('sftpDownloadFolder 返回 ok', dl.ok, dl.error || '');
        check('本地 zip 文件存在且非空', fs.existsSync(LOCAL_ZIP) && fs.statSync(LOCAL_ZIP).size > 0,
          `大小 ${fs.statSync(LOCAL_ZIP).size} 字节`);

        // ---- 2. 目录层级 (central directory 条目) ----
        const entries = readZipCentralDirectory(LOCAL_ZIP);
        const names = entries.map((x) => x.name);
        const expected = [
          'nimbus-dld/',
          'nimbus-dld/a.txt',
          'nimbus-dld/big.bin',
          'nimbus-dld/empty/',
          'nimbus-dld/sub/',
          'nimbus-dld/sub/deep/',
          'nimbus-dld/sub/inner.txt',
        ];
        check('zip 条目数 = 文件数 + 目录数(含空目录)', entries.length === expected.length,
          `${entries.length} 条`);
        check('zip 目录层级完整 (含空子目录)', expected.every((n) => names.includes(n)),
          expected.join(', '));
        check('目录条目以 / 结尾', entries.filter((e) => e.externalAttrs & 0x10).every((e) => e.name.endsWith('/')));
        check('目录条目含 DOS 目录属性位', entries.filter((e) => e.name.endsWith('/')).every((e) => (e.externalAttrs & 0x10) !== 0));

        // ---- 3. 内容完整性 (解压对比) ----
        const aEntry = entries.find((e) => e.name === 'nimbus-dld/a.txt');
        const innerEntry = entries.find((e) => e.name === 'nimbus-dld/sub/inner.txt');
        const bigEntry = entries.find((e) => e.name === 'nimbus-dld/big.bin');
        const aContent = extractZipEntry(LOCAL_ZIP, aEntry);
        const innerContent = extractZipEntry(LOCAL_ZIP, innerEntry);
        check('a.txt 内容一致', aContent.equals(fs.readFileSync(SMALL_LOCAL)));
        check('sub/inner.txt 内容一致', innerContent.equals(fs.readFileSync(SMALL_LOCAL)));
        check('big.bin (5MB) 解压后长度一致', bigEntry.uncompSize === BIG_SIZE && extractZipEntry(LOCAL_ZIP, bigEntry).length === BIG_SIZE);
        check('big.bin (5MB) CRC32 一致', (bigEntry.crc >>> 0) === BIG_CRC,
          `crc=${(bigEntry.crc >>> 0).toString(16)}`);
        check('big.bin (5MB) 解压内容一致', extractZipEntry(LOCAL_ZIP, bigEntry).equals(BIG_BUF));
        check('big.bin 采用 deflate 压缩 (method=8)', bigEntry.method === ZIP_METHOD_DEFLATE);

        // ---- 4. 进度回调 ----
        const hasListing = progress.some((p) => p.phase === 'listing' && typeof p.scanned === 'number');
        const packing = progress.filter((p) => p.phase === 'packing');
        const lastPacking = packing[packing.length - 1];
        check('进度回调含 listing 阶段', hasListing);
        check('进度回调含 packing 阶段且 done==total', packing.length > 0 && lastPacking.done === lastPacking.total,
          lastPacking ? `done=${lastPacking.done} total=${lastPacking.total}` : '无 packing 事件');
        check('packing 进度携带 currentName', lastPacking && typeof lastPacking.currentName === 'string' && lastPacking.currentName.length > 0);

        // ---- 5. 空文件夹单独测试 ----
        await promisify(sftp.mkdir).bind(sftp)(TEST_EMPTY);
        const emptyDl = await sftpDownloadFolder(sftp, TEST_EMPTY, LOCAL_EMPTY_ZIP);
        const emptyEntries = readZipCentralDirectory(LOCAL_EMPTY_ZIP);
        check('空文件夹打包成功', emptyDl.ok);
        check('空文件夹 zip 仅含根目录条目', emptyEntries.length === 1 && emptyEntries[0].name === 'nimbus-dld-empty/',
          emptyEntries.map((e) => e.name).join(',') || '(空)');

        // ---- 6. 错误映射: 不存在的目录 ----
        let missingErr = '';
        try {
          await sftpDownloadFolder(sftp, '/tmp/nimbus-dld-not-exist', path.join(LOCAL_TMP, 'missing.zip'));
        } catch (e) {
          missingErr = e.message;
        }
        check('不存在的目录报错清晰 (文件不存在/已删除)', missingErr.includes('文件不存在或已被删除'),
          missingErr);
        check('失败后未残留本地半成品 zip', !fs.existsSync(path.join(LOCAL_TMP, 'missing.zip')));

        // ---- 清理远端 ----
        await sftpRemove(sftp, TEST_ROOT, true, 0);
        await sftpRemove(sftp, TEST_EMPTY, true, 0);
        let cleaned = false;
        try { await promisify(sftp.stat).bind(sftp)(TEST_ROOT); } catch (e) { cleaned = true; }
        check('远端测试目录已清理', cleaned);

        log('\n> 全部文件夹打包下载用例执行完毕');
      } catch (e) {
        failCount++;
        log('❌ 执行异常: ' + (e && e.message));
        try { sftpRemove(sftp, TEST_ROOT, true, 0); } catch (e2) {}
        try { sftpRemove(sftp, TEST_EMPTY, true, 0); } catch (e2) {}
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

log(`启动 SFTP 文件夹打包下载测试 → ssh://${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`);
conn.connect(CONFIG);

setTimeout(() => {
  log('⚠️ 整体超时 (60s)');
  try { conn.end(); } catch (e) {}
  finish(1);
}, 60000);
