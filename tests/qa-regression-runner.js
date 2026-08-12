#!/usr/bin/env node
/**
 * QA 回归运行器: 逐个运行测试套件, 收集通过/失败/断言数
 * 用法: node tests/qa-regression-runner.js <suite1> <suite2> ...
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const CWD = path.join(__dirname, '..');
const suites = process.argv.slice(2);
const TIMEOUT_MS = 180000;

let totalPass = 0;
let totalFail = 0;
let totalSuitesPass = 0;
let totalSuitesFail = 0;

for (const s of suites) {
  const file = path.join(CWD, 'tests', s);
  const r = spawnSync(process.execPath, [file], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' },
  });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  // 提取 "==== 结果: X 通过, Y 失败 ====" 或类似汇总行
  const m = out.match(/(\d+)\s*通过,\s*(\d+)\s*失败/) || out.match(/(\d+)\s*passed,\s*(\d+)\s*failed/i);
  let summary = '?';
  if (m) summary = `${m[1]} 通过 / ${m[2]} 失败`;
  const ok = r.status === 0;
  if (ok) { totalSuitesPass++; } else { totalSuitesFail++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}  (${summary})${r.status === null ? ' [TIMEOUT]' : ''}`);
  // 失败时打印末尾上下文
  if (!ok) {
    const lines = out.split('\n').filter((l) => l.includes('FAIL') || l.includes('Error') || l.includes('error')).slice(0, 12);
    for (const l of lines) console.log('      ' + l.trim());
  }
  // 统计断言数 (尽量从输出汇总)
  if (m) {
    totalPass += parseInt(m[1], 10);
    totalFail += parseInt(m[2], 10);
  }
}

console.log(`\n==== 回归汇总: ${totalSuitesPass}/${suites.length} 套件通过, 断言 通过=${totalPass} 失败=${totalFail} ====`);
process.exit(totalSuitesFail > 0 ? 1 : 0);
