'use strict';
// Fan a set of search queries out to every enabled database, then merge the
// results into one de-duplicated, ranked list.

const crypto = require('crypto');
const { normTitle } = require('../util');
const common = require('./common');
const { scorePool, foldText } = require('./relevance');

const SOURCES = {
  openalex: require('./openalex'),
  semanticscholar: require('./semanticscholar'),
  crossref: require('./crossref'),
  europepmc: require('./europepmc'),
};

const REVIEW_KINDS = new Set(['Meta-analysis', 'Systematic review', 'Review']);
const LOW_VALUE_KINDS = new Set(['Editorial', 'News', 'Dataset', 'Letter']);

// ---------------------------------------------------------------------------------------
// Pacing. Every request to a database goes through one shared limiter, so the limits hold even when several searches
// run at once (the citation check looks up three citations side by side, and two windows can ask at the same time).

/** The reason a cancelled wait rejects with. */
function abortReason(signal) {
  return (signal && signal.reason) || new DOMException('This operation was aborted', 'AbortError');
}

/**
 * A queue per database ("lane"). A job starts when fewer than `concurrency` jobs of its lane are running and at least
 * `gap` ms have passed since the lane's previous start. The first request of a quiet lane starts at once. A job that
 * is cancelled while it waits leaves the queue at once, and an empty queue holds no timer. A running job keeps its
 * slot until it settles (fetchJson's own timeout bounds that), and an error releases the slot like a success.
 * Clock and timers can be replaced, so the tests run on fake time.
 */
function makeLimiter({ now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
  const lanes = new Map();
  let paced = true;
  const laneOf = (name) => {
    let l = lanes.get(name);
    if (!l) { l = { active: 0, last: -Infinity, queue: [], timer: null }; lanes.set(name, l); }
    return l;
  };
  function pump(l) {
    if (l.timer) { clearTimer(l.timer); l.timer = null; }
    while (l.queue.length) {
      const job = l.queue[0];
      if (l.active >= job.concurrency) return;
      const wait = paced ? l.last + job.gap - now() : 0;
      if (wait > 0) { l.timer = setTimer(() => { l.timer = null; pump(l); }, wait); return; }
      l.queue.shift();
      l.active++;
      l.last = now();
      job.go();
    }
  }
  function run(name, { concurrency = Infinity, gap = 0, signal } = {}, fn) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortReason(signal)); return; }
      const l = laneOf(name);
      const job = { concurrency: Math.max(1, concurrency), gap: Math.max(0, gap), go: null };
      const onAbort = () => {
        const i = l.queue.indexOf(job);
        if (i === -1) return; // already running: the request itself listens to the signal
        l.queue.splice(i, 1);
        pump(l);
        reject(abortReason(signal));
      };
      job.go = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        let out;
        try { out = Promise.resolve(fn()); } catch (e) { out = Promise.reject(e); }
        // The slot is free before the caller hears the result, so its next request can be planned at once.
        const release = () => { l.active--; pump(l); };
        out.then((v) => { release(); resolve(v); }, (e) => { release(); reject(e); });
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      l.queue.push(job);
      pump(l);
    });
  }
  return {
    run,
    /** Off = no waiting between requests (concurrency still holds). For offline tests, where no database is asked. */
    setPacing(on) { paced = !!on; },
    /** Jobs waiting and running per lane, and whether a timer is set. For tests. */
    state(name) { const l = laneOf(name); return { waiting: l.queue.length, running: l.active, timer: !!l.timer }; },
  };
}

const limiter = makeLimiter();

/** Planned queries keyless OpenAlex receives: its allowance is about 100 searches a day. */
const KEYLESS_OPENALEX_QUERIES = 1;

/**
 * Planned queries Crossref receives. Measured on the bench/search dev split (56 questions, 3 planned queries each,
 * 2026-11-18): Crossref's third query added no gold paper to the top 25 or 40 and changed the pool by -0.06 points (CI
 * -0.18 to 0.00), while each query costs about 1.1 s or more, one at a time. Its second query still added a few gold
 * papers to the pool (-0.28 points without it, CI -0.55 to -0.07), so it stays.
 */
