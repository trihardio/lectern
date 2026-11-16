'use strict';
// AI-writing check: a WRITING-PATTERN REVIEW, not an authorship detector.
//
//   1. Signals measured here, with no model: rhythm (how much sentence length varies), how evenly paragraphs
//      are cut, words whose use rose sharply after ChatGPT appeared (Kobak et al., 2025; Liang et al., 2024),
//      stock phrases and signpost openers. They are shown as evidence and are NOT part of the score.
//   2. A reading by the model the user selected, which rates each sentence 0-100 for how strongly it shows
//      generic, formulaic writing patterns, and must name the features it saw.
//
// Honesty rules (from the "AI score accuracy audit", 2026-11-15):
//   - Every sentence records where its rating came from. A sentence the model did not rate validly is
//     "not reviewed": it is never filled in from other signals and never counted as "few patterns".
//   - The model's reply is validated (JSON shape, integer sentence numbers inside the batch, ratings that are
//     real numbers 0-100, no conflicting duplicates). Failed and partial batches are kept in the report.
//   - The headline is the share of REVIEWED words in sentences rated strong; its denominator and the coverage
//     are always reported. No score is given when coverage or length is too low.
//   - Long sentences are cut into parts the model reads whole, so no unseen text is rated.
//   - Writing suggestions are kept only when the quoted words occur exactly once inside the sentence the
//     model named.
//   - The selected model is used or the check fails; the provider-reported model is recorded when the
//     provider reports one.
//   - The method has not been validated on an independent benchmark (see bench/). DETECTOR_VALIDATED stays
//     false until a pre-registered holdout evaluation supports a stronger claim.

const llm = require('../llm');
const Prompts = require('../prompts');
const { extractJson } = require('../util');
const T = require('./text');

// ---- words that became far more frequent in writing after LLMs (Kobak et al. 2025, Figure S6; Liang et al. 2024)
const STRONG = new Set(`delve delves delved delving intricate intricately intricacies meticulous meticulously pivotal showcase showcases showcased
showcasing underscore underscores underscored underscoring realm realms tapestry multifaceted nuanced interplay commendable groundbreaking
transformative seamless seamlessly unparalleled unveil unveils unveiled unveiling harness harnesses harnessing leverage leverages leveraging
bolster bolstered bolstering burgeoning invaluable noteworthy elucidate elucidates elucidating encompass encompasses encompassing foster fosters
fostering paving garner garnered garnering illuminate illuminates illuminating interconnectedness juxtaposed uncharted underexplored unraveling
revolutionize revolutionizing endeavor endeavors endeavour endeavours embark embarking testament beacon navigating landscape crucial
accentuates accentuating indispensable labyrinth culminating heighten heightened profound vibrant`.split(/\s+/));
const WEAK = new Set(`accentuate acknowledges adept advancements advocating akin align aligns amidst augmenting avenue avenues capabilities capitalizing
compelling comprehending comprising consolidates crafted crafting delineates dependable discern discernible discerning distinctive elevate elevates
elevating embracing emphasizes emphasizing employing empowers emulating enabling encapsulates enduring enhancements enhances ensuring equipping
escalating excels exceptional exceptionally exerting expedite facilitates facilitating formidable foundational furnish grappling groundwork hinges
imperative impressive inherent innovative integrates interplay juxtapose methodologies necessitate necessitates notable notably optimizing orchestrating
pinpoint pioneering poised predominantly propelling pronounced refining remarkable renowned scrutinize scrutinizing shedding signifying solidify
spurred streamline streamlined streamlining substantiated surmount surpass surpassing unlocking upholding utilizes versatility warranting
comprehensive enhancing valuable insights robust holistic myriad plethora realm noteworthy strategically additionally moreover furthermore`.split(/\s+/));

