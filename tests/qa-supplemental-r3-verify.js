#!/usr/bin/env node
/**
 * NimbusSSH - QA 补充验证 (Roadmap 第一梯队③ / 第三梯队① 新增功能)
 * 覆盖任务书中「补充验证」清单:
 *  ① find 命令构造: 注入关键字 / 空格 / 引号 / maxdepth 钳制 / 输出解析 (多行/ANSI/空)
 *  ② compareVersions: 预发布 / v2.0 vs v1.9.9 / 非法输入; fetch 抛错/超时 -> 静默 + failure 审计;
 *     发现新版 -> 事件触发 + 徽标数据
 *  ③ 高亮: shell 注释/字符串内关键字不误包; <script> 注入无原始标签; >500KB 降级;
 *     分段阈值边界 (恰 2MB / 2MB+1 / 512KB 预览 / 加载全部后可保存)
 *
 * 用法: node tests/qa-supplemental-r3-verify.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const fileFilter = require('../src/file-filter');
const uc = require('../src/update-check');
const eh = require('../src/editor-highlight');

let passed = 0;
let failed = 0;
const findings = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
}
function note(msg) { findings.push(msg); }
function section(name) { console.log(`\n== ${name} ==`); }

async function run() {

// ============ ① find 命令构造 ============
section('① find: 注入关键字 (任务书指定 " ; rm -rf / # ")');
{
  const evil = "'; rm -rf / #";
  const cmd = fileFilter.buildFindCommand('/etc', evil, { maxDepth: 3 });
  check('关键字 ";\' rm -rf / #" 被白名单化, 命令可构造且无注入面', cmd !== null);
  const NO_INJECT = /[;`$()&|<>\\\n]/;
  check('命令内无 shell 元字符 (分号/反引号/$/括号/重定向)', cmd === null || !NO_INJECT.test(cmd), String(cmd));
  if (cmd) check('残留字符仅白名单字母/连字符 (rm-rf)', cmd.includes("'*rm-rf*'"), cmd);
  // 空格 / 单引号
  const sp = fileFilter.buildFindCommand('/home', 'my file', { maxDepth: 2 });
  check('含空格关键字 -> 剔除空格后安全', sp === null || (!NO_INJECT.test(sp) && !/\s/.test(sp.match(/\*[^*]+\*/) ? sp.match(/\*[^*]+\*/)[0] : '')), String(sp));
  const qt = fileFilter.buildFindCommand('/a', "it's", { maxDepth: 2 });
  check("含单引号关键字 -> 剔除引号 (its) 后安全", qt === null || (qt.includes("'*its*'") && !NO_INJECT.test(qt)), String(qt));
}

section('① find: maxdepth 钳制 (负数/超大/NaN)');
{
  const neg = fileFilter.buildFindCommand('/', 'x', { maxDepth: -5 });
  check('负数 -> 钳制到 1..3 (实际 1)', neg !== null && /-maxdepth [123]/.test(neg), String(neg));
  const huge = fileFilter.buildFindCommand('/', 'x', { maxDepth: 999 });
  check('超大 -> 钳制到 3', huge !== null && huge.includes('-maxdepth 3'), String(huge));
  const nan = fileFilter.buildFindCommand('/', 'x', { maxDepth: 'abc' });
  check('NaN/非数字 -> 钳制到 1..3', nan !== null && /-maxdepth [123]/.test(nan), String(nan));
  const inf = fileFilter.buildFindCommand('/', 'x', { maxDepth: Infinity });
  check('Infinity -> 钳制到 1..3', inf !== null && /-maxdepth [123]/.test(inf), String(inf));
}

section('① find: 输出解析 (多行/ANSI/空结果/去重/路径边界)');
{
  // ANSI 颜色输出 (find 一般不产生, 防御性)
  const ansi = fileFilter.parseFindOutput('\u001b[32m/a/b.txt\u001b[0m\n/a/c.txt', '/a');
  check('ANSI 前缀行仍按绝对路径处理 (不崩溃)', Array.isArray(ansi));
  const empty = fileFilter.parseFindOutput('', '/a');
  check('空输出 -> 空数组', empty.length === 0);
  const whitespace = fileFilter.parseFindOutput('\n\n  \n', '/a');
  check('纯空白 -> 空数组', whitespace.length === 0);
  const multi = fileFilter.parseFindOutput('/a/x\n/a/y\n/a/z', '/a');
  check('多行解析 3 条', multi.length === 3);
  const dup = fileFilter.parseFindOutput('/a/x\n/a/x\n/a/x', '/a');
  check('重复行去重', dup.length === 1);
  const tailSlash = fileFilter.parseFindOutput('/a/dir/\n/a/file.txt', '/a');
  check('目录尾斜杠剔除', tailSlash.some((r) => r.path === '/a/dir'));
  const rootCwd = fileFilter.parseFindOutput('/x\n/x/y', '/');
  check('根 cwd 下 ./ 前缀归一化', rootCwd.some((r) => r.path === '/x'));
  const rootSelf = fileFilter.parseFindOutput('/\n/a', '/');
  check('cwd 自身 (根) 过滤', rootSelf.length === 1 && rootSelf[0].path === '/a');
}

