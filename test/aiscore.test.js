'use strict';
// The AI-writing review's honesty rules, one test per failure mode in the AI score accuracy audit (2026-11-15):
// failed, partial, missing, duplicated and malformed model replies; coverage and denominators; long sentences;
// suggestion anchoring; model provenance; and the words the interface and the prompt may use.
// The model is replaced by a function, so nothing here uses a plan or the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const llm = require('../server/llm');
const Prompts = require('../server/prompts');
const { Config } = require('../server/config');
const { runAiCheck, parseReview, percents, SCORING } = require('../server/checks/aiscore');
const T = require('../server/checks/text');

llm.engineStatus = async () => [{ id: 'codex', ready: true }, { id: 'claude-code', ready: true }];
const config = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-aiscore-')));

const para = (k) => `The village council met on a wet Tuesday in March to argue about bridge number ${k}. Margaret said the old stones would not last another winter, and nobody disagreed with her. The engineer from Leeds had measured the cracks twice and written the numbers on a napkin. We walked home past the bakery, which was already closed for the night.`;
const TEXT = [1, 2, 3].map(para).join('\n\n');
const LONG = Array.from({ length: 140 }, (_, k) => para(k)).join('\n\n'); // several review parts
const ids = (prompt) => [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => +m[1]);
const rateAll = (ai = 30, extra = {}) => async (o) => ({ text: JSON.stringify({ spans: ids(o.prompt).map((n) => ({ from: n, to: n, ai, why: 'Specific detail.' })), issues: [], ...extra }) });
const run = (complete, text = TEXT) => runAiCheck({ text, config, engine: 'codex', selectedModel: 'gpt-6.1-sol', complete });
const eligible = (r) => r.sentences.filter((s) => s.eligible);
/** The rule the audit asked for: text the model did not validly rate is never shown as "few patterns". */
const noSilentHuman = (r) => eligible(r).every((s) => (s.review === 'model' ? s.band !== null : s.band === null && s.rating === null && s.unreviewedReason));

test('an empty, null or malformed reply reviews nothing and gives no score', async () => {
  for (const text of ['{"spans": [], "issues": []}', '{"spans": [{"from": 1, "to": 6, "ai": null}, {"from": 7, "to": 12, "ai": ""}]}', '{"spans": [', 'Sure! Here is my analysis.', '{"spans": "all fine"}']) {
    const r = await run(async () => ({ text }));
    assert.equal(r.status, 'unavailable', text);
    assert.equal(r.score, null, text);
    assert.equal(r.reviewedWords, 0);
    assert.equal(r.bands.notReviewed, 100);
    assert.ok(noSilentHuman(r));
  }
});

