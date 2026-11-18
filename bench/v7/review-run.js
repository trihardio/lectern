'use strict';
// Live (or fake) run of the AI-writing review for version 7 (agent S, see bench/PREREGISTRATION.md "Version 7").
//
//   node bench/v7/review-run.js --system b0 --split dev --review-set --fake              free pipeline check, numbers mean nothing
//   node bench/v7/review-run.js --system b0 --split dev --review-set --yes-spend         shipped prompt (B0) on the dev review subset
//   node bench/v7/review-run.js --system r1 --split dev --review-set --yes-spend         the one revised prompt (R1)
//   node bench/v7/review-run.js --system b0 --split holdout --review-set --yes-spend     holdout review subset (needs bench/results/review7-frozen.json)
//
// USES MODEL CREDITS unless --fake. Claude Code only: settings are forced to claude-code, the codex program points at
// nothing, and every call is refused unless engine is claude-code and the model is claude-sonnet-5-5. A paid run needs
// --review-set (so a whole split is never sent by accident). Budget (agent S): 80 claude-sonnet-5-5 calls, checked against
// TEAM/calls.jsonl before every call; every paid call is logged there. Replies are cached by model, effort, run number,
// prompt hash and text hash, so nothing is paid for twice; each call is made once. Result rows hold ids, labels and scores, never text.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'v7');
const TEAM = '/tmp/lectern-sessions/5ae58c7f-e18b-489a-9c97-a66cd37bbd2d/scratchpad/team-v7';
const CALLS = path.join(TEAM, 'calls.jsonl');
const AGENT = 'S';
const SHARE = Object.freeze({ 'claude-sonnet-5-5': 80 });
const TEAM_TOTAL = Object.freeze({ 'claude-sonnet-5-5': 80 }); // Haiku has its own 60 (agent H); no Opus

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

function readCalls() {
  if (!fs.existsSync(CALLS)) return [];
  return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
}
/** Calls used so far: by this agent, and by the whole team, on one model. A line without "calls" counts as one call. */
function spent(model, rows = readCalls()) {
  const n = (r) => (Number.isFinite(Number(r.calls)) && r.calls != null ? Number(r.calls) : 1);
  const own = rows.filter((r) => r.agent === AGENT && r.model === model).reduce((s, r) => s + n(r), 0);
  const team = rows.filter((r) => r.model === model).reduce((s, r) => s + n(r), 0);
  return { own, team };
}
/** Throws when one more call on `model` would pass this agent's share or the team total. */
function checkBudget(model, inflight = 0, rows = readCalls(), share = SHARE, total = TEAM_TOTAL) {
  if (!share[model]) throw Object.assign(new Error(`Model ${model} is not allowed (only ${Object.keys(share).join(', ')}).`), { fatal: true });
  const s = spent(model, rows);
  if (s.own + inflight + 1 > share[model]) throw Object.assign(new Error(`Budget: agent ${AGENT} has used ${s.own + inflight} of ${share[model]} ${model} calls.`), { fatal: true });
  if (s.team + inflight + 1 > total[model]) throw Object.assign(new Error(`Budget: the team has used ${s.team + inflight} of ${total[model]} ${model} calls.`), { fatal: true });
}

const cacheDir = (fake) => path.join(DATA, fake ? 'reply-cache-fake' : 'reply-cache');
function cached(key, fake) { try { return JSON.parse(fs.readFileSync(path.join(cacheDir(fake), `${key}.json`), 'utf8')); } catch { return null; } }
function store(key, entry, fake) { fs.mkdirSync(cacheDir(fake), { recursive: true }); fs.writeFileSync(path.join(cacheDir(fake), `${key}.json`), JSON.stringify(entry)); }
const cacheKey = ({ model, effort, run, system, prompt, textHash }) => sha(JSON.stringify([model, effort || '', run, sha(system), sha(prompt), textHash]));

