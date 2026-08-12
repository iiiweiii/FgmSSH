#!/usr/bin/env node
/**
 * NimbusSSH - Roadmap 第一梯队 ③ (S) 更新检查 测试 (node 直跑, 无需 Electron)
 *
 * 1) 版本比较 compareVersions:
 *    - 新/旧/相同 / v 前缀归一化 / 预发布 tag (v1.2.3-beta.1) 解析 / 非语义化回退
 * 2) 检查器 createUpdateChecker (注入 fetch mock, 无真实网络):
 *    - 成功发现新版 -> hasUpdate:true + latest/url + 审计 success
 *    - 无新版 -> hasUpdate:false + 审计 success
 *    - 失败 (HTTP/网络/超时) -> ok:false 静默 (不抛异常, 审计 failure)
 *    - 无 tag -> 失败
 *    - autoCheck=false -> start() 不排程 (无定时器)
 *    - start() 延迟 + 周期排程 (注入假定时器)
 *    - stop() 清理定时器
 * 3) 静态断言 (真实源码):
 *    - main.js UPDATE_CHECK_CONFIG / settings autoCheckUpdate / startUpdateChecker /
 *      broadcastUpdateCheck / settings:load/save IPC
 *    - preload.js onUpdateCheck
 *    - renderer.js showUpdateBadge / initUpdateCheck
 *
 * 用法: node tests/updatecheck-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const uc = require('../src/update-check');

const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const rendererSrc = read('src/renderer.js');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

async function run() {

// ================= 版本比较 =================
section('版本比较: compareVersions');
{
  check('新版 > 旧版', uc.compareVersions('v1.2.3', 'v1.2.2') === 1);
  check('旧版 < 新版', uc.compareVersions('1.0.0', '1.0.1') === -1);
  check('相同版本', uc.compareVersions('1.2.3', 'v1.2.3') === 0);
  check('主版本优先', uc.compareVersions('2.0.0', '1.99.99') === 1);
  check('次版本优先', uc.compareVersions('1.10.0', '1.9.9') === 1);
  check('补丁版本优先', uc.compareVersions('1.2.10', '1.2.9') === 1);
  check('v 前缀归一化', uc.compareVersions('v1.2.3', '1.2.3') === 0);
  check('大写 V 前缀归一化', uc.compareVersions('V1.2.3', 'v1.2.3') === 0);
}

section('版本比较: 预发布 tag 解析');
{
  check('正式版 > 预发布', uc.compareVersions('v1.2.3', 'v1.2.3-beta.1') === 1);
  check('预发布 < 正式版', uc.compareVersions('v1.2.3-beta.1', 'v1.2.3') === -1);
  check('预发布数字递增', uc.compareVersions('v1.2.3-beta.2', 'v1.2.3-beta.1') === 1);
  check('预发布 beta > alpha', uc.compareVersions('v1.2.3-beta.1', 'v1.2.3-alpha.5') === 1);
  check('预发布同段相等', uc.compareVersions('v1.2.3-rc.1', '1.2.3-rc.1') === 0);
  check('预发布段缺省更小', uc.compareVersions('v1.2.3-beta', 'v1.2.3-beta.1') === -1);
}

section('版本比较: 非语义化回退');
{
  check('非语义化按字符串比较 (a<b)', uc.compareVersions('1.0', '1.0.0') !== 0);
  check('空 tag 比较安全', typeof uc.compareVersions('', 'v1.0.0') === 'number');
  check('non-version 与 semver 比较不抛异常', typeof uc.compareVersions('release-2024', 'v1.0.0') === 'number');
}

// ================= 检查器逻辑 (fetch mock) =================
section('检查器: 成功发现新版');
{
  const audits = [];
  let result = null;
  const checker = uc.createUpdateChecker({
    initialDelayMs: 0,
    getVersion: () => '1.0.0',
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v1.2.0', html_url: 'https://github.com/a/b/releases/tag/v1.2.0' }),
    }),
    audit: (r) => audits.push(r),
    onResult: (r) => { result = r; },
  });
  checker.start(); // scheduler 路径: 延迟 0 -> 立即检查 -> audit + onResult
  await new Promise((r) => setTimeout(r, 20));
  checker.stop();
  check('audit 回调收到同一结果 (hasUpdate:true)', audits.length === 1 && audits[0].hasUpdate === true);
  check('onResult 回调收到同一结果', !!result && result.ok === true);
  // checkOnce 直接调用仍可用且结果正确
  const res = await checker.checkOnce();
  check('ok:true', res.ok === true);
  check('hasUpdate:true', res.hasUpdate === true);
  check('latest=1.2.0 (tag_name 原样)', res.latest === 'v1.2.0');
  check('current=1.0.0', res.current === '1.0.0');
  check('url=releases 页', res.url === 'https://github.com/a/b/releases/tag/v1.2.0');
}

section('检查器: 无新版 (静默, 审计 success)');
{
  const audits = [];
  const checker = uc.createUpdateChecker({
    initialDelayMs: 0,
    getVersion: () => '1.2.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.0', html_url: '' }) }),
    audit: (r) => audits.push(r),
  });
  checker.start();
  await new Promise((r) => setTimeout(r, 20));
  checker.stop();
  const res = await checker.checkOnce();
  check('ok:true', res.ok === true);
  check('hasUpdate:false', res.hasUpdate === false);
  check('audit success 且无 update', audits.length === 1 && audits[0].ok === true && audits[0].hasUpdate === false);
}

section('检查器: 失败静默 (HTTP 错误 / 网络异常 / 超时 / 无 tag)');
{
  const httpFail = uc.createUpdateChecker({ getVersion: () => '1.0.0', fetchFn: async () => ({ ok: false, status: 404 }) });
  const r1 = await httpFail.checkOnce();
  check('HTTP 404 -> ok:false 不抛异常', r1.ok === false && !!r1.error);

  const netFail = uc.createUpdateChecker({ getVersion: () => '1.0.0', fetchFn: async () => { throw new Error('ENOTFOUND offline'); } });
  const r2 = await netFail.checkOnce();
  check('网络异常 -> ok:false 静默', r2.ok === false && /offline/.test(r2.error));

  const timeout = uc.createUpdateChecker({
    getVersion: () => '1.0.0',
    timeoutMs: 10,
    fetchFn: (url, init) => new Promise((resolve, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }
      // 永不 resolve: 靠 AbortController 超时中断
    }),
  });
  const r3 = await timeout.checkOnce();
  check('超时 -> ok:false 静默', r3.ok === false);

  const noTag = uc.createUpdateChecker({ getVersion: () => '1.0.0', fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  const r4 = await noTag.checkOnce();
  check('无 tag_name -> ok:false 静默', r4.ok === false);
}

section('检查器: 检查开关 (autoCheck) 与定时器');
{
  let timeoutCalls = 0;
  let intervalCalls = 0;
  let checked = 0;
  const checker = uc.createUpdateChecker({
    autoCheck: false,
    getVersion: () => '1.0.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.1' }) }),
    onResult: () => { checked++; },
    setTimeoutFn: (fn, ms) => { timeoutCalls++; return { id: 't' + timeoutCalls, fn }; },
    clearTimeoutFn: () => {},
    setIntervalFn: (fn, ms) => { intervalCalls++; return { id: 'i' + intervalCalls, fn }; },
    clearIntervalFn: () => {},
  });
  checker.start();
  check('autoCheck=false -> 不排程定时器', timeoutCalls === 0 && intervalCalls === 0);
  checker.stop();

  const checker2 = uc.createUpdateChecker({
    autoCheck: true,
    initialDelayMs: 100,
    intervalMs: 1000,
    getVersion: () => '1.0.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.1' }) }),
    onResult: () => { checked++; },
    setTimeoutFn: (fn, ms) => { timeoutCalls++; return { id: 't' + timeoutCalls, fn }; },
    clearTimeoutFn: () => {},
    setIntervalFn: (fn, ms) => { intervalCalls++; return { id: 'i' + intervalCalls, fn }; },
    clearIntervalFn: () => {},
  });
  checker2.start();
  check('autoCheck=true -> 排程首次延迟检查', timeoutCalls === 1);
  // 手动触发首次延迟回调 (模拟定时器到点)
  checker2.stop();
  check('stop() 后不新增排程', timeoutCalls === 1 && intervalCalls === 0);

  // 直接验证 start 内部 runAndSchedule: 延迟为 0 时立即检查 + 排程周期
  let immediateChecked = 0;
  let immediateInterval = 0;
  const checker3 = uc.createUpdateChecker({
    autoCheck: true,
    initialDelayMs: 0,
    intervalMs: 500,
    getVersion: () => '1.0.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.1' }) }),
    onResult: () => { immediateChecked++; },
    setIntervalFn: (fn, ms) => { immediateInterval++; return { id: 'i' }; },
    clearIntervalFn: () => {},
  });
  checker3.start();
  // 等待微任务完成 (checkOnce 是 async)
  await new Promise((r) => setTimeout(r, 20));
  check('initialDelay=0 -> 立即执行首次检查', immediateChecked === 1, 'checked=' + immediateChecked);
  check('initialDelay=0 -> 排程周期检查', immediateInterval === 1);
  checker3.stop();
}

// ================= 静态断言 =================
section('静态断言: main.js (更新检查接入)');
{
  check('UPDATE_CHECK_CONFIG 常量 (owner/repo 占位)', /UPDATE_CHECK_CONFIG\s*=\s*\{[\s\S]*?owner:\s*['"]nimbus-ssh['"]/.test(mainSrc));
  check('settings.json 全局设置 (autoCheckUpdate)', /SETTINGS_FILE\s*=\s*path\.join\(app\.getPath\(['"]userData['"]\),\s*['"]settings\.json['"]\)/.test(mainSrc));
  check('loadGlobalSettings 默认 autoCheckUpdate=true', /autoCheckUpdate:\s*parsed\.autoCheckUpdate\s*!==\s*false/.test(mainSrc));
  check('startUpdateChecker 在 app ready 调用', /startUpdateChecker\(\);/.test(mainSrc));
  check('启动延迟 4s (不阻塞启动)', /initialDelayMs:\s*4000/.test(mainSrc));
  check('间隔 24h', /intervalMs:\s*24\s*\*\s*3600\s*\*\s*1000/.test(mainSrc));
  check('请求超时 5s', /timeoutMs:\s*5000/.test(mainSrc));
  check('broadcastUpdateCheck 发送 update:check 事件', /webContents\.send\(['"]update:check['"]/.test(mainSrc));
  check('审计 update.check', /type:\s*['"]update\.check['"]/.test(mainSrc));
  check('settings:load IPC', /ipcMain\.handle\(['"]settings:load['"]/.test(mainSrc));
  check('settings:save IPC 且启停检查器', /ipcMain\.handle\(['"]settings:save['"][\s\S]*?applyUpdateCheckSetting\(\)/.test(mainSrc));
  check('检查失败静默 (failure 审计, 不广播)', /result:\s*'failure',\s*\n\s*detail:\s*'更新检查失败/.test(mainSrc));
  check('不自动升级 (无自动下载逻辑)', !/autoDownload|autoUpdat[e]?\(/.test(mainSrc));
}

section('静态断言: preload.js + renderer.js (更新提示 UI)');
{
  check('preload 暴露 onUpdateCheck', /onUpdateCheck:\s*\(cb\)\s*=>\s*ipcRenderer\.on\(['"]update:check['"]/.test(preloadSrc));
  check('preload 暴露 settingsLoad/settingsSave', /settingsLoad:\s*\(\)\s*=>/.test(preloadSrc) && /settingsSave:\s*\(settings\)\s*=>/.test(preloadSrc));
  check('renderer showUpdateBadge 函数', /function\s+showUpdateBadge\s*\(/.test(rendererSrc));
  check('renderer initUpdateCheck 绑定事件', /function\s+initUpdateCheck\s*\(/.test(rendererSrc));
  check('renderer 顶栏徽标 id updateBadge', /getElementById\(['"]updateBadge['"]\)|\$\('#updateBadge'\)/.test(rendererSrc));
  check('renderer 点击徽标 openExternal', /window\.nimbus\.openExternal\(url\)/.test(rendererSrc));
  check('renderer 无新版/失败不显示徽标 (hasUpdate 守卫)', /!payload\.hasUpdate/.test(rendererSrc));
  // B3 回归: GitHub tag_name 自带 v 前缀, 拼接前先去重 (发现新版本 vv2.0.1 -> v2.0.1)
  check('renderer 徽标版本去重 (v 前缀不重复)', /version\.startsWith\(['"]v['"]\)\s*\?\s*version\s*:\s*['"]v['"]\s*\+\s*version/.test(rendererSrc));
}

// ================= 汇总 =================
console.log(`\n==== 结果: ${passed} 通过, ${failed} 失败 ====`);
if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(2);
});
