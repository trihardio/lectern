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
