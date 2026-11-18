'use strict';
// Ranking, de-duplication and the pacing of database requests. Offline: hand-made pools, the canned responses in
// test/mock-fetch.js, and a fake clock for the request limiter (no real waiting).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mock = require('./mock-fetch');
const { makePaper } = require('../server/sources/common');
const { normTitle } = require('../server/util');
const rel = require('../server/sources/relevance');
const S = require('../server/sources');

const flush = () => new Promise((r) => setImmediate(r));

/** A clock and timers the test moves by hand. */
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimer: (id) => { const i = timers.indexOf(id); if (i !== -1) timers.splice(i, 1); },
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const next = timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

let seq = 0;
/** A paper as a database adapter would make it. */
function paper(over = {}) {
  seq++;
  return makePaper({
    source: 'crossref', doi: `10.5555/rank.${seq}`, title: `Sample record number ${seq} about something`,
    authors: ['Amira Solberg', 'Jun Hattori'], year: 2020, venue: 'Sample Journal',
    abstract: 'Sample abstract. '.repeat(10), ...over,
  });
}
const list = (source, qi, papers) => ({ source, qi, papers });

// ---- the text match (server/sources/relevance.js)

test('analyse: stopwords out, plurals joined, British spelling made American, Greek letters and other scripts kept', () => {
  assert.deepEqual(rel.analyse('Does the randomised trial show effects of behaviours?'), ['randomized', 'trial', 'behavior']);
  assert.deepEqual(rel.analyse('What does research say makes a good learning environment?'), ['learning', 'environment'], 'words of asking are not the topic');
  assert.deepEqual(rel.analyse('What does research say makes a good learning environment?', 's', 'base'), ['say', 'make', 'good', 'learning', 'environment']);
  assert.deepEqual(rel.analyse('Paediatric anaemia and oestrogen'), ['pediatric', 'anemia', 'estrogen']);
  assert.deepEqual(rel.analyse('β-amyloid and TNF-α'), rel.analyse('beta-amyloid and TNF-alpha'));
  assert.deepEqual(rel.analyse('远程办公 и производительность'), ['远程办公', 'производительность'], 'one-letter words are dropped in any script');
  assert.deepEqual(rel.analyse('studies of working mothers', 'porter1'), ['work', 'mother']);
  assert.equal(rel.sStem('ponies'), 'pony');
  assert.equal(rel.sStem('analysis'), 'analysi', 'the S stemmer only removes a plural s');
  for (const [w, want] of Object.entries({ caresses: 'caress', agreed: 'agree', hopping: 'hop', filing: 'file', happy: 'happi', sing: 'sing' })) {
    assert.equal(rel.porterStep1(w), want, w);
  }
});

test('query words weigh by how many search strings use them; a follow-up question counts half', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  const m = rel.queryModel({ question: 'Does remote work help?', queries: ['remote work productivity', 'telework productivity'] });
  near(m.terms.get('remote'), 2 / 3);
  near(m.terms.get('productivity'), 2 / 3);
  near(m.terms.get('telework'), 1 / 3);
  const f = rel.queryModel({ question: 'And in schools?', queries: ['remote learning schools', 'remote teaching'], followUp: true });
  near(f.terms.get('school'), 1.5 / 2.5);
  near(f.terms.get('remote'), 2 / 2.5);
});

test('text match: a paper covering the question beats one sharing a word, and no shared word scores 0', () => {
  const q = { question: 'Does remote work improve productivity?', queries: ['remote work productivity'] };
  const [full, one, none] = rel.scorePool([
    paper({ title: 'Remote work and productivity: a field experiment', abstract: 'Remote work raised the productivity of employees in a field experiment.' }),
    paper({ title: 'Agricultural productivity in river basins', abstract: 'Crop productivity rose with irrigation in three basins.' }),
    paper({ title: 'Coworking spaces and freelancer earnings', abstract: 'Freelancers in coworking spaces earned more.' }),
  ], q);
  assert.ok(full > one && one > none, `${full} > ${one} > ${none}`);
  assert.equal(none, 0);
  assert.ok(full < 1);
  assert.deepEqual(rel.scorePool([paper()], {}), [0], 'nothing to match against');
});

test('text match: a word in the title counts more than the same word in the abstract', () => {
  const abstract = 'We describe a cohort of adults followed for ten years with yearly visits and blood tests.';
  const [inTitle, inAbstract] = rel.scorePool([
    paper({ title: 'Sleep duration in a cohort of adults', abstract }),
    paper({ title: 'A cohort of adults followed for ten years', abstract: `${abstract} Sleep duration was recorded.` }),
  ], { question: 'sleep duration' });
  assert.ok(inTitle > inAbstract, `${inTitle} > ${inAbstract}`);
});

