'use strict';
// The benchmark harness: interval maths, AUROC, the dev-only threshold, the group split and the claim rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../bench/metrics');
const { split, splitOf } = require('../bench/split');
const { claimCheck, stratified, lengthBin, PREREG } = require('../bench/run');

test('Wilson intervals match published values', () => {
  const z = M.wilson(0, 20);
  assert.equal(z.p, 0);
  assert.ok(Math.abs(z.hi - 0.1611) < 0.0005, 'the audit quoted 0-16.1% for 0/20');
  const w = M.wilson(5, 50);
  assert.ok(Math.abs(w.lo - 0.0435) < 0.0005 && Math.abs(w.hi - 0.2136) < 0.0005);
  assert.equal(M.wilson(0, 0), null);
});

test('AUROC: perfect, inverse, ties and empty sides', () => {
  assert.equal(M.auroc([3, 4], [1, 2]), 1);
  assert.equal(M.auroc([1], [2]), 0);
  assert.equal(M.auroc([1, 1], [1, 1]), 0.5);
  assert.equal(M.auroc([], [1]), null);
});

test('the threshold flags at most the target share of development human texts', () => {
  const human = Array.from({ length: 200 }, (_, i) => i);
  const t = M.thresholdForFpr(human, 0.05);
  assert.ok(human.filter((s) => s >= t).length <= 10);
  assert.equal(human.filter((s) => s >= t).length, 10);
});

test('summarise keeps AI-edited texts out of the confusion matrix and counts abstentions', () => {
  const s = M.summarise([
    { label: 'human', decision: false }, { label: 'human', decision: true }, { label: 'human', decision: null },
    { label: 'ai', decision: true }, { label: 'mixed', decision: true },
  ]);
  assert.deepEqual(s.confusion, { tp: 1, fn: 0, fp: 1, tn: 1 });
  assert.equal(s.abstained.human, 1);
  assert.equal(s.mixedFlagRate.p, 1);
  assert.equal(s.n.mixed, 1);
});

test('the split is by group, deterministic, and keeps the independent set in the holdout', () => {
  const items = [];
  for (let g = 0; g < 200; g++) for (const label of ['human', 'ai']) items.push({ group: `hc3:${g}`, label, hash: `${g}-${label}` });
  for (let g = 0; g < 20; g++) items.push({ group: `liang:${g}`, label: 'human', hash: `l${g}`, holdoutOnly: true });
  items.push({ group: 'hc3:dupe', label: 'ai', hash: '0-human' }); // same text as a holdout or dev item
  const { dev, holdout } = split(items);
  const devGroups = new Set(dev.map((x) => x.group));
  assert.equal(holdout.filter((x) => devGroups.has(x.group)).length, 0, 'no group on both sides');
  assert.ok(holdout.filter((x) => x.group.startsWith('liang')).length === 20 && !dev.some((x) => x.group.startsWith('liang')));
  const devShare = dev.filter((x) => x.group.startsWith('hc3:') && x.group !== 'hc3:dupe').length / 400;
  assert.ok(devShare > 0.3 && devShare < 0.5, `dev share ${devShare}`);
  assert.equal(splitOf(items[0]), splitOf({ ...items[0] }));
  const hashesHeld = new Set(holdout.map((x) => x.hash));
  assert.ok(!dev.some((x) => hashesHeld.has(x.hash)), 'a text in the holdout never also appears in dev');
});

test('the pre-registered claim rule needs every condition, overall and for non-native writers', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push({ label: 'human', decision: false, writer: 'unspecified', attack: 'none' });
  for (let i = 0; i < 400; i++) rows.push({ label: 'ai', decision: true, writer: 'unspecified', attack: 'none' });
  assert.equal(claimCheck(rows).pass, false, 'no non-native writers measured: cannot pass');
  for (let i = 0; i < 300; i++) rows.push({ label: 'human', decision: false, writer: 'non-native (TOEFL)', attack: 'none' });
  assert.equal(claimCheck(rows).pass, true);
  rows.push(...Array.from({ length: 30 }, () => ({ label: 'human', decision: true, writer: 'non-native (TOEFL)', attack: 'none' })));
  assert.equal(claimCheck(rows).pass, false);
  assert.equal(PREREG.review.flagAtScore, 20);
});

test('stratified sampling is seeded and spreads over label and source; length bins cover every count', () => {
  const items = [];
  for (const label of ['human', 'ai', 'mixed']) for (const source of ['A', 'B']) for (let i = 0; i < 10; i++) items.push({ label, source, writer: 'w', id: `${label}${source}${i}` });
  const a = stratified(items, 12).map((x) => x.id);
  assert.deepEqual(a, stratified(items, 12).map((x) => x.id));
  assert.equal(new Set(stratified(items, 12).map((x) => `${x.label}${x.source}`)).size, 6);
  for (const n of [0, 149, 150, 299, 300, 599, 600, 5000]) assert.ok(lengthBin(n));
});

