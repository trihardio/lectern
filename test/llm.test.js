'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./fixtures');

const claudecode = require('../server/llm/claudecode');
const codex = require('../server/llm/codex');

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
    assert.equal(out.text, fx.ANSWER_TEXT);
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
  process.env.FAKE_REJECT_FLAG = '--ephemeral';
  process.env.FAKE_REJECT_WEB = '1';
  try {
    const out = await codex.complete({ bin: path.join(FAKES, 'codex'), effort: 'low', prompt: 'p', web: true });
    assert.equal(out.text, fx.ANSWER_TEXT);
  } finally { delete process.env.FAKE_REJECT_FLAG; delete process.env.FAKE_REJECT_WEB; }
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
    await assert.rejects(codex.complete({ bin: path.join(FAKES, 'codex'), prompt: 'p' }), /provider failed after partial output/);
  } finally { delete process.env.FAKE_PARTIAL_FAIL; }
});
