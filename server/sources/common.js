'use strict';
// Every database returns papers in its own shape. Each source module converts
// its results into the one shape defined by makePaper() below.

const { clean, normDoi, normTitle, httpUrl } = require('../util');

const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'du', 'la', 'le', 'bin', 'binti', 'ibn', 'al', 'el', 'ter', 'ten', 'st', 'st.']);

/** "Maria van der Berg" -> { given: "Maria", family: "van der Berg" }. Best effort: names are hard. */
function parseName(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    const family = clean(input.family || input.lastName || '');
    const given = clean(input.given || input.firstName || '');
    if (family) return { given, family };
    return parseName(input.name || input.fullName || input.display_name || '');
  }
  const name = clean(input);
  if (!name) return null;
  if (name.includes(',')) {
    const [family, ...rest] = name.split(',');
    return { family: family.trim(), given: rest.join(',').trim() };
  }
  const parts = name.split(' ');
  if (parts.length === 1) return { given: '', family: parts[0] };
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return { given: parts.slice(0, i).join(' '), family: parts.slice(i).join(' ') };
}

const TITLE_KINDS = [
  [/\bmeta[- ]?analy/i, 'Meta-analysis'],
  [/\bsystematic (literature )?review\b|\bscoping review\b|\bumbrella review\b/i, 'Systematic review'],
  [/\brandomi[sz]ed\b.*\btrial\b|\bRCT\b/i, 'Randomised trial'],
  [/\bliterature review\b|\ba review\b|\breview of\b|\bstate of the art\b/i, 'Review'],
  [/\bcase stud(y|ies)\b/i, 'Case study'],
  [/\bcase[- ]control\b/i, 'Case-control study'],
  [/\bcohort\b/i, 'Cohort study'],
  [/\bcross[- ]sectional\b/i, 'Cross-sectional study'],
  [/\blongitudinal\b|\bpanel (study|survey)\b/i, 'Longitudinal study'],
  [/\bqualitative\b|\bfocus groups?\b|\bin-depth interviews?\b/i, 'Qualitative study'],
];

const TYPE_KINDS = {
  // Semantic Scholar publicationTypes
  metaanalysis: 'Meta-analysis', review: 'Review', clinicaltrial: 'Clinical trial', casereport: 'Case report',
  conference: 'Conference paper', book: 'Book', booksection: 'Book chapter', editorial: 'Editorial',
  lettersandcomments: 'Letter', news: 'News', dataset: 'Dataset',
  // Europe PMC
  'meta-analysis': 'Meta-analysis', 'systematic review': 'Systematic review',
  'randomized controlled trial': 'Randomised trial', 'clinical trial': 'Clinical trial',
  'case reports': 'Case report', preprint: 'Preprint',
  // OpenAlex / Crossref
  'book-chapter': 'Book chapter', 'proceedings-article': 'Conference paper', 'posted-content': 'Preprint',
  dissertation: 'Thesis', monograph: 'Book', 'edited-book': 'Book', letter: 'Letter', report: 'Report',
  // OpenAlex work types (docs.openalex.org/data/work-types, read 2026-11-18) and Crossref types that are not research
  'conference-paper': 'Conference paper', 'conference-abstract': 'Conference paper',
  'review-article': 'Review', 'book-review': 'Letter', 'reference-entry': 'Book chapter',
  erratum: 'Correction', retraction: 'Correction', 'expression-of-concern': 'Correction',
  'retraction of publication': 'Correction', 'published erratum': 'Correction',
  'peer-review': 'Peer review', paratext: 'Front matter', 'supplementary-materials': 'Front matter',
  'journal-issue': 'Front matter', 'journal-volume': 'Front matter', 'proceedings': 'Front matter',
};

/** Kinds that are not research a student could cite: notices, reviewers' reports and front matter. */
const NON_RESEARCH_KINDS = new Set(['Correction', 'Peer review', 'Front matter']);

// OpenAlex tags works with a study design from the title and abstract (docs.openalex.org/data/study-designs).
// Its own documentation holds these tags to at least 95% precision, so they beat a guess from the title.
const DESIGN_KINDS = [
  ['meta-analysis', 'Meta-analysis'], ['systematic-review', 'Systematic review'],
  ['randomized-controlled-trial', 'Randomised trial'], ['clinical-trial', 'Clinical trial'], ['case-report', 'Case report'],
];

