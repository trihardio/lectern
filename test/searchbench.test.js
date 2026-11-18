'use strict';
// Offline tests for the search benchmark's metrics, cache keys and bootstrap, with tiny made-up data.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../bench/search/metrics');
const http = require('../bench/search/http');

const gold = [
  { doi: '10.1001/a', title: 'Alpha study of something long enough to match' },
  { doi: '10.1001/b', title: 'Beta study of something long enough to match' },
  { doi: '', title: 'Gamma study without any doi at all in gold', oa: 'W3' },
  { doi: '10.1001/d', title: 'Delta', altDois: ['10.48550/arxiv.1234.5678'] },
];
const p = (doi, title, extra = {}) => ({ doi, title, sources: ['openalex'], ...extra });

test('matching: DOI, OpenAlex id, title and alternative DOI; short titles never match alone', () => {
  const idx = M.goldIndex(gold);
  assert.strictEqual(M.matchPaper(p('10.1001/A', 'x'), idx), 0); // DOI is case-insensitive
  assert.strictEqual(M.matchPaper(p('', 'Something else', { oaId: 'W3' }), idx), 2);
  assert.strictEqual(M.matchPaper(p('', 'beta STUDY of something, long enough to match!'), idx), 1); // normalised title
  assert.strictEqual(M.matchPaper(p('https://doi.org/10.48550/arXiv.1234.5678', 'Other'), idx), 3);
  assert.strictEqual(M.matchPaper(p('', 'Delta'), idx), -1); // too short to trust
  assert.strictEqual(M.matchPaper(p('10.9009/zzz', 'Unrelated paper about nothing in particular'), idx), -1);
});

test('goldRanks counts a gold paper once, at its best rank', () => {
  const papers = [p('10.9009/x', 'Noise one is here for padding purposes'), p('10.1001/b', 'B'), p('10.1001/a', 'A'), p('10.1001/b', 'B again under another record')];
  assert.deepStrictEqual(M.goldRanks(papers, gold), [3, 2, null, null]);
});

test('recall at k, capped and uncapped', () => {
  const ranks = [3, 2, null, 30]; // 4 gold papers
  assert.strictEqual(M.recallAtK(ranks, 25), 0.5);
  assert.strictEqual(M.recallAtK(ranks, 40), 0.75);
  assert.strictEqual(M.recallAtK(ranks, 2, { cap: true }), 0.5); // 1 hit of min(4, 2) = 2
  const many = Array.from({ length: 60 }, (_, i) => i + 1); // 60 gold papers, all in the top 60
  assert.strictEqual(M.recallAtK(many, 25), 25 / 60);
  assert.strictEqual(M.recallAtK(many, 25, { cap: true }), 1); // nothing better is possible at 25
  assert.strictEqual(M.recallAtK([], 25), null);
});

test('nDCG: perfect list is 1, a late hit is less, known value', () => {
  assert.strictEqual(M.ndcgAtK([1, 2], 25), 1);
  const late = M.ndcgAtK([3], 25); // one gold paper at rank 3: (1/log2(4)) / (1/log2(2)) = 0.5
  assert.ok(Math.abs(late - 0.5) < 1e-12);
  assert.strictEqual(M.ndcgAtK([null, null], 25), 0);
  assert.strictEqual(M.ndcgAtK([30], 25), 0); // beyond the cut
});

test('MRR uses the first gold paper found', () => {
  assert.strictEqual(M.mrr([4, 2, null]), 0.5);
  assert.strictEqual(M.mrr([null]), 0);
});

test('questionMetrics separates a database miss from a ranking miss', () => {
  const ranked = [p('10.1001/a', 'A')];
  const pool = [p('10.1001/a', 'A'), p('10.1001/b', 'B')]; // b was found but fell out of the cut
  const lists = [
    { source: 'openalex', qi: 0, papers: [p('10.1001/a', 'A'), p('10.1001/b', 'B')] },
    { source: 'crossref', qi: 0, papers: [p('10.1001/a', 'A')] },
  ];
  const r = M.questionMetrics({ ranked, pool, lists, gold: gold.slice(0, 2), ks: [25] });
  assert.strictEqual(r.metrics['recall@25'], 0.5);
  assert.strictEqual(r.metrics.foundAnywhere, 1);
  assert.deepStrictEqual(r.perSource, { openalex: { found: 2, unique: 1 }, crossref: { found: 1, unique: 0 } });
});

