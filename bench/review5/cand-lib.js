'use strict';
// Helpers for the version 5 candidate search (bench/results/review5-candidates.md). Reads scores and, for the style
// reading and the rewrite distance, the corpus texts of the requested split only. Nothing here calls a model.
const fs = require('fs');
const path = require('path');
const { measures } = require('./analyze');
const style = require('../../server/checks/style');
const { DATA } = require('./plan');

const RESULTS = path.join(__dirname, '..', 'results');
const readJson = (f) => JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(RESULTS, f), 'utf8'));
const corpus = () => fs.readFileSync(path.join(DATA, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

const logit = (p) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };

/** Rows of one split with: meanRating (shipped), style probability, roberta ai_prob. Only the named split is touched. */
function rowsFor(split) {
  if (!['dev', 'test'].includes(split)) throw new Error('split dev|test');
  const shipped = readJson('review5-shipped-all-claude-sonnet-5-5.json').rows.filter((r) => r.split === split);
  const rob = new Map(readJson('review5-opensource-roberta-large-openai.json').results.map((r) => [r.id, r]));
  const text = new Map(corpus().filter((x) => x.split === split).map((x) => [x.id, x.text]));
  return shipped.map((r) => {
    const sr = style.styleReading(text.get(r.id));
    return { ...r, styleProb: sr ? sr.probability : null, styleLogit: sr ? logit(sr.probability) : null, roberta: rob.has(r.id) ? rob.get(r.id).ai_prob : null };
  });
}

/** Highest threshold (most cautious) at which at most maxHuman human texts are flagged and balanced accuracy is highest. */
function pickThreshold(rows, score, maxHuman) {
  const vals = [...new Set(rows.filter((r) => r[score] != null).map((r) => r[score]))].sort((a, b) => a - b);
  let best = null;
  for (const t of vals) {
    const m = measures(rows, { score, threshold: t });
    if (m.humanFlagged.k > maxHuman) continue;
    if (!best || m.balancedAccuracy > best.m.balancedAccuracy || (m.balancedAccuracy === best.m.balancedAccuracy && t > best.t)) best = { t, m };
  }
  return best;
}

const line = (name, m) => `${name} | thr ${m.threshold} | bal ${(100 * m.balancedAccuracy).toFixed(1)}% | acc ${m.accuracy.k}/${m.accuracy.n} | human flagged ${m.humanFlagged.k}/${m.humanFlagged.n} | AI ${m.caught.ai.k}/${m.caught.ai.n} | edited ${m.caught.edited.k}/${m.caught.edited.n} | AUROC ${m.auroc.all == null ? '-' : m.auroc.all.toFixed(3)} (AI ${m.auroc.ai.toFixed(3)}, ed ${m.auroc.edited.toFixed(3)})`;

module.exports = { readJson, corpus, rowsFor, pickThreshold, line, logit, measures, RESULTS };
