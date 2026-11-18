'use strict';
// Gemini through the Gemini API with the user's own key from Google AI Studio (Interactions API, ai.google.dev,
// Api-Revision 2026-05-20; checked 2026-11-19). This is the route Google allows for other apps: a Google AI Pro or
// Ultra plan is not used, because Google's terms forbid other apps from using the sign-in of the Gemini app,
// Gemini CLI or Antigravity CLI. Lectern never reads those apps' logins; it only notices that the Gemini app is
// installed, so Settings can say why its sign-in cannot be used.
//
// The key travels only in the x-goog-api-key header, never in the address, so an error or log line that repeats
// the URL cannot carry it. Requests ask Google not to keep the conversation (store: false; by default Google keeps
// interactions for 1 day on the free tier and 55 days on paid keys).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { statusCache } = require('./cli');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const REVISION = '2026-05-20';

// Thinking levels each model accepts (ai.google.dev/gemini-api/docs/thinking, 2026-11-19). Lectern's effort is
// mapped to the nearest level the model has, never above what was asked; an unknown model gets its own default.
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MODEL_LEVELS = {
  'gemini-4-carbon': ['low', 'medium', 'high'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
};
function thinkingLevel(model, effort) {
  const allowed = MODEL_LEVELS[model];
  if (!allowed) return undefined;
  const want = LEVELS.indexOf(effort === 'max' ? 'xhigh' : effort);
  if (want < 0) return undefined;
  for (let i = want; i >= 0; i--) if (allowed.includes(LEVELS[i])) return LEVELS[i];
  return allowed[0];
}

function requestBody({ model, system, prompt, effort, web, thinkingSummary }) {
  const level = thinkingLevel(model, effort);
  const config = { thinking_summaries: thinkingSummary ? 'auto' : 'none' };
  if (level) config.thinking_level = level;
  const body = { model, input: prompt, stream: true, store: false, generation_config: config };
  if (system) body.system_instruction = system;
  if (web) body.tools = [{ type: 'google_search' }];
  return body;
}

const headers = (key) => ({ 'x-goog-api-key': key, 'content-type': 'application/json', 'api-revision': REVISION });

/** A plain sentence for a failed request. Google's message is included, trimmed; the key never is. */
function explain(status, err, { model, web, key } = {}) {
  let msg = err && typeof err.message === 'string' ? err.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (key && msg.includes(key)) msg = msg.split(key).join('…');
  const detail = `${msg} ${JSON.stringify((err && (err.details || err.status || err.code)) || '')}`;
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(detail)) return 'Google did not accept the Gemini API key. Check it in Settings, or make a new one in Google AI Studio.';
  if (status === 404 || /not found|is not supported for/i.test(msg) && /model/i.test(msg)) {
    return Object.assign(new Error(`Gemini does not offer the model "${model}" for this key, so nothing was sent to another model. Pick a different Gemini model in Settings.`), { code: 'MODEL_REJECTED' });
  }
  if (web && /search|ground|tool/i.test(msg)) return 'Gemini could not search the web with this key: Google offers search grounding only on paid Gemini API keys. Turn web search off, or use a paid key.';
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(detail)) return 'Your Gemini API quota is used up for now. Wait a while, or check the key\'s limits and billing in Google AI Studio.';
  if (status === 401 || status === 403) return `Google refused the request${msg ? `: ${msg}` : ''}. Check the Gemini API key and its project in Google AI Studio.`;
  if (status >= 500 || /UNAVAILABLE|gateway_timeout|DEADLINE/i.test(detail)) return 'Gemini is busy or unavailable right now. Try again in a moment.';
  return `Gemini returned an error${status ? ` (${status})` : ''}${msg ? `: ${msg}` : ''}.`;
}
const fail = (status, err, ctx) => { const e = explain(status, err, ctx); return e instanceof Error ? e : new Error(e); };

/** Read a server-sent-event stream and call onData with each event's parsed JSON. */
async function readSse(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let ev; try { ev = JSON.parse(data); } catch { return; } // a line Lectern cannot read is skipped
    onData(ev);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at;
      while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
        const m = /\r?\n\r?\n/.exec(buf.slice(at));
        flush(buf.slice(0, at));
        buf = buf.slice(at + m[0].length);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) flush(buf);
  } finally { reader.cancel().catch(() => {}); }
}