test('paired bootstrap: same seed gives the same interval; a clear gain excludes zero; no change includes it', () => {
  const a = Array.from({ length: 40 }, (_, i) => (i % 5) / 10);
  const better = a.map((x) => x + 0.2);
  const r1 = M.pairedBootstrap(a, better, { B: 2000 });
  const r2 = M.pairedBootstrap(a, better, { B: 2000 });
  assert.deepStrictEqual(r1, r2);
  assert.ok(Math.abs(r1.diff - 0.2) < 1e-12 && r1.lo > 0.19 && r1.hi < 0.21);
  const same = M.pairedBootstrap(a, a, { B: 500 });
  assert.strictEqual(same.diff, 0);
  assert.ok(same.lo <= 0 && same.hi >= 0);
  const noisy = a.map((x, i) => x + (i % 2 ? 0.1 : -0.1));
  const r3 = M.pairedBootstrap(a, noisy, { B: 2000 });
  assert.ok(r3.lo < 0 && r3.hi > 0);
  assert.throws(() => M.pairedBootstrap([1], [1, 2]));
});

test('bootstrapMean covers the mean', () => {
  const r = M.bootstrapMean([0, 0, 1, 1, 1, 0, 1, 0], { B: 1000 });
  assert.strictEqual(r.mean, 0.5);
  assert.ok(r.lo <= 0.5 && r.hi >= 0.5 && r.lo >= 0 && r.hi <= 1);
});

test('summarizeRun groups by discipline and totals per-database gold', () => {
  const q = (d, m, ps) => ({ discipline: d, source: 's', metrics: { gold: 2, pool: 10, 'recall@25': m, 'recall@40': m, 'recallAll@25': m, 'recallAll@40': m, 'ndcg@25': m, mrr: m, foundAnywhere: m }, perSource: ps });
  const s = M.summarizeRun({ a: q('x', 1, { openalex: { found: 2, unique: 1 } }), b: q('x', 0, { openalex: { found: 0, unique: 0 } }), c: q('y', 1, {}) });
  assert.strictEqual(s.overall.n, 3);
  assert.strictEqual(s.byDiscipline.x['recall@25'].mean, 0.5);
  assert.deepStrictEqual(s.perDatabase, { openalex: { found: 2, unique: 1 } });
  assert.strictEqual(s.goldTotal, 6);
});