// ============ ② compareVersions ============
section('② compareVersions: 任务书指定用例');
{
  check("'1.0.0' vs '1.0.0-beta.1' -> 正式版更大 (1)", uc.compareVersions('1.0.0', '1.0.0-beta.1') === 1);
  check("'1.0.0-beta.1' vs '1.0.0' -> 预发布更小 (-1)", uc.compareVersions('1.0.0-beta.1', '1.0.0') === -1);
  check("'v2.0' vs 'v1.9.9' -> 非语义化回退字符串比较 (2.0 > 1.9.9)", uc.compareVersions('v2.0', 'v1.9.9') === 1, String(uc.compareVersions('v2.0', 'v1.9.9')));
  check('非法输入 null 不抛异常', typeof uc.compareVersions(null, 'v1.0.0') === 'number');
  check('非法输入 undefined 不抛异常', typeof uc.compareVersions(undefined, 'v1.0.0') === 'number');
  check('非法输入空串 不抛异常', typeof uc.compareVersions('', 'v1.0.0') === 'number');
  check('两非法输入相等返回 0', uc.compareVersions('', '') === 0);
  check('非语义化相等 (v2.0 == 2.0)', uc.compareVersions('v2.0', '2.0') === 0);
  check('预发布数字段跨段比较 (beta.10 > beta.9)', uc.compareVersions('v1.0.0-beta.10', 'v1.0.0-beta.9') === 1);
  check('预发布字母段比较 (beta > alpha)', uc.compareVersions('v1.0.0-beta', 'v1.0.0-alpha') === 1);
  check('数字段 < 字母段 (rc.1 < rc.a)', uc.compareVersions('v1.0.0-rc.1', 'v1.0.0-rc.a') === -1, String(uc.compareVersions('v1.0.0-rc.1', 'v1.0.0-rc.a')));
}

