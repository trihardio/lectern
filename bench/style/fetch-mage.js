'use strict';
const path = require('path');
const fs = require('fs'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const { rng } = require(ROOT + '/bench/metrics');
const UA = { 'user-agent': 'Lectern-bench/0.1 (research evaluation of a writing-pattern review)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wc = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
const hash = (s) => crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
const CACHE = path.join(ROOT, 'bench/data/cache/style'); fs.mkdirSync(CACHE, { recursive: true });
async function page(offset) {
  const f = path.join(CACHE, `mage-test-${offset}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=yaful/MAGE&config=default&split=test&offset=${offset}&length=100`, { headers: UA });
    if (r.ok) { const j = await r.json(); fs.writeFileSync(f, JSON.stringify(j)); return j; }
    await sleep(2000 * 2 ** i);
  }
  throw new Error('page ' + offset);
}
(async () => {
  const devHashes = new Set(fs.readFileSync(ROOT + '/bench/data/dev.jsonl', 'utf8').trim().split('\n').map((l) => hash(JSON.parse(l).text)));
  const r = rng(20261117); const offs = new Set();
  while (offs.size < 70) offs.add(Math.floor((r() * 60700) / 100) * 100);
  const per = {}; const out = []; const seen = new Set();
  for (const off of [...offs].sort((a, b) => a - b)) {
    const j = await page(off); await sleep(300);
    for (const { row, row_idx } of j.rows || []) {
      const n = wc(row.text); if (n < 80 || n > 1200) continue;
      const h = hash(row.text); if (seen.has(h) || devHashes.has(h)) continue;
      if ((per[row.src] || 0) >= 60) continue;
      seen.add(h); per[row.src] = (per[row.src] || 0) + 1;
      out.push({ source: 'MAGE', ref: `MAGE/test/${row_idx}`, group: `mage:${row.src}`, src: row.src, label: row.label === 1 ? 'human' : 'ai', text: row.text });
    }
  }
  fs.writeFileSync(path.join(ROOT, 'bench/data/style/mage.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const c = {}; for (const o of out) c[o.label] = (c[o.label] || 0) + 1;
  console.log('docs', out.length, JSON.stringify(c), 'sources', Object.keys(per).length);
})();
