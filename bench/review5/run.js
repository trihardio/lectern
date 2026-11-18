'use strict';
// Live (or fake) run of the AI-writing review on the version 5 corpus (bench/PREREGISTRATION.md, version 5).
//
//   node bench/review5/run.js --split all --fake                              free pipeline check, numbers mean nothing
//   node bench/review5/run.js --split all --yes-spend                         the working tree's review, claude-sonnet-5-5
//   node bench/review5/run.js --split dev --variant v1 --code-dir <copy> --yes-spend   a prompt variant from a copy of the code
//   node bench/review5/run.js --split test --ids a,b --model claude-opus-5-5 --yes-spend   the Opus spot check
//
// USES MODEL CREDITS unless --fake: one request per text, on the owner's Claude plan, through Claude Code only. Codex is
// never used (settings are forced to claude-code and the codex program is pointed at nothing). Every paid call is
// logged in bench/data/review5/calls.jsonl; the run stops before the version 5 budget would be exceeded. Replies are
// cached by code version, model, prompt and text, so no text is paid for twice.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('../review/lib');
const { DATA } = require('./plan');

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'bench', 'results');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

// The version 5 budget for review calls (agents' own work is not counted here).
const BUDGET = Object.freeze({ 'claude-sonnet-5-5': 270, 'claude-opus-5-5': 12 });
const CALLS = path.join(DATA, 'calls.jsonl');

function spent(model) {
  if (!fs.existsSync(CALLS)) return 0;
  return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.model === model).reduce((n, r) => n + (Number(r.calls) || 0), 0);
}

function codeVersion(dir) {
  const files = ['server/checks/aiscore.js', 'server/checks/text.js', 'server/prompts.js'];
  return `${path.resolve(dir) === ROOT ? 'tree' : 'dir'}:${files.map((f) => sha(fs.readFileSync(path.join(dir, f))).slice(0, 12)).join('.')}`;
}

const cacheDir = (fake) => path.join(DATA, fake ? 'reply-cache-fake' : 'reply-cache');
function cached(key, fake) { try { return JSON.parse(fs.readFileSync(path.join(cacheDir(fake), `${key}.json`), 'utf8')); } catch { return null; } }
function store(key, entry, fake) { fs.mkdirSync(cacheDir(fake), { recursive: true }); fs.writeFileSync(path.join(cacheDir(fake), `${key}.json`), JSON.stringify(entry)); }

/** A model call for runAiCheck: Claude Code only, the one model asked for, the budget, the cache, the provider's reported model. */
function guarded({ real, model, version, textHash, variant, fake, stats }) {
  return async (o) => {
    if (o.engine !== 'claude-code') throw Object.assign(new Error(`Refusing engine "${o.engine}": only claude-code is allowed.`), { fatal: true });
    if (o.model !== model) throw Object.assign(new Error(`Refusing model "${o.model}": this run is fixed to ${model}.`), { fatal: true });
    const key = sha(JSON.stringify([version, model, o.effort || '', sha(o.system), sha(o.prompt), textHash]));
    const hit = cached(key, fake);
    if (hit) { stats.cached++; return { text: hit.text, model: hit.reportedModel, usage: hit.usage || {}, webResults: [] }; }
    if (!fake) {
      const used = spent(model) + stats.inflight;
      if (used + 1 > BUDGET[model]) throw Object.assign(new Error(`Budget: ${used} of ${BUDGET[model]} ${model} review calls used.`), { fatal: true });
    }
    stats.inflight++;
    let out;
    let err;
    try { out = await real(o); } catch (e) { err = e; }
    stats.inflight--;
    if (!fake) fs.appendFileSync(CALLS, `${JSON.stringify({ t: new Date().toISOString(), model, calls: 1, variant, ...(err ? { error: String(err.message || err).slice(0, 160) } : {}) })}\n`);
    if (err) throw err;
    const reported = out && typeof out.model === 'string' ? out.model : null;
    if (!fake && (!reported || !reported.toLowerCase().startsWith(model))) throw Object.assign(new Error(`Provider reported "${reported}", not ${model}. Stopping.`), { fatal: true });
    stats.paid++;
    store(key, { version, model, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() }, fake);
    return out;
  };
}

function fakeReply(prompt) {
  const sents = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: +m[1], text: m[2] }));
  return JSON.stringify({ summary: 'fake', spans: sents.map((s) => ({ from: s.n, to: s.n, ai: 10 + (parseInt(sha(s.text).slice(0, 4), 16) % 80), why: 'fake rating' })), issues: [] });
}