section('② 检查器: fetch 抛错/超时 -> 静默 + failure 审计; 发现新版 -> 事件数据');
{
  // fetch 抛错 -> 静默 + failure 审计
  let audits = [];
  const failChecker = uc.createUpdateChecker({
    getVersion: () => '1.0.0',
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    audit: (r) => audits.push(r),
  });
  const rFail = await failChecker.checkOnce();
  check('fetch 抛错 -> ok:false 静默', rFail.ok === false && /ECONNREFUSED/.test(rFail.error));
  check('fetch 抛错 -> 不抛异常 (await 正常返回)', true);
  // 超时 (注入假定时器, 立即 abort)
  audits = [];
  const timeoutChecker = uc.createUpdateChecker({
    getVersion: () => '1.0.0',
    timeoutMs: 5,
    fetchFn: (url, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    audit: (r) => audits.push(r),
  });
  const rTimeout = await timeoutChecker.checkOnce();
  check('超时 -> ok:false 静默', rTimeout.ok === false);
  // 发现新版 -> 事件触发 (audit 回调收到 hasUpdate) + 徽标数据 (latest/url)
  audits = [];
  const newChecker = uc.createUpdateChecker({
    getVersion: () => '1.0.0',
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v2.0.1', html_url: 'https://github.com/x/y/releases/tag/v2.0.1' }) }),
    audit: (r) => audits.push(r),
  });
  const rNew = await newChecker.checkOnce();
  check('发现新版 -> hasUpdate:true', rNew.ok === true && rNew.hasUpdate === true);
  check('徽标数据: latest/tag/url/current 齐备', rNew.latest === 'v2.0.1' && rNew.tag === 'v2.0.1' && rNew.url === 'https://github.com/x/y/releases/tag/v2.0.1' && rNew.current === '1.0.0');
  // main.js handleUpdateCheckResult: hasUpdate -> audit success + broadcast 事件
  const mainSrc = read('main.js');
  check('main.js: hasUpdate 分支审计 success + 广播', /if \(res\.hasUpdate\) \{[\s\S]*?result:\s*'success'[\s\S]*?broadcastUpdateCheck\(/.test(mainSrc));
  check('main.js: failure 分支审计 failure 且不广播', /if \(!res \|\| !res\.ok\) \{[\s\S]*?result:\s*'failure'[\s\S]*?return;/.test(mainSrc));
}

// ============ ③ 高亮 ============
section('③ 高亮: shell 注释/字符串内关键字不误包');
{
  const sh = eh.highlightText('echo "if then else" # comment with if\nif true; then echo done; fi', '.sh', {});
  check('sh: 字符串内 if 不单独包裹 (字符串整体为 tok-string)', /<span class="tok-string">"if then else"<\/span>/.test(sh.html), sh.html);
  check('sh: 注释内 if 不单独包裹 (注释整体为 tok-comment)', /<span class="tok-comment"># comment with if<\/span>/.test(sh.html), sh.html);
  check('sh: 注释外 if 正常包裹', /<span class="tok-keyword">if<\/span>/.test(sh.html));
  const js = eh.highlightText('const s = "return 42"; // return', '.js', {});
  check('js: 字符串内 return 不包裹', /<span class="tok-string">"return 42"<\/span>/.test(js.html), js.html);
  check('js: 注释内 return 不包裹', /<span class="tok-comment">\/\/ return<\/span>/.test(js.html), js.html);
  const py = eh.highlightText("msg = 'if and for' # for loop", '.py', {});
  check('py: 字符串内 if/for 不包裹', /<span class="tok-string">'if and for'<\/span>/.test(py.html), py.html);
}

section('③ 高亮: XSS 注入文本 -> 无原始标签');
{
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> "if"';
  const js = eh.highlightText(evil, '.js', {});
  check('js 高亮输出无原始 <script>', !js.html.includes('<script>'));
  check('js 高亮输出无原始 <img', !js.html.includes('<img'));
  check('js 高亮输出转义为 &lt;script&gt;', js.html.includes('&lt;script&gt;'));
  // onerror= 仅存在于已转义文本内: 无原始 <img 标签, 无 onerror= 属性注入 (数字可能被套 span, 不影响)
  check('js 高亮 onerror= 仅位于转义文本 (无原始标签属性)', js.html.includes('onerror=alert(') && !js.html.includes('<img') && !/<img[^>]*onerror=/.test(js.html));
  const md = eh.highlightText('# t\n[link](javascript:alert(1)) <b>x</b>', '.md', {});
  check('md 高亮输出无原始 <b>', !md.html.includes('<b>'));
  check('md 高亮输出转义', md.html.includes('&lt;b&gt;'));
  const ymlEvil = eh.highlightText('key: "value <img>"', '.yml', {});
  check('yml 高亮输出无原始 <img>', !ymlEvil.html.includes('<img>'));
  // span class 均为固定常量: 属性值内不含 < > ' (双引号闭合属性, 内容只可能是固定 class 名)
  check('所有 span class 均为固定常量 (无用户输入进入属性)', !/class="[^"]*[<>']/.test(js.html + md.html + ymlEvil.html));
}

section('③ 高亮: >500KB 降级纯文本');
{
  const big = 'x = 1; // c\n'.repeat(50000); // ~500KB+
  const hl = eh.highlightText(big, '.js', {});
  check('>500KB degraded:true', hl.degraded === true);
  check('>500KB 无 span', !hl.html.includes('<span'));
  check('>500KB html 为完整 escapeHtml', hl.html === eh.escapeHtml(big));
  const customMax = eh.highlightText('const a = 1; // c', '.js', { maxBytes: 10 });
  check('自定义 maxBytes 生效 (超过即降级)', customMax.degraded === true);
}

section('③ 分段加载: 阈值边界 + 完整内容保存路径');
{
  check('恰 2MB (== 阈值) 不分段', eh.isLargeDoc(eh.DOC_SEGMENT_THRESHOLD) === false);
  check('2MB+1 分段', eh.isLargeDoc(eh.DOC_SEGMENT_THRESHOLD + 1) === true);
  check('2MB-1 不分段', eh.isLargeDoc(eh.DOC_SEGMENT_THRESHOLD - 1) === false);
  const info = eh.segmentPreviewInfo(eh.DOC_SEGMENT_THRESHOLD + 1);
  check('分段预览字节 = 512KB', info.previewBytes === eh.DOC_PREVIEW_BYTES);
  check('previewBytes 不超文件大小', eh.segmentPreviewInfo(100).previewBytes === 100);
  // 保存路径静态断言: 分段预览只读 -> 加载全部 -> 恢复编辑 -> docSave 基于完整内容
  const rendererSrc = read('src/renderer.js');
  check('加载全部后 truncated=false 恢复编辑', /doc\.truncated\s*=\s*false;[\s\S]*?doc\._editorMode\s*=\s*'edit'/.test(rendererSrc));
  check('保存使用 textarea 完整内容 (ta.value)', /docSave\(doc\.sessionId,\s*doc\.remotePath,\s*ta\.value\)/.test(rendererSrc));
  check('分段预览保存被拦截', /doc\.truncated\)\s*\{[\s\S]*?加载全部[\s\S]*?再保存/.test(rendererSrc));
  const mainSrc = read('main.js');
  check('doc:loadFull 追加剩余字节后 reg.loadedBytes=totalSize', /reg\.loadedBytes\s*=\s*reg\.totalSize/.test(mainSrc));
  check('doc:save 写完整内容 (ws.end(content))', /ws\.end\(content,\s*'utf8'\)/.test(mainSrc));
}

// ============ 汇总 ============
console.log(`\n==== 补充验证结果: ${passed} 通过, ${failed} 失败 ====`);
if (findings.length) {
  console.log('\n-- 发现/观察 --');
  for (const f of findings) console.log('  * ' + f);
}
if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('补充验证运行异常:', err);
  process.exit(2);
});
