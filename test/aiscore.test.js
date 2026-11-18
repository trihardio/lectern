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
const { runAiCheck, parseReview, percents, documentScores, SCORING } = require('../server/checks/aiscore');
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
  // 9-30 reaches outside the part, so it is rejected whole (below, a span that is too wide inside the part is a separate case)
  assert.deepEqual([...p.ratings.keys()], [1, 2]);
  assert.equal(p.status, 'partial');
  assert.deepEqual(p.missing, [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(p.problems.invalidSpans >= 6);
  assert.equal(p.problems.outOfBatch, 2, 'spans 0 and 9-30 reach outside the part and are rejected whole');
});

test('a span wider than allowed is rejected, not cut to fit; width counts only sentences the model was shown', () => {
  const wide = parseReview(JSON.stringify({ spans: [{ from: 1, to: 9, ai: 50 }] }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(wide.problems.tooWide, 1);
  assert.equal(wide.ratings.size, 0);
  // numbers 2, 4, 6, 8 ... were headings and were never shown: 1-13 holds only 7 shown sentences
  const shown = [1, 3, 5, 7, 9, 11, 13];
  const ok = parseReview(JSON.stringify({ spans: [{ from: 1, to: 13, ai: 50 }] }), shown);
  assert.equal(ok.problems.tooWide, 0);
  assert.equal(ok.status, 'complete');
});

test('a span that runs across numbers the model was never shown (headings) rates only the shown sentences inside it', async () => {
  const p = parseReview(JSON.stringify({ spans: [{ from: 3, to: 4, ai: 35 }, { from: 6, to: 8, ai: 38 }, { from: 10, to: 13, ai: 15 }] }), [3, 4, 6, 8, 10, 11, 13]);
  assert.equal(p.status, 'complete');
  assert.deepEqual([...p.ratings.entries()].map(([n, v]) => [n, v.rating]), [[3, 35], [4, 35], [6, 38], [8, 38], [10, 15], [11, 15], [13, 15]]);
  assert.equal(p.problems.outOfBatch, 0);
  // an end that is not a sentence of this part still rejects the span
  const bad = parseReview(JSON.stringify({ spans: [{ from: 6, to: 7, ai: 38 }, { from: 2, to: 4, ai: 20 }] }), [3, 4, 6, 8]);
  assert.equal(bad.problems.outOfBatch, 2);
  assert.equal(bad.ratings.size, 0);

  // end to end: a report with headings between paragraphs, and a model that writes spans across the headings
  const text = ['Introduction', para(1), 'Findings', para(2), 'Conclusion', para(3)].join('\n\n');
  const r = await run(async (o) => {
    const n = ids(o.prompt);
    const spans = [];
    for (let i = 0; i < n.length; i += 4) spans.push({ from: n[i], to: n[Math.min(i + 3, n.length - 1)], ai: 30, why: 'Specific.' });
    return { text: JSON.stringify({ spans }) };
  }, text);
  assert.equal(r.provenance.batches[0].problems.outOfBatch, 0);
  assert.equal(eligible(r).filter((s) => s.review !== 'model').length, 0);
  assert.equal(r.status, 'complete');
});

test('an optional whole-text "overall" rating is read as strictly as a sentence rating, and never rejects the part', () => {
  const spans = [{ from: 1, to: 2, ai: 40 }];
  const get = (overall) => parseReview(JSON.stringify({ spans, ...(overall === undefined ? {} : { overall }) }), [1, 2]);
  for (const [v, want] of [[0, 0], [37, 37], [100, 100], ['64', 64]]) assert.equal(get(v).overall, want, String(v));
  assert.equal(get(undefined).overall, null);
  assert.equal(get(undefined).problems.invalidOverall, 0);
  assert.equal(get(null).problems.invalidOverall, 0);
  for (const v of [101, -1, 12.5, '12abc', '', true, [], {}, 'high']) {
    const p = get(v);
    assert.equal(p.overall, null, JSON.stringify(v));
    assert.equal(p.problems.invalidOverall, 1, JSON.stringify(v));
    assert.equal(p.status, 'complete', 'the part is still kept');
  }
});

test('the report carries the whole-text rating only when every part that was read gave a valid one', async () => {
  const r1 = await run(async (o) => ({ text: JSON.stringify({ overall: 44, spans: ids(o.prompt).map((n) => ({ from: n, to: n, ai: 30 })) }) }));
  assert.equal(r1.overall, 44);
  assert.equal(r1.provenance.batches[0].overall, 44);
  const r2 = await run(rateAll(30));
  assert.equal(r2.overall, null);
  const r3 = await run(async (o) => ({ text: JSON.stringify({ overall: 250, spans: ids(o.prompt).map((n) => ({ from: n, to: n, ai: 30 })) }) }));
  assert.equal(r3.overall, null);
  assert.equal(r3.provenance.batches[0].problems.invalidOverall, 1);
  assert.equal(r3.status, 'complete');
});

/** A report shaped like runAiCheck's, built from [words, rating] pairs; a null rating is "not reviewed". */
const fake = (pairs, extra = {}) => {
  const sentences = pairs.map(([words, rating], i) => ({ i, eligible: true, words, review: rating == null ? 'unreviewed' : 'model', rating }));
  return { sentences: [{ i: 99, eligible: false }, ...sentences], eligibleWords: pairs.reduce((n, [w]) => n + w, 0), overall: null, ...extra };
};

test('documentScores: the four candidate scores, word-weighted, from the per-sentence ratings only', () => {
  // words 40/60/50/50/100 at ratings 70/45/40/20/10: reviewed words 300
  const d = documentScores(fake([[40, 70], [60, 45], [50, 40], [50, 20], [100, 10]], { overall: 55 }));
  assert.equal(d.strongShare, Math.round(100 * 40 / 300)); // 13
  assert.equal(d.someShare, Math.round(100 * 150 / 300)); // 50: 65+ and 40-64 both count
  assert.equal(d.meanRating, +((40 * 70 + 60 * 45 + 50 * 40 + 50 * 20 + 100 * 10) / 300).toFixed(1));
  // top quarter = 75 words: 40 at 70 and 35 of the 60 at 45
  assert.equal(d.topQuartileMean, +((40 * 70 + 35 * 45) / 75).toFixed(1));
  assert.equal(d.overall, 55);
  assert.equal(d.reviewedWords, 300);
  assert.equal(d.coverage, 1);
});

test('documentScores: the strong share is the headline, band edges are inclusive, and not-reviewed words are not counted', () => {
  assert.equal(documentScores(fake([[50, 65], [50, 64], [100, 39]])).strongShare, 25);
  assert.equal(documentScores(fake([[50, 65], [50, 64], [100, 39]])).someShare, 50);
  assert.equal(documentScores(fake([[50, 40], [100, 39], [100, 0]])).someShare, 20);
  const partial = documentScores(fake([[100, 80], [100, 20], [60, null]])); // coverage 200 of 260
  assert.equal(partial.reviewedWords, 200);
  assert.equal(partial.strongShare, 50);
  assert.equal(partial.coverage, +(200 / 260).toFixed(3));
});

test('documentScores: withheld like the headline (too few words, too little coverage, nothing reviewed); a bad overall is ignored', () => {
  for (const [rep, why] of [[fake([[79, 90]]), 'under 80 words'], [fake([[100, 90], [100, 90], [150, null]]), 'coverage under 60%'], [fake([[100, null]]), 'nothing reviewed'], [{ sentences: [] }, 'empty report'], [undefined, 'no report']]) {
    const d = documentScores(rep);
    assert.deepEqual([d.strongShare, d.someShare, d.meanRating, d.topQuartileMean], [null, null, null, null], why);
  }
  assert.equal(documentScores(fake([[100, 50]], { overall: 140 })).overall, null);
  assert.equal(documentScores(fake([[100, 50]], { overall: 12.5 })).overall, null);
  assert.equal(documentScores(fake([[100, 50]], { overall: 0 })).overall, 0);
  assert.equal(documentScores(fake([[100, 50]])).meanRating, 50);
});

test('the headline is the word-weighted mean rating, flagged at 52.1 or more (whole number 53), and the two always agree', async () => {
  for (const [ai, flagged] of [[10, false], [52, false], [53, true], [80, true]]) {
    const r = await run(rateAll(ai), LONG.slice(0, 6000));
    const d = documentScores(r);
    assert.equal(r.score, ai, `rating ${ai}`);
    assert.equal(r.score, Math.round(d.meanRating));
    assert.equal(r.scoreExact, d.meanRating);
    assert.equal(r.flagged, flagged, `rating ${ai}`);
    assert.equal(r.scores.strongShare, d.strongShare);
  }
  assert.equal(SCORING.version, 4); // version 7's prompt was tested and not shipped (deviation 9)
  assert.equal(SCORING.flagAt, 52.1);
  const r = await run(rateAll(60));
  assert.ok(!('headline' in r) && !('pattern' in r), 'the style reading is not part of the score and the old two-reading fields are gone');
  assert.ok(r.style && typeof r.style.probability === 'number', 'the style reading stays a separate second reading');
});

test('the flag is the frozen line 52.1 on the exact mean; the whole number never contradicts it', async () => {
  // two sentences of equal length at 52 and 53 average 52.5 (flagged); at 51 and 52 they average 51.5 (not flagged, the whole number stays below 53)
  const mixed = (a, b) => async (o) => ({ text: JSON.stringify({ spans: ids(o.prompt).map((n, i) => ({ from: n, to: n, ai: i % 2 ? b : a })) }) });
  const text = Array.from({ length: 8 }, (_, k) => para(k)).join('\n\n');
  const low = await run(mixed(51, 52), text);
  assert.ok(low.scoreExact >= 51 && low.scoreExact < 52.1, `exact ${low.scoreExact}`);
  assert.equal(low.flagged, false);
  assert.ok(low.score <= 52, `shown ${low.score}`);
  const high = await run(mixed(52, 53), text);
  assert.ok(high.scoreExact >= 52.1, `exact ${high.scoreExact}`);
  assert.equal(high.flagged, true);
  assert.ok(high.score >= 53, `shown ${high.score}`);
  for (const ai of [0, 20, 40, 50, 52, 53, 60, 90]) {
    const r = await run(rateAll(ai), LONG.slice(0, 4000));
    assert.equal(r.flagged, r.score >= 53, `rating ${ai}`);
  }
});

test('a withheld score has no flag; the whole-text rating and the test numbers stay in the report but not in the headline', async () => {
  const r = await run(async (o) => ({ text: JSON.stringify({ overall: 95, spans: ids(o.prompt).map((n) => ({ from: n, to: n, ai: 20 })) }) }));
  assert.equal(r.overall, 95);
  assert.equal(r.score, 20, 'overall is not part of the headline');
  assert.equal(r.flagged, false);
  const none = await run(async () => ({ text: 'nonsense' }));
  assert.equal(none.score, null);
  assert.equal(none.flagged, null);
  assert.equal(r.benchmark.texts, 36);
  assert.equal(r.benchmark.model, 'claude-sonnet-5-5');
  assert.deepEqual([r.benchmark.ai, r.benchmark.aiFlagged, r.benchmark.claudeFlagged, r.benchmark.human, r.benchmark.humanFlagged, r.benchmark.nonNative, r.benchmark.nonNativeFlagged, r.benchmark.flagAt, r.benchmark.auroc], [18, 10, 10, 18, 1, 6, 0, 52.1, 0.861]);
  assert.deepEqual(r.benchmark.styleOnly, { texts: 98, ai: 37, aiFlagged: 19, human: 61, humanFlagged: 6, nonNative: 22, nonNativeFlagged: 1, auroc: 0.852 });
  assert.ok(r.limits.some((x) => /review prompt \(version 6\) and the line \(52\.1\) were chosen on development texts and then tested once on 36 held-back texts.*2026-11-19.*claude-sonnet-5-5.*exact mean of 52\.1 or more, shown as 53 or more\) 10 of 18.*34 to 75%.*1 of 18 human texts.*0 of 6.*claim rule was not met/.test(x)));
  assert.ok(r.limits.some((x) => /headline was chosen after that test.*flagged 3 of the same 18 human texts.*may therefore be optimistic; by how much is not known/.test(x)));
  assert.ok(r.limits.some((x) => /style reading is separate and not part of the score.*all 98 held-back texts.*19 of 37.*6 of 61 human texts, 1 of 22.*25 were Wikipedia introductions.*flagged 4 of them/.test(x)));
  // Version 7 (AI text written or rewritten to sound human): the numbers and the limits that say how little they show.
  assert.deepEqual([r.benchmark.v7.texts, r.benchmark.v7.ai, r.benchmark.v7.aiFlagged, r.benchmark.v7.human, r.benchmark.v7.humanFlagged, r.benchmark.v7.previous.aiFlagged, r.benchmark.v7.previous.humanFlagged], [20, 10, 1, 10, 0, 0, 0]);
  assert.deepEqual(r.benchmark.v7.styleOnly, { texts: 36, ai: 13, aiFlagged: 5, aiInterval: [18, 65], human: 23, humanFlagged: 1, humanInterval: [1, 21], nonNative: 6, nonNativeFlagged: 0, auroc: 0.839 });
  assert.ok(r.limits.some((x) => /sound human was tested separately \(version 7\).*20 held-back texts.*this review flagged 0 of 10 AI texts and 0 of 10 human texts.*Most AI text written to sound human, including Rewrite output, is not flagged.*newer prompt.*flagged 1 of 10 \(interval 2 to 40%\) and 0 of 10 human texts; it is not used/.test(x)));
  assert.ok(r.limits.some((x) => /style reading flagged 5 of 13 AI texts.*1 of 23 human texts.*false-positive rate on casual human writing was not measured/.test(x)));
  assert.equal(SCORING.version, 4); // version 7's prompt was tested and not shipped (deviation 9)
  assert.equal(SCORING.flagAt, 52.1, 'the line did not move in version 7');
  assert.ok(r.limits.some((x) => /A low score never clears a text/.test(x)));
  assert.ok(!r.limits.some((x) => /100%|detects Claude/i.test(x)), 'no overclaiming in the limits');
  assert.equal(r.validated, false);
  // The second test (benchmark version 5, 2026-11-19): text from current Claude models, stated in the limits and
  // carried in the report for the note shown when the two readings disagree.
  assert.deepEqual(
    [r.currentModelsTest.ai, r.currentModelsTest.patternFlagged, r.currentModelsTest.styleFlagged, r.currentModelsTest.human, r.currentModelsTest.styleHumanFlagged, r.currentModelsTest.styleToeflFlagged, r.currentModelsTest.toefl],
    [78, 1, 59, 40, 3, 2, 8]);
});

test('the note for disagreeing readings never sends the reader to the style model as the better judge', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'checks.js'), 'utf8');
  const fn = ui.slice(ui.indexOf('function differWhy'), ui.indexOf('function differBox'));
  // style model version 4 flags human writing too (held-back test: 6 of 61, 1 of 22 non-native), so the note says so with
  // its numbers; "most often by non-native writers" described version 3 and is no longer true
  assert.match(fn, /style model also flagged \$\{so\.humanFlagged\} of \$\{so\.human\} human texts/);
  assert.match(fn, /also flags some human writing/);
  assert.doesNotMatch(fn, /most often by non-native/);
  assert.match(fn, /Neither reading is proof/);
  assert.doesNotMatch(fn, /trust|more accurate|more reliable|better/i);
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
  assert.equal(at80.score, 30, 'the headline is the mean rating');
  assert.equal(at80.flagged, false);
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