async function main() {
  const split = String(arg('split', ''));
  if (!['dev', 'test', 'all'].includes(split)) throw new Error('Use --split dev|test|all.');
  const fake = !!arg('fake', false);
  const model = String(arg('model', 'claude-sonnet-5-5'));
  if (!BUDGET[model]) throw new Error(`Model ${model} is not allowed (only ${Object.keys(BUDGET).join(', ')}).`);
  const variant = String(arg('variant', 'shipped'));
  const codeDir = path.resolve(String(arg('code-dir', ROOT)));
  if (variant !== 'shipped' && codeDir === ROOT) throw new Error('A prompt variant runs from a copy of the code: pass --code-dir.');
  const concurrency = Math.max(1, Math.min(4, Number(arg('concurrency', 3)) || 3));
  const ids = arg('ids', null) ? String(arg('ids')).split(',') : null;
  let items = fs.readFileSync(path.join(DATA, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (split !== 'all') items = items.filter((x) => x.split === split);
  if (ids) items = items.filter((x) => ids.includes(x.id));
  if (!items.length) throw new Error('No texts selected.');
  if (!fake && !arg('yes-spend', false)) throw new Error(`This run may send up to ${items.length} texts to ${model} on the owner's Claude plan. Add --yes-spend, or --fake.`);
  if (!fake && spent(model) + items.length > BUDGET[model]) console.warn(`Warning: ${spent(model)} of ${BUDGET[model]} ${model} calls used; cached texts cost nothing, the rest may stop at the budget.`);

  const aiscore = require(path.join(codeDir, 'server', 'checks', 'aiscore'));
  const llm = require(path.join(codeDir, 'server', 'llm'));
  const { Config } = require(path.join(codeDir, 'server', 'config'));
  const version = codeVersion(codeDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-review5-'));
  const settings = L.guardedSettings(new Config(tmp).get(), { model, claudeBin: fake ? path.join(ROOT, 'test', 'fakes', 'claude') : undefined });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');
  const config = L.guardedConfig(settings);
  const stats = { cached: 0, paid: 0, inflight: 0 };
  const tag = `${variant}-${split}-${model}${ids ? '-subset' : ''}${fake ? '-fake' : ''}`;
  const runFile = path.join(DATA, 'runs', `${tag}.jsonl`);
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  const done = new Map();
  if (fs.existsSync(runFile)) for (const l of fs.readFileSync(runFile, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.id, r); }

  const rows = [];
  let stop = null;
  const queue = items.slice();
  async function worker() {
    while (queue.length && !stop) {
      const it = queue.shift();
      if (done.has(it.id)) { rows.push(done.get(it.id)); continue; }
      const real = fake ? async (o) => ({ text: fakeReply(o.prompt), model: o.model, usage: {} }) : (o) => llm.complete(o);
      const complete = guarded({ real, model, version, textHash: sha(it.text), variant, fake, stats });
      const t0 = Date.now();
      let row;
      try {
        const r = await aiscore.runAiCheck({ text: it.text, config, engine: 'claude-code', selectedModel: model, complete });
        const ds = require(path.join(ROOT, 'server', 'checks', 'aiscore')).documentScores({ sentences: r.sentences, eligibleWords: r.eligibleWords, overall: r.overall });
        row = {
          id: it.id, variant, model, codeVersion: version, status: r.status, coverage: r.coverage, eligibleWords: r.eligibleWords, reviewedWords: r.reviewedWords,
          reportScore: r.score, reportFlagged: r.flagged == null ? null : r.flagged, scoreWithheld: r.scoreWithheld || '', overall: r.overall == null ? null : r.overall, ...ds,
          reported: r.provenance && r.provenance.reportedModels,
          sentences: r.sentences.filter((s) => s.eligible).map((s) => ({ i: s.i, words: s.words, rating: s.rating, review: s.review, why: s.why })),
          ms: Date.now() - t0,
        };
        if (!fake && /Budget:|Refusing|Provider reported/.test(row.scoreWithheld)) { stop = row.scoreWithheld; break; }
      } catch (e) {
        if (e.fatal) { stop = e.message; break; }
        row = { id: it.id, variant, model, codeVersion: version, status: 'error', error: String(e.message || e).slice(0, 300), sentences: [], ms: Date.now() - t0 };
      }
      if (row.status !== 'unavailable' && row.status !== 'error') fs.appendFileSync(runFile, `${JSON.stringify(row)}\n`);
      rows.push(row);
      process.stdout.write(`\r${rows.length}/${items.length} (paid ${stats.paid}, cached ${stats.cached})   `);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
  if (stop) { console.error(`Stopped: ${stop}`); process.exitCode = 2; }
  const byId = new Map(items.map((x) => [x.id, x]));
  const out = {
    version: 5, variant, split, model, codeVersion: version, fake, finishedAt: new Date().toISOString(), scoringVersion: aiscore.SCORING.version, flagAt: aiscore.SCORING.flagAt,
    calls: { paid: stats.paid, cached: stats.cached, budgetUsed: spent(model), budget: BUDGET[model] },
    rows: rows.map(({ sentences, ...r }) => { const it = byId.get(r.id) || {}; return { ...r, label: it.label, writer: it.writer, genre: it.genre, style: it.style, source: it.source, domain: it.domain, split: it.split, words: it.words, editShare: it.editShare, sentences: (sentences || []).map(({ i, words, rating, review }) => ({ i, words, rating, review })) }; }),
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, `review5-${tag}.json`), JSON.stringify(out));
  const ok = rows.filter((r) => r.meanRating != null).length;
  console.log(`${tag}: ${rows.length} texts, ${ok} scored. Paid ${stats.paid}, cached ${stats.cached}; ${model} budget used ${spent(model)} of ${BUDGET[model]}.`);
  console.log(`Written: bench/results/review5-${tag}.json (scores, no text); reasons per sentence: ${path.relative(ROOT, runFile)} (git-ignored).`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { BUDGET, codeVersion, guarded, spent, CALLS };