const CROSSREF_QUERIES = 2;

/**
 * How each database may be asked. Limits as agent B checked them against each database's documentation and response
 * headers on 2026-11-18:
 *   OpenAlex          10 requests a second without a key, 30 with one; each search spends from a daily dollar allowance
 *                     ($0.10 keyless, about 100 searches; $1 keyed, about 1,000).
 *   Semantic Scholar  a key allows 1 request a second on every endpoint; keyless requests share one pool for all users
 *                     and are often refused (429). One at a time either way, so a retry after a refusal cannot overlap
 *                     the next request.
 *   Crossref          without an email (public pool): list queries 1 a second, one at a time; with one (polite pool):
 *                     3 a second, three at a time (crossref.org/blog/announcing-changes-to-rest-api-rate-limits, 2025-11-05).
 *   Europe PMC        no published limit could be read; two at a time.
 *   OpenAlex semantic search ("search.semantic") is limited to 1 request a second and returns at most 50 works.
 * `gentle`: ask one query at a time and stop at the first refusal (the keyless pools). `max`: planned queries to send.
 * `semantic`: also run OpenAlex's meaning-based search once, on the first query (keyed only: each search spends from
 * the daily allowance, and the keyless allowance is about 100 searches).
 */
function policyFor(name, settings = {}) {
  const hasKey = !!(settings.keys && settings.keys[name]);
  switch (name) {
    case 'openalex': return hasKey ? { concurrency: Infinity, gap: 34, max: Infinity, gentle: false, semantic: true } : { concurrency: 1, gap: 100, max: KEYLESS_OPENALEX_QUERIES, gentle: true, semantic: false };
    case 'semanticscholar': return { concurrency: 1, gap: hasKey ? 1050 : 1100, max: Infinity, gentle: !hasKey };
    case 'crossref': return settings.email ? { concurrency: 3, gap: 350, max: CROSSREF_QUERIES, gentle: false } : { concurrency: 1, gap: 1100, max: CROSSREF_QUERIES, gentle: false };
    default: return { concurrency: 2, gap: 0, max: Infinity, gentle: false };
  }
}

/** Words a database is asked to look for with a study-design or reviews-only filter (the literature mostly spells "randomized"). */
const DESIGN_TERMS = {
  'Meta-analysis': 'meta-analysis', 'Systematic review': 'systematic review', Review: 'review',
  'Randomised trial': 'randomized controlled trial', 'Clinical trial': 'clinical trial', 'Cohort study': 'cohort study',
  'Longitudinal study': 'longitudinal', 'Case-control study': 'case-control', 'Cross-sectional study': 'cross-sectional',
  'Qualitative study': 'qualitative', 'Case study': 'case study', 'Case report': 'case report',
};

/** The design phrases for the extra search a design filter needs (at most two), or []. */
function boostPhrases(filters = {}) {
  const designs = filters.designs && filters.designs.length ? filters.designs : (filters.reviewsOnly ? [...REVIEW_KINDS] : []);
  return [...new Set(designs.map((d) => DESIGN_TERMS[d]).filter(Boolean))].slice(0, 2);
}

/** The lane and pace of OpenAlex's semantic search, which has its own limit of 1 request a second. */
const SEMANTIC_PACE = { lane: 'openalex:semantic', concurrency: 1, gap: 1050 };

/**
 * Run all queries against all enabled sources.
 * onSource({ name, label, count, error, needsKey }) is called once per source when it finishes.
 * `semantic`: add one meaning-based search of the first query where a database offers it (`semantic: true` in its
 * exports) and the policy allows it. Topic searches ask for it; a citation lookup does not (a citation string is not a topic).
 * Returns [{ source, qi, papers, semantic? }] where qi is the query's position (0 = most specific), in a fixed order
 * (source, then query), so the merge does not depend on which database answered first.
 */