/** The model call handed to runAiCheck: Claude Code only, the one model, the budget, the cache, the provider's reported model. */
function guarded({ real, model, run, textId, textHash, system: label, fake, stats }) {
  return async (o) => {
    if (o.engine !== 'claude-code') throw Object.assign(new Error(`Refusing engine "${o.engine}": only claude-code is allowed.`), { fatal: true });
    if (o.model !== model) throw Object.assign(new Error(`Refusing model "${o.model}": this run is fixed to ${model}.`), { fatal: true });
    const key = cacheKey({ model, effort: o.effort, run, system: o.system, prompt: o.prompt, textHash });
    const hit = cached(key, fake);
    if (hit) { stats.cached++; return { text: hit.text, model: hit.reportedModel, usage: hit.usage || {}, webResults: [] }; }
    if (!fake) checkBudget(model, stats.inflight); // synchronous with the increment below, so parallel parts cannot overshoot
    stats.inflight++;
    let out;
    let err;
    try { out = await real(o); } catch (e) { err = e; }
    stats.inflight--;
    if (!fake) fs.appendFileSync(CALLS, `${JSON.stringify({ agent: AGENT, model, purpose: `review ${label} run ${run}`, id: textId, t: new Date().toISOString(), ...(err ? { error: String(err.message || err).slice(0, 160) } : {}) })}\n`);
    if (err) throw err;
    const reported = out && typeof out.model === 'string' ? out.model : null;
    if (!fake && (!reported || !reported.toLowerCase().startsWith(model))) throw Object.assign(new Error(`Provider reported "${reported}", not ${model}. Stopping.`), { fatal: true });
    stats.paid++;
    store(key, { model, run, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() }, fake);
    return out;
  };
}

function fakeReply(prompt) {
  const sents = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: +m[1], text: m[2] }));
  return JSON.stringify({ summary: 'fake', spans: sents.map((s) => ({ from: s.n, to: s.n, ai: 10 + (parseInt(sha(s.text).slice(0, 4), 16) % 80), why: 'fake rating' })), issues: [] });
}

