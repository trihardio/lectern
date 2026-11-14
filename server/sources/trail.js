'use strict';
// Two jobs that start from a known paper instead of a topic:
//   trace()    citation trail: what a starting paper cites, and what cites it (OpenAlex)
//   resolve()  find the database record for a citation someone wrote ("Bloom et al., 2015")
// As everywhere else, papers and links come from the databases, never from a model.

const openalex = require('./openalex');
const crossref = require('./crossref');
const { titleSim } = require('./common');
const { normDoi, normTitle } = require('../util');

const DOI_IN_TEXT = /10\.\d{4,9}\/[^\s"<>]+/;

/** A DOI anywhere in a line of text (a bare DOI, a doi.org link, "doi: …"), or ''. */
function doiIn(text) {
  const m = DOI_IN_TEXT.exec(String(text || ''));
  return m ? normDoi(m[0].replace(/[.,;:)\]]+$/, '')) : '';
}

const plain = (s) => normTitle(s);
const sameFamily = (a, b) => !!a && !!b && plain(a) === plain(b);

/**
 * The starting papers of a citation trail: one per non-empty line, a DOI or a full title.
 * Returns { seeds: [paper], missing: [the lines that could not be found] }.
 */
async function findSeeds(input, { settings, signal }) {
  const lines = String(input || '').split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 5).slice(0, 3);
  const seeds = [];
  const missing = [];
  for (const line of lines) {
    let paper = null;
    const doi = doiIn(line);
    if (doi) {
      paper = await openalex.workByDoi(doi, { settings, signal });
    } else {
      const hits = await openalex.search(line.slice(0, 300), { settings, signal, limit: 5 });
      paper = hits.map((p) => ({ p, sim: titleSim(p.title, line) })).filter((x) => x.sim >= 0.6).sort((a, b) => b.sim - a.sim).map((x) => x.p)[0] || null;
      if (!paper) {
        // Crossref is good at matching a loosely written reference; use it to learn the DOI.
        const guess = (await crossref.search(line.slice(0, 300), { settings, signal, limit: 3 }).catch(() => []))
          .find((p) => p.doi && titleSim(p.title, line) >= 0.5);
        if (guess) paper = await openalex.workByDoi(guess.doi, { settings, signal });
      }
    }
    if (paper && paper.oaId) { if (!seeds.some((s) => s.oaId === paper.oaId)) seeds.push(paper); } else missing.push(line);
  }
  return { seeds, missing };
}

/**
 * Follow citations out from the seeds. For each seed: its most cited references, the most
 * cited papers that cite it, and the newest papers that cite it.
 * Each paper is tagged in `rel`: 'seed', 'ref:<seed number>' or 'cit:<seed number>'.
 * Returns ranked-list input for sources/index.js merge(): [{ qi, papers }].
 */
async function trace(seeds, { filters = {}, settings, signal }) {
  const tag = (papers, rel) => papers.map((p) => ({ ...p, rel: [rel] }));
  const lists = [];
  await Promise.all(seeds.map(async (seed, i) => {
    const k = i + 1;
    const opts = { filters, settings, signal };
    const [refs, citing, newest] = await Promise.all([
      openalex.related(seed.oaId, 'references', { ...opts, limit: 25, sort: 'cited' }),
      openalex.related(seed.oaId, 'citing', { ...opts, limit: 25, sort: 'cited' }),
      openalex.related(seed.oaId, 'citing', { ...opts, limit: 10, sort: 'newest' }),
    ]);
    lists.push({ qi: 0, papers: tag(refs, `ref:${k}`) }, { qi: 0, papers: tag(citing, `cit:${k}`) }, { qi: 2, papers: tag(newest, `cit:${k}`) });
  }));
  return lists;
}

/**
 * Find the record for one written citation. `cite` is what the model pulled out of the
 * student's text: { authors: [family names], year, title, doi }. `search(query)` runs the
 * normal database search and returns merged candidates.
 * Returns { paper, how } where how is 'doi', 'title', 'author-year' (weaker: it could be
 * another paper by the same author that year) or 'none'.
 */
async function resolve(cite, { search, settings, signal }) {
  const doi = normDoi(cite.doi) || '';
  if (doi) {
    const paper = await openalex.workByDoi(doi, { settings, signal }).catch((e) => {
      if (signal && signal.aborted) throw e;
      return null;
    });
    if (paper) return { paper, how: 'doi' };
    // A known DOI must not drift to a different paper just because OpenAlex is unavailable.
    const hits = await search(doi);
    const exact = hits.find((p) => normDoi(p.doi) === doi);
    return exact ? { paper: exact, how: 'doi' } : { paper: null, how: 'none' };
  }
  const first = (cite.authors || [])[0] || '';
  const year = Number(cite.year) || null;
  const byAuthorYear = (p) => p.authors.some((a) => sameFamily(a.family, first)) && year && p.year === year;

  if (cite.title && cite.title.length > 8) {
    const hits = await search(cite.title.slice(0, 300));
    const best = hits.map((p) => ({ p, sim: titleSim(p.title, cite.title) })).sort((a, b) => b.sim - a.sim)[0];
    if (best && best.sim >= 0.6) return { paper: best.p, how: 'title' };
    return { paper: null, how: 'none' };
  }
  if (first && year) {
    const hits = await search(`${first} ${year} ${cite.keywords || ''}`.trim().slice(0, 200));
    const match = hits.find(byAuthorYear);
    if (match) return { paper: match, how: 'author-year' };
  }
  return { paper: null, how: 'none' };
}

module.exports = { findSeeds, trace, resolve, doiIn };