/** One stream event into Lectern's events. */
function makeHandler(onEvent, state) {
  const addSource = (a) => {
    if (!a || a.type !== 'url_citation' || typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url)) return;
    if (state.webResults.size >= 200 || state.webResults.has(a.url)) return;
    state.webResults.set(a.url, { url: a.url, title: typeof a.title === 'string' ? a.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '' });
  };
  return (ev) => {
    const t = ev && ev.event_type;
    if (t === 'interaction.created' || t === 'interaction.completed') {
      const it = ev.interaction || {};
      if (typeof it.model === 'string' && it.model) state.model = it.model;
      if (t === 'interaction.completed') {
        state.done = true;
        const u = it.usage || {};
        state.usage = { input: Number(u.total_input_tokens) || 0, output: (Number(u.total_output_tokens) || 0) + (Number(u.total_thought_tokens) || 0) };
        if (it.status && it.status !== 'completed') state.incomplete = it.status;
      }
    } else if (t === 'step.start') {
      const kind = ev.step && ev.step.type;
      if (kind === 'thought') onEvent({ type: 'status', text: 'Thinking' });
      else if (kind === 'google_search_call') onEvent({ type: 'status', text: 'Searching the web' });
      else if (kind === 'model_output' && state.text && !state.text.endsWith('\n\n') && state.searched) { state.text += '\n\n'; onEvent({ type: 'delta', text: '\n\n' }); }
      if (kind === 'google_search_call') state.searched = true;
    } else if (t === 'step.delta') {
      const d = ev.delta || {};
      if (d.type === 'text' && typeof d.text === 'string' && d.text) { state.text += d.text; onEvent({ type: 'delta', text: d.text }); }
      else if (d.type === 'thought_summary' && d.content && typeof d.content.text === 'string' && d.content.text) onEvent({ type: 'thinking', text: d.content.text });
      else if (d.type === 'text_annotation_delta' && Array.isArray(d.annotations)) d.annotations.forEach(addSource);
      if (Array.isArray(d.annotations) && d.type !== 'text_annotation_delta') d.annotations.forEach(addSource);
    } else if (t === 'error') {
      state.error = ev.error || { message: 'The stream ended with an error.' };
    }
  };
}

/**
 * Run one prompt. Emits delta, thinking and status events; resolves { text, model, usage, webResults }.
 * There is no fallback model: a model Google does not offer stops the run (code MODEL_REJECTED), whether or not
 * strictModel is set, because nothing is ever sent to a model the writer did not pick.
 */
async function complete(opts) {
  const { key, signal, onEvent = () => {} } = opts;
  if (!key) throw new Error('No Gemini API key is saved. Add one in Settings (from Google AI Studio).');
  const model = opts.model || 'gemini-4-hydrogen';
  let res;
  try {
    res = await fetch(`${BASE}/interactions?alt=sse`, { method: 'POST', headers: headers(key), body: JSON.stringify(requestBody({ ...opts, model })), signal });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new Error('Lectern could not reach Gemini. Check the internet connection and try again.');
  }
  if (!res.ok) {
    let err = null;
    try { const j = await res.json(); err = j && j.error; } catch { /* not JSON */ }
    throw fail(res.status, err, { model, web: opts.web, key });
  }
  const state = { text: '', model: null, usage: { input: 0, output: 0 }, webResults: new Map(), error: null, done: false, searched: false, incomplete: null };
  await readSse(res.body, makeHandler(onEvent, state));
  if (state.error) {
    if (!state.text) throw fail(0, state.error, { model, web: opts.web, key });
    onEvent({ type: 'notice', text: `Gemini stopped before it finished (${String(state.error.message || 'error').slice(0, 160)}), so this answer may be incomplete.` });
  } else if (!state.done && !(signal && signal.aborted)) {
    if (!state.text) throw new Error('Gemini ended the reply without an answer. Try again.');
    onEvent({ type: 'notice', text: 'Gemini\'s reply ended early, so this answer may be incomplete.' });
  } else if (state.incomplete && state.text) {
    onEvent({ type: 'notice', text: `Gemini marked this reply "${state.incomplete}", so it may be incomplete.` });
  }
  return { text: state.text, model: state.model || model, usage: state.usage, webResults: [...state.webResults.values()] };
}

// The Gemini app for Mac (com.google.GeminiMacOS). Only its presence is checked; its sign-in is never read.
let APP_PATHS = ['/Applications/Gemini.app', path.join(os.homedir(), 'Applications', 'Gemini.app')];
const geminiApp = () => process.platform === 'darwin' && APP_PATHS.some((p) => fs.existsSync(path.join(p, 'Contents', 'Info.plist')));

const cached = statusCache();
const APP_NOTE = 'The Gemini app is on this Mac, but Google does not let other apps use its sign-in or your Google AI plan.';

/**
 * Is a key saved, and does Google accept it? models.list is free and checks only that the key exists (Google's
 * troubleshooting page): a reply can still fail on billing or tier, which "Save and test" in Settings shows.
 */
async function status({ key } = {}) {
  const app = geminiApp();
  if (!key) {
    return { ready: false, found: false, signedIn: false, app, detail: app ? `${APP_NOTE} Add a Gemini API key from Google AI Studio to use Gemini here.` : 'Add a Gemini API key from Google AI Studio to use Gemini.' };
  }
  const id = crypto.createHash('sha256').update(key).digest('hex');
  return cached(id, async () => {
    let res;
    try {
      res = await fetch(`${BASE}/models?pageSize=1`, { headers: headers(key), signal: AbortSignal.timeout(6000) });
    } catch {
      return { ready: true, found: true, signedIn: null, app, detail: 'Key saved. Google could not be reached to check it; press Save and test.' };
    }
    if (res.ok) return { ready: true, found: true, signedIn: true, app, detail: 'Google accepted the API key.' };
    let err = null;
    try { const j = await res.json(); err = j && j.error; } catch { /* not JSON */ }
    if (res.status >= 500) return { ready: true, found: true, signedIn: null, app, detail: 'Key saved. Google did not answer the check; press Save and test.' };
    const why = explain(res.status, err, { key });
    return { ready: false, found: true, signedIn: false, app, detail: why instanceof Error ? why.message : why };
  });
}

module.exports = {
  complete, status, thinkingLevel, requestBody, readSse, makeHandler, explain, BASE, REVISION, MODEL_LEVELS,
  _setAppPathsForTest: (paths) => { APP_PATHS = paths; },
};
