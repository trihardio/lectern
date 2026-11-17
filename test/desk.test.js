'use strict';
// The Writing desk's window code that runs without a page: the one server-sent-event reader every tool uses
// (ui/checks.js), the edit arithmetic that keeps proofreading marks on their words (ui/proofread.js), and the answer
// PDF's abstracts and links (ui/answerpdf.js). The files are browser scripts, so each is run in a small sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Cite = require('../shared/cite');

// Values made inside a sandbox have the sandbox's own Object and Array, so compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

function load(file) {
  const window = {};
  const sandbox = { window, console: { error() {}, log() {} }, TextDecoder, TextEncoder, ReadableStream, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', file), 'utf8'), sandbox, { filename: file });
  return window;
}

/** A response whose body is these chunks, and a flag that says whether the reader cancelled it. */
function stream(chunks) {
  const enc = new TextEncoder();
  const out = { cancelled: false };
  let i = 0;
  out.res = {
    body: new ReadableStream({
      pull(c) { if (i < chunks.length) c.enqueue(typeof chunks[i] === 'string' ? enc.encode(chunks[i++]) : chunks[i++]); else c.close(); },
      cancel() { out.cancelled = true; },
    }),
  };
  return out;
}

test('desk SSE reader: split chunks, CRLF, data with or without a space, several data lines; bad JSON is skipped', async () => {
  const { LecternSSE } = load('checks.js');
  const euro = new TextEncoder().encode('event: step\ndata: {"detail":"10 €"}\n\n');
  const cut = euro.indexOf(0xe2) + 1; // inside the three bytes of "€"
  const s = stream([
    'event: part\ndata: {"n":1}\n\nevent: part\nda', 'ta: {"n":2}\n\n',
    euro.slice(0, cut), euro.slice(cut),
    'event: notice\r\ndata:{"text":"crlf"}\r\n\r\n',
    'event: result\ndata: {"a":\ndata: 1}\n\n',
    'event: part\ndata: {not json}\n\n',
    'event: part\ndata: {"n":3}\n\n',
    'event: part\ndata: {"n":4}', // no blank line before the end: not an event
  ]);
  const seen = [];
  await LecternSSE.read(s.res, (event, data) => seen.push([event, data]));
  assert.deepEqual(plain(seen), [['part', { n: 1 }], ['part', { n: 2 }], ['step', { detail: '10 €' }], ['notice', { text: 'crlf' }], ['result', { a: 1 }], ['part', { n: 3 }]]);
  assert.equal(s.cancelled, false, 'a stream that ended by itself has nothing to cancel');
});

test('desk SSE reader: an error thrown by the handler ends the read, cancels the stream and is passed on', async () => {
  const { LecternSSE } = load('checks.js');
  const s = stream(['event: part\ndata: {"n":1}\n\n', 'event: error\ndata: {"message":"The model is not connected."}\n\n', 'event: part\ndata: {"n":2}\n\n']);
  const seen = [];
  await assert.rejects(LecternSSE.read(s.res, (event, data) => { if (event === 'error') throw new Error(data.message); seen.push(data.n); }), /not connected/);
  assert.deepEqual(plain(seen), [1]);
  assert.equal(s.cancelled, true, 'the server is told nobody reads the rest');
});

test('proofreader: one edit moves every mark after it, drops the marks it touched, keeps the ones before it', () => {
  const { LecternProofread: P } = load('proofread.js');
  const before = 'We saw the the results. They recieve mail.';
  const after = 'Then: We saw the the results. They recieve mail.';
  const e = P.editOf(before, after);
  assert.deepEqual(plain(e), { p: 0, oldEnd: 0, delta: 6 });
  const marks = [
    { start: 10, end: 14, from: ' the' },
    { start: 29, end: 36, from: 'recieve' },
  ];
  assert.equal(before.slice(29, 36), 'recieve');
  assert.deepEqual(plain(P.move(marks, e, after).map((s) => [s.start, after.slice(s.start, s.end)])), [[16, ' the'], [35, 'recieve']]);
  // typing inside a marked word drops that mark only
  const typed = 'We saw the the results. They recieved mail.';
  const e2 = P.editOf(before, typed);
  assert.deepEqual(plain(P.move(marks, e2, typed).map((s) => s.from)), [' the', 'recieve'], 'an insertion right after a word leaves the word as it was');
  const fixed = 'We saw the the results. They receive mail.';
  assert.deepEqual(plain(P.move(marks, P.editOf(before, fixed), fixed).map((s) => s.from)), [' the']);
  // a range that ends where the edit starts, and one that starts where it ends, are untouched
  assert.deepEqual(plain(P.through({ p: 5, oldEnd: 8, delta: -1 }, 0, 5)), { start: 0, end: 5 });
  assert.deepEqual(plain(P.through({ p: 5, oldEnd: 8, delta: -1 }, 8, 10)), { start: 7, end: 9 });
  assert.equal(P.through({ p: 5, oldEnd: 8, delta: -1 }, 4, 6), null);
  assert.deepEqual(plain(P.through(null, 3, 4)), { start: 3, end: 4 });
});

test('proofreader: reading only the changed paragraphs again finds exactly what a check of the whole text finds', () => {
  const { LecternProofread: P } = load('proofread.js');
  const Rules = require('../shared/proofrules');
  const paragraphs = [
    'Remote work changes how teams coordinate their daily tasks. The the evidence suggests a small effect.',
    'Methods',
    'Several firms reported that employees recieve fewer interruptions.  Managers  who trusted staff saw gains.',
    'A meta-analysis found a pooled correlation of r = .09 (Smith et al., 2020). i think it could of been larger.',
    'The occurance of burnout was higher,among workers.They lacked a separate space "the the quoted words".',
    'a Ontario study, a apple, an hour, an MBA, part a of the survey.\nA hard-wrapped line\ncould of continued here.',
  ];
  let text = paragraphs.join('\n\n');
  // a small seeded generator, so a failure can be repeated
  let seed = 20261117;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pieces = [' the', 'the ', '  ', 'a apple ', 'i think ', 'could of ', '.\n\n', '\n', 'recieve ', ',', '. ', 'Moreover, ', '\n\n  \n', 'x'];
  const key = (list) => plain(list.map((f) => [f.start, f.end, f.rule, f.to]));
  let found = Rules.check(text);
  let dirty = null;
  for (let round = 0; round < 1500; round++) {
    // one to three edits before the checks read the text again, as when several keys arrive in one frame
    for (let k = 1 + rnd(3); k > 0; k--) {
      const at = rnd(text.length + 1);
      const cut = rnd(4) === 0 ? Math.min(text.length - at, 1 + rnd(12)) : 0;
      // edits mostly cut and type small pieces; a text worn down below 400 characters gets a paragraph back
      const next = text.length < 400 ? `${text}\n\n${paragraphs[rnd(paragraphs.length)]}` : text.slice(0, at) + (rnd(3) === 0 ? '' : pieces[rnd(pieces.length)]) + text.slice(at + cut);
      if (next === text) continue;
      const e = P.editOf(text, next);
      found = P.move(found, e, next);
      dirty = P.joinDirty(dirty, e);
      text = next;
    }
    if (!dirty) continue;
    const span = P.recheckSpan(text, dirty[0], dirty[1]);
    found = P.recheck(Rules, text, found, span);
    dirty = null;
    assert.deepEqual(key(found), key(Rules.check(text)), `round ${round}: ${JSON.stringify(text)}`);
  }
});

test('answer PDF: abstract links come from the paper record (DOI first), and a missing abstract has one wording', () => {
  const { LecternAnswerPdf } = load('answerpdf.js');
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false) });
  const papers = [
    { n: 1, title: 'With a DOI', doi: '10.5555/example.42', url: 'https://example.org/record', abstract: 'Text of the abstract.', authors: [] },
    { n: 2, title: 'Only a link', url: 'https://example.org/paper-2', tldr: 'A short summary.', authors: [] },
    { n: 3, title: 'Nothing', authors: [] },
  ];
  const sheet = LecternAnswerPdf.build({
    turn: { question: 'Q?', answer: 'A.', papers, createdAt: '2026-11-17T10:00:00Z' },
    deps: {
      h, Cite, Render: { splitFollowUps: () => ({ followUps: [] }) }, state: { app: { settings: { citeStyle: 'apa' } } },
      answerParts: () => ({ hasLead: false, lead: { html: '' }, body: { html: '' } }), insightFor: () => null, citeLabels: () => new Map(),
      prettyModel: (m) => m, engineInfo: () => null,
    },
  });
  const all = [];
  const walk = (n) => { if (n && typeof n === 'object') { all.push(n); n.kids.forEach(walk); } };
  walk(sheet);
  const text = (n) => (typeof n === 'string' ? n : n.kids.map(text).join(''));
  const abstracts = all.filter((n) => n.attrs.class === 'apdf-abstract');
  const link = (a) => { const p = a.kids.find((k) => k.attrs && k.attrs.class === 'apdf-link'); return p ? [p.kids[0].attrs.href, text(p.kids[0])] : null; };
  assert.deepEqual(plain(link(abstracts[0])), [Cite.doiUrl(papers[0]), Cite.doiUrl(papers[0])]);
  assert.match(link(abstracts[0])[0], /^https:\/\/doi\.org\/10\.5555/);
  assert.deepEqual(plain(link(abstracts[1])), ['https://example.org/paper-2', 'https://example.org/paper-2']);
  assert.equal(link(abstracts[2]), null);
  assert.match(text(abstracts[1]), /The databases have no abstract for this paper\. Short summary: A short summary\./);
  assert.match(text(abstracts[2]), /The databases have no abstract for this paper\./);
  assert.ok(!/No abstract in the database/.test(all.map(text).join(' ')));
});
