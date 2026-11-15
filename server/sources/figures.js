'use strict';
// Figures from the papers themselves, for the papers that have an open-access full text.
//
//   1. Europe PMC tells us which of the answer's papers are open access in PubMed Central
//      (one search for all their DOIs at once).
//   2. The PMC Article Datasets (NCBI's open bucket on AWS, made for programmatic use) hold each
//      such article's full text, its licence, and its figure image files.
//   3. The full text's <fig> elements give each figure's label and caption, and its image file.
//
// A model then picks which figures help the question (server/pipeline.js), by id only. The image,
// label, caption, licence and links always come from the article record, never from a model.
// Only biomedical and life-science open-access papers are covered: other papers have no figures.

const { fetchJson, withTimeout, stripTags, clip, normDoi } = require('../util');

const BUCKET = 'https://pmc-oa-opendata.s3.amazonaws.com';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const UA = { 'user-agent': 'Lectern/0.1 (local research app)' };

/** Figures that rarely help a reader understand a finding: how studies were selected, and the like. */
const LOW_VALUE = /\b(prisma|flow ?(chart|diagram)|study selection|search strategy|selection process|screening process|risk of bias|consort|graphical abstract|photograph|logo)\b/i;

async function getText(url, { signal, timeout = 20000 } = {}) {
  const res = await fetch(url, { headers: UA, signal: withTimeout(signal, timeout) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.text();
}

/** Which DOIs are open access in PubMed Central: Map of doi -> PMCID. */
async function openAccessIds(dois, { signal } = {}) {
  const out = new Map();
  if (!dois.length) return out;
  const query = dois.map((d) => `DOI:"${d.replace(/"/g, '')}"`).join(' OR ');
  const json = await fetchJson(`${EPMC}?${new URLSearchParams({ query, format: 'json', resultType: 'lite', pageSize: String(Math.min(100, dois.length * 2)) })}`, { signal, timeout: 15000 });
  for (const r of (json.resultList && json.resultList.result) || []) {
    const doi = normDoi(r.doi);
    if (doi && r.pmcid && r.isOpenAccess === 'Y' && dois.includes(doi) && !out.has(doi)) out.set(doi, r.pmcid);
  }
  return out;
}

/** The newest version folder of one article in the bucket, and the files in it. */
async function listArticle(pmcid, { signal } = {}) {
  const xml = await getText(`${BUCKET}/?${new URLSearchParams({ 'list-type': '2', prefix: `${pmcid}.`, 'max-keys': '200' })}`, { signal });
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const versions = [...new Set(keys.map((k) => k.split('/')[0]))]
    .filter((f) => new RegExp(`^${pmcid}\\.\\d+$`).test(f))
    .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
  if (!versions.length) return null;
  const folder = versions[0];
  return { folder, keys: keys.filter((k) => k.startsWith(`${folder}/`)) };
}

const text = (s) => stripTags(String(s || ''))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/\s+/g, ' ').trim();

/** The <fig> elements of a JATS full text: [{ id, label, title, caption, href }]. */
function parseFigures(xml) {
  const out = [];
  // `(?=[\s>])`, not `\b`: front matter has <fig-count count="2"/>, which `\b` would match.
  for (const m of String(xml || '').matchAll(/<fig(?=[\s>])([^>]*)>([\s\S]*?)<\/fig>/g)) {
    const body = m[2];
    const href = (/<graphic\b[^>]*?xlink:href="([^"]+)"/.exec(body) || [])[1];
    if (!href) continue;
    const cap = (/<caption\b[^>]*>([\s\S]*?)<\/caption>/.exec(body) || [])[1] || '';
    const title = text((/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(cap) || [])[1]);
    const paras = [...cap.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((p) => text(p[1])).filter(Boolean).join(' ');
    out.push({
      id: (/\bid="([^"]+)"/.exec(m[1]) || [])[1] || '',
      label: text((/<label\b[^>]*>([\s\S]*?)<\/label>/.exec(body) || [])[1]),
      title: clip(title || paras.split(/(?<=\.)\s/)[0] || '', 240),
      caption: clip(paras && paras !== title ? paras : '', 1200),
      href,
    });
  }
  return out;
}

