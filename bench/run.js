'use strict';
// Run a pre-registered evaluation (see PREREGISTRATION.md) and write bench/results/<system>-<split>.{json,md}.
//
//   node bench/run.js --system measured --split dev       free; freezes the measured-index threshold from dev
//   node bench/run.js --system measured --split holdout   free; needs the frozen threshold; run it once
//   node bench/run.js --system review --split holdout --engine claude-code --model <id> --limit 60 --yes-spend
//        USES MODEL CREDITS: one or more requests per document through your signed-in plan
//   node bench/run.js --system review --split holdout --fake --limit 12
//        checks the pipeline with the offline fake model (no credits; the numbers mean nothing)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('./metrics');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const RESULTS = path.join(__dirname, 'results');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

// ---- pre-registered decision rules (PREREGISTRATION.md, version 1). Changing these needs a new version and fresh holdout data.
const PREREG = Object.freeze({
  version: 1,
  measured: { targetDevFpr: 0.05 }, // threshold = the lowest score that flags at most 5% of DEVELOPMENT human texts
  review: { flagAtScore: 20 }, // a document is flagged when the headline share is 20% or more; no score = abstained
  claim: { maxFprUpper: 0.05, minDetectionLower: 0.8, maxAbstention: 0.1 }, // all must hold on the holdout, overall and for non-native writers
  lengthBins: [[0, 149, 'under 150 words'], [150, 299, '150-299 words'], [300, 599, '300-599 words'], [600, Infinity, '600+ words']],
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function configHash() {
  const files = ['server/checks/aiscore.js', 'server/checks/text.js', 'server/prompts.js', 'bench/metrics.js', 'bench/run.js', 'bench/split.js'];
  return Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f)))]));
}
const lengthBin = (n) => PREREG.lengthBins.find(([lo, hi]) => n >= lo && n <= hi)[2];
const load = (split) => fs.readFileSync(path.join(DATA, `${split}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);

/** A seeded, stratified subset: up to `limit` documents spread over label x source, non-native essays included. */
function stratified(items, limit, seed = 11) {
  const r = M.rng(seed);
  const cells = new Map();
  for (const it of items) { const k = `${it.label}|${it.source}|${it.writer}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(it); }
  for (const list of cells.values()) list.sort(() => r() - 0.5);
  const out = [];
  while (out.length < limit && [...cells.values()].some((l) => l.length)) for (const l of cells.values()) if (l.length && out.length < limit) out.push(l.shift());
  return out;
}

