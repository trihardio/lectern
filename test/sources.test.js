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

test('OpenAlex: the key goes in a header, never in the URL; filters are pushed into the request', () => {
  const url = new URL(openalex.buildUrl('remote work', { settings, filters: { yearFrom: 2018, yearTo: 2024, oaOnly: true, minCitations: 50 } }));
  assert.equal(url.searchParams.get('api_key'), null, 'no key in the URL');
  assert.equal(url.searchParams.get('mailto'), null, 'mailto is no longer documented, so it is not sent');
  assert.deepEqual(openalex.authHeaders(settings), { authorization: 'Bearer oa-key' });
  assert.deepEqual(openalex.authHeaders({ keys: {} }), {}, 'keyless requests carry no header');
  assert.equal(url.searchParams.get('search'), 'remote work');
  assert.equal(url.searchParams.get('per_page'), '25');
  assert.equal(url.searchParams.get('rerank'), null, 'rerank is only sent when asked for');
  const f = url.searchParams.get('filter');
  assert.match(f, /is_retracted:false/);
  assert.match(f, /from_publication_date:2018-01-01/);
  assert.match(f, /to_publication_date:2024-12-31/);
  assert.match(f, /open_access\.is_oa:true/);
  assert.match(f, /cited_by_count:>49/);
  assert.match(f, /type:!erratum\|retraction\|paratext\|peer-review\|supplementary-materials\|study-registration\|dataset/, 'notices, front matter and datasets are left out');
  assert.doesNotMatch(f, /preprint/);
  assert.match(decodeURIComponent(openalex.buildUrl('q', { filters: { noPreprints: true } })), /type:!erratum[^&]*\|preprint/, 'one type filter, preprint added to it');
  const sel = url.searchParams.get('select');
  for (const field of ['study_designs', 'locations', 'ids', 'rerank_score']) assert.ok(sel.split(',').includes(field), field);
});

test('OpenAlex: search forms, rerank, boost and a repaired query', () => {
  const rr = new URL(openalex.buildUrl('sleep memory', { rerank: true, limit: 100 }));
  assert.equal(rr.searchParams.get('rerank'), 'true');
  assert.equal(rr.searchParams.get('per_page'), '100');
  assert.equal(new URL(openalex.buildUrl('q', { limit: 500 })).searchParams.get('per_page'), '100', 'at most 100 a page');
  const tak = new URL(openalex.buildUrl('sleep memory', { mode: 'title_abstract_keywords' }));
  assert.equal(tak.searchParams.get('search.title_abstract_keywords'), 'sleep memory');
  assert.equal(tak.searchParams.get('search'), null);
  const boosted = new URL(openalex.buildUrl('sleep memory', { boost: ['systematic review', 'meta-analysis'] }));
  assert.equal(boosted.searchParams.get('search'), '(sleep memory) AND ("systematic review" OR "meta-analysis")');
  // Semantic search accepts only a few filters (a date range written as publication_year), takes at most 50 and cannot be reranked.
  const sem = new URL(openalex.buildUrl('sleep memory', { mode: 'semantic', rerank: true, limit: 100, filters: { yearFrom: 2018, minCitations: 50, oaOnly: true } }));
  assert.equal(sem.searchParams.get('search.semantic'), 'sleep memory');
  assert.equal(sem.searchParams.get('per_page'), '50');
  assert.equal(sem.searchParams.get('rerank'), null);
  assert.match(sem.searchParams.get('filter'), /publication_year:2018-2100/);
  assert.doesNotMatch(sem.searchParams.get('filter'), /cited_by_count|from_publication_date/);
  // has_abstract:true is opt-in, and allowed in semantic search too.
  assert.doesNotMatch(decodeURIComponent(openalex.buildUrl('q')), /has_abstract/);
  assert.match(decodeURIComponent(openalex.buildUrl('q', { hasAbstract: true })), /has_abstract:true/);
  assert.match(decodeURIComponent(openalex.buildUrl('q', { hasAbstract: true, mode: 'semantic' })), /has_abstract:true/);
  // A wildcard, an odd quote or unpaired brackets would be a 400 from OpenAlex.
  assert.equal(openalex.cleanQuery('sleep* memory~2'), 'sleep memory 2');
  assert.equal(openalex.cleanQuery('"sleep memory'), 'sleep memory');
  assert.equal(openalex.cleanQuery('(sleep AND memory'), 'sleep AND memory');
  assert.equal(openalex.cleanQuery('sleep AND (memory OR recall)'), 'sleep AND (memory OR recall)', 'real syntax is kept');
  assert.equal(openalex.cleanQuery('AND sleep memory OR'), 'sleep memory');
});

