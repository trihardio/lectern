'use strict';
// Filters and the four research tools: literature review, citation trail, backing up a
// statement, and checking citations. Offline, like every other test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-fetch');
const fx = require('./fixtures');
const { createApp } = require('../server');
const { cleanFilters, countActive, describe, FIELDS, DESIGNS } = require('../server/filters');
const { sampleSize, titleSim, detectKind } = require('../server/sources/common');
const { passes, gather } = require('../server/sources');
const trail = require('../server/sources/trail');
const prompts = require('../server/prompts');
const { DEFAULTS } = require('../server/config');

const CLAUDE = path.join(__dirname, 'fakes', 'claude');
const settings = () => ({ ...JSON.parse(JSON.stringify(DEFAULTS)), keys: { openalex: 'oa', semanticscholar: '' } });

test('filters: whatever the window sends is made safe', () => {
  const f = cleanFilters({
    yearFrom: '2015', yearTo: 99999, oaOnly: 1, noPreprints: 'yes', minCitations: '-4', journalMin: 3,
    designs: ['Meta-analysis', 'Made-up design', 'Meta-analysis'], minSample: '250.7',
    fields: ['14', '999', 14], venues: ' Nature , x, The Lancet\n<script>',
  });
  assert.deepEqual(f, {
    yearFrom: 2015, yearTo: null, oaOnly: true, noPreprints: true, minCitations: 0, journalMin: 0,
    designs: ['Meta-analysis'], reviewsOnly: true, minSample: 251, fields: ['14'], venues: ['nature', 'the lancet', '<script>'],
  });
  assert.equal(countActive(f), 7);
  assert.match(describe(f), /published 2015 to now; open access only; no preprints; study design: Meta-analysis; stated sample of 251 or more; fields: Business, Management and Accounting/);

  const empty = cleanFilters(null);
  assert.equal(countActive(empty), 0);
  assert.equal(describe(empty), '');
  // The older "reviews only" switch still works, and a design that is not a review switches it off.
  assert.deepEqual(cleanFilters({ reviewsOnly: true }).designs, ['Meta-analysis', 'Systematic review', 'Review']);
  assert.equal(cleanFilters({ designs: ['Review', 'Cohort study'] }).reviewsOnly, false);
  assert.equal(cleanFilters({ journalMin: '5' }).journalMin, 5);
  assert.equal(FIELDS.length, 26);
  assert.ok(DESIGNS.includes('Randomised trial'));
});

test('sample size is read from the abstract; years, counts of studies and money are not samples', () => {
  const cases = [
    ['We synthesise 61 field studies (N = 48,210 employees) on telework', 48210],
    ['A survey of 5,748 knowledge workers in 29 countries shows', 5748],
    ['In 2020 firms moved to remote work across 12 countries', null],
    ['a panel of 3,100 firms show no change', 3100],
    ['Across 37 studies, remote work is associated', null],
    ['In 84 distributed teams, outcome-based monitoring', 84],
    ['a 16,000-person services firm completed 13% more calls', null],
    ['n=412 nurses completed the survey; 95% CI 1.2-3.4', 412],
    ['We recruited 120 healthy young adults and 3 controls', 120],
    ['costs fell by $1,200 people said', null],
    ['', null], [null, null],
  ];
  for (const [text, want] of cases) assert.equal(sampleSize(text), want, String(text));
  assert.equal(titleSim('Does Working from Home Work? Evidence from a Chinese Experiment *', 'does working from home work: evidence from a chinese experiment'), 1);
  assert.ok(titleSim('Remote work and productivity', 'Coworking spaces and freelancer earnings') < 0.3);
  assert.equal(detectKind('Sleep and mortality: a prospective cohort study', []), 'Cohort study');
  assert.equal(detectKind('Burnout in nurses, a cross-sectional survey', []), 'Cross-sectional study');
  assert.equal(detectKind('A qualitative study of teachers', []), 'Qualitative study');
  assert.equal(detectKind('A meta-analysis of cohort studies', []), 'Meta-analysis', 'the stronger label wins');
});

