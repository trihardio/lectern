'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../server/config');
const { runRewrite, MAX_CHARS, STYLES, SYSTEM } = require('../server/checks/rewrite');
const { createApp } = require('../server');

function config() {
  const c = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-rewrite-')));
  c.update({ bins: { codex: path.join(__dirname, 'fakes', 'codex'), claude: '/nonexistent/claude' } });
  return c;
}
const original = 'The report states “the observed increase was modest” (Smith, 2022). The team compared both groups [1, 2].\n\nReferences\nSmith (2022). A study.';

test('rewrite preserves protected text and uses the selected model', async () => {
  let call;
  const result = await runRewrite({ text: original, config: config(), engine: 'codex', selectedModel: 'chosen-model', complete: async (o) => {
    call = o;
    const passage = o.prompt.split('Passage to rewrite:\n\n')[1];
    return { text: JSON.stringify({ text: passage.replace('The report states', 'According to the report,') }), model: 'reported-model' };
  } });
  assert.equal(result.text, original.replace('The report states', 'According to the report,'));
  assert.equal(result.protectedCount, 4);
  assert.equal(call.model, 'chosen-model');
  assert.equal(call.strictModel, true);
  assert.equal(result.reportedModel, 'reported-model');
});

test('rewrite rejects missing, duplicated, reordered protected text and malformed model output', async () => {
  for (const edit of [
    (s) => s.replace(/LECTERNPROTECTED\w+?END/, ''),
    (s) => s.replace(/(LECTERNPROTECTED\w+?END)/, '$1$1'),
    (s) => { const matches = [...s.matchAll(/LECTERNPROTECTED\w+?END/g)]; return s.replace(matches[0][0], 'TEMP').replace(matches[1][0], matches[0][0]).replace('TEMP', matches[1][0]); },
  ]) {
    await assert.rejects(runRewrite({ text: original, config: config(), engine: 'codex', complete: async (o) => ({ text: JSON.stringify({ text: edit(o.prompt) }) }) }), /protected quotations or citations/);
  }
  await assert.rejects(runRewrite({ text: original, config: config(), engine: 'codex', complete: async () => ({ text: 'not JSON' }) }), /usable rewrite/);
});

test('rewrite accepts a reply whose JSON string holds raw line breaks (a model writing paragraphs) and keeps the break', async () => {
  // claude-haiku-5-5 returned this shape for 2 of 15 rewrites on 2026-11-19, and the rewrite was lost ("did not return a usable rewrite")
  const original = 'Sticky notes were sold from 1980. They became an office staple within a decade.';
  const result = await runRewrite({ text: original, config: config(), engine: 'codex', complete: async () => ({
    text: '{"text":"Sticky notes went on sale in 1980.\n\nWithin a decade they were an office staple."}', // the \n here are real line breaks inside the JSON string
  }) });
  assert.equal(result.text, 'Sticky notes went on sale in 1980.\n\nWithin a decade they were an office staple.');
  assert.ok(result.check.ok);
});

test('rewrite with a style sample: the sample is sent marked for style only, replaces the style, and its facts count as added', async () => {
  const original = 'The survey reached 412 students in 2021. Most of them preferred evening classes.';
  const sample = 'Honestly I never liked the long lectures. They dragged on and on, and by the end I had stopped taking notes at all, which my tutor in Leeds noticed in 2019 and mentioned twice in one week.';
  let call;
  const result = await runRewrite({ text: original, config: config(), engine: 'codex', style: 'academic', sample, complete: async (o) => {
    call = o;
    return { text: JSON.stringify({ text: 'The survey got to 412 students in 2021, and most of them liked evening classes better.' }) };
  } });
  assert.equal(result.style, 'sample');
  assert.equal(result.sample.words, sample.split(/\s+/).length);
  assert.match(call.system, /Style sample: the writer has supplied a sample/);
  assert.match(call.system, /no facts, claims, names, numbers, examples, phrases or sentences from the sample may appear/);
  assert.doesNotMatch(call.system, /Style \(Academic\)/, 'a sample replaces the picked style');
  assert.ok(call.prompt.startsWith('STYLE SAMPLE (for its style only; never use its content):\n<<<\n' + sample));
  assert.ok(call.prompt.includes('Passage to rewrite:'));
  assert.ok(result.check.ok);
  // a name or number taken from the sample is caught by the same fact check
  const leaked = await runRewrite({ text: original, config: config(), engine: 'codex', sample, complete: async () => ({
    text: JSON.stringify({ text: 'In 2019 and 2021 the survey in Leeds reached 412 students; most preferred evening classes.' }),
  }) });
  assert.equal(leaked.check.ok, false);
});

