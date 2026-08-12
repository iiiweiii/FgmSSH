/**
 * 诊断: 对比端口 22 与 26810 的连接认证行为
 */
const { Client } = require('ssh2');

function tryConnect(label, port) {
  return new Promise((resolve) => {
    const conn = new Client();
    const started = Date.now();
    let done = false;
    const finish = (msg) => { if (!done) { done = true; console.log(msg); resolve(); } };

    conn.on('ready', () => {
      finish(`[${label}] ✅ 连接成功 (${Date.now() - started}ms) → 立即断开`);
      conn.end();
    });
    conn.on('error', (err) => {
      finish(`[${label}] ❌ 错误: ${err.message}`);
    });
    conn.on('close', () => finish(`[${label}] 连接关闭 (${Date.now() - started}ms)`));
    conn.connect({
      host: '172.16.11.10',
      port,
      username: 'root',
      password: '92eXlHKg8i',
      readyTimeout: 15000,
    });
    setTimeout(() => finish(`[${label}] ⏱ 超时 (15s)`), 15000);
  });
}

(async () => {
  console.log('=== 诊断: 相同凭据, 不同端口 ===\n');
  await tryConnect('端口 22  (用户保存的连接)', 22);
  await tryConnect('端口 26810 (用户 ssh 命令用的端口)', 26810);
  console.log('\n=== 诊断完成 ===');
  process.exit(0);
})();