const PHRASES = [
  [/\bit is (?:important|worth|crucial|essential|vital) to (?:note|consider|remember|recognize|recognise|acknowledge|highlight)\b/gi, 'Stock phrase'],
  [/\bplays? an? (?:crucial|pivotal|vital|key|significant|critical|central|essential|important) role\b/gi, 'Stock phrase'],
  [/\bin today'?s (?:fast-paced|digital|modern|ever-changing|rapidly changing|interconnected) (?:world|age|landscape|era|society)\b/gi, 'Stock opening'],
  [/\b(?:rich|complex|intricate|vibrant) tapestry\b/gi, 'Stock phrase'],
  [/\bnavigat(?:e|es|ing) the (?:complexities|challenges|intricacies|landscape|nuances)\b/gi, 'Stock phrase'],
  [/\b(?:ever-evolving|ever-changing|rapidly evolving|constantly evolving) (?:landscape|field|world|nature)\b/gi, 'Stock phrase'],
  [/\b(?:is|stands as|serves as) a testament to\b|\ba testament to\b/gi, 'Stock phrase'],
  [/\bserves? as a (?:reminder|cornerstone|catalyst|foundation|powerful)\b/gi, 'Stock phrase'],
  [/\bshed(?:s|ding)? (?:new )?light on\b/gi, 'Stock phrase'],
  [/\bpav(?:e|es|ing) the way\b/gi, 'Stock phrase'],
  [/\b(?:delve|delves|delving|dive|dives|diving) (?:deep(?:er)? )?into\b/gi, 'Stock phrase'],
  [/\b(?:a|the) (?:myriad|plethora) of\b/gi, 'Stock phrase'],
  [/\b(?:unlock|unlocking|harness|harnessing|realize|realise) (?:the |its |their )?(?:full )?(?:potential|power)\b/gi, 'Stock phrase'],
  [/\bby (?:leveraging|harnessing|utilizing|utilising)\b/gi, 'Stock phrase'],
  [/\b(?:a|an) (?:nuanced|holistic|comprehensive|deeper) (?:understanding|approach|view|perspective)\b/gi, 'Stock phrase'],
  [/\b(?:these|this|the) (?:findings|results|insights) (?:underscore|highlight|emphasi[sz]e|illustrate)\b/gi, 'Stock phrase'],
  [/\bnot only\b[^.!?]{3,90}?\bbut also\b/gi, 'Set pattern ("not only ... but also")'],
  [/\b(?:it'?s|it is|this is) not (?:just|merely|simply|only) (?:about )?[^.!?;]{2,60}?[,;—-]+\s*(?:it'?s|it is|but)\b/gi, 'Set pattern ("not just X, it is Y")'],
  [/\bwhether you'?re\b/gi, 'Stock phrase'],
  [/\bin (?:conclusion|summary|essence)\b|\bto sum up\b|\ball in all\b/gi, 'Summary signpost'],
  [/\bat the (?:end of the day|heart of)\b/gi, 'Stock phrase'],
  [/\b(?:key|crucial|essential|valuable) (?:insights|takeaways|considerations)\b/gi, 'Stock phrase'],
  [/\b(?:offers?|provides?) (?:a |an )?(?:valuable|unique|comprehensive) (?:insights?|perspective|overview|framework)\b/gi, 'Stock phrase'],
  [/\b(?:remains|is) (?:a )?(?:complex|multifaceted) (?:issue|challenge|topic)\b/gi, 'Stock phrase'],
];
const SIGNPOSTS = /^(?:furthermore|moreover|additionally|in addition|consequently|ultimately|overall|notably|importantly|crucially|in conclusion|in summary|thus|hence|therefore|conversely|similarly|indeed|firstly|secondly|lastly|finally)\b,?/i;


const DETECTOR_VALIDATED = false;
const SCORING = Object.freeze({
  version: 2,
  bands: Object.freeze({ strong: 65, some: 40 }), // display bands of the model's own 0-100 rating, not probabilities
  minReviewedWords: 80, // fewer reviewed words: no headline score
  minCoverage: 0.6, // less than this share of eligible words reviewed: no headline score
  maxUnitChars: 900, // longer sentences are cut into parts the model reads whole
  batchChars: 12000, // about 3,000 tokens of sentences per request
  batchUnits: 60,
  maxSpanUnits: 8, // the prompt allows 6 sentences per span; wider spans are rejected, not truncated
  workers: 3,
});
const LIMITS = [
  'This is a writing-pattern review, not an AI detector. It has not been validated on an independent benchmark, and its numbers are not probabilities that a person or a model wrote the text.',
  'Human writing can show these patterns (formal, formulaic or carefully edited prose), and AI-assisted writing can avoid them. Non-native English, short texts and heavily edited texts are judged least reliably.',
  'Do not use this result as evidence against a writer. A person should review the reasons and the text itself.',
];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const cv = (a) => { if (a.length < 2) return null; const m = mean(a); if (!m) return null; const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2))); return sd / m; };

