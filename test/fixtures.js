'use strict';
// Made-up records shaped exactly like each database's real responses.
// They exist only so the tests can run offline; none of these papers is real
// (the DOIs use 10.5555, the prefix reserved for examples).

const BASE = [
  { n: 1, title: 'Sample record: telework intensity and task performance, a meta-analysis of field studies', authors: [['Amira', 'Solberg'], ['Jun', 'Hattori'], ['Lena', 'van der Molen']], year: 2022, venue: 'Journal of Sample Organisational Research', volume: '48', issue: '3', pages: '401-436', cites: 512, type: 'review', oa: true,
    abstract: 'Sample abstract. We synthesise 61 field studies (N = 48,210 employees) on telework intensity and individual task performance. The pooled effect is small and positive (r = .09), and is larger for tasks with low interdependence. Effects turn negative above four remote days per week in teams with high coordination needs.' },
  { n: 2, title: 'Sample record: working from home and output in a call-centre randomised trial', authors: [['Noor', 'Rahman'], ['Peter', 'Aldous']], year: 2019, venue: 'Sample Quarterly Journal of Economics', volume: '134', issue: '1', pages: '165-218', cites: 2940, type: 'article', oa: false,
    abstract: 'Sample abstract. In a nine-month randomised trial at a 16,000-person services firm, call-centre employees assigned to work from home completed 13% more calls, driven by fewer breaks and sick days, and quit at half the rate. Promotion rates conditional on performance fell.' },
  { n: 3, title: 'Sample record: hybrid schedules, collaboration networks and innovation output', authors: [['Kwame', 'Osei'], ['Sofia', 'Marchetti'], ['Li', 'Wen'], ['Hugo', 'Brandt'], ['Ana', 'Pires']], year: 2023, venue: 'Sample Management Science', volume: '69', issue: '11', pages: '6500-6522', cites: 188, type: 'article', oa: true,
    abstract: 'Sample abstract. Using communication metadata from 61,000 employees, we find firm-wide remote work made collaboration networks more siloed and reduced cross-group ties by 25%, with a measurable decline in new-product ideas over the following year.' },
  { n: 4, title: 'Sample record: remote work and self-reported productivity during lockdowns, a cross-sectional survey', authors: [['Tomasz', 'Lewandowski']], year: 2021, venue: 'Sample Journal of Vocational Behaviour', volume: '129', issue: '', pages: '103622', cites: 344, type: 'article', oa: true,
    abstract: 'Sample abstract. A survey of 5,748 knowledge workers in 29 countries shows self-rated productivity was on average unchanged, with wide dispersion. Parents of young children and workers without a dedicated workspace reported losses.' },
  { n: 5, title: 'Sample record: does telecommuting raise productivity? Evidence from matched employer-employee panels', authors: [['Ingrid', 'Halvorsen'], ['Marc', 'Dubois']], year: 2020, venue: 'Sample Labour Economics', volume: '66', issue: '', pages: '101883', cites: 96, type: 'article', oa: false,
    abstract: 'Sample abstract. Fixed-effects estimates on a panel of 3,100 firms show no significant change in value added per hour after telecommuting adoption, once selection of more productive firms into adoption is accounted for.' },
  { n: 6, title: 'Sample record: a systematic review of remote work and wellbeing outcomes', authors: [['Chiara', 'Bianchi'], ['Rohan', 'Mehta']], year: 2021, venue: 'Sample Occupational Health Review', volume: '12', issue: '2', pages: '77-103', cites: 221, type: 'review', oa: true,
    abstract: 'Sample abstract. Across 37 studies, remote work is associated with higher autonomy and lower commuting stress, but also with isolation. Productivity is rarely measured objectively in this literature.' },
  { n: 7, title: 'Sample record: managerial monitoring, trust and performance in distributed teams', authors: [['Yuki', 'Tanaka'], ['Daniel', 'Okafor']], year: 2018, venue: 'Sample Academy of Management Journal', volume: '61', issue: '4', pages: '1321-1349', cites: 410, type: 'article', oa: false,
    abstract: 'Sample abstract. In 84 distributed teams, outcome-based monitoring predicted higher team performance than behaviour-based monitoring, an effect mediated by perceived trust.' },
  { n: 8, title: 'Sample record: home working, hours and output of professionals in an IT services company', authors: [['Marta', 'Quillfeather'], ['Oskar', 'Brannlund'], ['Dev', 'Sarangi']], year: 2023, venue: 'Sample Journal of Political Economy Microeconomics', volume: '1', issue: '1', pages: '7-41', cites: 301, type: 'article', oa: true,
    abstract: 'Sample abstract. Personnel and analytics data for more than 10,000 IT professionals show hours worked rose after the move to home working while output was flat, implying a fall in output per hour of 8 to 19 percent. Time in meetings rose and uninterrupted work time fell.' },
  { n: 9, title: 'Sample record: the future of hybrid work, a conceptual framework', authors: [['Elena', 'Petrova']], year: 2022, venue: 'Sample California Management Review', volume: '64', issue: '2', pages: '5-27', cites: 150, type: 'article', oa: false, abstract: '' },
  { n: 10, title: 'Sample record: coworking spaces and freelancer earnings', authors: [['Pablo', 'Herrera'], ['Mei', 'Chen']], year: 2017, venue: 'Sample Urban Studies', volume: '54', issue: '9', pages: '2100-2118', cites: 40, type: 'article', oa: false,
    abstract: 'Sample abstract. We study earnings of freelancers who join coworking spaces in six cities. The paper does not examine employees or remote work arrangements inside firms.' },
];

