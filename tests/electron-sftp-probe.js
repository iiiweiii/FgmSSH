/**
 * 最小 Electron + ssh2 SFTP 探针: 隔离验证 Electron 主进程中 ssh2 sftp 是否可用
 */
const { app } = require('electron');
const { Client } = require('ssh2');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

const SERVER = { host: '172.16.11.10', port: 26810, username: 'root', password: 'CHANGE_ME_TEST_PASSWORD', readyTimeout: 15000 };

app.whenReady().then(() => {
  console.log('[electron] ready, 测试 ssh2 sftp...');
  const conn = new Client();
  const t = setTimeout(() => { console.log('TIMEOUT'); try { conn.end(); } catch (e) {} process.exit(1); }, 25000);
  conn.on('ready', () => {
    console.log('  ready');
    conn.sftp((err, sftp) => {
      if (err) { console.log('  SFTP open ERR:', err.message); clearTimeout(t); try { conn.end(); } catch (e) {} process.exit(1); }
      console.log('  sftp open OK');
      sftp.readdir('/tmp', (e, list) => {
        console.log('  readdir /tmp:', e ? 'ERR ' + e.message : 'OK ' + list.length + ' entries');
        clearTimeout(t);
        try { conn.end(); } catch (x) {}
        process.exit(e ? 1 : 0);
      });
    });
  });
  conn.on('error', (e) => { console.log('  conn ERR:', e.message); clearTimeout(t); process.exit(1); });
  conn.connect(SERVER);
});
