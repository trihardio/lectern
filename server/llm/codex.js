'use strict';
// OpenAI models through the Codex CLI ("codex exec"), using the account Codex is signed in
// to. With "Sign in with ChatGPT" this draws on the ChatGPT plan instead of an API key.
// Runs read-only in an empty folder; the model only reads the prompt and writes an answer.
// Codex returns the answer in one piece rather than word by word.

const { findBin, runCli, runQuick, statusCache, unknownFlag, withoutFlag } = require('./cli');

const VALUE_FLAGS = new Set(['-m', '--model', '-c', '--sandbox']);

function buildArgs({ model, effort, web }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only'];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (web) args.push('-c', 'web_search="live"');
  args.push('-'); // read the whole prompt from stdin
  return args;
}

function makeLineHandler(onEvent, state) {
  return (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const item = msg.item || {};
    if (msg.type === 'item.started') {
      if (item.type === 'web_search') onEvent({ type: 'status', text: item.query ? `Searching the web: ${item.query}` : 'Searching the web' });
      if (item.type === 'reasoning') onEvent({ type: 'status', text: 'Thinking' });
    } else if (msg.type === 'item.completed') {
      if (item.type === 'agent_message' && item.text) {
        const piece = (state.text ? '\n\n' : '') + item.text;
        state.text += piece;
        onEvent({ type: 'delta', text: piece });
      } else if (item.type === 'reasoning' && item.text) {
        onEvent({ type: 'thinking', text: item.text + '\n\n' });
      }
    } else if (msg.type === 'turn.completed') {
      const u = msg.usage || {};
      state.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
    } else if (msg.type === 'turn.failed') {
      state.error = (msg.error && msg.error.message) || 'the turn failed';
    } else if (msg.type === 'error') {
      state.error = msg.message || (msg.error && msg.error.message) || 'unknown error';
    }
  };
}

function explain(raw, code) {
  raw = String(raw || '').trim();
  if (/not logged in|login|unauthorized|401|sign in/i.test(raw)) {
    return 'Codex is not signed in. Open a terminal, run "codex login", then try again.';
  }
  if (/usage limit|rate limit|quota/i.test(raw)) return `Your ChatGPT plan's Codex limit was reached. ${raw.slice(0, 200)}`;
  return `Codex stopped with an error${code ? ` (exit ${code})` : ''}: ${raw.slice(0, 400) || 'no details were given'}`;
}

async function complete(opts) {
  const { signal, onEvent = () => {} } = opts;
  const bin = await findBin('codex', opts.bin);
  if (!bin) throw new Error('The Codex CLI was not found on this Mac. Install it, or set its location in Settings.');

  // Codex has no separate system-prompt option, so instructions lead the prompt.
  const input = opts.system ? `${opts.system}\n\n---\n\n${opts.prompt}` : opts.prompt;
  const o = { model: opts.model, effort: opts.effort, web: opts.web };
  let args = buildArgs(o);
  onEvent({ type: 'status', text: 'Waiting for Codex' });

  for (let attempt = 0; attempt < 5; attempt++) {
    const state = { text: '', usage: { input: 0, output: 0 }, error: null };
    const { code, stderr } = await runCli({
      bin, args, input, signal,
      dropEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'], // use the signed-in plan, not a stray API key
      onLine: makeLineHandler(onEvent, state),
    });

    if (!state.text) {
      // Options differ between Codex versions. Drop whichever one this version rejects and retry.
      const complaint = `${stderr}\n${state.error || ''}`;
      const flag = unknownFlag(stderr);
      if (flag && args.includes(flag)) { args = withoutFlag(args, flag, VALUE_FLAGS.has(flag)); continue; }
      if (o.web && /web_search/i.test(complaint)) { o.web = false; onEvent({ type: 'notice', text: 'This Codex version could not enable web search; the answer uses the retrieved papers only.' }); args = buildArgs(o); continue; }
      if (o.effort && /reasoning[_ ]effort/i.test(complaint)) { o.effort = ''; args = buildArgs(o); continue; }
    }

    if (state.error) throw new Error(explain(state.error, code));
    if (code !== 0) throw new Error(explain(stderr, code));
    if (!state.text) throw new Error('Codex finished without writing an answer.');
    return { text: state.text, usage: state.usage };
  }
  throw new Error('This version of Codex does not accept the options Lectern needs. Update Codex and try again.');
}

const cached = statusCache();

/**
 * Is Codex here (on its own or inside the ChatGPT app), and signed in to ChatGPT?
 * `codex login status` checks the saved login and exits non-zero when there is none.
 */
async function status(opts = {}) {
  const bin = await findBin('codex', opts.bin);
  if (!bin) return { ready: false, found: false, signedIn: false, detail: 'Install the ChatGPT app or the Codex CLI, then sign in.' };
  return cached(bin, async () => {
    const out = await runQuick(bin, ['login', 'status'], { dropEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
    if (out.code === 0 && /logged in/i.test(out.output) && !/not logged in/i.test(out.output)) {
      const how = /chatgpt/i.test(out.output) ? 'Signed in with ChatGPT' : 'Signed in';
      return { ready: true, found: true, signedIn: true, bin, detail: how };
    }
    return { ready: false, found: true, signedIn: false, bin, detail: 'Not signed in. Open the ChatGPT app and sign in, or run "codex login" in Terminal.' };
  });
}

module.exports = { complete, status, buildArgs, makeLineHandler };
