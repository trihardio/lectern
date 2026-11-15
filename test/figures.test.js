'use strict';
// Figures from open-access papers: finding them, reading their captions, choosing them, and
// keeping every image, caption, licence and link tied to the article record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-fetch');
const fx = require('./fixtures');
const figures = require('../server/sources/figures');
const { createApp } = require('../server');

const paper = (n) => ({ n, doi: fx.doi(fx.BASE[n - 1]), title: fx.BASE[n - 1].title });

test('captions are read from the full text, with entities decoded and the image file matched', () => {
  const figs = figures.parseFigures(fx.FIGURE_XML['PMC9001.2/PMC9001.2.xml']);
  assert.equal(figs.length, 4);
  assert.deepEqual(figs.map((f) => f.label), ['Figure 1', 'Figure 2', 'Figure 3', 'Figure 4']);
  assert.equal(figs[1].title, 'Pooled effect of telework intensity on task performance.');
  assert.match(figs[1].caption, /each study’s estimate/, 'numeric entities are decoded');
  assert.equal(figs[2].title, 'Effect size by share of remote days & task coordination.', 'a caption without a title gives its first sentence');
  const keys = fx.BUCKET_FILES.PMC9001.filter((k) => k.startsWith('PMC9001.2/'));
  assert.equal(figures.imageKey(keys, 'fig1'), 'PMC9001.2/fig1.jpg', 'href without an extension');
  assert.equal(figures.imageKey(keys, 'fig2.png'), 'PMC9001.2/fig2.png');
  assert.equal(figures.imageKey(keys, 'fig4'), null, 'no image file, no figure');
  assert.deepEqual(figures.parseFigures('<fig id="x"><caption><p>no graphic</p></caption></fig>'), []);
});

test('newer articles: <fig-count> in the front matter is not a figure, and .webp images are used', () => {
  const xml = `<article><front><counts><fig-count count="1"/><table-count count="1"/></counts></front><body>
    <fig position="float" id="F1" fig-type="figure"><label>Figure 1.</label><caption><title>Scores by group.</title></caption>
    <graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="art-g001.webp"/></fig></body></article>`;
  const figs = figures.parseFigures(xml);
  assert.equal(figs.length, 1);
  assert.equal(figs[0].id, 'F1', 'the match starts at the real <fig>, not at <fig-count>');
  assert.equal(figs[0].label, 'Figure 1.');
  const keys = ['PMC1.1/PMC1.1.xml', 'PMC1.1/art-g001.webp', 'PMC1.1/art-s001.docx'];
  assert.equal(figures.imageKey(keys, 'art-g001.webp'), 'PMC1.1/art-g001.webp');
  assert.equal(figures.imageKey(keys, 'art-g001'), 'PMC1.1/art-g001.webp', 'href without an extension');
});

test('candidates: only open-access papers, newest version, no selection flow charts, ids in order', async () => {
  mock.reset();
  const c = await figures.candidates([paper(1), paper(2), paper(3), paper(4), { n: 9, title: 'no doi' }]);
  // Record 2 is not open access; record 4 is but has no files; Figure 1 of record 1 is a PRISMA chart.
  assert.deepEqual(c.map((f) => [f.id, f.n, f.label]), [['F1', 1, 'Figure 2'], ['F2', 3, 'Fig. 1'], ['F3', 1, 'Figure 3']]);
  assert.ok(c.every((f) => f.img.startsWith(`${figures.BUCKET}/`)));
  assert.equal(c[0].img, `${figures.BUCKET}/PMC9001.2/fig2.png`, 'the newest article version is used');
  assert.equal(c[0].license, 'CC BY');
  assert.equal(c[1].license, 'CC BY-NC-ND');
  assert.equal(c[0].page, 'https://europepmc.org/article/PMC/9001');
  const lookup = mock.calls.filter((c2) => c2.host === 'www.ebi.ac.uk');
  assert.equal(lookup.length, 1, 'one open-access lookup for all the DOIs');
  assert.match(lookup[0].params.query, /^DOI:"10\.5555\/lectern\.sample\.1" OR DOI:"10\.5555\/lectern\.sample\.2"/);

  // Nothing reachable: no figures, no error.
  mock.reset();
  mock.state.fail['www.ebi.ac.uk'] = 503;
  assert.deepEqual(await figures.candidates([paper(1)]), []);
  mock.reset();
});

