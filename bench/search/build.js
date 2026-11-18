'use strict';
// Build the question set from the downloaded gold data (run fetch.js and reviews.js first).
//   node bench/search/build.js select     choose which reviews, topics and queries go in (seeded, no network)
//   node bench/search/build.js build      look up the gold papers (DOI, title) in OpenAlex and Semantic Scholar through
//                                         the cache, write data/dev.jsonl, data/holdout.jsonl and data/splits.json
// The questions for SYNERGY and CLEF reviews were written by hand from the review titles
// (data/synergy-questions.json, data/clef-questions.json). LitSearch questions are the dataset's own.
const fs = require('fs');
const path = require('path');
const http = require('./http');
const { makeSettings } = require('./settings');
const { rng } = require('./metrics');
const { fetchJson, normDoi } = require('../../server/util');

const DATA = path.join(__dirname, 'data');
const RAW = path.join(DATA, 'raw');
const SEED = 20261118; // fixed for the selection and the split
const SIZE = { synergy: [8, 80], clef: [6, 60] }; // included studies per review: enough to measure, few enough that 25-40 results can reach them

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const shuffle = (arr, rand) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => { const v = l.split(','); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
}

function clefTopics() {
  const out = [];
  for (const y of ['2017', '2018', '2019i']) {
    const rel = {};
    for (const l of fs.readFileSync(path.join(RAW, 'clef', `${y}.content.qrels`), 'utf8').split('\n')) {
      const p = l.trim().split(/\s+/);
      if (p.length === 4 && p[3] === '1') (rel[p[0]] = rel[p[0]] || []).push(p[2]);
    }
    for (const name of fs.readdirSync(path.join(RAW, 'clef', 'topics', y))) {
      const txt = fs.readFileSync(path.join(RAW, 'clef', 'topics', y, name), 'utf8');
      const id = /Topic:\s*(\S+)/.exec(txt)[1];
      out.push({ id, year: y, kind: y === '2019i' ? 'intervention' : 'dta', title: /Title:\s*(.*)/.exec(txt)[1].trim(), pmids: [...new Set(rel[id] || [])] });
    }
  }
  return out.filter((t) => t.pmids.length >= SIZE.clef[0] && t.pmids.length <= SIZE.clef[1]);
}

function select() {
  const rand = rng(SEED);
  const reviews = readJson(path.join(DATA, 'work/synergy-reviews.json'));
  const hand = readJson(path.join(DATA, 'synergy-questions.json'));
  const synergy = [];
  for (const h of hand) {
    const rows = parseCsv(fs.readFileSync(path.join(RAW, 'synergy', `${h.key}_ids.csv`), 'utf8')).filter((r) => r.label_included === '1');
    if (rows.length < SIZE.synergy[0] || rows.length > SIZE.synergy[1]) { console.log(`skip ${h.key}: ${rows.length} included`); continue; }
    const rv = reviews.find((r) => r.key === h.key);
    const norm = (v, re) => { const m = re.exec(String(v || '').toLowerCase()); return m ? m[1] : ''; };
    const recs = rows.map((r) => ({ oa: norm(r.openalex_id, /(w\d+)$/), doi: normDoi(r.doi), pmid: norm(r.pmid, /(\d+)$/) })).filter((r) => r.oa || r.doi || r.pmid);
    synergy.push({ key: h.key, discipline: h.discipline, question: h.question, reviewTitle: rv.title, reviewDoi: rv.doi, records: recs, noIdentifier: rows.length - recs.length });
  }
  const topics = clefTopics();
  const hasQ = fs.existsSync(path.join(DATA, 'clef-questions.json')) ? readJson(path.join(DATA, 'clef-questions.json')) : {};
  const inter = topics.filter((t) => t.kind === 'intervention' && t.pmids.length >= 6);
  const dta = shuffle(topics.filter((t) => t.kind === 'dta'), rand).slice(0, 22);
  const clef = [...inter, ...dta].map((t) => ({ ...t, question: hasQ[t.id] || '' }));
  const lit = readJson(path.join(RAW, 'litsearch', 'query.all.json')).map((q, i) => ({ ...q, row: i }));
  const manual = shuffle(lit.filter((q) => q.query_set.startsWith('manual') && q.quality === 2), rand).slice(0, 20);
  const inline = shuffle(lit.filter((q) => q.query_set.startsWith('inline') && q.quality === 2), rand).slice(0, 10);
  const litsearch = [...manual, ...inline];
  fs.writeFileSync(path.join(DATA, 'work/selection.json'), JSON.stringify({ synergy, clef, litsearch }, null, 1));
  console.log(`selected: SYNERGY ${synergy.length}, CLEF ${clef.length} (${clef.filter((c) => !c.question).length} without a question yet), LitSearch ${litsearch.length}`);
  for (const c of clef.filter((c) => !c.question)) console.log(c.id, c.kind, c.pmids.length, '|', c.title);
}

