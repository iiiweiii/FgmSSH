#!/usr/bin/env node
/**
 * NimbusSSH - 主机密钥指纹 e2e 验证 (真实 ssh2 Server + Client, node 直跑)
 * 运行: node tests/hostkey-e2e-test.js
 *
 * 目的: 验证「ssh2 hostVerifier 收到的 host key Buffer」与 hostkey-store.computeFingerprint
 * 完全兼容 (OpenSSH 兼容指纹), 并验证 checkHostKey unknown -> trustHostKey -> trusted 闭环。
 * 服务器使用 tests/hostkey (mock-ssh-server 同款 ed25519 私钥), 客户端用真实 ssh2 Client
 * 走 hostVerifier, 端口随机 (0) 避免冲突。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, Client } = require('ssh2');
const store = require('../src/hostkey-store');

const CWD = path.join(__dirname, '..');
const HOST_KEY = fs.readFileSync(path.join(CWD, 'tests', 'hostkey'));

// tests/hostkey.pub 的 ed25519 公钥 blob (独立核算的参考指纹见 hostkey-store-test)
const FIXTURE_BUF = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIF82X3M7p/KqIf2PMW7y/wqHi1QOH7zdki35eUUuz1+M', 'base64');
const EXPECT_SHA = store.computeFingerprint(FIXTURE_BUF).sha256;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-hke2e-'));
const storePath = path.join(tmp, 'known_hosts.json');

const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass123') ctx.accept();
    else ctx.reject(['password']);
  }).on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a && a());
      session.on('shell', (a) => { const s = a(); s.end(); });
    });
  });
});

let seenFingerprint = null;
let handshakeDone = false;
const conn = new Client();
let timeout = null;

function finish() {
  if (handshakeDone) return;
  handshakeDone = true;
  if (timeout) clearTimeout(timeout);
  check('hostVerifier 收到密钥且指纹与参考值一致', seenFingerprint === EXPECT_SHA, String(seenFingerprint));
  if (seenFingerprint) {
    const before = store.checkHostKey(storePath, '127.0.0.1', PORT, seenFingerprint, 'ssh-ed25519');
    check('空库 checkHostKey -> unknown', before.status === 'unknown', before.status);
    store.trustHostKey(storePath, '127.0.0.1', PORT, seenFingerprint, 'ssh-ed25519');
    const after = store.checkHostKey(storePath, '127.0.0.1', PORT, seenFingerprint, 'ssh-ed25519');
    check('trust 后 checkHostKey -> trusted', after.status === 'trusted', after.status);
  }
  try { server.close(); } catch (e) {}
  try { conn.end(); } catch (e) {}
  console.log('\n==== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ====');
  process.exit(failed > 0 ? 1 : 0);
}

let PORT = 0;
server.listen(0, '127.0.0.1', () => {
  PORT = server.address().port;
  conn.on('ready', () => {
    check('真实 ssh2 握手成功 (hostVerifier 接受后放行)', true);
    finish();
  });
  conn.on('error', (err) => {
    check('连接无错误', false, err.message);
    finish();
  });
  conn.connect({
    host: '127.0.0.1',
    port: PORT,
    username: 'testuser',
    password: 'testpass123',
    readyTimeout: 5000,
    hostVerifier: (key, cb) => {
      seenFingerprint = store.computeFingerprint(key).sha256;
      cb(true);
    },
  });
});

timeout = setTimeout(() => { check('e2e 超时兜底', false); finish(); }, 8000);