// ---- ranking (server/sources/index.js)

test('rank: an off-topic paper that one database put first falls below papers about the question', () => {
  const off = paper({ title: 'Coworking spaces and freelancer earnings in six cities', abstract: 'We study the earnings of freelancers who join coworking spaces in six cities. The paper does not examine employees.' });
  const a = paper({ title: 'Remote work and employee productivity: a randomised trial', abstract: 'Employees assigned to work from home were more productive; remote work raised output by 13 percent in this trial.' });
  const b = paper({ title: 'Telework intensity and productivity: a meta-analysis', abstract: 'Across 61 studies, remote work and telework intensity show a small positive association with productivity.' });
  const lists = [list('crossref', 0, [off, a, b]), list('crossref', 1, [off, b, a])];
  const plain = S.mergeAndRank(lists, { max: 10 });
  assert.equal(plain[0].title, off.title, 'without the question, the database order decides');
  const ranked = S.mergeAndRank(lists, { max: 10, question: 'Does remote work improve productivity?', queries: ['remote work productivity', 'telework productivity'] });
  assert.equal(ranked[2].title, off.title, 'with the question, the off-topic paper is last');
  assert.deepEqual(ranked.map((p) => p.n), [1, 2, 3]);
});

test('rank: ranking the same pool twice gives the same order and scores', () => {
  const lists = [list('openalex', 0, [paper(), paper(), paper({ abstract: '' })]), list('semanticscholar', 0, [paper(), paper()])];
  const all = S.merge(lists);
  const before = all.map((p) => p.score);
  const opts = { max: 10, question: 'sample record', queries: ['sample record'] };
  const one = S.rank(all, opts);
  const two = S.rank(all, opts);
  assert.deepEqual(two.map((p) => [p.doi, p.score]), one.map((p) => [p.doi, p.score]));
  assert.deepEqual(all.map((p) => p.score), before, 'the pool is not changed by ranking');
});

test('rank: correction notices, reviewers\' reports and retracted papers are never ranked', () => {
  const ok = paper({ title: 'Remote work and productivity in call centres' });
  const notice = paper({ title: 'Correction to: Remote work and productivity in call centres' });
  const retracted = paper({ title: 'Remote work and output', retracted: true });
  const ranked = S.mergeAndRank([list('crossref', 0, [notice, retracted, ok])], { max: 10 });
  assert.deepEqual(ranked.map((p) => p.title), [ok.title]);
});

// ---- the same work under two records

test('merge: a preprint and its published version are one paper, cited as published', () => {
  const pre = paper({
    source: 'openalex', doi: '10.21203/rs.3.rs-555/v1', title: 'Remote work and productivity: evidence from a natural experiment',
    authors: ['Noor Rahman', 'Peter Aldous'], year: 2019, venue: 'Research Square', types: ['posted-content'], pdfUrl: 'https://example.org/pre.pdf',
  });
  const pub = paper({
    source: 'crossref', doi: '10.5555/pub.555', title: 'Remote work and productivity: evidence from a large natural experiment',
    authors: ['Noor Rahman', 'Peter Aldous'], year: 2021, venue: 'Sample Journal of Economics', volume: '12', types: ['journal-article'],
  });
  const all = S.merge([list('openalex', 0, [pre]), list('crossref', 0, [pub])]);
  assert.equal(all.length, 1);
  const p = all[0];
  assert.equal(p.doi, '10.5555/pub.555');
  assert.equal(p.title, pub.title, 'the published title, as it will be cited');
  assert.equal(p.venue, 'Sample Journal of Economics');
  assert.equal(p.year, 2021);
  assert.equal(p.preprint, false);
  assert.notEqual(p.kind, 'Preprint');
  assert.equal(p.pdfUrl, 'https://example.org/pre.pdf', 'the open preprint copy is kept');
  assert.ok(p.altDois.includes('10.21203/rs.3.rs-555/v1'));
  assert.deepEqual(p.sources.sort(), ['crossref', 'openalex']);
  assert.ok(S.passes(p, { noPreprints: true }), 'a published paper passes "no preprints"');
});

test('merge: a Crossref preprint relation joins two records even when the titles differ', () => {
  const pre = paper({ doi: '10.31234/osf.io/abcde_v2', title: 'Working from home and wellbeing', types: ['posted-content'], preprintOf: ['10.5555/pub.777'] });
  const pub = paper({ doi: '10.5555/pub.777', title: 'Home-based telework, autonomy and employee wellbeing over two years', authors: ['Someone Else'] });
  const all = S.merge([list('crossref', 0, [pre, pub])]);
  assert.equal(all.length, 1);
  assert.equal(all[0].doi, '10.5555/pub.777');
});

