'use strict';
// Download the gold data for the search benchmark into bench/search/data/raw/ at pinned versions. The data stays on
// this computer (git-ignored); only hashes and sources go in data/manifest.json.
//   node bench/search/fetch.js
// Three sources, all chosen by experts rather than by a model (details and limits: bench/search/README.md):
//   SYNERGY   asreview/synergy-dataset   (CC0-1.0)   included studies of 119 published systematic reviews
//   CLEF TAR  CLEF-TAR/tar               (MIT)       Cochrane reviews and the studies they included (PubMed ids)
//   LitSearch princeton-nlp/LitSearch    (see README) literature-search questions with gold papers (Semantic Scholar ids)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYNERGY_COMMIT = '7efde4a37bed9e8d71f19421b90eae3485184c4d'; // asreview/synergy-dataset master, 2026-11-12
const CLEF_COMMIT = 'dbc13d02bb3e2f8ebc90e62ff47f5eb591e5ca20'; // CLEF-TAR/tar master, 2025-04-17
const LITSEARCH_SHA = '9573fb284a1026c998df47024b888a163f0f0e25'; // princeton-nlp/LitSearch on Hugging Face, 2024-07-09

const RAW = path.join(__dirname, 'data', 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const files = {};

async function get(url, dest, { binary = false } = {}) {
  const full = path.join(RAW, dest);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  let buf;
  if (fs.existsSync(full)) buf = fs.readFileSync(full);
  else {
    await sleep(250);
    const res = await fetch(url, { headers: { 'User-Agent': 'lectern-benchmark/1.0' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(full, buf);
  }
  files[dest] = { sha256: sha(buf), bytes: buf.length };
  return binary ? buf : buf.toString('utf8');
}

async function github(repo, commit, repoPath, dest) {
  return get(`https://raw.githubusercontent.com/${repo}/${commit}/${repoPath}`, dest);
}

(async () => {
  // SYNERGY: the table of reviews and one ids file per review (OpenAlex id, DOI, PubMed id, label_included).
  const toml = await github('asreview/synergy-dataset', SYNERGY_COMMIT, 'datasets.toml', 'synergy/datasets.toml');
  const keys = [...toml.matchAll(/^\s*key = "([^"]+)"/gm)].map((m) => m[1]);
  for (const key of keys) await github('asreview/synergy-dataset', SYNERGY_COMMIT, `datasets/${key}/${key}_ids.csv`, `synergy/${key}_ids.csv`);
  console.log(`SYNERGY: ${keys.length} reviews`);

  // CLEF TAR: titles come from the topic files, included studies from the "content" qrels (full-text level).
  const clef = (p, dest) => github('CLEF-TAR/tar', CLEF_COMMIT, p, `clef/${dest}`);
  await clef('2017-TAR/testing/qrels/qrel_content_test.txt', '2017.content.qrels');
  await clef('2018-TAR/Task2/Testing/qrels/full.test.content.2018.qrels', '2018.content.qrels');
  await clef('2019-TAR/Task2/Testing/Intervention/qrels/full.test.intervention.content.2019.qrels', '2019i.content.qrels');
  const listing = async (p) => (await (await fetch(`https://api.github.com/repos/CLEF-TAR/tar/contents/${p}?ref=${CLEF_COMMIT}`, { headers: { 'User-Agent': 'lectern-benchmark/1.0' } })).json()).map((x) => x.name);
  const topicIds = { '2017': [], '2018': [], '2019i': [] };
  for (const [year, dir] of [['2017', '2017-TAR/testing/topics'], ['2018', '2018-TAR/Task2/Testing/topics'], ['2019i', '2019-TAR/Task2/Testing/Intervention/topics']]) {
    await sleep(300);
    for (const name of await listing(dir)) {
      await clef(`${dir}/${name}`, `topics/${year}/${name}`);
      topicIds[year].push(name);
    }
  }
  console.log('CLEF TAR topics:', Object.fromEntries(Object.entries(topicIds).map(([k, v]) => [k, v.length])));

  // LitSearch: the 597 queries through the Hugging Face dataset viewer (rows of the pinned dataset revision).
  const rows = [];
  for (let off = 0; off < 597; off += 100) {
    const text = await get(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/LitSearch&config=query&split=full&offset=${off}&length=100&revision=${LITSEARCH_SHA}`, `litsearch/query.${off}.json`);
    rows.push(...JSON.parse(text).rows.map((r) => r.row));
  }
  fs.writeFileSync(path.join(RAW, 'litsearch', 'query.all.json'), JSON.stringify(rows));
  console.log('LitSearch queries:', rows.length);

  const manifest = {
    fetched: new Date().toISOString(),
    sources: {
      synergy: { name: 'SYNERGY (De Bruin et al.)', url: 'https://github.com/asreview/synergy-dataset', commit: SYNERGY_COMMIT, licence: 'CC0-1.0 (repository licence)', reviews: keys.length },
      clef: { name: 'CLEF eHealth TAR 2017-2019 (Kanoulas et al.)', url: 'https://github.com/CLEF-TAR/tar', commit: CLEF_COMMIT, licence: 'MIT (repository licence)', topics: Object.fromEntries(Object.entries(topicIds).map(([k, v]) => [k, v.length])) },
      litsearch: { name: 'LitSearch (Ajith et al. 2024)', url: 'https://huggingface.co/datasets/princeton-nlp/LitSearch', revision: LITSEARCH_SHA, licence: 'none stated on the dataset card; the code repository (github.com/princeton-nlp/LitSearch) is MIT', queries: rows.length },
    },
    files,
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(`${Object.keys(files).length} files hashed into data/manifest.json`);
})().catch((e) => { console.error(e.message); process.exit(1); });
