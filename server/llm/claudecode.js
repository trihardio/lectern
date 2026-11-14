'use strict';
// Claude through the Claude Code CLI ("claude -p"), using the account Claude Code is
// signed in to. On a Claude subscription this draws on the plan instead of an API key.
// Tools are switched off: the model only reads the prompt and writes an answer
// (plus web search when you ask for it).

const { findBin, runCli, runQuick, statusCache, unknownFlag, withoutFlag } = require('./cli');

// Flags that take a value, so a retry can strip both the flag and its value.
const VALUE_FLAGS = new Set(['--effort', '--model', '--tools', '--allowedTools', '--disallowedTools', '--max-turns', '--permission-mode', '--system-prompt', '--output-format']);

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

/** Turn one line of stream-json output into events. Returns final { text, usage } on the result line. */
function makeLineHandler(onEvent, state) {
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
        if (t === 'tool_use' || t === 'server_tool_use') {
          onEvent({ type: 'status', text: /fetch/i.test(ev.content_block.name || '') ? 'Reading a web page' : 'Searching the web' });
          // Text written before a tool call is narration ("Let me search…"); separate it from the answer.
          if (state.text && !state.text.endsWith('\n\n')) { state.text += '\n\n'; onEvent({ type: 'delta', text: '\n\n' }); }
        }
      }
    } else if (msg.type === 'assistant' && msg.message && !msg.parent_tool_use_id && !state.streamed) {
      // Older versions (or runs without partial messages) deliver whole messages instead of deltas.
      for (const b of msg.message.content || []) {
        if (b.type === 'text' && b.text) { state.text += b.text; onEvent({ type: 'delta', text: b.text }); }
      }
    } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
      onEvent({ type: 'status', text: `Claude is busy, retrying (attempt ${msg.attempt})` });
    } else if (msg.type === 'result') {
      state.result = msg;
    }
  };
}

function explain(result, stderr, code) {
  const raw = (result && typeof result.result === 'string' && result.result) || stderr || '';
  if (/not logged in|\/login|authentication|invalid api key|oauth/i.test(raw)) {
    return 'Claude Code is not signed in. Open a terminal, run "claude", sign in, then try again.';
  }
  if (/usage limit|rate limit|limit reached|out of extra usage/i.test(raw)) {
    return `Your Claude plan's usage limit was reached. ${raw.trim().slice(0, 200)}`;
  }
  return `Claude Code stopped with an error${code ? ` (exit ${code})` : ''}: ${raw.trim().slice(0, 400) || 'no details were given'}`;
}

async function complete(opts) {
  const { signal, onEvent = () => {} } = opts;
  const bin = await findBin('claude', opts.bin);
  if (!bin) throw new Error('Claude Code was not found on this Mac. Install it, or set its location in Settings.');

  let args = buildArgs(opts);
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = { text: '', streamed: false, result: null };
    const { code, stderr } = await runCli({
      bin, args, input: opts.prompt, signal,
      dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], // use the signed-in plan, not a stray API key
      onLine: makeLineHandler(onEvent, state),
    });

    const flag = !state.result && !state.text ? unknownFlag(stderr) : null;
    if (flag && args.includes(flag)) { args = withoutFlag(args, flag, VALUE_FLAGS.has(flag)); continue; }

    if (state.result && state.result.is_error) throw new Error(explain(state.result, stderr, code));
    if (!state.result && code !== 0) throw new Error(explain(null, stderr, code));

    const text = state.text || (state.result && state.result.result) || '';
    if (!state.text && text) onEvent({ type: 'delta', text });
    const u = (state.result && state.result.usage) || {};
    return {
      text,
      usage: {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      },
    };
  }
  throw new Error('This version of Claude Code does not accept the options Lectern needs. Run "claude update" and try again.');
}

const cached = statusCache();

/**
 * Is Claude Code here, and is it signed in? Uses the login Claude Code (or the Claude app)
 * already saved on this Mac: `claude auth status` reports it as JSON without exposing it.
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

module.exports = { complete, status, buildArgs, makeLineHandler };
