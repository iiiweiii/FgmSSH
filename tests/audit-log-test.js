/**
 * NimbusSSH 操作日志模块回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/audit-log-test.js
 * 覆盖:
 *   1. logAudit 落盘格式 (JSON Lines, 字段齐全, 白名单)
 *   2. redact 脱敏 (密码/私钥/token 不落盘; 路径用户名段替换)
 *   3. queryAudit 筛选 (时间/类型/结果/用户/分页)
 *   4. 并发写入 (Promise.all 多次 append 不丢行不交错)
 *   5. _sanitize 白名单策略
 *   6. main.js/preload.js/renderer.js 埋点静态断言
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auditLog = require('../src/audit-log');

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

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'nimbus-audit-test-'));
}

// 读取目录下全部 jsonl 行 (按文件名排序)
function readLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const lines = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim()) lines.push(line.trim());
    }
  }
  return lines;
}

async function run() {
  // ---------- 1. 落盘格式 ----------
  await test('logAudit 落盘为 JSON Lines, 字段齐全 + 路径用户名段脱敏', async () => {
    const dir = makeTmpDir();
    auditLog.initAuditLog({ dir });
    auditLog.logAudit({ type: 'sftp.mkdir', target: '/root/data', result: 'success', user: 'root@10.0.0.1', session: 's1_x', detail: '新建文件夹' });
    await auditLog.flush();

    const lines = readLines(dir);
    assert.strictEqual(lines.length, 1, '应恰好 1 行');
    const obj = JSON.parse(lines[0]);
    assert.strictEqual(obj.type, 'sftp.mkdir');
    assert.strictEqual(obj.result, 'success');
    // 用户名为 root -> 路径 /root/data 中 root 段被替换
    assert.strictEqual(obj.target, '/[REDACTED]/data');
    assert.strictEqual(obj.user, 'root@10.0.0.1');
    assert.strictEqual(obj.session, 's1_x');
    assert.strictEqual(obj.level, 'INFO');
    assert.ok(obj.ts && !isNaN(Date.parse(obj.ts)), 'ts 应为 ISO 8601');
    assert.ok(!('password' in obj), '不得出现白名单外字段');
  });

  // ---------- 2. 脱敏 ----------
  await test('redact: 密码/私钥/token 不落盘', async () => {
    const dir = makeTmpDir();
    auditLog.initAuditLog({ dir });
    auditLog.logAudit({
      type: 'connect',
      target: '1.2.3.4:22',
      result: 'failure',
      user: 'root@1.2.3.4',
      session: 's2',
      detail: '认证失败 password=MySecret123 token=abc123xyz api_key=KEY123',
    });
    auditLog.logAudit({
      type: 'connect',
      target: '1.2.3.4:22',
      result: 'failure',
      user: 'root@1.2.3.4',
      session: 's2b',
      detail: '私钥: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdEFGH1234...\n-----END RSA PRIVATE KEY-----',
    });
    await auditLog.flush();

    const text = readLines(dir).join('\n');
    assert.ok(!text.includes('MySecret123'), '密码不应落盘');
    assert.ok(!text.includes('abc123xyz'), 'token 不应落盘');
    assert.ok(!text.includes('KEY123'), 'api_key 不应落盘');
    assert.ok(!text.includes('MIIEowIBAAKCAQEA'), '私钥内容不应落盘');
    assert.ok(text.includes('[REDACTED]'), '应包含脱敏占位符');
  });

  await test('redact 纯函数: 各类敏感输入', () => {
    assert.strictEqual(auditLog.redact('password=abc'), 'password=[REDACTED]');
    assert.strictEqual(auditLog.redact('token: xyz123'), 'token=[REDACTED]'); // 分隔符统一归一化为 =
    assert.ok(!auditLog.redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----').includes('abc'));
    assert.strictEqual(auditLog.redact('普通文本 不含敏感'), '普通文本 不含敏感');
    assert.strictEqual(auditLog.redactPath('/home/root/x', 'root@h'), '/home/[REDACTED]/x');
    assert.strictEqual(auditLog.redactPath('/home/alice/x', 'root@h'), '/home/alice/x', '非当前用户目录不脱敏');
  });

  await test('redact: URI userinfo 密码段脱敏 (ssh://user:pass@host)', () => {
    const out = auditLog.redact('ssh://root:secretpw@1.2.3.4:22');
    assert.ok(out.includes('[REDACTED]'), '应包含脱敏占位符');
    assert.ok(!out.includes('secretpw'), '密码段不应保留');
    assert.ok(out.includes('root:'), '应保留用户名');
  });

  await test('redact: user:pass@host 形态脱敏', () => {
    const out = auditLog.redact('user:pass@host/path');
    assert.ok(out.includes('[REDACTED]'), '应包含脱敏占位符');
    assert.ok(!out.includes('pass@'), '密码段不应保留');
  });

  // ---------- 3. 查询筛选 ----------
  await test('queryAudit: 时间/类型/结果/用户筛选 + 分页', async () => {
    const dir = makeTmpDir();
    auditLog.initAuditLog({ dir });
    for (let i = 0; i < 6; i++) {
      auditLog.logAudit({
        type: i % 2 === 0 ? 'sftp.list' : 'sftp.upload',
        target: '/home/u' + i + '/f' + i + '.txt',
        result: i === 5 ? 'failure' : 'success',
        user: i < 3 ? 'alice@h' : 'bob@h',
        session: 's' + i,
        detail: 'd' + i,
      });
    }
    await auditLog.flush();

    let r = await auditLog.queryAudit({});
    assert.strictEqual(r.total, 6);
    assert.strictEqual(r.items.length, 6);

    r = await auditLog.queryAudit({ type: 'sftp.list' });
    assert.strictEqual(r.total, 3, 'sftp.list 应有 3 条');

    r = await auditLog.queryAudit({ result: 'failure' });
    assert.strictEqual(r.total, 1, 'failure 应有 1 条');
    assert.strictEqual(r.items[0].type, 'sftp.upload');

    r = await auditLog.queryAudit({ user: 'alice' });
    assert.strictEqual(r.total, 3, 'alice 应有 3 条');

    // 分页: 最新在前
    r = await auditLog.queryAudit({ limit: 2, offset: 0 });
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.total, 6);
    const first = r.items[0];
    r = await auditLog.queryAudit({ limit: 2, offset: 2 });
    assert.strictEqual(r.items.length, 2);
    assert.ok(r.items[0].ts <= first.ts, '应按 ts 降序');

    // 时间范围
    r = await auditLog.queryAudit({ to: new Date(Date.now() - 100000).toISOString() });
    assert.strictEqual(r.total, 0, 'to 在过去 100s 前应无命中');
    const newest = (await auditLog.queryAudit({ limit: 1 })).items[0];
    r = await auditLog.queryAudit({ from: newest.ts });
    assert.ok(r.total >= 1, 'from=最新 ts 应至少命中 1 条');
  });

  // ---------- 4. 并发写入 ----------
  await test('并发写入: 200 次 append 不丢行不交错', async () => {
    const dir = makeTmpDir();
    auditLog.initAuditLog({ dir });
    const N = 200;
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(auditLog.logAudit({
        type: 'sftp.delete',
        target: '/tmp/并发文件' + i + '.txt',
        result: 'success',
        user: 'tester@h',
        session: 'c' + i,
        detail: '并发写入 ' + i,
      }));
    }
    await Promise.all(jobs);
    await auditLog.flush();

    const lines = readLines(dir);
    assert.strictEqual(lines.length, N, '行数应为 ' + N + ', 实际 ' + lines.length);
    const details = new Set();
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.strictEqual(obj.type, 'sftp.delete', '每行可独立解析 => 无交错');
      assert.ok(obj.target.startsWith('/tmp/并发文件'), 'target 完整 => 无交错');
      details.add(obj.detail);
    }
    assert.strictEqual(details.size, N, '每条 detail 唯一 => 无丢失');
  });

  // ---------- 5. 白名单 ----------
  await test('_sanitize: 白名单字段策略', () => {
    const clean = auditLog._sanitize({
      type: 'x',
      result: 'success',
      password: 'hunter2',
      privateKey: 'SECRET',
      passphrase: 'p',
      target: '/a',
      user: 'u@h',
      detail: 42,
    });
    assert.ok(!('password' in clean), 'password 应被丢弃');
    assert.ok(!('privateKey' in clean), 'privateKey 应被丢弃');
    assert.ok(!('passphrase' in clean), 'passphrase 应被丢弃');
    assert.strictEqual(clean.detail, '42', '非字符串值应序列化');
    assert.ok(clean.ts, '自动补 ts');
    assert.strictEqual(clean.level, 'INFO', '自动补 level');
  });

  // ---------- 6. 静态断言 (IPC 埋点/桥接/面板) ----------
  await test('静态断言: main/preload/renderer/index 埋点与桥接齐全', () => {
    const root = path.join(__dirname, '..');
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

    // main.js: 引入 + 初始化 + IPC 通道
    assert.ok(mainSrc.includes("require('./src/audit-log')"), 'main.js 应 require audit-log');
    assert.ok(mainSrc.includes('auditLog.initAuditLog'), 'main.js 应初始化审计日志');
    assert.ok(mainSrc.includes("ipcMain.handle('audit:log'"), 'main.js 应有 audit:log IPC');
    assert.ok(mainSrc.includes("ipcMain.handle('audit:query'"), 'main.js 应有 audit:query IPC');
    // 关键操作类型埋点 (与 logAuditOp 调用对应)
    const expectedTypes = [
      'connect', 'disconnect', 'sftp.list', 'sftp.upload', 'sftp.download',
      'sftp.downloadFolder', 'sftp.mkdir', 'sftp.rename', 'sftp.delete',
      'sftp.cd', 'doc.open', 'doc.save', 'preview.open', 'preview.saveAs',
    ];
    for (const t of expectedTypes) {
      assert.ok(mainSrc.includes("'" + t + "'"), 'main.js 应埋点类型 ' + t);
    }
    // 不得同步写日志 (无 appendFileSync 新增)
    assert.ok(!mainSrc.includes('auditLog.appendFileSync'), '不得使用同步日志写入');

    // preload.js: 暴露 auditLog / auditQuery
    assert.ok(preloadSrc.includes('auditLog'), 'preload.js 应暴露 auditLog');
    assert.ok(preloadSrc.includes('auditQuery'), 'preload.js 应暴露 auditQuery');

    // renderer.js: 面板 + 查询调用 + 补充埋点
    assert.ok(rendererSrc.includes('openAuditPanel'), 'renderer.js 应有日志面板入口');
    assert.ok(rendererSrc.includes('window.nimbus.auditQuery'), 'renderer.js 应调用 auditQuery');
    assert.ok(rendererSrc.includes("type: 'doc.close'"), 'renderer.js 应补充 doc.close 埋点');

    // index.html: 面板 DOM 与入口按钮
    assert.ok(indexSrc.includes('id="auditOverlay"'), 'index.html 应有日志面板');
    assert.ok(indexSrc.includes('id="btnAudit"'), 'index.html 应有日志入口按钮');
  });

  // ---------- 汇总 ----------
  auditLog._resetForTest();
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
