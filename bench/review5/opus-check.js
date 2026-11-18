'use strict';
// Version 5 Opus direction check (bench/PREREGISTRATION.md, version 5): the frozen concise-rewrite request (P3 of
// rewrite-dist.js, exactly the same system text and prompt) sent to claude-opus-5-5, the app's default main model, on 12
// test texts picked by a fixed hash rule (6 human, 4 AI, 2 edited). Compares the share of unchanged words with the Sonnet
// run on the same texts. Direction only: 12 texts support no rate. Claude Code only, through guarded() of run.js, which
// enforces the 12-call Opus budget.
//   node bench/review5/opus-check.js --yes-spend

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('../review/lib');
const { guarded, spent, BUDGET } = require('./run');
const { DATA } = require('./plan');
const RD = require('./rewrite-dist');
const T = require('../../server/checks/text');
const { styleReading } = require('../../server/checks/style');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = 'claude-opus-5-5';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'results', 'review5-frozen.json'), 'utf8'));
const P = frozen.params;
const logit = (p) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
const zOf = (U, styleP) => ((U - P.mA) / P.sA + (logit(styleP) - P.mS) / P.sS) / 2;

function pick(items) {
  const by = (label, n) => items.filter((x) => x.label === label).sort((a, b) => sha(`opus5${a.id}`).localeCompare(sha(`opus5${b.id}`))).slice(0, n);
  return [...by('human', 6), ...by('ai', 4), ...by('edited', 2)];
}

async function main() {
  if (!process.argv.includes('--yes-spend')) throw new Error(`This sends 12 texts to ${MODEL} on the owner's Claude plan. Add --yes-spend.`);
  const items = pick(fs.readFileSync(path.join(DATA, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.split === 'test'));
  const sonnet = new Map(fs.readFileSync(path.join(DATA, 'runs', 'P3-test-claude-sonnet-5-5.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((r) => [r.id, r]));
  const llm = require('../../server/llm');
  const { Config } = require('../../server/config');
  const settings = L.guardedSettings(new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-review5-'))).get(), { model: MODEL });
  if (settings.engine !== 'claude-code' || settings.bins.codex !== '/nonexistent/codex') throw new Error('Codex guard failed.');
  const stats = { cached: 0, paid: 0, inflight: 0 };
  const runFile = path.join(DATA, 'runs', `P3-opus-check-${MODEL}.jsonl`);
  const rows = [];
  for (const it of items) {
    const complete = guarded({ real: (o) => llm.complete(o), model: MODEL, version: RD.VERSION, textHash: sha(it.text), variant: 'P3-opus', fake: false, stats });
    const out = await complete({ engine: 'claude-code', role: 'main', settings, effort: 'low', model: MODEL, strictModel: true, system: RD.SYSTEM, prompt: RD.prompt(it.text), onEvent: () => {} });
    const U = RD.unchangedScore(it.text, out.text);
    const s = styleReading(T.capWords(T.normalizeText(it.text)).text);
    const son = sonnet.get(it.id);
    const row = { id: it.id, label: it.label, reported: out.model, opusU: U, sonnetU: son ? son.unchanged : null, style: s ? s.probability : null };
    row.opusFlag = U != null && s ? zOf(U, s.probability) >= frozen.threshold : null;
    row.sonnetFlag = row.sonnetU != null && s ? zOf(row.sonnetU, s.probability) >= frozen.threshold : null;
    fs.appendFileSync(runFile, `${JSON.stringify({ ...row, revised: out.text })}\n`);
    rows.push(row);
    process.stdout.write(`\r${rows.length}/${items.length}`);
  }
  process.stdout.write('\n');
  const diffs = rows.filter((r) => r.opusU != null && r.sonnetU != null).map((r) => r.opusU - r.sonnetU);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const summary = { version: 5, check: 'opus direction', model: MODEL, finishedAt: new Date().toISOString(), paid: stats.paid, cached: stats.cached, opusBudgetUsed: spent(MODEL), opusBudget: BUDGET[MODEL], meanOpusMinusSonnetU: +mean.toFixed(2), agreeing: rows.filter((r) => r.opusFlag === r.sonnetFlag).length, rows };
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', 'review5-opus-check.json'), JSON.stringify(summary, null, 1));
  for (const r of rows) console.log(`${r.id.padEnd(24)} ${r.label.padEnd(7)} U opus ${r.opusU} sonnet ${r.sonnetU} style ${r.style}  flag opus ${r.opusFlag} sonnet ${r.sonnetFlag}`);
  console.log(`Mean Opus minus Sonnet unchanged share: ${mean.toFixed(2)} points; decisions agree on ${summary.agreeing} of ${rows.length}. Opus calls paid ${stats.paid}; budget used ${spent(MODEL)} of ${BUDGET[MODEL]}.`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
