'use strict';
// Writes the version 6 AI texts planned in data-plan.js, one live request per text, through Claude Code only.
//
//   node bench/v6/data-generate.js --fake                 free check of the pipeline (canned replies, nothing written to texts/)
//   node bench/v6/data-generate.js --ids a,b --yes-spend   write these planned texts
//   node bench/v6/data-generate.js --limit 20 --yes-spend  write the next 20 missing texts
//
// USES MODEL CREDITS unless --fake: runs on the owner's Claude plan. Codex is never used: the settings are forced to
// claude-code and the codex program is pointed at nothing. Agent A's share of the team budget is 120 Haiku/Sonnet calls
// plus 6 Opus calls; every paid call is logged in TEAM/calls.jsonl before the next one starts, and the run stops before
// the share (or the team total) would be passed. Replies are cached by model, prompt and request, so nothing is paid twice.
// The provider-reported model of every reply is recorded in bench/data/v6/gen.jsonl and must match the model asked for.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('../review/lib');
const { plan, DATA } = require('./data-plan');

const ROOT = path.join(__dirname, '..', '..');
const TEAM = process.env.LECTERN_TEAM || '/tmp/lectern-sessions/5ae58c7f-e18b-489a-9c97-a66cd37bbd2d/scratchpad/team-v6';
const AGENT = 'A';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const words = (t) => (String(t).match(/\S+/g) || []).length;

// Share of the team budget (hard rule 2 of the brief). Haiku and Sonnet count together.
const SHARE = Object.freeze({ small: { agent: 120, team: 250 }, 'claude-opus-5-5': { agent: 6, team: 20 } });
const kind = (model) => (model === 'claude-opus-5-5' ? 'claude-opus-5-5' : 'small');
const ALLOWED = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
const SYSTEM = 'You are a helpful assistant. Do exactly what the user asks and reply with the requested text only.';
const CALLS = path.join(TEAM, 'calls.jsonl');
const CACHE = path.join(DATA, 'gen-cache');
const GEN = path.join(DATA, process.argv.includes('--fake') ? 'gen-fake.jsonl' : 'gen.jsonl');

function spent() {
  const out = { agent: { small: 0, 'claude-opus-5-5': 0 }, team: { small: 0, 'claude-opus-5-5': 0 } };
  if (!fs.existsSync(CALLS)) return out;
  for (const line of fs.readFileSync(CALLS, 'utf8').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !ALLOWED.has(r.model)) continue;
    const n = Number(r.calls) || 1;
    out.team[kind(r.model)] += n;
    if (r.agent === AGENT) out.agent[kind(r.model)] += n;
  }
  return out;
}
function checkBudget(model, inflight) {
  const s = spent(); const k = kind(model);
  if (s.agent[k] + inflight + 1 > SHARE[k].agent) throw Object.assign(new Error(`Budget: agent A has used ${s.agent[k]} (+${inflight} running) of ${SHARE[k].agent} ${k} calls.`), { fatal: true });
  if (s.team[k] + inflight + 1 > SHARE[k].team) throw Object.assign(new Error(`Budget: the team has used ${s.team[k]} of ${SHARE[k].team} ${k} calls.`), { fatal: true });
}
function logCall(model, id, extra = {}) {
  fs.appendFileSync(CALLS, `${JSON.stringify({ t: new Date().toISOString(), agent: AGENT, model, calls: 1, purpose: 'v6-ai-text', id, ...extra })}\n`);
}

const cachePath = (key) => path.join(CACHE, `${key}.json`);
const cacheGet = (key) => { try { return JSON.parse(fs.readFileSync(cachePath(key), 'utf8')); } catch { return null; } };