test('each filter keeps and drops the right papers; a missing fact is not a pass', () => {
  const p = {
    title: 'A paper', year: 2020, kind: 'Randomised trial', citations: 40, isOA: true, sample: 300,
    venue: 'Journal of Sleep Research', publisher: 'Wiley', fieldIds: ['27'], journalScore: 4.1,
  };
  const ok = (f) => passes(p, cleanFilters(f));
  assert.ok(ok({}));
  assert.ok(ok({ designs: ['Randomised trial', 'Cohort study'], minSample: 300, venues: 'sleep', fields: ['27', '32'], journalMin: 2 }));
  assert.ok(ok({ venues: 'wiley' }), 'publisher names count');
  assert.ok(!ok({ designs: ['Cohort study'] }));
  assert.ok(!ok({ minSample: 301 }));
  assert.ok(!ok({ venues: 'nature' }));
  assert.ok(!ok({ fields: ['32'] }));
  assert.ok(!ok({ journalMin: 5 }));
  assert.ok(!passes({ ...p, kind: 'Preprint' }, cleanFilters({ noPreprints: true })));
  // Unknown sample, field or journal impact: left out when that filter is on.
  const bare = { ...p, sample: null, fieldIds: [], journalScore: undefined };
  assert.ok(passes(bare, cleanFilters({})));
  assert.ok(!passes(bare, cleanFilters({ minSample: 10 })));
  assert.ok(!passes(bare, cleanFilters({ fields: ['27'] })));
  assert.ok(!passes(bare, cleanFilters({ journalMin: 1 })));
  assert.ok(!passes({ ...p, year: null }, cleanFilters({ yearFrom: 2019 })), 'a missing date cannot pass a date filter');
  assert.ok(!passes({ ...p, year: null }, cleanFilters({ yearTo: 2025 })));
});

test('citation verification: a DOI resolves across databases and cannot drift to a different paper', async () => {
  mock.reset();
  const s = settings();
  const p = require('../server/sources/openalex').parseWork(fx.openalexWork(fx.BASE[1]));
  mock.state.fail['api.openalex.org'] = 429;
  const exact = await trail.resolve({ doi: p.doi }, { settings: s, search: async () => [p] });
  assert.equal(exact.how, 'doi');
  assert.equal(exact.paper.doi, p.doi);
  const wrong = await trail.resolve({ doi: '10.5555/does-not-exist', title: p.title, authors: [p.authors[0].family], year: p.year }, { settings: s, search: async () => [p] });
  assert.deepEqual(wrong, { paper: null, how: 'none' });
  const nearbyYear = await trail.resolve({ authors: [p.authors[0].family], year: p.year + 1 }, { settings: s, search: async () => [p] });
  assert.equal(nearbyYear.how, 'none');
  mock.reset();
});

test('field and journal filters ask OpenAlex for what the other databases lack', async () => {
  mock.reset();
  const s = settings();
  // Record 7 comes only from Semantic Scholar (no DOI there) and Crossref: its field is learned by DOI.
  let out = await gather({ queries: ['remote work'], filters: cleanFilters({ fields: ['32'] }), settings: s, max: 20 });
  assert.deepEqual(out.notices, []);
  assert.ok(out.papers.length > 0);
  assert.ok(out.papers.every((p) => p.fieldIds.includes('32')));
  assert.ok(out.papers.some((p) => /managerial monitoring/.test(p.title)), 'a paper OpenAlex did not return in the search still got its field');
  const search = mock.calls.find((c) => c.host === 'api.openalex.org' && c.params.search);
  assert.match(search.params.filter, /topics\.field\.id:32/);
  assert.ok(mock.calls.some((c) => c.host === 'api.openalex.org' && /^doi:/.test(c.params.filter || '')));

  mock.reset();
  out = await gather({ queries: ['remote work'], filters: cleanFilters({ journalMin: 5 }), settings: s, max: 20 });
  assert.ok(mock.calls.some((c) => c.path === '/sources' && /ids\.openalex:S800/.test(c.params.filter)));
  assert.deepEqual(out.papers.map((p) => p.journalId).sort(), ['S8001', 'S8002'], 'only the two journals at 5 or above');
  assert.ok(out.papers.every((p) => p.journalScore >= 5));

  // OpenAlex down: the two filters are skipped, with a notice, instead of returning nothing.
  mock.reset();
  mock.state.fail['api.openalex.org'] = 429;
  out = await gather({ queries: ['remote work'], filters: cleanFilters({ journalMin: 5, fields: ['32'], yearFrom: 2019 }), settings: s, max: 20 });
  assert.equal(out.notices.length, 1);
  assert.match(out.notices[0], /field of study and journal impact filter was skipped/);
  assert.ok(out.papers.length > 0);
  assert.ok(out.papers.every((p) => p.year >= 2019), 'the other filters still apply');
  mock.reset();
});

