// Every SVG the repo ships must load as an image on its own. The README shows build/icon.svg through an <img>, and a
// browser reads an image SVG as strict XML: one comment with two hyphens in a row (a CSS token name such as "--cab")
// makes the whole file fail, and GitHub showed a broken icon. The app never noticed, because scripts/make-icon.js
// strips comments before it uses the SVGs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svgFiles = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? svgFiles(path.join(dir, e.name)) : e.name.endsWith('.svg') ? [path.join(dir, e.name)] : []);

test('icons: every SVG loads as a stand-alone image (SVG namespace, no two hyphens inside a comment)', () => {
  const files = ['build', 'ui'].flatMap(svgFiles);
  assert.ok(files.length >= 3, `expected the three icon SVGs, found: ${files.join(', ')}`);
  for (const file of files) {
    const svg = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(svg, /<svg\b[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${file}: the root <svg> needs the SVG namespace`);
    for (const [, body] of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(!body.includes('--') && !body.endsWith('-'),
        `${file}: a comment contains two hyphens in a row, so browsers refuse the file as an image: "${body.trim().slice(0, 70)}"`);
    }
  }
});
