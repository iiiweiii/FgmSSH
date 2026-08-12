#!/usr/bin/env node
/** Round2: 复跑关键套件并记录真实退出码 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const CWD = path.join(__dirname, '..');
const suites = [
  'hostkey-store-test.js',
  'hostkey-verifier-test.js',
  'hostkey-e2e-test.js',
  'reconnect-test.js',
  'updatecheck-test.js',
  'audit-log-test.js',
  'credential-store-test.js',
];
let allOk = true;
for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(CWD, 'tests', s)], {
    cwd: CWD, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\s*通过,\s*(\d+)\s*失败/) || out.match(/(\d+)\s*passed,\s*(\d+)\s*failed/i);
  const ok = r.status === 0;
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}  exit=${r.status}  ${m ? m[0] : '?'}`);
}
console.log(`\n==== Round2 复验: ${allOk ? '全部通过' : '存在失败'} ====`);
process.exit(allOk ? 0 : 1);