/** Is this "sentence" prose worth reviewing (not a heading, list stub or reference entry)? */
function isProse(s, excluded) {
  const n = T.words(s.text).length;
  if (n < 5) return false;
  if (T.inRanges(s.start, excluded)) return false;
  return /[.!?…]["'”’)\]]*$/.test(s.text.trim()) || n >= 12;
}

/**
 * Review units: prose sentences, with a sentence longer than SCORING.maxUnitChars cut into parts.
 * Returns { units: [{ i, start, end, text, part, prose }], paragraphs, excluded }.
 */
function unitsOf(text) {
  const { paragraphs, sentences } = T.segment(text);
  const excluded = T.exclusions(text, { quotes: false, references: true });
  const units = [];
  for (const s of sentences) {
    const prose = isProse(s, excluded);
    const parts = prose ? T.splitLong(text, s, SCORING.maxUnitChars) : [{ start: s.start, end: s.end, text: s.text, part: false }];
    for (const p of parts) units.push({ i: units.length, start: p.start, end: p.end, text: p.text, part: p.part, prose });
  }
  return { units, paragraphs, excluded };
}

/** Signals measured on the text alone: evidence per unit and document-level readings. Not part of the score. */
function measure(text) {
  const { units, paragraphs, excluded } = unitsOf(text);
  const prose = units.filter((u) => u.prose);
  const proseWords = prose.reduce((n, s) => n + T.words(s.text).length, 0);

  const perSentence = new Map();
  let lexWeight = 0;
  let phraseCount = 0;
  let signposts = 0;
  for (const s of prose) {
    const ws = T.words(s.text);
    const hits = [];
    let lex = 0;
    for (const w of T.words(text.slice(s.start, s.end))) {
      const lw = w.lower;
      const strong = STRONG.has(lw);
      if (strong || WEAK.has(lw)) {
        lex += strong ? 1 : 0.35;
        hits.push({ start: s.start + w.start, end: s.start + w.end, label: strong ? 'Word much more common in AI writing since 2023' : 'Word somewhat more common in AI writing since 2023', word: w.w });
      }
    }
    const phrases = [];
    const raw = text.slice(s.start, s.end);
    for (const [re, label] of PHRASES) {
      re.lastIndex = 0;
      for (const m of raw.matchAll(re)) phrases.push({ start: s.start + m.index, end: s.start + m.index + m[0].length, label, word: m[0] });
    }
    const signpost = SIGNPOSTS.test(s.text.trim());
    const dashes = (s.text.match(/—|\s--\s/g) || []).length;
    const triad = /\b\w+(?:\s\w+){0,3},\s\w+(?:\s\w+){0,3},?\s(?:and|or)\s\w+/.test(s.text);
    lexWeight += lex;
    phraseCount += phrases.length;
    if (signpost) signposts++;
    perSentence.set(s.i, { lex, phrases, hits, signpost, dashes, triad, words: ws.length });
  }

  const lengths = prose.map((s) => perSentence.get(s.i).words);
  const rhythm = prose.length >= 8 ? cv(lengths) : null;
  const paraLens = paragraphs.map((p) => T.words(text.slice(p.start, p.end)).length).filter((n) => n >= 25);
  const paraCv = paraLens.length >= 4 ? cv(paraLens) : null;
  const per1000 = (x) => (proseWords ? (x * 1000) / proseWords : 0);
  const lexRate = per1000(lexWeight);
  const phraseRate = per1000(phraseCount);
  const signpostShare = prose.length ? signposts / prose.length : 0;

  // A fixed, hand-weighted summary of the signals ("measured index"). It is reported for transparency and is
  // the style-only baseline in bench/; it is NOT calibrated and is not part of the headline score.
  const u = {
    rhythm: rhythm == null ? 0.3 : clamp01((0.55 - rhythm) / 0.3),
    paragraphs: paraCv == null ? 0.3 : clamp01((0.5 - paraCv) / 0.35),
    vocabulary: clamp01(lexRate / 14),
    phrases: clamp01(phraseRate / 4),
    signposts: clamp01((signpostShare - 0.05) / 0.2),
  };
  const docSignal = 0.22 * u.rhythm + 0.08 * u.paragraphs + 0.32 * u.vocabulary + 0.23 * u.phrases + 0.15 * u.signposts;

  for (const s of prose) {
    const f = perSentence.get(s.i);
    f.reasons = [];
    const strongWords = [...new Set(f.hits.filter((x) => /much/.test(x.label)).map((x) => x.word.toLowerCase()))];
    const weakWords = [...new Set(f.hits.filter((x) => /somewhat/.test(x.label)).map((x) => x.word.toLowerCase()))];
    if (strongWords.length) f.reasons.push(`Uses words whose use rose sharply in published writing after ChatGPT: ${strongWords.slice(0, 5).join(', ')}.`);
    else if (weakWords.length >= 2) f.reasons.push(`Several words that became more common after ChatGPT: ${weakWords.slice(0, 5).join(', ')}.`);
    for (const p of f.phrases.slice(0, 2)) f.reasons.push(`${p.label}: “${p.word}”.`);
    if (f.signpost) f.reasons.push('Opens with a signpost word (a common pattern when it repeats).');
    if (f.dashes >= 2) f.reasons.push('Several em dashes.');
  }

  return {
    units, prose, proseWords, excluded, perSentence,
    readings: {
      rhythm: rhythm == null ? null : +rhythm.toFixed(2),
      paragraphVariation: paraCv == null ? null : +paraCv.toFixed(2),
      vocabularyPer1000: +lexRate.toFixed(1),
      phrasesPer1000: +phraseRate.toFixed(1),
      signpostShare: +signpostShare.toFixed(2),
      docSignal: Math.round(docSignal * 100),
    },
  };
}

/** Group units into batches the model can read whole: bounded by characters (about tokens) and count, in order. */
function batches(units, maxChars = SCORING.batchChars, maxUnits = SCORING.batchUnits) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const s of units) {
    const c = s.text.length + 8;
    if (cur.length && (n + c > maxChars || cur.length >= maxUnits)) { out.push(cur); cur = []; n = 0; }
    cur.push(s); n += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Strict number parsing: null, '', true and '12abc' are not numbers here (Number(null) would be 0).
const intOf = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : NaN);

