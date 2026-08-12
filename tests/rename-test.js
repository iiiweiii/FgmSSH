#!/usr/bin/env node
/**
 * FgmSSH - 软件更名回归测试 (rename-test)
 * 运行: node tests/rename-test.js
 *
 * 背景 (v1.1.0): 软件由 NimbusSSH 更名为 FgmSSH。
 * 覆盖:
 *   1. package.json: name=fgm-ssh / productName=FgmSSH / version=1.1.0 / build.productName=FgmSSH
 *   2. main.js: 窗口标题 / 托盘 tooltip / UPDATE_CHECK_CONFIG.repo / userData 注释 均为 FgmSSH
 *   3. 全仓无 NimbusSSH 显示名残留 (排除 window.nimbus / nimbus-preview / nimbus-doc /
 *      NimbusTheme / NIMBUS_DEV_DIAG / nimbus.theme / nimbus-doc- 等内部命名空间)
 *   4. userData 迁移逻辑 (src/userdata-migrate.js, 纯 node mock/真实 fs):
 *      - 旧目录存在 + 新目录不存在 -> 复制全部内容到新目录 (connections.json/known_hosts/logs/)
 *      - 旧目录不存在 -> 跳过 (全新安装)
 *      - 新目录已存在 -> 跳过 (幂等, 重复启动不覆盖)
 *      - 复制后旧目录保留 (防回退)
 *   5. main.js 在 app ready 早期调用迁移 (loadConnections 之前, 静态断言时序)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function readRoot(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function run() {
  // ---------- 1. package.json ----------
  await test('package.json: name=fgm-ssh / productName=FgmSSH / version=1.1.0', () => {
    const pkg = JSON.parse(readRoot('package.json'));
    assert.strictEqual(pkg.name, 'fgm-ssh', 'npm name 应为 fgm-ssh');
    assert.strictEqual(pkg.productName, 'FgmSSH', 'productName 应为 FgmSSH');
    assert.strictEqual(pkg.version, '1.1.0', '版本应 bump 到 1.1.0 (更名+功能变更, 触发更新检查提示)');
    assert.strictEqual(pkg.build.productName, 'FgmSSH', 'build.productName 应为 FgmSSH');
    assert.strictEqual(pkg.build.portable.artifactName, 'FgmSSH-${version}-portable.exe', '打包产物名应为 FgmSSH');
  });

  // ---------- 2. main.js 显示名 ----------
  await test('main.js: 窗口标题 / 托盘 tooltip / 更新仓库 / userData 注释均为 FgmSSH', () => {
    const src = readRoot('main.js');
    assert.ok(src.includes("title: 'FgmSSH - 现代化 SSH 客户端'"), '窗口标题应含 FgmSSH');
    assert.ok(src.includes("tray.setToolTip('FgmSSH - SSH 客户端')"), '托盘 tooltip 应含 FgmSSH');
    assert.ok(/repo:\s*'FgmSSH'/.test(src), 'UPDATE_CHECK_CONFIG.repo 应为 FgmSSH');
    assert.ok(src.includes('%APPDATA%/FgmSSH'), 'userData 注释应指向 %APPDATA%/FgmSSH');
    // 唯一允许的 NimbusSSH 引用 = 迁移用的旧目录名常量 (功能必需), 其余一律视为显示名残留
    const withoutMigrationConst = src.split("OLD_USER_DATA_DIR_NAME = 'NimbusSSH'").join('');
    assert.ok(!withoutMigrationConst.includes('NimbusSSH'), 'main.js 不得残留 NimbusSSH 显示名');
  });

  await test('main.js: 引入 userdata-migrate 并在 app ready 早期调用 (loadConnections 前)', () => {
    const src = readRoot('main.js');
    assert.ok(src.includes("require('./src/userdata-migrate')"), '应引入 userdata-migrate 模块');
    assert.ok(src.includes('migrateUserData({'), '应调用 migrateUserData');
    // 旧目录必须用「更名前产品名」字面量计算 (不依赖 getPath 旧值); 这是功能必需引用,
    // 不是显示名残留 —— 迁移若用当前 productName 计算旧路径将永远匹配不到旧目录。
    assert.ok(src.includes("OLD_USER_DATA_DIR_NAME = 'NimbusSSH'"), '应定义旧目录名常量 (更名前产品名)');
    assert.ok(src.includes("path.join(app.getPath('appData'), OLD_USER_DATA_DIR_NAME)"), '旧目录应通过 appData + 旧目录名常量计算');
    // 时序① (QA 复验 Bug 修复): 迁移必须是 userData 的第一次触碰 —— 必须在 initAuditLog 之前,
    // 否则 initAuditLog 内部 fs.mkdirSync(userData/logs, {recursive:true}) 会连带创建新 userData
    // 目录, 迁移将误判「新目录已存在」而跳过, 升级用户数据 (connections.json 等) 全部丢失。
    const migrateIdx = src.indexOf('userData 迁移 (v1.1.0 软件更名)');
    const initAuditLogIdx = src.indexOf("auditLog.initAuditLog({ dir: path.join(app.getPath('userData'), 'logs') })");
    assert.ok(migrateIdx !== -1 && initAuditLogIdx !== -1, '迁移与 initAuditLog 均应存在');
    assert.ok(migrateIdx < initAuditLogIdx, '迁移必须在 initAuditLog 之前 (initAuditLog 的 mkdirSync 会连带创建新 userData 目录)');
    // 时序②: 迁移调用出现在 whenReady 内的 createWindow() 调用之前 (窗口创建后渲染层才会 IPC 读配置);
    // 用 whenReady 专属连续调用模式定位, 避免误匹配 showMainWindow 里的 createWindow(); 调用。
    // loadConnections 函数在模块作用域定义 (早于 whenReady), 但只在 IPC (store:load) 被渲染层
    // 调用, 渲染层在窗口创建后才存在 —— 因此迁移(在 createWindow 前同步执行)必然先于任何读取。
    const readyCreateWindowIdx = src.indexOf('createWindow();\n  createTray();');
    assert.ok(readyCreateWindowIdx !== -1, 'whenReady 内 createWindow 应存在');
    assert.ok(migrateIdx < readyCreateWindowIdx, '迁移必须在 createWindow 之前 (窗口创建后渲染层才会 IPC 读配置)');
    assert.ok(src.includes("ipcMain.handle('store:load'"), 'store:load IPC 应存在 (迁移先于其运行时调用)');
  });

  // ---------- 3. 全仓显示名残留检查 ----------
  await test('全仓 (src/main/preload/tests/docs) 无 NimbusSSH 显示名残留 (排除内部命名空间)', () => {
    const skipPattern = /node_modules|dist-|build-out|_cacache|asar-check-tmp|\.git\//;
    const internalRefs = [
      'window.nimbus', "exposeInMainWorld('nimbus'", 'nimbus-preview', 'nimbus-doc',
      'NimbusTheme', 'NIMBUS_DEV_DIAG', 'nimbus.theme', 'nimbus-doc-',
      "'nimbus'", '"nimbus"', 'nimbus.', 'NimbusSSH', // 注意: NimbusSSH 不得出现; 其余为内部命名空间
    ];
    const walk = (dir) => {
      const out = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (skipPattern.test(full)) continue;
          out.push(...walk(full));
        } else if (/\.(js|html|md|json|css|bat)$/.test(name)) {
          // 排除本测试文件自身 (它必然引用旧名称以说明迁移背景)
          if (full === path.join(ROOT, 'tests', 'rename-test.js')) continue;
          out.push(full);
        }
      }
      return out;
    };
    const files = walk(ROOT);
    assert.ok(files.length > 10, '应扫描到足够的源码/测试/文档文件');
    let found = [];
    for (const f of files) {
      let src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      // 允许唯一功能必需引用: main.js 迁移用「更名前产品名」常量计算旧目录路径
      // (OLD_USER_DATA_DIR_NAME = 'NimbusSSH'); 除此之外出现 NimbusSSH 即视为显示名残留。
      src = src.split("OLD_USER_DATA_DIR_NAME = 'NimbusSSH'").join('');
      if (src.includes('NimbusSSH')) found.push(rel + ' (NimbusSSH)');
    }
    assert.deepStrictEqual(found, [], '发现 NimbusSSH 显示名残留: ' + JSON.stringify(found));
    // 反向确认: 内部命名空间未被误改
    const preloadSrc = readRoot('preload.js');
    assert.ok(preloadSrc.includes("contextBridge.exposeInMainWorld('nimbus'"), 'window.nimbus 命名空间应保留');
    const mainSrc = readRoot('main.js');
    assert.ok(mainSrc.includes("scheme: 'nimbus-preview'"), 'nimbus-preview 协议应保留');
    assert.ok(mainSrc.includes("scheme: 'nimbus-doc'"), 'nimbus-doc 协议应保留');
  });

  // ---------- 4. userData 迁移逻辑 (真实 fs + 临时目录) ----------
  await test('迁移: 旧目录存在 + 新目录不存在 -> 复制全部内容 (connections.json/logs/) 且旧目录保留', () => {
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const oldDir = path.join(base, 'NimbusSSH');
    const newDir = path.join(base, 'FgmSSH');
    fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'connections.json'), '{"encrypted":true}');
    fs.writeFileSync(path.join(oldDir, 'known_hosts.json'), '[]');
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"autoCheckUpdate":true}');
    fs.writeFileSync(path.join(oldDir, 'logs', 'audit-2026-08-12.jsonl'), '{"a":1}\n');
    const logs = [];
    const res = migrateUserData({ fs, path, oldDir, newDir, log: (m) => logs.push(m) });
    assert.strictEqual(res.migrated, true, '应执行迁移');
    assert.strictEqual(res.reason, 'migrated');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'connections.json'), 'utf8'), '{"encrypted":true}');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'known_hosts.json'), 'utf8'), '[]');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"autoCheckUpdate":true}');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'logs', 'audit-2026-08-12.jsonl'), 'utf8'), '{"a":1}\n');
    // 旧目录保留 (防回退)
    assert.ok(fs.existsSync(oldDir), '迁移后旧目录应保留');
    assert.ok(fs.existsSync(path.join(oldDir, 'connections.json')), '旧目录 connections.json 应保留');
    assert.ok(logs.some((m) => m.includes('复制')), '应有复制审计日志');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('迁移: 旧目录不存在 -> 跳过 (全新安装)', () => {
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const newDir = path.join(base, 'FgmSSH');
    const logs = [];
    const res = migrateUserData({ fs, path, oldDir: path.join(base, 'NimbusSSH'), newDir, log: (m) => logs.push(m) });
    assert.strictEqual(res.migrated, false, '旧目录不存在应跳过');
    assert.strictEqual(res.reason, 'old_missing');
    assert.ok(!fs.existsSync(newDir), '不应创建新目录');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('迁移: 新目录已含真实 connections.json -> 跳过 (幂等, 不覆盖用户数据)', () => {
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const oldDir = path.join(base, 'NimbusSSH');
    const newDir = path.join(base, 'FgmSSH');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'connections.json'), '{"encrypted":true}');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'connections.json'), '{"encrypted":"user-edited"}');
    const logs = [];
    const res = migrateUserData({ fs, path, oldDir, newDir, log: (m) => logs.push(m) });
    assert.strictEqual(res.migrated, false, '新目录已有真实 connections.json 应跳过');
    assert.strictEqual(res.reason, 'new_exists');
    // 新目录内容不被覆盖 (幂等保护用户后续写入)
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'connections.json'), 'utf8'), '{"encrypted":"user-edited"}');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('迁移: 新目录被 initAuditLog 副作用连带创建 (空目录, 模拟 mkdirSync recursive) -> 迁移仍执行且数据复制成功', () => {
    // QA 复验 Bug 复现: audit-log 的 initAuditLog 内部 fs.mkdirSync(userData/logs, {recursive:true})
    // 会连带创建新 userData 目录 (存在但为空)。旧逻辑「新目录存在即跳过」会导致升级用户数据丢失;
    // 强化后按「新目录中关键文件 connections.json 缺失」判断, 应继续迁移。
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const oldDir = path.join(base, 'NimbusSSH');
    const newDir = path.join(base, 'FgmSSH');
    fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'connections.json'), '{"encrypted":true}');
    fs.writeFileSync(path.join(oldDir, 'known_hosts.json'), '[]');
    fs.writeFileSync(path.join(oldDir, 'logs', 'audit-2026-08-12.jsonl'), '{"a":1}\n');
    // 模拟 initAuditLog 副作用: 先创建新目录 (含 userData/logs 子目录), 但无任何真实数据
    fs.mkdirSync(path.join(newDir, 'logs'), { recursive: true });
    assert.ok(fs.existsSync(newDir), '前置: 新目录已被连带创建');
    assert.ok(!fs.existsSync(path.join(newDir, 'connections.json')), '前置: 新目录无 connections.json');
    const logs = [];
    const res = migrateUserData({ fs, path, oldDir, newDir, log: (m) => logs.push(m) });
    assert.strictEqual(res.migrated, true, '新目录虽存在但无真实数据, 应执行迁移');
    assert.strictEqual(res.reason, 'migrated');
    // 数据复制成功 (升级用户凭据/配置不丢失)
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'connections.json'), 'utf8'), '{"encrypted":true}');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'known_hosts.json'), 'utf8'), '[]');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'logs', 'audit-2026-08-12.jsonl'), 'utf8'), '{"a":1}\n');
    // 旧目录保留
    assert.ok(fs.existsSync(path.join(oldDir, 'connections.json')), '旧目录 connections.json 应保留');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('迁移: 新目录存在且仅含非关键文件 (无 connections.json) -> 迁移仍执行', () => {
    // 边界: 新目录被连带创建后, 若 audit-log 已写入 (logs/ 非空) 但仍无 connections.json,
    // 强化逻辑仍应迁移 (关键文件缺失优先), 保证升级用户凭据不丢失。
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const oldDir = path.join(base, 'NimbusSSH');
    const newDir = path.join(base, 'FgmSSH');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'connections.json'), '{"encrypted":true}');
    fs.mkdirSync(path.join(newDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'logs', 'audit-2026-08-12.jsonl'), '{"new-run":1}\n'); // 新日志 (非关键)
    const res = migrateUserData({ fs, path, oldDir, newDir });
    assert.strictEqual(res.migrated, true, '新目录无 connections.json (关键文件缺失) 时应迁移');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'connections.json'), 'utf8'), '{"encrypted":true}');
    fs.rmSync(base, { recursive: true, force: true });
  });

  await test('迁移: 第二次调用幂等 (首次迁移后再启动 -> new_exists 跳过)', () => {
    const { migrateUserData } = require('../src/userdata-migrate');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgmssh-rename-test-'));
    const oldDir = path.join(base, 'NimbusSSH');
    const newDir = path.join(base, 'FgmSSH');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'connections.json'), '{"encrypted":true}');
    const r1 = migrateUserData({ fs, path, oldDir, newDir });
    assert.strictEqual(r1.migrated, true, '首次应迁移');
    const r2 = migrateUserData({ fs, path, oldDir, newDir });
    assert.strictEqual(r2.migrated, false, '第二次应跳过');
    assert.strictEqual(r2.reason, 'new_exists');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'connections.json'), 'utf8'), '{"encrypted":true}');
    fs.rmSync(base, { recursive: true, force: true });
  });

  // ---------- 5. 磁盘/主题改动联动 (更名不破坏) ----------
  await test('回归联动: health-parser 不再透传白名单字段; renderer 直接渲染 res.disks', () => {
    const parser = require('../src/health-parser');
    assert.ok(Array.isArray(parser.DISK_MOUNT_WHITELIST), 'DISK_MOUNT_WHITELIST 导出仍保留 (兼容)');
    const rendererSrc = readRoot('src/renderer.js');
    assert.ok(!rendererSrc.includes('res.diskMountWhitelist'), 'renderer 无白名单残留');
    assert.ok(rendererSrc.includes('currentXtermTheme()'), 'renderer 终端主题跟随当前主题');
  });

  console.log('\n==== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ====');
  process.exit(failed > 0 ? 1 : 0);
}

run();
