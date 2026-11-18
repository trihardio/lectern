'use strict';
// Free check: read the cached replies of a finished S2 run again through the current working-tree runAiCheck (no model call: the
// model function only serves the cache, and a missing reply is an error) and compare with the stored result.
//   node bench/review/replay-check.js <result file> dev|holdout [--threshold 53.8]
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');
const { cachedReplies } = require('./replay');

async function main() {
  const file = process.argv[2];
  const split = process.argv[3];
  const ti = process.argv.indexOf('--threshold');
  const threshold = ti === -1 ? 53.8 : Number(process.argv[ti + 1]);
  const run = JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(L.ROOT, 'bench', 'results', file), 'utf8'));
  const ai = require('../../server/checks/aiscore');
  const { Config } = require('../../server/config');
  const settings = L.guardedSettings(new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-replay-'))).get(), { model: run.model, claudeBin: path.join(L.ROOT, 'test', 'fakes', 'claude') });
  const config = L.guardedConfig(settings);
  const items = new Map(fs.readFileSync(path.join(L.DATA, `${split}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse).map((x) => [x.id, x]));
  const replies = cachedReplies(run.codeVersion, run.model);
  const out = { documents: 0, scored: 0, sameMeanRating: 0, sameDecision: 0, sameRatings: 0, noReply: 0, differences: [] };
  for (const row of run.rows) {
    const it = items.get(row.id);
    const e = replies.get(L.sha(it.text));
    out.documents++;
    if (!e) { out.noReply++; out.differences.push(`${row.id}: no cached reply`); continue; }
    const r = await ai.runAiCheck({ text: it.text, config, engine: 'claude-code', selectedModel: run.model, complete: async () => ({ text: e.text, model: e.reportedModel, usage: {} }) });
    const stored = ai.documentScores({ sentences: (row.sentences || []).map((s) => ({ ...s, eligible: true })), eligibleWords: row.eligibleWords, overall: row.overall });
    const now = ai.documentScores(r);
    const sameRatings = JSON.stringify(r.sentences.filter((s) => s.eligible).map((s) => [s.i, s.words, s.rating])) === JSON.stringify((row.sentences || []).map((s) => [s.i, s.words, s.rating]));
    if (sameRatings) out.sameRatings++; else out.differences.push(`${row.id}: ratings differ`);
    if (stored.meanRating != null || now.meanRating != null) out.scored++;
    if (stored.meanRating === now.meanRating && (r.scoreExact === undefined || r.scoreExact === now.meanRating)) out.sameMeanRating++; else out.differences.push(`${row.id}: meanRating ${stored.meanRating} -> ${now.meanRating}`);
    const dStored = stored.meanRating != null && stored.meanRating >= threshold;
    const dNow = r.flagged != null ? !!r.flagged : now.meanRating != null && now.meanRating >= threshold;
    if (dStored === dNow) out.sameDecision++; else out.differences.push(`${row.id}: decision ${dStored} -> ${dNow}`);
  }
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