test('rewrite with a sample under 30 words: ignored, the picked style is used', async () => {
  let call;
  const result = await runRewrite({ text: 'Plain text to rewrite here.', config: config(), engine: 'codex', style: 'casual', sample: 'Too short to show a voice.', complete: async (o) => { call = o; return { text: JSON.stringify({ text: 'Plain text, rewritten.' }) }; } });
  assert.equal(result.style, 'casual');
  assert.equal(result.sample, null);
  assert.doesNotMatch(call.prompt, /STYLE SAMPLE/);
});

test('rewrite styles: General keeps the old instruction, others add a style line, every style keeps the rules', async () => {
  const seen = {};
  const complete = async (o) => { seen.system = o.system; return { text: JSON.stringify({ text: o.prompt.split('Passage to rewrite:\n\n')[1] }) }; };
  const run = (style) => runRewrite({ text: original, config: config(), engine: 'codex', style, complete });
  for (const style of [undefined, 'general', 'nope', '__proto__', 'constructor', 42]) {
    const r = await run(style);
    assert.equal(r.style, 'general', String(style));
    assert.equal(seen.system, SYSTEM, String(style));
  }
  for (const [id, s] of Object.entries(STYLES)) {
    if (id === 'general') continue;
    const r = await run(id);
    assert.equal(r.style, id);
    assert.ok(seen.system.includes(`Style (${s.label}): ${s.say}`), id);
    // The rules that keep facts, quotations and citations, and the JSON reply, are in every style's instruction.
    for (const rule of ['Do not add facts', 'Do not invent sources', 'LECTERNPROTECTED', '{"text":"rewritten passage"}']) assert.ok(seen.system.includes(rule), `${id}: ${rule}`);
    assert.equal(r.text, original, id); // protected parts restored and checked as before
  }
});

test('rewrite styles: the window offers the same styles, in the same order, as the server', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'checks.js'), 'utf8');
  const list = /const REWRITE_STYLES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(list, 'REWRITE_STYLES not found in ui/checks.js');
  const ui = [...list[1].matchAll(/\{ value: '(\w+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(ui, Object.entries(STYLES).map(([id, s]) => [id, s.label]));
});

test('rewrite rejects oversize input before calling a model and does not fall back from the selected provider', async () => {
  let called = false;
  const complete = async () => { called = true; return {}; };
  await assert.rejects(runRewrite({ text: 'a'.repeat(MAX_CHARS + 1), config: config(), complete }), /No text was sent/);
  await assert.rejects(runRewrite({ text: original, config: config(), engine: 'claude-code', complete }), /not connected/);
  assert.equal(called, false);
});

test('rewrite API streams a completed result from the configured provider', async () => {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-rewrite-api-')) });
  app.config.update({ bins: { codex: path.join(__dirname, 'fakes', 'codex'), claude: '/nonexistent/claude' } });
  const pageUrl = await app.listen(0); // the window's address, with the token
  const base = pageUrl.slice(0, pageUrl.indexOf('?'));
  try {
    const response = await fetch(base + 'api/checks/rewrite', { method: 'POST', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: original, engine: 'codex', model: 'gpt-6.1-sol' }) });
    const stream = await response.text();
    const result = /event: result\ndata: (.+)/.exec(stream);
    assert.ok(result, stream);
    assert.equal(JSON.parse(result[1]).text, original.replace('The report states', 'According to the report,'));
    assert.equal(JSON.parse(result[1]).style, 'general');
    // The style travels with the request; an id the server does not know becomes General.
    for (const [style, expected] of [['academic', 'academic'], ['hacker', 'general']]) {
      const r = await fetch(base + 'api/checks/rewrite', { method: 'POST', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: original, engine: 'codex', model: 'gpt-6.1-sol', style }) });
      const m = /event: result\ndata: (.+)/.exec(await r.text());
      assert.ok(m, style);
      assert.equal(JSON.parse(m[1]).style, expected);
    }
  } finally { await app.close(); }
});