const doi = (p) => `10.5555/lectern.sample.${p.n}`;

function invert(text) {
  const idx = {};
  text.split(/\s+/).filter(Boolean).forEach((w, i) => { (idx[w] = idx[w] || []).push(i); });
  return idx;
}

// Field of study and journal for each sample record, as OpenAlex reports them.
// Records 1 to 5 are "Business", the rest "Psychology"; journal S8001 (record 1) is the highly cited one.
const oaField = (p) => (p.n <= 5 ? { id: 'https://openalex.org/fields/14', display_name: 'Business, Management and Accounting' } : { id: 'https://openalex.org/fields/32', display_name: 'Psychology' });
const journalImpact = (id) => (id === 'S8001' ? 12.5 : (id === 'S8002' ? 5.2 : 1.4));

function openalexWork(p) {
  return {
    id: `https://openalex.org/W90000${p.n}`,
    doi: `https://doi.org/${doi(p)}`,
    display_name: p.title,
    publication_year: p.year,
    publication_date: `${p.year}-03-01`,
    type: p.type,
    cited_by_count: p.cites,
    is_retracted: false,
    authorships: p.authors.map(([g, f]) => ({ author: { display_name: `${g} ${f}` } })),
    primary_location: { landing_page_url: `https://example.org/paper/${p.n}`, pdf_url: null, source: { id: `https://openalex.org/S800${p.n}`, type: 'journal', display_name: p.venue, host_organization_name: 'Sample Press' } },
    topics: [{ field: oaField(p) }, { field: { id: 'https://openalex.org/fields/33', display_name: 'Social Sciences' } }],
    best_oa_location: p.oa ? { pdf_url: `https://example.org/paper/${p.n}.pdf`, landing_page_url: `https://example.org/paper/${p.n}` } : null,
    open_access: { is_oa: p.oa, oa_url: p.oa ? `https://example.org/paper/${p.n}` : null },
    biblio: { volume: p.volume, issue: p.issue || null, first_page: p.pages.split('-')[0], last_page: p.pages.split('-')[1] || null },
    abstract_inverted_index: p.abstract ? invert(p.abstract) : null,
  };
}

function openalex(subset = [1, 2, 3, 4, 5, 6, 8, 9]) {
  return { meta: { count: subset.length }, results: BASE.filter((p) => subset.includes(p.n)).map(openalexWork) };
}

/** OpenAlex's /sources answer for a list of journal ids. */
function openalexSources(ids) {
  return { results: ids.map((id) => ({ id: `https://openalex.org/${id}`, summary_stats: { '2yr_mean_citedness': journalImpact(id), h_index: 50 } })) };
}