// ---- bench/review: the live review benchmark (version 4 of the pre-registration)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RL = require('../bench/review/lib');
const RA = require('../bench/review/analyze');

test('review bench: the budget reads calls.jsonl, counts per agent and per team, and stops before the limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-team-'));
  const lines = [
    { agent: 'B', model: 'claude-sonnet-5-5', calls: 1 }, { agent: 'B', model: 'claude-sonnet-5-5', calls: 1 },
    { agent: 'C', model: 'claude-sonnet-5-5', calls: 8 }, { agent: 'A', model: 'claude-opus-5-5', calls: 10 },
  ];
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  assert.deepEqual(RL.checkBudget(dir, 'B', 'claude-sonnet-5-5', 1), { mine: 2, team: 10 });
  assert.doesNotThrow(() => RL.checkBudget(dir, 'B', 'claude-sonnet-5-5', 188));
  assert.throws(() => RL.checkBudget(dir, 'B', 'claude-sonnet-5-5', 189), /agent B has used 2 of 190/);
  assert.throws(() => RL.checkBudget(dir, 'B', 'claude-opus-5-5', 11), /team has used 10 of 20/, 'the team total binds before the agent allocation');
  assert.throws(() => RL.checkBudget(dir, 'B', 'claude-haiku-5-5', 1), /not allowed/);
  RL.logCall(dir, 'B', 'claude-sonnet-5-5', 'test');
  assert.equal(RL.readSpent(dir, 'B').agent['claude-sonnet-5-5'], 3);
  assert.equal(RL.readSpent(path.join(dir, 'nothing-here'), 'B').lines, 0);
});

test('review bench: the guard keeps Claude Code only, points Codex at nothing and never saves settings', () => {
  const s = RL.guardedSettings({ engine: 'codex', bins: { claude: '', codex: '/usr/local/bin/codex' }, models: { 'claude-code': 'x', codex: 'gpt' } }, { model: 'claude-sonnet-5-5' });
  assert.equal(s.engine, 'claude-code');
  assert.equal(s.bins.codex, '/nonexistent/codex');
  assert.equal(s.models['claude-code'], 'claude-sonnet-5-5');
  assert.throws(() => RL.guardedConfig(s).update({}), /never changes settings/);
});

test('review bench: a call is refused for another engine or model, cached by prompt and text, and paid once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-team-'));
  const stats = { cached: 0, paid: 0 };
  let real = 0;
  const base = { real: async (o) => { real++; return { text: 'reply', model: o.model, usage: {} }; }, model: 'claude-sonnet-5-5', codeVersion: `test-${Date.now()}-${Math.random()}`, textHash: 'h1', teamDir: dir, agent: 'B', purpose: 'test', fake: true, stats };
  const call = RL.guardedComplete(base);
  const o = { engine: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low', system: 's', prompt: 'p' };
  await assert.rejects(() => call({ ...o, engine: 'codex' }), /only claude-code/);
  await assert.rejects(() => call({ ...o, model: 'claude-opus-5-5' }), /fixed to claude-sonnet-5-5/);
  assert.equal((await call(o)).text, 'reply');
  assert.equal((await call(o)).text, 'reply');
  assert.equal(real, 1, 'the second identical call came from the cache');
  assert.deepEqual(stats, { cached: 1, paid: 1 });
  await call({ ...o, prompt: 'other' });
  assert.equal(real, 2, 'a different prompt is a different call');
  assert.equal(RL.readSpent(dir, 'B').lines, 0, 'fake calls are not logged as spending');
  // a live call logs one line, and a reply from another model than requested stops the run
  const live = RL.guardedComplete({ ...base, fake: false, codeVersion: `live-${Date.now()}`, real: async () => ({ text: 'x', model: 'claude-haiku-5-5' }), stats: { cached: 0, paid: 0 } });
  await assert.rejects(() => live(o), (e) => e.fatal && /reported model/.test(e.message));
  assert.equal(RL.readSpent(dir, 'B').agent['claude-sonnet-5-5'], 1, 'the call that was made is logged even though its model was wrong');
});

test('review bench: the cache key changes with code version, model, prompt and text', () => {
  const k = (over) => RL.cacheKey({ codeVersion: 'a', model: 'm', effort: 'low', system: 's', prompt: 'p', textHash: 't', ...over });
  const all = new Set([k({}), k({ codeVersion: 'b' }), k({ model: 'n' }), k({ system: 's2' }), k({ prompt: 'q' }), k({ textHash: 'u' }), k({ effort: 'high' })]);
  assert.equal(all.size, 7);
  assert.equal(k({}), k({}));
});

