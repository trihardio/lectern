'use strict';
// Draws the background of the Mac installer window (the DMG): minimalist pixel art in Lectern's
// colours. The art is drawn on a coarse grid (one art pixel = 4 points) and written as two PNGs,
// 1x and 2x, with no dependencies (PNG encoding by hand with Node's zlib).
//
//   node scripts/dmg-background.js <out-dir>   ->  background.png (660x400), background@2x.png (1320x800)
//
// The window is 660 x 400 points. Finder puts the Lectern icon at (165, 186) and Applications at
// (495, 186) (scripts/dmg-settings.py); the art leaves those spots clear.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 660, H = 400, P = 4;              // window in points, points per art pixel
const GW = W / P, GH = H / P;               // 165 x 100 art pixels

const C = {
  sheet: [246, 248, 244], dot: [226, 232, 225], cab: [31, 58, 51], cab2: [54, 89, 78], leaf: [94, 140, 74],
  leaf2: [130, 170, 104], mark: [247, 230, 74], stamp: [91, 63, 168], ink3: [99, 109, 103],
};

const grid = Array.from({ length: GH }, () => Array(GW).fill(C.sheet));
const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < GW && y < GH) grid[y][x] = c; };
const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
const draw = (x, y, rows, palette) => rows.forEach((row, j) => [...row].forEach((ch, i) => { if (palette[ch]) put(x + i, y + j, palette[ch]); }));

// a faint dot grid, like a cutting mat, every 5 art pixels
for (let y = 2; y < GH - 6; y += 5) for (let x = 2; x < GW; x += 5) put(x, y, C.dot);

// the ground: a cabinet-green band along the bottom, with a highlighter stroke above it
rect(0, GH - 4, GW, 4, C.cab);
rect(0, GH - 5, GW, 1, C.cab2);

// the arrow from the app to Applications: dashes, then a stepped head
const ay = 46;
for (let x = 64; x < 96; x += 4) rect(x, ay, 2, 2, C.cab);
draw(96, ay - 4, [
  'g.....',
  'gg....',
  'ggg...',
  'gggg..',
  'gggg..',
  'ggg...',
  'gg....',
  'g.....',
], { g: C.cab });
rect(64, ay + 6, 38, 1, C.mark); // the highlighter under the gesture

// a pressed sprig (the herbarium), bottom left, standing on the ground
draw(12, GH - 22, [
  '.....l.....',
  '....lL.....',
  '...lLs..l..',
  '....Ls.lL..',
  '.l...slL...',
  '.Ll..s.....',
  '..Lls...l..',
  '.....s.lL..',
  '.....slL...',
  '.....s.....',
  '..l..s.....',
  '..Lls......',
  '.....s.....',
  '.....s.....',
  '...ttttt...',
  '...t...t...',
  '...ttttt...',
], { l: C.leaf2, L: C.leaf, s: C.cab2, t: C.ink3 });

// an accession stamp, bottom right: a small violet frame with a dot
draw(GW - 20, GH - 15, [
  'vvvvvvvv',
  'v......v',
  'v.vv.v.v',
  'v......v',
  'vvvvvvvv',
], { v: C.stamp });

// "DRAG TO INSTALL" in a 3x5 pixel face, centred under the icons
const FONT = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'], D: ['##.', '#.#', '#.#', '#.#', '##.'], G: ['.##', '#..', '#.#', '#.#', '.##'],
  I: ['###', '.#.', '.#.', '.#.', '###'], L: ['#..', '#..', '#..', '#..', '###'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'], R: ['##.', '#.#', '##.', '#.#', '#.#'], S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'], ' ': ['...', '...', '...', '...', '...'],
};
function text(str, y, c) {
  const width = [...str].reduce((w, ch) => w + FONT[ch][0].length + 1, -1);
  let x = Math.round((GW - width) / 2);
  for (const ch of str) { draw(x, y, FONT[ch], { '#': c }); x += FONT[ch][0].length + 1; }
}
text('DRAG TO INSTALL', 80, C.ink3);

// ---- write PNGs
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(scale) {
  const w = W * scale, h = H * scale, px = P * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // no filter
    const row = grid[Math.floor(y / px)];
    for (let x = 0; x < w; x++) {
      const c = row[Math.floor(x / px)];
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const phys = Buffer.alloc(9); // 72 or 144 dpi, so Finder shows both at 660 x 400 points
  phys.writeUInt32BE(Math.round(2835 * scale), 0); phys.writeUInt32BE(Math.round(2835 * scale), 4); phys[8] = 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('pHYs', phys),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = process.argv[2] || '.';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'background.png'), png(1));
fs.writeFileSync(path.join(out, 'background@2x.png'), png(2));
console.log(`Wrote ${path.join(out, 'background.png')} and background@2x.png`);