test('OpenAlex: study designs, preprint flag, other ids and rerank score', () => {
  const [sr, pre, retracted, notice] = openalex.parse(fx.edgeOpenalex());
  assert.equal(sr.kind, 'Meta-analysis', 'the study-design tag decides, and the stronger tag wins');
  assert.equal(sr.preprint, false);
  assert.equal(sr.pmid, '39000001');
  assert.equal(sr.pmcid, 'PMC9000001');
  assert.equal(sr.arxiv, '2401.01234', 'bare id, no version');
  assert.deepEqual(sr.altDois, ['10.5555/lectern.edge.1pre'], 'a preprint DOI from a location, not the main DOI again');
  assert.equal(sr.relScore, 0.87);
  assert.equal(pre.preprint, true);
  assert.equal(pre.kind, 'Meta-analysis', 'a preprint with "meta-analysis" in the title keeps that label and is still flagged');
  assert.equal(pre.relScore, null);
  assert.equal(retracted.retracted, true);
  assert.equal(notice.kind, 'Correction');
});

test('OpenAlex: search drops correction notices; the key is sent as a header', async () => {
  mock.reset();
  const papers = await openalex.search('sleep memory', { settings });
  assert.ok(papers.length > 0);
  const call = mock.calls[0];
  assert.equal(call.headers.authorization, 'Bearer oa-key');
  assert.equal(call.params.api_key, undefined);
  assert.ok(!/oa-key/.test(call.url), 'the key is not in the URL');
  // search() filters through the same rule the fixture shows.
  const noticeOnly = openalex.parse(fx.edgeOpenalex()).filter(require('../server/sources/common').usable);
  assert.equal(noticeOnly.length, 3, 'the correction notice is dropped');
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

test('Semantic Scholar: plain query, boost as words, limit capped, other ids and preprints', () => {
  const url = new URL(s2.buildUrl('(sleep OR memory) AND "recall*"', { limit: 500, boost: ['systematic review'], filters: { minCitations: 10, oaOnly: true } }));
  assert.equal(url.searchParams.get('query'), 'sleep memory recall systematic review', 'no operators, quotes or wildcards');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('minCitationCount'), '10');
  assert.match(url.search, /&openAccessPdf$/);
  const [arxiv, journal, biorxiv] = s2.parse(fx.edgeSemanticscholar());
  assert.equal(arxiv.preprint, true, 'arXiv id and no journal');
  assert.equal(arxiv.arxiv, '2101.00001');
  assert.equal(arxiv.abstract, '');
  assert.equal(journal.preprint, false, 'a published paper that also sits on arXiv is not a preprint');
  assert.equal(journal.pmid, '39000002');
  assert.equal(journal.pmcid, 'PMC9000002');
  assert.equal(journal.arxiv, '2401.99999');
  assert.equal(journal.doi, '10.5555/lectern.edge.s2');
  assert.equal(biorxiv.preprint, true, 'a dated bioRxiv DOI');
});

test('Crossref: strips JATS markup and reads dates', () => {
  const p = crossref.parse(fx.crossref())[0];
  assert.equal(p.year, 2020);
  assert.ok(!/</.test(p.abstract));
  assert.ok(p.abstract.startsWith('Sample abstract.') || p.abstract.startsWith('Fixed-effects'));
  assert.deepEqual(p.authors[0], { given: 'Ingrid', family: 'Halvorsen' });
});

test('Crossref: abstracts only, one query field, boost as words, relations, retractions and notices', () => {
  const url = new URL(crossref.buildUrl('sleep (memory)', { settings, boost: ['meta-analysis'], limit: 30, filters: { yearFrom: 2019 } }));
  assert.equal(url.searchParams.get('query'), 'sleep memory meta-analysis');
  assert.equal(new URL(crossref.buildUrl('sleep memory', { field: 'bibliographic' })).searchParams.get('query.bibliographic'), 'sleep memory');
  assert.equal(url.searchParams.get('rows'), '30');
  assert.match(url.searchParams.get('filter'), /has-abstract:true/);
  assert.match(url.searchParams.get('filter'), /from-pub-date:2019-01-01/);
  assert.equal(url.searchParams.get('mailto'), 'me@example.org');
  assert.match(url.searchParams.get('select'), /updated-by,update-to,relation/);
  assert.doesNotMatch(crossref.buildUrl('q', { hasAbstract: false }), /has-abstract/);
  const [pre, pub, retracted, notice, corr] = crossref.parse(fx.edgeCrossref());
  assert.equal(pre.preprint, true);
  assert.deepEqual(pre.preprintOf, ['10.5555/lectern.edge.c1pub']);
  assert.equal(pre.abstract, 'Introduction Clinical education is a cornerstone (P < 0.05).', 'double-escaped markup is removed, spaces kept');
  assert.deepEqual(pub.hasPreprint, ['10.5555/lectern.edge.c1']);
  assert.equal(pub.abstract, 'Background. Feedback matters. Methods. We ran H2O tests where x<y and a>b.');
  assert.equal(retracted.retracted, true);
  assert.equal(notice.kind, 'Correction', 'a record that updates another DOI as a retraction is a notice');
  assert.equal(corr.kind, 'Correction', '"Correction to: ..." is a notice by its title');
  assert.equal(crossref.parse(fx.edgeCrossref()).filter(require('../server/sources/common').usable).length, 3);
});

test('Europe PMC: abstract filter, boost, sort, preprints, retraction and ids', () => {
  const url = new URL(epmc.buildUrl('sleep (memory)', { settings, boost: ['systematic review', 'meta-analysis'], limit: 50, sort: 'cited', filters: { yearFrom: 2019, oaOnly: true, noPreprints: true } }));
  assert.equal(url.searchParams.get('pageSize'), '50');
  assert.equal(url.searchParams.get('resultType'), 'core');
  assert.equal(url.searchParams.get('query'), '(sleep memory) AND ("systematic review" OR "meta-analysis") AND HAS_ABSTRACT:y AND PUB_YEAR:[2019 TO 2100] AND OPEN_ACCESS:y NOT SRC:PPR sort_cited:y');
  assert.doesNotMatch(epmc.buildUrl('q', { hasAbstract: false }), /HAS_ABSTRACT/);
  const [retracted, pre, notice] = epmc.parse(fx.edgeEuropepmc());
  assert.equal(retracted.retracted, true);
  assert.equal(retracted.pmid, '39000003');
  assert.equal(retracted.pmcid, 'PMC9000003');
  assert.equal(retracted.abstract, 'Background. Sample text. Methods. More text.');
  assert.equal(pre.preprint, true);
  assert.equal(notice.kind, 'Correction');
});

test('abstract cleaning keeps a bare "<" and entities, and every adapter takes a boost', () => {
  const { abstractText, withBoost, plainQuery, isPreprintDoi } = require('../server/sources/common');
  assert.equal(abstractText('Effects were small (p < .05) and x<y; H&amp;M &#x2009;said &quot;yes&quot;.'), 'Effects were small (p < .05) and x<y; H&M said "yes".');
  assert.equal(abstractText('Abstract: We tested it.'), 'We tested it.');
  assert.equal(abstractText(['<p>One</p>']), 'One');
  assert.equal(withBoost('q', [], true), 'q');
  assert.equal(plainQuery('a AND b'), 'a b');
  for (const src of [openalex, s2, crossref, epmc]) assert.equal(src.boosts, true, `${src.name} exports boosts`);
  assert.equal(openalex.semantic, true, 'OpenAlex says it can run a semantic search (mode: \'semantic\')');
  assert.ok(!s2.semantic && !crossref.semantic && !epmc.semantic);
  assert.equal(isPreprintDoi('10.1101/2023.01.02.523456'), true);
  assert.equal(isPreprintDoi('10.64898/2026.01.02.123'), true);
  assert.equal(isPreprintDoi('10.1101/cshperspect.a021568'), false, '10.1101 is shared with journals');
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
