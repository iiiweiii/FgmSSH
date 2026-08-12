#!/usr/bin/env node
/**
 * NimbusSSH - 主机密钥指纹存储模块 (hostkey-store) 测试 (node 直跑, 无 Electron)
 * 运行: node tests/hostkey-store-test.js
 *
 * 覆盖 (Roadmap 第一梯队 ②, TOFU 防中间人):
 *   1. computeFingerprint: 固定 Buffer 的 SHA256/MD5 输出与已知值一致
 *      (tests/hostkey.pub 是 mock-ssh-server 的 ed25519 公钥, 指纹已独立核算)
 *   2. checkHostKey 三态: trusted / unknown / mismatch
 *   3. trustHostKey 写入后可 trusted; mismatch 覆盖后可 trusted
 *   4. 损坏 JSON 回退 {} (不抛异常)
 *   5. host:port 不同 key 隔离
 *   6. 目录不存在自动创建 (saveKnownHosts mkdir recursive)
 *   7. 路径安全: 特殊 host 字符串仅作为 JSON key, 无路径注入
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../src/hostkey-store');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}

function section(name) {
  console.log('\n== ' + name + ' ==');
}

// 每个用例独立临时目录, 互不污染
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-hostkey-test-'));
}

// mock-ssh-server 的 ed25519 公钥 blob (hostkey.pub 第二段)
const FIXTURE_PUB_B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIF82X3M7p/KqIf2PMW7y/wqHi1QOH7zdki35eUUuz1+M';
// 独立核算的参考指纹 (sha256(blob) base64 无 padding / md5 冒号十六进制小写)。
// 与 OpenSSH `ssh-keygen -lf` 输出逐字符一致: SHA256 指纹 base64 不带尾部 '=' padding
// (实测 ssh-keygen: SHA256:Y5Bn0lxnS+dl5dnK38A0IV/6btRQ+gj3xYQtgvEIkEI)。
const EXPECT_SHA256 = 'SHA256:Y5Bn0lxnS+dl5dnK38A0IV/6btRQ+gj3xYQtgvEIkEI';
const EXPECT_MD5 = 'MD5:22:6b:f1:09:ad:67:df:d7:e1:67:61:e3:1b:7b:bb:c6';

function run() {
  section('computeFingerprint: 固定 Buffer 已知值');
  {
    const buf = Buffer.from(FIXTURE_PUB_B64, 'base64');
    const fp = store.computeFingerprint(buf);
    check('SHA256 与参考值一致', fp.sha256 === EXPECT_SHA256, fp.sha256);
    check('MD5 与参考值一致', fp.md5 === EXPECT_MD5, fp.md5);
    check('SHA256 前缀为 SHA256:', fp.sha256.startsWith('SHA256:'));
    check('MD5 前缀为 MD5: 且为 16 组冒号十六进制', fp.md5.startsWith('MD5:') && fp.md5.split(':').length === 17);
    // 自校验: 与直接 crypto 计算结果一致 (独立实现, 防计算路径漂移);
    // 注意 OpenSSH 指纹 base64 无 padding, 需去除尾部 '=' 后再比较
    const directSha = 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
    check('SHA256 与直接 crypto 一致 (无 padding)', fp.sha256 === directSha, fp.sha256 + ' vs ' + directSha);
    check('SHA256 base64 无尾部 padding (=)', !/[=]$/.test(fp.sha256), fp.sha256);
    const directMd5 = 'MD5:' + crypto.createHash('md5').update(buf).digest('hex').match(/../g).join(':');
    check('MD5 与直接 crypto 一致', fp.md5 === directMd5);
  }

  section('computeFingerprint: 输入容错');
  {
    const buf = Buffer.from('hello-host-key', 'utf8');
    const a = store.computeFingerprint(buf);
    const b = store.computeFingerprint(new Uint8Array(buf));
    const c = store.computeFingerprint(buf.toString('utf8'));
    check('Buffer/Uint8Array/string 三种输入结果一致', a.sha256 === b.sha256 && a.sha256 === c.sha256);
    check('空 Buffer 不抛异常', typeof store.computeFingerprint(Buffer.alloc(0)).sha256 === 'string');
  }

  section('checkHostKey 三态');
  {
    const dir = tmpDir();
    const p = path.join(dir, 'known_hosts.json');
    const fp = store.computeFingerprint(Buffer.from(FIXTURE_PUB_B64, 'base64'));

    const unknown = store.checkHostKey(p, 'example.com', 22, fp.sha256, 'ssh-ed25519');
    check('空库 -> unknown', unknown.status === 'unknown');

    const t = store.trustHostKey(p, 'example.com', 22, fp.sha256, 'ssh-ed25519');
    check('trustHostKey 返回 ok', t.ok === true);

    const trusted = store.checkHostKey(p, 'example.com', 22, fp.sha256, 'ssh-ed25519');
    check('写入后 -> trusted', trusted.status === 'trusted');
    check('trusted 返回 stored 条目', !!trusted.stored && trusted.stored.algorithm === 'ssh-ed25519');

    const mismatch = store.checkHostKey(p, 'example.com', 22, 'SHA256:AAAA1234567890123456789012345678901234567890=', 'ssh-ed25519');
    check('不同指纹 -> mismatch', mismatch.status === 'mismatch');
    check('mismatch 返回 stored (旧指纹可展示)', !!mismatch.stored && mismatch.stored.fingerprint === fp.sha256);
  }

  section('trustHostKey 覆盖 + firstSeen 保留');
  {
    const dir = tmpDir();
    const p = path.join(dir, 'known_hosts.json');
    const fp1 = store.computeFingerprint(Buffer.from(FIXTURE_PUB_B64, 'base64'));
    const fp2 = store.computeFingerprint(Buffer.from('another-key-blob', 'utf8'));

    const t1 = store.trustHostKey(p, 'srv.local', 2222, fp1.sha256, 'ssh-ed25519');
    const file1 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const firstSeen = file1['srv.local:2222'].firstSeen;
    check('首次写入 firstSeen 存在', typeof firstSeen === 'string' && firstSeen.length > 0);

    const t2 = store.trustHostKey(p, 'srv.local', 2222, fp2.sha256, 'ssh-ed25519');
    check('覆盖返回 ok', t2.ok === true);
    const after = store.checkHostKey(p, 'srv.local', 2222, fp2.sha256, 'ssh-ed25519');
    check('覆盖后新指纹 trusted', after.status === 'trusted');
    const file2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    check('覆盖保留 firstSeen', file2['srv.local:2222'].firstSeen === firstSeen);
    check('覆盖更新 lastSeen', file2['srv.local:2222'].lastSeen >= firstSeen);
    const old = store.checkHostKey(p, 'srv.local', 2222, fp1.sha256, 'ssh-ed25519');
    check('旧指纹覆盖后 -> mismatch', old.status === 'mismatch');
  }

  section('损坏 JSON 回退 {}');
  {
    const dir = tmpDir();
    const p = path.join(dir, 'known_hosts.json');
    fs.writeFileSync(p, '{ this is not valid json !!!', 'utf8');
    const map = store.loadKnownHosts(p);
    check('损坏 JSON -> {}', Object.keys(map).length === 0);
    const unknown = store.checkHostKey(p, 'x', 22, 'SHA256:abc=', 'ssh-ed25519');
    check('损坏库上 checkHostKey -> unknown (不抛异常)', unknown.status === 'unknown');
    // 非对象 (数组) 也回退
    fs.writeFileSync(p, '[1,2,3]', 'utf8');
    check('数组 JSON -> {}', Object.keys(store.loadKnownHosts(p)).length === 0);
    // 文件不存在 -> {}
    const missing = path.join(dir, 'nope', 'known_hosts.json');
    check('文件不存在 -> {}', Object.keys(store.loadKnownHosts(missing)).length === 0);
  }

  section('host:port 不同 key 隔离');
  {
    const dir = tmpDir();
    const p = path.join(dir, 'known_hosts.json');
    const fp = store.computeFingerprint(Buffer.from(FIXTURE_PUB_B64, 'base64'));
    store.trustHostKey(p, 'example.com', 22, fp.sha256, 'ssh-ed25519');
    check('同 host 不同端口 -> unknown', store.checkHostKey(p, 'example.com', 2222, fp.sha256, 'ssh-ed25519').status === 'unknown');
    check('同端口不同 host -> unknown', store.checkHostKey(p, 'other.com', 22, fp.sha256, 'ssh-ed25519').status === 'unknown');
    store.trustHostKey(p, 'other.com', 22, fp.sha256, 'ssh-ed25519');
    const map = store.loadKnownHosts(p);
    check('两主机并存 (key 隔离)', map['example.com:22'] && map['other.com:22']);
  }

  section('目录自动创建');
  {
    const dir = tmpDir();
    const deep = path.join(dir, 'a', 'b', 'c');
    const p = path.join(deep, 'known_hosts.json');
    const fp = store.computeFingerprint(Buffer.from(FIXTURE_PUB_B64, 'base64'));
    const t = store.trustHostKey(p, 'h', 22, fp.sha256, 'ssh-ed25519');
    check('深层目录自动创建 + 写入成功', t.ok === true && fs.existsSync(p));
    const stored = store.loadKnownHosts(p);
    check('写入内容可读', !!stored['h:22'] && stored['h:22'].fingerprint === fp.sha256);
  }

  section('路径安全: host 特殊字符仅作为 JSON key');
  {
    const dir = tmpDir();
    const p = path.join(dir, 'known_hosts.json');
    const fp = store.computeFingerprint(Buffer.from('k', 'utf8'));
    // host 含路径分隔符/点: 只能作为 JSON key, 绝不应影响存储文件路径
    const weirdHost = '../evil/..\\..\\x';
    const t = store.trustHostKey(p, weirdHost, 22, fp.sha256, 'ssh-ed25519');
    check('特殊 host 写入 ok', t.ok === true);
    const map = store.loadKnownHosts(p);
    const id = store.hostKeyId(weirdHost, 22);
    check('特殊 host 以原样 key 存储', !!map[id]);
    check('hostKeyId 是纯字符串拼接', id === '../evil/..\\..\\x:22');
    check('未越权写文件 (known_hosts.json 仍在目标目录)', fs.existsSync(p));
  }

  console.log('\n==== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ====');
  process.exit(failed > 0 ? 1 : 0);
}

run();
