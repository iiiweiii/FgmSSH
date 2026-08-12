/**
 * NimbusSSH 真实服务器连接测试
 * 复用 src/main.js 中 createSSHSession() 完全相同的 ssh2 调用方式:
 * - Client + password 认证
 * - conn.shell({ term, rows, cols }) 打开 PTY
 * 目标: 用户提供的真实服务器
 */
const { Client } = require('ssh2');

// ===== 用户提供的真实服务器 =====
const CONFIG = {
  host: '172.16.11.10',
  port: 26810,
  username: 'root',
  password: 'CHANGE_ME_TEST_PASSWORD',
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3,
};

// ===== 测试用例: [命令, 期望包含的关键字列表] =====
const TESTS = [
  ['whoami', ['root']],
  ['hostname', ['-']],                      // 只要求非空(hostname 结果本身)
  ['uname -s', ['Linux']],
  ['echo NIMBUS-REAL-TEST-2026', ['NIMBUS-REAL-TEST-2026']],
  ['pwd', ['/']],
  ['cat /etc/os-release | head -1', ['NAME']],
  ['uptime', ['up']],
  ['ls / | head -3', ['bin', 'boot']],
];

const S_MARK = '__NIMBUS_S__';
const E_MARK = '__NIMBUS_E__';

let failCount = 0;
let passCount = 0;
let curTest = null;
let outBuf = '';

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function assertOutput(cmd, output, keywords) {
  const ok = keywords.every((kw) => output.includes(kw));
  const firstLine = output.trim().split('\n').slice(0, 3).join(' | ');
  if (ok) {
    passCount++;
    log(`  ✅ "${cmd}" 输出正常: ${firstLine}`);
  } else {
    failCount++;
    log(`  ❌ "${cmd}" 输出异常. 期望含: ${keywords.join(',')}. 实际: ${JSON.stringify(output.slice(0, 200))}`);
  }
}

const conn = new Client();

conn.on('ready', () => {
  log('✅ SSH 连接建立 (ready) — 密码认证通过');
  log(`   主机: ${CONFIG.host}:${CONFIG.port} 用户: ${CONFIG.username}`);
  log('   打开 PTY shell 会话 (与 NimbusSSH main.js 相同调用方式)...');

  conn.shell({
    term: process.env.TERM || 'xterm-256color',
    rows: 30,
    cols: 120,
    env: { LANG: 'en_US.UTF-8', TERM: process.env.TERM || 'xterm-256color' },
  }, (err, stream) => {
    if (err) { log('❌ shell 打开失败: ' + err.message); conn.end(); return; }
    log('✅ PTY shell 会话打开成功');
    log('   初始化: 关闭终端回显 (stty -echo) 以隔离命令输出...');

    let i = 0;
    let initialized = false;

    function next() {
      if (i >= TESTS.length) {
        log('\n> 所有测试完成, 发送 exit 关闭会话');
        stream.write('exit\r');
        return;
      }
      curTest = TESTS[i++];
      const [cmd] = curTest;
      log(`> [${i}/${TESTS.length}] 执行: ${cmd}`);
      stream.write(`echo ${S_MARK}; ${cmd}; echo ${E_MARK}\r`);
    }

    stream.on('data', (data) => {
      outBuf += data.toString('utf8');

      // 初始化阶段: 等待 stty -echo 生效
      if (!initialized) {
        if (outBuf.includes('NIMBUS_INIT_DONE')) {
          initialized = true;
          outBuf = '';
          log(`   初始化完成, 共 ${TESTS.length} 项测试, 开始执行...\n`);
          setTimeout(next, 300);
        }
        return;
      }

      // 检测标记对
      if (outBuf.includes(E_MARK)) {
        const sIdx = outBuf.lastIndexOf(S_MARK);
        if (sIdx >= 0) {
          const eIdx = outBuf.indexOf(E_MARK, sIdx);
          if (eIdx > sIdx) {
            let seg = outBuf.slice(sIdx + S_MARK.length, eIdx);
            seg = seg.replace(/\x1b\[[0-9;]*m/g, '');   // ANSI 颜色
            seg = seg.replace(/\r/g, '');
            outBuf = outBuf.slice(eIdx + E_MARK.length);
            const [cmd, keywords] = curTest;
            assertOutput(cmd, seg, keywords);
            next();
            return;
          }
        }
      }
    });

    stream.on('close', () => { log('\n✅ shell 会话关闭'); conn.end(); });
    stream.on('error', (e) => { log('❌ stream 错误: ' + e.message); conn.end(); });

    // 等待 shell 稳定后关闭回显
    setTimeout(() => {
      stream.write('stty -echo 2>/dev/null; echo NIMBUS_INIT_DONE\r');
    }, 600);
  });
});

conn.on('error', (err) => {
  log('❌ 连接失败: ' + err.message);
  finish();
});

conn.on('close', () => finish());

function finish() {
  log('\n============================================');
  log(`测试结果: ✅ 通过 ${passCount} 项 | ❌ 失败 ${failCount} 项`);
  if (failCount === 0 && passCount > 0) {
    log('🎉 NimbusSSH SSH 连接链路 (认证/PTY/命令交互) 在真实服务器上验证通过!');
  } else {
    log('⚠️ 存在失败项, 详见上方输出');
  }
  log('============================================');
  process.exit(failCount === 0 ? 0 : 1);
}

log(`启动真实服务器连接测试 → ssh://${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`);
conn.connect(CONFIG);

setTimeout(() => {
  log('⚠️ 整体超时 (30s)');
  try { conn.end(); } catch (e) {}
  finish();
}, 30000);