test('review bench: provisional scores and the paired bootstrap behave', () => {
  const s = RL.provisionalScores([{ words: 10, rating: 80 }, { words: 30, rating: 20 }, { words: 10, rating: 50 }]);
  assert.equal(s.headline65, 20);
  assert.equal(s.share50, 40);
  assert.equal(s.meanRating, 38);
  assert.equal(RL.provisionalScores([]), null);
  const docs = [];
  for (let i = 0; i < 12; i++) docs.push({ label: 'human', v: i % 4 }, { label: 'ai', v: 5 + (i % 4) }, { label: 'edited', v: 3 + (i % 4) });
  const better = docs.map((x) => ({ ...x }));
  const worse = docs.map((x) => ({ ...x, v: x.label === 'human' ? 4 : 4 }));
  const a = RA.pairedAuroc(worse, better);
  assert.deepEqual(a, RA.pairedAuroc(worse, better), 'seeded, so repeatable');
  assert.ok(a.lo > 0, 'a clear improvement has an interval above zero');
  const same = RA.pairedAuroc(better, better.map((x) => ({ ...x })));
  assert.equal(same.lo, 0);
  assert.equal(same.hi, 0);
});

test('review bench: the built benchmark, when present, has disjoint groups, one-call documents and the planned classes', () => {
  const manifest = path.join(__dirname, '..', 'bench', 'review', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.ok(m.datasets.every((d) => d.name && d.url && d.licence && d.revision), 'every dataset has a licence and revision on record');
  assert.ok(/NONE STATED/.test(m.datasets.find((d) => /MixSet/.test(d.name)).licence), 'MixSet has no stated licence and the manifest says so');
  if (!m.items) return;
  const dev = m.items.filter((x) => x.split === 'dev');
  const hold = m.items.filter((x) => x.split === 'holdout');
  const devGroups = new Set(dev.map((x) => x.group));
  assert.equal(hold.filter((x) => devGroups.has(x.group)).length, 0);
  assert.equal(new Set(m.items.map((x) => x.group)).size, m.items.length, 'one document per group');
  assert.equal(new Set(m.items.map((x) => x.hash)).size, m.items.length);
  assert.ok(m.items.every((x) => x.words >= 150 && x.words <= 700));
  for (const list of [dev, hold]) for (const label of ['human', 'ai', 'edited']) assert.ok(list.some((x) => x.label === label));
  assert.ok(!JSON.stringify(m).includes('"text"'), 'the manifest holds no texts');
});

test('review bench: the Markdown pattern, the Opus check selection and the holdout analysis', () => {
  assert.ok(RA.MARKDOWN.test('A line with **bold** text.'));
  assert.ok(RA.MARKDOWN.test('Intro.\n- a bullet\nmore'));
  assert.ok(RA.MARKDOWN.test('Intro.\n1. first'));
  assert.ok(!RA.MARKDOWN.test('A plain sentence, with a 3.5 number and a hyphen-ated word.'));
  const holdout = path.join(__dirname, '..', 'bench', 'data', 'review', 'holdout.jsonl');
  if (fs.existsSync(holdout)) {
    const ids = RA.opusIds();
    assert.equal(ids.length, 8);
    assert.deepEqual(ids, RA.opusIds(), 'seeded');
    const info = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'review', 'manifest.json'), 'utf8')).items.map((x) => [x.id, x]));
    const labels = ids.map((i) => info.get(i).label);
    assert.deepEqual([labels.filter((l) => l === 'human').length, labels.filter((l) => l === 'edited').length, labels.filter((l) => l === 'ai').length], [3, 3, 2]);
    assert.ok(ids.some((i) => /non-native/.test(info.get(i).writer)));
    const texts = new Map(fs.readFileSync(holdout, 'utf8').trim().split('\n').map(JSON.parse).map((x) => [x.id, x.text]));
    assert.ok(ids.every((i) => !RA.MARKDOWN.test(texts.get(i))));
  }
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ label: 'human', writer: 'student', v: i, words: 300, headline: i }, { label: 'ai', writer: 'x', v: 20 + i, words: 200, headline: 20 + i }, { label: 'edited', writer: 'x', v: 10 + i, words: 250, headline: 10 + i });
  const r = RA.analyse(rows, rows.map((x) => ({ ...x })), { threshold: 20 });
  assert.equal(r.n.human, 10);
  assert.equal(r.S0.detectionAI.p, 1);
  assert.equal(r.wordCountAuroc.all, 0, 'every positive is shorter than every human');
  assert.equal(r.aurocDiff.diff, 0);
});
