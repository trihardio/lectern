'use strict';
// The Gemini engine (server/llm/gemini.js) against the Gemini API mock in mock-fetch.js. Nothing here reaches
// Google: every request goes to the mock, and a GEMINI_API_KEY in the shell is never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-fetch');
const fx = require('./fixtures');
const gemini = require('../server/llm/gemini');
const llm = require('../server/llm');
const { Config } = require('../server/config');

const KEY = 'test-gemini-key-1234';
const collect = () => { const events = []; return { events, onEvent: (e) => events.push(e), text: () => events.filter((e) => e.type === 'delta').map((e) => e.text).join('') }; };
const geminiCalls = () => mock.calls.filter((c) => c.host === 'generativelanguage.googleapis.com');

test('Gemini: the key travels only in a header; the request keeps nothing on Google and maps the effort', async () => {
  mock.reset();
  const c = collect();
  const out = await gemini.complete({ key: KEY, model: 'gemini-4-hydrogen', effort: 'max', system: 'Answer from the papers.', prompt: 'the prompt', thinkingSummary: true, onEvent: c.onEvent });
  assert.equal(out.text, fx.ANSWER_TEXT);
  assert.equal(c.text(), fx.ANSWER_TEXT);
  assert.equal(out.model, 'gemini-4-hydrogen');
  assert.deepEqual(out.usage, { input: 8800, output: 550 }, 'output counts the thinking tokens Google bills');
  assert.ok(c.events.some((e) => e.type === 'thinking' && e.text === 'Comparing designs.'), 'thought summary shown as thinking');
  const [call] = geminiCalls();
  assert.equal(call.path, '/v1beta/interactions');
  assert.equal(call.params.alt, 'sse');
  assert.ok(!call.url.includes(KEY), 'the key is never in the address');
  assert.equal(call.headers['x-goog-api-key'], KEY);
  assert.equal(call.headers['api-revision'], gemini.REVISION);
  assert.equal(call.body.store, false, 'Google is asked not to keep the conversation');
  assert.equal(call.body.stream, true);
  assert.equal(call.body.system_instruction, 'Answer from the papers.');
  assert.equal(call.body.input, 'the prompt');
  assert.equal(call.body.generation_config.thinking_level, 'xhigh', 'max maps to the highest level Hydrogen has');
  assert.equal(call.body.generation_config.thinking_summaries, 'auto');
  assert.equal(call.body.tools, undefined, 'no tools without web search');
});

test('Gemini: thinking levels never exceed what was asked or what the model accepts', () => {
  const t = gemini.thinkingLevel;
  assert.equal(t('gemini-4-carbon', 'max'), 'high');
  assert.equal(t('gemini-4-carbon', 'xhigh'), 'high');
  assert.equal(t('gemini-4-hydrogen', 'xhigh'), 'xhigh');
  assert.equal(t('gemini-3.5-flash-lite', 'low'), 'low');
  assert.equal(t('gemini-4-argon', 'medium'), 'medium');
  assert.equal(t('some-new-model', 'high'), undefined, 'an unknown model keeps its own default');
  const body = gemini.requestBody({ model: 'some-new-model', prompt: 'p', effort: 'high', thinkingSummary: false });
  assert.ok(!('thinking_level' in body.generation_config));
  assert.equal(body.generation_config.thinking_summaries, 'none');
});

test('Gemini: web search uses Google Search, and only cited pages become web results', async () => {
  mock.reset();
  const c = collect();
  const out = await gemini.complete({ key: KEY, model: 'gemini-4-argon', effort: 'medium', system: 'S', prompt: 'P', web: true, onEvent: c.onEvent });
  assert.deepEqual(geminiCalls()[0].body.tools, [{ type: 'google_search' }]);
  assert.deepEqual(out.webResults, [{ url: 'https://example.org/report', title: 'example.org' }]);
  assert.ok(c.events.some((e) => e.type === 'status' && /Searching the web/.test(e.text)));
  assert.equal(out.text, fx.withWebLinks(fx.ANSWER_TEXT));
});

test('Gemini: errors are plain sentences, never contain the key, and an unknown model is never swapped', async () => {
  const run = (key, extra = {}) => gemini.complete({ key, model: 'gemini-4-hydrogen', effort: 'low', system: 'S', prompt: 'P', ...extra });
  await assert.rejects(run(''), /No Gemini API key is saved/);
  for (const [key, extra, re] of [
    ['bad-gemini-key', {}, /did not accept the Gemini API key/],
    ['quota-gemini-key', {}, /quota is used up/],
    ['free-gemini-key', { web: true }, /search grounding only on paid Gemini API keys/],
  ]) {
    mock.reset();
    await assert.rejects(run(key, extra), (e) => { assert.match(e.message, re); assert.ok(!e.message.includes(key), 'no key in the message'); return true; });
  }
  mock.reset();
  await assert.rejects(run(KEY, { model: 'no-such-model', strictModel: true }), (e) => { assert.equal(e.code, 'MODEL_REJECTED'); assert.match(e.message, /does not offer the model "no-such-model"/); return true; });
  assert.equal(geminiCalls().length, 1, 'one request: no retry with another model');
  mock.state.fail['generativelanguage.googleapis.com'] = 503;
  await assert.rejects(run(KEY), /busy or unavailable/);
  mock.reset();
});

