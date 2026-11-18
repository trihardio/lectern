'use strict';
// One front door for the three ways Lectern reaches a model. The first two use a login already saved
// on this computer (the user's Claude or ChatGPT plan); Gemini uses the user's own Gemini API key, because
// Google does not let other apps use the Gemini app's sign-in or a Google AI plan (see gemini.js):
//   claude-code  Claude, through Claude Code (on its own or inside the Claude app)
//   codex        ChatGPT, through Codex (on its own or inside the ChatGPT app)
//   gemini       Gemini, through the Gemini API with a key from Google AI Studio (added 2026-11-19, the owner's choice)

const claudecode = require('./claudecode');
const codex = require('./codex');
const gemini = require('./gemini');

const ENGINE_INFO = {
  'claude-code': {
    label: 'Claude', short: 'Claude', billing: 'Uses the Claude plan you are signed in to',
    models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    blurbs: {
      'claude-opus-5-5': 'Most capable for deep research questions',
      'claude-fable-5-2': 'For the toughest questions',
      'claude-sonnet-5-5': 'Fast and capable for everyday questions',
      'claude-haiku-5-5': 'Fastest, for quick answers',
    },
  },
  codex: {
    label: 'ChatGPT', short: 'ChatGPT', billing: 'Uses the ChatGPT plan you are signed in to',
    // From the model list Codex itself reports (~/.codex/models_cache.json, checked 2026-11-17).
    // Older and smaller models stay available on the ChatGPT plan; hidden internal models are left out.
    models: ['', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    blurbs: {
      '': 'Whatever model Codex is set to use',
      'gpt-6.1-sol': 'For everyday research questions',
      'gpt-6-astra': 'For complex questions that need careful reasoning',
      'gpt-6.1-terra': 'For code and technical questions',
      'gpt-6-luna': 'For quick questions',
      'gpt-6-sol': 'Previous GPT-6 workhorse',
      'gpt-5.6-sol': 'Older GPT-5 workhorse',
      'gpt-5.6-terra': 'Older GPT-5, balanced',
      'gpt-5.6-luna': 'Older GPT-5, fastest',
    },
  },
  gemini: {
    label: 'Gemini', short: 'Gemini', billing: 'Uses your Gemini API key, billed by Google (not a Google AI plan)',
    // The Gemini API's text models (ai.google.dev/gemini-api/docs/models and pricing, checked 2026-11-19).
    models: ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    blurbs: {
      'gemini-4-hydrogen': 'Fast and capable for everyday questions; free tier',
      'gemini-4-argon': 'Frontier reasoning, faster than Carbon; paid keys only',
      'gemini-4-carbon': 'Strongest reasoning; paid keys only',
      'gemini-3.8-flash': 'Previous-generation Flash; free tier',
      'gemini-3.5-flash-lite': 'Fastest and cheapest; free tier',
    },
    usesKey: true, // connected by a key in Settings, not by a sign-in
    hiddenUntilReady: true, // the owner's rule: no Gemini in the model menus until a key is linked
  },
};
const ORDER = ['claude-code', 'codex', 'gemini'];

/** Which engines can run right now (found on this computer and signed in, or a Gemini key accepted). */
async function engineStatus(settings) {
  const [cc, cx, gm] = await Promise.all([
    claudecode.status({ bin: settings.bins.claude }),
    codex.status({ bin: settings.bins.codex }),
    gemini.status({ key: settings.keys && settings.keys.gemini }),
  ]);
  const ready = { 'claude-code': cc, codex: cx, gemini: gm };
  return ORDER.map((id) => ({ id, ...ENGINE_INFO[id], ...ready[id] }));
}

/** The engine to use: the chosen one if it is ready, otherwise the first that is. */
async function pickEngine(settings, preferred) {
  const statuses = await engineStatus(settings);
  const want = preferred || settings.engine;
  const chosen = statuses.find((s) => s.id === want && s.ready) || statuses.find((s) => s.ready);
  return chosen ? chosen.id : null;
}

/**
 * Run one prompt on an engine.
 * role 'main' writes the answer with the chosen model and effort;
 * role 'helper' uses the small fast model at low effort (and falls back to the main model if that fails).
 */
async function complete({ engine, role = 'main', settings, model, effort, system, prompt, web = false, signal, onEvent, strictModel = false }) {
  const helper = role === 'helper';
  const chosenModel = model || (helper ? settings.helperModels[engine] : settings.models[engine]) || '';
  const base = {
    system, prompt, signal, onEvent,
    web: helper ? false : web,
    effort: helper ? 'low' : (effort || settings.effort),
    thinkingSummary: !helper,
    model: chosenModel,
    strictModel, // true: fail rather than drop a model option the CLI rejects
  };

  const run = (opts) => {
    switch (engine) {
      case 'claude-code': return claudecode.complete({ ...opts, bin: settings.bins.claude });
      case 'codex': return codex.complete({ ...opts, bin: settings.bins.codex });
      case 'gemini': return gemini.complete({ ...opts, key: settings.keys && settings.keys.gemini });
      default: throw new Error('No model is connected yet. Sign in to Claude or ChatGPT on this computer, or add a Gemini API key in Settings, then try again.');
    }
  };

  if (!helper) return run(base);
  try {
    return await run(base);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const main = settings.models[engine] || '';
    if (main === chosenModel) throw e;
    return run({ ...base, model: main });
  }
}

async function listModels(engine) {
  return ENGINE_INFO[engine] ? ENGINE_INFO[engine].models.map((id) => ({ id, label: id })) : [];
}

module.exports = { ENGINE_INFO, ORDER, engineStatus, pickEngine, complete, listModels };