async function searchAll({ queries, filters = {}, settings, signal, onSource = () => {}, pace = limiter, semantic = false }) {
  const active = Object.keys(SOURCES).filter((k) => settings.sources && settings.sources[k]);
  const lists = [];
  // A study-design filter keeps few papers unless the search also looks for that design: one extra search on the first
  // query, which each database writes in its own syntax (`boost`). A database without that option gets the plain words.
  const boost = boostPhrases(filters);

  await Promise.all(active.map(async (name) => {
    const src = SOURCES[name];
    const policy = policyFor(name, settings);
    const jobs = queries.slice(0, policy.max).map((q, qi) => ({ q, qi, opts: {} }));
    if (boost.length && queries.length) {
      jobs.push(src.boosts
        ? { q: queries[0], qi: queries.length, opts: { boost } }
        : { q: `${queries[0]} ${boost.join(' ')}`, qi: queries.length, opts: {} });
    }
    if (semantic && src.semantic && policy.semantic && queries.length) {
      jobs.push({ q: queries[0], qi: queries.length + 1, opts: { mode: 'semantic', limit: 50 }, semantic: true });
    }
    let count = 0;
    let error = null;

    const run = async ({ q, qi, opts, semantic: sem }) => {
      try {
        const lane = sem ? SEMANTIC_PACE : { lane: name, concurrency: policy.concurrency, gap: policy.gap };
        const papers = await pace.run(lane.lane, { concurrency: lane.concurrency, gap: lane.gap, signal },
          () => src.search(q, { filters, settings, signal, ...opts }));
        lists.push(sem ? { source: name, qi, papers, semantic: true } : { source: name, qi, papers });
        count += papers.length;
        return true;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        error = e;
        return false;
      }
    };

    if (policy.gentle) {
      for (const job of jobs) if (!(await run(job))) break;
    } else {
      await Promise.all(jobs.map(run));
    }

    onSource({
      name,
      label: src.label,
      count,
      error: error ? (error.message || 'Request failed') : null,
      needsKey: !!(error && error.needsKey),
    });
  }));

  return lists.sort((a, b) => active.indexOf(a.source) - active.indexOf(b.source) || a.qi - b.qi);
}

// ---------------------------------------------------------------------------------------
// Which records are the same work.

/**
 * A title as a merge key: lower case, accents removed, Greek letters spelled out, punctuation gone. Unlike
 * util.normTitle it keeps letters of every script, so two different Chinese or Russian titles do not both become ''.
 */
