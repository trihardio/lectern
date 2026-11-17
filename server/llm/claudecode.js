'use strict';
// Claude through the Claude Code CLI ("claude -p"), using the account Claude Code is
// signed in to. On a Claude subscription this draws on the plan instead of an API key.
// Tools are switched off: the model only reads the prompt and writes an answer
// (plus web search when you ask for it).

const { findBin, runCli, runQuick, statusCache, unknownFlag, withoutFlag, tooOld, shortReason } = require('./cli');

// Flags that take a value, so a retry can strip both the flag and its value.
const VALUE_FLAGS = new Set(['--effort', '--model', '--tools', '--allowedTools', '--disallowedTools', '--max-turns', '--permission-mode', '--system-prompt', '--output-format']);
// Flags that keep a run safe: no tools beyond the ones asked for, no MCP servers, nothing saved. A version that
// rejects one is too old to use; Lectern stops and asks for an update instead of running without it.
const SAFETY_FLAGS = new Set(['--tools', '--disallowedTools', '--strict-mcp-config', '--no-session-persistence']);

// Safe mode (Claude Code 2.1.169 and later, documented as equivalent to --safe-mode): the user's own CLAUDE.md,
// hooks, plugins, skills, MCP servers, output styles and auto memory are not loaded, while the sign-in and the
// model choice work as usual. Without it a run inherits the user's global setup, for example a SessionStart
// hook that adds instructions to every session. An older version ignores the variable.
const SAFE_ENV = { CLAUDE_CODE_SAFE_MODE: '1' };

function buildArgs({ model, effort, system, web }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
    '--disallowedTools', 'mcp__*'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (system) args.push('--system-prompt', system);
  if (web) {
    args.push('--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--max-turns', '16');
  } else {
    args.push('--tools', '');
  }
  return args;
}

/**
 * Pages the web tools really returned, from the stream: WebSearch results and WebFetch pages (the structured
 * `tool_use_result` on the user message that carries a tool's result), and the API's own web_search_tool_result
 * blocks. Only these may become web sources; a link the model writes from memory never does.
 */
function addWebResults(state, value) {
  const add = (url, title) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || state.webResults.size >= 200) return;
    if (!state.webResults.has(url)) state.webResults.set(url, { url, title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 300) : '' });
  };
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.results)) { // WebSearch: { query, results: [{ tool_use_id, content: [{ title, url }] } | text] }
    for (const r of value.results) if (r && Array.isArray(r.content)) for (const hit of r.content) if (hit) add(hit.url, hit.title);
  }
  if (typeof value.url === 'string' && typeof value.code === 'number' && value.code >= 200 && value.code < 400) add(value.url, ''); // WebFetch
  if (value.type === 'web_search_tool_result' && Array.isArray(value.content)) for (const hit of value.content) if (hit) add(hit.url, hit.title);
}

/** Turn one line of stream-json output into events. Returns final { text, usage } on the result line. */
function makeLineHandler(onEvent, state) {
  if (!state.webResults) state.webResults = new Map();
  return (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'stream_event' && msg.event && !msg.parent_tool_use_id) {
      const ev = msg.event;
      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          state.streamed = true;
          state.text += ev.delta.text;
          onEvent({ type: 'delta', text: ev.delta.text });
        } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
          onEvent({ type: 'thinking', text: ev.delta.thinking });
        }
      } else if (ev.type === 'content_block_start' && ev.content_block) {
        const t = ev.content_block.type;
        if (t === 'thinking') onEvent({ type: 'status', text: 'Thinking' });
        if (t === 'web_search_tool_result') addWebResults(state, ev.content_block);
        if (t === 'tool_use' || t === 'server_tool_use') {
          onEvent({ type: 'status', text: /fetch/i.test(ev.content_block.name || '') ? 'Reading a web page' : 'Searching the web' });
          // Text written before a tool call is narration ("Let me search…"); separate it from the answer.
          if (state.text && !state.text.endsWith('\n\n')) { state.text += '\n\n'; onEvent({ type: 'delta', text: '\n\n' }); }
        }
      }
    } else if (msg.type === 'assistant' && msg.message && !msg.parent_tool_use_id) {
      for (const b of msg.message.content || []) {
        if (b && b.type === 'web_search_tool_result') addWebResults(state, b);
        // Older versions (or runs without partial messages) deliver whole messages instead of deltas.
        else if (!state.streamed && b && b.type === 'text' && b.text) { state.text += b.text; onEvent({ type: 'delta', text: b.text }); }
      }
    } else if (msg.type === 'user' && !msg.parent_tool_use_id && msg.tool_use_result) {
      addWebResults(state, msg.tool_use_result);
    } else if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.model === 'string') {
      state.model = msg.model; // the model Claude Code says it is using: the provider's own word, not our request
    } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
      onEvent({ type: 'status', text: `Claude is busy, retrying (attempt ${msg.attempt})` });
    } else if (msg.type === 'result') {
      state.result = msg;
    }
  };
}

/**
 * A plain message for a failed run. What the CLI printed on stderr (which can hold file paths and account details)
 * goes to the log only, never into the window or a saved conversation; the error text of its result is shown only
 * as a short line without paths or addresses.
 */
const SIGNED_OUT = /not logged in|\/login|authentication|invalid api key|oauth/i;

