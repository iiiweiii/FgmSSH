#!/usr/bin/env node
/**
 * FgmSSH - 更新检查真实仓库配置 静态断言测试 (node 直跑, 无 Electron)
 * 运行: node tests/updatecheck-config-test.js
 *
 * 背景 (Roadmap 第一梯队 ③, S): UPDATE_CHECK_CONFIG 从占位符 (nimbus-ssh/nimbus-ssh)
 * 替换为真实 GitHub 仓库 (iiiweiii/FgmSSH; v1.1.0 软件更名)。
 * 发布新版本时创建 tag 即触发更新提醒。
 *
 * 覆盖:
 *   1. main.js UPDATE_CHECK_CONFIG.owner === 'iiiweiii' / repo === 'FgmSSH'
 *   2. main.js / src/update-check.js 不再含 'fgm-ssh' 占位 owner/repo (配置引用)
 *   3. settings.json autoCheckUpdate 开关链路 (settings:load/save + applyUpdateCheckSetting) 不受影响
 *   4. 行为一致性: startUpdateChecker 仍从 UPDATE_CHECK_CONFIG 读取 owner/repo 传给检查器
 *   5. 运行时行为: createUpdateChecker 使用注入 owner/repo 构造 GitHub API URL (真实仓库)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const uc = require('../src/update-check');

const mainSrc = read('main.js');
const updateSrc = read('src/update-check.js');
const preloadSrc = read('preload.js');

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

async function run() {
  section('UPDATE_CHECK_CONFIG 真实仓库 (无占位残留)');
  {
    const m = mainSrc.match(/UPDATE_CHECK_CONFIG\s*=\s*\{([\s\S]*?)\n\};/);
    check('UPDATE_CHECK_CONFIG 常量存在', !!m);
    const block = (m && m[1]) || '';
    check('owner = iiiweiii', /owner:\s*['"]iiiweiii['"]/.test(block), block.trim());
    check('repo = FgmSSH', /repo:\s*['"]FgmSSH['"]/.test(block), block.trim());
    check('不再含 fgm-ssh 占位', !/fgm-ssh/.test(block), block.trim());
    check('不再含 TODO 占位注释', !/TODO/.test(block), block.trim());
    check('配置注释指向真实 GitHub 仓库', /github\.com\/iiiweiii\/FgmSSH/.test(mainSrc.slice(0, mainSrc.indexOf('UPDATE_CHECK_CONFIG'))));
    check('注释说明创建 tag 触发提醒', /tag/.test(mainSrc.slice(0, mainSrc.indexOf('UPDATE_CHECK_CONFIG'))));
  }

  section('update-check.js 默认配置同步 (无占位残留)');
  {
    const d = uc.DEFAULT_CONFIG;
    check('DEFAULT_CONFIG.owner = iiiweiii', d.owner === 'iiiweiii', d.owner);
    check('DEFAULT_CONFIG.repo = FgmSSH', d.repo === 'FgmSSH', d.repo);
    check('update-check.js 源码不再以 fgm-ssh 作为 owner/repo', !/owner:\s*['"]fgm-ssh['"]|repo:\s*['"]fgm-ssh['"]/.test(updateSrc));
  }

  section('settings autoCheckUpdate 开关链路不受影响');
  {
    check('SETTINGS_FILE 仍指向 userData/settings.json', /SETTINGS_FILE\s*=\s*path\.join\(app\.getPath\(['"]userData['"]\),\s*['"]settings\.json['"]\)/.test(mainSrc));
    check('loadGlobalSettings 默认 autoCheckUpdate=true', /autoCheckUpdate:\s*parsed\.autoCheckUpdate\s*!==\s*false/.test(mainSrc));
    check('startUpdateChecker 从 UPDATE_CHECK_CONFIG 读取 owner/repo', /owner:\s*UPDATE_CHECK_CONFIG\.owner[\s\S]*?repo:\s*UPDATE_CHECK_CONFIG\.repo/.test(mainSrc));
    check('settings:load IPC', /ipcMain\.handle\(['"]settings:load['"]/.test(mainSrc));
    check('settings:save IPC 且启停检查器', /ipcMain\.handle\(['"]settings:save['"][\s\S]*?applyUpdateCheckSetting\(\)/.test(mainSrc));
    check('preload 暴露 settingsLoad/settingsSave', /settingsLoad:\s*\(\)\s*=>/.test(preloadSrc) && /settingsSave:\s*\(settings\)\s*=>/.test(preloadSrc));
  }

  section('运行时行为: 检查器使用注入的真实仓库 URL');
  {
    const checker = uc.createUpdateChecker({
      owner: 'iiiweiii', repo: 'FgmSSH',
      getVersion: () => '1.0.0',
      fetchFn: async () => ({ ok: false, status: 404 }),
    });
    const apiUrl = checker.apiUrl();
    const webUrl = checker.releasesUrl();
    check('GitHub API URL 指向真实仓库', apiUrl === 'https://api.github.com/repos/iiiweiii/FgmSSH/releases/latest', apiUrl);
    check('Releases 页面 URL 指向真实仓库', webUrl === 'https://github.com/iiiweiii/FgmSSH/releases', webUrl);
    // 版本逻辑: 当前 app 版本与最新 tag 相同 -> 不提示 (发布 v1.0.0 基线时不误报)
    const same = uc.createUpdateChecker({
      owner: 'iiiweiii', repo: 'FgmSSH',
      getVersion: () => '1.0.0',
      fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.0', html_url: '' }) }),
    });
    await same.checkOnce().then((res) => {
      check('tag 与当前版本相同 -> 不提示', res.ok === true && res.hasUpdate === false);
      // 未来更高 tag -> 提示
      const newer = uc.createUpdateChecker({
        owner: 'iiiweiii', repo: 'FgmSSH',
        getVersion: () => '1.0.0',
        fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.1.0', html_url: '' }) }),
      });
      return newer.checkOnce();
    }).then((res) => {
      check('更高 tag -> 提示有新版本', res.ok === true && res.hasUpdate === true);
      check('latest 原样返回 tag', res.latest === 'v1.1.0');
    });
  }

  console.log('\n==== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ====');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(2);
});
