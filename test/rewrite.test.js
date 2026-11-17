'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../server/config');
const { runRewrite, MAX_CHARS } = require('../server/checks/rewrite');
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
  } finally { await app.close(); }
});