test('a reading guide may not add numbers the caption does not state', () => {
  const fig = { label: 'Figure 2', title: 'Pooled effect', caption: 'Forest plot of 61 field studies, 95% interval, r = .09, N = 48,210.' };
  assert.equal(figures.groundedRead('Each square is a study; the 95% line is its interval.', fig), 'Each square is a study; the 95% line is its interval.');
  assert.equal(figures.groundedRead('All 61 studies, 48210 employees in total.', fig), 'All 61 studies, 48210 employees in total.', 'thousands separators do not matter');
  assert.equal(figures.groundedRead('The effect doubles after 3 days.', fig), '');
  const long = `${'Each square is one study and its line is the interval. '.repeat(6)}Compare the squares to see whether`;
  const cut = figures.groundedRead(long, fig);
  assert.ok(cut.length <= 320 && cut.endsWith('interval.'), 'an overlong guide ends on its last whole sentence');
  assert.equal(figures.groundedRead('', fig), '');
});

test('an answer carries at most two chosen figures, saved with the turn', async () => {
  mock.reset();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-figures-'));
  const app = createApp({ dataDir });
  const base = await app.listen(0);
  const headers = { 'x-lectern-token': app.token, 'content-type': 'application/json' };
  const call = (method, p, body) => mock.realFetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const ask = async (body) => (await (await mock.realFetch(`${base}api/ask`, { method: 'POST', headers, body: JSON.stringify(body) })).text())
    .split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { event: e.slice(7), data: JSON.parse(d.slice(6)) }; });
  try {
    await call('PUT', 'api/settings', { keys: { openalex: 'oa' }, bins: { claude: path.join(__dirname, 'fakes', 'claude'), codex: '/nonexistent/bin' } });
    let events = await ask({ question: 'Does remote work improve employee productivity?' });
    const got = events.find((e) => e.event === 'figures');
    assert.ok(got, 'a figures event is sent');
    const figs = got.data.figures;
    assert.equal(figs.length, 2, 'unknown ids and repeats are dropped');
    assert.deepEqual(figs.map((f) => f.id), ['F1', 'F2']);
    const papers = events.find((e) => e.event === 'papers').data.papers;
    for (const f of figs) {
      assert.ok(papers.some((p) => p.n === f.n), 'every figure belongs to a paper in the answer');
      assert.ok(f.img.startsWith(`${figures.BUCKET}/`) && f.page.startsWith('https://europepmc.org/article/PMC/'));
    }
    assert.match(figs[0].read, /diamond at the bottom is the pooled effect/);
    assert.equal(figs[1].read, '', 'a guide that invents a number (40 percent) is dropped');
    const done = events.find((e) => e.event === 'done').data;
    const thread = await call('GET', `api/thread?id=${done.threadId}`);
    assert.deepEqual(thread.turns[0].figures.map((f) => f.id), ['F1', 'F2']);

    // Turned off in Settings, or a tool where results figures do not apply: no lookup at all.
    await call('PUT', 'api/settings', { figures: false });
    mock.reset();
    events = await ask({ question: 'Does remote work improve employee productivity?' });
    assert.ok(!events.some((e) => e.event === 'figures'));
    assert.ok(!mock.calls.some((c) => c.host === 'pmc-oa-opendata.s3.amazonaws.com'));
    await call('PUT', 'api/settings', { figures: true });
    mock.reset();
    events = await ask({ question: 'Remote work raised output (Rahman & Aldous, 2019).', mode: 'verify' });
    assert.ok(!events.some((e) => e.event === 'figures'), 'checking citations shows no figures');

    // The helper model choosing none is respected.
    process.env.FAKE_NO_FIGURES = '1';
    events = await ask({ question: 'Does remote work improve employee productivity?' });
    assert.ok(!events.some((e) => e.event === 'figures'));
  } finally { delete process.env.FAKE_NO_FIGURES; await app.close(); mock.reset(); }
});

test('the window may load figure images from the open bucket and nowhere else', async () => {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-csp-')) });
  const base = await app.listen(0);
  try {
    const csp = (await mock.realFetch(base)).headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: https:\/\/pmc-oa-opendata\.s3\.amazonaws\.com;/);
    assert.match(csp, /connect-src 'self'/, 'the page still cannot fetch from anywhere else');
  } finally { await app.close(); }
});

// ---- which evidence views an answer shows (ui/evidence.js plan), and the brief answer
const vm = require('vm');
function loadEvidenceUI() {
  const ctx = { window: {}, self: undefined };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'evidence.js'), 'utf8'), ctx);
  ctx.window.LecternEvidence = ctx.window.LecternEvidence || ctx.LecternEvidence;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'evidence.js'), 'utf8'), ctx);
  return ctx.window.LecternEvidenceUI;
}

