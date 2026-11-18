'use strict';
// Step 1 of building the question set: look up the title and field of each SYNERGY review paper (by its DOI), so a
// natural question can be written for it. Reads bench/search/data/raw/synergy/datasets.toml.
//   node bench/search/reviews.js
const fs = require('fs');
const path = require('path');
const http = require('./http');
const { makeSettings } = require('./settings');
const { fetchJson } = require('../../server/util');

(async () => {
  const net = http.install({});
  const settings = makeSettings({ useSavedKeys: true });
  const toml = fs.readFileSync(path.join(__dirname, 'data/raw/synergy/datasets.toml'), 'utf8');
  const blocks = toml.split('[[datasets]]').slice(1);
  const reviews = blocks.map((b) => ({ key: /key = "([^"]+)"/.exec(b)[1], doi: (/\[datasets\.publication\][\s\S]*?\bdoi = "([^"]+)"/.exec(b) || [])[1] || '' }));
  const withDoi = reviews.filter((r) => r.doi);
  const byDoi = new Map();
  for (let i = 0; i < withDoi.length; i += 50) {
    const chunk = withDoi.slice(i, i + 50).map((r) => r.doi.toLowerCase());
    const q = new URLSearchParams({ filter: `doi:${chunk.map((d) => `https://doi.org/${d}`).join('|')}`, per_page: '50', select: 'id,doi,display_name,publication_year,type,primary_topic' });
    if (settings.keys.openalex) q.set('api_key', settings.keys.openalex);
    const json = await fetchJson(`https://api.openalex.org/works?${q}`);
    for (const w of json.results) byDoi.set(String(w.doi || '').toLowerCase().replace('https://doi.org/', ''), w);
  }
  const out = reviews.map((r) => {
    const w = byDoi.get(r.doi.toLowerCase());
    const t = w && w.primary_topic;
    return { key: r.key, doi: r.doi, title: w ? w.display_name : '', year: w ? w.publication_year : null, field: t && t.field ? t.field.display_name : '', domain: t && t.domain ? t.domain.display_name : '', topic: t ? t.display_name : '' };
  });
  fs.writeFileSync(path.join(__dirname, 'data/work/synergy-reviews.json'), JSON.stringify(out, null, 1));
  console.log(`reviews ${out.length}, with title ${out.filter((r) => r.title).length}; live requests ${net.stats.live}, cache hits ${net.stats.hits}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
