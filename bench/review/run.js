'use strict';
// Live (or fake) run of the AI-writing review on the review benchmark (PREREGISTRATION.md, version 4).
//
//   node bench/review/run.js --system S0 --split dev --fake                 free pipeline check, numbers mean nothing
//   node bench/review/run.js --system S0 --split dev --yes-spend            S0 = the shipped review (git HEAD f41450c), Sonnet
//   node bench/review/run.js --system S2 --split dev --yes-spend            S2 = the working tree's prompt (agent C), Sonnet
//   node bench/review/run.js --system S0 --split holdout --ids a,b --model claude-opus-5-5 --yes-spend   the Opus direction check
//
// S0 runs the code of git HEAD from an extracted copy (--code-dir, made by `git archive HEAD server shared package.json`), so
// the working tree can change without changing S0. S2 runs the working tree (--code-dir omitted). S1 is not a run: it is the
// S0 replies scored with the candidate document scores (bench/review/analyze.js).
//
// USES MODEL CREDITS unless --fake. Every paid call is added to <team>/calls.jsonl, replies are cached by code version,
// prompt, model and text, and the run stops before the budget is exceeded. Codex is never used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const RESULTS = path.join(L.ROOT, 'bench', 'results');

/** A short label of the code under test: hashes of the files that decide what the model is asked and how replies are read. */
function codeVersion(dir) {
  const files = ['server/checks/aiscore.js', 'server/checks/text.js', 'server/prompts.js'];
  const h = files.map((f) => L.sha(fs.readFileSync(path.join(dir, f))).slice(0, 12));
  return `${path.resolve(dir) === L.ROOT ? 'tree' : 'dir'}:${h.join('.')}`;
}

/** The candidate scores of a report, from the working tree's documentScores() (a function of per-sentence ratings only). */
function docScores(report) {
  return require('../../server/checks/aiscore').documentScores({ sentences: report.sentences, eligibleWords: report.eligibleWords, overall: report.overall });
}

/** Fixed fake replies for --fake: deterministic from the sentence text, valid JSON, no model involved. */
function fakeReply(prompt) {
  const sents = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: +m[1], text: m[2] }));
  const spans = sents.map((s) => ({ from: s.n, to: s.n, ai: 10 + (parseInt(L.sha(s.text).slice(0, 4), 16) % 80), why: 'fake rating for the pipeline check' }));
  return JSON.stringify({ summary: 'fake', spans, issues: [] });
}