test('merge: alike titles are not merged without the same author, and a protocol is not its results paper', () => {
  const a = paper({ title: 'Clinical practice guideline for the management of hypertension in adults', authors: ['Ann Weber'] });
  const b = paper({ title: 'Clinical practice guideline for the management of hypertension in adults', authors: ['Kenji Mori'] });
  assert.equal(S.merge([list('crossref', 0, [a, b])]).length, 2, 'same long title, different first authors');
  const protocol = paper({ doi: '10.21203/rs.3.rs-9/v1', title: 'Exercise for knee osteoarthritis in older adults: protocol for a randomised trial', types: ['posted-content'], authors: ['Lia Grant'] });
  const results = paper({ title: 'Exercise for knee osteoarthritis in older adults: a randomised trial', authors: ['Lia Grant'] });
  assert.equal(S.merge([list('crossref', 0, [protocol, results])]).length, 2);
});

test('merge: a short title merges only with the same first author and year', () => {
  const intro = (over) => paper({ doi: '', title: 'Introduction', ...over });
  assert.equal(S.merge([list('crossref', 0, [intro({ authors: ['Ann Weber'] }), intro({ authors: ['Kenji Mori'] })])]).length, 2);
  assert.equal(S.merge([list('crossref', 0, [intro({ authors: ['Ann Weber'] }), intro({ authors: ['Ann Weber'], year: 2015 })])]).length, 2);
  assert.equal(S.merge([list('crossref', 0, [intro({ authors: ['Ann Weber'] }), intro({ authors: ['A. Weber'] })])]).length, 1);
});

test('merge: titles in other scripts are compared as text, not all as one empty title', () => {
  const zh1 = paper({ doi: '', title: '远程办公对员工生产率的影响研究', authors: ['Wei Zhang'] });
  const zh2 = paper({ doi: '', title: '睡眠时间与青少年学业成绩的关系', authors: ['Wei Zhang'] });
  const all = S.merge([list('crossref', 0, [zh1, zh2])]);
  assert.equal(all.length, 2);
  assert.notEqual(S.paperId(all[0]), S.paperId(all[1]));
  // Latin titles keep the id they had before, so the Library still recognises saved papers.
  const latin = { doi: '', title: 'Sample record: remote work', year: 2020 };
  const old = `t:${crypto.createHash('sha1').update(`${normTitle(latin.title)}|2020`).digest('hex').slice(0, 16)}`;
  assert.equal(S.paperId(latin), old);
});

test('merge: preprint versions with their own DOIs are one work; other DOIs are left alone', () => {
  assert.equal(S.doiKey('10.21203/rs.3.rs-123/v2'), '10.21203/rs.3.rs-123');
  assert.equal(S.doiKey('10.26434/chemrxiv.8865143.v2'), '10.26434/chemrxiv.8865143');
  assert.equal(S.doiKey('10.31234/osf.io/243tg_v3'), '10.31234/osf.io/243tg');
  assert.equal(S.doiKey('10.5555/journal.abc.v2'), '10.5555/journal.abc.v2', 'not a preprint server');
  const v1 = paper({ doi: '10.21203/rs.3.rs-123/v1', title: 'First version title of this preprint here', types: ['posted-content'] });
  const v2 = paper({ doi: '10.21203/rs.3.rs-123/v2', title: 'Second version, with a new title entirely', types: ['posted-content'] });
  assert.equal(S.merge([list('crossref', 0, [v1, v2])]).length, 1);
});

test('merge: a shared PubMed id joins records that have no DOI', () => {
  const a = paper({ doi: '', pmid: '31234567', title: 'Vitamin D and falls in older adults' });
  const b = paper({ doi: '', pmid: '31234567', title: 'Vitamin D supplementation and falls in older adults: a trial', authors: ['Kenji Mori'] });
  assert.equal(S.merge([list('europepmc', 0, [a]), list('semanticscholar', 0, [b])]).length, 1);
});

test('merge: a preprint copy does not relabel a published paper, and "no preprints" drops a preprint meta-analysis', () => {
  const pub = paper({ doi: '10.5555/pub.900', title: 'Sleep and memory consolidation in adolescents: a cohort', types: ['journal-article'] });
  const sameAsPreprint = { ...pub, kind: 'Preprint', preprint: false, sources: ['openalex'] };
  const merged = S.merge([list('crossref', 0, [pub]), list('openalex', 0, [sameAsPreprint])]);
  assert.equal(merged[0].kind, 'Cohort study');
  const preMeta = paper({ doi: '10.48550/arxiv.2101.00001', title: 'A meta-analysis of sleep and memory', types: ['posted-content'] });
  const [p] = S.merge([list('openalex', 0, [preMeta])]);
  assert.equal(p.kind, 'Meta-analysis');
  assert.equal(p.preprint, true);
  assert.equal(S.passes(p, { noPreprints: true }), false);
});

