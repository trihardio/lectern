'use strict';
// Download the CWEB evaluation data (Flachs et al. 2020) at a pinned commit into bench/grammar/data/cweb/.
// Licence: CC BY-NC-SA 4.0. The texts stay on this computer (git-ignored); only hashes go in the manifest.
//   node bench/grammar/fetch.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMMIT = '08d1da0ff2b78885b1f060b4fa11460a98eb9218'; // SimonHFL/CWEB master, 2021-01-08
const BASE = `https://raw.githubusercontent.com/SimonHFL/CWEB/${COMMIT}/data/raw/`;
const FILES = [];
for (const domain of ['G', 'S']) for (const split of ['dev', 'test']) for (const part of ['source', 'ann1', 'ann2']) FILES.push(`CWEB-${domain}.${split}.${part}`);
const DIR = path.join(__dirname, 'data', 'cweb');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const files = {};
  for (const name of FILES) {
    const dest = path.join(DIR, name);
    let buf;
    if (fs.existsSync(dest)) buf = fs.readFileSync(dest);
    else {
      const res = await fetch(BASE + name, { headers: { 'User-Agent': 'lectern-benchmark/1.0' } });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
    }
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n').length;
    files[name] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, lines };
  }
  // The three files of each split must line up.
  for (const domain of ['G', 'S']) for (const split of ['dev', 'test']) {
    const n = ['source', 'ann1', 'ann2'].map((p) => files[`CWEB-${domain}.${split}.${p}`].lines);
    if (new Set(n).size !== 1) throw new Error(`CWEB-${domain}.${split}: line counts differ (${n.join(', ')})`);
  }
  const manifest = {
    dataset: 'CWEB (Corrected Websites)',
    citation: 'Flachs, Lacroix, Yannakoudakis, Rei and Søgaard (2020). Grammatical Error Correction in Low Error Density Domains: A New Benchmark and Analyses. EMNLP 2020, pages 8467-8478.',
    licence: 'CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/). Used here for non-commercial evaluation; the texts are not redistributed.',
    source: `https://github.com/SimonHFL/CWEB/tree/${COMMIT}/data/raw`,
    commit: COMMIT,
    fetched: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  for (const [k, v] of Object.entries(files)) console.log(k.padEnd(22), String(v.lines).padStart(6), 'lines', v.sha256.slice(0, 12));
})().catch((e) => { console.error(e.message); process.exit(1); });
