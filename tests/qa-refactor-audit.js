// Renderer static-analysis script (test for QA verification)
const code = require('fs').readFileSync('src/renderer.js', 'utf8');
const html = require('fs').readFileSync('src/index.html', 'utf8');
const css = require('fs').readFileSync('src/style.css', 'utf8');

const fns = [
  'showSftpFor', 'openConnDrawer', 'closeConnDrawer', 'toggleConnDrawer',
  'currentSftpSession', 'loadDir', 'renderFileList', 'openSession',
  'closeSession', 'activateSession', 'createTerminal', 'renderConnectionList'
];
console.log('--- Function defs / call sites ---');
for (const f of fns) {
  const defRe = new RegExp('function\\s+' + f + '\\s*\\(', 'g');
  const callRe = new RegExp('\\b' + f + '\\s*\\(', 'g');
  const defs = (code.match(defRe) || []).length;
  const calls = (code.match(callRe) || []).length - defs;
  console.log('  ' + f.padEnd(22) + ' defs=' + defs + ' calls=' + calls);
}

console.log('\n--- Old viewer remnants (should all be 0) ---');
const oldies = ['view-switch', 'createFileView', 'setSessionView', 'toggleFileView', 'fileView', 'view_switch', 'showFileView'];
let residual = 0;
for (const p of oldies) {
  const a = (code.match(new RegExp(p, 'g')) || []).length;
  const b = (html.match(new RegExp(p, 'g')) || []).length;
  const c = (css.match(new RegExp(p, 'g')) || []).length;
  const total = a + b + c;
  residual += total;
  console.log('  ' + p.padEnd(20) + ' js=' + a + ' html=' + b + ' css=' + c + (total ? '  ⚠' : '  ok'));
}

console.log('\n--- currentSftpSessionId refs ---');
const csi = (code.match(/currentSftpSessionId/g) || []).length;
console.log('  total = ' + csi);

console.log('\n--- fileReqSeq race-guard refs ---');
const seqRefs = (code.match(/fileReqSeq/g) || []).length;
console.log('  total = ' + seqRefs + ' (expect ≥ 4: declare, increment, compare×2, fallback)');

console.log('\n--- Per-session isolation fields (must be inside session object literal) ---');
const fields = ['currentPath', 'history:', 'historyIndex', 'fileEntries', 'fileEntryMap', 'fileReqSeq'];
for (const f of fields) {
  const m = (code.match(new RegExp(f, 'g')) || []).length;
  console.log('  ' + f.padEnd(16) + ' = ' + m);
}

console.log('\n--- CSS pointer-events for drawer ---');
const closedPE = (css.match(/\.conn-drawer\s*\{[^}]*pointer-events:\s*none/g) || []).length;
const openPE = (css.match(/\.conn-drawer\.open\s*\{[^}]*pointer-events:\s*auto/g) || []).length;
console.log('  .conn-drawer { pointer-events: none } : ' + closedPE);
console.log('  .conn-drawer.open { pointer-events: auto } : ' + openPE);

console.log('\n--- DOM ID audit (expected: each new=1, view-switch=0, connectionList=0) ---');
const ids = ['sftpPanel', 'btnConnections', 'connDrawer', 'searchInput', 'btnNewDrawer',
  'view-switch', 'connectionList', 'tabbar', 'terminalArea', 'modalOverlay'];
for (const id of ids) {
  const re = new RegExp('id="' + id + '"', 'g');
  console.log('  ' + ((html.match(re) || []).length + ' ').padStart(2) + '#' + id);
}

console.log('\n--- Sidebar width + overflow ---');
const sidebarBlock = css.match(/\.sidebar\s*\{[^}]+\}/);
console.log('  .sidebar rule: ' + (sidebarBlock ? sidebarBlock[0].replace(/\s+/g, ' ') : 'NOT FOUND'));