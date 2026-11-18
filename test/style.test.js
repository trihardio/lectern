'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/checks/style');

const SAMPLE = 'The history of the bicycle is a story of steady improvement. Early designs, such as the draisine, had no pedals and were pushed along the ground. Later inventors added cranks, chains and air-filled tyres, making the machine faster and more comfortable. Today, bicycles remain one of the most efficient forms of transport ever created.\n\nCycling is more than a way to travel. It supports health, reduces pollution and connects communities. Ultimately, the bicycle reminds us that simple ideas can change the world.';

test('style features: deterministic, finite, one value per named feature', () => {
  const a = S.vector(SAMPLE, S.ALL_NAMES), b = S.vector(SAMPLE, S.ALL_NAMES);
  assert.deepEqual(a, b);
  assert.equal(a.length, S.ALL_NAMES.length);
  assert.ok(a.every(Number.isFinite));
  assert.deepEqual(S.features(SAMPLE), S.NAMES.map((n) => S.featureMap(SAMPLE)[n]));
  const map = S.featureMap(SAMPLE);
  assert.equal(map.threeRate > 0, true, 'a list of three is counted');
  assert.equal(map.superlativeRate > 0, true, '"one of the most" is counted');
  assert.equal(map.closerSum >= 1, true, 'the closing sentence that sums up is counted');
});

test('style model version 4: two models (older generators, current Claude), each naming only features the code computes', () => {
  assert.equal(S.MODEL.version, 4);
  assert.equal(S.MODEL.kind, 'either');
  assert.equal(S.MODEL.threshold, 0.5);
  assert.deepEqual(S.MODEL.parts.map((m) => m.name), ['v3', 'v4-core']);
  for (const m of S.MODEL.parts) {
    assert.ok(m.names.every((n) => S.ALL_NAMES.includes(n)), m.name);
    assert.equal(m.w.length, m.names.length);
    assert.equal(m.mu.length, m.names.length);
    assert.ok(m.cut > 0 && m.cut < 1);
    // the AI-word lists stay in both models (deviation 7)
    for (const n of ['strongLexRate', 'weakLexRate', 'phraseRate']) assert.ok(m.names.includes(n), `${m.name} ${n}`);
  }
  // the current-text model uses no paragraph-shape feature (it only reflects file format) and no entity or vocabulary-size
  // feature (they push learners' essays towards "AI")
  const core = S.MODEL.parts[1];
  assert.deepEqual(core.names.filter((n) => /^para|^lastParaSum$|^ent|^properRate$|^mattr$|^hapaxRate$|^wordLenMean$/.test(n)), []);
  assert.equal(S.MODEL.tested.split, 'dev');
});

test('style reading: either model at its line flags; the shown score is the higher lifted reading, 0.5 at the line', () => {
  const r = S.styleReading(SAMPLE);
  assert.ok(r.probability >= 0 && r.probability <= 1);
  assert.equal(r.probability, 0.457);
  assert.equal(r.flagged, r.parts.some((q) => q.flagged));
  assert.equal(r.flagged, r.probability >= 0.5);
  assert.deepEqual(S.styleReading(SAMPLE), r);
  assert.equal(S.styleReading('Too short.'), null);
  // the lift keeps order and puts each model's own line at 0.5
  assert.equal(S.lift(0.94, 0.94), 0.5);
  assert.equal(S.lift(0, 0.77), 0);
  assert.equal(S.lift(1, 0.77), 1);
  assert.ok(S.lift(0.6, 0.77) < S.lift(0.7, 0.77));
});

test('style model: version 3 weights still score through the same code', () => {
  const v3 = { names: S.NAMES, mu: S.NAMES.map(() => 0), sd: S.NAMES.map(() => 1), w: S.NAMES.map(() => 0), b: 0 };
  assert.equal(S.score(v3, S.transform(S.features(SAMPLE))), 0.5);
});