async function main() {
  const system = String(arg('system', ''));
  if (!['b0', 'r1'].includes(system)) throw new Error('Use --system b0 (the shipped version 6 prompt) or --system r1 (the one revised version 7 prompt).');
  const split = String(arg('split', ''));
  if (!['dev', 'holdout', 'all'].includes(split)) throw new Error('Use --split dev|holdout|all.');
  const fake = !!arg('fake', false);
  const model = String(arg('model', 'claude-sonnet-5-5'));
  if (!SHARE[model]) throw new Error(`Model ${model} is not allowed (only ${Object.keys(SHARE).join(', ')}).`);
  const run = Number(arg('run', 1)) || 1;
  const concurrency = Math.max(1, Math.min(4, Number(arg('concurrency', 3)) || 3));
  const ids = arg('ids', null) ? String(arg('ids')).split(',') : null;
  if (!fake && !arg('review-set', false)) throw new Error('A paid run needs --review-set: only the fixed review subset is ever sent to the model.');
  const maxTexts = arg('max-texts', null) ? Number(arg('max-texts')) : null;
  const corpusFile = path.resolve(String(arg('corpus', path.join(DATA, 'corpus.jsonl'))));
  let items = fs.readFileSync(corpusFile, 'utf8').trim().split('\n').map(JSON.parse);
  if (split !== 'all') items = items.filter((x) => x.split === split);
  if (arg('review-set', false)) items = items.filter((x) => x.review); // the holdout review set fixed in holdout.sha256
  if (ids) items = items.filter((x) => ids.includes(x.id));
  if (items.some((x) => x.split === 'holdout') && !fake) require('./review-freeze').assertFrozen(); // no holdout call before the freeze file exists and everything still matches it
  if (maxTexts) items = items.slice(0, maxTexts);
  if (!items.length) throw new Error('No texts selected.');
  if (!fake && !arg('yes-spend', false)) throw new Error(`This run may send up to ${items.length} texts to ${model} on the owner's Claude plan. Add --yes-spend, or --fake.`);
  if (!fake) { const s = spent(model); console.warn(`${model}: agent S has used ${s.own} of ${SHARE[model]}, the team ${s.team} of ${TEAM_TOTAL[model]}. Cached texts cost nothing; a run stops at the budget.`); }

  const Prompts = require(path.join(ROOT, 'server', 'prompts'));
  Prompts.AI_REVIEW_SYSTEM = require('./review-prompts')[system === 'r1' ? 'R1_SYSTEM' : 'B0_SYSTEM']; // aiscore.js reads it at call time
  const aiscore = require(path.join(ROOT, 'server', 'checks', 'aiscore'));
  const llm = require(path.join(ROOT, 'server', 'llm'));
  const { Config } = require(path.join(ROOT, 'server', 'config'));
  const L = require(path.join(ROOT, 'bench', 'review', 'lib'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-review7-'));
  const settings = L.guardedSettings(new Config(tmp).get(), { model, claudeBin: fake ? path.join(ROOT, 'test', 'fakes', 'claude') : undefined });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');
  const config = L.guardedConfig(settings);
  const stats = { cached: 0, paid: 0, inflight: 0 };
  const tag = `${system}-${split}-${model}-r${run}${ids ? '-subset' : ''}${maxTexts ? `-max${maxTexts}` : ''}${fake ? '-fake' : ''}`;
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
      const complete = guarded({ real, model, run, textId: it.id, textHash: sha(it.text), system, fake, stats });
      const t0 = Date.now();
      let row;
      try {
        const r = await aiscore.runAiCheck({ text: it.text, config, engine: 'claude-code', selectedModel: model, complete });
        const ds = aiscore.documentScores({ sentences: r.sentences, eligibleWords: r.eligibleWords, overall: r.overall });
        row = {
          id: it.id, system, run, model, status: r.status, coverage: r.coverage, eligibleWords: r.eligibleWords, reviewedWords: r.reviewedWords,
          reportScore: r.score, reportFlagged: r.flagged == null ? null : r.flagged, reportScoreExact: r.scoreExact, styleScore: r.headline ? r.headline.styleScore : null, styleFlagged: r.style ? r.style.flagged : null, scoreWithheld: r.scoreWithheld || '', overall: r.overall == null ? null : r.overall, ...ds,
          reported: r.provenance && r.provenance.reportedModels,
          sentences: r.sentences.filter((s) => s.eligible).map((s) => ({ i: s.i, words: s.words, rating: s.rating, review: s.review, why: s.why })),
          ms: Date.now() - t0,
        };
        if (!fake && /Budget:|Refusing|Provider reported/.test(row.scoreWithheld)) { stop = row.scoreWithheld; break; }
      } catch (e) {
        if (e.fatal) { stop = e.message; break; }
        row = { id: it.id, system, run, model, status: 'error', error: String(e.message || e).slice(0, 300), sentences: [], ms: Date.now() - t0 };
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
    version: 7, system, split, run, model, fake, finishedAt: new Date().toISOString(), scoringVersion: aiscore.SCORING.version, flagAt: aiscore.SCORING.flagAt,
    promptSha256: sha(Prompts.AI_REVIEW_SYSTEM),
    calls: { paid: stats.paid, cached: stats.cached, ...(fake ? {} : { used: spent(model), share: SHARE[model] }) },
    rows: rows.map(({ sentences, why, ...r }) => { const it = byId.get(r.id) || {}; return { ...r, label: it.label, split: it.split, source: it.source, words: it.words, sentences: (sentences || []).map(({ i, words, rating, review }) => ({ i, words, rating, review })) }; }),
  };
  fs.writeFileSync(path.join(DATA, 'runs', `${tag}.result.json`), JSON.stringify(out));
  const ok = rows.filter((r) => r.meanRating != null).length;
  console.log(`${tag}: ${rows.length} texts, ${ok} scored. Paid ${stats.paid}, cached ${stats.cached}.`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { SHARE, TEAM_TOTAL, spent, checkBudget, guarded, cacheKey, sha };