// ---- pacing the databases

test('limiter: requests to one database start a gap apart; a lone request does not wait', async () => {
  const c = fakeClock();
  const L = S.makeLimiter(c);
  const starts = [];
  const job = (i) => L.run('s2', { gap: 1000 }, async () => { starts.push([i, c.now()]); return i; });
  const ps = [job(0), job(1), job(2)];
  assert.deepEqual(starts, [[0, 0]], 'the first request starts at once');
  await c.advance(999);
  assert.equal(starts.length, 1);
  await c.advance(1);
  await c.advance(1000);
  assert.deepEqual(starts, [[0, 0], [1, 1000], [2, 2000]]);
  assert.deepEqual(await Promise.all(ps), [0, 1, 2]);
  assert.equal(c.pending(), 0, 'no timer left behind');
  await c.advance(5000);
  await L.run('s2', { gap: 1000 }, async () => starts.push([3, c.now()]));
  assert.deepEqual(starts[3], [3, 7000], 'after a quiet spell the next request goes at once');
});

test('limiter: one at a time means the next request waits for the previous one to finish', async () => {
  const c = fakeClock();
  const L = S.makeLimiter(c);
  let release;
  const first = L.run('crossref', { concurrency: 1 }, () => new Promise((r) => { release = r; }));
  let second = false;
  const p2 = L.run('crossref', { concurrency: 1 }, async () => { second = true; });
  await flush();
  assert.equal(second, false);
  assert.deepEqual(L.state('crossref'), { waiting: 1, running: 1, timer: false });
  release('done');
  assert.equal(await first, 'done');
  await p2;
  assert.equal(second, true);
});

test('limiter: a cancelled question leaves the queue at once and no timer is left', async () => {
  const c = fakeClock();
  const L = S.makeLimiter(c);
  const ac = new AbortController();
  await L.run('s2', { gap: 1000 }, async () => 1);
  let ran = false;
  const waiting = L.run('s2', { gap: 1000, signal: ac.signal }, async () => { ran = true; });
  assert.deepEqual(L.state('s2'), { waiting: 1, running: 0, timer: true });
  ac.abort();
  await assert.rejects(waiting, (e) => e.name === 'AbortError');
  assert.deepEqual(L.state('s2'), { waiting: 0, running: 0, timer: false });
  assert.equal(c.pending(), 0);
  await c.advance(2000);
  assert.equal(ran, false);
  await assert.rejects(L.run('s2', { signal: ac.signal }, async () => 1), (e) => e.name === 'AbortError', 'an already cancelled question does not queue');
});

