/**
 * QA 补充验证: 断线自动重连 + 断点续传 (独立验证, 不改 src/)
 * ============================================================
 * 运行: node tests/qa-supplemental-reconnect-resume.js
 *
 * 重连场景 (module 级, mock 定时器):
 *   R1. 连接成功 -> 模拟 error 断开 -> 触发重连 (退避 1s) -> 模拟成功 -> 计数重置
 *   R2. 连续失败 5 次 -> 放弃 (reconnect.failed 审计恰 5 条, 无后续定时器)
 *   R3. 重连等待中手动关闭 (cancel) -> 定时器取消, 无后续 attempt
 *   R4. 静态: PTY exit 0 (正常退出) 不重连 (main.js stream close 分支)
 *   R5. 静态: everConnected=false (首次连接失败) 不重连
 *   R6. 静态: cleanupAllSessions 逐个 cancel 重连定时器 (退出路径无残留)
 *
 * 续传场景 (module 级, mock sftp + 真实 fs 临时目录):
 *   S1. 下载中断保留 .part -> 重试从 offset 续传 -> 完成后 rename, 无 .part 残留
 *   S2. .part size == remote -> 直接改名 (不建读流)
 *   S3. 上传中断 (远端半成品) -> 重试以远端 stat 为基准续传, offset 正确, 最终内容一致
 *   S4. 远端已完整 -> 全量覆盖 (offset 0, 非追加)
 *   S5. 进度 % 计算: 渲染层 pct = min(100, round(done/total*100)), 续传时 done 含 offset
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');

const { createReconnectRunner } = require('../src/reconnect');
const {
  downloadPartPath,
  downloadFileResumable,
  uploadFileResumable,
  resolveUploadResume,
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

function makeMockTimers() {
  const timers = [];
  let seq = 0;
  return {
    setTimeoutFn: (cb, delay) => { const id = ++seq; timers.push({ id, delay, cb, cleared: false }); return id; },
    clearTimeoutFn: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    _timers: timers,
    _pending() { return timers.filter((t) => !t.cleared); },
    _fireNext() {
      const t = this._pending()[0];
      if (!t) return null;
      const delay = t.delay;
      t.cleared = true;
      t.cb();
      return delay;
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeConnectSeq(sequence) {
  const calls = [];
  const fn = async ({ attempt }) => {
    calls.push(attempt);
    const b = sequence[Math.min(calls.length - 1, sequence.length - 1)];
    return typeof b === 'function' ? b({ attempt }) : b;
  };
  fn._calls = calls;
  return fn;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rr-'));
}
function makeContent(size, seed) {
  const buf = Buffer.alloc(size);
  let s = seed || 42;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = s & 0xff;
  }
  return buf;
}

// 有状态 mock sftp: 仅第一次下载流发 prefix (分片异步) 后 error, 之后正常
// (shared.interrupted 跨实例共享, 保证「中断 -> 重试」流程中重试不被再次中断)
function makeInterruptThenOkDownloadSftp(remoteFile, prefixLen, shared) {
  const st = shared || { interrupted: false };
  const prefix = fs.readFileSync(remoteFile).slice(0, prefixLen);
  return {
    createReadStream(remotePath, opts) {
      if (!st.interrupted) {
        st.interrupted = true;
        // 分 4 片异步发出 (真实定时器间隔), 给本地 fs 写流充足 flush 时间, 再模拟网络中断
        const rs = new Readable({
          read() {
            if (!this._started) {
              this._started = true;
              const parts = 4;
              for (let i = 0; i < parts; i++) {
                (function (self, idx) {
                  const slice = prefix.slice(Math.floor(prefixLen * idx / parts), Math.floor(prefixLen * (idx + 1) / parts));
                  setTimeout(() => { if (!self._errored) self.push(slice); }, 2 + idx * 4);
                })(this, i);
              }
              setTimeout(() => {
                if (!this._errored) { this._errored = true; this.emit('error', new Error('simulated network drop')); }
              }, 30);
              return;
            }
            if (this._errored) this.push(null);
          },
        });
        return rs;
      }
      return fs.createReadStream(remoteFile, opts || {});
    },
    createWriteStream() { throw new Error('download 不通过 sftp.createWriteStream 写本地'); },
    stat(remotePath, cb) { fs.stat(remoteFile, (err, st) => cb(err, st ? { size: st.size } : null)); },
  };
}

// 有状态 mock sftp: 仅第一次上传写流写入 N 个 chunk 后 error, 之后正常追加
// (shared.interrupted 跨实例共享, 保证重试不被再次中断)
function makeInterruptThenOkUploadSftp(remoteFile, failAfterChunks, shared) {
  const st = shared || { interrupted: false };
  return {
    createReadStream() { throw new Error('not used'); },
    createWriteStream(remotePath, opts) {
      const flags = (opts && opts.flags) || 'w';
      if (!st.interrupted) {
        st.interrupted = true;
        let count = 0;
        const ws = new Writable({
          write(chunk, enc, cb) {
            count++;
            fs.appendFileSync(remoteFile, chunk);
            if (count >= failAfterChunks) { cb(new Error('simulated interruption')); return; }
            cb();
          },
        });
        return ws;
      }
      return fs.createWriteStream(remoteFile, { flags });
    },
    stat(remotePath, cb) { fs.stat(remoteFile, (err, st2) => cb(err, st2 ? { size: st2.size } : null)); },
  };
}

async function run() {
  // ================= 重连 =================
  await test('R1 触发重连(退避1s)->成功->计数重置: 失败后第1次尝试延迟 1s, 成功后 attempt 归零', async () => {
    const timers = makeMockTimers();
    const audit = [];
    const connectFn = makeConnectSeq([{ ok: false, error: 'net' }, { ok: true }]);
    const runner = createReconnectRunner({
      maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 32000,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      connectFn,
      onAudit: (e) => audit.push(e),
    });
    // 连接已建立 (模拟 everConnected 后意外断开), 现在启动重连
    runner.start();
    await flush();
    const d1 = timers._fireNext(); // attempt 1 fail
    assert.strictEqual(d1, 1000, '首次重连尝试应在断开后 1s');
    await flush();
    assert.strictEqual(connectFn._calls.length, 1);
    timers._fireNext(); // attempt 2 -> success
    await flush();
    assert.strictEqual(runner.getAttempt(), 0, '成功后退避计数应重置');
    assert.strictEqual(runner.isActive(), false);
    assert.ok(audit.some((e) => e.type === 'reconnect.success'), '应有 success 审计');
  });

  await test('R2 连续失败 5 次 -> 放弃: reconnect.failed 审计恰 5 条, 无后续定时器', async () => {
    const timers = makeMockTimers();
    const audit = [];
    const states = [];
    const connectFn = makeConnectSeq([{ ok: false, error: 'x' }]);
    const runner = createReconnectRunner({
      maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 32000,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      connectFn,
      onAudit: (e) => audit.push(e),
      onState: (s) => states.push(s),
    });
    runner.start();
    await flush();
    for (let i = 0; i < 5; i++) {
      const d = timers._fireNext();
      assert.ok(d > 0, `第 ${i + 1} 次尝试应被调度`);
      await flush();
    }
    assert.strictEqual(connectFn._calls.length, 5, '恰好尝试 5 次');
    const failedAudits = audit.filter((e) => e.type === 'reconnect.failed');
    assert.strictEqual(failedAudits.length, 5, 'reconnect.failed 审计应恰 5 条');
    assert.ok(failedAudits.every((e) => /第 \d+\/5 次重连失败/.test(e.detail)), '失败审计含第 N/5 次');
    assert.strictEqual(timers._pending().length, 0, '放弃后不应有残留定时器');
    assert.ok(states.some((s) => s.status === 'gaveup' && s.attempt === 5), '应有 gaveup (attempt=5)');
    assert.strictEqual(runner.isActive(), false);
  });

  await test('R3 重连等待中手动关闭 (cancel) -> 定时器取消, 无后续 attempt', async () => {
    const timers = makeMockTimers();
    const connectFn = makeConnectSeq([{ ok: false, error: 'x' }]);
    const runner = createReconnectRunner({
      maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 32000,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
      connectFn,
    });
    runner.start();
    await flush();
    timers._fireNext(); await flush(); // attempt 1 fail -> 等待退避
    assert.strictEqual(connectFn._calls.length, 1);
    assert.strictEqual(timers._pending().length, 1, '等待退避期间应有 1 个定时器');
    runner.cancel(); // 重连期间用户关闭会话
    await flush();
    assert.strictEqual(timers._pending().length, 0, '取消后定时器应清除');
    assert.strictEqual(connectFn._calls.length, 1, '取消后不应再发起尝试');
    assert.strictEqual(runner.isActive(), false);
  });

  // ---------- 静态断言 (main.js 语义) ----------
  await test('R4 静态: PTY exit 0 (正常退出) 不重连; 仅 conn error/close 触发重连', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    // stream close 处理器: sessionEnded (code 为数字 / signal 非空) -> cleanupSession, 不进入 handleUnexpectedClose
    const m = mainSrc.match(/stream\.on\('close', \(code, signal\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, '应存在 stream close 处理器');
    assert.ok(/sessionEnded/.test(m[1]), '应区分 sessionEnded');
    assert.ok(/cleanupSession\(winId, sessionId, session\)/.test(m[1]), 'exit 正常结束应 cleanupSession');
    assert.ok(!/handleUnexpectedClose/.test(m[1]), 'exit 正常结束不应触发重连入口');
    // conn error / conn close -> handleUnexpectedClose
    const errorHandler = mainSrc.match(/conn\.on\('error', \(err\) => \{([\s\S]*?)handleUnexpectedClose\(winId, sessionId, session, config, conn, err\);/s);
    assert.ok(errorHandler, 'conn error 应进入 handleUnexpectedClose');
  });

  await test('R5 静态: everConnected=false (首次连接失败) 不重连, 走清理路径', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const idx = mainSrc.indexOf('function handleUnexpectedClose');
    const fn = mainSrc.slice(idx, idx + 1400);
    assert.ok(/!canReconnect\(session\) \|\| !session\.everConnected/.test(fn), '应含 everConnected 守卫');
    assert.ok(/cleanupSession\(winId, sessionId, session\)/.test(fn), '不满足守卫时应清理会话');
    // createReconnectRunner 仅在守卫之后 (重连分支) 创建
    assert.ok(fn.indexOf('createReconnectRunner') > fn.indexOf('everConnected'), '重连控制器应在守卫之后创建');
  });

  await test('R6 静态: cleanupAllSessions 逐个 cancel 重连定时器 (退出路径无残留)', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const idx = mainSrc.indexOf('function cleanupAllSessions');
    const fn = mainSrc.slice(idx, idx + 1600);
    assert.ok(/reconnectRunner\.cancel\(\)/.test(fn), 'cleanupAllSessions 应取消每个会话的重连定时器');
    assert.ok(/sessions\.clear\(\)/.test(fn), '清理后应清空会话表');
    // 手动断开入口同样取消
    const discIdx = mainSrc.indexOf("ipcMain.handle('ssh:disconnect'");
    assert.ok(mainSrc.slice(discIdx, discIdx + 1200).includes('reconnectRunner.cancel'), 'ssh:disconnect 应取消重连');
  });

  // ================= 续传 =================
  await test('S1 下载中断保留 .part -> 重试从 offset 续传 -> rename 完成, 无 .part 残留', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'remote.bin');
    const content = makeContent(100 * 1024, 11);
    fs.writeFileSync(remoteFile, content);
    const localPath = path.join(dir, 'dl.bin');
    const partPath = downloadPartPath(localPath);

    // 第 1 次: 中断 (发 20KB 后 error); 共享状态保证重试不再次中断
    const shared = { interrupted: false };
    const sftp = makeInterruptThenOkDownloadSftp(remoteFile, 20 * 1024, shared);
    const r1 = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });
    assert.strictEqual(r1.ok, false, '第 1 次应中断失败');
    assert.ok(fs.existsSync(partPath), '中断后应保留 .part');
    assert.ok(!fs.existsSync(localPath), '中断后不应生成目标文件');
    const partSize1 = fs.statSync(partPath).size;
    assert.ok(partSize1 > 0, '.part 应保留已写入字节 (实际 ' + partSize1 + ')');

    // 第 2 次: 重试 -> 检测 .part -> 从 offset 续传 -> 完成 rename
    const r2 = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });
    assert.strictEqual(r2.ok, true, '第 2 次应成功');
    assert.strictEqual(r2.resumed, true, '应识别为续传');
    assert.strictEqual(r2.offset, partSize1, '续传起点应为 .part 实际大小');
    assert.ok(fs.existsSync(localPath), '完成后应生成目标文件');
    assert.ok(!fs.existsSync(partPath), '完成后不应有 .part 残留');
    assert.deepStrictEqual(fs.readFileSync(localPath), content, '最终内容应与远端一致');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('S2 .part size == remote -> 直接改名, 不创建读流', async () => {
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'r.bin');
    const content = makeContent(8 * 1024, 12);
    fs.writeFileSync(remoteFile, content);
    const localPath = path.join(dir, 'dl.bin');
    fs.writeFileSync(downloadPartPath(localPath), content);
    let reads = 0;
    const sftp = {
      createReadStream() { reads++; throw new Error('不应创建读流'); },
      createWriteStream() { throw new Error('不应创建写流'); },
      stat(p, cb) { fs.stat(remoteFile, (e, st) => cb(e, st ? { size: st.size } : null)); },
    };
    const res = await downloadFileResumable({ sftp, fs, remotePath: '/r', localPath, remoteSize: content.length });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true);
    assert.strictEqual(reads, 0, '完整 .part 不应创建读流');
    assert.ok(fs.existsSync(localPath) && !fs.existsSync(downloadPartPath(localPath)), '改名完成');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('S3 上传中断 (远端半成品) -> 重试以远端 stat 为基准续传, offset 正确, 内容一致', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(300 * 1024, 13);
    fs.writeFileSync(localFile, content);
    const remoteFile = path.join(dir, 'remote.bin');

    // 第 1 次: 远端写入 2 个 chunk 后中断; 共享状态保证重试不再次中断
    const shared = { interrupted: false };
    const sftp1 = makeInterruptThenOkUploadSftp(remoteFile, 2, shared);
    const r1 = await uploadFileResumable({ sftp: sftp1, fs, localPath: localFile, remotePath: '/r' });
    assert.strictEqual(r1.ok, false, '第 1 次应中断失败');
    const partialSize = fs.statSync(remoteFile).size;
    assert.ok(partialSize > 0 && partialSize < content.length, '远端应保留半成品且未完成');

    // 第 2 次: 以远端 stat 为基准续传 (同一共享状态 -> 不再中断)
    const sftp2 = makeInterruptThenOkUploadSftp(remoteFile, 2, shared);
    const r2 = await uploadFileResumable({ sftp: sftp2, fs, localPath: localFile, remotePath: '/r' });
    assert.strictEqual(r2.ok, true, '第 2 次应成功');
    assert.strictEqual(r2.resumed, true);
    assert.strictEqual(r2.offset, partialSize, '续传起点应为远端已传大小');
    assert.deepStrictEqual(fs.readFileSync(remoteFile), content, '续传后远端应与本地一致');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('S4 远端已完整 (size >= localSize) -> 全量覆盖 (offset 0, 非追加)', async () => {
    const dir = makeTmpDir();
    const localFile = path.join(dir, 'local.bin');
    const content = makeContent(10 * 1024, 14);
    fs.writeFileSync(localFile, content);
    const remoteFile = path.join(dir, 'remote.bin');
    fs.writeFileSync(remoteFile, content);
    const writes = [];
    const sftp = {
      createReadStream() { throw new Error('not used'); },
      createWriteStream(remotePath, opts) {
        writes.push(opts || {});
        return fs.createWriteStream(remoteFile, { flags: (opts && opts.flags) || 'w' });
      },
      stat(p, cb) { fs.stat(remoteFile, (e, st) => cb(e, st ? { size: st.size } : null)); },
    };
    const res = await uploadFileResumable({ sftp, fs, localPath: localFile, remotePath: '/r' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, false, '远端已完整不应续传');
    assert.strictEqual(res.offset, 0);
    assert.ok(writes.length === 1 && writes[0].flags !== 'a', '全量覆盖不应使用追加写');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('S5 进度%计算: 渲染层 pct=min(100,round(done/total*100)); 续传 done 含 offset', async () => {
    // 渲染层逻辑 (src/renderer.js showSftpProgress)
    const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
    assert.ok(/const pct = Math\.min\(100, Math\.round\(\(done \/ total\) \* 100\)\);/.test(rendererSrc), '渲染层应含进度百分比公式');
    // 模块层: 续传场景 done 从 offset 起算 (含已续传字节), total = 文件总大小
    const dir = makeTmpDir();
    const remoteFile = path.join(dir, 'r.bin');
    const content = makeContent(64 * 1024, 15);
    fs.writeFileSync(remoteFile, content);
    const localPath = path.join(dir, 'dl.bin');
    fs.writeFileSync(downloadPartPath(localPath), content.slice(0, 16 * 1024)); // 已下载 16KB
    const progress = [];
    const sftp = {
      createReadStream(p, opts) { return fs.createReadStream(remoteFile, opts || {}); },
      createWriteStream(p, opts) { return fs.createWriteStream(downloadPartPath(localPath), opts || {}); },
      stat(p, cb) { fs.stat(remoteFile, (e, st) => cb(e, st ? { size: st.size } : null)); },
    };
    await downloadFileResumable({
      sftp, fs, remotePath: '/r', localPath, remoteSize: content.length,
      onProgress: (info) => progress.push(info),
    });
    const last = progress[progress.length - 1];
    assert.strictEqual(last.total, content.length);
    assert.strictEqual(last.done, content.length, '最终 done 应为文件总大小 (含续传 offset)');
    const pct = Math.min(100, Math.round((last.done / last.total) * 100));
    assert.strictEqual(pct, 100, '完成后进度应为 100%');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\nQA 补充验证 (reconnect+resume): ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('QA 补充验证执行异常:', err);
  process.exit(1);
});