test('text wrapped at a fixed width (copied from a PDF) is read as whole sentences, and headings still stand alone', async () => {
  // Found on 2026-11-19 (benchmark version 5): every short wrapped line was taken for a heading, so a 211-word
  // abstract became 30 fragments and only 56 words could be reviewed.
  const wrapped = [
    'We introduce a post-processing method based on denoising',
    'autoencoders to improve the plausibility of arbitrary',
    'segmentation algorithms. Some of the most popular segmentation',
    'methods incorporate additional post-processing steps to ensure that the',
    'resulting masks fulfil expected connectivity constraints. These methods',
    'operate under the hypothesis that contiguous pixels should',
    'belong to the same class.',
  ].join('\n');
  const { sentences } = T.segment(`Abstract\n${wrapped}\n\n2 Method\nWe measured forty masks by hand.`);
  assert.deepEqual(sentences.map((s) => s.text), [
    'Abstract',
    'We introduce a post-processing method based on denoising autoencoders to improve the plausibility of arbitrary segmentation algorithms.',
    'Some of the most popular segmentation methods incorporate additional post-processing steps to ensure that the resulting masks fulfil expected connectivity constraints.',
    'These methods operate under the hypothesis that contiguous pixels should belong to the same class.',
    '2 Method',
    'We measured forty masks by hand.',
  ]);
  const r = await run(rateAll(30), `${wrapped}\n${wrapped}`);
  assert.equal(r.eligibleWords, 2 * T.words(wrapped).length); // 2 x 53: every word is in a reviewable sentence
  assert.equal(r.status, 'complete');
  assert.notEqual(r.score, null);
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

test('a sentence\'s number on hover and in its reason reads "AI-like" or "human-like" (100 minus the rating), with the not-proof line', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'checks.js'), 'utf8');
  // the owner's choice (2026-11-19): red and yellow show the rating as "% AI-like", green shows 100 minus it as "% human-like"
  assert.match(ui, /s\.band === 'few' \? \{ n: 100 - s\.rating, word: 'human-like' \} : \{ n: s\.rating, word: 'AI-like' \}/);
  assert.match(ui, /Writing patterns, not proof of who wrote it\./);
  assert.match(ui, /The number describes writing patterns in this sentence, not who wrote it\./);
  // never a bare "% AI" or "% human", which would read as a probability of who wrote the sentence
  assert.ok(!/%\s*(AI|human)(?![-\w])/i.test(ui.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'no bare "% AI" or "% human" in ui/checks.js');
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

// ---- version 6 (bench/v6/): the combined headline candidate S3 and the review runner's budget guard
test('the S3 helpers kept in bench/ for the record: style score side of 50 and the frozen 0.3/0.7 mix', () => {
  const S3 = require('../bench/v6/review-s3');
  assert.equal(S3.styleScoreOf({ probability: 0.5, flagged: false }), 49.9);
  assert.equal(S3.styleScoreOf({ probability: 0.5, flagged: true }), 50);
  assert.equal(S3.styleScoreOf(null), null);
  assert.equal(S3.headlineScore(40, 50), 0.3 * 40 + 0.7 * 50);
  assert.equal(S3.headlineScore(null, 50), null);
  assert.equal(S3.S3_LINE, 41.1);
});

test('S3 combines the mean rating and the style probability, deterministically, and ignores rows missing an input', () => {
  const S3 = require('../bench/v6/review-s3');
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const y = i % 2;
    rows.push({ y, meanRating: 15 + 30 * y + (i % 7) * 2, styleProbability: 0.15 + 0.5 * y + (i % 5) * 0.04 });
  }
  rows.push({ y: 1, meanRating: null, styleProbability: 0.9 }, { y: 0, meanRating: 30, styleProbability: NaN });
  const f = S3.fitS3(rows);
  assert.equal(f.n, 40, 'rows without both inputs are not used');
  assert.deepEqual(S3.fitS3(rows), f, 'the same rows always give the same formula');
  assert.ok(f.weights[0] > 0 && f.weights[1] > 0, 'a higher rating and a higher style probability both raise the score');
  assert.ok(S3.scoreS3(f, 50, 0.7) > S3.scoreS3(f, 15, 0.2));
  assert.ok(S3.scoreS3(f, 50, 0.7) > S3.scoreS3(f, 15, 0.7) && S3.scoreS3(f, 50, 0.7) > S3.scoreS3(f, 50, 0.2));
  assert.equal(S3.scoreS3(f, null, 0.5), null);
  assert.equal(S3.scoreS3(f, 40, undefined), null);
  const s = S3.scoreS3(f, 30, 0.5);
  assert.ok(s >= 0 && s <= 100);
  assert.throws(() => S3.fitS3(rows.slice(0, 4)), /at least 3 texts of each label/);
});

test('the Wilson interval and the AUROC helpers give the known values', () => {
  const S3 = require('../bench/v6/review-s3');
  assert.deepEqual(S3.wilson(0, 22), { k: 0, n: 22, pct: 0, lo: 0, hi: 14.9 });
  const w = S3.wilson(18, 32);
  assert.ok(w.lo === 39.3 && w.hi === 71.8, JSON.stringify(w));
  assert.equal(S3.auroc([3, 4], [1, 2]), 1);
  assert.equal(S3.auroc([1, 1], [1, 1]), 0.5);
  assert.equal(S3.auroc([null], [0]), 0, 'a missing score counts as -1');
});

test('the version 6 review runner refuses a call past agent C\'s share, the team total, and any other model', () => {
  const R = require('../bench/v6/review-run');
  const rows = (n, agent, model) => Array.from({ length: n }, () => ({ agent, model }));
  assert.doesNotThrow(() => R.checkBudget('claude-sonnet-5-5', 0, rows(129, 'C', 'claude-sonnet-5-5')));
  assert.throws(() => R.checkBudget('claude-sonnet-5-5', 0, rows(130, 'C', 'claude-sonnet-5-5')), /agent C has used 130 of 130/);
  assert.throws(() => R.checkBudget('claude-sonnet-5-5', 2, rows(128, 'C', 'claude-sonnet-5-5')), /agent C/, 'calls in flight count');
  assert.throws(() => R.checkBudget('claude-sonnet-5-5', 0, [...rows(120, 'A', 'claude-haiku-5-5'), ...rows(100, 'C', 'claude-sonnet-5-5'), ...rows(30, 'A', 'claude-sonnet-5-5')]), /team has used 250 of 250/, 'Haiku and Sonnet share the 250');
  assert.throws(() => R.checkBudget('claude-opus-5-5', 0, rows(9, 'C', 'claude-opus-5-5')), /9 of 9/);
  assert.throws(() => R.checkBudget('claude-haiku-5-5', 0, []), /not allowed/);
});

test('the version 6 review runner calls only Claude Code and only the model it was started for', async () => {
  const R = require('../bench/v6/review-run');
  const stats = { cached: 0, paid: 0, inflight: 0 };
  const g = R.guarded({ real: async () => { throw new Error('must not be reached'); }, model: 'claude-sonnet-5-5', run: 1, textId: 't', textHash: 'h', system: 's2', fake: true, stats });
  await assert.rejects(g({ engine: 'codex', model: 'claude-sonnet-5-5', system: 'a', prompt: 'b' }), /only claude-code/);
  await assert.rejects(g({ engine: 'claude-code', model: 'claude-opus-5-5', system: 'a', prompt: 'b' }), /fixed to claude-sonnet-5-5/);
  assert.notEqual(R.cacheKey({ model: 'm', run: 1, system: 'a', prompt: 'b', textHash: 'h' }), R.cacheKey({ model: 'm', run: 2, system: 'a', prompt: 'b', textHash: 'h' }), 'a second run is a different cache entry');
});
