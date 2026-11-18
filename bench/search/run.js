'use strict';
// Run Lectern's real search (searchAll, merge, enrich, rank through gather) on a split of the question set, and score
// the ranked list against the gold papers. Read README.md first; PREREGISTRATION.md fixes the metrics and rules.
//
//   node bench/search/run.js --split dev --queries keywords --label base --use-saved-keys
//   node bench/search/run.js --split dev --queries file:bench/search/data/plans/x.json --label x --offline
//
// Options
//   --split dev|holdout        which questions (default dev). The holdout runs once, when the project lead says go.
//   --queries keywords         pipeline.keywords(question): one query, no model (the reference baseline)
//   --queries fallback         pipeline.fallbackQueries(question): the no-model path the app uses when the planner fails
//   --queries file:<path>      recorded planner output: {"version":1,"label":"...","plans":{"<id>":{"queries":[...]}}}
//   (There is no live-planner mode: the owner ruled out model calls from this runner. Planner output is recorded by
//   whoever runs the planner and replayed here with file:<path>.)
//   --label <name>             names the files in results/ (required)
//   --sources a,b,c            databases to switch on (default openalex,semanticscholar,crossref = the owner's setting)
//   --use-saved-keys           use the owner's saved OpenAlex and Semantic Scholar keys, in memory only
//   --offline                  replay from the cache; a request not in the cache fails the run (exit 2)
//   --keyless                  with --offline: take the keyless code path (default offline takes the keyed path,
//                              because the recorded runs used keys)
//   --limit N / --ids a,b      only the first N questions / only these ids
//   --depth N                  how many ranked papers to keep per question in the lists file (default 100)
//   --code-dir <folder>        load server/sources and server/pipeline from this folder instead of the working tree, for
//                              running an OLD version of the code read-only. Make the folder with
//                              git archive <commit> server shared package.json | tar -x -C <empty folder>
//                              (package.json is needed because server/util.js reads the version from it).
//   --code-commit <sha>        recorded in the run's meta with --code-dir (git archive does not carry it)
//   --max-live N               stop if this process would send more than N live requests (default 500)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const http = require('./http');
const { makeSettings, keyStatus, DEFAULT_SOURCES } = require('./settings');
const M = require('./metrics');
const { renderSummary } = require('./report');

const DATA = path.join(__dirname, 'data');
const RESULTS = path.join(__dirname, 'results');
const KS = [25, 40];
const REPO = path.join(__dirname, '..', '..');

