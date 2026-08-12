/**
 * 调试: 打印 SSH 会话原始数据流 (十六进制+文本)
 */
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('=== READY ===');
  conn.shell({ term: 'xterm-256color', rows: 30, cols: 120 }, (err, stream) => {
    if (err) { console.error('shell err:', err.message); conn.end(); return; }
    console.log('=== SHELL OPEN ===');
    let buf = '';
    stream.on('data', (data) => {
      buf += data.toString('utf8');
      const hex = data.toString('hex').slice(0, 120);
      const txt = JSON.stringify(data.toString('utf8').slice(0, 80));
      console.log(`[data ${data.length}B] hex=${hex} txt=${txt}`);
      // 尝试在输出中提取命令结果
      if (buf.includes('/home/testuser')) {
        console.log('*** 检测到 pwd 输出: /home/testuser ***');
      }
    });
    stream.on('close', () => { console.log('=== STREAM CLOSE ==='); conn.end(); process.exit(0); });
    setTimeout(() => {
      console.log('> send: pwd\\r');
      stream.write('pwd\r');
    }, 500);
    setTimeout(() => {
      console.log('> send: exit\\r');
      stream.write('exit\r');
    }, 1500);
  });
});
conn.on('error', (e) => console.error('CONN ERR:', e.message));
conn.on('close', () => { console.log('=== CONN CLOSE ==='); process.exit(0); });
conn.connect({ host: '127.0.0.1', port: 2222, username: 'testuser', password: 'testpass123' });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
