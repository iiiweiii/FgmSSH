/**
 * FgmSSH 测试用 SSH 服务器
 * 基于 ssh2 的 Server API, 模拟一台真实 Linux 服务器:
 * - 密码认证: testuser / testpass123
 * - shell 交互: 模拟常见 Linux 命令输出
 * 监听: 127.0.0.1:2222
 */
const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST_KEY = fs.readFileSync(path.join(__dirname, 'hostkey'));
const PORT = 2222;

// 模拟的"命令执行结果"
function mockExec(cmd) {
  const c = cmd.trim();
  if (c === 'pwd') return '/home/testuser\r\n';
  if (c === 'whoami') return 'testuser\r\n';
  if (c === 'uname -a') return 'Linux nimbus-test-server 5.15.0-generic #1 SMP x86_64 GNU/Linux\r\n';
  if (c === 'hostname') return 'nimbus-test-server\r\n';
  if (c.startsWith('echo ')) return c.slice(5) + '\r\n';
  if (c === 'ls' || c.startsWith('ls ')) return 'Desktop  Documents  Downloads  projects\r\n';
  if (c === 'cat /etc/os-release') return 'NAME="Ubuntu"\r\nVERSION="22.04 LTS (Jammy Jellyfish)"\r\n';
  if (c === 'df -h /') return 'Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        98G   24G   69G  26% /\r\n';
  if (c === 'free -m') return '              total        used        free      shared  buff/cache   available\r\nMem:           7949        2412        3120          87        2416        5109\r\n';
  if (c === 'top -bn1 | head -5') return 'top - 14:31:22 up 12 days,  3:12,  2 users,  load average: 0.08, 0.03, 0.01\r\nTasks: 178 total,   1 running, 177 sleeping\r\n';
  if (c === 'exit' || c === 'logout') return null; // 退出
  return `bash: ${c}: command not found\r\n`;
}

const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
  console.log('[server] client connected');

  client
    .on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass123') {
        console.log('[server] auth OK:', ctx.username);
        ctx.accept();
      } else {
        console.log('[server] auth rejected:', ctx.username, ctx.method);
        ctx.reject(['password']);
      }
    })
    .on('ready', () => {
      console.log('[server] client ready');

      client.on('session', (accept) => {
        const session = accept();

        // shell (PTY) 会话 - 与 FgmSSH main.js 的 conn.shell() 对应
        // 处理 PTY 请求 (真实 Linux 服务器会自动响应 pty-req)
        session.on('pty', (accept, reject, info) => {
          console.log('[server] pty requested:', info.term, info.cols + 'x' + info.rows);
          accept();
        });

        session.on('window-change', (accept, reject, info) => {
          if (accept) accept();
          console.log('[server] window-change:', info.cols + 'x' + info.rows);
        });

        session.on('shell', (accept2) => {
          console.log('[server] shell requested');
          const stream = accept2();
          stream.write('\x1b[32mtestuser@nimbus-test-server\x1b[0m:\x1b[34m~\x1b[0m$ ');
          stream._buffer = '';

          stream.on('data', (data) => {
            stream._buffer += data.toString();
            // 处理 \r 回车 (终端发送的是 \r)
            const lines = stream._buffer.split('\r');
            stream._buffer = lines.pop() || '';
            for (const line of lines) {
              const cmd = line.trim();
              console.log('[server] cmd received:', JSON.stringify(cmd));
              if (cmd === 'exit' || cmd === 'logout' || cmd === 'exit\r') {
                stream.end('logout\r\n');
                return;
              }
              const out = mockExec(cmd);
              if (out !== null) {
                stream.write(out);
              }
              stream.write('\x1b[32mtestuser@nimbus-test-server\x1b[0m:\x1b[34m~\x1b[0m$ ');
            }
          });
        });
      });
    })
    .on('error', (err) => console.error('[server] error:', err.message))
    .on('close', () => console.log('[server] connection closed'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] FgmSSH 测试 SSH 服务器已启动: ssh://testuser@127.0.0.1:${PORT} (密码: testpass123)`);
  console.log('[server] 等待连接...');
});