/**
 * The image file in the bucket for a figure's href (hrefs come with or without an extension).
 * Newer articles ship their figures as .webp only, which the window (Chromium) shows.
 */
function imageKey(keys, href) {
  const base = href.replace(/\.(jpe?g|png|gif|webp|tiff?)$/i, '');
  const images = keys.filter((k) => /\.(jpe?g|png|gif|webp)$/i.test(k));
  return images.find((k) => k.endsWith(`/${href}`)) || images.find((k) => k.split('/').pop().replace(/\.[a-z]+$/i, '') === base) || null;
}

/** Every figure of one open-access article, with its image URL and licence. [] when it has none. */
async function articleFigures(pmcid, { signal } = {}) {
  const art = await listArticle(pmcid, { signal });
  if (!art) return [];
  const xmlKey = art.keys.find((k) => k.endsWith('.xml'));
  const jsonKey = art.keys.find((k) => k.endsWith('.json'));
  if (!xmlKey) return [];
  const [xml, meta] = await Promise.all([
    getText(`${BUCKET}/${xmlKey}`, { signal }),
    jsonKey ? getText(`${BUCKET}/${jsonKey}`, { signal }).then((t) => JSON.parse(t)).catch(() => ({})) : Promise.resolve({}),
  ]);
  if (meta.is_retracted) return [];
  const license = clip(String(meta.license_code || ''), 40);
  return parseFigures(xml).map((f) => {
    const key = imageKey(art.keys, f.href);
    return key ? {
      pmcid, label: f.label, title: f.title, caption: f.caption, license,
      img: `${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
      page: `https://europepmc.org/article/PMC/${pmcid.replace(/^PMC/, '')}`,
    } : null;
  }).filter(Boolean);
}

/**
 * Candidate figures for a list of ranked papers. Looks at the `look` highest-ranked papers that
 * have a DOI, opens at most `open` of the open-access ones, and returns at most `max` figures,
 * each tagged with its paper's number and a candidate id (F1, F2…). Never throws.
 */
async function candidates(papers, { signal, look = 10, open = 4, perPaper = 4, max = 10 } = {}) {
  try {
    const ranked = papers.filter((p) => p.doi).slice(0, look);
    const ids = await openAccessIds(ranked.map((p) => p.doi), { signal });
    const chosen = ranked.filter((p) => ids.has(p.doi)).slice(0, open);
    const lists = await Promise.all(chosen.map((p) => articleFigures(ids.get(p.doi), { signal })
      .then((figs) => figs.map((f) => ({ ...f, n: p.n })))
      .catch(() => [])));
    // Keep each paper's most useful figures, then interleave papers so one paper cannot fill the list.
    const per = lists.map((figs) => figs.filter((f) => !LOW_VALUE.test(`${f.label} ${f.title} ${f.caption}`)).slice(0, perPaper));
    const out = [];
    for (let i = 0; out.length < max && per.some((l) => i < l.length); i++) {
      for (const l of per) if (l[i] && out.length < max) out.push(l[i]);
    }
    return out.map((f, i) => ({ ...f, id: `F${i + 1}` }));
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return [];
  }
}

/**
 * A reading guide must not add facts: every number in it has to appear in the figure's own
 * label, title or caption. Returns the guide, or '' when it fails that check.
 */
function groundedRead(read, fig) {
  const full = String(read || '').replace(/\s+/g, ' ').trim();
  // Models overrun the length asked for; end on the last whole sentence rather than mid-word.
  const cut = full.length > 320 ? full.slice(0, 320).replace(/(?<=[.!?])\s[^.!?]*$/, '') : full;
  const guide = /[.!?]$/.test(cut) ? cut : clip(full, 320);
  if (!guide) return '';
  const source = `${fig.label} ${fig.title} ${fig.caption}`.replace(/,(?=\d{3}\b)/g, '');
  const nums = guide.replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/g) || [];
  return nums.every((n) => source.includes(n)) ? guide : '';
}

module.exports = { candidates, openAccessIds, listArticle, parseFigures, imageKey, articleFigures, groundedRead, BUCKET, LOW_VALUE };
