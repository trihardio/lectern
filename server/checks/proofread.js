'use strict';
// Proofreading: grammar, spelling, punctuation and capital-letter mistakes, found by the selected model and
// turned into exact, minimal edits.
//
// Sentences go to the model in numbered batches. For each sentence it changes, the model returns the whole
// corrected sentence; this file compares it with the original word by word, so every suggestion points at the
// exact characters it replaces, and applying every suggestion gives exactly the model's correction. Nothing the
// model says is trusted blindly: a reply that is not a correction of the sentence it names (too many changes), an
// edit inside a quotation, citation, link or code, and a full stop added to a heading are all dropped and counted.
//
// The method follows Karpo and Chernodub (2026), arXiv:2609.10810 (see PROOFREAD_SYSTEM in server/prompts.js).
// Accuracy is measured in bench/grammar; it is not 100%, and the window says so.

const crypto = require('crypto');
const llm = require('../llm');
const Prompts = require('../prompts');
const T = require('./text');
const { extractJson } = require('../util');

const PROOF = Object.freeze({
  version: 1,
  maxChars: 40000, // about 6,000 words in one check
  batchUnits: 25, // sentences per request
  batchChars: 4000,
  maxUnitChars: 900,
  workers: 3,
  effort: 'low',
  maxChange: 0.5, // a reply that changes more than half of a sentence's words (and more than 3) is not trusted
});

const VARIANTS = Object.freeze(['auto', 'us', 'uk', 'au', 'ca']);

// ERRANT type codes the prompt allows, and the kind of suggestion each becomes in the window.
const TYPE_KIND = {
  SPELL: 'spelling', ORTH: 'capitalization', PUNCT: 'punctuation',
  ADJ: 'word', ADV: 'word', NOUN: 'word', VERB: 'word',
};
const TYPE_TITLE = {
  'VERB:SVA': 'Subject-verb agreement', 'VERB:TENSE': 'Verb tense', 'VERB:FORM': 'Verb form', 'VERB:INFL': 'Verb form',
  'NOUN:NUM': 'Singular or plural', 'NOUN:INFL': 'Noun form', 'NOUN:POSS': 'Possessive', DET: 'Article or determiner',
  PREP: 'Preposition', PRON: 'Pronoun', 'ADJ:FORM': 'Comparison', MORPH: 'Word form', PART: 'Particle',
  CONJ: 'Conjunction', CONTR: 'Contraction', WO: 'Word order', OTHER: 'Grammar',
};
const KIND_TITLE = { spelling: 'Spelling', grammar: 'Grammar', punctuation: 'Punctuation', capitalization: 'Capital letter', spacing: 'Spacing', word: 'Word choice' };
const KIND_WHY = {
  spelling: 'This word looks misspelt.',
  grammar: 'This part of the sentence is not grammatical.',
  punctuation: 'The punctuation here looks wrong.',
  capitalization: 'This needs a different capital letter.',
  spacing: 'The spacing here looks wrong.',
  word: 'This word does not fit the meaning.',
};

// ---------------------------------------------------------------- sentences and batches