function explain(result, stderr, code, model) {
  const said = (result && typeof result.result === 'string' && result.result) || (result && Array.isArray(result.errors) && result.errors.join('; ')) || '';
  const raw = said || stderr || '';
  if (SIGNED_OUT.test(raw)) {
    return 'Claude Code is not signed in. Open a terminal, run "claude", sign in, then try again.';
  }
  if (/usage limit|rate limit|limit reached|out of extra usage/i.test(raw)) {
    const reset = /resets?\s+(?:at\s+)?([0-9][^\n|.,;]{0,30})/i.exec(raw);
    return `Your Claude plan's usage limit was reached${reset ? ` (it resets ${reset[1].trim()})` : ''}. Try again later, or pick another provider.`;
  }
  console.error(`Lectern: Claude Code stopped${code ? ` (exit ${code})` : ''}:`, raw.trim().slice(0, 2000) || 'no details');
  if (model && /model/i.test(raw) && /not.?found|invalid|unknown|not available|does not exist|unsupported/i.test(raw)) {
    return `Claude Code could not use the model ${model}. Pick another model, or update Claude Code, then try again.`;
  }
  const reason = shortReason(said);
  return `Claude Code stopped with an error${code ? ` (exit ${code})` : ''}${reason ? `: ${reason}` : ''}. Try again; if it keeps happening, run "claude" in Terminal to check that it works.`;
}

async function complete(opts) {
  const { signal, onEvent = () => {} } = opts;
  const bin = await findBin('claude', opts.bin);
  if (!bin) throw new Error('Claude Code was not found on this computer. Install it, or set its location in Settings.');

  let args = buildArgs(opts);
  let safe = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = { text: '', streamed: false, result: null, model: null, webResults: new Map() };
    const { code, stderr } = await runCli({
      bin, args, input: opts.prompt, signal, env: safe ? SAFE_ENV : {},
      dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], // use the signed-in plan, not a stray API key
      onLine: makeLineHandler(onEvent, state),
    });

    const flag = !state.result && !state.text ? unknownFlag(stderr) : null;
    if (flag && args.includes(flag)) {
      if (SAFETY_FLAGS.has(flag)) throw tooOld('Claude Code', flag);
      // A check that must say which model read the text cannot quietly run on another one.
      if (opts.strictModel && flag === '--model') throw Object.assign(new Error(`This version of Claude Code rejected the model option, so ${opts.model} could not be used. Nothing was read with a different model; update Claude Code or pick another model.`), { code: 'MODEL_REJECTED' });
      args = withoutFlag(args, flag, VALUE_FLAGS.has(flag)); continue;
    }

    const res = state.result;
    // Safe mode is documented to keep the sign-in working. Should a version still answer "not signed in" with it
    // while the sign-in itself is fine, one more try without it keeps Lectern usable (that run then loads the user's
    // own setup); a real sign-out fails again and is reported below.
    if (safe && !state.text && SIGNED_OUT.test(`${(res && typeof res.result === 'string' && res.result) || ''}\n${stderr}`)) {
      console.error('Lectern: Claude Code reported no sign-in in safe mode; trying once without safe mode.');
      safe = false; continue;
    }
    if (res && res.is_error) {
      // A run that ends in an error after writing (for example when web searching used every turn) keeps what it
      // wrote, with a note, instead of losing an answer the reader already saw arrive.
      const wrote = state.text.trim() && typeof res.result !== 'string';
      if (!wrote) {
        if (res.subtype === 'error_max_turns') throw new Error('Claude used all of its web-search steps without writing an answer. Try again, or ask without web search.');
        throw new Error(explain(res, stderr, code, opts.model));
      }
      onEvent({ type: 'notice', text: res.subtype === 'error_max_turns'
        ? 'Claude used all of its web-search steps before it finished, so this answer may be incomplete.'
        : 'Claude Code stopped before the answer was finished, so it may be incomplete.' });
      console.error(`Lectern: Claude Code ended with ${res.subtype || 'an error'} after writing ${state.text.length} characters.`);
    } else if (res && res.subtype === 'error_max_turns') {
      onEvent({ type: 'notice', text: 'Claude used all of its web-search steps before it finished, so this answer may be incomplete.' });
    }
    if (!res && code !== 0) throw new Error(explain(null, stderr, code, opts.model));

    const text = state.text || (res && typeof res.result === 'string' ? res.result : '') || '';
    if (!state.text && text) onEvent({ type: 'delta', text });
    const u = (res && res.usage) || {};
    const used = state.model || (res && res.modelUsage ? Object.keys(res.modelUsage)[0] : null) || null;
    return {
      text,
      model: used, // null when Claude Code did not say
      usage: {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      },
      webResults: [...state.webResults.values()], // pages the web tools returned (empty with web search off)
    };
  }
  throw new Error('This version of Claude Code does not accept the options Lectern needs. Run "claude update" and try again.');
}

const cached = statusCache();

/**
 * Is Claude Code here, and is it signed in? Uses the login Claude Code (or the Claude app)
 * already saved on this computer: `claude auth status` reports it as JSON without exposing it.
 */
async function status(opts = {}) {
  const bin = await findBin('claude', opts.bin);
  if (!bin) return { ready: false, found: false, signedIn: false, detail: 'Install the Claude app or Claude Code, then sign in.' };
  return cached(bin, async () => {
    const out = await runQuick(bin, ['auth', 'status'], { dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] });
    let info = null;
    try { info = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))); } catch { /* older version: no JSON */ }
    if (!info) return { ready: true, found: true, signedIn: null, bin, detail: 'Found. Press Test to check the sign-in.' };
    if (!info.loggedIn) return { ready: false, found: true, signedIn: false, bin, detail: 'Not signed in. Open the Claude app and sign in, or run "claude" in Terminal.' };
    const plan = info.subscriptionType ? `${String(info.subscriptionType).replace(/^./, (c) => c.toUpperCase())} plan` : '';
    return { ready: true, found: true, signedIn: true, bin, account: info.email || '', detail: ['Signed in', info.email && `as ${info.email}`, plan && `(${plan})`].filter(Boolean).join(' ') };
  });
}

module.exports = { complete, status, buildArgs, makeLineHandler, addWebResults, SAFETY_FLAGS, SAFE_ENV };