/**
 * Validate a model reply for one batch. `ids` are the 1-based unit numbers in the batch.
 * Returns { status: 'complete'|'partial'|'failed', ratings: Map(n -> { rating, why }), missing: [n], problems: {...},
 *           issues: [...], summary, error }.
 */
function parseReview(raw, ids) {
  const idSet = new Set(ids);
  const problems = { invalidSpans: 0, outOfBatch: 0, tooWide: 0, conflicts: 0 };
  const json = extractJson(raw);
  if (!json || typeof json !== 'object' || !Array.isArray(json.spans)) {
    return { status: 'failed', ratings: new Map(), missing: ids.slice(), problems, issues: [], summary: '', error: 'The model’s reply was not the expected JSON, so nothing in this part was reviewed.' };
  }
  const ratings = new Map();
  const conflicted = new Set();
  for (const sp of json.spans) {
    if (!sp || typeof sp !== 'object') { problems.invalidSpans++; continue; }
    const from = intOf(sp.from);
    const to = sp.to == null ? from : intOf(sp.to);
    const rating = numOf(sp.ai);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || !(rating >= 0 && rating <= 100)) { problems.invalidSpans++; continue; }
    if (to - from + 1 > SCORING.maxSpanUnits) { problems.tooWide++; continue; }
    let outside = false;
    for (let k = from; k <= to; k++) if (!idSet.has(k)) outside = true;
    if (outside) { problems.outOfBatch++; continue; }
    const why = typeof sp.why === 'string' ? sp.why.slice(0, 240) : '';
    for (let k = from; k <= to; k++) {
      const had = ratings.get(k);
      if (had && had.rating !== Math.round(rating)) conflicted.add(k);
      else if (!had) ratings.set(k, { rating: Math.round(rating), why });
    }
  }
  for (const k of conflicted) { ratings.delete(k); problems.conflicts++; }
  const missing = ids.filter((k) => !ratings.has(k));
  const status = ratings.size === 0 ? 'failed' : missing.length ? 'partial' : 'complete';
  return {
    status, ratings, missing, problems,
    issues: Array.isArray(json.issues) ? json.issues.slice(0, 40) : [],
    summary: typeof json.summary === 'string' ? json.summary.slice(0, 400) : '',
    error: status === 'failed' ? 'The model’s reply rated none of the sentences in this part validly.' : '',
  };
}

