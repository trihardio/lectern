'use strict';
const path = require('path');
const fs = require('fs'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..'); const { rng } = require(ROOT + '/bench/metrics');
const UA = { 'user-agent': 'Lectern-bench/0.1 (research evaluation of a writing-pattern review)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wc = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
const hash = (s) => crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
const CACHE = path.join(ROOT, 'bench/data/cache/style'); fs.mkdirSync(CACHE, { recursive: true });
async function page(split, offset) {
  const f = path.join(CACHE, `dactyl-${split}-${offset}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for (let i = 0; i < 7; i++) {
    try {
      const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=ShantanuT01/DACTYL&config=default&split=${split}&offset=${offset}&length=100`, { headers: UA });
      if (r.ok) { const j = await r.json(); fs.writeFileSync(f, JSON.stringify(j)); return j; }
    } catch {}
    await sleep(2000 * 2 ** i);
  }
  return { rows: [] };
}
async function sample(split, total, pages, seed, cap, exclude) {
  const r = rng(seed); const offs = new Set();
  while (offs.size < pages) offs.add(Math.floor((r() * (total - 100)) / 100) * 100);
  const per = {}; const out = [];
  for (const off of [...offs].sort((a, b) => a - b)) {
    const j = await page(split, off); await sleep(250);
    for (const { row } of j.rows || []) {
      const n = wc(row.text); if (n < 80 || n > 1200) continue;
      const h = hash(row.text); if (exclude.has(h)) continue;
      const key = `${row.domain}|${row.model}`; if ((per[key] || 0) >= cap) continue;
      exclude.add(h); per[key] = (per[key] || 0) + 1;
      out.push({ source: 'DACTYL', ref: `DACTYL/${split}/${row.id}`, group: `dactyl:${row.domain}:${row.id}`, domain: row.domain, model: row.model, label: row.target === 1 ? 'ai' : 'human', text: row.text });
    }
  }
  return out;
}
(async () => {
  const seen = new Set();
  for (const f of [ROOT + '/bench/data/dev.jsonl', ROOT + '/bench/data/holdout.jsonl', path.join(ROOT, 'bench/data/style/mage.jsonl')]) for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) seen.add(hash(JSON.parse(l).text));
  const train = await sample('train', 466005, 60, 777, 30, seen);
  const test = await sample('test', 96998, 80, 4242, 40, seen);
  for (const [n, rows] of [['dactyl-train', train], ['dactyl-test', test]]) {
    fs.writeFileSync(path.join(ROOT, 'bench/data/style', `${n}.jsonl`), rows.map((o) => JSON.stringify(o)).join('\n') + '\n');
    const c = {}; for (const o of rows) c[o.label] = (c[o.label] || 0) + 1;
    const models = [...new Set(rows.map((o) => o.model))];
    console.log(n, rows.length, JSON.stringify(c), 'models', models.length, models.slice(0, 14).join(', '));
  }
})();
