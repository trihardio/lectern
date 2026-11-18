'use strict';
// Version 5 repeat check: the frozen concise-rewrite request (P3) sent a second time to claude-sonnet-5-5 for the first 5
// texts of the Opus check's fixed hash order (3 human, 2 AI), to see how much the unchanged share moves between two runs of
// the same model. A new cache label ("-repeat1") makes these real second calls. Uses the last 5 calls of the Sonnet budget.
//   node bench/review5/repeat-check.js --yes-spend
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('../review/lib');
const { guarded, spent, BUDGET } = require('./run');
const { DATA } = require('./plan');
const RD = require('./rewrite-dist');
const MODEL = 'claude-sonnet-5-5';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const IDS = ['hu-toefl-2', 'hu-news-6', 'hu-news-2', 'hk-labreport-plain', 'hk-blog-concise'];
async function main() {
  if (!process.argv.includes('--yes-spend')) throw new Error('Add --yes-spend (5 calls of claude-sonnet-5-5).');
  const corpus = new Map(fs.readFileSync(path.join(DATA, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((x) => [x.id, x]));
  const first = new Map(fs.readFileSync(path.join(DATA, 'runs', 'P3-test-claude-sonnet-5-5.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((r) => [r.id, r]));
  const llm = require('../../server/llm');
  const { Config } = require('../../server/config');
  const settings = L.guardedSettings(new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-review5-'))).get(), { model: MODEL });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');
  const stats = { cached: 0, paid: 0, inflight: 0 };
  const rows = [];
  for (const id of IDS) {
    const it = corpus.get(id);
    const complete = guarded({ real: (o) => llm.complete(o), model: MODEL, version: `${RD.VERSION}-repeat1`, textHash: sha(it.text), variant: 'P3-repeat', fake: false, stats });
    const out = await complete({ engine: 'claude-code', role: 'main', settings, effort: 'low', model: MODEL, strictModel: true, system: RD.SYSTEM, prompt: RD.prompt(it.text), onEvent: () => {} });
    rows.push({ id, label: it.label, first: first.get(id).unchanged, second: RD.unchangedScore(it.text, out.text), reported: out.model });
  }
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'review5-repeat-check.json'), JSON.stringify({ model: MODEL, finishedAt: new Date().toISOString(), paid: stats.paid, budgetUsed: spent(MODEL), budget: BUDGET[MODEL], rows }, null, 1));
  for (const r of rows) console.log(`${r.id.padEnd(20)} ${r.label.padEnd(6)} first ${r.first}  second ${r.second}  diff ${(r.second - r.first).toFixed(2)}`);
  console.log(`Paid ${stats.paid}; Sonnet budget used ${spent(MODEL)} of ${BUDGET[MODEL]}.`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
