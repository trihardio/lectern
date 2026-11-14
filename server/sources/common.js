'use strict';
// Every database returns papers in its own shape. Each source module converts
// its results into the one shape defined by makePaper() below.

const { clean, cleanAbstract, normDoi, normTitle, httpUrl } = require('../util');

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
};

/** A short, human label for what kind of publication this is. */
function detectKind(title, types) {
  for (const [re, label] of TITLE_KINDS) if (re.test(title || '')) return label;
  const list = (Array.isArray(types) ? types : [types]).filter(Boolean).map((t) => String(t).toLowerCase());
  // Prefer the most informative label when several are present.
  const order = ['Meta-analysis', 'Systematic review', 'Randomised trial', 'Clinical trial', 'Review', 'Case report', 'Preprint', 'Conference paper', 'Book chapter', 'Book', 'Thesis', 'Report', 'Editorial', 'Letter', 'News', 'Dataset'];
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

function makePaper(p) {
  const title = clean(p.title);
  const authors = (p.authors || []).map(parseName).filter((a) => a && a.family);
  const year = Number(p.year) || (p.date ? Number(String(p.date).slice(0, 4)) : null) || null;
  return {
    id: '',
    doi: normDoi(p.doi),
    title,
    authors,
    year,
    date: p.date || '',
    venue: clean(p.venue),
    volume: clean(p.volume),
    issue: clean(p.issue),
    pages: clean(p.pages),
    publisher: clean(p.publisher),
    kind: detectKind(title, p.types),
    abstract: cleanAbstract(p.abstract),
    tldr: clean(p.tldr),
    citations: Number.isFinite(p.citations) ? p.citations : null,
    isOA: !!p.isOA || !!httpUrl(p.pdfUrl),
    pdfUrl: httpUrl(p.pdfUrl),
    url: httpUrl(p.url),
    retracted: !!p.retracted,
    sources: [p.source],
    // Filled where the database gives them (OpenAlex): field of study, and which journal this is.
    fields: (p.fields || []).map(clean).filter(Boolean),
    fieldIds: (p.fieldIds || []).map(String).filter(Boolean),
    journalId: clean(p.journalId),
    oaId: clean(p.oaId),
    sample: sampleSize(p.abstract),
  };
}

module.exports = { parseName, detectKind, makePaper, sampleSize, titleSim };