test('limiter: a failed request releases its slot', async () => {
  const L = S.makeLimiter(fakeClock());
  const bad = L.run('x', { concurrency: 1 }, async () => { throw new Error('boom'); });
  const good = L.run('x', { concurrency: 1 }, async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.deepEqual(L.state('x'), { waiting: 0, running: 0, timer: false });
});

test('fan-out: each database is asked within its limits, keyed and keyless', async () => {
  const seen = [];
  const pace = { run: (name, opts, fn) => { seen.push({ name, concurrency: opts.concurrency, gap: opts.gap }); return fn(); } };
  const sources = { openalex: true, semanticscholar: true, crossref: true, europepmc: true };
  mock.reset();
  await S.searchAll({ queries: ['q one', 'q two', 'q three'], settings: { sources, keys: { openalex: 'k', semanticscholar: 'k' } }, pace });
  const by = (n) => seen.filter((s) => s.name === n);
  assert.equal(by('openalex').length, 3, 'keyed OpenAlex takes every query');
  assert.ok(by('semanticscholar').every((s) => s.concurrency === 1 && s.gap >= 1000), 'Semantic Scholar: one a second');
  assert.ok(by('crossref').every((s) => s.concurrency === 1 && s.gap >= 1000), 'Crossref public pool: one a second, one at a time');
  assert.equal(by('crossref').length, S.CROSSREF_QUERIES, 'Crossref: only the first planned queries (its later ones added nothing on dev)');
  assert.ok(by('europepmc').every((s) => s.concurrency <= 2));

  seen.length = 0;
  mock.reset();
  await S.searchAll({ queries: ['q one', 'q two', 'q three'], settings: { sources, keys: {} }, pace });
  assert.equal(mock.calls.filter((c) => c.host === 'api.openalex.org').length, S.KEYLESS_OPENALEX_QUERIES, 'keyless OpenAlex: its small allowance');
  assert.equal(by('semanticscholar').length, 3);
  seen.length = 0;
  await S.searchAll({ queries: ['q one'], settings: { sources: { crossref: true }, keys: {}, email: 'x@example.org' }, pace });
  assert.deepEqual(by('crossref'), [{ name: 'crossref', concurrency: 3, gap: 350 }], 'polite pool with an email');
  mock.reset();
});

test('fan-out: a design filter adds one search with the design as a hint, or as plain words', async () => {
  assert.deepEqual(S.boostPhrases({ designs: ['Randomised trial', 'Cohort study', 'Case report'] }), ['randomized controlled trial', 'cohort study']);
  assert.deepEqual(S.boostPhrases({ reviewsOnly: true }), ['meta-analysis', 'systematic review']);
  assert.deepEqual(S.boostPhrases({}), []);
  const settings = { sources: { crossref: true }, keys: {} };
  const crossref = S.SOURCES.crossref;
  const real = crossref.search;
  const asked = [];
  crossref.search = async (q, opts) => { asked.push([q, opts.boost || null]); return []; };
  try {
    const noPace = { run: (n, o, fn) => fn() };
    await S.searchAll({ queries: ['sleep memory', 'sleep learning'], filters: { designs: ['Randomised trial'] }, settings, pace: noPace });
    assert.deepEqual(asked, [['sleep memory', null], ['sleep learning', null], ['sleep memory', ['randomized controlled trial']]]);
    asked.length = 0;
    const flag = crossref.boosts;
    crossref.boosts = false;
    try {
      await S.searchAll({ queries: ['sleep memory'], filters: { reviewsOnly: true }, settings, pace: noPace });
    } finally { crossref.boosts = flag; }
    assert.deepEqual(asked[1], ['sleep memory meta-analysis systematic review', null], 'a database without the hint gets plain words');
  } finally { crossref.search = real; }
});

test('fan-out: OpenAlex semantic search runs once per topic search, keyed only, at most one a second', async () => {
  const seen = [];
  const pace = { run: (lane, opts, fn) => { seen.push({ lane, concurrency: opts.concurrency, gap: opts.gap }); return fn(); } };
  const settings = { sources: { openalex: true }, keys: { openalex: 'k' } };
  mock.reset();
  const lists = await S.searchAll({ queries: ['sleep memory', 'sleep learning'], settings, pace, semantic: true });
  const sem = mock.calls.filter((c) => c.params['search.semantic']);
  assert.equal(sem.length, 1);
  assert.equal(sem[0].params['search.semantic'], 'sleep memory', 'the first query');
  assert.deepEqual(seen.filter((s) => s.lane === 'openalex:semantic'), [{ lane: 'openalex:semantic', concurrency: 1, gap: 1050 }]);
  assert.equal(lists.filter((l) => l.semantic).length, 1);
  mock.reset();
  await S.searchAll({ queries: ['sleep memory'], settings, pace });
  assert.equal(mock.calls.filter((c) => c.params['search.semantic']).length, 0, 'not asked for (a citation lookup)');
  await S.searchAll({ queries: ['sleep memory'], settings: { sources: { openalex: true }, keys: {} }, pace, semantic: true });
  assert.equal(mock.calls.filter((c) => c.params['search.semantic']).length, 0, 'not without a key (small allowance)');
  // Its list weighs like the first query in the fusion.
  const p = paper();
  const a = S.merge([{ source: 'openalex', qi: 3, papers: [p], semantic: true }]);
  const b = S.merge([{ source: 'openalex', qi: 0, papers: [p] }]);
  assert.equal(a[0].score, b[0].score);
  mock.reset();
});

test('fan-out: the lists come back in a fixed order, whichever database answers first', async () => {
  mock.reset();
  const slowFirst = { run: async (name, o, fn) => { if (name === 'openalex') await new Promise((r) => setTimeout(r, 5)); return fn(); } };
  const lists = await S.searchAll({ queries: ['a', 'b'], settings: { sources: { openalex: true, semanticscholar: true, crossref: true }, keys: { openalex: 'k', semanticscholar: 'k' } }, pace: slowFirst });
  assert.deepEqual(lists.map((l) => `${l.source}:${l.qi}`), ['openalex:0', 'openalex:1', 'semanticscholar:0', 'semanticscholar:1', 'crossref:0', 'crossref:1']);
  mock.reset();
});