function semanticscholar(subset = [2, 1, 7, 8, 10, 4]) {
  return {
    total: subset.length,
    data: subset.map((n) => BASE.find((p) => p.n === n)).map((p) => ({
      paperId: `s2-${p.n}`,
      title: p.title,
      abstract: p.abstract || null,
      tldr: { text: `Sample one-line summary of record ${p.n}.` },
      year: p.year,
      publicationDate: `${p.year}-03-01`,
      authors: p.authors.map(([g, f]) => ({ name: `${g} ${f}` })),
      venue: p.venue,
      journal: { name: p.venue, volume: p.volume, pages: p.pages },
      // Record 7 has no DOI here, so merging must fall back to its title.
      externalIds: p.n === 7 ? {} : { DOI: doi(p).toUpperCase() },
      citationCount: p.cites + 5,
      isOpenAccess: p.oa,
      openAccessPdf: p.oa ? { url: `https://example.org/paper/${p.n}.pdf` } : null,
      publicationTypes: p.n === 1 ? ['MetaAnalysis', 'Review'] : (p.n === 2 ? ['JournalArticle', 'ClinicalTrial'] : ['JournalArticle']),
      url: `https://www.semanticscholar.org/paper/s2-${p.n}`,
    })),
  };
}

function crossref(subset = [5, 2, 7, 3, 9]) {
  return {
    status: 'ok',
    message: {
      items: subset.map((n) => BASE.find((p) => p.n === n)).map((p) => ({
        DOI: doi(p),
        title: [p.title],
        author: p.authors.map(([given, family]) => ({ given, family })),
        issued: { 'date-parts': [[p.year, 3, 1]] },
        'container-title': [p.venue],
        'is-referenced-by-count': p.cites - 10,
        abstract: p.abstract ? `<jats:title>Abstract</jats:title><jats:p>${p.abstract}</jats:p>` : undefined,
        type: 'journal-article',
        URL: `https://doi.org/${doi(p)}`,
        volume: p.volume, issue: p.issue || undefined, page: p.pages, publisher: 'Sample Press',
      })),
    },
  };
}

function europepmc(subset = [6]) {
  return {
    hitCount: subset.length,
    resultList: {
      result: subset.map((n) => BASE.find((p) => p.n === n)).map((p) => ({
        id: `3900000${p.n}`, source: 'MED', pmid: `3900000${p.n}`, pmcid: `PMC900${p.n}`, doi: doi(p),
        title: `${p.title}.`,
        authorList: { author: p.authors.map(([g, f]) => ({ fullName: `${f} ${g[0]}`, firstName: g, lastName: f })) },
        journalInfo: { volume: p.volume, issue: p.issue, journal: { title: p.venue } },
        pageInfo: p.pages, pubYear: String(p.year), firstPublicationDate: `${p.year}-03-01`,
        abstractText: p.abstract, citedByCount: p.cites, isOpenAccess: p.oa ? 'Y' : 'N',
        pubTypeList: { pubType: ['Systematic Review', 'Journal Article'] },
        fullTextUrlList: { fullTextUrl: [{ availability: 'Open access', documentStyle: 'pdf', url: `https://example.org/paper/${p.n}.pdf` }] },
      })),
    },
  };
}

const PLAN_JSON = JSON.stringify({ queries: ['remote work employee productivity', 'telework task performance field evidence', 'working from home output per hour'], yes_no: true, topic: 'Remote work and productivity' });