test('citation trail: seeds are found by DOI or title, and links are tagged from the database', async () => {
  mock.reset();
  const s = settings();
  const two = fx.BASE[1];
  const { seeds, missing } = await trail.findSeeds(`https://doi.org/${fx.doi(two)}.\n${fx.BASE[0].title}\nA paper that does not exist anywhere at all`, { settings: s });
  assert.deepEqual(seeds.map((p) => p.oaId), ['W900002', 'W900001']);
  assert.deepEqual(missing, ['A paper that does not exist anywhere at all']);
  assert.equal(trail.doiIn('see doi:10.5555/abc.DEF-1).'), '10.5555/abc.def-1');

  const lists = await trail.trace([seeds[0]], { filters: cleanFilters({ yearFrom: 2018 }), settings: s });
  const rels = lists.map((l) => l.papers[0].rel[0]);
  assert.deepEqual(rels.sort(), ['cit:1', 'cit:1', 'ref:1']);
  const calls = mock.calls.filter((c) => /cites:|cited_by:/.test(c.params.filter || ''));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => /from_publication_date:2018-01-01/.test(c.params.filter)), 'filters reach the citation search');
  assert.ok(calls.some((c) => c.params.sort === 'publication_date:desc'));
  assert.equal(prompts.linkLine({ rel: ['seed', 'ref:2'] }), 'Link: starting paper; cited by starting paper 2');
  mock.reset();
});