/** Returns { ok, text, reason }: the reply must be the text only, 80-400 words, plain paragraphs. */
function clean(raw) {
  let t = String(raw || '').replace(/\r/g, '').trim();
  t = t.replace(/^["“”]+|["“”]+$/g, '').trim();
  const w = words(t);
  if (/^(here('s| is)|sure|certainly|of course)\b/i.test(t)) return { ok: false, text: t, reason: 'preface' };
  if (/(^|\n)\s*(#{1,6}\s|[-*•]\s|\d+\.\s)/.test(t) || /\*\*/.test(t)) return { ok: false, text: t, reason: 'markdown' };
  if (w < 80 || w > 400) return { ok: false, text: t, reason: `${w} words` };
  return { ok: true, text: t.replace(/\n{3,}/g, '\n\n'), words: w };
}

async function main() {
  const fake = !!arg('fake', false);
  if (!fake && !arg('yes-spend', false)) throw new Error('This run uses the owner\'s Claude plan. Add --yes-spend, or --fake.');
  const ids = arg('ids', null) ? String(arg('ids')).split(',') : null;
  const limit = Number(arg('limit', 0)) || Infinity;
  const concurrency = Math.max(1, Math.min(3, Number(arg('concurrency', 3)) || 3));
  const textsDir = path.join(DATA, fake ? 'texts-fake' : 'texts');
  fs.mkdirSync(textsDir, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
  let todo = plan().filter((p) => !fs.existsSync(path.join(textsDir, `${p.id}.txt`)));
  if (ids) todo = todo.filter((p) => ids.includes(p.id));
  todo = todo.slice(0, limit);
  if (!todo.length) { console.log('Nothing to write.'); return; }

  const llm = require(path.join(ROOT, 'server', 'llm'));
  const { Config } = require(path.join(ROOT, 'server', 'config'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-v6-'));
  const settings = L.guardedSettings(new Config(tmp).get(), { model: 'claude-sonnet-5-5' });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');

  const stats = { paid: 0, cached: 0, rejected: 0, inflight: { small: 0, 'claude-opus-5-5': 0 } };
  let stop = null;
  const queue = todo.slice();
  async function worker() {
    while (queue.length && !stop) {
      const p = queue.shift();
      const key = sha(JSON.stringify([p.writer, 'low', sha(SYSTEM), sha(p.brief)]));
      let entry = fake ? null : cacheGet(key);
      if (entry) stats.cached++;
      else {
        try { checkBudget(p.writer, stats.inflight[kind(p.writer)]); } catch (e) { stop = e.message; break; }
        stats.inflight[kind(p.writer)]++;
        let out; let err;
        try {
          out = fake ? { text: `${'Fake sentence about the topic. '.repeat(40)}`, model: p.writer, usage: {} }
            : await llm.complete({ engine: 'claude-code', settings, model: p.writer, effort: 'low', system: SYSTEM, prompt: p.brief, strictModel: true });
        } catch (e) { err = e; }
        stats.inflight[kind(p.writer)]--;
        if (!fake) logCall(p.writer, p.id, err ? { error: String(err.message || err).slice(0, 120) } : {}); // a failed call may still be charged
        if (err) { console.error(`${p.id}: ${String(err.message || err).slice(0, 200)}`); if (err.code === 'MODEL_REJECTED') { stop = err.message; } continue; }
        const reported = out && typeof out.model === 'string' ? out.model : null;
        if (!fake && (!reported || !reported.toLowerCase().startsWith(p.writer))) { stop = `Provider reported "${reported}", not ${p.writer}. Stopping.`; break; }
        entry = { key, id: p.id, writer: p.writer, brief: p.brief, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() };
        if (!fake) fs.writeFileSync(cachePath(key), JSON.stringify(entry));
        stats.paid++;
      }
      const c = clean(entry.text);
      if (!c.ok) { stats.rejected++; console.error(`${p.id}: rejected (${c.reason}); the reply is cached, not retried automatically.`); fs.appendFileSync(GEN, `${JSON.stringify({ id: p.id, writer: p.writer, reportedModel: entry.reportedModel, rejected: c.reason })}\n`); continue; }
      fs.writeFileSync(path.join(textsDir, `${p.id}.txt`), `${c.text}\n`);
      fs.appendFileSync(GEN, `${JSON.stringify({ id: p.id, writer: p.writer, reportedModel: entry.reportedModel, words: c.words, targetWords: p.targetWords, usage: entry.usage, at: entry.at })}\n`);
      process.stdout.write(`\r${stats.paid + stats.cached} done (paid ${stats.paid}, cached ${stats.cached}, rejected ${stats.rejected})   `);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
  if (stop) { console.error(`Stopped: ${stop}`); process.exitCode = 2; }
  const s = spent();
  console.log(`Paid ${stats.paid}, cached ${stats.cached}, rejected ${stats.rejected}. Agent A so far: ${s.agent.small} of ${SHARE.small.agent} Haiku/Sonnet, ${s.agent['claude-opus-5-5']} of ${SHARE['claude-opus-5-5'].agent} Opus.`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { clean, spent };
