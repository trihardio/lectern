'use strict';
// Writes the version 7 AI test texts planned in gen-plan.js, through Claude Code only, model claude-haiku-5-5.
//
//   node bench/v7/gen-run.js --fake          free check: prints what would be paid, calls nothing, writes nothing
//   node bench/v7/gen-run.js --yes-spend     write the texts (USES MODEL CREDITS on the owner's Claude plan)
//
// Codex is never used: the settings are forced to claude-code and the codex program is pointed at nothing.
// Agent H gets 60 claude-haiku-5-5 calls. Every paid call is logged in TEAM/calls.jsonl before the next one starts,
// and the budget is checked before each call. Replies are cached, so nothing is paid twice. Each call is made once:
// a text that is outside 80 to 400 words is kept in the cache and is not asked again.
// Rewrite may use up to 2 calls per text (its own second attempt); every one of them is counted.
// Outputs: bench/data/v7/ai/<id>.txt, bench/data/v7/ai/manifest.jsonl, bench/data/v7/ai/rejected.jsonl,
// and bench/data/v7/ai/results.json (the state the other files are rebuilt from).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { plan, WRITER } = require('./gen-plan');

const ROOT = path.join(__dirname, '..', '..');
const TEAM = process.env.LECTERN_TEAM || '/tmp/lectern-sessions/5ae58c7f-e18b-489a-9c97-a66cd37bbd2d/scratchpad/team-v7';
const AGENT = 'H';
const LIMIT = 60;
const OUT = path.join(ROOT, 'bench', 'data', 'v7', 'ai');
const CACHE = path.join(OUT, 'gen-cache');
const CALLS = path.join(TEAM, 'calls.jsonl');
const RESULTS = path.join(OUT, 'results.json');
const LICENCE = 'model output written for this benchmark; local only';
const SYSTEM = 'You are a helpful assistant. Do exactly what the user asks and reply with the requested text only.';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const words = (t) => (String(t).match(/\S+/g) || []).length;
const arg = (name) => process.argv.includes(`--${name}`);

// ---- budget and log
function spent() {
  let n = 0;
  if (!fs.existsSync(CALLS)) return n;
  for (const line of fs.readFileSync(CALLS, 'utf8').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.agent === AGENT && r.model === WRITER) n += Number(r.calls) || 1;
  }
  return n;
}
function checkBudget(inflight) {
  const s = spent();
  if (s + inflight + 1 > LIMIT) throw Object.assign(new Error(`Budget: agent H has used ${s} of ${LIMIT} ${WRITER} calls.`), { fatal: true });
}
function logCall(purpose, id, extra = {}) {
  fs.mkdirSync(TEAM, { recursive: true });
  fs.appendFileSync(CALLS, `${JSON.stringify({ t: new Date().toISOString(), agent: AGENT, model: WRITER, calls: 1, purpose, id, ...extra })}\n`);
}

// ---- cache
const cachePath = (key) => path.join(CACHE, `${key}.json`);
const cacheGet = (key) => { try { return JSON.parse(fs.readFileSync(cachePath(key), 'utf8')); } catch { return null; } };
const cachePut = (key, entry) => fs.writeFileSync(cachePath(key), JSON.stringify(entry));

