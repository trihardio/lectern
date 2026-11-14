'use strict';
// Crossref: the DOI registry itself. No key needed. Best for authoritative
// citation details; abstracts are present for only some publishers.

const { fetchJson } = require('../util');
const { makePaper } = require('./common');

const SELECT = 'DOI,title,author,issued,container-title,is-referenced-by-count,abstract,type,URL,volume,issue,page,publisher';
const TYPES = ['journal-article', 'proceedings-article', 'book-chapter', 'posted-content'];

function buildUrl(query, { filters = {}, settings = {}, limit = 20 }) {
  const f = TYPES.map((t) => `type:${t}`);
  if (filters.yearFrom) f.push(`from-pub-date:${filters.yearFrom}-01-01`);
  if (filters.yearTo) f.push(`until-pub-date:${filters.yearTo}-12-31`);
  const params = new URLSearchParams({ query, rows: String(limit), select: SELECT, filter: f.join(',') });
  if (settings.email) params.set('mailto', settings.email);
  return `https://api.crossref.org/works?${params}`;
}

function parse(json) {
  const items = (json.message && json.message.items) || [];
  return items.map((w) => {
    const parts = (w.issued && w.issued['date-parts'] && w.issued['date-parts'][0]) || [];
    const date = parts.length ? parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join('-') : '';
    return makePaper({
      source: 'crossref',
      doi: w.DOI,
      title: Array.isArray(w.title) ? w.title[0] : w.title,
      authors: (w.author || []).map((a) => (a.family ? { family: a.family, given: a.given || '' } : a.name)),
      year: parts[0],
      date,
      venue: Array.isArray(w['container-title']) ? w['container-title'][0] : w['container-title'],
      publisher: w.publisher,
      volume: w.volume,
      issue: w.issue,
      pages: w.page,
      types: [w.type],
      abstract: w.abstract,
      citations: w['is-referenced-by-count'],
      url: w.URL,
    });
  }).filter((p) => p.title);
}

async function search(query, opts = {}) {
  return parse(await fetchJson(buildUrl(query, opts), { signal: opts.signal, timeout: 20000 }));
}

module.exports = { name: 'crossref', label: 'Crossref', search, parse, buildUrl };