const ANSWER_TEXT = `Remote work does not have one effect on productivity: it depends on the task and on how much of the week is remote. The best pooled evidence finds a small positive effect on individual task performance [1], while studies of collaborative, professional work often find flat or lower output per hour [3][8].

## Routine work versus collaborative work

- **Routine, independent tasks gain.** In a randomised trial at a services firm, home workers completed 13% more calls and quit less often [2].
- **The average effect is small.** A meta-analysis of 61 field studies puts the pooled effect at r = .09, larger where tasks need little coordination [1].
- **Coordination-heavy work can lose.** Professionals worked longer hours for the same output after moving home, a fall in output per hour of 8 to 19 percent [8], and firm-wide remote work made collaboration networks more siloed [3].

| Kind of work | What changed | Evidence | Papers |
|---|---|---|---|
| Call-centre tasks | 13% more calls completed | Randomised trial | [2] |
| Mixed field settings | Small pooled gain, r = .09 | Meta-analysis of 61 studies | [1] |
| Professional, team-based | Output per hour down 8 to 19 percent | Firm records | [8][3] |

The gain shrinks as the work needs more coordination.

## Which firms choose remote work

Once more productive firms choosing to adopt telecommuting is accounted for, one panel study finds no significant change [5].

## Where the evidence is thin or disputed

Self-reported productivity [4] and objective output [2][8] do not measure the same thing, and much of the wellbeing literature never measures output at all [6]. Several studies come from a single firm.

## Worth following up

- Does the effect differ between fully remote and hybrid schedules?
- Which management practices offset the coordination losses of remote teams [7]?
- How do studies measure productivity when output is hard to count?`;

/** What the helper model returns when asked to pull claim-citation pairs out of pasted text. */
const VERIFY_JSON = JSON.stringify({
  items: [
    { claim: 'Employees working from home completed 13% more calls.', citation: '(Rahman & Aldous, 2019)', authors: ['Rahman', 'Aldous'], year: 2019, title: '', doi: '', keywords: 'working from home call centre output' },
    { claim: 'Telework has a large positive effect on performance.', citation: '(Solberg et al., 2022)', authors: ['Solberg', 'Hattori'], year: 2022, title: BASE[0].title, doi: '', keywords: 'telework performance meta-analysis' },
    { claim: 'Telecommuting adoption does not change value added per hour.', citation: '(Halvorsen & Dubois, 2020)', authors: ['Halvorsen', 'Dubois'], year: 2020, title: '', doi: `https://doi.org/${doi(BASE[4])}`, keywords: 'telecommuting productivity panel' },
    { claim: 'Remote work doubles innovation.', citation: '(Nobody, 1999)', authors: ['Nobody'], year: 1999, title: '', doi: '', keywords: 'remote work innovation' },
    { claim: '', citation: '(Empty, 2001)' },
  ],
});

