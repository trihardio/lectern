'use strict';
// Shared parts of the live review benchmark (PREREGISTRATION.md, version 4): the rules about Codex and models, the
// call budget, the reply cache, and the document-level scores computed from per-sentence ratings.
// Nothing here talks to a model by itself; bench/review/run.js passes in a `complete` function.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'review');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- team budget (the owner approved "Standard" for this task; see the team brief)
const DEFAULT_TEAM = '/tmp/lectern-sessions/5ae58c7f-e18b-489a-9c97-a66cd37bbd2d/scratchpad/team-ai';
const ALLOWED_MODELS = Object.freeze({
  'claude-sonnet-5-5': { agentLimit: 190, teamLimit: 200 },
  'claude-opus-5-5': { agentLimit: 16, teamLimit: 20 },
});

/** Read calls.jsonl and add up the calls per model, for one agent and for the whole team. */
function readSpent(teamDir, agent) {
  const file = path.join(teamDir, 'calls.jsonl');
  const out = { agent: {}, team: {}, lines: 0 };
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const n = Number(r.calls) || 0;
    out.lines++;
    out.team[r.model] = (out.team[r.model] || 0) + n;
    if (r.agent === agent) out.agent[r.model] = (out.agent[r.model] || 0) + n;
  }
  return out;
}

/** Would `n` more calls on `model` stay inside this agent's allocation and the team total? Throws with the reason if not. */
function checkBudget(teamDir, agent, model, n, limits = ALLOWED_MODELS) {
  const lim = limits[model];
  if (!lim) throw new Error(`Model ${model} is not allowed for this task (only ${Object.keys(limits).join(' and ')}).`);
  const s = readSpent(teamDir, agent);
  const mine = s.agent[model] || 0;
  const team = s.team[model] || 0;
  if (mine + n > lim.agentLimit) throw new Error(`Budget: agent ${agent} has used ${mine} of ${lim.agentLimit} ${model} calls; ${n} more would exceed it.`);
  if (team + n > lim.teamLimit) throw new Error(`Budget: the team has used ${team} of ${lim.teamLimit} ${model} calls; ${n} more would exceed it.`);
  return { mine, team };
}

function logCall(teamDir, agent, model, purpose, extra = {}) {
  fs.mkdirSync(teamDir, { recursive: true });
  fs.appendFileSync(path.join(teamDir, 'calls.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), agent, model, calls: 1, purpose, ...extra })}\n`);
}

// ---- Codex guard (standing rule: never spend the owner's ChatGPT plan)
/** Settings for a benchmark run: Claude Code only, Codex pointed at nothing. Never saved to the owner's settings file. */
function guardedSettings(baseSettings, { model, claudeBin } = {}) {
  const s = JSON.parse(JSON.stringify(baseSettings));
  s.engine = 'claude-code';
  s.bins = { ...(s.bins || {}), codex: '/nonexistent/codex' };
  if (claudeBin) s.bins.claude = claudeBin;
  s.models = { ...(s.models || {}), 'claude-code': model };
  return s;
}
const guardedConfig = (settings) => ({ get: () => settings, update() { throw new Error('The benchmark never changes settings.'); } });

// ---- reply cache: one file per call, so a call is never paid twice
/** The cache key: code version, model, effort, prompt hash and text hash. */
function cacheKey({ codeVersion, model, effort, system, prompt, textHash }) {
  return sha(JSON.stringify([codeVersion, model, effort || '', sha(system), sha(prompt), textHash]));
}
const cacheDir = (fake) => path.join(DATA, fake ? 'reply-cache-fake' : 'reply-cache');
function cacheGet(key, fake) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir(fake), `${key}.json`), 'utf8')); } catch { return null; }
}
function cachePut(key, entry, fake) {
  fs.mkdirSync(cacheDir(fake), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(fake), `${key}.json`), JSON.stringify(entry));
}

/**
 * Wrap a model call for runAiCheck's `complete` option. Enforces: Claude Code only, the model asked for, the budget,
 * the cache, a log line per paid call, and a check of the model the provider reports.
 * `real` is the function that really calls the model (llm.complete from the code folder under test).
 */
function guardedComplete({ real, model, codeVersion, textHash, teamDir, agent, purpose, fake = false, stats }) {
  return async (o) => {
    if (o.engine !== 'claude-code') throw new Error(`Refusing to use engine "${o.engine}": only claude-code is allowed here.`);
    if (o.model !== model) throw new Error(`Refusing to call model "${o.model}": this run is fixed to ${model}.`);
    const key = cacheKey({ codeVersion, model, effort: o.effort, system: o.system, prompt: o.prompt, textHash });
    const hit = cacheGet(key, fake);
    if (hit) { stats.cached++; return { text: hit.text, model: hit.reportedModel, usage: hit.usage || {}, webResults: [] }; }
    if (!fake) checkBudget(teamDir, agent, model, 1);
    let out;
    let err;
    try { out = await real(o); } catch (e) { err = e; }
    if (!fake) logCall(teamDir, agent, model, purpose, err ? { error: String(err.message || err).slice(0, 120) } : {}); // a failed call may still have been charged
    if (err) throw err;
    const reported = out && typeof out.model === 'string' ? out.model : null;
    if (!fake && (!reported || !reported.toLowerCase().startsWith(model))) {
      const e = new Error(`The provider reported model "${reported}" but ${model} was requested. Stopping.`);
      e.fatal = true;
      throw e;
    }
    stats.paid++;
    cachePut(key, { key, codeVersion, model, effort: o.effort || '', textHash, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() }, fake);
    return out;
  };
}

// ---- document-level scores from per-sentence ratings
/**
 * Provisional candidate scores (bench-side definitions, used until the app's own `documentScores()` exists).
 * `sentences`: [{ words, rating }] of the reviewed sentences only. Returns a number per score name, or null.
 * All are on a 0-100 scale; higher means more AI-like. headline65 is exactly the shipped headline.
 */
function provisionalScores(sentences) {
  const s = sentences.filter((x) => x.rating != null && x.words > 0);
  const total = s.reduce((n, x) => n + x.words, 0);
  if (!s.length || !total) return null;
  const share = (t) => (100 * s.filter((x) => x.rating >= t).reduce((n, x) => n + x.words, 0)) / total;
  const wmean = s.reduce((n, x) => n + x.rating * x.words, 0) / total;
  const sorted = s.map((x) => x.rating).sort((a, b) => b - a);
  const top = sorted.slice(0, Math.min(3, sorted.length));
  // word-weighted quantile: the rating below which a fraction q of the words lie
  const byRating = [...s].sort((a, b) => a.rating - b.rating);
  const quant = (q) => { let acc = 0; for (const x of byRating) { acc += x.words; if (acc >= q * total) return x.rating; } return byRating[byRating.length - 1].rating; };
  return {
    headline65: Math.round(share(65)), share50: share(50), share40: share(40), meanRating: wmean,
    medianRating: quant(0.5), p75Rating: quant(0.75), top3Mean: top.reduce((a, b) => a + b, 0) / top.length,
  };
}
const PROVISIONAL_SCORE_NAMES = ['headline65', 'share50', 'share40', 'meanRating', 'medianRating', 'p75Rating', 'top3Mean'];

module.exports = {
  ROOT, DATA, DEFAULT_TEAM, ALLOWED_MODELS, sha,
  readSpent, checkBudget, logCall, guardedSettings, guardedConfig,
  cacheKey, cacheGet, cachePut, guardedComplete,
  provisionalScores, PROVISIONAL_SCORE_NAMES,
};
