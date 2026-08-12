#!/usr/bin/env node
/**
 * FgmSSH - Roadmap 第一梯队 ③ (M) 文本编辑增强 测试 (node 直跑, 无需 Electron)
 *
 * 1) 语法高亮 tokenizer (src/editor-highlight.js):
 *    - 各语言关键词高亮 (sh/js/py/json/yml/md)
 *    - escapeHtml/escapeText 防注入 (内容先转义再套 span, 无原始 <script>)
 *    - 超阈值降级纯文本 (无 span)
 *    - 内容启发 (shebang -> sh / py)
 * 2) 大文件分段加载阈值逻辑:
 *    - <2MB 全量 (isLargeDoc false) / >2MB 前段预览 (true) / 加载全部
 *    - segmentPreviewInfo previewBytes 钳制 / totalSize
 * 3) 静态断言 (真实源码):
 *    - renderer.js 默认编辑模式 textarea + 高亮/编辑切换 + 分段预览只读 + 加载全部 +
 *      saveDocText 基于完整内容 (docSave)
 *    - main.js doc:open 分段 (stat + downloadToFilePartial + truncated/previewText) +
 *      doc:loadFull (appendRemoteTail + registry) + doc:save 语义不变
 *    - preload.js docLoadFull
 *
 * 用法: node tests/editor-enhance-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWD = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(CWD, f), 'utf8');
const eh = require('../src/editor-highlight');

const rendererSrc = read('src/renderer.js');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');

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

// ================= XSS / 转义 =================
section('XSS: escapeText / escapeHtml');
{
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const esc = eh.escapeHtml(evil);
  check('escapeHtml 无原始 <script>', !esc.includes('<script>'));
  check('escapeHtml 转义尖括号', esc.includes('&lt;script&gt;'));
  check('escapeHtml 转义引号', eh.escapeHtml('"\'') === '&quot;&#39;');
  const escT = eh.escapeText(evil);
  check('escapeText 无原始 <script>', !escT.includes('<script>'));
  check('escapeText 转义 & < >', escT.includes('&lt;script&gt;'));
}

// ================= 语法高亮 =================
section('语法高亮: 各语言关键词/注释/字符串');
{
  const sh = eh.highlightText('if [ -f /etc/passwd ]; then echo "ok" # done\nfi', '.sh', {});
  check('sh: 关键词 span (if/fi)', sh.html.includes('tok-keyword') && /<span class="tok-keyword">if<\/span>/.test(sh.html));
  check('sh: 注释 span (# done)', sh.html.includes('tok-comment') && /# done/.test(sh.html));
  check('sh: 字符串 span', sh.html.includes('tok-string'));

  const js = eh.highlightText('const x = 42; // answer', '.js', {});
  check('js: const 关键词', /<span class="tok-keyword">const<\/span>/.test(js.html));
  check('js: 数字 span', js.html.includes('tok-number'));
  check('js: 行注释 span', js.html.includes('tok-comment'));

  const py = eh.highlightText('def greet(name):\n    return name', '.py', {});
  check('py: def 关键词', /<span class="tok-keyword">def<\/span>/.test(py.html));
  check('py: return 关键词', /<span class="tok-keyword">return<\/span>/.test(py.html));

  const json = eh.highlightText('{"key": "value", "n": 1, "ok": true}', '.json', {});
  check('json: 键 span', json.html.includes('tok-key') && /<span class="tok-key">"key"<\/span>/.test(json.html));
  check('json: 字符串值 span', json.html.includes('tok-string'));
  check('json: 数字 span', json.html.includes('tok-number'));
  check('json: true 关键词', json.html.includes('tok-keyword'));

  const yml = eh.highlightText('name: nimbus\nport: 22 # ssh', '.yml', {});
  check('yml: 键 span (name:)', yml.html.includes('tok-key'));
  check('yml: 注释 span', yml.html.includes('tok-comment'));

  // B1 回归: yml key 规则内部捕获组改为非捕获组后, string/keyword/number 外层组号可预测,
  // 值字符串/数字/关键字必须正确包裹 tok-* class (此前仅 key/注释正常)
  const ymlVals = eh.highlightText('name: "quoted"\nport: 22\nflag: true', '.yml', {});
  check('yml: 值字符串 span ("quoted")', /<span class="tok-string">"quoted"<\/span>/.test(ymlVals.html), ymlVals.html);
  check('yml: 数字值 span (22)', /<span class="tok-number">22<\/span>/.test(ymlVals.html), ymlVals.html);
  check('yml: 关键字值 span (true)', /<span class="tok-keyword">true<\/span>/.test(ymlVals.html), ymlVals.html);

  const md = eh.highlightText('# Title\n\n`inline` code\n\n```\ncode block\n```', '.md', {});
  check('md: 标题 span', md.html.includes('tok-heading'));
  check('md: 行内代码 span', md.html.includes('tok-inlinecode'));
  check('md: 围栏内代码块 span', md.html.includes('tok-codeblock'));

  const txt = eh.highlightText('plain text with if and "quotes"', '.txt', {});
  check('txt: 纯文本无 span (仅转义)', !txt.html.includes('<span'));
  check('txt: 未降级', txt.degraded === false);
}

section('语法高亮: 内容启发 (无扩展名/未知扩展名)');
{
  const shByShebang = eh.highlightText('#!/bin/bash\necho hi', '', {});
  check('shebang bash -> sh 高亮', shByShebang.language === 'sh' && shByShebang.html.includes('tok-keyword'));
  const pyByShebang = eh.highlightText('#!/usr/bin/env python3\nimport os', '.log', {});
  check('shebang python -> py 高亮', pyByShebang.language === 'py');
  const pyByDef = eh.highlightText('def foo():\n    pass', '.conf', {});
  check('def 特征 -> py 高亮', pyByDef.language === 'py');
  const plain = eh.highlightText('nothing special here', '.log', {});
  check('无特征 -> null 语言纯文本', plain.language === null && !plain.html.includes('<span'));
}

section('语法高亮: 超阈值降级纯文本');
{
  const big = 'x = 1; // comment\n'.repeat(40000); // > 500KB
  const hl = eh.highlightText(big, '.js', {});
  check('超阈值 degraded:true', hl.degraded === true);
  check('超阈值无 span (纯文本)', !hl.html.includes('<span'));
  check('超阈值 html 等于完整转义', hl.html === eh.escapeHtml(big));
  const small = eh.highlightText('const a = 1;', '.js', { maxBytes: 1000 });
  check('未超阈值正常高亮', small.degraded === false && small.html.includes('tok-keyword'));
}

// ================= 大文件分段加载阈值 =================
section('分段加载: 阈值逻辑');
{
  check('2MB 边界 (等于阈值) 不分段', eh.isLargeDoc(eh.DOC_SEGMENT_THRESHOLD) === false);
  check('2MB+1 分段', eh.isLargeDoc(eh.DOC_SEGMENT_THRESHOLD + 1) === true);
  check('小文件不分段', eh.isLargeDoc(1024) === false);
  check('0 字节不分段', eh.isLargeDoc(0) === false);

  const info = eh.segmentPreviewInfo(eh.DOC_SEGMENT_THRESHOLD + 1);
  check('分段信息 truncated:true', info.truncated === true);
  check('分段预览字节 = 512KB', info.previewBytes === eh.DOC_PREVIEW_BYTES);
  check('totalSize 保留', info.totalSize === eh.DOC_SEGMENT_THRESHOLD + 1);

  const smallInfo = eh.segmentPreviewInfo(1024);
  check('小文件 truncated:false', smallInfo.truncated === false);
  check('小文件 previewBytes 钳制到文件大小', smallInfo.previewBytes === 1024);

  const badInfo = eh.segmentPreviewInfo(-5);
  check('非法大小 -> totalSize 0', badInfo.totalSize === 0 && badInfo.truncated === false);
}

// ================= 静态断言 =================
section('静态断言: renderer.js (查看器高亮 + 分段预览)');
{
  check('使用 editorHighlightApi.highlightText', /editorHighlightApi\.highlightText/.test(rendererSrc));
  check('默认编辑模式 (textarea, 回归兼容)', /doc\._editorMode\s*=\s*'edit'/.test(rendererSrc));
  check('高亮预览只读 pre#docHighlight', /id\s*=\s*'docHighlight'/.test(rendererSrc));
  check('加载全部按钮 docLoadAllBtn', /docLoadAllBtn/.test(rendererSrc));
  check('加载全部调 docLoadFull', /window\.nimbus\.docLoadFull\(doc\.sessionId,\s*doc\.filename\)/.test(rendererSrc));
  check('分段预览只读 (编辑禁用)', /doc\.truncated\)\s*\{[\s\S]*?toast\(['"]文件较大，请先点击「加载全部」后再编辑/.test(rendererSrc));
  check('保存基于完整内容 (docSave)', /window\.nimbus\.docSave\(doc\.sessionId,\s*doc\.remotePath,\s*ta\.value\)/.test(rendererSrc));
  check('分段预览保存被拦截', /toast\(['"]文件较大，请先点击「加载全部」后再保存['"]/.test(rendererSrc));
  check('编辑/高亮切换按钮绑定', /toggleDocEditorMode/.test(rendererSrc));
  check('保存按钮仅编辑模式+完整加载显示', /saveBtn\.style\.display\s*=\s*\(!doc\.truncated\s*&&\s*doc\._editorMode\s*===\s*'edit'\)/.test(rendererSrc));
}

section('静态断言: main.js (doc:open 分段 + doc:loadFull + 保存语义)');
{
  check('doc:open 使用 segmentPreviewInfo', /editorHighlight\.segmentPreviewInfo\(totalSize\)/.test(mainSrc));
  check('doc:open 使用 downloadToFilePartial', /downloadToFilePartial\(sftp,\s*remotePath,\s*localPath,\s*seg\.previewBytes\)/.test(mainSrc));
  check('doc:open stat 远端大小', /promisify\(sftp\.stat\)\.bind\(sftp\)\(remotePath\)/.test(mainSrc));
  check('doc:open 返回 truncated/totalSize/previewText', /truncated,\s*\n\s*totalSize,\s*\n\s*previewText/.test(mainSrc));
  check('doc:open 注册表记录 loadedBytes', /loadedBytes:\s*truncated\s*\?\s*seg\.previewBytes\s*:\s*totalSize/.test(mainSrc));
  check('doc:loadFull handler', /ipcMain\.handle\(['"]doc:loadFull['"]/.test(mainSrc));
  check('doc:loadFull 校验打开登记', /docOpenRegistry\.get\(filename\)/.test(mainSrc));
  check('doc:loadFull 追加剩余字节', /appendRemoteTail\(sftp,\s*reg\.remotePath,\s*localPath,\s*offset\)/.test(mainSrc));
  check('doc:save 语义不变 (写流覆盖完整内容)', /ws\.end\(content,\s*'utf8'\)/.test(mainSrc));
  check('doc:save 仍校验扩展名白名单 + 打开登记', /TEXT_DOC_EXTENSIONS\.includes\(ext\)/.test(mainSrc) && /docOpenRegistry\.values\(\)/.test(mainSrc));
  check('审计 doc.loadFull', /'doc\.loadFull'/.test(mainSrc));
}

section('静态断言: preload.js');
{
  check('preload 暴露 docLoadFull', /docLoadFull:\s*\(sessionId,\s*filename\)\s*=>\s*ipcRenderer\.invoke\(['"]doc:loadFull['"]/.test(preloadSrc));
}

// ================= 汇总 =================
console.log(`\n==== 结果: ${passed} 通过, ${failed} 失败 ====`);
if (failed > 0) process.exit(1);
