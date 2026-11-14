'use strict';
// Search filters: the lists the window offers, and the one place that cleans what it sends back.
//
// Where each filter's information comes from (nothing here is guessed by a model):
//   year, citations, open access, preprint   the paper's database record
//   study design                              the title and the database's publication type
//   sample size                               the number stated in the abstract (common.js sampleSize)
//   field of study, journal impact            OpenAlex (its 26 fields; its 2-year mean citedness per journal)
//   journal or publisher                      the venue and publisher names on the record

const { clip } = require('./util');

/** OpenAlex's 26 fields of study, with OpenAlex's own ids (api.openalex.org/fields, checked 2026-11-14). */
const FIELDS = [
  ['11', 'Agricultural and Biological Sciences'], ['12', 'Arts and Humanities'],
  ['13', 'Biochemistry, Genetics and Molecular Biology'], ['14', 'Business, Management and Accounting'],
  ['15', 'Chemical Engineering'], ['16', 'Chemistry'], ['17', 'Computer Science'], ['18', 'Decision Sciences'],
  ['35', 'Dentistry'], ['19', 'Earth and Planetary Sciences'], ['20', 'Economics, Econometrics and Finance'],
  ['21', 'Energy'], ['22', 'Engineering'], ['23', 'Environmental Science'], ['36', 'Health Professions'],
  ['24', 'Immunology and Microbiology'], ['25', 'Materials Science'], ['26', 'Mathematics'], ['27', 'Medicine'],
  ['28', 'Neuroscience'], ['29', 'Nursing'], ['30', 'Pharmacology, Toxicology and Pharmaceutics'],
  ['31', 'Physics and Astronomy'], ['32', 'Psychology'], ['33', 'Social Sciences'], ['34', 'Veterinary'],
].map(([id, label]) => ({ id, label }));

/** Study designs Lectern can recognise. The values are the `kind` labels from sources/common.js. */
const DESIGNS = [
  'Meta-analysis', 'Systematic review', 'Review', 'Randomised trial', 'Clinical trial',
  'Cohort study', 'Longitudinal study', 'Case-control study', 'Cross-sectional study',
  'Qualitative study', 'Case study', 'Case report',
];
const REVIEW_DESIGNS = ['Meta-analysis', 'Systematic review', 'Review'];

/**
 * Journal impact = OpenAlex's "2-year mean citedness", an impact-factor-style measure.
 * It is not the Journal Impact Factor or a journal's SJR quartile.
 * The free databases carry no SJR quartile (Q1 to Q4), so the filter is a plain threshold instead.
 */
const JOURNAL_TIERS = [
  { min: 0, label: 'Any journal' },
  { min: 1, label: '1 or more citations per paper' },
  { min: 2, label: '2 or more' },
  { min: 5, label: '5 or more' },
  { min: 10, label: '10 or more (the most cited journals)' },
];

const FIELD_IDS = new Set(FIELDS.map((f) => f.id));
const DESIGN_SET = new Set(DESIGNS);
const TIER_MINS = new Set(JOURNAL_TIERS.map((t) => t.min));

function list(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,;\n]/);
  return [];
}

/** Whatever the window sends, return a complete, safe filter object. */
function cleanFilters(f) {
  f = f || {};
  const year = (v) => { const n = Math.round(Number(v)); return n >= 1800 && n <= 2100 ? n : null; };
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  let designs = [...new Set(list(f.designs).map(String).filter((d) => DESIGN_SET.has(d)))];
  if (f.reviewsOnly && !designs.length) designs = [...REVIEW_DESIGNS]; // the older "reviews only" switch
  const journalMin = Number(f.journalMin);
  return {
    yearFrom: year(f.yearFrom),
    yearTo: year(f.yearTo),
    oaOnly: !!f.oaOnly,
    noPreprints: !!f.noPreprints,
    minCitations: int(f.minCitations, 100000),
    journalMin: TIER_MINS.has(journalMin) ? journalMin : 0,
    designs,
    reviewsOnly: designs.length > 0 && designs.every((d) => REVIEW_DESIGNS.includes(d)),
    minSample: int(f.minSample, 10000000),
    fields: [...new Set(list(f.fields).map(String).filter((id) => FIELD_IDS.has(id)))],
    venues: [...new Set(list(f.venues).map((v) => clip(String(v).replace(/\s+/g, ' ').trim(), 80).toLowerCase()).filter((v) => v.length > 1))].slice(0, 8),
  };
}

/** How many filters are switched on (for the badge on the Filters button). */
function countActive(f) {
  return [f.yearFrom, f.yearTo, f.oaOnly, f.noPreprints, f.minCitations > 0, f.journalMin > 0,
    f.designs.length, f.minSample > 0, f.fields.length, f.venues.length].filter(Boolean).length;
}

/** A one-line description, for the search record in a literature review. */
function describe(f) {
  const out = [];
  if (f.yearFrom || f.yearTo) out.push(`published ${f.yearFrom || 'any year'} to ${f.yearTo || 'now'}`);
  if (f.minCitations > 0) out.push(`at least ${f.minCitations} citations`);
  if (f.journalMin > 0) out.push(`journal impact of ${f.journalMin} or more`);
  if (f.oaOnly) out.push('open access only');
  if (f.noPreprints) out.push('no preprints');
  if (f.designs.length) out.push(`study design: ${f.designs.join(', ')}`);
  if (f.minSample > 0) out.push(`stated sample of ${f.minSample} or more`);
  if (f.fields.length) out.push(`fields: ${f.fields.map((id) => FIELDS.find((x) => x.id === id).label).join(', ')}`);
  if (f.venues.length) out.push(`journal or publisher containing: ${f.venues.join(', ')}`);
  return out.join('; ');
}

const options = () => ({ fields: FIELDS, designs: DESIGNS, journalTiers: JOURNAL_TIERS });

module.exports = { FIELDS, DESIGNS, REVIEW_DESIGNS, JOURNAL_TIERS, cleanFilters, countActive, describe, options };