const ISSUE_KINDS = new Set(['grammar', 'spelling', 'punctuation', 'word choice', 'clarity', 'wordiness', 'repetition', 'tone', 'citation', 'unsupported claim', 'consistency']);

/** Percentages that add up to exactly 100 (largest remainder), for parts given in words. */
function percents(parts, total) {
  if (!total) return Object.fromEntries(Object.keys(parts).map((k) => [k, 0]));
  const raw = Object.entries(parts).map(([k, v]) => [k, (100 * v) / total]);
  const floor = raw.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
  let left = 100 - floor.reduce((n, x) => n + x[1], 0);
  floor.sort((a, b) => b[2] - a[2]);
  for (const x of floor) { if (left <= 0) break; if (x[2] > 0) { x[1]++; left--; } }
  return Object.fromEntries(floor.map(([k, v]) => [k, v]));
}

const bandOf = (rating) => (rating >= SCORING.bands.strong ? 'strong' : rating >= SCORING.bands.some ? 'some' : 'few');

/**
 * Run the whole AI-writing check.
 * emit(event, data): 'step' { id, state, detail }, 'notice' { text }, 'result' { ...report }.
 * `complete` can be replaced in tests and in bench/ (default: the signed-in model through server/llm).
 */
async function runAiCheck({ text: input, config, signal, emit = () => {}, engine: preferred, selectedModel, complete = (o) => llm.complete(o) }) {
  const startedAt = new Date().toISOString();
  const normal = T.normalizeText(input);
  const { text, trimmed, totalWords } = T.capWords(normal);
  if (T.words(text).length < 40) throw Object.assign(new Error('Add at least 40 words of text to check.'), { status: 400 });

  emit('step', { id: 'signals', state: 'now' });
  const m = measure(text);
  emit('step', { id: 'signals', state: 'done', detail: `${m.prose.length} sentences measured` });

  const settings = config.get();
  let engine;
  if (preferred) {
    const statuses = await llm.engineStatus(settings);
    const choice = statuses.find((s) => s.id === preferred);
    if (!choice || !choice.ready) throw new Error('The selected model provider is not connected. Sign in or choose a connected provider.');
    engine = preferred;
  } else engine = await llm.pickEngine(settings);

  const notes = [];
  if (trimmed) notes.push(`Only the first ${T.MAX_WORDS.toLocaleString('en')} of ${totalWords.toLocaleString('en')} words were checked.`);
  const requestedModel = engine ? (selectedModel || settings.models[engine] || '') : '';
  const ratings = new Map(); // unit index -> { rating, why }
  const unreviewedWhy = new Map(); // unit index -> reason
  const batchLog = [];
  const issuesByBatch = [];
  const summaries = [];
  let stopReason = '';

  if (!engine) {
    stopReason = 'No model is connected, so nothing was reviewed. Sign in to Claude or ChatGPT to run the review.';
  } else {
    const groups = batches(m.prose);
    emit('step', { id: 'model', state: 'now', detail: groups.length > 1 ? `0 of ${groups.length} parts read` : '' });
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < groups.length && !stopReason) {
        const k = next++;
        const batch = groups[k];
        const ids = batch.map((s) => s.i + 1);
        const entry = { n: k + 1, from: ids[0], to: ids[ids.length - 1], units: ids.length, words: batch.reduce((n, s) => n + T.words(s.text).length, 0), status: 'failed', error: '', problems: null, unrated: ids.length, reportedModel: null, ms: 0 };
        batchLog[k] = entry;
        const t0 = Date.now();
        try {
          const out = await complete({
            engine, role: 'main', settings, effort: 'low', model: requestedModel || undefined, strictModel: !!requestedModel,
            system: Prompts.AI_REVIEW_SYSTEM,
            prompt: Prompts.aiReviewPrompt(batch.map((s) => ({ n: s.i + 1, text: s.text })), settings.profile),
            signal, onEvent: () => {},
          });
          entry.reportedModel = out && typeof out.model === 'string' ? out.model : null;
          const r = parseReview(out && out.text, ids);
          entry.status = r.status; entry.error = r.error; entry.problems = r.problems; entry.unrated = r.missing.length;
          for (const [n, v] of r.ratings) ratings.set(n - 1, v);
          for (const n of r.missing) unreviewedWhy.set(n - 1, r.status === 'failed' ? r.error : 'The model did not give this sentence a valid rating.');
          issuesByBatch[k] = { ids: new Set(ids), issues: r.issues };
          if (r.summary) summaries[k] = r.summary;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          entry.error = e.message || 'The request failed.';
          for (const n of ids) unreviewedWhy.set(n - 1, `This part could not be read: ${entry.error}`);
          if (e.code === 'MODEL_REJECTED') stopReason = entry.error; // the same rejection would repeat: stop, do not switch
        }
        entry.ms = Date.now() - t0;
        if (entry.status === 'failed') emit('notice', { text: `Part ${entry.n} of ${groups.length} was not reviewed: ${entry.error}` });
        else if (entry.status === 'partial') emit('notice', { text: `Part ${entry.n} of ${groups.length}: ${entry.unrated} of ${entry.units} sentences were not rated validly and are marked “not reviewed”.` });
        done++;
        if (groups.length > 1) emit('step', { id: 'model', state: 'now', detail: `${done} of ${groups.length} parts read` });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCORING.workers, groups.length) }, worker));
    for (let k = 0; k < groups.length; k++) {
      if (!batchLog[k]) { // never sent (the run stopped early)
        const ids = groups[k].map((s) => s.i + 1);
        batchLog[k] = { n: k + 1, from: ids[0], to: ids[ids.length - 1], units: ids.length, words: groups[k].reduce((n, s) => n + T.words(s.text).length, 0), status: 'not sent', error: stopReason, problems: null, reportedModel: null, ms: 0 };
        for (const n of ids) unreviewedWhy.set(n - 1, `Not sent: ${stopReason}`);
      }
    }
    const anyRated = ratings.size > 0;
    emit('step', { id: 'model', state: anyRated ? 'done' : 'failed' });
  }

  // ---- per-unit results
  const sentences = m.units.map((s) => {
    const f = m.perSentence.get(s.i);
    if (!s.prose || !f) return { i: s.i, start: s.start, end: s.end, part: s.part, eligible: false };
    const md = ratings.get(s.i);
    return {
      i: s.i, start: s.start, end: s.end, part: s.part, eligible: true, words: f.words,
      review: md ? 'model' : 'unreviewed',
      rating: md ? md.rating : null,
      band: md ? bandOf(md.rating) : null,
      why: md ? md.why : '',
      unreviewedReason: md ? '' : (unreviewedWhy.get(s.i) || stopReason || 'Not reviewed.'),
      signals: f.reasons,
      marks: [...f.hits, ...f.phrases].map((h) => ({ start: h.start, end: h.end, label: h.label })),
    };
  });

  const eligible = sentences.filter((s) => s.eligible);
  const sum = (list) => list.reduce((n, s) => n + s.words, 0);
  const eligibleWords = sum(eligible);
  const reviewed = eligible.filter((s) => s.review === 'model');
  const reviewedWords = sum(reviewed);
  const wordsIn = (band) => sum(reviewed.filter((s) => s.band === band));
  const coverage = eligibleWords ? reviewedWords / eligibleWords : 0;
  const status = !reviewed.length ? 'unavailable' : reviewedWords < eligibleWords ? 'partial' : 'complete';
  const lengthCategory = eligibleWords < SCORING.minReviewedWords ? 'short' : eligibleWords < 300 ? 'brief' : 'standard';

  let score = null;
  let withheld = '';
  const firstError = (batchLog.find((b) => b && b.error) || {}).error;
  if (status === 'unavailable') withheld = stopReason || (firstError ? `Nothing was reviewed. ${firstError}` : 'The model reviewed none of the text, so there is no score.');
  else if (reviewedWords < SCORING.minReviewedWords) withheld = `Only ${reviewedWords} words were reviewed; a score needs at least ${SCORING.minReviewedWords}.`;
  else if (coverage < SCORING.minCoverage) withheld = `Only ${Math.round(coverage * 100)}% of the eligible text was reviewed; a score needs at least ${Math.round(SCORING.minCoverage * 100)}%.`;
  else score = Math.round((100 * wordsIn('strong')) / reviewedWords);

  if (status === 'partial') notes.push(`The model reviewed ${reviewedWords.toLocaleString('en')} of ${eligibleWords.toLocaleString('en')} eligible words (${Math.round(coverage * 100)}%). The rest is marked “not reviewed” and is not counted either way.`);
  if (lengthCategory === 'short') notes.push('Short text: the result describes very little writing, so read the individual sentences rather than the totals.');

  // ---- writing suggestions: only where the quote occurs exactly once inside the sentence the model named
  const issues = [];
  let rejectedSuggestions = 0;
  const seen = new Set();
  issuesByBatch.forEach((b) => {
    if (!b) return;
    for (const iss of b.issues) {
      const n = intOf(iss && iss.s);
      const unit = Number.isInteger(n) && b.ids.has(n) ? m.units[n - 1] : null;
      const at = unit ? T.locateWithin(text, iss.quote, unit.start, unit.end) : null;
      if (!at) { rejectedSuggestions++; continue; }
      const key = `${at.start}:${at.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = ISSUE_KINDS.has(String(iss.kind || '').toLowerCase()) ? String(iss.kind).toLowerCase() : 'clarity';
      issues.push({ start: at.start, end: at.end, sentence: n - 1, kind, note: String(iss.note || '').slice(0, 220), fix: typeof iss.fix === 'string' ? iss.fix.slice(0, 220) : '' });
    }
  });
  issues.sort((a, b) => a.start - b.start);

  const reported = [...new Set(batchLog.map((b) => b && b.reportedModel).filter(Boolean))];
  return {
    kind: 'writing-pattern-review',
    text, words: T.words(text).length,
    status, score, scoreWithheld: withheld,
    eligibleWords, reviewedWords, coverage: +coverage.toFixed(3),
    bands: percents({ strong: wordsIn('strong'), some: wordsIn('some'), few: wordsIn('few'), notReviewed: eligibleWords - reviewedWords }, eligibleWords),
    bandWords: { strong: wordsIn('strong'), some: wordsIn('some'), few: wordsIn('few'), notReviewed: eligibleWords - reviewedWords },
    lengthCategory,
    sentences, issues, rejectedSuggestions,
    readings: m.readings,
    summary: summaries.filter(Boolean).join(' ').slice(0, 600),
    excluded: m.excluded,
    notes,
    limits: LIMITS,
    validated: DETECTOR_VALIDATED,
    provenance: {
      engine: engine || null,
      requestedModel: engine ? (requestedModel || null) : null, // null: the provider's own default model
      reportedModels: reported, // what the provider said it used; empty when it does not say (Codex)
      modelConfirmed: reported.length > 0,
      batches: batchLog.filter(Boolean),
      startedAt, finishedAt: new Date().toISOString(),
      scoring: SCORING,
    },
  };
}

module.exports = { runAiCheck, measure, unitsOf, batches, parseReview, percents, STRONG, WEAK, PHRASES, SCORING, LIMITS, DETECTOR_VALIDATED };
