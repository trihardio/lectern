'use strict';
// Fan a set of search queries out to every enabled database, then merge the
// results into one de-duplicated, ranked list.

const crypto = require('crypto');
const { normTitle, sleep } = require('../util');

const SOURCES = {
  openalex: require('./openalex'),
  semanticscholar: require('./semanticscholar'),
  crossref: require('./crossref'),
  europepmc: require('./europepmc'),
};

const REVIEW_KINDS = new Set(['Meta-analysis', 'Systematic review', 'Review']);
const LOW_VALUE_KINDS = new Set(['Editorial', 'News', 'Dataset', 'Letter']);

/**
 * Run all queries against all enabled sources.
 * onSource({ name, label, count, error, needsKey }) is called once per source when it finishes.
 * Returns [{ source, qi, papers }] where qi is the query's position (0 = most specific).
 */
async function searchAll({ queries, filters = {}, settings, signal, onSource = () => {} }) {
  const active = Object.keys(SOURCES).filter((k) => settings.sources && settings.sources[k]);
  const lists = [];
  // A study-design filter keeps few papers unless the search also looks for that design.
  const designs = filters.designs || [];
  let qs = queries;
  if (filters.reviewsOnly) qs = [...queries, `${queries[0]} systematic review meta-analysis`];
  else if (designs.length) qs = [...queries, `${queries[0]} ${designs.slice(0, 2).join(' ').toLowerCase()}`];

  await Promise.all(active.map(async (name) => {
    const src = SOURCES[name];
    const hasKey = !!(settings.keys && settings.keys[name]);
    let count = 0;
    let error = null;

    const run = async (q, qi) => {
      try {
        const papers = await src.search(q, { filters, settings, signal });
        lists.push({ source: name, qi, papers });
        count += papers.length;
        return true;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        error = e;
        return false;
      }
    };

    // Keyless OpenAlex has a tiny daily allowance and keyless Semantic Scholar allows about
    // one request a second, so go one query at a time there and stop at the first refusal.
    const gentle = (name === 'openalex' || name === 'semanticscholar') && !hasKey;
    if (gentle) {
      const limit = name === 'openalex' ? 1 : qs.length;
      for (let i = 0; i < Math.min(limit, qs.length); i++) {
        if (i > 0) await sleep(1100);
        if (!(await run(qs[i], i))) break;
      }
    } else {
      await Promise.all(qs.map(run));
    }

    onSource({
      name,
      label: src.label,
      count,
      error: error ? (error.message || 'Request failed') : null,
      needsKey: !!(error && error.needsKey),
    });
  }));

  return lists;
}

function paperId(p) {
  if (p.doi) return `doi:${p.doi}`;
  const h = crypto.createHash('sha1').update(`${normTitle(p.title)}|${p.year || ''}`).digest('hex').slice(0, 16);
  return `t:${h}`;
}

/** Fold `b` into `a`, keeping the richer value for each field. */
function mergeInto(a, b) {
  if (!a.doi && b.doi) a.doi = b.doi;
  if ((b.abstract || '').length > (a.abstract || '').length) a.abstract = b.abstract;
  if (!a.tldr && b.tldr) a.tldr = b.tldr;
  if (b.authors.length > a.authors.length) a.authors = b.authors;
  if (b.citations != null && (a.citations == null || b.citations > a.citations)) a.citations = b.citations;
  for (const k of ['year', 'date', 'venue', 'volume', 'issue', 'pages', 'publisher', 'pdfUrl', 'url']) {
    if (!a[k] && b[k]) a[k] = b[k];
  }
  if (a.kind === 'Article' && b.kind !== 'Article') a.kind = b.kind;
  a.isOA = a.isOA || b.isOA;
  a.retracted = a.retracted || b.retracted;
  for (const s of b.sources) if (!a.sources.includes(s)) a.sources.push(s);
  for (const k of ['fields', 'fieldIds', 'rel']) {
    for (const v of b[k] || []) { if (!a[k]) a[k] = []; if (!a[k].includes(v)) a[k].push(v); }
  }
  for (const k of ['journalId', 'oaId']) if (!a[k] && b[k]) a[k] = b[k];
  if (b.sample != null && (a.sample == null || b.sample > a.sample)) a.sample = b.sample;
}

/**
 * Fold per-source lists into one list of distinct papers, each scored by reciprocal-rank
 * fusion: a paper scores for every list it appears in, more for higher positions, so papers
 * that several databases (and several queries) agree on float up.
 */
function merge(lists) {
  const K = 20;
  const QUERY_WEIGHT = [1, 0.85, 0.7, 0.6, 0.5];
  const byDoi = new Map();
  const byTitle = new Map();
  const all = [];

  for (const { qi, papers } of lists) {
    papers.forEach((p, rank) => {
      if (!p.title || p.title.length < 8) return;
      const tKey = normTitle(p.title);
      let rec = p.doi ? byDoi.get(p.doi) : null;
      if (!rec) {
        // Same title = same work, unless both carry different DOIs and the title is
        // short enough to be generic ("Introduction", "Editorial").
        const t = byTitle.get(tKey);
        const conflictingDoi = t && t.doi && p.doi && t.doi !== p.doi;
        if (t && (!conflictingDoi || tKey.length >= 40)) rec = t;
      }
      if (rec) {
        mergeInto(rec, p);
      } else {
        rec = { ...p, authors: [...p.authors], sources: [...p.sources], fields: [...(p.fields || [])], fieldIds: [...(p.fieldIds || [])], rel: [...(p.rel || [])], score: 0 };
        all.push(rec);
      }
      if (rec.doi) byDoi.set(rec.doi, rec);
      byTitle.set(tKey, rec);
      rec.score += (QUERY_WEIGHT[qi] || 0.5) / (K + rank);
    });
  }
  return all;
}

