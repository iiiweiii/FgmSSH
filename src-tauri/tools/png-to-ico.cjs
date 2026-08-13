// 将 fmgssh-review/assets/icon.png 封装为 ICO（ICONDIR 6B + ICONDIRENTRY 16B + PNG bytes）。
// 纯 Node，无第三方依赖；输出 src-tauri/icons/icon.ico。
// 校验：6 + 16 + pngLen == 文件大小。
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/we/WorkBuddy/2026-08-13-09-44-54/fmgssh-review/assets/icon.png';
const OUT_DIR = 'C:/Users/we/WorkBuddy/2026-08-13-09-44-54/fmgssh-tauri/src-tauri/icons';
const OUT = path.join(OUT_DIR, 'icon.ico');

try {
  const png = fs.readFileSync(SRC);
  if (png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    console.error('SKIP: source is not a PNG:', SRC);
    process.exit(2);
  }
  // IHDR: width/height 在 bytes 16-23 (big-endian)
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== 256 || h !== 256) {
    console.error('SKIP: PNG not 256x256, got', w + 'x' + h);
    process.exit(2);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // ICONDIR (6): reserved(2)=0, type(2)=1(ICO), count(2)=1
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);     // reserved
  dir.writeUInt16LE(1, 2);     // type: 1=icon
  dir.writeUInt16LE(1, 4);     // count: 1 entry

  // ICONDIRENTRY (16): width(1) height(1) colorCount(1) reserved(1)
  //   planes(2) bitCount(2) bytesInRes(4) imageOffset(4)
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);              // width: 0 means 256
  entry.writeUInt8(0, 1);              // height: 0 means 256
  entry.writeUInt8(0, 2);              // colorCount: 0 (>=8bpp)
  entry.writeUInt8(0, 3);              // reserved
  entry.writeUInt16LE(1, 4);           // planes
  entry.writeUInt16LE(32, 6);          // bitCount: 32 (RGBA)
  entry.writeUInt32LE(png.length, 8);  // bytesInRes
  entry.writeUInt32LE(22, 12);         // imageOffset: 6+16=22

  const ico = Buffer.concat([dir, entry, png]);
  fs.writeFileSync(OUT, ico);

  // 校验：6+16+pngLen == 文件大小
  const written = fs.statSync(OUT).size;
  const expected = 6 + 16 + png.length;
  if (written !== expected) {
    console.error('FAIL: size mismatch written=' + written + ' expected=' + expected);
    process.exit(1);
  }
  // 读回校验 ICONDIR magic + PNG 头
  const back = fs.readFileSync(OUT);
  const ok =
    back[0] === 0 && back[1] === 0 &&                       // reserved
    back[2] === 1 && back[3] === 0 &&                       // type=ICO
    back[4] === 1 && back[5] === 0 &&                       // count=1
    back.slice(22, 30).toString('hex') === '89504e470d0a1a0a'; // PNG magic
  if (!ok) {
    console.error('FAIL: header check failed');
    process.exit(1);
  }
  console.log('OK: ' + OUT + ' (' + written + ' bytes)');
} catch (e) {
  console.error('ERROR:', e && e.message ? e.message : e);
  process.exit(1);
}