'use strict';
// S1b: read the cached S0 replies again with the working tree's parser and scores (free: no model call).
// The replies are the ones S0 received; the sentences they rate must be the same sentences, or the document is refused.
// Used by bench/review/analyze.js.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

function cachedReplies(codeVersion, model) {
  const dir = L.cacheDir ? L.cacheDir(false) : path.join(L.DATA, 'reply-cache');
  const byText = new Map();
  for (const f of fs.readdirSync(dir)) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (e.codeVersion === codeVersion && e.model === model) byText.set(e.textHash, e);
  }
  return byText;
}

/** Rows in the shape run.js writes, rebuilt from S0's cached replies with the working tree's code. */
function replayRows(run, split) {
  const ai = require('../../server/checks/aiscore');
  const T = require('../../server/checks/text');
  const items = new Map(fs.readFileSync(path.join(L.DATA, `${split}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse).map((x) => [x.id, x]));
  const replies = cachedReplies(run.codeVersion, run.model);
  return run.rows.map((row) => {
    const it = items.get(row.id);
    const e = replies.get(L.sha(it.text));
    const base = { id: row.id, system: 'S1b', split, model: run.model, codeVersion: run.codeVersion };
    if (!e) return { ...base, score: null, status: 'error', error: 'No cached S0 reply for this document.', sentences: [] };
    const m = ai.measure(T.capWords(T.normalizeText(it.text)).text);
    const groups = ai.batches(m.prose);
    if (groups.length !== 1) return { ...base, score: null, status: 'error', error: 'The working tree reads this text as several parts, so the S0 reply does not apply.', sentences: [] };
    const ids = groups[0].map((s) => s.i + 1);
    // The reply is only valid for the sentences S0 numbered: compare with what S0 recorded.
    const mine = m.units.filter((s) => m.perSentence.get(s.i) && s.prose).map((s) => s.i);
    const theirs = (row.sentences || []).map((s) => s.i);
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) return { ...base, score: null, status: 'error', error: 'The working tree splits this text into different sentences than S0 did.', sentences: [] };
    const r = ai.parseReview(e.text, ids);
    const sentences = m.units.filter((s) => s.prose && m.perSentence.get(s.i)).map((s) => {
      const md = r.ratings.get(s.i + 1);
      return { i: s.i, words: m.perSentence.get(s.i).words, review: md ? 'model' : 'unreviewed', rating: md ? md.rating : null };
    });
    const eligibleWords = sentences.reduce((n, s) => n + s.words, 0);
    const out = { ...base, status: r.status, eligibleWords, overall: r.overall == null ? null : r.overall, sentences, parseProblems: r.problems };
    const ds = ai.documentScores({ sentences: sentences.map((s) => ({ ...s, eligible: true })), eligibleWords, overall: out.overall });
    return { ...out, score: ds.strongShare };
  });
}

module.exports = { replayRows, cachedReplies };
