'use strict';
// Build shared/misspellings.js from Wikipedia's machine-readable list of common misspellings (a fixed revision).
//   node scripts/make-misspellings.js
// Kept: entries with one correction. Dropped: any "misspelling" that is a real word or name in the Mac's word lists
// (/usr/share/dict/words, propernames, web2a), so the rule never flags a valid word. Run on macOS.
const fs = require('fs');
const path = require('path');

const TITLE = 'Wikipedia:Lists_of_common_misspellings/For_machines';
const REVISION = 1199637275; // 2024-01-27T15:31:36Z
const URL = `https://en.wikipedia.org/w/index.php?title=${TITLE}&oldid=${REVISION}&action=raw`;
const DICTS = ['/usr/share/dict/words', '/usr/share/dict/propernames', '/usr/share/dict/web2a'];

(async () => {
  const res = await fetch(URL, { headers: { 'User-Agent': 'lectern-build/1.0 (one-time fetch of a list page)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const known = new Set();
  for (const f of DICTS) for (const w of fs.readFileSync(f, 'utf8').split('\n')) if (w) known.add(w.trim().toLowerCase());
  let total = 0, multi = 0, real = 0, odd = 0;
  const keep = new Map();
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^([^\s<>{}|=]+)->(.+)$/);
    if (!m) continue;
    total++;
    const [, miss, fix] = m;
    if (fix.includes(',')) { multi++; continue; }
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(miss) || !/^[A-Za-z][A-Za-z '’-]*$/.test(fix.trim())) { odd++; continue; }
    if (known.has(miss.toLowerCase())) { real++; continue; }
    if (miss.toLowerCase() === fix.trim().toLowerCase()) { odd++; continue; }
    keep.set(miss, fix.trim());
  }
  const list = [...keep].sort((a, b) => a[0].localeCompare(b[0])).map(([a, b]) => `${a}->${b}`).join('\n');
  const out = `// Common English misspellings and their corrections, used by shared/proofrules.js.
// Source: Wikipedia contributors, "${TITLE.replace(/_/g, ' ')}", revision ${REVISION} (2024-01-27),
// https://en.wikipedia.org/w/index.php?oldid=${REVISION}. Licence: Creative Commons Attribution-ShareAlike 4.0
// (https://creativecommons.org/licenses/by-sa/4.0/). This file is a filtered copy, under the same licence:
// entries with more than one possible correction were left out, and so was any entry whose "misspelling" is a word
// or name in the macOS word lists (/usr/share/dict). Built by scripts/make-misspellings.js; do not edit by hand.
// ${total} entries read; kept ${keep.size}; left out: ${multi} with several corrections, ${real} that are real words, ${odd} malformed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LecternMisspellings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return { REVISION: ${REVISION}, COUNT: ${keep.size}, LIST: ${JSON.stringify(list)} };
});
`;
  fs.writeFileSync(path.join(__dirname, '..', 'shared', 'misspellings.js'), out);
  console.log(`read ${total}; kept ${keep.size}; several corrections ${multi}; real words ${real}; malformed ${odd}; ${(out.length / 1024).toFixed(0)} KB`);
})().catch((e) => { console.error(e.message); process.exit(1); });
