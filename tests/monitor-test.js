/**
 * NimbusSSH 服务器健康监控模块回归测试 (node 直跑, 不依赖 Electron)
 * 运行: node tests/monitor-test.js
 * 覆盖:
 *   1. parseUptime: Linux uptime / /proc/loadavg / macOS / 空输出
 *   2. parseFree: free -k 无后缀 / free -h 带单位 / busybox / 无 Swap
 *   3. parseDf: POSIX 单行 / 多挂载点 / Use% 排序与 Top 限制 / 空 / 可选白名单过滤
 *   4. parseTopCpu: %Cpu(s) 标准 / 多核取首个 / mpstat 兜底 / 无法解析
 *   5. parseOsRelease: PRETTY_NAME / NAME 兜底 / 缺失
 *   6. parseNvidiaSmi: CSV 单卡 / 多卡 / [N/A] 指标 / 表格降级 / 无数据 / command not found
 *   7. fetchMonitorData: mock exec 全成功 (含 gpu) / 单命令失败不阻塞 / 输出无法解析 /
 *      全失败 (8 命令) / exec 缺失抛错 / stderr 记录
 *   8. main.js/preload.js/index.html 静态断言: ssh:monitor:fetch handler + monitorFetch 桥接
 *      + nvidia-smi 命令 + GPU 卡片/折线 + 内存 GB 格式化
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parser = require('../src/health-parser');
const { parseUptime, parseFree, parseDf, parseTopCpu, parseOsRelease, parseNvidiaSmi, fetchMonitorData } = parser;

const ROOT = path.join(__dirname, '..');

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

// 构造 mock exec: 按命令名返回预设输出 (未预设 -> reject)
function makeMockExec(map) {
  return async (command) => {
    const entry = map[command];
    if (entry === undefined) throw new Error('mock: 未知命令 ' + command);
    if (entry instanceof Error) throw entry;
    return { stdout: entry, stderr: '', code: 0 };
  };
}

const C = parser.MONITOR_COMMANDS;

async function run() {
  // ---------- 1. parseUptime ----------
  await test('parseUptime: Linux uptime 标准输出', () => {
    const r = parseUptime(' 12:34:56 up 1 day,  2:03,  2 users,  load average: 0.52, 0.58, 0.59\n');
    assert.ok(r, '应解析成功');
    assert.strictEqual(r.load1, 0.52);
    assert.strictEqual(r.load5, 0.58);
    assert.strictEqual(r.load15, 0.59);
    assert.strictEqual(r.up, '1 day,  2:03');
  });

  await test('parseUptime: /proc/loadavg 前 3 字段', () => {
    const r = parseUptime('0.00 0.01 0.05 1/234 56789\n');
    assert.ok(r);
    assert.strictEqual(r.load1, 0);
    assert.strictEqual(r.load5, 0.01);
    assert.strictEqual(r.load15, 0.05);
  });

  await test('parseUptime: macOS load averages 空格分隔', () => {
    const r = parseUptime(' 10:20:30 up 2 days, 1:02, 3 users, load averages: 1.34 1.56 1.47');
    assert.ok(r);
    assert.strictEqual(r.load1, 1.34);
    assert.strictEqual(r.load5, 1.56);
    assert.strictEqual(r.load15, 1.47);
  });

  await test('parseUptime: 空/无效输出 -> null', () => {
    assert.strictEqual(parseUptime(''), null);
    assert.strictEqual(parseUptime('   \n'), null);
    assert.strictEqual(parseUptime('no load data here'), null);
    assert.strictEqual(parseUptime(null), null);
  });

  // ---------- 2. parseFree ----------
  await test('parseFree: free -k 无单位 KB', () => {
    const out = '              total        used        free      shared  buff/cache   available\n' +
                'Mem:        16258316     3456789    12800000      100000     4500000    8500000\n' +
                'Swap:        8388604           0     8388604\n';
    const r = parseFree(out);
    assert.ok(r);
    // 16258316 KB -> MB
    assert.strictEqual(r.totalMB, Math.round((16258316 / 1024) * 100) / 100);
    assert.strictEqual(r.usedMB, Math.round((3456789 / 1024) * 100) / 100);
    assert.strictEqual(r.freeMB, Math.round((12800000 / 1024) * 100) / 100);
    assert.strictEqual(r.swapTotalMB, Math.round((8388604 / 1024) * 100) / 100);
    assert.strictEqual(r.swapUsedMB, 0);
    assert.strictEqual(r.swapFreeMB, Math.round((8388604 / 1024) * 100) / 100);
    assert.ok(!('availableMB' in r), '不提取语义有歧义的 available 列 (新旧 free 第 6 列语义不同)');
  });

  await test('parseFree: free -h 带单位 (Gi/Mi)', () => {
    const out = '               total        used        free      shared  buff/cache   available\n' +
                'Mem:            15Gi       3.2Gi        11Gi       1.0Gi       4.3Gi       9.3Gi\n' +
                'Swap:          8.0Gi          0B       8.0Gi\n';
    const r = parseFree(out);
    assert.ok(r);
    assert.strictEqual(r.totalMB, 15 * 1024);
    assert.strictEqual(r.usedMB, Math.round(3.2 * 1024 * 100) / 100);
    assert.strictEqual(r.freeMB, 11 * 1024);
    assert.strictEqual(r.swapTotalMB, 8 * 1024);
    assert.strictEqual(r.swapUsedMB, 0);
  });

  await test('parseFree: busybox 无 available 列 + 无 Swap 行', () => {
    const out = '             total       used       free     shared    buffers     cached\n' +
                'Mem:        16258316    3456789   12800000     100000    4500000    8500000\n';
    const r = parseFree(out);
    assert.ok(r);
    assert.ok(r.totalMB > 0);
    assert.strictEqual(r.availableMB, undefined, '旧版无 available 列不应伪造');
    assert.strictEqual(r.swapTotalMB, null, '无 Swap 行时 swap 应为 null');
  });

  await test('parseFree: 空/无 Mem 行 -> null', () => {
    assert.strictEqual(parseFree(''), null);
    assert.strictEqual(parseFree('no mem line'), null);
    assert.strictEqual(parseFree(null), null);
  });

  // ---------- 3. parseDf ----------
  await test('parseDf: POSIX 单行标准输出', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                'tmpfs           7.8G  1.2M  7.8G   1% /dev/shm\n' +
                '/dev/sda2       200G  150G   40G  79% /home\n';
    const rows = parseDf(out);
    assert.strictEqual(rows.length, 3);
    // Use% 降序: /home(79) -> /(48) -> /dev/shm(1)
    assert.strictEqual(rows[0].mounted, '/home');
    assert.strictEqual(rows[0].usedPct, 79);
    assert.strictEqual(rows[1].mounted, '/');
    assert.strictEqual(rows[2].mounted, '/dev/shm');
    assert.strictEqual(rows[1].filesystem, '/dev/sda1');
    assert.strictEqual(rows[1].size, '99G');
    assert.strictEqual(rows[1].usePct, '48%');
  });

  await test('parseDf: Top 限制 + 挂载点含空格', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sdb1       500G  400G   70G  85% /data with space\n' +
                '/dev/sdc1       300G  290G   -1G 100% /full\n';
    const rows = parseDf(out, 2);
    assert.strictEqual(rows.length, 2, '应限制为 Top 2');
    assert.strictEqual(rows[0].usedPct, 100);
    assert.strictEqual(rows[0].mounted, '/full');
    assert.strictEqual(rows[1].usedPct, 85);
    assert.strictEqual(rows[1].mounted, '/data with space', '挂载点应保留空格');
  });

  await test('parseDf: 空/仅表头 -> []', () => {
    assert.deepStrictEqual(parseDf(''), []);
    assert.deepStrictEqual(parseDf('Filesystem      Size  Used Avail Use% Mounted on\n'), []);
    assert.deepStrictEqual(parseDf(null), []);
  });

  await test('health-parser: DISK_MOUNT_WHITELIST 导出且含 3 个挂载点', () => {
    assert.ok(Array.isArray(parser.DISK_MOUNT_WHITELIST), '应导出 DISK_MOUNT_WHITELIST');
    assert.deepStrictEqual(
      parser.DISK_MOUNT_WHITELIST,
      ['/', '/root/autodl-tmp', '/root/autodl-fs'],
      '白名单应为用户服务器配置的 3 个挂载点'
    );
  });

  await test('parseDf: 可选白名单参数 -> 仅保留白名单挂载点 (默认不传不过滤)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sda2       200G  150G   40G  79% /home\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp\n' +
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n' +
                '/dev/sdd1        50G    1G   49G   2% /data\n';
    // 传入白名单: 只输出白名单内挂载点, 且按 Use% 降序
    const rows = parseDf(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(rows.length, 3, '应只输出白名单内挂载点');
    assert.ok(rows.every((r) => parser.DISK_MOUNT_WHITELIST.includes(r.mounted)), '全部应在白名单内');
    assert.strictEqual(rows[0].mounted, '/root/autodl-tmp', '白名单内仍按使用率降序');
    assert.strictEqual(rows[1].mounted, '/root/autodl-fs');
    assert.strictEqual(rows[2].mounted, '/');
    // 默认不传白名单 -> 不过滤 (保持原行为, 仍含 /home 与 /data)
    const all = parseDf(out);
    assert.strictEqual(all.length, 5, '默认仍按 Top 5 限制');
    assert.ok(all.some((r) => r.mounted === '/home'), '默认不过滤 /home');
    assert.ok(all.some((r) => r.mounted === '/data'), '默认不过滤 /data');
    // 白名单中挂载点在 df 输出中不存在 -> 不显示 (仅输出实际存在的白名单挂载点)
    const missing = parseDf(
      'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1  99G  45G  49G  48% /\n',
      undefined,
      parser.DISK_MOUNT_WHITELIST
    );
    assert.strictEqual(missing.length, 1, 'df 中不存在的白名单挂载点不应输出');
    assert.strictEqual(missing[0].mounted, '/');
    // 空白名单/未传 -> 不限制 (兼容历史调用, 仍按使用率降序)
    assert.deepStrictEqual(
      parseDf(out, undefined, []).map((r) => r.mounted),
      ['/root/autodl-tmp', '/root/autodl-fs', '/home', '/', '/data'],
      '空白名单视为不过滤'
    );
  });

  await test('parseDf: 白名单归一化 — /root/autodl-tmp 带 trailing slash / 尾部空格仍匹配', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp/   \n' + // trailing slash + 尾部空格
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n';
    const rows = parseDf(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(rows.length, 3, '归一化后 3 个白名单挂载点全部保留');
    const mounted = rows.map((r) => r.mounted);
    assert.ok(mounted.includes('/root/autodl-tmp'), 'trailing slash + 尾部空格应归一化后匹配白名单');
    assert.ok(mounted.includes('/root/autodl-fs'), '/root/autodl-fs 应保留');
    assert.ok(mounted.includes('/'), '根挂载点应保留');
    assert.strictEqual(rows[0].mounted, '/root/autodl-tmp', '使用率 100% 应按使用率排最前');
    assert.strictEqual(rows[0].usedPct, 100, '归一化不影响 Use% 解析');
    assert.ok(rows.every((r) => !r.mounted.endsWith('/') || r.mounted === '/'),
      '归一化后非根挂载点不应带尾斜杠');
  });

  await test('parseDf: 白名单归一化 — 多空格折叠 + 与高使用率非白名单盘共存 (Top5 截断场景)', () => {
    // 6 个高使用率非白名单盘 + 低使用率白名单盘 /root/autodl-tmp (1%) -> 先过滤再截断, tmp 不被挤掉
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1       100G   90G   10G  90% /var/lib/docker\n' +
                '/dev/sda2       100G   85G   15G  85% /opt/app\n' +
                '/dev/sda3       100G   81G   19G  81% /boot\n' +
                '/dev/sda4       100G   70G   30G  70% /srv\n' +
                '/dev/sda5       100G   55G   45G  55% /tmp\n' +
                '/dev/sda6       100G   21G   79G  21% /run\n' +
                '/dev/sdb1       500G    1G  499G   1% /root/autodl-tmp\n' +
                '/dev/sdc1        50G   10G   40G  20% /\n';
    const rows = parseDf(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(rows.length, 2, '仅白名单 / 与 /root/autodl-tmp (tmp 不被 Top5 截断)');
    assert.ok(rows.some((r) => r.mounted === '/root/autodl-tmp' && r.usedPct === 1),
      '低使用率白名单盘必须保留 (过滤先于截断)');
    assert.ok(rows.every((r) => parser.DISK_MOUNT_WHITELIST.includes(r.mounted)), '全部应在白名单内');
  });

  await test('parseDf: normalizeMountPath 导出 — 根 / 去尾斜杠后仍为 / (不伤根)', () => {
    assert.strictEqual(typeof parser.normalizeMountPath, 'function', '应导出 normalizeMountPath');
    assert.strictEqual(parser.normalizeMountPath('/'), '/', '根保留');
    assert.strictEqual(parser.normalizeMountPath('/root/autodl-tmp/'), '/root/autodl-tmp');
    assert.strictEqual(parser.normalizeMountPath(' /root/autodl-tmp  '), '/root/autodl-tmp');
    assert.strictEqual(parser.normalizeMountPath('/data with  space'), '/data with space');
    assert.strictEqual(parser.normalizeMountPath('/root/autodl-fs///'), '/root/autodl-fs');
    assert.strictEqual(parser.normalizeMountPath(null), '');
    assert.strictEqual(parser.normalizeMountPath(undefined), '');
  });

  await test('parseDfWithUnmatched: 3 白名单 + 3 非白名单 -> matched 3 + unmatched 3 (同一批 rows, 不截断)', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sda2       200G  150G   40G  79% /home\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp\n' +
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n' +
                '/dev/sdd1        50G    1G   49G   2% /data\n' +
                '/dev/sde1       500G  400G  100G  82% /var/lib/docker\n';
    const { matched, unmatched } = parser.parseDfWithUnmatched(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(matched.length, 3, '白名单内 3 个挂载点应全部匹配');
    assert.ok(matched.every((r) => parser.DISK_MOUNT_WHITELIST.includes(r.mounted)), 'matched 全部应在白名单内');
    assert.strictEqual(unmatched.length, 3, '白名单外挂载点应全部进入 unmatched (不截断)');
    assert.deepStrictEqual(unmatched.map((r) => r.mounted), ['/var/lib/docker', '/home', '/data'], 'unmatched 按使用率降序');
    // parseDf 仍返回 matched 数组 (兼容既有调用/测试)
    const rows = parseDf(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows.map((r) => r.mounted).sort(), ['/', '/root/autodl-fs', '/root/autodl-tmp']);
  });

  await test('parseDfWithUnmatched: 全部命中白名单 -> unmatched 空; 无白名单 -> matched 全部', () => {
    const out = 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                '/dev/sda1        99G   45G   49G  48% /\n' +
                '/dev/sdb1       300G  290G   -1G 100% /root/autodl-tmp\n' +
                '/dev/sdc1       100G   80G   20G  88% /root/autodl-fs\n';
    const { matched, unmatched } = parser.parseDfWithUnmatched(out, undefined, parser.DISK_MOUNT_WHITELIST);
    assert.strictEqual(matched.length, 3, '全部命中白名单');
    assert.strictEqual(unmatched.length, 0, '无未匹配 -> 调试区隐藏');
    // 不传白名单 -> matched=全部 rows, unmatched=[] (保持 parseDf 不过滤行为)
    const all = parser.parseDfWithUnmatched(out, undefined, []);
    assert.strictEqual(all.matched.length, 3);
    assert.strictEqual(all.unmatched.length, 0, '空白名单视为不过滤, 无未匹配');
    const none = parser.parseDfWithUnmatched(out);
    assert.strictEqual(none.matched.length, 3, '不传白名单 = 不过滤');
    assert.strictEqual(none.unmatched.length, 0);
  });

  await test('静态: renderer.js 不再出现 "Top 5" 文案 (磁盘卡片标题已改为 "磁盘")', () => {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(!rendererSrc.includes('Top 5'), 'renderer.js 不得残留 "Top 5" 文案');
    assert.ok(!rendererSrc.includes('Top5'), 'renderer.js 不得残留 "Top5" 文案');
    assert.ok(rendererSrc.includes('<h4>磁盘</h4>'), '磁盘卡片标题应为 "磁盘"');
    assert.ok(rendererSrc.includes('normalizeMountPath'), 'renderer 应含挂载点归一化函数');
  });

  // ---------- 4. parseTopCpu ----------
  await test('parseTopCpu: %Cpu(s) 标准格式', () => {
    const out = 'top - 12:00:01 up 1 day,  2:03,  2 users,  load average: 0.52, 0.58, 0.59\n' +
                'Tasks: 120 total,   1 running, 119 sleeping\n' +
                '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\n' +
                'KiB Mem :  16258316 total,  12800000 free\n';
    const r = parseTopCpu(out);
    assert.ok(r);
    assert.strictEqual(r.user, 3.1);
    assert.strictEqual(r.system, 0.7);
    assert.strictEqual(r.idle, 95.8);
    assert.strictEqual(r.nice, 0);
    assert.strictEqual(r.iowait, 0.3);
    assert.strictEqual(r.steal, 0);
  });

  await test('parseTopCpu: 多核输出取首个 %Cpu 行', () => {
    const out = '%Cpu0 :  5.0 us,  2.0 sy,  0.0 ni, 93.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n' +
                '%Cpu1 :  9.0 us,  1.0 sy,  0.0 ni, 90.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n';
    const r = parseTopCpu(out);
    assert.ok(r);
    assert.strictEqual(r.user, 5.0);
    assert.strictEqual(r.idle, 93.0);
  });

  await test('parseTopCpu: mpstat all 汇总行兜底', () => {
    const out = 'Linux 5.15.0 (host)  08/12/2026  _x86_64_  (8 CPU)\n' +
                '\n' +
                '12:00:01     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle\n' +
                'Average:     all    3.05    0.00    0.71    0.35    0.00    0.02    0.00    0.00    0.00   95.87\n';
    const r = parseTopCpu(out);
    assert.ok(r);
    assert.strictEqual(r.user, 3.05);
    assert.strictEqual(r.system, 0.71);
    assert.strictEqual(r.iowait, 0.35);
    assert.strictEqual(r.idle, 95.87);
  });

  await test('parseTopCpu: 无法解析 (busybox 风格/空) -> null', () => {
    assert.strictEqual(parseTopCpu(''), null);
    assert.strictEqual(parseTopCpu('PID  PPID USER STAT VSZ'), null);
    assert.strictEqual(parseTopCpu(null), null);
  });

  // ---------- 5. parseOsRelease ----------
  await test('parseOsRelease: PRETTY_NAME 优先', () => {
    const out = 'NAME="Ubuntu"\nVERSION="22.04.3 LTS (Jammy Jellyfish)"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nID=ubuntu\n';
    assert.strictEqual(parseOsRelease(out), 'Ubuntu 22.04.3 LTS');
  });

  await test('parseOsRelease: NAME 兜底 + 缺失 -> null', () => {
    assert.strictEqual(parseOsRelease('NAME="Alpine Linux"\nID=alpine\n'), 'Alpine Linux');
    assert.strictEqual(parseOsRelease(''), null);
    assert.strictEqual(parseOsRelease('ID=unknown\n'), null);
    assert.strictEqual(parseOsRelease(null), null);
  });

  // ---------- 6. parseNvidiaSmi ----------
  await test('parseNvidiaSmi: CSV 单卡标准输出 (nounits)', () => {
    const out = 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n';
    const r = parseNvidiaSmi(out);
    assert.ok(r, '应解析成功');
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.gpus.length, 1);
    const g = r.gpus[0];
    assert.strictEqual(g.name, 'NVIDIA GeForce RTX 3080');
    assert.strictEqual(g.util, 45);
    assert.strictEqual(g.memUsed, 5120);
    assert.strictEqual(g.memTotal, 10240);
    assert.strictEqual(g.memPct, 50);
    assert.strictEqual(g.temp, 67);
    assert.strictEqual(g.power, 180.5);
    assert.strictEqual(g.available, true);
  });

  await test('parseNvidiaSmi: CSV 多卡 -> gpus 数组 + 卡数', () => {
    const out = 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n' +
                'NVIDIA GeForce RTX 3090, 12, 1024, 24576, 55, 90.2\n';
    const r = parseNvidiaSmi(out);
    assert.ok(r);
    assert.strictEqual(r.gpus.length, 2);
    assert.strictEqual(r.gpus[1].name, 'NVIDIA GeForce RTX 3090');
    assert.strictEqual(r.gpus[1].util, 12);
    assert.strictEqual(r.gpus[1].memPct, Math.round((1024 / 24576) * 1000) / 10);
  });

  await test('parseNvidiaSmi: CSV [N/A] / [Not Supported] 指标 -> null (不误判为 0)', () => {
    const out = 'NVIDIA A100-SXM4-40GB, [N/A], [Not Supported], 40960, 45, 200.0\n';
    const r = parseNvidiaSmi(out);
    assert.ok(r);
    const g = r.gpus[0];
    assert.strictEqual(g.util, null);
    assert.strictEqual(g.memUsed, null);
    assert.strictEqual(g.memTotal, 40960);
    assert.strictEqual(g.memPct, null, '显存占用缺失时 memPct 应为 null');
    assert.strictEqual(g.temp, 45);
    assert.strictEqual(g.power, 200);
  });

  await test('parseNvidiaSmi: 标准表格输出降级解析 (best-effort)', () => {
    const out = [
      '+-----------------------------------------------------------------------------+',
      '| NVIDIA-SMI 545.23.08    Driver Version: 545.23.08    CUDA Version: 12.3     |',
      '|-------------------------------+----------------------+----------------------+',
      '| GPU  Name                     Persistence-M | Bus-Id        Disp.A | Volatile Uncorr. ECC |',
      '| Fan  Temp  Perf  Pwr:Usage/Cap |         Memory-Usage | GPU-Util  Compute M. |',
      '+-------------------------------+----------------------+----------------------+',
      '|   0  NVIDIA GeForce RTX 3080  On   | 00000000:01:00.0 Off |                  N/A |',
      '| 30%   67C    P0    180W / 320W |   5120MiB / 10240MiB |     45%      Default |',
      '+-------------------------------+----------------------+----------------------+',
    ].join('\n');
    const r = parseNvidiaSmi(out);
    assert.ok(r, '表格输出应降级解析成功');
    assert.strictEqual(r.gpus.length, 1);
    const g = r.gpus[0];
    assert.strictEqual(g.name, 'NVIDIA GeForce RTX 3080');
    assert.strictEqual(g.util, 45);
    assert.strictEqual(g.memUsed, 5120);
    assert.strictEqual(g.memTotal, 10240);
    assert.strictEqual(g.memPct, 50);
    assert.strictEqual(g.temp, 67);
    assert.strictEqual(g.power, 180);
  });

  await test('parseNvidiaSmi: 空 / command not found / 无设备 -> null (降级)', () => {
    assert.strictEqual(parseNvidiaSmi(''), null);
    assert.strictEqual(parseNvidiaSmi('   \n'), null);
    assert.strictEqual(parseNvidiaSmi(null), null);
    assert.strictEqual(parseNvidiaSmi('bash: nvidia-smi: command not found\n'), null);
    assert.strictEqual(parseNvidiaSmi('No devices were found\n'), null);
    assert.strictEqual(parseNvidiaSmi('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.\n'), null);
  });

  // ---------- 7. fetchMonitorData (mock exec) ----------
  await test('fetchMonitorData: 全命令成功 -> 结构化指标齐全 (含 gpu)', async () => {
    const exec = makeMockExec({
      [C.load]: ' 12:34:56 up 1 day,  2:03,  2 users,  load average: 0.52, 0.58, 0.59',
      [C.memory]: 'Mem:  16258316  3456789  12800000  100000  4500000  8500000\nSwap:  8388604  0  8388604\n',
      [C.disks]: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1  99G  45G  49G  48% /\n',
      [C.cpu]: '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\n',
      [C.hostname]: 'web-01\n',
      [C.os]: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n',
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.identity, 'root@1.2.3.4');
    assert.ok(data.fetchedAt, '应有采集时间');
    assert.strictEqual(data.info.hostname, 'web-01');
    assert.strictEqual(data.info.os, 'Ubuntu 22.04.3 LTS');
    assert.strictEqual(data.info.date, '2026-08-12T10:00:00Z');
    assert.strictEqual(data.load.load1, 0.52);
    assert.ok(data.memory.totalMB > 0);
    assert.strictEqual(data.disks.length, 1);
    assert.strictEqual(data.cpu.user, 3.1);
    assert.ok(data.gpu, '应有 gpu 指标');
    assert.strictEqual(data.gpu.available, true);
    assert.strictEqual(data.gpu.gpus[0].util, 45);
    assert.deepStrictEqual(data.errors, {}, '全成功时不应有错误');
  });

  await test('fetchMonitorData: disks 按白名单预过滤 + diskMountWhitelist 透传 (单一事实源)', async () => {
    const exec = makeMockExec({
      [C.load]: ' 12:34:56 up 1 day, load average: 0.52, 0.58, 0.59',
      [C.memory]: 'Mem:  16258316  3456789  12800000\n',
      [C.disks]: 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                 '/dev/sda1  99G  45G  49G  48% /\n' +
                 '/dev/sda2  200G  150G  40G  79% /home\n' +
                 '/dev/sdb1  300G  290G   -1G 100% /root/autodl-tmp\n',
      [C.cpu]: '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\n',
      [C.hostname]: 'web-01\n',
      [C.os]: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n',
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.ok(Array.isArray(data.diskMountWhitelist), '应透传 diskMountWhitelist');
    assert.deepStrictEqual(data.diskMountWhitelist, ['/', '/root/autodl-tmp', '/root/autodl-fs']);
    assert.strictEqual(data.disks.length, 2, '白名单外 /home 不应出现在 disks (df 中 /root/autodl-fs 不存在 -> 不显示)');
    assert.ok(data.disks.every((d) => data.diskMountWhitelist.includes(d.mounted)), 'disks 全部应在白名单内');
    assert.strictEqual(data.disks[0].mounted, '/root/autodl-tmp', '白名单内按使用率降序');
    assert.strictEqual(data.disks[1].mounted, '/');
  });

  await test('fetchMonitorData: diskUnmatched 透传白名单外挂载点 (与 disks 同批 rows 划分)', async () => {
    const exec = makeMockExec({
      [C.load]: ' 12:34:56 up 1 day, load average: 0.52, 0.58, 0.59',
      [C.memory]: 'Mem:  16258316  3456789  12800000\n',
      [C.disks]: 'Filesystem      Size  Used Avail Use% Mounted on\n' +
                 '/dev/sda1  99G  45G  49G  48% /\n' +
                 '/dev/sda2  200G  150G  40G  79% /home\n' +
                 '/dev/sdb1  300G  290G   -1G 100% /root/autodl-tmp\n' +
                 '/dev/sdc1  100G  80G  20G  88% /root/autodl-fs\n' +
                 '/dev/sdd1  50G   1G  49G   2% /data\n',
      [C.cpu]: '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\n',
      [C.hostname]: 'web-01\n',
      [C.os]: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n',
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.disks.length, 3, '白名单内 3 个挂载点 (/, tmp, fs)');
    assert.strictEqual(data.diskUnmatched.length, 2, '白名单外 2 个挂载点透传 (/home, /data)');
    assert.deepStrictEqual(data.diskUnmatched.map((d) => d.mounted).sort(), ['/data', '/home']);
    assert.ok(data.diskUnmatched.every((d) => !data.diskMountWhitelist.includes(d.mounted)),
      'diskUnmatched 不应含白名单挂载点');
    assert.ok(data.diskUnmatched.some((d) => d.mounted === '/home' && d.usedPct === 79),
      'diskUnmatched 应保留完整 df 字段 (usedPct) 供调试区展示');
  });

  await test('fetchMonitorData: 单命令失败不阻塞 (top 抛错 -> cpu=null + errors.cpu; gpu 不受影响)', async () => {
    const exec = makeMockExec({
      [C.load]: ' 12:34:56 up 1 day, load average: 0.52, 0.58, 0.59',
      [C.memory]: 'Mem:  16258316  3456789  12800000\n',
      [C.disks]: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1  99G  45G  49G  48% /\n',
      [C.cpu]: new Error('top 不可用'),
      [C.hostname]: 'web-01\n',
      [C.os]: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: 'NVIDIA GeForce RTX 3080, 45, 5120, 10240, 67, 180.5\n',
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.cpu, null, 'top 失败时 cpu 应为 null');
    assert.ok(data.errors.cpu, '应有 errors.cpu 原因');
    assert.ok(data.memory, '内存指标不受影响');
    assert.ok(data.load, '负载指标不受影响');
    assert.strictEqual(data.disks.length, 1, '磁盘指标不受影响');
    assert.ok(data.gpu, 'GPU 指标不受 top 失败影响');
  });

  await test('fetchMonitorData: nvidia-smi 不存在 (command not found) -> gpu=null + errors.gpu, 不阻塞', async () => {
    const exec = makeMockExec({
      [C.load]: ' 12:34:56 up 1 day, load average: 0.52, 0.58, 0.59',
      [C.memory]: 'Mem:  16258316  3456789  12800000\n',
      [C.disks]: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1  99G  45G  49G  48% /\n',
      [C.cpu]: '%Cpu(s):  3.1 us,  0.7 sy,  0.0 ni, 95.8 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\n',
      [C.hostname]: 'web-01\n',
      [C.os]: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\n',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: new Error('nvidia-smi: command not found'),
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.gpu, null, 'nvidia-smi 不存在时 gpu 应为 null');
    assert.ok(data.errors.gpu, '应有 errors.gpu 原因');
    assert.ok(data.cpu, 'CPU 指标不受影响');
    assert.ok(data.memory, '内存指标不受影响');
  });

  await test('fetchMonitorData: 输出无法解析也降级为 null + errors', async () => {
    const exec = makeMockExec({
      [C.load]: 'weird output',
      [C.memory]: 'weird output',
      [C.disks]: 'weird output',
      [C.cpu]: 'weird output',
      [C.hostname]: 'web-01\n',
      [C.os]: 'weird output',
      [C.date]: '2026-08-12T10:00:00Z\n',
      [C.gpu]: 'weird output',
    });
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.load, null);
    assert.strictEqual(data.memory, null);
    assert.strictEqual(data.cpu, null);
    assert.strictEqual(data.gpu, null);
    assert.deepStrictEqual(data.disks, []);
    assert.ok(data.errors.load, '应有 errors.load');
    assert.ok(data.errors.memory, '应有 errors.memory');
    assert.ok(data.errors.cpu, '应有 errors.cpu');
    assert.ok(data.errors.gpu, '应有 errors.gpu (GPU 输出无法解析)');
    // 命令执行本身成功, 不抛整体异常
    assert.ok(data.info.hostname, 'hostname 仍可用');
  });

  await test('fetchMonitorData: 全部命令失败仍返回 (不抛), errors 记录全部', async () => {
    const exec = async () => { throw new Error('connection closed'); };
    const data = await fetchMonitorData({ exec, identity: 'root@1.2.3.4' });
    assert.strictEqual(data.load, null);
    assert.strictEqual(data.memory, null);
    assert.strictEqual(data.cpu, null);
    assert.strictEqual(data.gpu, null);
    assert.deepStrictEqual(data.disks, []);
    assert.strictEqual(Object.keys(data.errors).length, 8, '8 条命令均应记录错误');
  });

  await test('fetchMonitorData: exec 未注入 -> 抛错', async () => {
    await assert.rejects(() => fetchMonitorData({ identity: 'x' }), /exec/);
  });

  await test('fetchMonitorData: stderr 有输出时记录 errors 原因', async () => {
    const exec = async (command) => {
      if (command === C.cpu) return { stdout: '', stderr: 'top: failed', code: 1 };
      return { stdout: command === C.hostname ? 'h\n' : '', stderr: '', code: 0 };
    };
    const data = await fetchMonitorData({ exec, identity: 'x' });
    assert.strictEqual(data.cpu, null);
    assert.ok(data.errors.cpu, 'top stderr 应记录 errors.cpu');
  });

  // ---------- 8. main.js / preload.js / renderer.js / index.html 静态断言 ----------
  await test('main.js: 引入 health-parser + 提供 ssh:monitor:fetch handler + nvidia-smi 命令', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/require\('\.\/src\/health-parser'\)/.test(mainSrc), 'main.js 未引入 health-parser');
    assert.ok(/ipcMain\.handle\('ssh:monitor:fetch'/.test(mainSrc), '缺少 ssh:monitor:fetch handler');
    assert.ok(mainSrc.includes('function execSSHCommand'), '缺少 execSSHCommand');
    assert.ok(/monitor\.refresh/.test(mainSrc), '缺少 monitor.refresh 审计');
    assert.ok(mainSrc.includes('nvidia-smi'), 'main.js 应说明 nvidia-smi GPU 采集 (注释引用 MONITOR_COMMANDS.gpu)');
  });

  await test('health-parser: MONITOR_COMMANDS.gpu 为 nvidia-smi 固定 CSV 查询', () => {
    assert.strictEqual(C.gpu, parser.NVIDIA_SMI_QUERY, 'MONITOR_COMMANDS.gpu 应等于 NVIDIA_SMI_QUERY');
    assert.ok(/^nvidia-smi --query-gpu=name,utilization\.gpu,memory\.used,memory\.total,temperature\.gpu,power\.draw --format=csv,noheader,nounits$/.test(C.gpu), 'GPU 命令应为固定 CSV 格式');
  });

  await test('renderer.js: GPU 卡片 + 折线滚动窗口 + 内存 GB 格式化', () => {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    // GPU 卡片: 基本信息下方 + 降级文案
    assert.ok(rendererSrc.includes('未检测到 GPU 监控（需要 NVIDIA GPU + nvidia-smi）'), '缺少 GPU 降级文案');
    assert.ok(rendererSrc.includes('monitor-gpu-card'), '缺少 GPU 卡片容器 class');
    // 折线逻辑: 滚动窗口 + SVG 生成 + 每次刷新 push
    assert.ok(rendererSrc.includes('monitorGpuHistory'), '缺少 GPU 折线滚动窗口状态');
    assert.ok(rendererSrc.includes('buildGpuChartSvg'), '缺少 SVG 折线生成调用');
    assert.ok(rendererSrc.includes('pushMonitorGpuSample'), '缺少 GPU 采样追加函数');
    assert.ok(rendererSrc.includes('monitorGpuHistory.clear()'), '面板打开时应重置折线窗口');
    assert.ok(rendererSrc.includes('createGpuHistory({ max: 60 })'), '滚动窗口上限应为 60 点');
    // 内存 GB 格式化: 解析层保持 MB, 渲染层 formatGB(mb) -> GB
    assert.ok(rendererSrc.includes('function formatGB('), '缺少 formatGB 工具函数');
    assert.ok(rendererSrc.includes('(mb / 1024).toFixed(1) + \' GB\''), 'formatGB 应为 MB/1024 保留 1 位小数');
    assert.ok(rendererSrc.includes('formatGB(mem.usedMB)'), '已用内存应走 formatGB');
    assert.ok(rendererSrc.includes('formatGB(mem.totalMB)'), '总量内存应走 formatGB');
    assert.ok(!rendererSrc.includes('+ \' MB\''), '内存显示不应再出现 MB 后缀拼接');
  });

  await test('renderer.js: 磁盘渲染按 DISK_MOUNT_WHITELIST 过滤 (静态断言)', () => {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    // 白名单在 renderer 被引用 (单一事实源来自 health-parser, 经 IPC 透传)
    assert.ok(rendererSrc.includes('DISK_MOUNT_WHITELIST'), 'renderer 应引用 DISK_MOUNT_WHITELIST');
    assert.ok(rendererSrc.includes('res.diskMountWhitelist'), 'renderer 白名单应来自 monitorFetch 透传 (不重复硬编码)');
    // 磁盘渲染含白名单过滤逻辑 (基于挂载点字段 mounted)
    assert.ok(rendererSrc.includes('disks.filter((d) => DISK_MOUNT_WHITELIST.includes(d.mounted))'), '磁盘渲染应含白名单 filter');
    assert.ok(rendererSrc.includes('whitelistedDisks.map'), '磁盘列表应基于过滤后的数组渲染');
  });

  await test('renderer.js: 磁盘卡片含「未匹配白名单」调试区 (静态断言)', () => {
    const rendererSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    assert.ok(rendererSrc.includes('未匹配白名单'), '磁盘卡片应含未匹配白名单调试区标题');
    assert.ok(rendererSrc.includes('monitor-disk-unmatched'), '应含未匹配区容器 class (弱化样式)');
    assert.ok(rendererSrc.includes('res.diskUnmatched'), '未匹配区数据源应来自 res.diskUnmatched (解析层单遍划分)');
    assert.ok(rendererSrc.includes('unmatchedDisks.length > 0'), '未匹配区应在存在未匹配挂载点时渲染 (全部命中则隐藏)');
    assert.ok(rendererSrc.includes('escapeHtml(d.mounted)'), '未匹配区挂载点应 escapeHtml (防 XSS)');
    // 未匹配区不破坏白名单主区: 白名单过滤逻辑与列表渲染保持原样
    assert.ok(rendererSrc.includes('disks.filter((d) => DISK_MOUNT_WHITELIST.includes(d.mounted))'), '白名单主区过滤逻辑应保留');
    assert.ok(rendererSrc.includes('whitelistedDisks.map'), '白名单主区列表渲染应保留');
  });

  await test('index.html: 引入 gpu-chart.js + 监控面板元素存在 + 数据来源含 nvidia-smi', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    assert.ok(html.includes('id="btnMonitor"'), '缺少健康监控入口按钮');
    assert.ok(html.includes('id="monitorOverlay"'), '缺少 monitorOverlay 面板');
    assert.ok(html.includes('id="monitorRefreshBtn"'), '缺少刷新按钮');
    assert.ok(html.includes('id="monitorAutoToggle"'), '缺少自动刷新开关');
    assert.ok(html.includes('id="monitorCloseBtn"'), '缺少关闭按钮');
    assert.ok(html.includes('src="gpu-chart.js"'), '缺少 gpu-chart.js 脚本引入');
    assert.ok(html.includes('nvidia-smi'), '监控面板数据来源说明应含 nvidia-smi');
  });

  await test('preload.js: 暴露 monitorFetch 桥接', () => {
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    assert.ok(/monitorFetch:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\('ssh:monitor:fetch'/.test(preloadSrc), 'preload 缺少 monitorFetch');
  });

  console.log(`\nmonitor-test: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