// A notice about another paper, not a paper: "Correction to: ...", "Retraction Note: ...".
const NOTICE_TITLE = /^\s*(correction to\b|correction:|corrigendum|erratum|errata\b|publisher correction|author correction|addendum to\b|retraction( note| notice| statement)?\s*[:.]|retraction of\b|notice of retraction|expression of concern|withdrawal notice)/i;
const RETRACTED_TITLE = /^\s*(retracted( article| publication| paper)?|withdrawn)\s*:/i;

// DOI prefixes of preprint servers, each checked against Crossref's prefix registry on 2026-11-18: arXiv, SSRN, Research
// Square, Authorea, Preprints.org, ChemRxiv, TechRxiv, Cambridge Open Engage, and the Center for Open Science servers
// (OSF Preprints, PsyArXiv, SocArXiv, MetaArXiv, EdArXiv), EarthArXiv and EngrXiv. bioRxiv and medRxiv used 10.1101/
// with a date until 2025-11 and 10.64898 since then (agent C's report of bioRxiv's notice, checked against Crossref's prefix registry
// too). 10.1101 is shared with Cold Spring Harbor journals, so only the
// dated form counts.
const PREPRINT_DOI = /^10\.(48550\/arxiv\.|1101\/\d{4}\.\d{2}\.\d{2}\.|64898\/|2139\/ssrn\.|21203\/rs\.|22541\/au\.|20944\/preprints|26434\/chemrxiv|36227\/techrxiv|33774\/coe-|31219\/|31234\/|31235\/|31222\/|35542\/|31223\/|31224\/)/i;
const PREPRINT_VENUE = /^\s*(arxiv|biorxiv|medrxiv|chemrxiv|ssrn|research square|preprints\.org|osf preprints|psyarxiv|socarxiv|engrxiv|eartharxiv|edarxiv|authorea|techrxiv)\b/i;

function isPreprintDoi(doi) {
  return PREPRINT_DOI.test(String(doi || '').toLowerCase());
}

function isPreprintVenue(venue) {
  return PREPRINT_VENUE.test(String(venue || ''));
}

/** A short, human label for what kind of publication this is. `designs` are OpenAlex study-design ids, when known. */
function detectKind(title, types, designs) {
  if (NOTICE_TITLE.test(title || '')) return 'Correction';
  // A database that says "this is a notice, a review of another paper or front matter" outranks what the title looks like.
  for (const t of (Array.isArray(types) ? types : [types]).filter(Boolean)) {
    const label = TYPE_KINDS[String(t).toLowerCase()];
    if (NON_RESEARCH_KINDS.has(label)) return label;
  }
  const tagged = new Set((designs || []).map((d) => String(d).split('/').pop()));
  for (const [id, label] of DESIGN_KINDS) if (tagged.has(id) && !tagged.has('study-protocol')) return label;
  for (const [re, label] of TITLE_KINDS) if (re.test(title || '')) return label;
  const list = (Array.isArray(types) ? types : [types]).filter(Boolean).map((t) => String(t).toLowerCase());
  // Prefer the most informative label when several are present.
  const order = ['Correction', 'Peer review', 'Front matter', 'Meta-analysis', 'Systematic review', 'Randomised trial', 'Clinical trial', 'Review', 'Case report', 'Preprint', 'Conference paper', 'Book chapter', 'Book', 'Thesis', 'Report', 'Editorial', 'Letter', 'News', 'Dataset'];
  const found = list.map((t) => TYPE_KINDS[t] || TYPE_KINDS[t.replace(/\s+/g, '')]).filter(Boolean);
  for (const label of order) if (found.includes(label)) return label;
  return 'Article';
}