/** Sentence units with exact offsets. `src` is the sentence with line breaks turned into spaces (same length). */
function unitsOf(text) {
  const { sentences, paragraphs } = T.segment(text);
  const units = [];
  for (const s of sentences) {
    const block = paragraphs[s.para];
    for (const p of T.splitLong(text, s, PROOF.maxUnitChars)) {
      const raw = text.slice(p.start, p.end);
      if (!/\p{L}/u.test(raw)) continue; // numbers or symbols only: nothing to proofread
      const ownLine = !!block && block.start === s.start && block.end === s.end;
      const heading = !p.part && ownLine && !/[.!?…:;]["'”’)\]]*$/.test(raw.trim()) && T.words(raw).length <= 12;
      units.push({ i: units.length, start: p.start, end: p.end, src: raw.replace(/[\r\n]/g, ' '), heading });
    }
  }
  return units;
}

function batches(units) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const u of units) {
    if (cur.length && (cur.length >= PROOF.batchUnits || chars + u.src.length > PROOF.batchChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(u);
    chars += u.src.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- reading the model's reply

/**
 * Parse one batch reply. Returns { status: 'complete'|'failed', fixes: Map(n -> { text, changes }), problems, error }.
 * A sentence that is not listed has no corrections. A fix for a number outside the batch, a repeated number or a
 * fix without text is a problem and is not used.
 */
function parseReply(raw, ids) {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object' || !Array.isArray(json.fixes)) {
    return { status: 'failed', fixes: new Map(), problems: 1, error: 'The model did not reply in the expected format.' };
  }
  const allowed = new Set(ids);
  const fixes = new Map();
  let problems = 0;
  for (const f of json.fixes) {
    const n = f && typeof f.n === 'number' && Number.isInteger(f.n) ? f.n : (f && typeof f.n === 'string' && /^\d+$/.test(f.n.trim()) ? Number(f.n.trim()) : NaN);
    if (!allowed.has(n) || fixes.has(n) || typeof f.text !== 'string' || !f.text.trim()) { problems++; continue; }
    const changes = Array.isArray(f.changes) ? f.changes.filter((c) => c && typeof c === 'object').slice(0, 40).map((c) => ({
      from: typeof c.from === 'string' ? c.from.slice(0, 300) : '',
      to: typeof c.to === 'string' ? c.to.slice(0, 300) : '',
      type: typeof c.type === 'string' ? c.type.trim().toUpperCase().slice(0, 20) : '',
      why: typeof c.why === 'string' ? c.why.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    })) : [];
    fixes.set(n, { text: f.text.replace(/[\r\n]+/g, ' '), changes });
  }
  return { status: 'complete', fixes, problems, error: '' };
}

// ---------------------------------------------------------------- comparing a sentence with its correction

const TOKEN_RE = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|\S/gu;
function tokens(s) {
  const out = [];
  for (const m of s.matchAll(TOKEN_RE)) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Word-level edit alignment. Returns the matched token pairs [[i, j], ...] in order, and the edit distance. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d[i][j] === d[i - 1][j - 1] + 1) { i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return { pairs: pairs.reverse(), distance: d[n][m] };
}

// Changes that are a matter of typography, not correctness: curly versus straight quotes, dash style, ellipsis.
const typo = (s) => s.normalize('NFC').replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"').replace(/[‐‑‒–—]/g, '-').replace(/…/g, '...');
const bare = (s) => s.replace(/\s+/g, '');

/**
 * Turn (original sentence, corrected sentence) into exact edits on the original. `gapIsSpace(a, b)` says whether the
 * original text between offsets a and b counts as one space (a line break inside a paragraph does). Returns
 * [{ start, end, to }] with offsets into `src`; applying them all gives `corr` (apart from typography-only changes,
 * which are left out).
 */
function diffEdits(src, corr, gapIsSpace = () => false) {
  const a = tokens(src);
  const b = tokens(corr);
  const { pairs } = align(a.map((x) => x.t), b.map((x) => x.t));
  const anchors = [[-1, -1], ...pairs, [a.length, b.length]];
  const edits = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [pi, pj] = anchors[k];
    const [ni, nj] = anchors[k + 1];
    let os = pi < 0 ? 0 : a[pi].end;
    let oe = ni >= a.length ? src.length : a[ni].start;
    let cs = pj < 0 ? 0 : b[pj].end;
    let ce = nj >= b.length ? corr.length : b[nj].start;
    let from = src.slice(os, oe);
    let to = corr.slice(cs, ce);
    if (from === to) continue;
    if (!bare(from) && !bare(to) && (gapIsSpace(os, oe) || (pi < 0 || ni >= a.length)) && to.length <= 1) continue; // a line break, or the edges
    if (typo(from) === typo(to)) continue;
    // A change that is only spacing, or that adds words between two kept words, is shown on the word before it.
    if (!bare(from)) {
      if (pi >= 0) { os = a[pi].start; cs = b[pj].start; }
      else if (ni < a.length) { oe = a[ni].end; ce = b[nj].end; }
      from = src.slice(os, oe);
      to = corr.slice(cs, ce);
    }
    // Spaces both sides keep are not part of the edit.
    while (os < oe && cs < ce && /\s/.test(src[os]) && src[os] === corr[cs]) { os++; cs++; }
    while (oe > os && ce > cs && /\s/.test(src[oe - 1]) && src[oe - 1] === corr[ce - 1]) { oe--; ce--; }
    edits.push({ start: os, end: oe, to: corr.slice(cs, ce) });
  }
  return edits;
}

/** Damerau-Levenshtein distance for short words. */
function wordDistance(x, y) {
  const n = x.length;
  const m = y.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}

/** What kind of change this is, from the change itself first and the model's label second. */
function kindOf(from, to, type) {
  const f = from.trim();
  const t = to.trim();
  if (bare(f) === bare(t)) return 'spacing';
  if (bare(f).toLowerCase() === bare(t).toLowerCase()) return 'capitalization';
  const strip = (s) => s.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (strip(f) === strip(t)) {
    // An apostrophe added or removed inside a word (its / it's, students / students') is grammar, not punctuation.
    if ((type === 'CONTR' || type === 'NOUN:POSS') && f.replace(/['’]/g, '') === t.replace(/['’]/g, '')) return 'grammar';
    return 'punctuation';
  }
  if (type === 'SPELL') return 'spelling';
  if (type === 'ORTH') return 'capitalization';
  if (TYPE_KIND[type]) return TYPE_KIND[type];
  if (type && (TYPE_TITLE[type] || type === 'OTHER')) return 'grammar';
  // No usable label: one word for one similar word is most likely spelling; anything else is grammar.
  if (/^[\p{L}']+$/u.test(f) && /^[\p{L}']+$/u.test(t) && f.length >= 4 && wordDistance(f.toLowerCase(), t.toLowerCase()) <= 2) return 'spelling';
  return 'grammar';
}

function titleOf(kind, type, from, to) {
  if (kind === 'punctuation') {
    const commas = (s) => (s.match(/,/g) || []).length;
    if (commas(to) > commas(from)) return 'Missing comma';
    if (commas(to) < commas(from)) return 'Unneeded comma';
    if (/[.!?]$/.test(to.trim()) && !/[.!?]$/.test(from.trim())) return 'Missing end punctuation';
    return KIND_TITLE.punctuation;
  }
  if (kind === 'grammar' && TYPE_TITLE[type]) return TYPE_TITLE[type];
  return KIND_TITLE[kind];
}

const norm = (s) => typo(String(s || '')).replace(/\s+/g, ' ').trim().toLowerCase();

/** The model's note for an edit: the unused change whose from/to best match the edit's words. */
function noteFor(changes, used, from, to) {
  const f = norm(from);
  const t = norm(to);
  let best = -1;
  let bestScore = 0;
  changes.forEach((c, k) => {
    if (used.has(k)) return;
    const cf = norm(c.from);
    const ct = norm(c.to);
    let score = 0;
    if (cf === f) score += 2; else if (cf && (f.includes(cf) || cf.includes(f))) score += 1;
    if (ct === t) score += 2; else if (ct && (t.includes(ct) || ct.includes(t))) score += 1;
    if (score > bestScore) { bestScore = score; best = k; }
  });
  if (best < 0 || bestScore < 2) return null;
  used.add(best);
  return changes[best];
}

// ---------------------------------------------------------------- what must not be edited

/** Quotations, citations, links, email addresses and code in the text: ranges an edit may not touch. */
function protectedRanges(text) {
  const out = [];
  const add = (re, why) => { for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, why }); };
  add(/"[^"\n]{1,2000}"|“[^”\n]{1,2000}”/g, 'quotation');
  add(/\((?:[^()\n]{0,120}?\b(?:1[5-9]|20)\d{2}[a-z]?\b[^()\n]{0,60}|[^()\n]{0,40}\bet al\.[^()\n]{0,60})\)/g, 'citation');
  add(/\[\s*\d+(?:\s*[-–,;]\s*\d+)*\s*\]/g, 'citation');
  add(/\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+/gi, 'link');
  add(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, 'email');
  add(/`[^`\n]+`/g, 'code');
  return out;
}
const overlaps = (s, e, ranges) => ranges.some((r) => s < r.end && e > r.start);

// ---------------------------------------------------------------- one sentence's correction -> suggestions

/**
 * Suggestions for one unit from the model's fix. Returns { suggestions, dropped: { misaligned, protected, heading } }.
 * Offsets are into the whole text.
 */
function suggestionsFor(text, unit, fix, guard) {
  const dropped = { misaligned: 0, protected: 0, heading: 0 };
  if (!fix) return { suggestions: [], dropped };
  const a = tokens(unit.src);
  const b = tokens(fix.text);
  const { distance } = align(a.map((x) => x.t), b.map((x) => x.t));
  if (distance > Math.max(3, Math.ceil(PROOF.maxChange * a.length))) { dropped.misaligned++; return { suggestions: [], dropped }; }
  const gapIsSpace = (s, e) => /\n/.test(text.slice(unit.start + s, unit.start + e)) && !/\S/.test(text.slice(unit.start + s, unit.start + e));
  const edits = diffEdits(unit.src, fix.text, gapIsSpace);
  const used = new Set();
  const out = [];
  for (const e of edits) {
    const start = unit.start + e.start;
    const end = unit.start + e.end;
    if (overlaps(start, Math.max(end, start + 1), guard)) { dropped.protected++; continue; }
    const from = text.slice(start, end);
    if (unit.heading && e.end >= unit.src.trimEnd().length && /^[.!?]$/.test(e.to.slice(from.length)) && e.to.startsWith(from)) { dropped.heading++; continue; }
    const note = noteFor(fix.changes, used, from, e.to);
    const type = note && note.type ? note.type : '';
    const kind = kindOf(from, e.to, type);
    out.push({
      start, end, from, to: e.to, kind,
      type: type || null,
      title: titleOf(kind, type, from, e.to),
      why: (note && note.why) || KIND_WHY[kind],
      sentence: unit.i,
    });
  }
  return { suggestions: out, dropped };
}

// ---------------------------------------------------------------- the check

const cache = new Map(); // key -> { text|null, changes } for one sentence, so a re-check only sends what changed
const CACHE_MAX = 4000;
const cacheKey = (engine, model, variant, src, heading) => crypto.createHash('sha256').update(JSON.stringify([PROOF.version, engine, model, variant, heading, src])).digest('hex');
function remember(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

const LIMITS = [
  'The model can miss mistakes and can suggest changes that are not needed. Read each suggestion before you accept it.',
  'Quotations, citations, links and code are never changed. Headings are not given full stops.',
  'Only mistakes are corrected: style, tone and word choice that is merely a matter of taste are left alone.',
];

/**
 * Proofread `text`. Offsets in the result refer to `text` exactly as given (it is not normalized), so the window
 * can underline and replace the characters it holds. `emit('part', { suggestions })` sends each batch's
 * suggestions as soon as they are ready.
 */
async function runProofread({ text, config, signal, emit = () => {}, engine: preferred, selectedModel, variant = 'auto', complete = (o) => llm.complete(o), useCache = true }) {
  const startedAt = new Date().toISOString();
  if (typeof text !== 'string' || !/\p{L}/u.test(text)) throw Object.assign(new Error('Add some text to proofread.'), { status: 400 });
  if (text.length > PROOF.maxChars) throw Object.assign(new Error(`Proofread up to ${PROOF.maxChars.toLocaleString('en')} characters at a time. No text was sent.`), { status: 400 });
  if (!VARIANTS.includes(variant)) variant = 'auto';

  const settings = config.get();
  let engine;
  if (preferred) {
    const statuses = await llm.engineStatus(settings);
    const choice = statuses.find((s) => s.id === preferred);
    if (!choice || !choice.ready) throw new Error('The selected model provider is not connected. Sign in or choose a connected provider.');
    engine = preferred;
  } else engine = await llm.pickEngine(settings);
  if (!engine) throw new Error('No model is connected. Sign in to Claude or ChatGPT to proofread.');
  const requestedModel = selectedModel || settings.models[engine] || '';

  const units = unitsOf(text);
  const guard = protectedRanges(text);
  const fixes = new Map(); // unit index -> fix | null
  const toSend = [];
  for (const u of units) {
    const key = cacheKey(engine, requestedModel, variant, u.src, u.heading);
    if (useCache && cache.has(key)) { const hit = cache.get(key); remember(key, hit); fixes.set(u.i, hit); } else toSend.push(u);
  }
  const groups = batches(toSend);
  const suggestions = [];
  const dropped = { misaligned: 0, protected: 0, heading: 0, invalid: 0 };
  const batchLog = [];
  const notes = [];
  const unchecked = new Set();
  let stopReason = '';

  const collect = (list) => {
    const made = [];
    for (const u of list) {
      const r = suggestionsFor(text, u, fixes.get(u.i), guard);
      for (const k of Object.keys(r.dropped)) dropped[k] += r.dropped[k];
      made.push(...r.suggestions);
    }
    return made;
  };

  // Sentences already checked in this session (same words, model and settings) are not sent again.
  const cachedUnits = units.filter((u) => fixes.has(u.i));
  if (cachedUnits.length) {
    const made = collect(cachedUnits);
    suggestions.push(...made);
    if (made.length) emit('part', { suggestions: made });
  }

  emit('step', { id: 'model', state: 'now', detail: groups.length ? `0 of ${groups.length} part${groups.length === 1 ? '' : 's'} checked` : 'nothing new to send' });
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < groups.length && !stopReason) {
      const k = next++;
      const batch = groups[k];
      const ids = batch.map((_, x) => x + 1);
      const entry = { n: k + 1, units: batch.length, status: 'failed', error: '', problems: 0, reportedModel: null, ms: 0 };
      batchLog[k] = entry;
      const t0 = Date.now();
      try {
        const out = await complete({
          engine, role: 'main', settings, effort: PROOF.effort, model: requestedModel || undefined, strictModel: !!requestedModel,
          system: Prompts.PROOFREAD_SYSTEM,
          prompt: Prompts.proofreadPrompt(batch.map((u, x) => ({ n: x + 1, text: u.src })), variant),
          signal, onEvent: () => {},
        });
        entry.reportedModel = out && typeof out.model === 'string' ? out.model : null;
        const r = parseReply(out && out.text, ids);
        entry.status = r.status; entry.error = r.error; entry.problems = r.problems;
        dropped.invalid += r.problems;
        if (r.status === 'complete') {
          batch.forEach((u, x) => {
            const fix = r.fixes.get(x + 1) || null;
            fixes.set(u.i, fix);
            if (useCache) remember(cacheKey(engine, requestedModel, variant, u.src, u.heading), fix);
          });
          const made = collect(batch);
          suggestions.push(...made);
          emit('part', { suggestions: made });
        } else batch.forEach((u) => unchecked.add(u.i));
      } catch (e) {
        if (signal && signal.aborted) throw e;
        entry.error = e.message || 'The request failed.';
        batch.forEach((u) => unchecked.add(u.i));
        if (e.code === 'MODEL_REJECTED') stopReason = entry.error; // the same rejection would repeat: stop, do not switch models
      }
      entry.ms = Date.now() - t0;
      if (entry.status === 'failed') emit('notice', { text: `Part ${entry.n} of ${groups.length} was not checked: ${entry.error}` });
      done++;
      emit('step', { id: 'model', state: 'now', detail: `${done} of ${groups.length} part${groups.length === 1 ? '' : 's'} checked` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROOF.workers, groups.length) }, worker));
  groups.forEach((g, k) => { if (!batchLog[k]) { batchLog[k] = { n: k + 1, units: g.length, status: 'not sent', error: stopReason, problems: 0, reportedModel: null, ms: 0 }; g.forEach((u) => unchecked.add(u.i)); } });
  emit('step', { id: 'model', state: 'done', detail: unchecked.size ? `${units.length - unchecked.size} of ${units.length} sentences checked` : `${units.length} sentence${units.length === 1 ? '' : 's'} checked` });

  if (stopReason) notes.push(stopReason);
  if (unchecked.size) notes.push(`${unchecked.size} of ${units.length} sentences could not be checked. They have no suggestions; check them again or read them yourself.`);
  if (dropped.misaligned) notes.push(`${dropped.misaligned} correction${dropped.misaligned === 1 ? ' was' : 's were'} left out because the model changed too much of the sentence.`);
  if (dropped.protected) notes.push(`${dropped.protected} change${dropped.protected === 1 ? '' : 's'} inside quotations, citations, links or code ${dropped.protected === 1 ? 'was' : 'were'} left out.`);

  suggestions.sort((x, y) => x.start - y.start || x.end - y.end);
  suggestions.forEach((s, k) => { s.id = `p${k + 1}`; });
  const counts = {};
  for (const s of suggestions) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const reported = [...new Set(batchLog.map((b) => b && b.reportedModel).filter(Boolean))];
  return {
    kind: 'proofread',
    version: PROOF.version,
    length: text.length,
    hash: crypto.createHash('sha256').update(text).digest('hex'),
    variant,
    suggestions,
    counts,
    checked: { sentences: units.length, sent: toSend.length, reused: cachedUnits.length, unchecked: [...unchecked].sort((x, y) => x - y).map((i) => ({ start: units[i].start, end: units[i].end })) },
    dropped,
    notes,
    limits: LIMITS,
    provenance: {
      engine, requestedModel: requestedModel || null, reportedModels: reported,
      modelConfirmed: !!requestedModel && reported.length > 0 && reported.every((m) => m === requestedModel),
      batches: batchLog, startedAt, finishedAt: new Date().toISOString(), settings: PROOF,
    },
  };
}

/** Apply suggestions (non-overlapping) to text, last first. Used by the benchmark and the tests. */
function applySuggestions(text, list) {
  let out = text;
  let limit = Infinity;
  for (const s of [...list].sort((x, y) => y.start - x.start)) {
    if (s.end > limit) continue;
    out = out.slice(0, s.start) + s.to + out.slice(s.end);
    limit = s.start;
  }
  return out;
}

module.exports = { runProofread, applySuggestions, unitsOf, batches, parseReply, tokens, align, diffEdits, kindOf, protectedRanges, suggestionsFor, PROOF, VARIANTS, _cache: cache };