function groupTable(rows, key) {
  const groups = new Map();
  for (const x of rows) { const k = key(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => ({ group: k, ...M.summarise(list) }));
}

const fmtCi = (w) => (w ? `${(w.p * 100).toFixed(1)}% (${(w.lo * 100).toFixed(1)}–${(w.hi * 100).toFixed(1)})` : '–');

function markdown(res) {
  const s = res.overall;
  const lines = [
    `# ${res.system === 'measured' ? 'Measured index (style-only)' : 'Model writing-pattern review'} on the ${res.split} split`,
    '',
    `Run ${res.finishedAt}. Pre-registration version ${res.prereg.version}. ${res.note || ''}`,
    `Decision rule: ${res.rule}. Documents: ${res.rows.length} (${s.n.human} human, ${s.n.ai} AI, ${s.n.mixed} AI-edited human).`,
    '',
    '| Measure | Value (95% CI) |', '|---|---|',
    `| False positive rate (human texts flagged) | ${fmtCi(s.falsePositiveRate)} |`,
    `| Detection rate (AI texts flagged) | ${fmtCi(s.detectionRate)} |`,
    `| Abstained or failed | ${fmtCi(s.abstentionRate)} |`,
    `| AI-edited human texts flagged | ${fmtCi(s.mixedFlagRate)} |`,
    `| AUROC (continuous score, human vs AI) | ${res.auroc == null ? '–' : `${res.auroc.toFixed(3)} (${res.aurocCi ? `${res.aurocCi.lo.toFixed(3)}–${res.aurocCi.hi.toFixed(3)}` : '–'})`} |`,
    `| Balanced accuracy | ${s.balancedAccuracy == null ? '–' : `${(s.balancedAccuracy * 100).toFixed(1)}%`} |`,
    `| Precision if 5% / 10% / 20% / 50% of texts were AI | ${s.ppv ? Object.values(s.ppv).map((v) => (v == null ? '–' : `${(v * 100).toFixed(0)}%`)).join(' / ') : '–'} |`,
    '',
    `Confusion (human/AI only): TP ${s.confusion.tp}, FN ${s.confusion.fn}, FP ${s.confusion.fp}, TN ${s.confusion.tn}.`,
    '',
  ];
  for (const [title, table] of Object.entries(res.groups)) {
    lines.push(`## By ${title}`, '', '| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |', '|---|---|---|---|---|---|---|');
    for (const g of table) lines.push(`| ${g.group} | ${g.n.human} | ${fmtCi(g.falsePositiveRate)} | ${g.n.ai} | ${fmtCi(g.detectionRate)} | ${g.n.mixed} | ${fmtCi(g.mixedFlagRate)} |`);
    lines.push('');
  }
  lines.push('## Claim check (pre-registered)', '', res.claim.text, '', 'Small groups have wide intervals; a point estimate on a few dozen documents is not a reliable rate.', '');
  return lines.join('\n');
}

function claimCheck(rows) {
  const c = PREREG.claim;
  const all = M.summarise(rows);
  const nn = M.summarise(rows.filter((x) => x.writer === 'non-native (TOEFL)'));
  const unattacked = M.summarise(rows.filter((x) => x.attack === 'none'));
  const checks = [
    ['overall false positive rate upper bound <= 5%', all.falsePositiveRate && all.falsePositiveRate.hi <= c.maxFprUpper],
    ['non-native false positive rate upper bound <= 5%', nn.falsePositiveRate && nn.falsePositiveRate.hi <= c.maxFprUpper],
    ['detection rate lower bound on unattacked AI >= 80%', unattacked.detectionRate && unattacked.detectionRate.lo >= c.minDetectionLower],
    ['abstention <= 10%', all.abstentionRate && all.abstentionRate.p <= c.maxAbstention],
  ];
  const pass = checks.every(([, ok]) => ok);
  return { pass, checks: checks.map(([name, ok]) => ({ name, ok: !!ok })), text: `${pass ? 'MET' : 'NOT MET'}: ${checks.map(([n, ok]) => `${ok ? 'pass' : 'fail'} - ${n}`).join('; ')}. ${pass ? 'A stronger claim may be considered after repeatability and fresh-holdout checks.' : 'Strong authorship or accuracy claims stay disabled.'}` };
}

async function main() {
  const system = arg('system', 'measured');
  const split = arg('split', 'dev');
  if (!['measured', 'review'].includes(system) || !['dev', 'holdout'].includes(split)) throw new Error('Use --system measured|review and --split dev|holdout.');
  fs.mkdirSync(RESULTS, { recursive: true });
  let items = load(split);
  const startedAt = new Date().toISOString();
  let rule;
  let note = '';
  let rows;

  if (system === 'measured') {
    const { measure } = require('../server/checks/aiscore');
    const T = require('../server/checks/text');
    // Exactly what the app scores: normalised (zero-width characters removed, line endings tidied) and capped.
    const appMeasure = (raw) => measure(T.capWords(T.normalizeText(raw)).text).readings.docSignal;
    const scored = items.map((it) => ({ ...it, score: appMeasure(it.text) }));
    const frozenFile = path.join(RESULTS, 'frozen-measured.json');
    let threshold;
    if (split === 'dev') {
      threshold = M.thresholdForFpr(scored.filter((x) => x.label === 'human').map((x) => x.score), PREREG.measured.targetDevFpr);
      fs.writeFileSync(frozenFile, JSON.stringify({ threshold, chosenOn: 'dev', targetDevFpr: PREREG.measured.targetDevFpr, frozenAt: startedAt, config: configHash() }, null, 1));
      note = `Threshold ${threshold.toFixed(2)} chosen on this split and frozen for the holdout.`;
    } else {
      if (!fs.existsSync(frozenFile)) throw new Error('Run the dev split first: the holdout uses the threshold frozen there.');
      const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8'));
      threshold = frozen.threshold;
      const now = configHash();
      const changed = Object.keys(now).filter((f) => frozen.config[f] !== now[f]);
      note = `Threshold ${threshold.toFixed(2)} frozen on dev at ${frozen.frozenAt}.${changed.length ? ` WARNING: files changed since the threshold was frozen: ${changed.join(', ')}.` : ' Scoring files unchanged since then.'}`;
    }
    rule = `flag when the measured index >= ${threshold.toFixed(2)}`;
    rows = scored.map((x) => ({ ...x, decision: x.score >= threshold }));
  } else {
    const fake = !!arg('fake', false);
    const limit = Number(arg('limit', 30));
    if (!fake && !arg('yes-spend', false)) {
      throw new Error(`This run sends up to ${limit} documents to your model (at least ${limit} requests on your plan). Add --yes-spend to confirm, or --fake to test the pipeline offline.`);
    }
    items = stratified(items, limit);
    const { runAiCheck } = require('../server/checks/aiscore');
    const { Config } = require('../server/config');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-bench-'));
    const config = new Config(dir);
    if (fake) config.update({ bins: { claude: path.join(ROOT, 'test', 'fakes', 'claude'), codex: path.join(ROOT, 'test', 'fakes', 'codex') } });
    const engine = arg('engine', 'claude-code');
    const model = arg('model', undefined);
    rows = [];
    for (const it of items) {
      const t0 = Date.now();
      try {
        const r = await runAiCheck({ text: it.text, config, engine, selectedModel: typeof model === 'string' ? model : undefined });
        rows.push({ ...it, score: r.score, status: r.status, coverage: r.coverage, reported: r.provenance.reportedModels, decision: r.score == null ? null : r.score >= PREREG.review.flagAtScore, ms: Date.now() - t0 });
      } catch (e) {
        rows.push({ ...it, score: null, status: 'error', error: e.message, decision: null, ms: Date.now() - t0 });
      }
      process.stdout.write(`\r${rows.length}/${items.length}`);
    }
    process.stdout.write('\n');
    rule = `flag when the headline share >= ${PREREG.review.flagAtScore}%; no score = abstained`;
    note = fake ? 'FAKE MODEL: checks the pipeline only; these numbers say nothing about accuracy.' : `Live model: ${engine}${model ? ` / ${model}` : ''}.`;
  }

  rows.forEach((x) => { x.lengthBin = lengthBin(x.words); });
  const hum = rows.filter((x) => x.label === 'human' && x.score != null).map((x) => x.score);
  const ai = rows.filter((x) => x.label === 'ai' && x.score != null).map((x) => x.score);
  const res = {
    system, split, prereg: PREREG, rule, note, startedAt, finishedAt: new Date().toISOString(), config: configHash(),
    overall: M.summarise(rows),
    auroc: M.auroc(ai, hum),
    aurocCi: M.bootstrap(rows.filter((x) => x.score != null && x.label !== 'mixed'), (s) => M.auroc(s.filter((x) => x.label === 'ai').map((x) => x.score), s.filter((x) => x.label === 'human').map((x) => x.score)), { reps: 500 }),
    groups: {
      source: groupTable(rows, (x) => x.source),
      'writer group': groupTable(rows, (x) => x.writer),
      domain: groupTable(rows, (x) => `${x.source}: ${x.domain}`),
      generator: groupTable(rows, (x) => x.generator),
      'attack or edit': groupTable(rows, (x) => x.attack),
      length: groupTable(rows, (x) => x.lengthBin),
    },
    claim: split === 'holdout' ? claimCheck(rows) : { pass: false, text: 'Not checked on the development split.' },
    rows: rows.map(({ text, ...r }) => r),
  };
  const name = `${system}-${split}${arg('fake', false) ? '-fake' : ''}`;
  fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(RESULTS, `${name}.md`), markdown(res));
  console.log(markdown(res).split('\n').slice(0, 16).join('\n'));
  console.log(`\nWritten: bench/results/${name}.md and .json`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { PREREG, stratified, lengthBin, claimCheck };