const SAMPLE_UNITS = 'participants|patients|subjects|respondents|students|adults|children|adolescents|women|men|individuals|people|persons|employees|workers|firms|companies|households|schools|teams|nurses|teachers|users|customers|volunteers|residents|infants|pupils';
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
const SAMPLE_N = new RegExp(`\\b[Nn]\\s*=\\s*${NUM}`, 'g');
const SAMPLE_UNIT = new RegExp(`(?<![\\d.,%$£€-])${NUM}\\s+(?:[a-z][a-z-]*\\s+){0,2}(?:${SAMPLE_UNITS})\\b`, 'gi');

/**
 * The largest sample size an abstract states, or null. It reads "N = 48,210" and
 * "5,748 knowledge workers"; it does not count studies, countries or years. Best effort:
 * an abstract can state its sample in ways this misses, and then the answer is null.
 */
function sampleSize(text) {
  const t = String(text || '');
  let best = null;
  const take = (raw, strict) => {
    const v = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(v) || v < 2 || v > 1e9) return;
    if (strict && !raw.includes(',') && v >= 1800 && v <= 2100) return; // "in 2020 firms…" is a year
    if (best == null || v > best) best = v;
  };
  for (const m of t.matchAll(SAMPLE_N)) take(m[1], false);
  for (const m of t.matchAll(SAMPLE_UNIT)) take(m[1], true);
  return best;
}

