'use strict';
// Build Lectern's app icons from build/icon.svg (and build/icon-small.svg for 16-32 pixels).
//   node scripts/make-icon.js            # writes build/icon.icns, build/icon.ico, ui/icon.svg
//   node scripts/make-icon.js --preview  # writes build/preview-<size>.png only
// Each size is drawn by headless Chrome from the vector source at that exact size (not shrunk from one big picture).
// macOS: iconutil (built in) makes the .icns. Windows: the .ico holds PNG images (Windows Vista and later).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-icon-'));

// The Windows icon and the favicon fill their square: the same drawing, cropped to the tile.
const fullBleed = (svg) => svg.replace('viewBox="0 0 1024 1024"', 'viewBox="92 92 840 840"');

function render(svg, size, out) {
  // The drawing goes inside the page itself: a file:// page may not load a neighbouring file.
  const inline = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`).replace(/<!--[\s\S]*?-->/g, '');
  const html = path.join(tmp, `p${size}-${path.basename(out)}.html`);
  fs.writeFileSync(html, `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${inline}</body></html>`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=1',
    `--window-size=${size},${size}`, `--screenshot=${out}`, `--user-data-dir=${path.join(tmp, 'profile')}`, 'file://' + html], { stdio: 'ignore' });
  const png = fs.readFileSync(out);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`${out}: ${w}x${h}, expected ${size}x${size}`);
  return png;
}

function ico(images) { // images: [{ size, png }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e); dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3); dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

const big = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(BUILD, 'icon-small.svg'), 'utf8');
const pick = (size) => (size <= 32 ? small : big);

if (process.argv.includes('--preview')) {
  for (const size of [1024, 256, 64, 32, 16]) render(pick(size), size, path.join(BUILD, `preview-${size}.png`));
  for (const size of [256, 32]) render(fullBleed(pick(size)), size, path.join(BUILD, `preview-win-${size}.png`));
  console.log('previews in build/');
  process.exit(0);
}

// macOS .icns
const set = path.join(tmp, 'icon.iconset');
fs.mkdirSync(set);
for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256],
  ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
  render(pick(name.startsWith('16x16') || name === '32x32' ? Math.min(size, 32) : size), size, path.join(set, `icon_${name}.png`));
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
// Windows .ico
const winSizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(winSizes.map((size) => ({ size, png: render(fullBleed(pick(size)), size, path.join(tmp, `win-${size}.png`)) }))));
// the window's favicon (served by server/index.js as text)
fs.writeFileSync(path.join(ROOT, 'ui', 'icon.svg'), fullBleed(small).replace(/<!--[\s\S]*?-->\s*/g, ''));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`build/icon.icns ${fs.statSync(path.join(BUILD, 'icon.icns')).size} bytes; build/icon.ico ${fs.statSync(path.join(BUILD, 'icon.ico')).size} bytes (${winSizes.join(', ')}); ui/icon.svg`);
