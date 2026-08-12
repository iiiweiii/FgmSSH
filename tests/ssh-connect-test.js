/**
 * FgmSSH 连接测试客户端
 * 复用与 src/main.js 中 createSSHSession() 完全相同的 ssh2 调用方式:
 * - Client 连接 + password 认证
 * - conn.shell({ term, rows, cols }) 打开 PTY
 * - stream.write() 发送命令
 * 目标: 127.0.0.1:2222 (tests/mock-ssh-server.js)
 */
const { Client } = require('ssh2');
const assert = require('assert');

const CONFIG = {
  host: '127.0.0.1',
  port: 2222,
  username: 'testuser',
  password: 'testpass123',
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3,
};

const RESULTS = [];
let outputBuffer = '';
let currentCmd = null;
let cmdQueue = ['pwd', 'whoami', 'uname -a', 'echo fgm-ssh-hello', 'ls', 'exit'];
let failCount = 0;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  RESULTS.push(line);
}

const conn = new Client();

conn.on('ready', () => {
  log('✅ SSH 连接建立成功 (ready)');
  log(`   服务器指纹握手完成 | 主机: ${CONFIG.host}:${CONFIG.port} 用户: ${CONFIG.username}`);

  // 与 main.js 完全一致: 打开 shell PTY
  conn.shell({
    term: process.env.TERM || 'xterm-256color',
    rows: 30,
    cols: 120,
    env: { LANG: 'en_US.UTF-8', TERM: process.env.TERM || 'xterm-256color' },
  }, (err, stream) => {
    if (err) {
      fail('shell 打开失败: ' + err.message);
      conn.end();
      return;
    }
    log('✅ PTY shell 会话打开成功');
    log('   开始发送测试命令...');

    stream.on('data', (data) => {
      outputBuffer += data.toString('utf8');
      // 检测到提示符 => 一条命令执行完毕
      if (outputBuffer.includes('$ ')) {
        processOutput();
      }
    });

    stream.on('close', () => {
      log('✅ shell 会话正常关闭');
      conn.end();
    });

    stream.on('error', (e) => {
      fail('stream 错误: ' + e.message);
      conn.end();
    });

    sendNext(stream);
  });
});

function sendNext(stream) {
  if (cmdQueue.length === 0) return;
  currentCmd = cmdQueue.shift();
  log(`> 发送命令: ${currentCmd}`);
  stream.write(currentCmd + '\r');
}

function processOutput() {
  const idx = outputBuffer.lastIndexOf('$ ');
  const cmdOutput = outputBuffer.slice(0, idx).replace(/\r\n/g, '\n');
  outputBuffer = '';

  const expectedMap = {
    'pwd': ['/home/testuser'],
    'whoami': ['testuser'],
    'uname -a': ['Linux', 'x86_64'],
    'echo fgm-ssh-hello': ['fgm-ssh-hello'],
    'ls': ['Desktop', 'projects'],
  };

  const expected = expectedMap[currentCmd];
  if (expected) {
    const ok = expected.every((kw) => cmdOutput.includes(kw));
    if (ok) {
      log(`   ✅ "${currentCmd}" 输出正确: ${cmdOutput.trim().split('\n')[0]}${cmdOutput.trim().split('\n')[1] ? ' ...' : ''}`);
    } else {
      fail(`命令 "${currentCmd}" 输出不符合预期。期望包含: ${expected.join(', ')}。实际: ${JSON.stringify(cmdOutput)}`);
    }
  } else {
    log(`   (无断言) "${currentCmd}" 输出: ${cmdOutput.trim().split('\n')[0]}`);
  }

  if (cmdQueue.length > 0) {
    sendNext(stream);
  } else {
    log('> 所有命令测试完成, 发送 exit 关闭会话');
    stream.write('exit\r');
  }
}

function fail(msg) {
  failCount++;
  log('❌ 失败: ' + msg);
  RESULTS.push('FAIL: ' + msg);
}

conn.on('error', (err) => {
  fail('连接失败: ' + err.message);
  finish();
});

conn.on('close', () => finish());

function finish() {
  const total = Object.keys({
    'pwd': 1, 'whoami': 1, 'uname -a': 1, 'echo fgm-ssh-hello': 1, 'ls': 1,
  }).length;
  log('');
  log('==================== 测试结果 ====================');
  if (failCount === 0) {
    log(`🎉 全部通过! ${total} 项命令断言全部 PASS`);
    log('✅ FgmSSH 的 SSH 连接链路 (认证/PTY/命令交互) 工作正常');
  } else {
    log(`⚠️ 有 ${failCount} 项断言失败`);
  }
  log('==================================================');
  process.exit(failCount === 0 ? 0 : 1);
}

log(`启动连接测试 → ssh://${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`);
conn.connect(CONFIG);

// 超时保护
setTimeout(() => {
  fail('整体超时 (25s)');
  try { conn.end(); } catch (e) {}
  finish();
}, 25000);