async function oaBatch(settings, filterName, ids, select) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({ filter: `${filterName}:${ids.slice(i, i + 50).join('|')}`, per_page: '50', select });
    if (settings.keys.openalex) q.set('api_key', settings.keys.openalex);
    try { out.push(...(await fetchJson(`https://api.openalex.org/works?${q}`)).results); } catch (e) { throw new Error(`OpenAlex ${filterName} lookup: ${e.message} ${e.body || ''}`.slice(0, 400)); }
  }
  return out;
}

const goldFromOa = (w) => ({ doi: normDoi(w.doi), title: w.display_name || '', oa: String(w.id).split('/').pop().toLowerCase(), year: w.publication_year || null });

async function build() {
  const sel = readJson(path.join(DATA, 'work/selection.json'));
  const net = http.install({});
  const settings = makeSettings({ useSavedKeys: true });
  if (!settings.keys.openalex || !settings.keys.semanticscholar) console.log('Note: a key is missing; requests still work but are slower or less reliable.');
  const questions = [];
  const unmapped = { synergy: 0, clef: 0, litsearch: 0 };
  const goldTotal = { synergy: 0, clef: 0, litsearch: 0 };
  const SEL = 'id,doi,display_name,publication_year,ids';

  // SYNERGY: an included record has an OpenAlex id, a DOI, a PubMed id, or several. Look each up in OpenAlex for its
  // title and DOI. A record OpenAlex does not know but that has a DOI stays, with an empty title.
  const recs = sel.synergy.flatMap((s) => s.records);
  const byOa = new Map(); const byDoiMap = new Map(); const byPmid = new Map();
  const index = (w) => {
    byOa.set(String(w.id).split('/').pop().toLowerCase(), w);
    if (w.doi) byDoiMap.set(normDoi(w.doi), w);
    const m = /(\d+)$/.exec((w.ids && w.ids.pmid) || '');
    if (m) byPmid.set(m[1], w);
  };
  for (const w of await oaBatch(settings, 'openalex', [...new Set(recs.map((r) => r.oa).filter(Boolean))], SEL)) index(w);
  const needDoi = [...new Set(recs.filter((r) => !(r.oa && byOa.has(r.oa)) && r.doi).map((r) => `https://doi.org/${r.doi}`))];
  for (const w of await oaBatch(settings, 'doi', needDoi, SEL)) index(w);
  const needPmid = [...new Set(recs.filter((r) => !(r.oa && byOa.has(r.oa)) && !(r.doi && byDoiMap.has(r.doi)) && r.pmid).map((r) => r.pmid))];
  for (const w of await oaBatch(settings, 'pmid', needPmid, SEL)) index(w);
  for (const s of sel.synergy) {
    const gold = []; const seen = new Set();
    goldTotal.synergy += s.noIdentifier; unmapped.synergy += s.noIdentifier; // included records with no id, DOI or PubMed id in SYNERGY
    for (const r of s.records) {
      goldTotal.synergy++;
      const w = (r.oa && byOa.get(r.oa)) || (r.doi && byDoiMap.get(r.doi)) || (r.pmid && byPmid.get(r.pmid)) || null;
      const item = w && w.display_name ? goldFromOa(w) : (r.doi ? { doi: r.doi, title: '', oa: r.oa || '', year: null } : null);
      if (!item) { unmapped.synergy++; continue; }
      const key = item.oa || item.doi;
      if (seen.has(key)) continue; // two records of the same work
      seen.add(key);
      gold.push(item);
    }
    questions.push({ id: `syn-${s.key}`, question: s.question, discipline: s.discipline, source: 'synergy', reference: s.reviewDoi, goldItems: gold });
  }

  // CLEF: PubMed ids -> OpenAlex works (by the pmid filter).
  const pmids = [...new Set(sel.clef.flatMap((c) => c.pmids))];
  const clefWorks = new Map();
  for (const w of await oaBatch(settings, 'pmid', pmids, SEL)) {
    const m = /(\d+)$/.exec((w.ids && w.ids.pmid) || '');
    if (m) clefWorks.set(m[1], w);
  }
  for (const c of sel.clef) {
    if (!c.question) throw new Error(`No question written for CLEF topic ${c.id}. Add it to data/clef-questions.json.`);
    const gold = [];
    for (const p of c.pmids) {
      goldTotal.clef++;
      const w = clefWorks.get(p);
      if (!w || !w.display_name) { unmapped.clef++; continue; }
      gold.push({ ...goldFromOa(w), pmid: p });
    }
    questions.push({ id: `clef-${c.id}`, question: c.question, discipline: 'health', source: 'clef', reference: c.id, goldItems: gold });
  }

  // LitSearch: Semantic Scholar corpus ids -> title and DOI (an arXiv paper without a DOI gets its arXiv DOI).
  const corpus = [...new Set(sel.litsearch.flatMap((q) => q.corpusids))];
  const s2 = new Map();
  for (let i = 0; i < corpus.length; i += 100) {
    const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,externalIds,year,paperId', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'lectern-benchmark/1.0', ...(settings.keys.semanticscholar ? { 'x-api-key': settings.keys.semanticscholar } : {}) },
      body: JSON.stringify({ ids: corpus.slice(i, i + 100).map((c) => `CorpusId:${c}`) }),
    });
    if (!res.ok) throw new Error(`Semantic Scholar batch lookup: HTTP ${res.status}`);
    const arr = await res.json();
    arr.forEach((p, k) => { if (p && p.title) s2.set(corpus[i + k], p); });
  }
  for (const q of sel.litsearch) {
    const gold = [];
    for (const cid of q.corpusids) {
      goldTotal.litsearch++;
      const p = s2.get(cid);
      if (!p) { unmapped.litsearch++; continue; }
      const ex = p.externalIds || {};
      const doi = normDoi(ex.DOI);
      const arxiv = ex.ArXiv ? normDoi(`10.48550/arxiv.${ex.ArXiv}`) : '';
      gold.push({ doi: doi || arxiv, altDois: doi && arxiv ? [arxiv] : [], title: p.title, year: p.year || null, corpusId: cid });
    }
    questions.push({ id: `lit-${q.row}`, question: q.query, discipline: 'cs', source: 'litsearch', reference: `${q.query_set} specificity ${q.specificity}`, goldItems: gold });
  }

  // Keep questions with at least 3 gold papers that could be mapped.
  const dropped = questions.filter((q) => q.goldItems.length < 3 && q.source !== 'litsearch').map((q) => q.id);
  const kept = questions.filter((q) => !dropped.includes(q.id) && q.goldItems.length >= 1);
  for (const q of kept) q.gold = q.goldItems.map((g) => g.doi).filter(Boolean);

  // Split: within each source and discipline, shuffle with the fixed seed and alternate dev, holdout, dev ...
  const rand = rng(SEED + 1);
  const strata = new Map();
  for (const q of kept) { const k = `${q.source}|${q.discipline}`; if (!strata.has(k)) strata.set(k, []); strata.get(k).push(q); }
  const flip = rand() < 0.5;
  let toggle = flip;
  for (const k of [...strata.keys()].sort()) {
    for (const q of shuffle(strata.get(k), rand)) { q.split = toggle ? 'dev' : 'holdout'; toggle = !toggle; }
  }
  const line = (q) => JSON.stringify({ id: q.id, question: q.question, discipline: q.discipline, source: q.source, gold: q.gold, goldItems: q.goldItems, reference: q.reference });
  for (const split of ['dev', 'holdout']) {
    fs.writeFileSync(path.join(DATA, `${split}.jsonl`), kept.filter((q) => q.split === split).map(line).join('\n') + '\n');
  }
  const count = (f) => kept.filter(f).length;
  const splits = {
    seed: SEED,
    note: 'Ids only. The questions and gold papers are rebuilt locally by fetch.js, reviews.js and build.js; the dev and holdout files stay out of git.',
    dev: kept.filter((q) => q.split === 'dev').map((q) => q.id),
    holdout: kept.filter((q) => q.split === 'holdout').map((q) => q.id),
    strata: Object.fromEntries([...strata.entries()].map(([k, v]) => [k, { dev: v.filter((q) => q.split === 'dev').length, holdout: v.filter((q) => q.split === 'holdout').length }])),
  };
  fs.writeFileSync(path.join(DATA, 'splits.json'), JSON.stringify(splits, null, 1) + '\n');
  const man = readJson(path.join(DATA, 'manifest.json'));
  man.questions = {
    built: new Date().toISOString(), total: kept.length, droppedForTooFewGold: dropped,
    goldItemsBySource: Object.fromEntries(['synergy', 'clef', 'litsearch'].map((s) => [s, { listed: goldTotal[s], unmapped: unmapped[s], mapped: goldTotal[s] - unmapped[s], withoutDoi: kept.filter((q) => q.source === s).reduce((n, q) => n + q.goldItems.filter((g) => !g.doi).length, 0) }])),
    byDiscipline: Object.fromEntries([...new Set(kept.map((q) => q.discipline))].map((d) => [d, count((q) => q.discipline === d)])),
  };
  fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(man, null, 1) + '\n');
  console.log(JSON.stringify({ total: kept.length, dev: splits.dev.length, holdout: splits.holdout.length, strata: splits.strata, gold: man.questions.goldItemsBySource, dropped }, null, 1));
  console.log(`live requests ${net.stats.live}, cache hits ${net.stats.hits}`);
}

const cmd = process.argv[2];
(cmd === 'select' ? Promise.resolve(select()) : cmd === 'build' ? build() : Promise.reject(new Error('Usage: node bench/search/build.js select|build')))
  .catch((e) => { console.error(e.message); process.exit(1); });
