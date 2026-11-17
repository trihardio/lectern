'use strict';
// Proofreading (server/checks/proofread.js): exact edits from corrected sentences, the guards, and the whole check
// with a stand-in model. No real model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../server/config');
const P = require('../server/checks/proofread');

function config() {
  const c = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-proof-')));
  c.update({ bins: { claude: path.join(__dirname, 'fakes', 'claude'), codex: '/nonexistent/codex' } });
  return c;
}

/** A stand-in model: corrects sentences by a table { original sentence: corrected sentence }. */
function modelFrom(table, calls = []) {
  return async (o) => {
    calls.push(o);
    const lines = [...o.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    const fixes = lines.filter((l) => table[l.text] && table[l.text] !== l.text).map((l) => ({ n: l.n, text: table[l.text], changes: [] }));
    return { text: JSON.stringify({ fixes }), model: o.model || 'claude-opus-5-5' };
  };
}

const applyAll = (src, edits) => P.applySuggestions(src, edits.map((e) => ({ ...e })));

test('diffEdits: replacements, insertions, deletions, spacing and capitals reproduce the correction exactly', () => {
  const cases = [
    ['She have two book.', 'She has two books.'],
    ['When I arrived the room was empty.', 'When I arrived, the room was empty.'],
    ['We went to to the shop.', 'We went to the shop.'],
    ['It was late , we went  home', 'It was late. We went home.'],
    ['on monday i recieve the informations', 'On Monday I receive the information'],
    ['the students books are here', "the students' books are here"],
    ['A word at the end', 'A word at the end.'],
    ['Its raining.', "It's raining."],
  ];
  for (const [src, corr] of cases) {
    const edits = P.diffEdits(src, corr);
    assert.ok(edits.length > 0, src);
    assert.equal(applyAll(src, edits), corr, src);
    for (const e of edits) assert.ok(e.end > e.start, `every edit covers visible text: ${JSON.stringify(e)}`);
  }
});

test('diffEdits: quote and dash style, and line breaks inside a paragraph, are not edits', () => {
  assert.deepEqual(P.diffEdits('He said “yes” – twice.', 'He said "yes" - twice.'), []);
  const src = 'The cat   sat on the mat.'; // a line break with spaces around it, flattened to spaces
  assert.deepEqual(P.diffEdits(src, 'The cat sat on the mat.', (a, b) => a === 7 && b === 10), []);
  assert.equal(P.diffEdits(src, 'The cat sat on the mat.').length, 1, 'without a line break, a triple space is an edit');
});

test('kinds and titles come from the change first and the model label second', () => {
  assert.equal(P.kindOf('arrived', 'arrived,', 'SPELL'), 'punctuation');
  assert.equal(P.kindOf('monday', 'Monday', ''), 'capitalization');
  assert.equal(P.kindOf('wether', 'whether', 'SPELL'), 'spelling');
  assert.equal(P.kindOf('have', 'has', 'VERB:SVA'), 'grammar');
  assert.equal(P.kindOf('recieve', 'receive', ''), 'spelling');
  assert.equal(P.kindOf('big', 'wide', 'ADJ'), 'word');
  assert.equal(P.kindOf('go', 'went', ''), 'grammar');
  assert.equal(P.kindOf("it's", 'its', 'CONTR'), 'grammar', 'its / it’s is grammar');
  assert.equal(P.kindOf('students', "students'", 'NOUN:POSS'), 'grammar');
  assert.equal(P.kindOf('However', 'However,', 'PUNCT'), 'punctuation');
});

test('parseReply: wrong format fails; unknown, repeated and empty fixes are problems; numbers as strings are read', () => {
  assert.equal(P.parseReply('Sure! Here are the fixes.', [1, 2]).status, 'failed');
  const r = P.parseReply(JSON.stringify({ fixes: [{ n: 1, text: 'A.' }, { n: 1, text: 'B.' }, { n: 9, text: 'C.' }, { n: 2, text: '' }, { n: '2', text: 'D.' }] }), [1, 2]);
  assert.equal(r.status, 'complete');
  assert.equal(r.problems, 3);
  assert.deepEqual([...r.fixes.keys()], [1, 2]);
  assert.equal(r.fixes.get(1).text, 'A.');
});

test('guards: quotations, citations, links and headings are never edited; a rewritten sentence is not trusted', () => {
  const text = 'Method\n\nAs Smith (2019) notes, "the effect were small". See https://example.org/teh-page for teh data.\n\nThis sentence is fine.';
  const units = P.unitsOf(text);
  assert.equal(units[0].heading, true);
  const guard = P.protectedRanges(text);
  const quoteUnit = units.find((u) => u.src.startsWith('As Smith'));
  const r1 = P.suggestionsFor(text, quoteUnit, { text: 'As Smith (2020) notes, "the effect was small".', changes: [] }, guard);
  assert.equal(r1.suggestions.length, 0);
  assert.equal(r1.dropped.protected, 2);
  const linkUnit = units.find((u) => u.src.startsWith('See'));
  const r2 = P.suggestionsFor(text, linkUnit, { text: 'See https://example.org/the-page for the data.', changes: [] }, guard);
  assert.deepEqual(r2.suggestions.map((s) => [s.from, s.to]), [['teh', 'the']]);
  const r3 = P.suggestionsFor(text, units[0], { text: 'Method.', changes: [] }, guard);
  assert.equal(r3.suggestions.length, 0);
  assert.equal(r3.dropped.heading, 1);
  const fine = units.find((u) => u.src.startsWith('This sentence'));
  const r4 = P.suggestionsFor(text, fine, { text: 'Completely different words replace every one of these.', changes: [] }, guard);
  assert.equal(r4.suggestions.length, 0);
  assert.equal(r4.dropped.misaligned, 1);
});

test('runProofread: exact offsets into the text as given, notes attached, parts streamed, strict model', async () => {
  P._cache.clear();
  const text = 'Introduction\n\nShe have finished her homeworks.  When the samples arrived we stored them.\nThe results was clear.\n\nThis line is correct.';
  const calls = [];
  const complete = async (o) => {
    calls.push(o);
    return { text: JSON.stringify({ fixes: [
      { n: 2, text: 'She has finished her homework.', changes: [{ from: 'have', to: 'has', type: 'VERB:SVA', why: 'The subject is singular.' }, { from: 'homeworks', to: 'homework', type: 'NOUN:INFL', why: 'Homework has no plural.' }] },
      { n: 3, text: 'When the samples arrived, we stored them.', changes: [{ from: 'arrived', to: 'arrived,', type: 'PUNCT', why: 'Comma after an introductory clause.' }] },
      { n: 4, text: 'The results were clear.', changes: [] },
    ] }), model: 'chosen-model' };
  };
  const parts = [];
  const r = await P.runProofread({ text, config: config(), engine: 'claude-code', selectedModel: 'chosen-model', complete, emit: (e, d) => { if (e === 'part') parts.push(d); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].strictModel, true);
  assert.equal(calls[0].model, 'chosen-model');
  assert.match(calls[0].prompt, /^\[1\] Introduction$/m);
  assert.equal(r.length, text.length);
  for (const s of r.suggestions) assert.equal(text.slice(s.start, s.end), s.from, 'offsets point at the original words');
  assert.deepEqual(r.suggestions.map((s) => [s.from, s.to, s.kind]), [
    ['have', 'has', 'grammar'], ['homeworks', 'homework', 'grammar'], ['arrived', 'arrived,', 'punctuation'], ['was', 'were', 'grammar'],
  ]);
  assert.equal(r.suggestions[0].title, 'Subject-verb agreement');
  assert.equal(r.suggestions[0].why, 'The subject is singular.');
  assert.equal(r.suggestions[3].why.length > 0, true, 'a default explanation when the model gives none');
  assert.equal(P.applySuggestions(text, r.suggestions), 'Introduction\n\nShe has finished her homework.  When the samples arrived, we stored them.\nThe results were clear.\n\nThis line is correct.');
  assert.equal(parts.reduce((n, p) => n + p.suggestions.length, 0), 4);
  assert.equal(r.provenance.modelConfirmed, true);
  assert.deepEqual(r.checked.unchecked, []);
});

test('runProofread: a second check sends only the sentences that changed', async () => {
  P._cache.clear();
  const table = { 'Their is a problem.': 'There is a problem.', 'It work well.': 'It works well.' };
  const calls = [];
  const c = config();
  const first = await P.runProofread({ text: 'Their is a problem. It work well. All good here.', config: c, engine: 'claude-code', complete: modelFrom(table, calls) });
  assert.equal(first.suggestions.length, 2);
  assert.equal(first.checked.sent, 3);
  const second = await P.runProofread({ text: 'There is a problem. It work well. All good here. A new line.', config: c, engine: 'claude-code', complete: modelFrom(table, calls) });
  assert.equal(second.checked.reused, 2, 'the unchanged sentences come from the earlier check');
  assert.equal(second.checked.sent, 2);
  assert.match(calls[1].prompt, /\[1\] There is a problem\.\n\[2\] A new line\./);
  assert.deepEqual(second.suggestions.map((s) => [s.from, s.to]), [['work', 'works']]);
});

test('runProofread: failures are reported, a rejected model stops the check, nothing is sent for oversized text', async () => {
  P._cache.clear();
  const many = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
  let n = 0;
  const notices = [];
  const flaky = async () => { n++; if (n === 2) throw new Error('timed out'); return { text: '{"fixes": []}' }; };
  const r = await P.runProofread({ text: many, config: config(), engine: 'claude-code', complete: flaky, emit: (e, d) => { if (e === 'notice') notices.push(d.text); } });
  assert.equal(r.provenance.batches.length, 3);
  assert.equal(r.provenance.batches.filter((b) => b.status === 'failed').length, 1);
  assert.ok(r.checked.unchecked.length > 0);
  assert.match(notices.join(' '), /not checked: timed out/);
  assert.match(r.notes.join(' '), /could not be checked/);

  P._cache.clear();
  let sent = 0;
  const rejecting = async () => { sent++; throw Object.assign(new Error('model rejected'), { code: 'MODEL_REJECTED' }); };
  const more = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} is here.`).join(' '); // five parts, three workers
  const r2 = await P.runProofread({ text: more, config: config(), engine: 'claude-code', selectedModel: 'x', complete: rejecting });
  assert.equal(r2.provenance.batches.length, 5);
  assert.ok(sent <= 3, 'no new parts are started after a rejection');
  assert.ok(r2.provenance.batches.some((b) => b.status === 'not sent'));

  let called = false;
  await assert.rejects(P.runProofread({ text: 'a'.repeat(P.PROOF.maxChars + 1) + ' word', config: config(), engine: 'claude-code', complete: async () => { called = true; return {}; } }), /No text was sent/);
  await assert.rejects(P.runProofread({ text: 'Hello there.', config: config(), engine: 'codex', complete: async () => { called = true; return {}; } }), /not connected/);
  assert.equal(called, false);
});

test('the spelling variant reaches the prompt; an unknown variant falls back to accepting all of them', async () => {
  P._cache.clear();
  const calls = [];
  await P.runProofread({ text: 'The colour is nice.', config: config(), engine: 'claude-code', variant: 'us', complete: modelFrom({}, calls) });
  assert.match(calls[0].prompt, /American English/);
  await P.runProofread({ text: 'The colour is fine.', config: config(), engine: 'claude-code', variant: 'klingon', complete: modelFrom({}, calls) });
  assert.match(calls[1].prompt, /never change a word from one variant to another/);
});

test('a correction far longer than its sentence is dropped before the word-by-word comparison', () => {
  const P = require('../server/checks/proofread');
  const src = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ') + '.';
  const unit = { src, start: 0, heading: false };
  const huge = { text: Array.from({ length: 100000 }, (_, i) => `other${i}`).join(' '), changes: [] };
  const t = Date.now();
  const r = P.suggestionsFor(src, unit, huge, []);
  assert.ok(Date.now() - t < 50, `${Date.now() - t} ms`);
  assert.equal(r.dropped.misaligned, 1);
  assert.deepEqual(r.suggestions, []);
  // A real correction of the same sentence still comes through.
  const fixed = P.suggestionsFor(src, unit, { text: src.replace('word7 ', 'word7, '), changes: [] }, []);
  assert.equal(fixed.suggestions.length, 1);
});