/**
 * Does this paper pass the filters? A filter that needs a fact the record lacks (its field,
 * its journal's impact, a stated sample size) leaves the paper out: unknown is not a pass.
 */
function passes(p, filters = {}) {
  if (p.retracted) return false;
  if (filters.yearFrom && !(p.year >= filters.yearFrom)) return false;
  if (filters.yearTo && !(p.year > 0 && p.year <= filters.yearTo)) return false;
  if (filters.oaOnly && !p.isOA) return false;
  if (filters.noPreprints && p.kind === 'Preprint') return false;
  if (filters.minCitations > 0 && (p.citations || 0) < filters.minCitations) return false;
  const designs = filters.designs && filters.designs.length ? filters.designs : (filters.reviewsOnly ? [...REVIEW_KINDS] : []);
  if (designs.length && !designs.includes(p.kind)) return false;
  if (filters.minSample > 0 && !(p.sample >= filters.minSample)) return false;
  if (filters.venues && filters.venues.length) {
    const where = `${p.venue || ''} | ${p.publisher || ''}`.toLowerCase();
    if (!filters.venues.some((v) => where.includes(v))) return false;
  }
  if (filters.fields && filters.fields.length && !(p.fieldIds || []).some((id) => filters.fields.includes(id))) return false;
  if (filters.journalMin > 0 && !(p.journalScore >= filters.journalMin)) return false;
  return true;
}

/** Filter, adjust the fused score for readability and standing, sort, and number the top `max`. */
function rank(all, { filters = {}, max = 16 } = {}) {
  const kept = all.filter((p) => passes(p, filters));
  for (const p of kept) {
    const hasText = (p.abstract && p.abstract.length > 120) || p.tldr;
    let s = p.score;
    s *= hasText ? 1 : 0.5; // without an abstract there is little to read
    s *= 1 + 0.06 * Math.log10(1 + (p.citations || 0));
    if (LOW_VALUE_KINDS.has(p.kind)) s *= 0.6;
    p.score = s;
  }
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, max).map((p, i) => ({ ...p, id: paperId(p), n: i + 1, score: Number(p.score.toFixed(5)) }));
}

/** Merge per-source lists into one ranked list (see merge and rank). */
function mergeAndRank(lists, opts = {}) {
  return rank(merge(lists), opts);
}

/**
 * The field-of-study and journal-impact filters need facts only OpenAlex has. Before those
 * filters run, ask OpenAlex about the papers that came from the other databases (by DOI) and
 * about the journals involved. Returns a message when OpenAlex could not be asked, in which
 * case the caller drops those two filters rather than silently keeping nothing.
 */
async function enrich(all, { filters = {}, settings, signal } = {}) {
  const wantFields = !!(filters.fields && filters.fields.length);
  const wantJournal = filters.journalMin > 0;
  if (!wantFields && !wantJournal) return null;
  const oa = SOURCES.openalex;
  try {
    const missing = all.filter((p) => p.doi && !p.oaId).map((p) => p.doi);
    if (missing.length) {
      const byDoi = new Map(all.filter((p) => p.doi).map((p) => [p.doi, p]));
      for (const found of await oa.worksByDoi(missing, { settings, signal })) {
        const rec = byDoi.get(found.doi);
        if (rec) mergeInto(rec, found);
      }
    }
    if (wantJournal) {
      const ids = [...new Set(all.map((p) => p.journalId).filter(Boolean))];
      const stats = ids.length ? await oa.journalStats(ids, { settings, signal }) : new Map();
      for (const p of all) if (stats.has(p.journalId)) p.journalScore = stats.get(p.journalId);
    }
    return null;
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return e.message || 'OpenAlex could not be reached';
  }
}

/**
 * Search, merge, look up what the filters need, and rank.
 * Returns { papers, found (distinct papers before filtering), notices }.
 */
async function gather({ queries, filters = {}, settings, signal, onSource, max }) {
  const lists = await searchAll({ queries, filters, settings, signal, onSource });
  const all = merge(lists);
  const notices = [];
  let use = filters;
  const problem = await enrich(all, { filters, settings, signal });
  if (problem) {
    const which = [filters.fields && filters.fields.length && 'field of study', filters.journalMin > 0 && 'journal impact'].filter(Boolean).join(' and ');
    notices.push(`The ${which} filter was skipped, because it needs OpenAlex. ${problem}`);
    use = { ...filters, fields: [], journalMin: 0 };
  }
  return { papers: rank(all, { filters: use, max }), found: all.length, notices };
}

module.exports = { SOURCES, searchAll, merge, rank, passes, enrich, gather, mergeAndRank, mergeInto, paperId };