function insightsJson(count, input = '') {
  const blocks = [...input.matchAll(/^\[(\d+)\] (.+)\n[^\n]+\n(?:Abstract(?: \(partial\))?|Summary \([^\n]+\)): ([^\n]+)/gm)];
  const stances = ['supports', 'supports', 'against', 'mixed', 'against', 'conditional', 'na', 'against', 'na', 'na'];
  return JSON.stringify({ papers: Array.from({ length: count }, (_, i) => {
    const block = blocks.find((m) => Number(m[1]) === i + 1);
    const base = block && BASE.find((p) => p.title === block[2]);
    const a = block?.[3] || '';
    const facts = {};
    const add = (key, value, quote) => { if (a.includes(quote)) facts[key] = { value, quote }; };
    if (base?.n === 1) {
      add('population', 'Employees across field studies', '61 field studies (N = 48,210 employees)');
      add('designType', 'meta-analysis', 'We synthesise 61 field studies');
      add('design', 'Meta-analysis of 61 field studies', 'We synthesise 61 field studies');
      add('sample', '48,210 employees', 'N = 48,210 employees');
      add('measure', 'Individual task performance', 'individual task performance');
      add('result', 'Small positive pooled effect, r = .09; worse with high coordination needs', 'The pooled effect is small and positive (r = .09)');
      add('direction', 'mixed', 'Effects turn negative above four remote days per week');
    } else if (base?.n === 2) {
      add('population', 'Call-centre workers', 'call-centre employees');
      add('designType', 'randomised', 'nine-month randomised trial');
      add('design', 'Nine-month randomised trial', 'nine-month randomised trial');
      add('setting', 'Services firm', '16,000-person services firm');
      add('measurement', 'objective', 'completed 13% more calls');
      add('measure', 'Calls completed', 'completed 13% more calls');
      add('result', '13% more calls completed; lower quitting', 'completed 13% more calls');
      add('direction', 'higher', 'completed 13% more calls');
    } else if (base?.n === 3) {
      add('population', 'Employees', '61,000 employees');
      add('sample', '61,000 employees', '61,000 employees');
      add('designType', 'observational', 'Using communication metadata');
      add('measurement', 'objective', 'communication metadata');
      add('measure', 'Collaboration networks and new-product ideas', 'collaboration networks more siloed');
      add('result', 'Fewer cross-group ties and new-product ideas', 'reduced cross-group ties by 25%');
    } else if (base?.n === 4) {
      add('population', 'Knowledge workers', '5,748 knowledge workers');
      add('sample', '5,748 workers in 29 countries', '5,748 knowledge workers in 29 countries');
      add('designType', 'observational', 'A survey of 5,748 knowledge workers');
      add('measurement', 'self-report', 'self-rated productivity');
      add('measure', 'Self-rated productivity', 'self-rated productivity');
      add('result', 'Unchanged average, with losses in some groups', 'on average unchanged, with wide dispersion');
      add('direction', 'mixed', 'on average unchanged, with wide dispersion');
    } else if (base?.n === 5) {
      add('population', 'Firms', 'a panel of 3,100 firms');
      add('sample', '3,100 firms', 'a panel of 3,100 firms');
      add('designType', 'observational', 'Fixed-effects estimates on a panel');
      add('measurement', 'objective', 'value added per hour');
      add('measure', 'Value added per hour', 'value added per hour');
      add('result', 'No significant change after accounting for selection', 'no significant change in value added per hour');
      add('direction', 'unchanged', 'no significant change in value added per hour');
    } else if (base?.n === 6) {
      add('designType', 'systematic-review', 'Across 37 studies');
      add('measure', 'Autonomy and commuting stress', 'higher autonomy and lower commuting stress');
    } else if (base?.n === 7) {
      add('population', 'Distributed teams', '84 distributed teams');
      add('sample', '84 distributed teams', '84 distributed teams');
      add('measure', 'Team performance', 'higher team performance');
      add('result', 'Outcome-based monitoring linked to higher team performance', 'outcome-based monitoring predicted higher team performance');
    } else if (base?.n === 8) {
      add('population', 'IT professionals', '10,000 IT professionals');
      add('sample', 'More than 10,000 professionals', 'more than 10,000 IT professionals');
      add('designType', 'observational', 'Personnel and analytics data');
      add('design', 'Personnel and analytics records', 'Personnel and analytics data');
      add('measurement', 'objective', 'output per hour of 8 to 19 percent');
      add('measure', 'Output per hour', 'output per hour');
      add('result', 'Output per hour fell by 8–19%; working hours rose', 'fall in output per hour of 8 to 19 percent');
      add('direction', 'lower', 'fall in output per hour of 8 to 19 percent');
    }
    return { n: i + 1, relevant: base ? base.n !== 10 : i < 8,
      stance: base ? ({1: 'conditional', 2: 'supports', 3: 'against', 4: 'mixed', 5: 'mixed', 6: 'na', 7: 'conditional', 8: 'against', 9: 'na', 10: 'na'}[base.n]) : (stances[i] || 'na'), finding: facts.result?.value || `Sample finding for paper ${i + 1}: a short statement of what the abstract reports.`,
      design: facts.design?.value || (base ? ({3: 'Communication metadata study', 4: 'Cross-sectional survey', 5: 'Fixed-effects panel', 6: 'Systematic review', 7: 'Distributed team study'}[base.n] || 'Not stated') : 'Not stated'), sample: facts.sample?.value || '', facts };
  }) });
}

// ---- figures: Europe PMC's open-access lookup and the PMC Article Datasets bucket
// Sample records 1 and 3 have an open-access full text with figures; 4 is open access but the
// bucket has nothing for it. Record 1 has two versions in the bucket (the newest must win).
const FIGURE_PMC = { 1: 'PMC9001', 3: 'PMC9003', 4: 'PMC9004' };