/** How alike two titles are, 0 to 1 (shared words over all words, ignoring short ones). */
function titleSim(a, b) {
  const words = (t) => new Set(normTitle(t).split(' ').filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', thinsp: ' ', ensp: ' ', emsp: ' ' };

function decodeEntities(t) {
  return t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (m, dec, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// Only tags that publishers really use: a bare "<" in "x<y and a>b" must survive. Anything with a namespace (jats:, mml:) is a tag.
const TAG = /<\/?(?:(?:[a-z]+:)[a-z][\w-]*|(?:p|br|i|b|u|em|strong|sub|sup|span|a|div|sec|title|h[1-6]|li|ul|ol|italic|bold|sc|math|ext-link|xref|inline-formula|tex-math|list-item|label|caption|table|tr|td|th|abstract|small|big|mark|code|tt|font))(?:\s[^<>]*)?\/?>/gi;

/**
 * Plain text from an abstract as a database ships it. Crossref sends JATS XML ("<jats:p>", "<jats:title>"), Europe PMC
 * sends HTML ("<h4>Background</h4><p>"), and some publishers send both escaped twice. Section headings become "Background. "
 * so a structured abstract stays readable; a stray "<" in "P < 0.05" is kept, because only a real tag (a letter or a
 * slash right after "<") is removed.
 */
function abstractText(raw) {
  let t = Array.isArray(raw) ? String(raw[0] || '') : String(raw == null ? '' : raw);
  if (!t) return '';
  // Escaped markup ("&lt;p&gt;") shows up in some Crossref records: decode it first so it is removed like real markup.
  if (/&lt;\/?[a-z][^&]{0,80}&gt;/i.test(t)) t = decodeEntities(t);
  t = t.replace(/<(?:jats:)?(?:title|h[1-6])\b[^>]*>\s*([^<]{1,60}?)\s*<\/(?:jats:)?(?:title|h[1-6])>/gi, (m, h) => {
    if (/^(abstract|summary)$/i.test(h.trim())) return ' ';
    return /[.:?!]$/.test(h) ? ` ${h} ` : ` ${h}. `;
  });
  t = t.replace(/<\/?(?:jats:)?(?:p|sec|div|li|ul|ol|list|list-item|br|abstract)\b[^>]*>/gi, ' ');
  t = t.replace(TAG, '');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim().replace(/^(abstract|summary)\s*[:.]?\s+/i, '');
}

/** The identifier at the end of a link or "name:id" string, when it has the expected shape; otherwise ''. */
function idTail(v, re) {
  const m = String(v || '').match(re);
  return m ? m[0] : '';
}
const pmidOf = (v) => idTail(String(v || '').replace(/\/+$/, ''), /\d{1,9}$/);
const pmcidOf = (v) => (String(v || '').match(/PMC\d{4,9}/i) || [''])[0].toUpperCase();
const arxivOf = (v) => (String(v || '').replace(/^arxiv:/i, '').match(/(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i) || [''])[0];

/** Crossref and other relations hold DOIs as links; keep the distinct, normalised ones. */
function doiList(list) {
  return [...new Set((list || []).map(normDoi).filter(Boolean))];
}

function makePaper(p) {
  const title = clean(p.title);
  const authors = (p.authors || []).map(parseName).filter((a) => a && a.family);
  const year = Number(p.year) || (p.date ? Number(String(p.date).slice(0, 4)) : null) || null;
  const doi = normDoi(p.doi);
  const venue = clean(p.venue);
  return {
    id: '',
    doi,
    title,
    authors,
    year,
    date: p.date || '',
    venue,
    volume: clean(p.volume),
    issue: clean(p.issue),
    pages: clean(p.pages),
    publisher: clean(p.publisher),
    kind: detectKind(title, p.types, p.designs),
    abstract: abstractText(p.abstract),
    tldr: clean(p.tldr),
    citations: Number.isFinite(p.citations) ? p.citations : null,
    isOA: !!p.isOA || !!httpUrl(p.pdfUrl),
    pdfUrl: httpUrl(p.pdfUrl),
    url: httpUrl(p.url),
    retracted: !!p.retracted || RETRACTED_TITLE.test(title),
    sources: [p.source],
    // Filled where the database gives them (OpenAlex): field of study, and which journal this is.
    fields: (p.fields || []).map(clean).filter(Boolean),
    fieldIds: (p.fieldIds || []).map(String).filter(Boolean),
    journalId: clean(p.journalId),
    oaId: clean(p.oaId),
    sample: sampleSize(p.abstract),
    // A preprint stays a preprint even when its title says "meta-analysis": `kind` shows the design, this flag the stage.
    preprint: !!p.preprint || isPreprintDoi(doi) || isPreprintVenue(venue) || (Array.isArray(p.types) ? p.types : [p.types]).some((t) => /^(preprint|posted-content)$/i.test(String(t || ''))),
    // Identifiers that let the merge recognise one work under another id (preprint and published version, PubMed copy).
    pmid: pmidOf(p.pmid),
    pmcid: pmcidOf(p.pmcid),
    arxiv: arxivOf(p.arxiv),
    preprintOf: doiList(p.preprintOf),
    hasPreprint: doiList(p.hasPreprint),
    altDois: doiList(p.altDois).filter((d) => d !== doi),
    // The database's own relevance estimate for this query, 0 to 1, when it gives one (OpenAlex rerank); null otherwise.
    relScore: Number.isFinite(p.relScore) ? p.relScore : null,
  };
}

/** False for records that are not research a student could cite: correction notices, reviewers' reports, front matter. */
function usable(p) {
  return !NON_RESEARCH_KINDS.has(p.kind);
}

/**
 * A query cleaned for a database that has no search syntax (or only some of it). Operators the planner may have left in
 * ("AND", "OR", "NOT"), wildcards, fuzzy marks and brackets would otherwise become search words or a 400 error.
 * `keepQuotes` leaves balanced double quotes, for databases that match phrases.
 */
function plainQuery(q, { keepQuotes = false } = {}) {
  let t = String(q || '').replace(/[*~^\\{}\[\]|]/g, ' ').replace(/[()]/g, ' ');
  t = t.replace(/\b(?:AND|OR|NOT)\b/g, ' ');
  if (!keepQuotes || (t.match(/"/g) || []).length % 2) t = t.replace(/["“”]/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Boost phrases ("systematic review", "meta-analysis") as a query clause in a database's own syntax. `bool` databases
 * take `(q) AND ("a" OR "b")`; the others get the phrases appended as plain words, which only nudges the ranking.
 */
function withBoost(q, boost, bool) {
  const phrases = (boost || []).map((b) => plainQuery(b)).filter(Boolean);
  if (!phrases.length) return q;
  if (bool) return `(${q}) AND (${phrases.map((b) => `"${b}"`).join(' OR ')})`;
  return `${q} ${phrases.join(' ')}`;
}

module.exports = { parseName, detectKind, makePaper, sampleSize, titleSim, abstractText, usable, plainQuery, withBoost, isPreprintDoi, isPreprintVenue, decodeEntities, NON_RESEARCH_KINDS };
