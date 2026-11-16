'use strict';
// The instant proofreading rules (shared/proofrules.js) and the proofread API route. No real model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../shared/proofrules');
const M = require('../shared/misspellings');
const P = require('../server/checks/proofread');
const { createApp } = require('../server');

const fixes = (text) => R.check(text).map((s) => [text.slice(s.start, s.end), s.to, s.rule]);

test('rules find what they are for, with offsets into the text as given', () => {
  assert.deepEqual(fixes('She went to to the shop.'), [[' to', '', 'repeat']]);
  assert.deepEqual(fixes('He ate a apple and an banana.'), [['a', 'an', 'a-an'], ['an', 'a', 'a-an']]);
  assert.deepEqual(fixes('A orange.'), [['A', 'An', 'a-an']]);
  assert.deepEqual(fixes('I could of gone.'), [['of', 'have', 'modal-of']]);
  assert.deepEqual(fixes('Two  spaces here.'), [['  ', ' ', 'space-double']]);
  assert.deepEqual(fixes('Really , it is.'), [[' ', '', 'space-before']]);
  assert.deepEqual(fixes('apples,oranges and pears.'), [[',', ', ', 'space-after']]);
  assert.deepEqual(fixes('It ended.They left.'), [['.', '. ', 'space-after']]);
  assert.deepEqual(fixes('Wait,, what;; no.'), [[',,', ',', 'double-punct'], [';;', ';', 'double-punct']]);
  assert.deepEqual(fixes('It rained. the end.'), [['t', 'T', 'cap-start']]);
  assert.deepEqual(fixes('Yesterday i think i saw it.'), [['i', 'I', 'cap-i'], ['i', 'I', 'cap-i']]);
  assert.deepEqual(fixes("Then i'm done."), [['i', 'I', 'cap-i']]);
  assert.deepEqual(fixes('We recieved teh form.'), [['recieved', 'received', 'misspelling'], ['teh', 'the', 'misspelling']]);
  assert.deepEqual(fixes('Teh end.'), [['Teh', 'The', 'misspelling']]);
  const text = 'Line one.\n\nWe went to to town.';
  const [s] = R.check(text);
  assert.equal(text.slice(s.start, s.end), ' to');
  assert.equal(P.applySuggestions(text, R.check(text)), 'Line one.\n\nWe went to town.');
});

test('rules leave correct English alone (every exception is tested)', () => {
  const fine = [
    'He said that that was fine.', 'We had had enough.', 'They went to Bora Bora.', 'What it is is unclear.',
    'An hour later, an honest man met an MBA student and a European in May of 2020.', 'It was a one-off and a university.',
    'Take vitamin a daily? Option a or b. Part a is done.', 'An x-ray, an s-curve, an mRNA vaccine, an 18-year-old.',
    'You should of course check. The will of the people. The might of the army.',
    '"Really?" she asked. Smith et al. found it. U.S. and others agreed. See p. 12 and e.g. the table.',
    'Wait... and then. It was 3.14 or 1,000 or 10:30.', 'Node.js and app.js files. Visit www.example.com or https://example.org/teh-page.',
    'He wrote "i recieve teh mail" in the letter.', 'Cite (Smith, 2020) and [3]. Email teh@example.org.',
    'It cost more than expected .Here', 'iPhone sales rose. eBay too.', 'The years 2019 and 2020.',
    'The sample was small (n = 40). This is fine.', 'Mr. Smith and Dr. Jones met at 10 a.m. on Monday.',
    'Kit Holliday sang.', 'It came to me ..flow painting!',
  ];
  for (const s of fine) assert.deepEqual(fixes(s), [], s);
});

test('the misspelling list is the filtered Wikipedia list: no real words, one correction each', () => {
  assert.equal(M.REVISION, 1199637275);
  const lines = M.LIST.split('\n');
  assert.equal(lines.length, M.COUNT);
  assert.ok(M.COUNT > 3900, `${M.COUNT} entries`);
  for (const l of lines) {
    const [miss, fix] = l.split('->');
    assert.ok(miss && fix && !fix.includes(','), l);
    assert.notEqual(miss.toLowerCase(), fix.toLowerCase(), l);
  }
  const words = new Set(fs.existsSync('/usr/share/dict/words') ? fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').map((w) => w.toLowerCase()) : []);
  if (words.size) for (const l of lines) assert.ok(!words.has(l.split('->')[0].toLowerCase()), `${l} is a dictionary word`);
});

test('API: POST /api/checks/proofread streams parts and a result from the fake model; offsets match the text sent', async () => {
  P._cache.clear();
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-proof-api-')) });
  app.config.update({ bins: { claude: path.join(__dirname, 'fakes', 'claude'), codex: '/nonexistent/codex' } });
  const base = await app.listen(0);
  try {
    const text = 'She have finished her homeworks.\n\nWhen the samples arrived we stored them. The results was clear.';
    const response = await fetch(base + 'api/checks/proofread', { method: 'POST', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify({ text, engine: 'claude-code', model: 'claude-opus-5-5', variant: 'uk' }) });
    const stream = await response.text();
    const result = /event: result\ndata: (.+)/.exec(stream);
    assert.ok(result, stream);
    assert.match(stream, /event: part/);
    const r = JSON.parse(result[1]);
    assert.equal(r.variant, 'uk');
    assert.deepEqual(r.suggestions.map((s) => [text.slice(s.start, s.end), s.to]), [['have', 'has'], ['homeworks', 'homework'], ['arrived', 'arrived,'], ['was', 'were']]);
    assert.equal(P.applySuggestions(text, r.suggestions), 'She has finished her homework.\n\nWhen the samples arrived, we stored them. The results were clear.');
    const page = await (await fetch(base, { headers: { 'x-lectern-token': app.token } })).text();
    for (const f of ['/proofread.js', '/proofrules.js', '/misspellings.js', '/proofread.css']) assert.ok(page.includes(f), f);
    for (const f of ['proofread.js', 'proofrules.js', 'misspellings.js', 'proofread.css']) assert.equal((await fetch(base + f)).status, 200, f);
  } finally {
    await app.close();
  }
});