function europepmcLite(query) {
  const asked = [...String(query).matchAll(/DOI:"([^"]+)"/g)].map((m) => m[1]);
  return {
    hitCount: asked.length,
    resultList: {
      result: BASE.filter((p) => asked.includes(doi(p))).map((p) => ({
        id: `3900000${p.n}`, source: 'MED', doi: doi(p).toUpperCase(),
        pmcid: FIGURE_PMC[p.n] || undefined, isOpenAccess: FIGURE_PMC[p.n] ? 'Y' : 'N',
      })),
    },
  };
}

const BUCKET_FILES = {
  PMC9001: ['PMC9001.1/PMC9001.1.xml', 'PMC9001.2/PMC9001.2.json', 'PMC9001.2/PMC9001.2.xml', 'PMC9001.2/PMC9001.2.pdf', 'PMC9001.2/fig1.jpg', 'PMC9001.2/fig2.png', 'PMC9001.2/fig3.jpg', 'PMC9001.2/supp_table.xlsx'],
  PMC9003: ['PMC9003.1/PMC9003.1.json', 'PMC9003.1/PMC9003.1.xml', 'PMC9003.1/gr1.jpg'],
  PMC9004: [],
};

function bucketList(prefix) {
  const id = String(prefix).replace(/\.$/, '');
  const keys = BUCKET_FILES[id] || [];
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>pmc-oa-opendata</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount>${keys.map((k) => `<Contents><Key>${k}</Key><Size>100</Size></Contents>`).join('')}</ListBucketResult>`;
}

const FIGURE_XML = {
  'PMC9001.2/PMC9001.2.xml': `<article><body><sec><title>Results</title>
    <fig id="F1"><label>Figure 1</label><caption><title>PRISMA flow diagram of study selection.</title></caption><graphic xlink:href="fig1"/></fig>
    <fig id="F2"><label>Figure 2</label><caption><title>Pooled effect of telework intensity on task performance.</title><p>Forest plot of 61 field studies. Squares show each study&#x2019;s estimate and lines its 95% interval; the diamond is the pooled effect (r = .09).</p></caption><graphic xlink:href="fig2.png"/></fig>
    <fig id="F3"><label>Figure 3</label><caption><p>Effect size by share of remote days &amp; task coordination.</p></caption><graphic xlink:href="fig3"/></fig>
    <fig id="F4"><label>Figure 4</label><caption><p>A figure whose image is missing from the bucket.</p></caption><graphic xlink:href="fig4"/></fig>
  </sec></body></article>`,
  'PMC9001.1/PMC9001.1.xml': '<article><fig id="old"><label>Old figure</label><caption><p>From an older version.</p></caption><graphic xlink:href="old"/></fig></article>',
  'PMC9003.1/PMC9003.1.xml': `<article><fig id="g1"><label>Fig. 1</label><caption><p>Collaboration network density before and after firm-wide remote work.</p></caption><graphic xlink:href="gr1.jpg"/></fig></article>`,
};
const FIGURE_JSON = {
  'PMC9001.2/PMC9001.2.json': { pmcid: 'PMC9001', version: 2, license_code: 'CC BY', is_retracted: false },
  'PMC9003.1/PMC9003.1.json': { pmcid: 'PMC9003', version: 1, license_code: 'CC BY-NC-ND', is_retracted: false },
};

/** What the helper model replies when asked to choose figures: two good picks, one unknown id, one repeat. */
function figuresJson(input) {
  const ids = [...String(input).matchAll(/^\[(F\d+)\]/gm)].map((m) => m[1]);
  return JSON.stringify({
    figures: [
      { id: ids[0], read: 'Each square is one study and its line the 95% interval; the diamond at the bottom is the pooled effect.' },
      { id: 'F99', read: 'Not a candidate.' },
      { id: ids[0], read: 'The same figure again.' },
      { id: ids[1], read: 'Remote work cut network density by 40 percent.' },
    ],
  });
}

module.exports = {
  FIGURE_PMC, europepmcLite, bucketList, BUCKET_FILES, FIGURE_XML, FIGURE_JSON, figuresJson,
  BASE, doi, openalex, openalexWork, openalexSources, semanticscholar, crossref, europepmc, PLAN_JSON, ANSWER_TEXT, VERIFY_JSON, insightsJson };
