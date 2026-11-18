'use strict';
// Europe PMC: life sciences and medicine (includes PubMed and a preprint collection). No key needed.
// Off by default because it adds noise for non-medical questions.

const { fetchJson } = require('../util');
const { makePaper, plainQuery, usable } = require('./common');

/**
 * Europe PMC takes Lucene-style queries (AND, OR, NOT, "phrases", FIELD:value). Its pages are behind a bot check, so
 * this was written from the live service rather than its manual: `HAS_ABSTRACT:y` and `OPEN_ACCESS:y` were checked on
 * 2026-11-18. The planner's brackets and quotes are removed and the words are searched together; a boost becomes an
 * AND clause. opts.sort is '' (relevance), 'cited' or 'date' (Europe PMC's sort_cited:y and sort_date:y).
 */
function buildUrl(query, { filters = {}, settings = {}, limit = 20, boost, sort = '', hasAbstract = true } = {}) {
  const words = plainQuery(query);
  let q = `(${words})`;
  const phrases = (boost || []).map((b) => plainQuery(b)).filter(Boolean);
  if (phrases.length) q += ` AND (${phrases.map((b) => `"${b}"`).join(' OR ')})`;
  if (hasAbstract) q += ' AND HAS_ABSTRACT:y';
  if (filters.yearFrom || filters.yearTo) q += ` AND PUB_YEAR:[${filters.yearFrom || 1900} TO ${filters.yearTo || 2100}]`;
  if (filters.oaOnly) q += ' AND OPEN_ACCESS:y';
  if (filters.noPreprints) q += ' NOT SRC:PPR';
  if (sort === 'cited') q += ' sort_cited:y';
  else if (sort === 'date') q += ' sort_date:y';
  const params = new URLSearchParams({ query: q, format: 'json', resultType: 'core', pageSize: String(Math.min(1000, limit)) });
  if (settings.email) params.set('email', settings.email);
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;
}

function parse(json) {
  const results = (json.resultList && json.resultList.result) || [];
  return results.map((r) => {
    const j = (r.journalInfo && r.journalInfo.journal) || {};
    const authors = (r.authorList && r.authorList.author) || [];
    const links = (r.fullTextUrlList && r.fullTextUrlList.fullTextUrl) || [];
    const pdf = links.find((l) => l.documentStyle === 'pdf' && /open|free/i.test(l.availability || ''));
    const landing = r.pmcid
      ? `https://europepmc.org/article/PMC/${r.pmcid}`
      : (r.source && r.id ? `https://europepmc.org/article/${r.source}/${r.id}` : '');
    const pubTypes = (r.pubTypeList && r.pubTypeList.pubType) || [];
    return makePaper({
      source: 'europepmc',
      doi: r.doi,
      title: String(r.title || '').replace(/\.$/, ''),
      authors: authors.map((a) => (a.lastName ? { family: a.lastName, given: a.firstName || a.initials || '' } : a.fullName)),
      year: r.pubYear,
      date: r.firstPublicationDate,
      venue: j.title || (r.bookOrReportDetails && r.bookOrReportDetails.publisher),
      volume: r.journalInfo && r.journalInfo.volume,
      issue: r.journalInfo && r.journalInfo.issue,
      pages: r.pageInfo,
      types: pubTypes,
      abstract: r.abstractText,
      citations: r.citedByCount,
      isOA: r.isOpenAccess === 'Y',
      pdfUrl: pdf && pdf.url,
      url: landing,
      // Source PPR is Europe PMC's preprint collection; a "Retracted Publication" tag marks the paper itself.
      preprint: r.source === 'PPR',
      retracted: pubTypes.some((t) => /^retracted publication$/i.test(t)),
      pmid: r.pmid || (r.source === 'MED' ? r.id : ''),
      pmcid: r.pmcid,
    });
  }).filter((p) => p.title);
}

async function search(query, opts = {}) {
  const papers = parse(await fetchJson(buildUrl(query, opts), { signal: opts.signal, timeout: 30000 })).filter(usable);
  const min = (opts.filters && opts.filters.minCitations) || 0;
  return min > 0 ? papers.filter((p) => (p.citations || 0) >= min) : papers;
}

module.exports = { name: 'europepmc', label: 'Europe PMC', search, parse, buildUrl, boosts: true };