// ---- results state
function loadResults() { try { return JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { return {}; } }
function saveResults(r) { fs.writeFileSync(RESULTS, `${JSON.stringify(r, null, 2)}\n`); }

/** The reply must be the text only, 80 to 400 words, plain paragraphs. Same rules as bench/v6/data-generate.js. */
function clean(raw) {
  let t = String(raw || '').replace(/\r/g, '').trim();
  t = t.replace(/^["“”]+|["“”]+$/g, '').trim();
  const w = words(t);
  if (/^(here('s| is)|sure|certainly|of course)\b/i.test(t)) return { ok: false, text: t, reason: 'preface', words: w };
  if (/(^|\n)\s*(#{1,6}\s|[-*•]\s|\d+\.\s)/.test(t) || /\*\*/.test(t)) return { ok: false, text: t, reason: 'markdown', words: w };
  if (w < 80 || w > 400) return { ok: false, text: t, reason: `${w} words`, words: w };
  return { ok: true, text: t.replace(/\n{3,}/g, '\n\n'), words: w };
}

async function main() {
  const fake = arg('fake');
  if (!fake && !arg('yes-spend')) throw new Error('This run uses the owner\'s Claude plan. Add --yes-spend, or --fake.');
  const p = plan();
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
  const results = loadResults();

  if (fake) {
    const todo = [...p.humanvoice, ...p.rewrite].filter((x) => !results[x.id]);
    console.log(`Fake run: ${todo.length} texts not yet written; up to ${p.humanvoice.filter((x) => !results[x.id]).length + 2 * p.rewrite.filter((x) => !results[x.id]).length} paid calls would be needed. Spent so far: ${spent()} of ${LIMIT}. Nothing called.`);
    return;
  }

  const llm = require(path.join(ROOT, 'server', 'llm'));
  const { Config } = require(path.join(ROOT, 'server', 'config'));
  const L = require(path.join(ROOT, 'bench', 'review', 'lib'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-v7-'));
  const settings = L.guardedSettings(new Config(tmp).get(), { model: WRITER });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');

  const record = (id, entry) => { results[id] = entry; saveResults(results); };
  let stop = null;

  // 1. humanvoice: one request each, three at a time, each cached.
  const hv = p.humanvoice.filter((x) => !results[x.id]);
  let inflight = 0;
  const queue = hv.slice();
  async function worker() {
    while (queue.length && !stop) {
      const item = queue.shift();
      const key = sha(JSON.stringify(['hv', WRITER, 'low', sha(SYSTEM), item.request]));
      let entry = cacheGet(key);
      if (!entry) {
        try { checkBudget(inflight); } catch (e) { stop = e.message; break; }
        inflight++;
        let out; let err;
        try { out = await llm.complete({ engine: 'claude-code', settings, model: WRITER, effort: 'low', system: SYSTEM, prompt: item.request, strictModel: true }); }
        catch (e) { err = e; }
        inflight--;
        logCall('v7-humanvoice', item.id, err ? { error: String(err.message || err).slice(0, 120) } : {}); // a failed call may still be charged
        if (err) { console.error(`${item.id}: ${String(err.message || err).slice(0, 200)}`); continue; }
        const reported = out && typeof out.model === 'string' ? out.model : null;
        if (!reported || !reported.toLowerCase().startsWith(WRITER)) { stop = `Provider reported "${reported}", not ${WRITER}. Stopping.`; break; }
        entry = { key, id: item.id, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() };
        cachePut(key, entry);
      }
      const c = clean(entry.text);
      record(item.id, { id: item.id, kind: item.kind, genre: item.genre, topic: item.topic, request: item.request, writer: WRITER, reportedModel: entry.reportedModel, words: c.words, ok: c.ok, reason: c.ok ? null : c.reason, text: c.text, at: entry.at });
      process.stdout.write(`\rhumanvoice ${Object.keys(results).length} recorded   `);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  process.stdout.write('\n');

  // 2. rewrite: Lectern's own runRewrite, one text at a time, guarded (sequential, so the in-flight count is 0).
  const { runRewrite } = require(path.join(ROOT, 'server', 'checks', 'rewrite.js'));
  const guardedRewriteComplete = async (o) => {
    if (stop) throw Object.assign(new Error(stop), { fatal: true });
    if (o.engine !== 'claude-code') throw new Error(`Refusing to use engine "${o.engine}": only claude-code is allowed here.`);
    if (o.model !== WRITER) throw new Error(`Refusing to call model "${o.model}": this run is fixed to ${WRITER}.`);
    const key = sha(JSON.stringify(['rw', WRITER, sha(o.system), sha(o.prompt)]));
    const hit = cacheGet(key);
    if (hit) return { text: hit.text, model: hit.reportedModel, usage: hit.usage || {}, webResults: [] };
    checkBudget(0);
    let out; let err;
    try { out = await llm.complete(o); } catch (e) { err = e; }
    logCall('v7-rewrite', o.__id || 'rewrite', err ? { error: String(err.message || err).slice(0, 120) } : {});
    if (err) throw err;
    const reported = out && typeof out.model === 'string' ? out.model : null;
    if (!reported || !reported.toLowerCase().startsWith(WRITER)) throw Object.assign(new Error(`Provider reported "${reported}", not ${WRITER}. Stopping.`), { fatal: true });
    cachePut(key, { key, text: out.text, reportedModel: reported, usage: out.usage || {}, at: new Date().toISOString() });
    return out;
  };
  const config = L.guardedConfig(settings);
  for (const item of p.rewrite.filter((x) => !results[x.id])) {
    if (stop) break;
    try {
      const res = await runRewrite({ text: item.sourceText, config, engine: 'claude-code', selectedModel: WRITER, style: item.style, complete: guardedRewriteComplete });
      const c = clean(res.text);
      record(item.id, { id: item.id, kind: item.kind, genre: item.genre, topic: item.topic, source: item.source, style: item.style, writer: WRITER, reportedModel: res.reportedModel, attempts: res.attempts, words: c.words, ok: c.ok, reason: c.ok ? null : c.reason, text: c.text, at: new Date().toISOString() });
    } catch (e) {
      console.error(`${item.id}: ${String(e.message || e).slice(0, 200)}`);
      if (e.fatal) { stop = e.message; break; }
    }
  }

  // 3. rebuild the files from the state.
  const all = [...p.humanvoice, ...p.rewrite].map((x) => results[x.id]).filter(Boolean);
  const manifest = [];
  const rejected = [];
  for (const r of all) {
    if (r.ok) {
      fs.writeFileSync(path.join(OUT, `${r.id}.txt`), `${r.text}\n`);
      const src = r.kind === 'rewrite' ? { source: r.source, style: r.style } : { request: r.request };
      manifest.push({ id: r.id, kind: r.kind === 'rewrite' ? 'rewrite' : 'humanvoice', genre: r.genre, topic: r.topic, ...src, words: r.words, writer: r.writer, reportedModel: r.reportedModel, licence: LICENCE });
    } else {
      rejected.push({ id: r.id, kind: r.kind, genre: r.genre, reason: r.reason, words: r.words });
    }
  }
  fs.writeFileSync(path.join(OUT, 'manifest.jsonl'), manifest.map((x) => JSON.stringify(x)).join('\n') + (manifest.length ? '\n' : ''));
  fs.writeFileSync(path.join(OUT, 'rejected.jsonl'), rejected.map((x) => JSON.stringify(x)).join('\n') + (rejected.length ? '\n' : ''));
  if (stop) { console.error(`Stopped: ${stop}`); process.exitCode = 2; }
  console.log(`Written ${manifest.length} texts, rejected ${rejected.length} (outside 80-400 words or a format fault; kept in the cache). Agent H calls so far: ${spent()} of ${LIMIT}.`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
