'use strict';
// The single holdout analysis for version 6 (pre-registration "Primary measures"). Run after the holdout runs:
//   node bench/v6/review-holdout.js      writes bench/results/review6-holdout.json (ids, labels, scores; no text)
const fs = require('fs');
const path = require('path');
const S3 = require('./review-s3');
const { s1Score, flag, median } = require('./review-analyze');
const F = require('./review-freeze');
const { styleReading } = require('../../server/checks/style');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'bench', 'data', 'v6');
const jl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function main() {
  const frozen = F.assertFrozen();
  const L = frozen.lines;
  const corpus = jl(path.join(DATA, 'corpus.jsonl')).filter((x) => x.split === 'holdout');
  const run = (f) => new Map(jl(path.join(DATA, 'runs', f)).map((r) => [r.id, r]));
  const s2r = run('s2-holdout-claude-sonnet-5-5-r1.jsonl');
  const s0r = run('s0-holdout-claude-sonnet-5-5-r1.jsonl');
  const rows = corpus.map((x) => {
    const st = styleReading(x.text);
    const s1 = st ? s1Score(st) : null;
    const a = s2r.get(x.id);
    const b = s0r.get(x.id);
    const m2 = a ? a.meanRating : null;
    const m0 = b ? b.meanRating : null;
    return {
      id: x.id, label: x.label, ai: x.label === 'ai', nn: !!x.nonNative, writer: x.writer, source: x.source, genre: x.genre, words: x.words, group: x.group || x.id, review: !!x.review,
      s0: m0, s1, s2: m2, s3: S3.headlineScore(m2, s1), reportScore: a ? a.reportScore : null, reportFlagged: a ? a.reportFlagged : null,
      s1Flagged: st ? st.flagged : null,
    };
  });
  const rev = rows.filter((r) => r.review);
  const sys = { S0: { f: (r) => r.s0, line: L.S0 }, S1: { f: (r) => r.s1, line: L.S1 }, S2: { f: (r) => r.s2, line: L.S2 }, S3: { f: (r) => r.s3, line: L.S3 } };
  const measure = (set, f, line) => {
    const ai = set.filter((r) => r.ai); const claude = ai.filter((r) => /^claude/.test(r.writer)); const hum = set.filter((r) => !r.ai); const nn = hum.filter((r) => r.nn);
    const k = (a) => a.filter((r) => flag(f(r), line)).length;
    return { ai: S3.wilson(k(ai), ai.length), claude: S3.wilson(k(claude), claude.length), human: S3.wilson(k(hum), hum.length), nonNative: S3.wilson(k(nn), nn.length), auroc: S3.auroc(ai.map(f), hum.map(f)), noScore: set.filter((r) => !Number.isFinite(f(r))).map((r) => r.id) };
  };
  // bootstrap: resample groups within class (AI, human), seed 20261119, 2000 resamples
  const boot = (set, stat, B = 2000) => {
    const rnd = mulberry(20261119);
    const groupsOf = (cls) => { const m = new Map(); for (const r of set.filter((x) => x.ai === cls)) { if (!m.has(r.group)) m.set(r.group, []); m.get(r.group).push(r); } return [...m.values()]; };
    const gA = groupsOf(true); const gH = groupsOf(false);
    const draw = (g) => { const out = []; for (let i = 0; i < g.length; i++) out.push(...g[Math.floor(rnd() * g.length)]); return out; };
    const vals = [];
    for (let b = 0; b < B; b++) vals.push(stat([...draw(gA), ...draw(gH)]));
    vals.sort((x, y) => x - y);
    return [+vals[Math.floor(0.025 * B)].toFixed(3), +vals[Math.floor(0.975 * B) - 1].toFixed(3)];
  };
  const out = { frozen: { choice: frozen.choice, lines: L }, n: { holdout: rows.length, review: rev.length }, parity: {}, systems: {}, paired: {}, secondary: {} };
  for (const [name, s] of Object.entries(sys)) {
    const set = name === 'S1' ? rows : rev;
    out.systems[name] = { set: name === 'S1' ? 'all holdout' : 'review set', ...measure(set, s.f, s.line) };
    out.systems[name].aurocCI = boot(set, (x) => S3.auroc(x.filter((r) => r.ai).map(s.f), x.filter((r) => !r.ai).map(s.f)));
    if (name === 'S1') { out.systems.S1_reviewSet = { set: 'review set', ...measure(rev, s.f, s.line) }; }
  }
  // paired differences on the review set (S3 minus S0), plus S2 and S1 minus S0 for reference
  for (const name of ['S3', 'S2', 'S1']) {
    const f = sys[name].f; const g = sys.S0.f;
    const aiK = (x, h, line) => x.filter((r) => r.ai && flag(h(r), line)).length;
    const humK = (x, h, line) => x.filter((r) => !r.ai && flag(h(r), line)).length;
    const nAi = (x) => x.filter((r) => r.ai).length;
    out.paired[name] = {
      aiFlaggedDiffPoints: {
        value: +(100 * (aiK(rev, f, sys[name].line) / nAi(rev) - aiK(rev, g, L.S0) / nAi(rev))).toFixed(1),
        ci: boot(rev, (x) => 100 * (aiK(x, f, sys[name].line) - aiK(x, g, L.S0)) / nAi(x)).map((v) => +v.toFixed(1)),
      },
      humanFlaggedDiff: { value: humK(rev, f, sys[name].line) - humK(rev, g, L.S0), ci: boot(rev, (x) => humK(x, f, sys[name].line) - humK(x, g, L.S0), 2000).map((v) => +v.toFixed(1)) },
      aurocDiff: { value: +(S3.auroc(rev.filter((r) => r.ai).map(f), rev.filter((r) => !r.ai).map(f)) - S3.auroc(rev.filter((r) => r.ai).map(g), rev.filter((r) => !r.ai).map(g))).toFixed(3), ci: boot(rev, (x) => S3.auroc(x.filter((r) => r.ai).map(f), x.filter((r) => !r.ai).map(f)) - S3.auroc(x.filter((r) => r.ai).map(g), x.filter((r) => !r.ai).map(g))) },
    };
  }
  // parity: the app's own report fields against the headline computed here (S2 rows hold the report's score and flag)
  const par = rev.filter((r) => r.reportScore != null);
  out.parity = { compared: par.length, flagMismatch: par.filter((r) => r.reportFlagged !== flag(r.s3, L.S3)).map((r) => r.id), scoreRoundMismatch: par.filter((r) => Math.abs(r.reportScore - Math.round(r.s3)) > 1).map((r) => r.id) };
  // secondary (never used for a claim)
  const by = (key) => { const o = {}; for (const r of rev) { const k = r[key] || 'n/a'; (o[k] = o[k] || []).push(r); } return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, s0: v.filter((r) => flag(r.s0, L.S0)).length, s2: v.filter((r) => flag(r.s2, L.S2)).length, s3: v.filter((r) => flag(r.s3, L.S3)).length, s1: v.filter((r) => flag(r.s1, L.S1)).length }])); };
  out.secondary = { byWriterOrSource: by('writer'), bySource: by('source'), byLength: (() => { const o = { '80-150': [], '151-400': [], '401+': [] }; for (const r of rev) o[r.words <= 150 ? '80-150' : r.words <= 400 ? '151-400' : '401+'].push(r); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, ai: v.filter((r) => r.ai).length, s3flagged: v.filter((r) => flag(r.s3, L.S3)).length, s3humanFlagged: v.filter((r) => !r.ai && flag(r.s3, L.S3)).length }])); })(), wordCountAuroc: S3.auroc(rev.filter((r) => r.ai).map((r) => r.words), rev.filter((r) => !r.ai).map((r) => r.words)), s3Flagged: rev.filter((r) => flag(r.s3, L.S3)).map((r) => [r.id, r.label, r.nn ? 'nn' : '', r.s3 && +r.s3.toFixed(1)]) };
  out.rows = rows.map(({ group, ...r }) => ({ ...r, s3Flagged: flag(r.s3, L.S3) }));
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', 'review6-holdout.json'), JSON.stringify(out, null, 1));
  const f = (m) => `${m.ai.k}/${m.ai.n} AI (${m.ai.lo}-${m.ai.hi}) | Claude ${m.claude.k}/${m.claude.n} | human ${m.human.k}/${m.human.n} (${m.human.lo}-${m.human.hi}) | nn ${m.nonNative.k}/${m.nonNative.n} (${m.nonNative.lo}-${m.nonNative.hi}) | AUROC ${m.auroc}`;
  for (const [k, v] of Object.entries(out.systems)) console.log(k, v.set, f(v), v.aurocCI || '', 'noScore', v.noScore.length);
  console.log(JSON.stringify(out.paired)); console.log(JSON.stringify(out.parity)); console.log(JSON.stringify(out.secondary.byWriterOrSource), JSON.stringify(out.secondary.byLength), out.secondary.wordCountAuroc);
}
if (require.main === module) main();