test('cache keys drop keys and contact addresses, so a key can never reach the cache', () => {
  const a = http.cacheUrl('https://api.openalex.org/works?search=sleep&api_key=SECRET&mailto=me@example.org&per_page=25');
  assert.strictEqual(a, 'https://api.openalex.org/works?search=sleep&per_page=25');
  assert.ok(!/SECRET|example/.test(a));
  assert.strictEqual(http.cacheUrl('https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=x&email=me%40example.org'), 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=x');
  assert.notStrictEqual(http.keyOf('POST', 'https://a.org/x', '{"ids":[1]}').hash, http.keyOf('POST', 'https://a.org/x', '{"ids":[2]}').hash);
});

test('OpenAlex cost: a search is one unit, a filter-only list a tenth, a single entity nothing, other hosts nothing', () => {
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?search=sleep&per_page=25'), 1);
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?filter=doi:10.1001/x'), 0.1);
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works/https://doi.org/10.1001/x?select=id'), 0);
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?search.semantic=sleep'), 1);
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?filter=title_and_abstract.search:sleep'), 0.1); // not one of the named search parameters
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?filter=publication_year:2020,search.title_abstract_keywords:sleep'), 1);
  assert.strictEqual(http.openalexCost('https://api.openalex.org/works?search=sleep&rerank=true'), 2);
  assert.strictEqual(http.openalexCost('https://api.crossref.org/works?query=x'), 0);
});

test('offline replay fails on a cache miss and records it, without touching the network', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cache-'));
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('the network must not be used'); };
  const net = http.install({ offline: true, cacheDir: dir });
  try {
    await assert.rejects(() => fetch('https://api.crossref.org/works?query=x&mailto=a@b.org'), /no cached answer/);
    assert.deepStrictEqual(net.stats.misses.length, 1);
    assert.ok(!net.stats.misses[0].includes('a@b.org'));
  } finally { net.restore(); globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two benchmark processes share one host: never at the same time, and never closer than the gap', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pace-'));
  const log = path.join(dir, 'log.txt');
  const child = (tag) => `
    const fs = require('fs');
    globalThis.fetch = async () => { // stands in for the network: it records when each request starts and ends
      const start = Date.now(); await new Promise((r) => setTimeout(r, 60)); const end = Date.now();
      fs.appendFileSync(${JSON.stringify(log)}, start + ' ' + end + '\\n');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const http = require(${JSON.stringify(path.join(__dirname, '../bench/search/http.js'))});
    http.install({ cacheDir: ${JSON.stringify(path.join(dir, 'cache'))}, stateDir: ${JSON.stringify(dir)}, gaps: { 'api.semanticscholar.org': 150 } });
    (async () => { await Promise.all([1, 2, 3].map((i) => fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=${tag}' + i))); })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  `;
  const run = (tag) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', child(tag)], { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}`))));
  });
  try {
    await Promise.all([run('a'), run('b')]);
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)).sort((x, y) => x[0] - y[0]);
    assert.strictEqual(rows.length, 6);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i][0] >= rows[i - 1][1], `request ${i} started before the previous one ended`);
      assert.ok(rows[i][0] - rows[i - 1][1] >= 150 - 25, `gap ${rows[i][0] - rows[i - 1][1]} ms is shorter than 150`);
    }
    const counter = JSON.parse(fs.readFileSync(path.join(dir, 'requests.json'), 'utf8'));
    assert.strictEqual(counter.total['api.semanticscholar.org'], 6); // both processes counted into the one file
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lock left by a dead process is taken over', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-stale-'));
  fs.mkdirSync(path.join(dir, 'locks', 'api.crossref.org.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'locks', 'api.crossref.org.lock', 'pid'), '999999999'); // no such process
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  const net = http.install({ cacheDir: path.join(dir, 'cache'), stateDir: dir, gaps: { 'api.crossref.org': 0 } });
  try {
    const r = await fetch('https://api.crossref.org/works?query=x');
    assert.strictEqual((await r.json()).ok, 1);
    assert.strictEqual(net.stats.live, 1);
    const again = await fetch('https://api.crossref.org/works?query=x'); // now served from the cache
    assert.strictEqual((await again.json()).ok, 1);
    assert.strictEqual(net.stats.live, 1); assert.strictEqual(net.stats.hits, 1);
  } finally { net.restore(); globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a busy answer (429) is retried inside the wrapper and each attempt is counted; a good answer is cached, a failure is not', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-retry-'));
  const real = globalThis.fetch;
  let calls = 0; let alwaysBusy = false;
  globalThis.fetch = async () => { calls++; return alwaysBusy || calls <= 2 ? new Response('busy', { status: 429 }) : new Response('{"ok":2}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const net = http.install({ cacheDir: path.join(dir, 'cache'), stateDir: dir, gaps: { 'api.semanticscholar.org': 0 }, retryPausesMs: [5, 5] });
  try {
    const r = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=a');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(net.stats.live, 3); assert.strictEqual(net.stats.retries, 2);
    alwaysBusy = true; // every further attempt is a 429
    const bad = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=b');
    assert.strictEqual(bad.status, 429); // given back after three attempts, not stored
    assert.strictEqual(net.stats.live, 6);
    const again = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=a');
    assert.strictEqual(again.status, 200); assert.strictEqual(net.stats.hits, 1);
  } finally { net.restore(); globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});