function args(argv) {
  const a = { split: 'dev', queries: 'keywords', sources: DEFAULT_SOURCES, depth: 100, maxLive: 500 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value.`); return v; };
    if (k === '--split') a.split = val();
    else if (k === '--queries') a.queries = val();
    else if (k === '--label') a.label = val();
    else if (k === '--sources') a.sources = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--use-saved-keys') a.useSavedKeys = true;
    else if (k === '--offline') a.offline = true;
    else if (k === '--keyless') a.keyless = true;
    else if (k === '--limit') a.limit = Number(val());
    else if (k === '--ids') a.ids = val().split(',');
    else if (k === '--depth') a.depth = Number(val());
    else if (k === '--max-live') a.maxLive = Number(val());
    else if (k === '--code-dir') a.codeDir = val();
    else if (k === '--code-commit') a.codeCommit = val();
    else throw new Error(`Unknown option ${k}.`);
  }
  if (!a.label || !/^[\w.-]+$/.test(a.label)) throw new Error('--label is required (letters, digits, dot, dash, underscore).');
  if (!['dev', 'holdout'].includes(a.split)) throw new Error('--split must be dev or holdout.');
  if (a.useSavedKeys && a.offline) throw new Error('--use-saved-keys is for live runs; offline replay needs no key.');
  if (!a.offline && !a.useSavedKeys && process.env.BENCH_ALLOW_KEYLESS !== '1') {
    throw new Error('A live run needs --use-saved-keys (keyless OpenAlex is limited to one query and a tiny daily allowance, so it would not match the app). Set BENCH_ALLOW_KEYLESS=1 to run keyless on purpose.');
  }
  return a;
}

function readQuestions(split, a) {
  const file = path.join(DATA, `${split}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. Build it with fetch.js, reviews.js and build.js (see README.md).`);
  let qs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const q of qs) if (!q.goldItems) q.goldItems = (q.gold || []).map((d) => ({ doi: d, title: '' }));
  if (a.ids) qs = qs.filter((q) => a.ids.includes(q.id));
  if (a.limit > 0) qs = qs.slice(0, a.limit);
  return qs;
}

function codeVersion(root, declared) {
  const files = ['server/sources/index.js', 'server/sources/relevance.js', 'server/sources/openalex.js', 'server/sources/semanticscholar.js', 'server/sources/crossref.js', 'server/sources/europepmc.js', 'server/sources/common.js', 'server/pipeline.js', 'server/prompts.js'];
  const hashes = {};
  for (const f of files) { try { hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex').slice(0, 12); } catch { /* optional file */ } }
  let commit = '';
  if (declared) commit = declared;
  else { try { commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ } }
  return { commit, fileHashes: hashes, codeDir: root === REPO ? '' : root };
}

async function planFor(a, q, ctx) {
  const pipeline = require(path.join(ctx.root, 'server', 'pipeline'));
  if (a.queries === 'keywords') return { queries: [pipeline.keywords(q.question)] };
  if (a.queries === 'fallback') {
    if (typeof pipeline.fallbackQueries !== 'function') throw new Error('pipeline.fallbackQueries does not exist in this checkout.');
    return { queries: pipeline.fallbackQueries(q.question) };
  }
  if (a.queries.startsWith('file:')) return ctx.filePlans[q.id] || null;
  throw new Error(`Unknown --queries ${a.queries}.`);
}

async function main() {
  const a = args(process.argv.slice(2));
  const questions = readQuestions(a.split, a);
  const ctx = { filePlans: null, root: a.codeDir ? path.resolve(a.codeDir) : REPO };
  if (a.codeDir && !fs.existsSync(path.join(ctx.root, 'server', 'sources', 'index.js'))) throw new Error(`${ctx.root} has no server/sources/index.js. Build it with: git archive <commit> server shared package.json | tar -x -C <folder>`);
  if (!['keywords', 'fallback'].includes(a.queries) && !a.queries.startsWith('file:')) throw new Error(`Unknown --queries ${a.queries}. Use keywords, fallback or file:<path>.`);
  if (a.queries.startsWith('file:')) {
    const f = JSON.parse(fs.readFileSync(a.queries.slice(5), 'utf8'));
    if (f.version !== 1 || !f.plans) throw new Error('A plans file must be {"version":1,"label":"...","plans":{"<id>":{"queries":[...]}}}.');
    ctx.filePlans = f.plans;
    ctx.planLabel = f.label || '';
  }

  const net = http.install({ offline: !!a.offline, maxLive: a.maxLive });
  const settings = makeSettings({ sources: a.sources, useSavedKeys: !!a.useSavedKeys, assumeKeys: !!a.offline && !a.keyless });
  const Sources = require(path.join(ctx.root, 'server', 'sources'));

  const out = { questions: {}, skipped: [] };
  const lists = {};
  const t0 = Date.now();
  for (const q of questions) {
    const plan = await planFor(a, q, ctx);
    if (!plan || !Array.isArray(plan.queries) || !plan.queries.length) { out.skipped.push(q.id); console.error(`No plan for ${q.id}: skipped.`); continue; }
    const sourceErrors = [];
    const searched = await Sources.searchAll({ queries: plan.queries, filters: {}, settings, onSource: (s) => { if (s.error) sourceErrors.push({ source: s.name, error: s.error }); } });
    const pool = Sources.merge(searched);
    const found = await Sources.gather({ queries: plan.queries, question: q.question, followUp: false, filters: {}, settings, max: a.depth });
    const ranked = found.papers;
    if (sourceErrors.some((e) => /daily stop|--max-live/.test(e.error))) throw new Error(`Run stopped at ${q.id}: ${sourceErrors.find((e) => /daily stop|--max-live/.test(e.error)).error}. Nothing was written; the cache keeps what was fetched, so a re-run continues from here.`);
    const scored = M.questionMetrics({ ranked, pool, lists: searched, gold: q.goldItems, ks: KS });
    out.questions[q.id] = { discipline: q.discipline, source: q.source, queries: plan.queries, complete: !sourceErrors.length, sourceErrors, metrics: scored.metrics, perSource: scored.perSource, goldRanks: scored.ranks };
    const idx = M.goldIndex(q.goldItems);
    lists[q.id] = {
      question: q.question, queries: plan.queries, pool: pool.length,
      ranked: ranked.slice(0, a.depth).map((p, i) => ({ rank: i + 1, doi: p.doi || '', title: p.title, year: p.year, sources: p.sources, gold: (() => { const g = M.matchPaper(p, idx); return g >= 0 ? g : null; })() })),
      goldMissing: q.goldItems.map((g, i) => ({ i, doi: g.doi, title: g.title, rank: scored.ranks[i] })).filter((g) => g.rank === null),
    };
    process.stderr.write(`${q.id.padEnd(34)} recall@25 ${(scored.metrics['recall@25'] * 100).toFixed(0).padStart(3)}%  found-anywhere ${(scored.metrics.foundAnywhere * 100).toFixed(0).padStart(3)}%  pool ${String(pool.length).padStart(3)}${sourceErrors.length ? `  SOURCE ERRORS: ${sourceErrors.map((e) => e.source).join(',')}` : ''}\n`);
  }

  const ids = Object.keys(out.questions);
  const meta = {
    label: a.label, split: a.split, queriesMode: a.queries, planLabel: ctx.planLabel || '', sources: a.sources, keys: keyStatus(settings),
    offline: !!a.offline, keyedPath: !!(settings.keys.openalex || settings.keys.semanticscholar), ks: KS, depth: a.depth,
    n: ids.length, skippedNoPlan: out.skipped, incomplete: ids.filter((i) => !out.questions[i].complete),
    cacheMisses: net.stats.misses.length, liveRequests: net.stats.live, retries: net.stats.retries, openalexCreditsRemaining: net.stats.openalexRemaining, liveByHost: net.stats.byHost, cacheHits: net.stats.hits, modelCalls: 0,
    counters: http.counterSnapshot(), code: codeVersion(ctx.root, a.codeCommit), seconds: Math.round((Date.now() - t0) / 1000), finished: new Date().toISOString(),
  };
  if (a.offline && net.stats.misses.length) {
    console.error(`Offline replay failed: ${net.stats.misses.length} requests were not in the cache. First: ${net.stats.misses[0]}`);
    process.exit(2);
  }
  const summary = M.summarizeRun(out.questions);
  fs.mkdirSync(RESULTS, { recursive: true });
  const base = path.join(RESULTS, a.label);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, summary, questions: out.questions }, null, 1) + '\n');
  fs.writeFileSync(`${base}.lists.json`, JSON.stringify(lists));
  fs.writeFileSync(`${base}.plans.json`, JSON.stringify({ version: 1, label: a.label, plans: Object.fromEntries(ids.map((i) => [i, { queries: out.questions[i].queries }])) }, null, 1) + '\n');
  fs.writeFileSync(`${base}.md`, renderSummary(meta, summary));
  console.log(renderSummary(meta, summary));
  if (meta.incomplete.length) { console.error(`${meta.incomplete.length} question(s) had a database error; see "incomplete" in ${base}.json. Do not compare this run until they are re-run.`); process.exit(3); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