// ---- through the API, with the fake Claude CLI
async function start(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-tools-'));
  const app = createApp({ dataDir, ...opts });
  const base = await app.listen(0);
  const headers = { 'x-lectern-token': app.token, 'content-type': 'application/json' };
  const call = async (method, p, body) => {
    const res = await mock.realFetch(base + p.replace(/^\//, ''), { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ask = async (body) => {
    const text = await (await mock.realFetch(`${base}api/ask`, { method: 'POST', headers, body: JSON.stringify(body) })).text();
    const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
      const [e, d] = b.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
    const get = (n) => (events.find((e) => e.event === n) || {}).data;
    return { events, get, answer: events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('') };
  };
  await call('PUT', '/api/settings', { keys: { openalex: 'oa' }, bins: { claude: CLAUDE, codex: '/nonexistent/bin' }, insights: true });
  const file = path.join(dataDir, 'runs.jsonl');
  process.env.FAKE_LOG = file;
  const runs = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const sys = (r) => r.args[r.args.indexOf('--system-prompt') + 1];
  return { app, call, ask, runs, sys, stop: async () => { delete process.env.FAKE_LOG; await app.close(); mock.reset(); } };
}
const turnOf = async (s, done) => (await s.call('GET', `/api/thread?id=${done.threadId}`)).json.turns[0];

test('the window is told which tools and filters exist', async () => {
  let asked = 0;
  const s = await start({ onDictate: () => { asked++; } });
  try {
    const st = (await s.call('GET', '/api/state')).json;
    assert.deepEqual(st.modes.map((m) => m.id), ['answer', 'review', 'trail', 'claim', 'verify']);
    assert.ok(st.modes.every((m) => m.label && m.blurb && m.placeholder));
    assert.equal(st.filterOptions.fields.length, 26);
    assert.equal(st.filterOptions.journalTiers[0].min, 0);
    assert.equal(st.dictation, true);
    assert.deepEqual((await s.call('POST', '/api/dictate', {})).json, { ok: true });
    assert.equal(asked, 1);
  } finally { await s.stop(); }
  const plain = await start();
  try {
    assert.equal((await plain.call('GET', '/api/state')).json.dictation, false);
    assert.equal((await plain.call('POST', '/api/dictate', {})).json.ok, false);
  } finally { await plain.stop(); }
});

test('literature review: wider plan, more papers, and the real search record in the prompt', async () => {
  mock.reset();
  const s = await start();
  try {
    const r = await s.ask({ question: 'Remote work and productivity', mode: 'review', filters: { yearFrom: 2015 } });
    assert.equal(r.get('error'), undefined);
    assert.equal(r.get('meta').mode, 'review');
    const runs = s.runs();
    assert.match(s.sys(runs[0]), /plan the search for a literature review/);
    const main = runs.find((x) => /write a short literature review/.test(s.sys(x)));
    assert.match(main.input, /Topic to review: Remote work and productivity/);
    assert.match(main.input, /Search record \(facts about this search/);
    assert.match(main.input, /Queries run: "remote work employee productivity"/);
    assert.match(main.input, /Databases: .*OpenAlex: \d+ results/);
    assert.match(main.input, new RegExp(`Papers ranked highest and read \\(abstracts only\\): ${r.get('papers').papers.length}`));
    assert.match(main.input, /Filters: published 2015 to now/);
    const turn = await turnOf(s, r.get('done'));
    assert.equal(turn.mode, 'review');
    assert.equal(turn.filters.yearFrom, 2015);
    assert.ok(turn.insights.length > 0, 'the reading pass still runs');
  } finally { await s.stop(); }
});

test('back up a statement: every paper is judged for or against it', async () => {
  mock.reset();
  const s = await start();
  try {
    const r = await s.ask({ question: 'Remote work makes employees more productive.', mode: 'claim' });
    assert.equal(r.get('error'), undefined);
    assert.equal(r.get('plan').yesNo, true);
    const runs = s.runs();
    assert.match(s.sys(runs[0]), /wants to cite evidence for a statement/);
    assert.match(runs.find((x) => /judge each/.test(s.sys(x))).input, /this IS a yes\/no question\): Is this statement supported by the evidence\? "Remote work makes employees more productive\."/);
    const main = runs.find((x) => /has a statement they want to back with citations/.test(s.sys(x)));
    assert.match(main.input, /^Statement to check: Remote work makes employees more productive\./);
    const turn = await turnOf(s, r.get('done'));
    assert.equal(turn.yesNo, true);
    assert.ok(turn.insights.some((i) => i.stance === 'supports') && turn.insights.some((i) => i.stance === 'against'));
  } finally { await s.stop(); }
});

test('citation trail: starting paper first, linked papers after it, links stated to the model', async () => {
  mock.reset();
  const s = await start();
  try {
    const r = await s.ask({ question: `${fx.doi(fx.BASE[1])}\nno such paper title anywhere`, mode: 'trail' });
    assert.equal(r.get('error'), undefined);
    const papers = r.get('papers').papers;
    assert.deepEqual(papers[0].rel, ['seed']);
    assert.equal(papers[0].doi, fx.doi(fx.BASE[1]));
    assert.deepEqual(papers.map((p) => p.n), papers.map((_, i) => i + 1));
    assert.deepEqual(papers.slice(1).map((p) => p.rel.join()).sort(), ['cit:1', 'cit:1', 'cit:1', 'ref:1', 'ref:1', 'ref:1']);
    assert.ok(papers.every((p) => p.id), 'every paper can be saved and cited');
    assert.match(r.events.find((e) => e.event === 'notice').data.text, /Not found, so left out: "no such paper title anywhere"/);
    assert.deepEqual(r.events.filter((e) => e.event === 'source').map((e) => e.data.label), ['OpenAlex']);
    const main = s.runs().find((x) => /gave one to three starting papers/.test(s.sys(x)));
    assert.match(main.input, /^Starting papers: \[1\]/);
    assert.match(main.input, /Link: starting paper\n/);
    assert.match(main.input, /Link: cites starting paper 1/);
    assert.match(main.input, /Link: cited by starting paper 1/);

    // A paper that cannot be found is an error the reader can act on, and nothing is saved.
    const before = (await s.call('GET', '/api/threads')).json.threads.length;
    const bad = await s.ask({ question: 'a title that matches nothing in the sample data', mode: 'trail' });
    assert.match(bad.get('error').message, /could not find that paper in OpenAlex/);
    assert.equal((await s.call('GET', '/api/threads')).json.threads.length, before);
  } finally { await s.stop(); }
});

test('check citations: each citation is matched to a record, or reported as not found', async () => {
  mock.reset();
  const s = await start();
  try {
    const text = 'Employees working from home completed 13% more calls (Rahman & Aldous, 2019). '.repeat(40);
    assert.ok(text.length > 2000, 'this tool accepts long pasted text');
    const r = await s.ask({ question: text, mode: 'verify' });
    assert.equal(r.get('error'), undefined);
    const runs = s.runs();
    const extract = runs[0];
    assert.match(s.sys(extract), /claim-citation pairs/);
    assert.equal(extract.input.length, text.trim().length, 'the whole text reaches the extractor');
    assert.equal(r.get('plan').queries.length, 4, 'the item with no claim is dropped');

    const papers = r.get('papers').papers;
    assert.deepEqual(papers.map((p) => p.n), [1, 2, 3]);
    assert.deepEqual(papers.map((p) => p.doi), [fx.doi(fx.BASE[1]), fx.doi(fx.BASE[0]), fx.doi(fx.BASE[4])]);
    const main = runs.find((x) => /audit whether the papers a student cites/.test(s.sys(x)));
    assert.match(main.input, /Claim 1: Employees working from home completed 13% more calls\.\nCitation as written: \(Rahman & Aldous, 2019\)\nMatched paper: \[1\], matched by author and year only/);
    assert.match(main.input, /Claim 2: [^\n]+\n[^\n]+\nMatched paper: \[2\], matched by title\n/);
    assert.match(main.input, /Claim 3: [^\n]+\n[^\n]+\nMatched paper: \[3\], matched by DOI\n/);
    assert.match(main.input, /Claim 4: Remote work doubles innovation\.\nCitation as written: \(Nobody, 1999\)\nMatched paper: none/);
    assert.match(r.events.find((e) => e.event === 'notice').data.text, /1 of 4 citations could not be matched to a database record: \(Nobody, 1999\)/);
    assert.ok(!runs.some((x) => /judge each/.test(s.sys(x))), 'no per-paper reading pass for this tool');
    const sources = r.events.filter((e) => e.event === 'source').map((e) => e.data.name).sort();
    assert.deepEqual(sources, ['crossref', 'openalex', 'semanticscholar'], 'each database is reported once');

    // Text with no citations: a plain message, and the answer model is not called.
    process.env.FAKE_NO_CITATIONS = '1';
    const before = s.runs().length;
    const none = await s.ask({ question: 'Just an opinion with no sources.', mode: 'verify' });
    delete process.env.FAKE_NO_CITATIONS;
    assert.match(none.answer, /found no citations in that text/);
    assert.equal(s.runs().length, before + 1, 'only the extractor ran');
  } finally { delete process.env.FAKE_NO_CITATIONS; await s.stop(); }
});

test('citation snowballing: journal metadata is fetched before filtering linked papers', async () => {
  mock.reset();
  const s = await start();
  try {
    const r = await s.ask({ question: fx.doi(fx.BASE[1]), mode: 'trail', filters: { journalMin: 5 } });
    assert.equal(r.get('error'), undefined);
    const papers = r.get('papers').papers;
    assert.ok(papers.length > 1, 'the impact filter must not silently remove every linked paper');
    assert.ok(papers.slice(1).every((p) => p.journalScore >= 5));
    assert.match(r.events.find((e) => e.event === 'notice').data.text, /Starting papers are kept for context/);
    assert.ok(mock.calls.some((c) => c.path === '/sources'));
  } finally { await s.stop(); }
});

test('an unknown tool name falls back to a normal answer, and normal answers cap the question length', async () => {
  mock.reset();
  const s = await start();
  try {
    const r = await s.ask({ question: `Does remote work help? ${'x'.repeat(3000)}`, mode: 'nonsense' });
    assert.equal(r.get('meta').mode, 'answer');
    assert.equal((await turnOf(s, r.get('done'))).question.length, 2000);
  } finally { await s.stop(); }
});
