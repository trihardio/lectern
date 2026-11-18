'use strict';
// Crossref: the DOI registry itself. No key needed. Best for authoritative
// citation details; abstracts are present for only some publishers.

const { fetchJson } = require('../util');
const { makePaper, plainQuery, withBoost, usable } = require('./common');

// updated-by and update-to carry retractions and corrections (Crossmark); relation links a preprint to its published
// version. All three are valid `select` fields (the API lists the valid ones when asked for a wrong one, 2026-11-18).
const SELECT = 'DOI,title,author,issued,container-title,is-referenced-by-count,abstract,type,URL,volume,issue,page,publisher,updated-by,update-to,relation';
const QUERY_FIELDS = { query: 'query', bibliographic: 'query.bibliographic', title: 'query.title' };
const TYPES = ['journal-article', 'proceedings-article', 'book-chapter', 'posted-content'];

// Without an email address Crossref's public pool allows one list request a second and one at a time; with one, the polite
// pool allows three a second and three at a time (crossref.org/blog/announcing-changes-to-rest-api-rate-limits, 2025-11-05,
// and the x-rate-limit-limit header answered on 2026-11-18). `has-abstract:true` matters: without it only about a quarter of
// the records a search returns carry an abstract, and a paper with no abstract is worth little to the answer.
function buildUrl(query, { filters = {}, settings = {}, limit = 20, boost, hasAbstract = true, field = 'query' } = {}) {
  const f = TYPES.map((t) => `type:${t}`);
  if (hasAbstract) f.push('has-abstract:true');
  if (filters.yearFrom) f.push(`from-pub-date:${filters.yearFrom}-01-01`);
  if (filters.yearTo) f.push(`until-pub-date:${filters.yearTo}-12-31`);
  // `field` picks Crossref's query parameter: 'query' (all fields), 'query.bibliographic' (title, authors, journal, year) or 'query.title'.
  const params = new URLSearchParams({ [QUERY_FIELDS[field] || 'query']: withBoost(plainQuery(query), boost, false), rows: String(limit), select: SELECT, filter: f.join(',') });
  if (settings.email) params.set('mailto', settings.email);
  return `https://api.crossref.org/works?${params}`;
}

// What an `updated-by` or `update-to` entry says about a paper (Crossmark update types).
const RETRACTION_TYPES = new Set(['retraction', 'withdrawal', 'removal']);
const NOTICE_TYPES = new Set(['retraction', 'withdrawal', 'removal', 'correction', 'erratum', 'corrigendum', 'expression_of_concern', 'addendum', 'clarification']);

function relationDois(relation, kind) {
  return ((relation && relation[kind]) || []).filter((r) => r && r['id-type'] === 'doi').map((r) => r.id);
}

function parse(json) {
  const items = (json.message && json.message.items) || [];
  return items.map((w) => {
    const parts = (w.issued && w.issued['date-parts'] && w.issued['date-parts'][0]) || [];
    const date = parts.length ? parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join('-') : '';
    const rel = w.relation || {};
    const title = Array.isArray(w.title) ? w.title[0] : w.title;
    // A record that updates another DOI as a retraction or correction is a notice, not a paper.
    const isNotice = (w['update-to'] || []).some((u) => NOTICE_TYPES.has(String(u.type || '').toLowerCase()));
    return makePaper({
      source: 'crossref',
      doi: w.DOI,
      title,
      authors: (w.author || []).map((a) => (a.family ? { family: a.family, given: a.given || '' } : a.name)),
      year: parts[0],
      date,
      venue: Array.isArray(w['container-title']) ? w['container-title'][0] : w['container-title'],
      publisher: w.publisher,
      volume: w.volume,
      issue: w.issue,
      pages: w.page,
      types: [isNotice ? 'retraction' : w.type],
      abstract: w.abstract,
      citations: w['is-referenced-by-count'],
      url: w.URL,
      retracted: (w['updated-by'] || []).some((u) => RETRACTION_TYPES.has(String(u.type || '').toLowerCase())),
      preprint: w.type === 'posted-content',
      preprintOf: relationDois(rel, 'is-preprint-of'),
      hasPreprint: relationDois(rel, 'has-preprint'),
    });
  }).filter((p) => p.title);
}

async function search(query, opts = {}) {
  return parse(await fetchJson(buildUrl(query, opts), { signal: opts.signal, timeout: 20000 })).filter(usable);
}

module.exports = { name: 'crossref', label: 'Crossref', search, parse, buildUrl, boosts: true };