test('ratings must be real numbers 0-100 on whole sentence numbers inside the part', () => {
  const p = parseReview(JSON.stringify({ spans: [
    { from: 1, to: 1, ai: 70 }, { from: '2', ai: '45' }, { from: 3, ai: null }, { from: 4, ai: true }, { from: 5, ai: 150 },
    { from: 6.5, ai: 20 }, { from: 7, to: 6, ai: 20 }, { from: 0, ai: 20 }, { from: 9, to: 30, ai: 20 }, { from: 10, to: 10, ai: '12abc' },
  ] }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...p.ratings.keys()], [1, 2]);
  assert.equal(p.status, 'partial');
  assert.deepEqual(p.missing, [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(p.problems.invalidSpans >= 6);
  assert.equal(p.problems.tooWide, 1, 'a span wider than allowed is rejected, not cut to fit');
});

test('missing sentences are "not reviewed", and a score needs enough reviewed words', async () => {
  const r = await run(async () => ({ text: '{"spans": [{"from": 1, "to": 1, "ai": 90, "why": "x"}]}' }));
  assert.equal(r.status, 'partial');
  assert.equal(r.score, null);
  assert.match(r.scoreWithheld, /needs at least 80/);
  assert.equal(eligible(r).filter((s) => s.review === 'model').length, 1);
  assert.ok(noSilentHuman(r));
  assert.ok(r.notes.some((n) => /not reviewed/.test(n)));
});

test('conflicting duplicate ratings for one sentence leave it not reviewed; identical repeats are fine', async () => {
  const r = await run(async (o) => {
    const reply = JSON.parse((await rateAll(20)(o)).text);
    reply.spans.push({ from: 2, to: 2, ai: 90 }, { from: 3, to: 3, ai: 20 });
    return { text: JSON.stringify(reply) };
  });
  const s2 = eligible(r).find((s) => s.i === 1);
  const s3 = eligible(r).find((s) => s.i === 2);
  assert.equal(s2.review, 'unreviewed');
  assert.equal(s3.review, 'model');
  assert.equal(r.provenance.batches[0].problems.conflicts, 1);
});

test('one failed part out of several: partial result, kept in the report, in source order', async () => {
  let k = 0;
  const r = await run(async (o) => {
    const n = ++k;
    await new Promise((res) => setTimeout(res, n === 1 ? 80 : 5)); // part 1 finishes last
    if (n === 2) throw new Error('provider timed out');
    const reply = JSON.parse((await rateAll(70)(o)).text);
    reply.summary = `S${ids(o.prompt)[0]}`;
    return { text: JSON.stringify(reply) };
  }, LONG);
  const parts = r.provenance.batches;
  assert.ok(parts.length >= 3);
  assert.deepEqual(parts.map((b) => b.n), parts.map((_, i) => i + 1), 'parts are listed in source order');
  assert.equal(parts[1].status, 'failed');
  assert.match(parts[1].error, /timed out/);
  assert.equal(r.status, 'partial');
  assert.ok(r.coverage < 1 && r.coverage > 0.6);
  assert.ok(noSilentHuman(r));
  const first = r.summary.split(' ')[0];
  assert.equal(first, 'S1', 'summaries follow the text, not the order the parts finished');
  assert.ok(r.notes.some((n) => /reviewed .* of .* eligible words/.test(n)));
});

test('every part failed: unavailable, never "few patterns"', async () => {
  const r = await run(async () => { throw new Error('network down'); });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.score, null);
  assert.ok(noSilentHuman(r));
  assert.ok(eligible(r).every((s) => /network down/.test(s.unreviewedReason)));
});

test('a rejected model option stops the review instead of switching model', async () => {
  let calls = 0;
  const r = await run(async () => { calls++; throw Object.assign(new Error('Codex rejected the model option'), { code: 'MODEL_REJECTED' }); }, LONG);
  assert.equal(r.status, 'unavailable');
  assert.ok(calls <= SCORING.workers, 'no part is sent after the rejection is known');
  assert.ok(r.provenance.batches.some((b) => b.status === 'not sent'));
  assert.match(r.scoreWithheld, /rejected the model option/);
});

test('a long sentence is cut into parts the model reads whole; no unseen tail is rated; offsets stay exact', async () => {
  const long = `This first part of a very long sentence keeps going ${'with ordinary words about the river and the mill '.repeat(25)}and finally ends with a DISTINCTTAIL marker phrase.`;
  let prompts = '';
  const r = await run(async (o) => { prompts += o.prompt; return rateAll(30)(o); }, `${TEXT}\n\n${long}`);
  const parts = r.sentences.filter((s) => s.part);
  assert.ok(parts.length >= 2);
  assert.ok(prompts.includes('DISTINCTTAIL'), 'the tail reaches the model');
  assert.ok(!prompts.includes('…'), 'nothing in the prompt was clipped');
  assert.ok(parts.every((p) => p.review === 'model' && p.end - p.start <= SCORING.maxUnitChars));
  const start = r.text.indexOf('This first part');
  assert.equal(parts[0].start, start);
  assert.equal(parts[parts.length - 1].end, r.text.indexOf('phrase.') + 'phrase.'.length);
  for (const p of T.splitLong(r.text, { start, end: parts[parts.length - 1].end, text: '' }, 900)) assert.equal(r.text.slice(p.start, p.end).replace(/\s*\n\s*/g, ' '), p.text);
});

test('suggestions anchor only inside the sentence the model named, and only when unambiguous', async () => {
  const text = `The council approved the plan quickly. ${TEXT} The council approved the plan, and later the plan was approved again by the plan committee.`;
  const r = await run(rateAll(20, { issues: [
    { s: 4, quote: 'approved the plan', kind: 'grammar', note: 'claims sentence 4, but the words are elsewhere', fix: 'x' },
    { s: 14, quote: 'the plan', kind: 'repetition', note: 'three times in that sentence: ambiguous', fix: '' },
    { s: 'one', quote: 'council', kind: 'clarity' },
    { s: 1, quote: 'approved the plan', kind: 'clarity', note: 'right sentence, once', fix: 'passed the plan' },
  ] }), text);
  assert.deepEqual(r.issues.map((i) => [i.sentence + 1, r.text.slice(i.start, i.end)]), [[1, 'approved the plan']]);
  assert.equal(r.rejectedSuggestions, 3);
});

test('length boundaries: 39/40 words to start, 79/80 reviewed words for a score, 299/300 for the length category', async () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`);
  const prose = (n) => { const w = words(n); const out = []; for (let i = 0; i < w.length; i += 10) out.push(`${w.slice(i, i + 10).join(' ')}.`); return out.join(' '); };
  await assert.rejects(run(rateAll(30), prose(39)), /at least 40 words/);
  const at40 = await run(rateAll(30), prose(40));
  assert.equal(at40.score, null);
  const at79 = await run(rateAll(30), prose(79));
  assert.equal(at79.eligibleWords, 79);
  assert.equal(at79.score, null);
  assert.equal(at79.lengthCategory, 'short');
  const at80 = await run(rateAll(30), prose(80));
  assert.equal(at80.score, 0);
  assert.equal(at80.lengthCategory, 'brief');
  assert.equal((await run(rateAll(30), prose(299))).lengthCategory, 'brief');
  assert.equal((await run(rateAll(30), prose(300))).lengthCategory, 'standard');
});

test('headings and reference lists only: no zero-denominator, no score', async () => {
  const text = 'Introduction\n\nMethods\n\nResults\n\nDiscussion\n\nConclusion\n\nAppendix A\n\nAppendix B\n\nAcknowledgements\n\nReferences\nSmith J 2020 Title of a paper\nJones K 2019 Another title of a paper\nBrown L 2018 More words in a title here\nGreen M 2017 Yet another title in the list\nWhite N 2016 The final title in this list';
  const r = await run(rateAll(80), text);
  assert.equal(r.score, null);
  assert.ok(Number.isFinite(r.coverage));
  assert.equal(Object.values(r.bands).reduce((a, b) => a + b, 0), r.eligibleWords ? 100 : 0);
});

test('band percentages always add up to 100', () => {
  assert.deepEqual(percents({ a: 1, b: 1, c: 1 }, 3), { a: 34, b: 33, c: 33 });
  assert.equal(Object.values(percents({ strong: 17, some: 29, few: 51, notReviewed: 3 }, 100)).reduce((x, y) => x + y, 0), 100);
  assert.deepEqual(percents({ a: 0 }, 0), { a: 0 });
});

test('words used by the interface, the copied report and the prompt make no authorship verdict', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'checks.js'), 'utf8');
  for (const banned of [/likely AI/i, /reads as human/i, /possibly AI/i, /reads as AI/i, /AI-written/i, /written by AI/i, /is AI-generated/i]) {
    assert.ok(!banned.test(ui), `ui/checks.js must not say ${banned}`);
  }
  assert.ok(!/how likely it is to have been written/i.test(Prompts.AI_REVIEW_SYSTEM));
  assert.ok(!/point towards a human/i.test(Prompts.AI_REVIEW_SYSTEM));
  assert.match(Prompts.AI_REVIEW_SYSTEM, /never use these as evidence/i);
  assert.match(Prompts.AI_REVIEW_SYSTEM, /non-native English/);
});

test('engines: in strict mode a rejected model option is an error, never a silent switch; otherwise it is dropped as before', async () => {
  const codex = require('../server/llm/codex');
  const claude = require('../server/llm/claudecode');
  const fakes = path.join(__dirname, 'fakes');
  process.env.FAKE_REJECT_FLAG = '-m';
  try {
    await assert.rejects(codex.complete({ bin: path.join(fakes, 'codex'), model: 'gpt-6.1-sol', prompt: 'Numbered sentences (1):\n\n[1] Hello there friend.', strictModel: true }), (e) => e.code === 'MODEL_REJECTED' && /gpt-6\.1-sol could not be used/.test(e.message));
    const loose = await codex.complete({ bin: path.join(fakes, 'codex'), model: 'gpt-6.1-sol', prompt: 'hello' });
    assert.ok(loose.text, 'the main answer path keeps its old compatibility retry');
  } finally { delete process.env.FAKE_REJECT_FLAG; }
  process.env.FAKE_REJECT_FLAG = '--model';
  try {
    await assert.rejects(claude.complete({ bin: path.join(fakes, 'claude'), model: 'claude-opus-5-5', prompt: 'hi', system: 'You are a careful writing analyst.', strictModel: true }), (e) => e.code === 'MODEL_REJECTED');
  } finally { delete process.env.FAKE_REJECT_FLAG; }
  const ok = await claude.complete({ bin: path.join(fakes, 'claude'), model: 'claude-opus-5-5', prompt: 'Numbered sentences (1):\n\n[1] Hello there friend.', system: 'You are a careful writing analyst.' });
  assert.equal(ok.model, 'claude-opus-5-5', 'Claude Code reports its model in the stream, and that is what is recorded');
});
