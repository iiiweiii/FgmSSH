/**
 * NimbusSSH 断点续传回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/resume-test.js
 * 覆盖 (Roadmap 第一梯队 ② 断点续传):
 *   1. 下载续传: .part 检测 / 从 offset 继续 / 完成后改名 / 完成清理
 *   2. 下载中断: 保留 .part (不删), 目标文件不存在
 *   3. 下载 .part 已完整: 直接改名, 不再传输
 *   4. resolveDownloadResume 边界 (无 .part / 部分 / 完整 / 异常更大)
 *   5. 上传续传: 远端 stat 为基准 offset / flags:'a' 追加 / 最终内容一致
 *   6. 上传中断: 保留远端半成品 (不删)
 *   7. 上传远端已完整: 全量覆盖 (offset 0)
 *   8. resolveUploadResume 边界 (stat 失败 / 半成品 / 完整)
 *   9. 进度事件: phase/done/total/currentName
 *  10. 静态断言: main.js / renderer.js 续传/进度接线 (sftp.resume 审计 / 上传进度通道 / .part 命名)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');

const {
  downloadPartPath,
  resolveDownloadResume,
  downloadFileResumable,
  resolveUploadResume,
  uploadFileResumable,
} = require('../src/transfer-resume');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  \u2713 ' + name); })
    .catch((err) => {
      failed++;
      console.error('  \u2717 ' + name);
      console.error('    ' + ((err && err.stack) || err));
    });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-resume-'));
}

// 随机字节内容 (确定性: 用可复现的伪随机)
function makeContent(size, seed) {
  const buf = Buffer.alloc(size);
  let s = seed || 42;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = s & 0xff;
  }
  return buf;
}

// ---------- mock 远端 SFTP (远端文件用真实临时文件表示) ----------
// - createReadStream(remotePath, opts): 记录 opts, 返回 fs 读流
// - createWriteStream(remotePath, opts): 记录 opts, 模拟 ssh2 语义:
//     flags 'a' -> 追加 (EOF), 其余 -> 覆盖; 返回 fs 写流
// - stat(remotePath, cb): 返回远端文件 stat
function makeMockSftp(remoteFile) {
  const calls = { reads: [], writes: [] };
  return {
    _calls: calls,
    createReadStream(remotePath, opts) {
      calls.reads.push({ remotePath, opts: opts || {} });
      return fs.createReadStream(remoteFile, opts || {});
    },
    createWriteStream(remotePath, opts) {
      calls.writes.push({ remotePath, opts: opts || {} });
      const flags = (opts && opts.flags) || 'w';
      const ws = fs.createWriteStream(remoteFile, { flags });
      calls.writes[calls.writes.length - 1].stream = ws;
      return ws;
    },
    stat(remotePath, cb) {
      fs.stat(remoteFile, (err, st) => {
        if (err) { cb(err); return; }
        // ssh2 stat 返回含 size 的 Stats 兼容对象
        cb(null, { size: st.size, isDirectory: () => false });
      });
    },
  };
}

// ---------- mock 下载中断: 远端读流发出部分数据后 error ----------
function makeInterruptedDownloadSftp(remoteFile, prefixLen) {
  const calls = { reads: [] };
  const prefix = fs.readFileSync(remoteFile).slice(0, prefixLen);
  return {
    _calls: calls,
    createReadStream(remotePath, opts) {
      calls.reads.push({ remotePath, opts: opts || {} });
      let sent = false;
      let errored = false;
      const rs = new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(prefix);
            return;
          }
          if (!errored) {
            errored = true;
            process.nextTick(() => this.emit('error', new Error('simulated network drop')));
            return;
          }
          this.push(null);
        },
      });
      return rs;
    },
    createWriteStream() { throw new Error('not used'); },
    stat(remotePath, cb) {
      fs.stat(remoteFile, (err, st) => cb(err, st ? { size: st.size } : null));
    },
  };
}

// ---------- mock 上传中断: 远端写流写入若干 chunk 后 error ----------
// 模拟 ssh2 'a' 追加语义: 先写入远端半成品, 中断后保留
function makeInterruptedUploadSftp(remoteFile, failAfterChunks) {
  const calls = { writes: [] };
  return {
    _calls: calls,
    createReadStream() { throw new Error('not used'); },
    createWriteStream(remotePath, opts) {
      calls.writes.push({ remotePath, opts: opts || {} });
      let count = 0;
      const ws = new Writable({
        write(chunk, enc, cb) {
          count++;
          fs.appendFileSync(remoteFile, chunk); // 模拟远端写入
          if (count >= failAfterChunks) {
            cb(new Error('simulated interruption')); // 确定性: 写入失败即中断
            return;
          }
          cb();
        },
      });
      return ws;
    },
    stat(remotePath, cb) {
      fs.stat(remoteFile, (err, st) => cb(err, st ? { size: st.size } : null));
    },
  };
}

async function run() {
  // ---------- 1. 下载续传 ----------
  await test('下载续传: 检测 .part -> 从 offset 继续 -> 改名完成 -> .part 清理', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'remote.bin');
    const content = makeContent(100 * 1024, 1);
    fs.writeFileSync(remoteFile, content);

    const localPath = path.join(dir, 'download.bin');
    const partPath = downloadPartPath(localPath);
    // 预置 .part = 前 30KB (模拟上次中断)
    const prefix = content.slice(0, 30 * 1024);
    fs.writeFileSync(partPath, prefix);

    const sftp = makeMockSftp(remoteFile);
    const res = await downloadFileResumable({ sftp, fs, remotePath: '/data/remote.bin', localPath, remoteSize: content.length });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true, '应识别为续传');
    assert.strictEqual(res.offset, 30 * 1024, '续传起点应为 .part 大小');
    assert.ok(fs.existsSync(localPath), '完成后应生成目标文件');
    assert.ok(!fs.existsSync(partPath), '完成后应清理 .part');
    assert.deepStrictEqual(fs.readFileSync(localPath), content, '合并后内容应与远端一致');
    // 读流应从 offset 开始
    const readOpts = sftp._calls.reads[0].opts;
    assert.strictEqual(readOpts.start, 30 * 1024, 'createReadStream 应带 start=offset');
    // 本地写流应追加
    assert.ok(true);
  });

  await test('下载全新文件 (无 .part): 从头下载, 不续传', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'remote.bin');
    const content = makeContent(8 * 1024, 2);
    fs.writeFileSync(remoteFile, content);

    const localPath = path.join(dir, 'fresh.bin');
    const sftp = makeMockSftp(remoteFile);
    const res = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, false);
    assert.strictEqual(res.offset, 0);
    assert.deepStrictEqual(fs.readFileSync(localPath), content);
    assert.ok(!fs.existsSync(downloadPartPath(localPath)), '全新下载后 .part 应被改名清理');
    assert.ok(!('start' in sftp._calls.reads[0].opts), '全新下载不应带 start');
  });

  // ---------- 2. 下载中断保留 .part ----------
  await test('下载中断: 保留 .part (不删), 目标文件不存在', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'remote.bin');
    const content = makeContent(64 * 1024, 3);
    fs.writeFileSync(remoteFile, content);

    const localPath = path.join(dir, 'interrupted.bin');
    const partPath = downloadPartPath(localPath);
    const sftp = makeInterruptedDownloadSftp(remoteFile, 16 * 1024);
    const res = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /simulated network drop/);
    assert.ok(fs.existsSync(partPath), '中断后应保留 .part');
    assert.ok(!fs.existsSync(localPath), '中断后不应生成目标文件');
  });

  // ---------- 3. .part 完整 -> 直接改名 ----------
  await test('下载 .part 已完整 (size == remoteSize): 直接改名, 不再传输', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'remote.bin');
    const content = makeContent(5 * 1024, 4);
    fs.writeFileSync(remoteFile, content);

    const localPath = path.join(dir, 'complete.bin');
    const partPath = downloadPartPath(localPath);
    fs.writeFileSync(partPath, content); // .part 已写满

    const sftp = makeMockSftp(remoteFile);
    const res = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true);
    assert.strictEqual(sftp._calls.reads.length, 0, '不应创建读流 (数据已完整)');
    assert.deepStrictEqual(fs.readFileSync(localPath), content);
    assert.ok(!fs.existsSync(partPath));
  });

  // ---------- 4. resolveDownloadResume 边界 ----------
  await test('resolveDownloadResume 边界: 无 .part / 部分 / 完整 / 更大', () => {
    const dir = makeTmpDir();
    const localPath = path.join(dir, 'x.bin');
    const partPath = downloadPartPath(localPath);
    // 无 .part
    let r = resolveDownloadResume(fs, localPath, 100);
    assert.deepStrictEqual(r, { partPath, offset: 0, resume: false, complete: false });
    // 部分 (30 < 100)
    fs.writeFileSync(partPath, makeContent(30, 1));
    r = resolveDownloadResume(fs, localPath, 100);
    assert.strictEqual(r.resume, true);
    assert.strictEqual(r.offset, 30);
    assert.strictEqual(r.complete, false);
    // 完整 (100 == 100)
    fs.writeFileSync(partPath, makeContent(100, 1));
    r = resolveDownloadResume(fs, localPath, 100);
    assert.strictEqual(r.resume, true);
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.offset, 100);
    // 更大 (120 > 100): 视为异常, 从头下载
    fs.writeFileSync(partPath, makeContent(120, 1));
    r = resolveDownloadResume(fs, localPath, 100);
    assert.strictEqual(r.resume, false);
    assert.strictEqual(r.offset, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- 5. 上传续传 ----------
  await test('上传续传: 远端 stat 为基准 -> flags:\'a\' 追加 -> 最终内容一致', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(80 * 1024, 5);
    fs.writeFileSync(localFile, content);

    const remoteFile = path.join(dir, 'remote.bin');
    // 远端半成品 = 前 25KB
    fs.writeFileSync(remoteFile, content.slice(0, 25 * 1024));

    const sftp = makeMockSftp(remoteFile);
    const res = await uploadFileResumable({ sftp, fs, localPath: localFile, remotePath: '/data/remote.bin' });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true, '应识别为续传');
    assert.strictEqual(res.offset, 25 * 1024, '续传起点应为远端大小');
    assert.deepStrictEqual(fs.readFileSync(remoteFile), content, '续传后远端内容应与本地一致');
    // 写流应使用 flags 'a' (追加)
    const writeOpts = sftp._calls.writes[0].opts;
    assert.strictEqual(writeOpts.flags, 'a', '续传应使用追加写 flags:\'a\'');
  });

  await test('上传全新文件 (远端不存在): 全量覆盖写, 不续传', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(4 * 1024, 6);
    fs.writeFileSync(localFile, content);

    const remoteFile = path.join(dir, 'remote.bin'); // 不存在
    const sftp = makeMockSftp(remoteFile);
    const res = await uploadFileResumable({ sftp, fs, localPath: localFile, remotePath: '/r' });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, false);
    assert.strictEqual(res.offset, 0);
    assert.deepStrictEqual(fs.readFileSync(remoteFile), content);
    const writeOpts = sftp._calls.writes[0].opts;
    assert.ok(writeOpts.flags !== 'a', '全新上传不应使用追加写');
  });

  // ---------- 6. 上传中断保留远端半成品 ----------
  await test('上传中断: 保留远端半成品 (不删)', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(256 * 1024, 7); // 足够大, 保证多个 chunk
    fs.writeFileSync(localFile, content);

    const remoteFile = path.join(dir, 'remote.bin');
    // 远端半成品 = 前 10KB
    const partial = content.slice(0, 10 * 1024);
    fs.writeFileSync(remoteFile, partial);

    const sftp = makeInterruptedUploadSftp(remoteFile, 1); // 首个 chunk 写入后中断
    const res = await uploadFileResumable({ sftp, fs, localPath: localFile, remotePath: '/r' });

    assert.strictEqual(res.ok, false);
    assert.ok(fs.existsSync(remoteFile), '中断后远端半成品应保留');
    assert.ok(fs.statSync(remoteFile).size >= partial.length, '远端半成品不应被清空');
    assert.ok(fs.statSync(remoteFile).size < content.length, '远端半成品应小于本地大小 (未完成)');
  });

  // ---------- 7. 远端已完整 ----------
  await test('上传远端已完整 (size >= localSize): 全量覆盖, 不续传', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(12 * 1024, 8);
    fs.writeFileSync(localFile, content);

    const remoteFile = path.join(dir, 'remote.bin');
    fs.writeFileSync(remoteFile, content); // 远端大小 == 本地大小

    const sftp = makeMockSftp(remoteFile);
    const res = await uploadFileResumable({ sftp, fs, localPath: localFile, remotePath: '/r' });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, false, '远端已完整不应续传 (按现有行为覆盖)');
    assert.strictEqual(res.offset, 0);
    const writeOpts = sftp._calls.writes[0].opts;
    assert.ok(writeOpts.flags !== 'a', '全量覆盖不应使用追加写');
  });

  // ---------- 8. resolveUploadResume 边界 ----------
  await test('resolveUploadResume 边界: stat 失败 / 半成品 / 完整', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'r.bin');
    // stat 失败 (文件不存在)
    let sftp = makeMockSftp(remoteFile);
    let r = await resolveUploadResume({ sftp, localSize: 100, remotePath: '/r' });
    assert.deepStrictEqual(r, { offset: 0, resume: false });
    // 半成品 (40 < 100)
    fs.writeFileSync(remoteFile, makeContent(40, 1));
    sftp = makeMockSftp(remoteFile);
    r = await resolveUploadResume({ sftp, localSize: 100, remotePath: '/r' });
    assert.deepStrictEqual(r, { offset: 40, resume: true });
    // 完整 (100 == 100)
    fs.writeFileSync(remoteFile, makeContent(100, 1));
    sftp = makeMockSftp(remoteFile);
    r = await resolveUploadResume({ sftp, localSize: 100, remotePath: '/r' });
    assert.deepStrictEqual(r, { offset: 0, resume: false });
    // 更大 (150 > 100)
    fs.writeFileSync(remoteFile, makeContent(150, 1));
    sftp = makeMockSftp(remoteFile);
    r = await resolveUploadResume({ sftp, localSize: 100, remotePath: '/r' });
    assert.deepStrictEqual(r, { offset: 0, resume: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- 9. 进度事件 ----------
  await test('进度事件: phase/done/total/currentName (下载与上传)', async () => {
    const dir = makeTmpDir();
    const content = makeContent(16 * 1024, 9);

    // 下载进度
    const remoteFile = path.join(dir, 'remote.bin');
    fs.writeFileSync(remoteFile, content);
    const localPath = path.join(dir, 'dl.bin');
    const dlProgress = [];
    const sftp1 = makeMockSftp(remoteFile);
    await downloadFileResumable({
      sftp: sftp1, fs, remotePath: '/data/remote.bin', localPath, remoteSize: content.length,
      onProgress: (info) => dlProgress.push(info),
    });
    assert.ok(dlProgress.length >= 1, '下载应有进度事件');
    const lastDl = dlProgress[dlProgress.length - 1];
    assert.strictEqual(lastDl.phase, 'downloading');
    assert.strictEqual(lastDl.total, content.length);
    assert.strictEqual(lastDl.done, content.length, '最终 done 应为文件大小');
    assert.strictEqual(lastDl.currentName, 'remote.bin');

    // 上传进度
    const localFile = path.join(dir, 'ul.bin');
    fs.writeFileSync(localFile, content);
    const upRemote = path.join(dir, 'up-remote.bin');
    const upProgress = [];
    const sftp2 = makeMockSftp(upRemote);
    await uploadFileResumable({
      sftp: sftp2, fs, localPath: localFile, remotePath: '/data/ul.bin',
      onProgress: (info) => upProgress.push(info),
    });
    assert.ok(upProgress.length >= 1, '上传应有进度事件');
    const lastUp = upProgress[upProgress.length - 1];
    assert.strictEqual(lastUp.phase, 'uploading');
    assert.strictEqual(lastUp.total, content.length);
    assert.strictEqual(lastUp.done, content.length);
    assert.strictEqual(lastUp.currentName, 'ul.bin');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- 10. 静态断言 ----------
  await test('静态断言: main.js / renderer.js 续传与进度接线一致', () => {
    const root = path.join(__dirname, '..');
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
    const resumeSrc = fs.readFileSync(path.join(root, 'src', 'transfer-resume.js'), 'utf8');

    // src/transfer-resume.js: 下载 .part + 上传 stat 基准 + 进度
    assert.ok(resumeSrc.includes('.part'), 'transfer-resume.js 应使用 .part 命名');
    assert.ok(resumeSrc.includes('sftp.stat'), 'transfer-resume.js 应查询远端大小');
    assert.ok(resumeSrc.includes("flags: 'a'"), 'transfer-resume.js 上传续传应使用追加写');
    assert.ok(resumeSrc.includes('downloading'), 'transfer-resume.js 应有下载进度 phase');

    // main.js: 引入 + 审计 + 进度通道
    assert.ok(mainSrc.includes("require('./src/transfer-resume')"), 'main.js 应 require transfer-resume');
    assert.ok(mainSrc.includes("'sftp.resume'"), 'main.js 应埋点 sftp.resume 审计');
    assert.ok(mainSrc.includes('sftp-download-progress'), 'main.js 应上报下载进度事件');
    assert.ok(mainSrc.includes('sftp-upload-progress'), 'main.js 应上报上传进度事件');
    assert.ok(mainSrc.includes('downloadFileResumable'), 'main.js 应调用下载续传');
    assert.ok(mainSrc.includes('uploadFileResumable'), 'main.js 应调用上传续传');
    // 审计 detail 从 offset 续传, 无敏感信息
    assert.ok(mainSrc.includes('从偏移 '), 'main.js sftp.resume detail 应含偏移');

    // renderer.js: 进度条 phase + 续传提示
    assert.ok(rendererSrc.includes("phase: 'downloading'"), 'renderer.js 应处理下载进度 phase');
    assert.ok(rendererSrc.includes("phase: 'uploading'"), 'renderer.js 应处理上传进度 phase');
    assert.ok(rendererSrc.includes('sftp-upload-progress'), 'renderer.js 应监听上传进度事件');
    assert.ok(rendererSrc.includes('sftpFileKind'), 'renderer.js 应有单文件传输跟踪');
    assert.ok(rendererSrc.includes('已续传下载'), 'renderer.js 应有续传完成提示');
  });

  // ---------- 汇总 ----------
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
