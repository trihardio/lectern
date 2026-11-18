'use strict';
// Why are gold papers not found? For every gold paper that is not in a run's merged pool, ask OpenAlex about it (a
// few batched filter-only requests, through the cache) and sort it into one reason.
//   node bench/search/miss.js --label dev-keywords-base --use-saved-keys
// Writes results/<split>-miss-analysis.md. The reasons, in the order they are tested:
//   ranked below the cut      the paper IS in the pool, but not in the top 25
//   not in OpenAlex           the batch lookup found no record
//   no abstract               OpenAlex has the record but no abstract text, so a search sees only the title
//   query words missing       an abstract exists, but not every query word appears in title + abstract. OpenAlex's
//                             search needs the words together, so synonyms and formal terms cost the paper (approximate:
//                             a word counts as present when its crude stem is; the stem rule is below)
//   words all present         every query word is in title + abstract, so the paper could match; it was outranked by
//                             other results inside the database's one page of results (25 per query)
// No year or other filter was used in these runs, so "outside a filter" cannot occur.
const fs = require('fs');
const path = require('path');
const http = require('./http');
const { makeSettings } = require('./settings');
const { fetchJson } = require('../../server/util');
const STOP = new Set('a an and are as at be by can do does for from how in is it of on or the to what which who why with well often much many'.split(' '));

const RESULTS = path.join(__dirname, 'results');
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
const tokens = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

function abstractOf(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(index)) for (const p of pos) words[p] = w;
  return words.filter((w) => w !== undefined).join(' ');
}

