'use strict';
// Europe PMC: life sciences and medicine (includes PubMed). No key needed.
// Off by default because it adds noise for non-medical questions.

const { fetchJson } = require('../util');
const { makePaper } = require('./common');

function buildUrl(query, { filters = {}, settings = {}, limit = 20 }) {
  let q = `(${query.replace(/[()"]/g, ' ')})`;
  if (filters.yearFrom || filters.yearTo) q += ` AND PUB_YEAR:[${filters.yearFrom || 1900} TO ${filters.yearTo || 2100}]`;
  if (filters.oaOnly) q += ' AND OPEN_ACCESS:y';
  const params = new URLSearchParams({ query: q, format: 'json', resultType: 'core', pageSize: String(limit) });
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
      types: (r.pubTypeList && r.pubTypeList.pubType) || [],
      abstract: r.abstractText,
      citations: r.citedByCount,
      isOA: r.isOpenAccess === 'Y',
      pdfUrl: pdf && pdf.url,
      url: landing,
    });
  }).filter((p) => p.title);
}

async function search(query, opts = {}) {
  const papers = parse(await fetchJson(buildUrl(query, opts), { signal: opts.signal, timeout: 20000 }));
  const min = (opts.filters && opts.filters.minCitations) || 0;
  return min > 0 ? papers.filter((p) => (p.citations || 0) >= min) : papers;
}

module.exports = { name: 'europepmc', label: 'Europe PMC', search, parse, buildUrl };
