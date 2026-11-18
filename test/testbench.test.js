'use strict';
// The Writing desk's test bench (shared/testbench.js, used by ui/checks.js): labels, counting with intervals, the built-in
// examples and their sources, and that the window loads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TB = require('../shared/testbench');

test('test bench labels: three kinds of AI text and one human; a flag is only wrong on a human text', () => {
  assert.deepEqual(TB.LABELS.map((l) => l.value), ['ai', 'ai-human', 'rewritten', 'human']);
  assert.deepEqual(TB.LABELS.filter((l) => !l.isAi).map((l) => l.value), ['human']);
  assert.equal(TB.labelOf('nope'), null);
});

test('test bench counts: caught, wrongly flagged and "no score" kept apart, with Wilson 95% intervals', () => {
  assert.deepEqual(TB.wilson(0, 10), [0, 28]);
  assert.deepEqual(TB.wilson(10, 18), [34, 75]);
  assert.equal(TB.wilson(0, 0), null);
  const r = (score, flagged, style) => ({ score, flagged, style: style == null ? null : { probability: 0.6, flagged: style } });
  const items = [
    { label: 'ai', result: r(70, true, true) },
    { label: 'ai', result: r(30, false, false) },
    { label: 'ai-human', result: r(20, false, true) },
    { label: 'rewritten', result: r(null, false, null) }, // too short or the review failed: neither caught nor missed
    { label: 'human', result: r(60, true, false) },
    { label: 'human', result: r(10, false, false) },
    { label: 'human', result: null }, // not run
  ];
  const s = TB.summarize(items);
  const row = (v) => s.rows.find((x) => x.value === v);
  assert.deepEqual([row('ai').flagged, row('ai').n, row('ai').styleFlagged], [1, 2, 1]);
  assert.deepEqual([row('ai-human').flagged, row('ai-human').n, row('ai-human').styleFlagged], [0, 1, 1]);
  assert.deepEqual([row('rewritten').n, row('rewritten').noScore], [0, 1]);
  assert.deepEqual([row('human').flagged, row('human').n], [1, 2]);
  assert.deepEqual([s.ai.flagged, s.ai.n], [1, 3]);
  assert.deepEqual([s.human.flagged, s.human.n], [1, 2]);
});

test('test bench examples: labelled, 80-400 words, a stated source, Wikipedia ones attributed (CC BY-SA, revision link)', () => {
  assert.ok(TB.EXAMPLES.length >= 8);
  const ids = new Set();
  for (const e of TB.EXAMPLES) {
    assert.ok(!ids.has(e.id), e.id); ids.add(e.id);
    assert.ok(TB.labelOf(e.label), e.id);
    const words = e.text.trim().split(/\s+/).length;
    assert.equal(words, e.words, e.id);
    assert.ok(words >= 80 && words <= 400, e.id);
    assert.ok(e.source && e.source.length > 20, e.id);
    if (e.label === 'human') {
      assert.match(e.source, /^Wikipedia, ".+", introduction of revision \d+ \(before 30 November 2022\)\. CC BY-SA 4\.0\. https:\/\/en\.wikipedia\.org\/w\/index\.php\?oldid=\d+$/);
    } else {
      assert.match(e.source, /Claude (Haiku|Sonnet|Opus) 5\.5|a Claude model/);
    }
    // the owner's own test topics are never examples
    assert.doesNotMatch(e.text, /Star Wars|Jabba|Jedi|Crocs|Beast Boy|Star Trek/);
  }
  for (const v of ['ai', 'ai-human', 'rewritten', 'human']) assert.ok(TB.EXAMPLES.filter((e) => e.label === v).length >= 2, v);
});

test('test bench: the server serves the module and the window loads it before the Writing desk', () => {
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8'), /'\/testbench\.js': \['shared\/testbench\.js'/);
  const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/testbench.js') > 0 && html.indexOf('/testbench.js') < html.indexOf('/checks.js'));
  const ui = fs.readFileSync(path.join(root, 'ui', 'checks.js'), 'utf8');
  assert.match(ui, /bench: \{\s*label: 'Test bench'/);
  assert.match(ui, /fetch\('\/api\/checks\/ai'/); // the bench runs the same AI writing check, nothing else
});