async function main() {
  const argv = process.argv.slice(2);
  const label = argv[argv.indexOf('--label') + 1];
  if (!label || label.startsWith('--')) throw new Error('Usage: node bench/search/miss.js --label <run label> [--use-saved-keys]');
  const run = JSON.parse(fs.readFileSync(path.join(RESULTS, `${label}.json`), 'utf8'));
  const lists = JSON.parse(fs.readFileSync(path.join(RESULTS, `${label}.lists.json`), 'utf8'));
  const qs = new Map(fs.readFileSync(path.join(__dirname, 'data', `${run.meta.split}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((q) => [q.id, q]));
  const net = http.install({});
  const settings = makeSettings({ useSavedKeys: argv.includes('--use-saved-keys') });

  // Every gold paper that is not in the top-ranked list, with where it stands.
  const missing = [];
  for (const [id, rq] of Object.entries(run.questions)) {
    const q = qs.get(id);
    q.goldItems.forEach((g, i) => {
      const rank = rq.goldRanks[i];
      if (rank !== null && rank <= 25) return;
      missing.push({ id, discipline: rq.discipline, source: rq.source, g, rank, queries: rq.queries, question: q.question });
    });
  }
  // Look them up in OpenAlex, by OpenAlex id where the gold has one, else by DOI.
  const select = 'id,doi,display_name,publication_year,abstract_inverted_index,type';
  const byOa = new Map(); const byDoi = new Map();
  const lookup = async (filterName, vals) => {
    for (let i = 0; i < vals.length; i += 50) {
      const q = new URLSearchParams({ filter: `${filterName}:${vals.slice(i, i + 50).join('|')}`, per_page: '50', select });
      if (settings.keys.openalex) q.set('api_key', settings.keys.openalex);
      for (const w of (await fetchJson(`https://api.openalex.org/works?${q}`)).results) {
        byOa.set(String(w.id).split('/').pop().toLowerCase(), w);
        if (w.doi) byDoi.set(String(w.doi).toLowerCase().replace('https://doi.org/', ''), w);
      }
    }
  };
  await lookup('openalex', [...new Set(missing.filter((m) => m.g.oa).map((m) => m.g.oa))]);
  await lookup('doi', [...new Set(missing.filter((m) => !m.g.oa && m.g.doi && !byDoi.has(m.g.doi.toLowerCase())).map((m) => `https://doi.org/${m.g.doi}`))]);

  const classes = ['ranked below the cut', 'not in OpenAlex', 'no abstract', 'query words missing', 'words all present'];
  const count = {}; const examples = {};
  for (const m of missing) {
    const w = (m.g.oa && byOa.get(m.g.oa.toLowerCase())) || (m.g.doi && byDoi.get(m.g.doi.toLowerCase())) || null;
    let cls; let detail = '';
    if (m.rank !== null) cls = classes[0];
    else if (!w) cls = classes[1];
    else {
      const abs = abstractOf(w.abstract_inverted_index);
      if (!abs) cls = classes[2];
      else {
        const have = new Set(tokens(`${w.display_name} ${abs}`).map(stem));
        const words = [...new Set(m.queries.flatMap(tokens))].filter((t) => !STOP.has(t));
        const lacking = words.filter((t) => !have.has(stem(t)));
        if (lacking.length) { cls = classes[3]; detail = lacking.join(', '); } else cls = classes[4];
      }
    }
    m.cls = cls; m.detail = detail; m.title = (w && w.display_name) || m.g.title || m.g.doi;
    for (const key of ['all', m.discipline]) { count[key] = count[key] || Object.fromEntries(classes.map((c) => [c, 0])); count[key][cls]++; }
    (examples[cls] = examples[cls] || []).push(m);
  }

  const L = [`# Miss analysis: ${label}`, '', `Run ${label}: split ${run.meta.split}, ${Object.keys(run.questions).length} questions, queries ${run.meta.queriesMode}. ${missing.length} gold papers are outside the top 25 of ${Object.values(run.questions).reduce((n, q) => n + q.metrics.gold, 0)}. Looked up in OpenAlex with batched filter-only requests (live requests this process: ${net.stats.live}, cache hits ${net.stats.hits}). No filter was applied in the run, so no paper is out of range of a filter.`, '',
    'Reasons, tested in order: see the header of `bench/search/miss.js`. "Query words missing" is approximate: a word counts as present when its crude stem (trailing -ing, -ed, -es, -s removed) is among the stems of the title and abstract.', '',
    `| Group | Gold outside top 25 | ${classes.join(' | ')} |`, `|---|---|${classes.map(() => '---').join('|')}|`];
  for (const key of ['all', ...Object.keys(count).filter((k) => k !== 'all').sort()]) {
    const row = count[key]; const tot = Object.values(row).reduce((a, b) => a + b, 0);
    L.push(`| ${key} | ${tot} | ${classes.map((c) => `${row[c]} (${((row[c] / tot) * 100).toFixed(0)}%)`).join(' | ')} |`);
  }
  // The words that most often keep a paper with an abstract from matching.
  const wordCount = new Map();
  for (const m of examples[classes[3]] || []) for (const w of m.detail.split(', ')) wordCount.set(w, (wordCount.get(w) || 0) + 1);
  const nMissing = (examples[classes[3]] || []).length;
  L.push('', `## Query words missing from title and abstract (${nMissing} papers)`, '', [...wordCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([w, n]) => `${w} (${n})`).join(', '));
  const lackShare = (examples[classes[3]] || []).map((m) => m.detail.split(', ').length);
  if (lackShare.length) L.push('', `Missing words per such paper: mean ${(lackShare.reduce((x, y) => x + y, 0) / lackShare.length).toFixed(1)}; ${lackShare.filter((n) => n === 1).length} papers lack exactly one word.`);
  // Ten short examples, each from a different question, mostly of the "query words missing" kind.
  const used = new Set();
  const take = (cls, n) => (examples[cls] || []).filter((m) => (used.has(m.id) ? false : (used.add(m.id), true))).slice(0, n);
  const pick = [...take(classes[3], 5), ...take(classes[4], 2), ...take(classes[2], 1), ...take(classes[1], 1), ...take(classes[0], 1)];
  L.push('', '## Examples', '');
  for (const m of pick) L.push(`- ${m.cls}${m.detail ? ` (missing: ${m.detail})` : ''}: "${m.title.slice(0, 90)}" for the question "${m.question.slice(0, 90)}"; query: ${m.queries[0]}`);
  fs.writeFileSync(path.join(RESULTS, `${run.meta.split}-miss-analysis.md`), L.join('\n') + '\n');
  console.log(L.slice(0, 14).join('\n'));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