test('Gemini: a stream cut off half way keeps the partial answer and says so', async () => {
  mock.reset();
  const c = collect();
  const out = await gemini.complete({ key: 'cut-gemini-key', model: 'gemini-4-hydrogen', effort: 'low', system: 'S', prompt: 'P', onEvent: c.onEvent });
  assert.equal(out.text, fx.ANSWER_TEXT.slice(0, Math.ceil(fx.ANSWER_TEXT.length / 2)));
  assert.ok(c.events.some((e) => e.type === 'notice' && /stopped before it finished/.test(e.text)));
});

test('Gemini: the stream reader joins pieces split anywhere, including inside an event', async () => {
  const sse = fx.geminiStream({ text: 'Hello world', model: 'gemini-4-hydrogen' });
  const chunks = [];
  for (let i = 0; i < sse.length; i += 7) chunks.push(new TextEncoder().encode(sse.slice(i, i + 7)));
  const body = new ReadableStream({ start(ctrl) { chunks.forEach((ch) => ctrl.enqueue(ch)); ctrl.close(); } });
  const state = { text: '', model: null, usage: {}, webResults: new Map(), error: null, done: false };
  await gemini.readSse(body, gemini.makeHandler(() => {}, state));
  assert.equal(state.text, 'Hello world');
  assert.equal(state.done, true);
});

test('Gemini status: no key, a refused key, an accepted key, and the Gemini app noticed but never used', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-gemini-app-'));
  fs.mkdirSync(path.join(app, 'Gemini.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Gemini.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.google.GeminiMacOS</string></dict></plist>');
  gemini._setAppPathsForTest([path.join(app, 'Gemini.app')]);
  try {
    mock.reset();
    const none = await gemini.status({ key: '' });
    assert.equal(none.ready, false);
    assert.equal(none.found, false);
    assert.equal(geminiCalls().length, 0, 'no request without a key');
    if (process.platform === 'darwin') assert.match(none.detail, /Gemini app is on this Mac, but Google does not let other apps use its sign-in/);
    const bad = await gemini.status({ key: 'bad-gemini-key' });
    assert.equal(bad.ready, false);
    assert.equal(bad.found, true);
    assert.match(bad.detail, /did not accept/);
    const good = await gemini.status({ key: KEY });
    assert.equal(good.ready, true);
    const check = geminiCalls().find((c) => c.path === '/v1beta/models');
    assert.ok(check && !check.url.includes(KEY), 'the check sends the key in a header too');
  } finally { gemini._setAppPathsForTest([path.join(os.tmpdir(), 'no-such-dir', 'Gemini.app')]); mock.reset(); }
});

test('Gemini key: kept server-side, masked for the window, never taken from GEMINI_API_KEY', async () => {
  process.env.GEMINI_API_KEY = 'from-the-shell-should-be-ignored';
  try {
    const c = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-gemini-cfg-')));
    assert.equal(c.get().keys.gemini, '', 'a shell variable is not a saved key');
    c.update({ keys: { gemini: KEY } });
    assert.equal(c.get().keys.gemini, KEY);
    assert.deepEqual(c.getPublic().keys.gemini, { set: true, hint: '…1234', fromEnv: false });
    assert.ok(!JSON.stringify(c.getPublic()).includes(KEY));
    // The engine list carries the rule that keeps Gemini out of the menus until a key is accepted. The CLI paths are
    // pinned to programs that do not exist, so no real claude or codex is looked at.
    mock.reset();
    const NO = { claude: '/nonexistent/claude', codex: '/nonexistent/codex' };
    c.update({ bins: NO });
    const empty = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-gemini-cfg-')));
    empty.update({ bins: NO });
    const unlinked = (await llm.engineStatus(empty.get())).find((e) => e.id === 'gemini');
    assert.equal(unlinked.hiddenUntilReady, true);
    assert.equal(unlinked.ready, false);
    const linked = (await llm.engineStatus(c.get())).find((e) => e.id === 'gemini');
    assert.equal(linked.ready, true);
    assert.equal(linked.usesKey, true);
  } finally { delete process.env.GEMINI_API_KEY; mock.reset(); }
});
