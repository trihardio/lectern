'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./fixtures');

const claudecode = require('../server/llm/claudecode');
const codex = require('../server/llm/codex');
const cli = require('../server/llm/cli');

const FAKES = path.join(__dirname, 'fakes');
const collect = () => { const events = []; return { events, onEvent: (e) => events.push(e), text: () => events.filter((e) => e.type === 'delta').map((e) => e.text).join('') }; };

test('Claude Code: builds a tool-less, plan-billed run and streams the answer', async () => {
  const log = path.join(os.tmpdir(), `lectern-fake-${process.pid}-cc.log`);
  fs.rmSync(log, { force: true });
  process.env.FAKE_LOG = log;
  process.env.ANTHROPIC_API_KEY = 'should-not-reach-the-cli';
  try {
    const c = collect();
    const out = await claudecode.complete({ bin: path.join(FAKES, 'claude'), model: 'claude-opus-5-5', effort: 'high', system: 'Answer.', prompt: 'the prompt', onEvent: c.onEvent });
    assert.equal(out.text, fx.ANSWER_TEXT);
    assert.equal(c.text(), fx.ANSWER_TEXT, 'no doubled text from the final whole message');
    assert.deepEqual(out.usage, { input: 9000, output: 500 });
    assert.ok(c.events.some((e) => e.type === 'thinking'));

    const run = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    const a = run.args;
    assert.equal(a[0], '-p');
    assert.equal(a[a.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.equal(a[a.indexOf('--effort') + 1], 'high');
    assert.equal(a[a.indexOf('--tools') + 1], '', 'all tools off');
    assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(a.includes('--no-session-persistence') && a.includes('--strict-mcp-config'));
    assert.equal(run.hasApiKey, false, 'a stray API key is not passed on, so the plan is used');
    assert.equal(run.safeMode, '1', 'safe mode: the user\'s own CLAUDE.md, hooks, plugins and output styles are not loaded');
    assert.equal(run.inputLength, 'the prompt'.length, 'prompt goes in on stdin');
    assert.match(run.cwd, /lectern-scratch$/, 'runs in an empty scratch folder');

    const web = claudecode.buildArgs({ model: 'opus', effort: 'low', web: true });
    assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch');
    assert.equal(web[web.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  } finally { delete process.env.FAKE_LOG; delete process.env.ANTHROPIC_API_KEY; }
});

test('Claude Code: copes with an older version and with being signed out', async () => {
  process.env.FAKE_REJECT_FLAG = '--effort';
  try {
    const out = await claudecode.complete({ bin: path.join(FAKES, 'claude'), model: 'opus', effort: 'max', prompt: 'p' });
    assert.equal(out.text, fx.ANSWER_TEXT, 'retried without the flag this version does not know');
  } finally { delete process.env.FAKE_REJECT_FLAG; }

  process.env.FAKE_AUTH_FAIL = '1';
  try {
    await assert.rejects(claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p' }), /not signed in/);
  } finally { delete process.env.FAKE_AUTH_FAIL; }

  await assert.rejects(claudecode.complete({ bin: '/nonexistent/claude', prompt: 'p' }), /not found/);
});

test('Codex: read-only run, prompt on stdin, answer and usage parsed', async () => {
  const log = path.join(os.tmpdir(), `lectern-fake-${process.pid}-cx.log`);
  fs.rmSync(log, { force: true });
  process.env.FAKE_LOG = log;
  process.env.OPENAI_API_KEY = 'should-not-reach-the-cli';
  try {
    const c = collect();
    const out = await codex.complete({ bin: path.join(FAKES, 'codex'), model: 'gpt-x', effort: 'high', system: 'Answer.', prompt: 'p', web: true, onEvent: c.onEvent });
    assert.equal(out.text, fx.withWebLinks(fx.ANSWER_TEXT));
    assert.deepEqual(out.webResults, [{ url: 'https://example.org/report', title: '' }], 'the page the web search opened');
    assert.deepEqual(out.usage, { input: 8800, output: 450 });
    const run = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.deepEqual(run.args.slice(0, 6), ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only']);
    assert.ok(run.args.includes('model_reasoning_effort="high"'));
    assert.ok(run.args.includes('web_search="live"'));
    assert.equal(run.args[run.args.length - 1], '-');
    assert.equal(run.hasApiKey, false);
  } finally { delete process.env.FAKE_LOG; delete process.env.OPENAI_API_KEY; }
});

test('Codex: drops options a different version rejects', async () => {
  process.env.FAKE_REJECT_FLAG = '--skip-git-repo-check';
  process.env.FAKE_REJECT_WEB = '1';
  try {
    const out = await codex.complete({ bin: path.join(FAKES, 'codex'), effort: 'low', prompt: 'p', web: true });
    assert.equal(out.text, fx.ANSWER_TEXT);
  } finally { delete process.env.FAKE_REJECT_FLAG; delete process.env.FAKE_REJECT_WEB; }
});

test('a CLI that rejects a safety option is never run without it: Lectern asks for an update', async () => {
  const log = path.join(os.tmpdir(), `lectern-fake-${process.pid}-safety.log`);
  for (const [mod, name, flag] of [
    [claudecode, 'claude', '--tools'], [claudecode, 'claude', '--disallowedTools'], [claudecode, 'claude', '--strict-mcp-config'],
    [claudecode, 'claude', '--no-session-persistence'], [codex, 'codex', '--sandbox'], [codex, 'codex', '--ephemeral'],
  ]) {
    fs.rmSync(log, { force: true });
    process.env.FAKE_REJECT_FLAG = flag;
    process.env.FAKE_LOG = log;
    try {
      await assert.rejects(mod.complete({ bin: path.join(FAKES, name), prompt: 'p', effort: 'low', web: flag === '--tools' }),
        (e) => e.code === 'CLI_TOO_OLD' && /too old for Lectern's safety settings\. Update it, then try again\./.test(e.message), `${name} ${flag}`);
      assert.ok(!fs.existsSync(log), `${name} never answered without ${flag}`);
    } finally { delete process.env.FAKE_REJECT_FLAG; delete process.env.FAKE_LOG; }
  }
});

test('Claude Code: if safe mode ever refused the sign-in, one run without it still answers', async () => {
  const log = path.join(os.tmpdir(), `lectern-fake-${process.pid}-safe.log`);
  fs.rmSync(log, { force: true });
  process.env.FAKE_SAFE_AUTH_FAIL = '1';
  process.env.FAKE_LOG = log;
  const say = console.error;
  console.error = () => {};
  try {
    const out = await claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p' });
    assert.equal(out.text, fx.ANSWER_TEXT);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((r) => r.safeMode), ['1', null]);
  } finally { console.error = say; delete process.env.FAKE_SAFE_AUTH_FAIL; delete process.env.FAKE_LOG; }
});

test('Claude Code: web results come from the search results in the stream, not from links the model writes', async () => {
  const out = await claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p', web: true });
  assert.match(out.text, /not-searched\.example/, 'the model also wrote a link from memory');
  assert.deepEqual(out.webResults.map((w) => w.url), ['https://example.org/report', 'https://example.org/other']);
  assert.equal(out.webResults[0].title, 'Sample report');
  const off = await claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p' });
  assert.deepEqual(off.webResults, [], 'no web search, no web results');
});

test('Claude Code: an answer that ran out of web-search turns is kept, with a note', async () => {
  process.env.FAKE_MAX_TURNS = '1';
  try {
    const c = collect();
    const out = await claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p', web: true, onEvent: c.onEvent });
    assert.equal(out.text, fx.withWebLinks(fx.ANSWER_TEXT), 'the streamed answer is not lost');
    assert.ok(c.events.some((e) => e.type === 'notice' && /used all of its web-search steps/.test(e.text)));
  } finally { delete process.env.FAKE_MAX_TURNS; }
});

test('quitting stops a model that is still writing (stopAll), and a status check that hangs is killed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-stop-'));
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_HANG = '1';
  process.env.FAKE_IGNORE_TERM = '1'; // only SIGKILL ends it
  process.env.FAKE_PID_FILE = pidFile;
  try {
    const running = claudecode.complete({ bin: path.join(FAKES, 'claude'), prompt: 'p' });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(cli._running.size, 1, 'the run is in the registry');
    cli.stopAll();
    await assert.rejects(running);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the CLI process is gone');
    assert.equal(cli._running.size, 0);

    fs.rmSync(pidFile, { force: true });
    const started = Date.now();
    const quick = await cli.runQuick(path.join(FAKES, 'claude'), ['auth', 'status'], { timeout: 200 });
    assert.equal(quick.code, 1);
    assert.ok(Date.now() - started < 4500, 'killed after the grace period although it ignores SIGTERM');
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), /ESRCH/);
  } finally { delete process.env.FAKE_HANG; delete process.env.FAKE_IGNORE_TERM; delete process.env.FAKE_PID_FILE; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status checks: callers that ask at the same time share one check', async () => {
  const cache = cli.statusCache();
  let runs = 0;
  const compute = async () => { runs++; await new Promise((r) => setTimeout(r, 50)); return { ready: true }; };
  const results = await Promise.all([cache('bin', compute), cache('bin', compute), cache('bin', compute)]);
  assert.equal(runs, 1);
  assert.ok(results.every((r) => r.ready));
  assert.equal((await cache('bin', compute)).ready, true);
  assert.equal(runs, 1, 'a ready status is remembered');
});

test('tests can only start the stand-in tools', async () => {
  const say = console.error;
  console.error = () => {}; // the guard's loud message is expected here
  try {
    await assert.rejects(cli.findBin('claude', '/bin/ls'), /Tests may only run the stand-ins in test\/fakes/);
  } finally { console.error = say; }
  process.exitCode = 0; // the guard also marks the test file failed; this test expects that guard to fire
  assert.equal(await cli.findBin('claude', path.join(FAKES, 'claude')), path.join(FAKES, 'claude'));
});

test('a running CLI stops when the question is cancelled', async () => {
  const slow = path.join(os.tmpdir(), `lectern-slow-${process.pid}`);
  fs.writeFileSync(slow, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n', { mode: 0o755 });
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(claudecode.complete({ bin: slow, prompt: 'p', signal: ac.signal }), /Stopped/);
  assert.ok(Date.now() - started < 3000);
  fs.rmSync(slow, { force: true });
});


test('Codex reports a failure even after partial output', async () => {
  process.env.FAKE_PARTIAL_FAIL = '1';
  try {
    await assert.rejects(codex.complete({ bin: path.join(FAKES, 'codex'), prompt: 'p' }), /Codex stopped with an error \(exit 1\): provider failed after partial output\./);
  } finally { delete process.env.FAKE_PARTIAL_FAIL; }
});
