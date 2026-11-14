'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./mock-fetch');
const fx = require('./fixtures');

const openalex = require('../server/sources/openalex');
const s2 = require('../server/sources/semanticscholar');
const crossref = require('../server/sources/crossref');
const epmc = require('../server/sources/europepmc');
const { searchAll, mergeAndRank } = require('../server/sources');
const { parseName, detectKind } = require('../server/sources/common');

const settings = {
  sources: { openalex: true, semanticscholar: true, crossref: true, europepmc: true },
  keys: { openalex: 'oa-key', semanticscholar: 's2-key' }, email: 'me@example.org',
};

test('OpenAlex: rebuilds abstracts and maps fields', () => {
  const papers = openalex.parse(fx.openalex());
  const p = papers.find((x) => x.doi === '10.5555/lectern.sample.1');
  assert.ok(p.abstract.startsWith('Sample abstract. We synthesise 61 field studies'), 'abstract rebuilt in word order');
  assert.equal(p.authors[2].family, 'van der Molen');
  assert.equal(p.authors[2].given, 'Lena');
  assert.equal(p.kind, 'Meta-analysis');
  assert.equal(p.pages, '401-436');
  assert.equal(p.isOA, true);
  assert.equal(p.pdfUrl, 'https://example.org/paper/1.pdf');
});

test('OpenAlex: request carries key, email and filters', () => {
  const url = new URL(openalex.buildUrl('remote work', { settings, filters: { yearFrom: 2018, yearTo: 2024, oaOnly: true, minCitations: 50 } }));
  assert.equal(url.searchParams.get('api_key'), 'oa-key');
  assert.equal(url.searchParams.get('mailto'), 'me@example.org');
  const f = url.searchParams.get('filter');
  assert.match(f, /from_publication_date:2018-01-01/);
  assert.match(f, /to_publication_date:2024-12-31/);
  assert.match(f, /open_access\.is_oa:true/);
  assert.match(f, /cited_by_count:>49/);
});

test('Semantic Scholar: maps fields, year range and key header', async () => {
  mock.reset();
  const papers = await s2.search('remote work', { settings, filters: { yearFrom: 2015 } });
  assert.equal(papers[0].doi, '10.5555/lectern.sample.2', 'DOI lower-cased');
  assert.equal(papers[0].tldr, 'Sample one-line summary of record 2.');
  assert.equal(papers[1].kind, 'Meta-analysis');
  const call = mock.calls[0];
  assert.equal(call.params.year, '2015-');
  assert.equal(call.headers['x-api-key'], 's2-key');
});

test('Crossref: strips JATS markup and reads dates', () => {
  const p = crossref.parse(fx.crossref())[0];
  assert.equal(p.year, 2020);
  assert.ok(!/</.test(p.abstract));
  assert.ok(p.abstract.startsWith('Sample abstract.') || p.abstract.startsWith('Fixed-effects'));
  assert.deepEqual(p.authors[0], { given: 'Ingrid', family: 'Halvorsen' });
});

test('Europe PMC: maps fields and study type', () => {
  const p = epmc.parse(fx.europepmc())[0];
  assert.equal(p.kind, 'Systematic review');
  assert.equal(p.isOA, true);
  assert.equal(p.title.endsWith('.'), false);
});

test('names: particles and "Family, Given" forms', () => {
  assert.deepEqual(parseName('Maria de la Cruz'), { given: 'Maria', family: 'de la Cruz' });
  assert.deepEqual(parseName('Okafor, Daniel'), { family: 'Okafor', given: 'Daniel' });
  assert.deepEqual(parseName('Plato'), { given: '', family: 'Plato' });
  assert.equal(detectKind('A randomized controlled trial of X', ['journal-article']), 'Randomised trial');
  assert.equal(detectKind('Plain title', ['posted-content']), 'Preprint');
});

test('merge: de-duplicates across databases and keeps the richest record', async () => {
  mock.reset();
  const reports = [];
  const lists = await searchAll({ queries: ['q one', 'q two'], settings, onSource: (s) => reports.push(s) });
  assert.equal(reports.length, 4);
  assert.ok(reports.every((r) => !r.error));
  const papers = mergeAndRank(lists, { max: 30 });

  const dois = papers.map((p) => p.doi).filter(Boolean);
  assert.equal(new Set(dois).size, dois.length, 'no duplicate DOIs');
  assert.equal(papers.length, 10, 'ten distinct sample records');

  const p2 = papers.find((p) => p.doi === '10.5555/lectern.sample.2');
  assert.deepEqual(p2.sources.sort(), ['crossref', 'openalex', 'semanticscholar']);
  assert.equal(p2.citations, 2945, 'highest citation count wins');
  assert.ok(p2.tldr && p2.abstract, 'fields merged from different sources');

  // Record 7 has no DOI in Semantic Scholar; it must merge with Crossref's copy by title.
  const sevens = papers.filter((p) => /managerial monitoring/i.test(p.title));
  assert.equal(sevens.length, 1);
  assert.equal(sevens[0].doi, '10.5555/lectern.sample.7');

  assert.deepEqual(papers.map((p) => p.n), papers.map((_, i) => i + 1), 'numbered in rank order');
  const noAbstract = papers.find((p) => /conceptual framework/.test(p.title));
  assert.ok(noAbstract.n > 5, 'a record with no abstract ranks low');
});

test('merge: filters apply to the merged list', async () => {
  mock.reset();
  const lists = await searchAll({ queries: ['q'], settings });
  assert.ok(mergeAndRank(lists, { filters: { yearFrom: 2022 }, max: 30 }).every((p) => p.year >= 2022));
  assert.ok(mergeAndRank(lists, { filters: { oaOnly: true }, max: 30 }).every((p) => p.isOA));
  assert.ok(mergeAndRank(lists, { filters: { minCitations: 300 }, max: 30 }).every((p) => p.citations >= 300));
  const reviews = mergeAndRank(lists, { filters: { reviewsOnly: true }, max: 30 });
  assert.ok(reviews.length >= 2 && reviews.every((p) => /review|meta/i.test(p.kind)));
  assert.equal(mergeAndRank(lists, { max: 4 }).length, 4);
});

test('a failing database is reported, not fatal', async () => {
  mock.reset();
  mock.state.fail['api.openalex.org'] = 403;
  mock.state.fail['api.semanticscholar.org'] = 429;
  const reports = [];
  const noKeys = { ...settings, keys: {} };
  const lists = await searchAll({ queries: ['q one', 'q two'], settings: noKeys, onSource: (s) => reports.push(s) });
  const oa = reports.find((r) => r.name === 'openalex');
  assert.equal(oa.needsKey, true);
  assert.match(oa.error, /free API key/);
  assert.match(reports.find((r) => r.name === 'semanticscholar').error, /busy/);
  assert.ok(mergeAndRank(lists, { max: 30 }).length >= 5, 'Crossref and Europe PMC still answer');
  assert.equal(mock.calls.filter((c) => c.host === 'api.openalex.org').length, 1, 'keyless OpenAlex is asked only once');
  mock.reset();
});