async function main() {
  const system = String(arg('system', ''));
  const split = String(arg('split', ''));
  if (!['S0', 'S2'].includes(system) || !['dev', 'holdout'].includes(split)) throw new Error('Use --system S0|S2 --split dev|holdout.');
  const fake = !!arg('fake', false);
  const model = String(arg('model', 'claude-sonnet-5-5'));
  if (!L.ALLOWED_MODELS[model]) throw new Error(`Model ${model} is not allowed (only ${Object.keys(L.ALLOWED_MODELS).join(', ')}).`);
  const team = String(arg('team', process.env.LECTERN_TEAM_DIR || L.DEFAULT_TEAM));
  const agent = String(arg('agent', 'B'));
  const codeDir = path.resolve(String(arg('code-dir', L.ROOT)));
  if (system === 'S0' && codeDir === L.ROOT && !fake) throw new Error('S0 is the shipped review: pass --code-dir <folder with the git HEAD copy of server/>.');
  if (split === 'holdout' && !fake && !fs.existsSync(path.join(RESULTS, 'review-frozen.json'))) {
    throw new Error('The holdout is run only after the development choice is frozen (node bench/review/analyze.js dev --freeze).');
  }
  const idList = arg('ids', null) ? String(arg('ids')).split(',') : null;
  const limit = Number(arg('limit', 0)) || Infinity;

  let items = fs.readFileSync(path.join(L.DATA, `${split}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  if (idList) items = items.filter((x) => idList.includes(x.id));
  items = items.slice(0, limit);
  if (!items.length) throw new Error('No documents selected.');
  if (!fake && !arg('yes-spend', false)) {
    throw new Error(`This run may send up to ${items.length} documents to ${model} (about one request each) on the owner's Claude plan. Add --yes-spend to confirm, or --fake to test the pipeline.`);
  }
  if (!fake) L.checkBudget(team, agent, model, 0); // fail early on a bad team folder or model

  const { runAiCheck, SCORING } = require(path.join(codeDir, 'server', 'checks', 'aiscore'));
  const T = require(path.join(codeDir, 'server', 'checks', 'text'));
  const llm = require(path.join(codeDir, 'server', 'llm'));
  const { Config } = require(path.join(codeDir, 'server', 'config'));
  const aiscore = require(path.join(codeDir, 'server', 'checks', 'aiscore'));
  const version = codeVersion(codeDir);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-review-bench-'));
  const settings = L.guardedSettings(new Config(dir).get(), { model, claudeBin: fake ? path.join(L.ROOT, 'test', 'fakes', 'claude') : undefined });
  const config = L.guardedConfig(settings);
  const stats = { cached: 0, paid: 0 };
  const purpose = `review bench ${system} ${split}${idList ? ' subset' : ''}`;
  const outFile = path.join(L.DATA, 'runs', `${system}-${split}-${model}${idList ? '-subset' : ''}${fake ? '-fake' : ''}.jsonl`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const done = new Map();
  if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.id, r); }

  const rows = [];
  for (const it of items) {
    if (done.has(it.id)) { rows.push(done.get(it.id)); continue; } // resumable: a finished document is not run again
    const textHash = L.sha(it.text);
    const batchCount = aiscore.batches(aiscore.measure(T.capWords(T.normalizeText(it.text)).text).prose).length;
    const real = fake ? async (o) => ({ text: fakeReply(o.prompt), model: o.model, usage: {} }) : (o) => llm.complete(o);
    const complete = L.guardedComplete({ real, model, codeVersion: version, textHash, teamDir: team, agent, purpose, fake, stats });
    const t0 = Date.now();
    let row;
    try {
      const r = await runAiCheck({ text: it.text, config, engine: 'claude-code', selectedModel: model, complete });
      row = {
        id: it.id, system, split, model, codeVersion: version, batches: batchCount,
        // Scores are computed explicitly from the per-sentence ratings with the working tree's documentScores(), so they do not depend on what
        // the code under test calls its `score` (S0, the HEAD copy, reports the strong share; the shipped code now reports the mean rating).
        score: docScores(r).strongShare, strongShare: docScores(r).strongShare, meanRating: docScores(r).meanRating, reportScore: r.score, reportFlagged: r.flagged == null ? null : r.flagged,
        overall: r.overall == null ? null : r.overall, scoreWithheld: r.scoreWithheld, status: r.status, coverage: r.coverage, eligibleWords: r.eligibleWords, reviewedWords: r.reviewedWords,
        bands: r.bands, reported: r.provenance.reportedModels,
        // per-sentence ratings (numbers only), and the raw reply of each batch from the cache
        sentences: r.sentences.filter((s) => s.eligible).map((s) => ({ i: s.i, words: s.words, rating: s.rating, review: s.review, why: s.why })),
        ms: Date.now() - t0,
      };
      if (!fake && r.provenance.reportedModels.some((m) => !m.toLowerCase().startsWith(model))) throw Object.assign(new Error(`Reported model ${r.provenance.reportedModels} is not ${model}.`), { fatal: true });
    } catch (e) {
      if (e.fatal || /Budget:/.test(e.message)) { console.error(`\nStopped: ${e.message}`); process.exitCode = 2; break; }
      row = { id: it.id, system, split, model, codeVersion: version, batches: batchCount, score: null, status: 'error', error: e.message, sentences: [], ms: Date.now() - t0 };
    }
    if (row.status === 'unavailable' && /Budget:|Refusing|provider reported model/.test(row.scoreWithheld || '')) { console.error(`\nStopped: ${row.scoreWithheld}`); process.exitCode = 2; break; }
    // Documents with no usable review are not written to the resume file, so a later run tries them again (a reply that
    // arrived is cached, so trying again costs nothing unless the call itself failed).
    if (row.status !== 'unavailable' && row.status !== 'error') fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
    rows.push(row);
    process.stdout.write(`\r${rows.length}/${items.length} (paid ${stats.paid}, cached ${stats.cached})`);
  }
  process.stdout.write('\n');
  if (!rows.length) { process.exitCode = 2; console.error('No document was reviewed, so no result file was written.'); return; }
  const byId = new Map(items.map((x) => [x.id, x]));
  const summary = {
    system, split, model, codeVersion: version, fake, finishedAt: new Date().toISOString(), scoringVersion: SCORING.version,
    calls: { paid: stats.paid, cached: stats.cached, resumed: rows.length - stats.paid - stats.cached },
    rows: rows.map((r) => { const it = byId.get(r.id) || {}; const { why, ...rest } = r; return { ...rest, label: it.label, source: it.source, writer: it.writer, words: it.words, sentences: (r.sentences || []).map(({ i, words, rating, review }) => ({ i, words, rating, review })) }; }),
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  const name = `review-${system}-${split}-${model}${idList ? '-subset' : ''}${fake ? '-fake' : ''}.json`;
  fs.writeFileSync(path.join(RESULTS, name), JSON.stringify(summary));
  const ok = rows.filter((r) => r.score != null).length;
  console.log(`${system} ${split} ${model}: ${rows.length} documents, ${ok} scored, ${rows.length - ok} without a score. Calls paid ${stats.paid}, from cache ${stats.cached}.`);
  console.log(`Written: bench/results/${name}; per-sentence ratings with reasons: ${path.relative(L.ROOT, outFile)} (git-ignored).`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { codeVersion, fakeReply };