/** A turn with papers 1..n, each with an abstract and the given facts (quoted from that abstract). */
function turnWith(rows, extra = {}) {
  // Each fact is quoted from its own abstract, as the reading pass must do (quotes need 8+ characters).
  const quote = (k, v) => `the ${k} reported was ${v}`;
  const facts = (r) => Object.entries(r).filter(([k]) => k !== 'stance');
  const papers = rows.map((r, i) => ({ n: i + 1, title: `Paper ${i + 1}`, abstract: `Abstract of paper ${i + 1}. ${facts(r).map(([k, v]) => quote(k, v)).join('. ')}.` }));
  const insights = rows.map((r, i) => ({
    n: i + 1, relevant: true, stance: r.stance || 'na',
    facts: Object.fromEntries(facts(r).map(([k, v]) => [k, { value: v, quote: quote(k, v) }])),
  }));
  return { papers, insights, yesNo: false, mode: 'answer', ...extra };
}

test('evidence views appear only when the papers give them enough to show', () => {
  const UI = loadEvidenceUI();
  // Mixed directions, two kinds of design, three populations: everything shows.
  let views = UI.plan(turnWith([
    { direction: 'higher', designType: 'randomised', population: 'Nurses', measurement: 'objective' },
    { direction: 'lower', designType: 'observational', population: 'Teachers', measurement: 'self-report' },
    { direction: 'higher', designType: 'observational', population: 'Students', measurement: 'self-report' },
    { direction: 'unchanged', designType: 'randomised', population: 'Nurses', measurement: 'objective' },
  ]));
  assert.equal(views.compare, true);
  assert.equal(views.direction, 'chart');
  assert.equal(views.design, true);
  assert.ok(views.coverage, 'three groups, two methods, four filled cells');
  assert.deepEqual([...views.coverage.used], [true, true, true, false, true], 'the empty column is marked unused');

  // All one way: a sentence, not a one-bar chart. One design kind, two groups: no design chart, no map.
  views = UI.plan(turnWith([
    { direction: 'higher', designType: 'observational', population: 'Nurses' },
    { direction: 'higher', designType: 'observational', population: 'Teachers' },
    { direction: 'higher', designType: 'observational', population: 'Nurses' },
  ]));
  assert.equal(views.direction, 'same');
  assert.equal(views.design, false);
  assert.equal(views.coverage, null);

  // Mostly unreported directions (as in a real run with five of eight unreported): no direction chart.
  views = UI.plan(turnWith([
    { direction: 'higher' }, { direction: 'higher' }, { direction: 'mixed' }, { result: 'no direction one' },
    { result: 'no direction two' }, { result: 'no direction three' }, { result: 'no direction four' }, { result: 'no direction five' },
  ]));
  assert.equal(views.direction, null);

  // A yes/no question falls back to the stance reading.
  views = UI.plan(turnWith([{ stance: 'supports', result: 'a' }, { stance: 'against', result: 'b' }, { stance: 'supports', result: 'c' }], { yesNo: true }));
  assert.equal(views.direction, 'stance');

  // One relevant study: nothing to compare. No readings or checking citations: nothing at all.
  assert.equal(UI.plan(turnWith([{ direction: 'higher' }])).compare, false);
  assert.equal(UI.plan({ papers: [{ n: 1, title: 'x' }], insights: [], mode: 'answer' }).compare, false);
  assert.equal(UI.plan({ ...turnWith([{ direction: 'higher' }, { direction: 'lower' }]), mode: 'verify' }).compare, false);
});

test('an opening that describes the answer is not shown as the brief answer', () => {
  const Render = require('../ui/render.js');
  assert.equal(Render.splitLead('No. The papers disagree because they measure different things [1].\n\n## More').lead, 'No. The papers disagree because they measure different things [1].');
  for (const opening of [
    "I'll build the strongest case on each side from the supplied abstracts.",
    'I’ll lay out both arguments.',
    'Below, the evidence is split into two cases.',
    "Here's what the papers say.",
    '**Let me** start with the trials.',
  ]) {
    const parts = Render.splitLead(`${opening}\n\n## The case for\n\nText [1].`);
    assert.equal(parts.lead, '', opening);
    assert.ok(parts.body.startsWith(opening), 'the sentence stays in the answer');
  }
  assert.equal(Render.splitLead('Below-average sleep predicts later symptoms [2].').lead, '', 'a rare false positive only moves the sentence into the body');
});
