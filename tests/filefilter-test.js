#!/usr/bin/env node
/**
 * FgmSSH - Roadmap 第三梯队 ① SFTP 文件搜索/过滤 测试 (node 直跑, 无需 Electron)
 *
 * 1) 客户端过滤逻辑 (src/file-filter.js):
 *    - 子串不区分大小写 / 清空恢复全部 / 空目录 / 特殊字符正则安全 (子串非正则)
 *    - matchRange 命中区间 (高亮用)
 * 2) 递归搜索逻辑:
 *    - buildFindCommand 防注入断言 (关键字白名单/引号包裹/maxdepth 钳制/cwd 校验)
 *    - parseFindOutput 解析 (绝对路径/./前缀/cwd 自身/去重/截断)
 * 3) 静态断言 (真实源码):
 *    - renderer.js 搜索输入绑定 / renderFileList 过滤 / 递归开关 / Esc 清空
 *    - main.js sftp:search handler (execSSHCommand 超时+64KB / 降级 / 审计)
 *    - preload.js sftpSearch 桥接
 *
 * 用法: node tests/filefilter-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const fileFilter = require('../src/file-filter');

const rendererSrc = read('src/renderer.js');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const htmlSrc = read('src/index.html');

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

// ================= 客户端过滤逻辑 =================
section('客户端过滤: filterEntries');
{
  const entries = [
    { name: 'README.md', isDir: false },
    { name: 'src', isDir: true },
    { name: 'App.js', isDir: false },
    { name: 'app.log', isDir: false },
    { name: '中文文件.txt', isDir: false },
  ];
  const filtered = fileFilter.filterEntries(entries, 'APP');
  check('不区分大小写子串', filtered.length === 2 && filtered.every((x) => /app/i.test(x.name)), JSON.stringify(filtered.map((x) => x.name)));
  check('过滤不影响目录结构 (仅返回子集)', entries.length === 5);
  check('清空恢复全部 (返回副本, 顺序不变)', fileFilter.filterEntries(entries, '').length === entries.length);
  check('空关键字返回副本非原引用', fileFilter.filterEntries(entries, '') !== entries);
  check('空目录返回空数组', Array.isArray(fileFilter.filterEntries([], 'x')) && fileFilter.filterEntries([], 'x').length === 0);
  check('非数组返回空数组', Array.isArray(fileFilter.filterEntries(null, 'x')) && fileFilter.filterEntries(null, 'x').length === 0);
}

section('客户端过滤: 特殊字符正则安全 (子串匹配, 非正则)');
{
  const entries = [
    { name: 'a.b(c)d', isDir: false },
    { name: 'aXbXcXd', isDir: false },
    { name: 'file[1].txt', isDir: false },
    { name: 'file1.txt', isDir: false },
  ];
  // 正则元字符应按字面量匹配, 不得按正则语义 (a.b 匹配任意字符)
  const r1 = fileFilter.filterEntries(entries, 'a.b(c)d');
  check('正则元字符字面匹配', r1.length === 1 && r1[0].name === 'a.b(c)d');
  const r2 = fileFilter.filterEntries(entries, '[1]');
  check('方括号字面匹配', r2.length === 1 && r2[0].name === 'file[1].txt');
  const r3 = fileFilter.filterEntries(entries, 'file1');
  check('普通子串匹配 file1.txt', r3.length === 1 && r3[0].name === 'file1.txt');
  check('CJK 子串', fileFilter.filterEntries([{ name: '中文文件.txt' }], '文').length === 1);
}

section('客户端过滤: matchRange (高亮命中区间)');
{
  check('命中区间定位', JSON.stringify(fileFilter.matchRange('HelloWorld.txt', 'world')) === JSON.stringify({ start: 5, end: 10 }));
  check('未命中返回 null', fileFilter.matchRange('abc', 'xyz') === null);
  check('空关键字返回 null', fileFilter.matchRange('abc', '') === null);
  check('非字符串返回 null', fileFilter.matchRange(null, 'a') === null);
}

// ================= 递归搜索命令构造 =================
section('递归搜索: buildFindCommand 防注入');
{
  const cmd = fileFilter.buildFindCommand('/var/log', 'nginx', { maxDepth: 2 });
  check('命令结构正确', !!cmd && /^find '\/var\/log' -maxdepth 2 -iname '\*nginx\*' -print$/.test(cmd), String(cmd));

  // 注入面检查: 命令中不得出现命令分隔/展开/重定向元字符 (单引号为安全引号机制, 允许)
  const NO_INJECT = /[;`$()&|<>\\\n]/;
  const inj = fileFilter.buildFindCommand('/etc', "'; rm -rf /; '", { maxDepth: 3 });
  check('注入关键字被白名单过滤 (分号/引号剔除, 无注入面)', inj === null || !NO_INJECT.test(inj), String(inj));
  const inj2 = fileFilter.buildFindCommand('/etc', '$(reboot) & cat /etc/passwd', { maxDepth: 3 });
  check('shell 元字符整体剔除 (命令内无注入面)', inj2 === null || !NO_INJECT.test(inj2), String(inj2));

  const withSpace = fileFilter.buildFindCommand('/home/user', 'my file', { maxDepth: 2 });
  check('含空格关键字 -> 白名单剔除后命令内无注入面', withSpace === null || !NO_INJECT.test(withSpace), String(withSpace));

  const clean = fileFilter.buildFindCommand('/data', 'report_v2.1-final', { maxDepth: 3 });
  check('白名单字符 (字母数字._-) 保留', !!clean && clean.includes("'*report_v2.1-final*'"), String(clean));

  check('maxdepth 4 钳制到 3', !!fileFilter.buildFindCommand('/', 'x', { maxDepth: 4 }) && fileFilter.buildFindCommand('/', 'x', { maxDepth: 4 }).includes('-maxdepth 3'));
  check('maxdepth 0 钳制到 1', !!fileFilter.buildFindCommand('/', 'x', { maxDepth: 0 }) && fileFilter.buildFindCommand('/', 'x', { maxDepth: 0 }).includes('-maxdepth 1'));
  check('maxdepth 缺省为 3', fileFilter.buildFindCommand('/', 'x', {}).includes('-maxdepth 3'));

  check('相对路径 cwd 拒绝', fileFilter.buildFindCommand('var/log', 'x') === null);
  check('.. 段 cwd 拒绝', fileFilter.buildFindCommand('/a/../b', 'x') === null);
  check('空 cwd 拒绝', fileFilter.buildFindCommand('', 'x') === null);
  check('空关键字拒绝', fileFilter.buildFindCommand('/a', '   ') === null);
  check('超长关键字拒绝', fileFilter.buildFindCommand('/a', 'x'.repeat(100)) === null);

  const cwdQuoted = fileFilter.buildFindCommand("/a'b", 'x', { maxDepth: 2 });
  check("cwd 单引号转义 (a'b)", !!cwdQuoted && cwdQuoted.includes("'/a'\\''b'"), String(cwdQuoted));

  const cjk = fileFilter.buildFindCommand('/data', '日志', { maxDepth: 3 });
  check('CJK 关键字保留', !!cjk && cjk.includes("'*日志*'"), String(cjk));
}

section('递归搜索: parseFindOutput');
{
  const out = [
    '/var/log/nginx/access.log',
    '/var/log/nginx/error.log',
    '/var/log/nginx',           // cwd 自身 -> 过滤
    'Permission denied',        // 权限提示 -> 过滤
    './relative.log',           // ./ 前缀 -> 归一化
    'not-absolute',             // 非绝对路径 -> 过滤
    '',
  ].join('\n');
  const results = fileFilter.parseFindOutput(out, '/var/log/nginx');
  check('解析 3 条有效结果 (cwd/权限/相对路径外 4 条过滤)', results.length === 3, 'got ' + results.length + ' ' + JSON.stringify(results));
  check('包含 access.log', results.some((r) => r.path === '/var/log/nginx/access.log'));
  check('./ 前缀归一化为绝对路径', results.some((r) => r.path === '/var/log/nginx/relative.log'));
  check('name/dir 拆分正确', results.some((r) => r.name === 'access.log' && r.dir === '/var/log/nginx'));
  const dedupe = fileFilter.parseFindOutput('/a/b.txt\n/a/b.txt\n/a/b.txt', '/a');
  check('去重', dedupe.length === 1);
  const many = fileFilter.parseFindOutput(Array.from({ length: 300 }, (_, i) => `/a/f${i}.txt`).join('\n'), '/a');
  check('结果截断到 MAX_RESULTS', many.length === fileFilter.MAX_RESULTS);
}

// ================= 静态断言 =================
section('静态断言: renderer.js (客户端过滤 + 递归搜索 UI)');
{
  check('搜索输入框绑定', /addEventListener\(['"]input['"],\s*\(\)\s*=>\s*\{[\s\S]*?sftpSearchKeyword\s*=\s*input\.value/.test(rendererSrc) || /sftpSearchKeyword\s*=\s*input\.value/.test(rendererSrc));
  check('renderFileList 应用关键字过滤', /sftpSearchKeyword/.test(rendererSrc) && /\.toLowerCase\(\)\.includes\(kwLower\)/.test(rendererSrc));
  check('无匹配提示行 sftp-no-match', /sftp-no-match/.test(rendererSrc));
  check('命中子串高亮 sftp-name-match', /sftp-name-match/.test(rendererSrc));
  // B2 回归: 名称含 & < > " ' 时跳过 span 包裹 (原始索引切转义串会切碎实体, 如 a&b.txt 搜 b)
  check('特殊字符文件名跳过 span (防实体被切)', /!\/\[&<>"']\/\.test\(entry\.name\)/.test(rendererSrc));
  check('Esc 清空搜索框', /input\.addEventListener\(['"]keydown['"],\s*\(e\)\s*=>\s*\{[\s\S]*?Escape/.test(rendererSrc));
  check('递归开关按钮绑定', /sftpSearchRecursive/.test(rendererSrc));
  check('调用 sftpSearch IPC', /window\.nimbus\.sftpSearch\(/.test(rendererSrc));
  check('递归结果列表点击处理', /onSftpSearchResultClick/.test(rendererSrc));
  check('init 中接入 initSftpSearch()', /initSftpSearch\(\);/.test(rendererSrc));
  check('搜索结果可打开文档 (openDocViewer 第三参数覆盖路径)', /openDocViewer\(session,\s*\{\s*name,\s*isDir:\s*false\s*\},\s*path\)/.test(rendererSrc));
}

section('静态断言: main.js (sftp:search handler)');
{
  check('注册 sftp:search', /ipcMain\.handle\(['"]sftp:search['"]/.test(mainSrc));
  check('使用 fileFilter.buildFindCommand', /fileFilter\.buildFindCommand\(/.test(mainSrc));
  check('maxdepth 钳制 1..MAX_DEPTH_LIMIT', /Math\.max\(1,\s*Math\.min\(fileFilter\.MAX_DEPTH_LIMIT/.test(mainSrc));
  check('execSSHCommand 带超时/输出上限', /execSSHCommand\(session,\s*cmd,\s*\{\s*maxBytes:\s*64\s*\*\s*1024,\s*timeoutMs:\s*8000\s*\}/.test(mainSrc));
  check('find 未安装降级 degraded', /degraded:\s*true/.test(mainSrc));
  check('审计 sftp.search', /'sftp\.search'/.test(mainSrc));
  check('cwd 校验 (.. 段拒绝)', /!path\.split\(['"]\/['"]\)\.some\(\(s\)\s*=>\s*s\s*===\s*['"]\.\.['"]\)/.test(mainSrc));
}

section('静态断言: preload.js + index.html');
{
  check('preload 暴露 sftpSearch', /sftpSearch:\s*\(sessionId,\s*path,\s*keyword,\s*maxDepth\)\s*=>/.test(preloadSrc));
  check('index.html 搜索框 sftpSearchInput', /id="sftpSearchInput"/.test(htmlSrc));
  check('index.html 递归按钮 sftpSearchRecursive', /id="sftpSearchRecursive"/.test(htmlSrc));
  check('index.html 结果列表 sftpSearchResults', /id="sftpSearchResults"/.test(htmlSrc));
}

// ================= 汇总 =================
console.log(`\n==== 结果: ${passed} 通过, ${failed} 失败 ====`);
if (failed > 0) process.exit(1);