function titleKey(t) {
  return foldText(t).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A paper's id: its DOI, or a hash of its title and year. */
function paperId(p) {
  if (p.doi) return `doi:${p.doi}`;
  let t = normTitle(p.title);
  // A title in another script has (almost) nothing left after normTitle; hash the full title instead. Latin titles
  // keep the id they always had, so papers saved in the Library still match.
  if (t.replace(/[^a-z]/g, '').length < 3) t = titleKey(p.title);
  const h = crypto.createHash('sha1').update(`${t}|${p.year || ''}`).digest('hex').slice(0, 16);
  return `t:${h}`;
}

const isPreprintDoi = (d) => (common.isPreprintDoi ? common.isPreprintDoi(d) : false);

/**
 * The DOI as an identity key. Some preprint servers mint one DOI per version (Research Square ".../v2", Preprints.org
 * ".v2", ChemRxiv ".v2", the OSF servers "_v2", seen in Crossref records on 2026-11-18); all versions are one work.
 */
function doiKey(doi) {
  const d = String(doi || '').toLowerCase();
  if (!d) return '';
  return isPreprintDoi(d) ? d.replace(/(?:[._/]v|(?<=\d)v)\d+$/, '') : d;
}

/** Every identifier a record carries, as keys that mean "the same work" when two records share one. */
function idKeys(p) {
  const keys = [];
  for (const d of [p.doi, ...(p.altDois || [])]) { const k = doiKey(d); if (k) keys.push(`doi:${k}`); }
  if (p.pmid) keys.push(`pmid:${p.pmid}`);
  if (p.pmcid) keys.push(`pmcid:${String(p.pmcid).toUpperCase()}`);
  if (p.arxiv) keys.push(`arxiv:${String(p.arxiv).toLowerCase().replace(/v\d+$/, '')}`);
  return [...new Set(keys)];
}

/** Is this record a preprint (by its DOI, its database's type, or a preprint server as its venue)? */
function isPreprint(p) {
  return !!p.preprint || p.kind === 'Preprint' || isPreprintDoi(p.doi)
    || (!p.doi && (common.isPreprintVenue ? common.isPreprintVenue(p.venue) : false));
}

/** A notice about another paper, or a reply to it: never the same work as that paper, however alike the titles. */
const NOTICE = /^\s*(correction|corrigendum|erratum|errata|retraction|retracted|withdrawn|withdrawal|expression of concern|addendum|reply|response|comment|commentary|author correction|publisher correction)\b/i;

/** The last word of an author's family name, folded ("van der Molen" and "Molen" agree). */
function familyKey(a) {
  const words = foldText(a && a.family).split(/[^\p{L}]+/u).filter(Boolean);
  return words[words.length - 1] || '';
}

/** true / false when both records list authors and their first authors do / do not agree; null when one has none. */
function sameAuthor(a, b) {
  if (!a.authors || !b.authors || !a.authors.length || !b.authors.length) return null;
  const fa = familyKey(a.authors[0]);
  const fb = familyKey(b.authors[0]);
  if (!fa || !fb) return null;
  // Databases sometimes list the authors in a different order: the first author among the other's first three counts.
  return fa === fb || b.authors.slice(0, 3).some((x) => familyKey(x) === fa) || a.authors.slice(0, 3).some((x) => familyKey(x) === fb);
}

const yearsClose = (a, b, gap) => !a.year || !b.year || Math.abs(a.year - b.year) <= gap;

/** Words of a title for the near-match below: longer than two characters, every script kept. */
function titleWords(t) {
  return new Set(titleKey(t).split(' ').filter((w) => w.length > 2 || /\d/.test(w)));
}

function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** Kind labels in order of what they tell a reader: a preprint label is replaced by any other, "Article" by a design. */
const kindRank = (k) => (k === 'Preprint' ? 0 : k === 'Article' ? 1 : 2);

/** Fold `b` into `a`, keeping the richer value for each field. */
function mergeInto(a, b) {
  if (!a.doi && b.doi) a.doi = b.doi;
  if ((b.abstract || '').length > (a.abstract || '').length) a.abstract = b.abstract;
  if (!a.tldr && b.tldr) a.tldr = b.tldr;
  if ((b.authors || []).length > (a.authors || []).length) a.authors = b.authors;
  if (b.citations != null && (a.citations == null || b.citations > a.citations)) a.citations = b.citations;
  for (const k of ['year', 'date', 'venue', 'volume', 'issue', 'pages', 'publisher', 'pdfUrl', 'url']) {
    if (!a[k] && b[k]) a[k] = b[k];
  }
  // A preprint label never replaces what another copy says the record is (a published copy is not a preprint).
  if (kindRank(b.kind) > kindRank(a.kind)) a.kind = b.kind;
  a.isOA = a.isOA || b.isOA;
  a.retracted = a.retracted || b.retracted;
  a.preprint = !!a.preprint || !!b.preprint; // copies of one DOI: any database that knows it is a preprint is believed
  for (const s of b.sources) if (!a.sources.includes(s)) a.sources.push(s);
  for (const k of ['fields', 'fieldIds', 'rel', 'altDois', 'preprintOf', 'hasPreprint']) {
    for (const v of b[k] || []) { if (!a[k]) a[k] = []; if (!a[k].includes(v)) a[k].push(v); }
  }
  for (const k of ['journalId', 'oaId', 'pmid', 'pmcid', 'arxiv']) if (!a[k] && b[k]) a[k] = b[k];
  if (b.sample != null && (a.sample == null || b.sample > a.sample)) a.sample = b.sample;
}

/**
 * `vor` is the published version of the preprint `rec`: the record takes the published identity (DOI, journal,
 * volume, pages, date), so it is cited as published, and keeps the richer text and the open copy from either.
 */
function adoptPublished(rec, vor) {
  const oldDoi = rec.doi;
  for (const k of ['doi', 'title', 'venue', 'volume', 'issue', 'pages', 'publisher', 'year', 'date', 'url', 'journalId', 'oaId']) {
    if (vor[k]) rec[k] = vor[k];
  }
  rec.kind = kindRank(vor.kind) >= kindRank(rec.kind) || rec.kind === 'Preprint' ? vor.kind : rec.kind;
  if (oldDoi && oldDoi !== rec.doi) { if (!rec.altDois) rec.altDois = []; if (!rec.altDois.includes(oldDoi)) rec.altDois.push(oldDoi); }
  rec.preprint = false;
  mergeInto(rec, vor);
}

/** Merge `b` into `a` (two records of one work), the published version's identity winning over a preprint's. */
function absorb(a, b) {
  const pa = isPreprint(a);
  const pb = isPreprint(b);
  if (pa && !pb && b.doi) { adoptPublished(a, b); return; }
  const otherVersion = !pa && pb && a.doi && doiKey(a.doi) !== doiKey(b.doi);
  mergeInto(a, b);
  if (otherVersion) {
    // `a` is the published version and `b` its preprint: `a` stays published, and keeps the preprint's DOI as another id.
    a.preprint = false;
    if (b.doi) { if (!a.altDois) a.altDois = []; if (!a.altDois.includes(b.doi)) a.altDois.push(b.doi); }
  }
}

/** Do records `a` and `b` (different ids, one a preprint) look like a preprint and its published version? */
function versionsOfOneWork(a, b, wa, wb) {
  if (!isPreprint(a) && !isPreprint(b)) return false;
  const da = doiKey(a.doi);
  const db = doiKey(b.doi);
  const linked = (x, d) => !!d && [...(x.preprintOf || []), ...(x.hasPreprint || [])].some((v) => doiKey(v) === d);
  if (linked(a, db) || linked(b, da)) return true;
  if (NOTICE.test(a.title || '') || NOTICE.test(b.title || '')) return false;
  // A title may change a little between preprint and publication; the numbers in it (Part 2, COVID-19, 2020) may not.
  const nums = (w) => [...w].filter((x) => /\d/.test(x)).sort().join(' ');
  if (nums(wa) !== nums(wb)) return false;
  if (/\bprotocol\b/i.test(a.title) !== /\bprotocol\b/i.test(b.title)) return false;
  return jaccard(wa, wb) >= VERSION_TITLE_SIM && sameAuthor(a, b) === true && yearsClose(a, b, 3);
}

/** Title-word overlap (Jaccard) above which a preprint and a published record by the same first author are one work. */
const VERSION_TITLE_SIM = 0.75;

// ---------------------------------------------------------------------------------------
// Fusion, relevance and ranking.

/**
 * The ranking parameters, each with its reason. Change one at a time and re-run bench/search on the dev split.
 *   K            reciprocal-rank constant (with 0-based positions, so 20 here is k = 19 in Cormack et al.'s 1-based
 *                formula, SIGIR 2009, who fixed k = 60 in a pilot). Smaller K trusts each database's top results more.
 *   queryWeight  the planner lists its most specific query first.
 *   sourceWeight per database; 1 when not listed.
 *   semanticWeight  the list from OpenAlex's meaning-based search of the first query. It is that query in another
 *                form, so it weighs like the first query.
 *   alpha        share of the final score that comes from the paper's own text matching the question (relevance.js);
 *                the rest is the fused database ranks. A convex combination of max-normalised scores (Bruch et al.,
 *                "An Analysis of Fusion Functions for Hybrid Retrieval", ACM TOIS 2023) needs one parameter.
 *   noText       factor for a paper with no usable abstract or summary: there is little for the model to read.
 *   citeBoost    a well-cited paper rises a little: x(1 + citeBoost * log10(1 + citations)).
 *   lowKind      factor for editorials, news, datasets and letters.
 *   relevance    options for relevance.scorePool.
 */
const RANK_DEFAULTS = {
  K: 20,
  queryWeight: [1, 0.85, 0.7, 0.6, 0.5],
  sourceWeight: {},
  semanticWeight: 1,
  alpha: 0.75,
  noText: 0.5,
  citeBoost: 0.06,
  lowKind: 0.6,
  relevance: {},
};

/**
 * Fold per-source lists into one list of distinct papers, each scored by reciprocal-rank fusion: a paper scores for
 * every list it appears in, more for higher positions, so papers that several databases (and several queries) agree
 * on float up. Two records are one paper when they share an identifier (DOI, PubMed id, PMC id, arXiv id), when their
 * titles are the same and their authors and years agree, or when one is the preprint of the other.
 */
function merge(lists, { params } = {}) {
  const P = { ...RANK_DEFAULTS, ...params };
  const byId = new Map();
  const byTitle = new Map();
  const all = [];

  for (const { source, qi, papers, semantic } of lists) {
    const sw = P.sourceWeight[source] == null ? 1 : P.sourceWeight[source];
    const qw = semantic ? P.semanticWeight : (P.queryWeight[qi] == null ? P.queryWeight[P.queryWeight.length - 1] : P.queryWeight[qi]);
    papers.forEach((p, rank) => {
      if (!p.title || p.title.length < 8) return;
      const keys = idKeys(p);
      const tKey = titleKey(p.title);
      let rec = null;
      for (const k of keys) { rec = byId.get(k); if (rec) break; }
      if (!rec && tKey) {
        const t = byTitle.get(tKey);
        if (t) {
          // Same title: one work if nothing says otherwise. A long title is strong evidence on its own; a short one
          // ("Introduction", "Editorial") also needs the same first author and year.
          const long = tKey.length >= 40;
          const authors = sameAuthor(t, p);
          const doiConflict = !!(t.doi && p.doi && doiKey(t.doi) !== doiKey(p.doi));
          const ok = long ? authors !== false && yearsClose(t, p, 3) : !doiConflict && authors === true && yearsClose(t, p, 1);
          if (ok) rec = t;
        }
      }
      if (rec) {
        absorb(rec, p);
      } else {
        rec = {
          ...p, authors: [...(p.authors || [])], sources: [...(p.sources || [])], fields: [...(p.fields || [])],
          fieldIds: [...(p.fieldIds || [])], rel: [...(p.rel || [])], altDois: [...(p.altDois || [])],
          preprintOf: [...(p.preprintOf || [])], hasPreprint: [...(p.hasPreprint || [])], score: 0,
        };
        all.push(rec);
      }
      for (const k of [...keys, ...idKeys(rec)]) if (!byId.has(k)) byId.set(k, rec);
      if (tKey) byTitle.set(tKey, rec);
      rec.score += (sw * qw) / (P.K + rank);
    });
  }

  // Second pass: a preprint and its published version carry different DOIs and often slightly different titles.
  const words = all.map((p) => titleWords(p.title));
  const gone = new Set();
  for (let i = 0; i < all.length; i++) {
    if (gone.has(i)) continue;
    for (let j = i + 1; j < all.length; j++) {
      if (gone.has(j) || !versionsOfOneWork(all[i], all[j], words[i], words[j])) continue;
      const score = all[i].score + all[j].score;
      absorb(all[i], all[j]);
      all[i].score = score;
      words[i] = titleWords(all[i].title);
      gone.add(j);
    }
  }
  const out = all.filter((_, i) => !gone.has(i));
  for (const p of out) {
    p.preprint = isPreprint(p);
    if (p.preprint && p.kind === 'Article') p.kind = 'Preprint';
  }
  return out;
}

/**
 * Does this paper pass the filters? A filter that needs a fact the record lacks (its field,
 * its journal's impact, a stated sample size) leaves the paper out: unknown is not a pass.
 */
function passes(p, filters = {}) {
  if (p.retracted) return false;
  if (common.usable && !common.usable(p)) return false; // correction notices, reviewers' reports, front matter
  if (filters.yearFrom && !(p.year >= filters.yearFrom)) return false;
  if (filters.yearTo && !(p.year > 0 && p.year <= filters.yearTo)) return false;
  if (filters.oaOnly && !p.isOA) return false;
  if (filters.noPreprints && (p.kind === 'Preprint' || p.preprint)) return false;
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

/**
 * Filter, combine the fused database ranks with the paper's own match to the question, adjust for readability and
 * standing, sort, and number the top `max`. `question`, `queries` and `followUp` feed the text match; without them the
 * order is the fused ranks alone. The records in `all` are not changed, so ranking twice gives the same order.
 */
function rank(all, { filters = {}, max = 16, question = '', queries = [], followUp = false, params } = {}) {
  const P = { ...RANK_DEFAULTS, ...params };
  const kept = all.filter((p) => passes(p, filters));
  const rel = P.alpha > 0 ? scorePool(kept, { question, queries, followUp, ...P.relevance }) : kept.map(() => 0);
  const maxFused = kept.reduce((m, p) => Math.max(m, p.score || 0), 0);
  const maxRel = rel.reduce((m, r) => Math.max(m, r), 0);
  const scored = kept.map((p, i) => {
    let s = maxFused > 0 ? (p.score || 0) / maxFused : 0;
    if (maxRel > 0) s = (1 - P.alpha) * s + P.alpha * (rel[i] / maxRel);
    const hasText = (p.abstract && p.abstract.length > 120) || p.tldr;
    if (!hasText) s *= P.noText;
    s *= 1 + P.citeBoost * Math.log10(1 + Math.max(0, p.citations || 0));
    if (LOW_VALUE_KINDS.has(p.kind)) s *= P.lowKind;
    return { p, s };
  });
  // Ties are broken by the fused score, then the title, so the order never depends on the order of the input.
  scored.sort((a, b) => b.s - a.s || (b.p.score || 0) - (a.p.score || 0) || titleKey(a.p.title).localeCompare(titleKey(b.p.title)));
  return scored.slice(0, max).map(({ p, s }, i) => ({ ...p, id: paperId(p), n: i + 1, score: Number(s.toFixed(5)) }));
}

/** Merge per-source lists into one ranked list (see merge and rank). */
function mergeAndRank(lists, opts = {}) {
  return rank(merge(lists, opts), opts);
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
 * `question` is the student's own text; `followUp` says it continues earlier turns (its words then count less).
 * Returns { papers, found (distinct papers before filtering), notices }.
 */
async function gather({ queries, question = '', followUp = false, filters = {}, settings, signal, onSource, max }) {
  const lists = await searchAll({ queries, filters, settings, signal, onSource, semantic: true });
  const all = merge(lists);
  const notices = [];
  let use = filters;
  const problem = await enrich(all, { filters, settings, signal });
  if (problem) {
    const which = [filters.fields && filters.fields.length && 'field of study', filters.journalMin > 0 && 'journal impact'].filter(Boolean).join(' and ');
    notices.push(`The ${which} filter was skipped, because it needs OpenAlex. ${problem}`);
    use = { ...filters, fields: [], journalMin: 0 };
  }
  return { papers: rank(all, { filters: use, max, question, queries, followUp }), found: all.length, notices };
}

module.exports = {
  SOURCES, searchAll, merge, rank, passes, enrich, gather, mergeAndRank, mergeInto, paperId,
  makeLimiter, limiter, policyFor, boostPhrases, doiKey, titleKey, idKeys, isPreprint, sameAuthor, RANK_DEFAULTS,
  KEYLESS_OPENALEX_QUERIES, CROSSREF_QUERIES,
};
