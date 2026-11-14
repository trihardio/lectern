'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Evidence = require('../shared/evidence');
const { splitLead, renderAnswer } = require('../ui/render');
const p = { n: 1, year: 2021, abstract: 'A randomised trial of 200 call-centre workers found 13% more calls completed. Records measure objective output.' };
const f = (value, quote) => ({ value, quote });
const row = { n: 1, relevant: true, stance: 'supports', finding: 'More calls.', facts: {
  population: f('Call-centre workers', '200 call-centre workers'), measurement: f('objective', 'Records measure objective output'),
  designType: f('randomised', 'A randomised trial'), result: f('13% more calls', '13% more calls completed'),
} };

test('evidence: only known paper ids and exact abstract excerpts can support classifications', () => {
  const raw = { papers: [row, { ...row, n: 99 }, { ...row, n: 1 }, { n: 2, facts: row.facts }] };
  const cleaned = Evidence.cleanInsights(raw, [p, { n: 2, title: 'Randomised trial', abstract: '' }], { yesNo: true });
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].facts.measurement.value, 'objective');
  assert.deepEqual(cleaned[1].facts, {}, 'title-only records cannot establish facts');
  const fake = Evidence.cleanInsights({ papers: [{ ...row, facts: { measurement: f('objective', 'A fabricated quotation'), population: f('Invented', 'trial') } }] }, [p]);
  assert.deepEqual(fake[0].facts, {});
  assert.equal(fake[0].stance, 'na', 'non-binary questions do not become yes/no votes');
});

test('evidence: invalid enums and quotes borrowed from other papers are rejected', () => {
  const rows = Evidence.cleanInsights({ papers: [{ n: 1, facts: {
    measurement: f('huge effect', 'objective output'), timing: f('pandemic', 'during pandemic lockdowns'),
  } }] }, [p, { n: 2, abstract: 'This survey took place during pandemic lockdowns.' }]);
  assert.deepEqual(rows[0].facts, {});
});

test('coverage: counts deduplicated papers, supports overlapping cells, and never treats publication year as timing', () => {
  const map = Evidence.coverage([p], [row, row]);
  assert.equal(map.groups.length, 1);
  assert.deepEqual(map.groups[0].cells[0], [1]);
  assert.deepEqual(map.groups[0].cells[2], [1]);
  assert.ok(!map.columns.some((c) => c.id === 'pandemic'), '2021 publication does not establish pandemic data');
  assert.equal(map.total, 1);
});

test('coverage: off-topic readings are excluded and missing populations remain unclassified', () => {
  const map = Evidence.coverage([p, { n: 2, abstract: 'A survey of nurses describes self-rated performance.' }],
    [{ ...row, relevant: false }, { n: 2, relevant: true, facts: { measurement: f('self-report', 'self-rated performance') } }]);
  assert.equal(map.groups.length, 0);
  assert.equal(map.total, 1);
  assert.equal(map.unclassified, 1);
  assert.deepEqual(Evidence.cleanInsights(null, []), []);
});

test('answer lead: separates the opening intact and leaves heading/list-first legacy answers intact', () => {
  assert.deepEqual(splitLead('**It depends.** Gains [1], losses [2].\n\n## Disagreement\n\nDetails.'), {
    lead: '**It depends.** Gains [1], losses [2].', body: '## Disagreement\n\nDetails.',
  });
  assert.deepEqual(splitLead('Still streaming [1]'), { lead: 'Still streaming [1]', body: '' });
  assert.deepEqual(splitLead('## Old answer\n\nDetails'), { lead: '', body: '## Old answer\n\nDetails' });
});

test('citation indicators: allow only known stance names and preserve escaping', () => {
  const out = renderAnswer('A finding [1].', { paperCount: 1, citeLabel: () => '<img>', citeStance: () => 'against' });
  assert.match(out.html, /data-stance="against"/); assert.match(out.html, /&lt;img&gt;/);
  const unsafe = renderAnswer('A finding [1].', { paperCount: 1, citeLabel: () => 'Name', citeStance: () => '" onclick="bad' });
  assert.ok(!unsafe.html.includes('onclick'));
});

test('coverage: simulations and expected results stay available as papers but do not count as observed coverage', () => {
  const simulation = { n: 2, abstract: 'We simulate 500 employees to estimate expected productivity.' };
  const map = Evidence.coverage([p, simulation], [row, { n: 2, relevant: true, facts: {
    population: f('Simulated employees', 'simulate 500 employees'), evidenceStatus: f('simulation', 'We simulate 500 employees'),
    measurement: f('objective', 'expected productivity'),
  } }]);
  assert.equal(map.total, 1); assert.equal(map.excluded, 1);
  assert.equal(map.groups.length, 1); assert.equal(map.groups[0].label, 'Call-centre workers');
});

test('planner: a binary opening remains binary when the request also asks why papers disagree', async () => {
  const llm = require('../server/llm');
  const { planQueries } = require('../server/pipeline');
  const original = llm.complete;
  llm.complete = async () => ({ text: JSON.stringify({ queries: ['remote work productivity', 'telework meta analysis', 'remote output null findings'], yes_no: false }) });
  try {
    const result = await planQueries({ question: 'Does remote work improve employee productivity? Explain the disagreements.', settings: { profile: {} } });
    assert.equal(result.yesNo, true);
  } finally { llm.complete = original; }
});
