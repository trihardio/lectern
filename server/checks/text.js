'use strict';
// Shared text helpers for the two checks (AI-writing signals and similarity).
// Every function keeps character offsets into the submitted text, so the window can
// highlight exactly the words a finding is about.

const MAX_WORDS = 20000;

/** Tidy line endings and blank runs without moving words around. */
function normalizeText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** Words with offsets: [{ w, lower, start, end }]. */
function words(text) {
  const out = [];
  for (const m of String(text).matchAll(WORD_RE)) {
    out.push({ w: m[0], lower: fold(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Lower case, no accents, straight apostrophes: "Café’s" -> "cafe's". */
function fold(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");
}

/** Cut the text to MAX_WORDS words. Returns { text, trimmed }. */
function capWords(text, max = MAX_WORDS) {
  const ws = words(text);
  if (ws.length <= max) return { text, trimmed: false, totalWords: ws.length };
  return { text: text.slice(0, ws[max - 1].end), trimmed: true, totalWords: ws.length };
}

const ABBREV = new Set(['e.g', 'i.e', 'etc', 'et al', 'al', 'vs', 'cf', 'fig', 'figs', 'eq', 'eqs', 'no', 'nos', 'vol', 'pp', 'p', 'ch', 'sec',
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'approx', 'ca', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'ed', 'eds', 'trans', 'op', 'ibid', 'resp']);

/**
 * Blocks of text separated by blank lines. A short line without end punctuation (a heading such as
 * "References" or "2. Method") becomes a block of its own even with no blank line after it.
 */
function blocks(text) {
  const out = [];
  const isHeading = (line) => line.trim() && !/[.!?:;,]["'\u201d\u2019)]*\s*$/.test(line) && line.trim().split(/\s+/).length <= 12;
  let start = -1;
  let pos = 0;
  const close = (end) => { if (start !== -1) out.push({ index: start, 0: text.slice(start, end) }); start = -1; };
  for (const line of text.split('\n')) {
    const lineStart = pos;
    pos += line.length + 1;
    if (!line.trim()) { close(lineStart - 1); continue; }
    if (isHeading(line)) { close(lineStart - 1); out.push({ index: lineStart, 0: line }); continue; }
    if (start === -1) start = lineStart;
  }
  close(text.length);
  return out.map((b) => { const t = b[0].replace(/\n$/, ''); return { index: b.index, 0: t }; });
}

/**
 * Paragraphs and sentences with offsets.
 * Returns { paragraphs: [{ start, end }], sentences: [{ i, start, end, text, para }] }.
 */
function segment(text) {
  const paragraphs = [];
  const sentences = [];
  for (const pm of blocks(text)) {
    const pStart = pm.index;
    const pText = pm[0];
    if (!pText.trim()) continue;
    const para = paragraphs.length;
    paragraphs.push({ start: pStart, end: pStart + pText.length });
    // A heading or list line on its own is its own sentence; otherwise split at sentence ends.
    let s = 0;
    const endRe = /[.!?…]+["'”’)\]]*(?=\s+|$)/g;
    let m;
    while ((m = endRe.exec(pText))) {
      const cut = m.index + m[0].length;
      const before = pText.slice(s, m.index);
      const lastWord = (before.match(/([A-Za-z.]+)$/) || [, ''])[1].toLowerCase().replace(/\.$/, '');
      const next = pText.slice(cut).match(/^\s+(\S)/);
      // Do not split after abbreviations, initials ("J. Smith") or before a lower-case word.
      if (m[0] === '.' && (ABBREV.has(lastWord) || /^[a-z]$/i.test(lastWord) && /[A-Z]$/.test(before))) continue;
      if (next && /[a-z]/.test(next[1]) && m[0] === '.') continue;
      push(pStart + s, pStart + cut, para);
      s = cut;
    }
    if (s < pText.length) push(pStart + s, pStart + pText.length, para);
  }
  function push(a, b, para) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b <= a) return;
    // Lines inside one paragraph that look like list items split the sentence.
    const chunk = text.slice(a, b);
    const lines = chunk.split(/\n(?=\s*(?:[-*•]|\d+[.)])\s)/);
    let off = a;
    for (const line of lines) {
      const ls = text.indexOf(line, off);
      if (line.trim()) sentences.push({ i: sentences.length, start: ls, end: ls + line.length, text: line.replace(/\s*\n\s*/g, ' '), para });
      off = ls + line.length;
    }
  }
  return { paragraphs, sentences };
}

/**
 * Find where a quote from a model sits in the text. Exact first, then ignoring case, curly quotes and
 * runs of spaces. Returns { start, end } or null. `near` (an offset) prefers the closest match.
 */
function locate(text, quote, near = 0) {
  const q = String(quote || '').trim();
  if (q.length < 2) return null;
  const hits = [];
  let i = text.indexOf(q);
  while (i !== -1 && hits.length < 50) { hits.push({ start: i, end: i + q.length }); i = text.indexOf(q, i + 1); }
  if (!hits.length) {
    const map = [];
    let flat = '';
    for (let k = 0; k < text.length; k++) {
      let c = text[k];
      if (/\s/.test(c)) { if (flat.endsWith(' ')) continue; c = ' '; }
      c = c.replace(/[‘’]/, "'").replace(/[“”]/, '"').replace(/[–—]/, '-').toLowerCase();
      flat += c; map.push(k);
    }
    const fq = q.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').toLowerCase();
    let j = flat.indexOf(fq);
    while (j !== -1 && hits.length < 50) { hits.push({ start: map[j], end: map[j + fq.length - 1] + 1 }); j = flat.indexOf(fq, j + 1); }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => Math.abs(a.start - near) - Math.abs(b.start - near));
  return hits[0];
}

/**
 * Parts of the text a similarity check leaves out when asked: quotations in quote marks and the
 * reference list at the end. Returns [{ start, end, why }].
 */
function exclusions(text, { quotes = true, references = true } = {}) {
  const out = [];
  if (quotes) {
    for (const m of text.matchAll(/"[^"\n]{12,4000}"|“[^”\n]{12,4000}”/g)) out.push({ start: m.index, end: m.index + m[0].length, why: 'quote' });
  }
  if (references) {
    const re = /(?:^|\n)\s*(?:\d+\.?\s*)?(references|reference list|bibliography|works cited|literature cited|sources)\s*:?\s*(?=\n)/gi;
    let last = null;
    for (const m of text.matchAll(re)) last = m;
    // Only a heading in the last 60% of the text counts, so a section called "Sources of error" early on does not.
    if (last && last.index > text.length * 0.4) out.push({ start: last.index, end: text.length, why: 'references' });
  }
  return out;
}

const inRanges = (pos, ranges) => ranges.some((r) => pos >= r.start && pos < r.end);

/**
 * Cut a sentence longer than `max` characters into parts a model can read whole, at a clause
 * boundary (; : , dash) or else a space, never inside a word. Every part keeps exact offsets into
 * `text`, so nothing a model did not see is ever rated. Returns [{ start, end, text, part }].
 */
function splitLong(text, sentence, max = 900) {
  if (sentence.end - sentence.start <= max) return [{ start: sentence.start, end: sentence.end, text: sentence.text, part: false }];
  const out = [];
  let pos = sentence.start;
  while (sentence.end - pos > max) {
    const window = text.slice(pos, pos + max);
    let cut = -1;
    for (const m of window.matchAll(/[;:,\u2014\u2013](?=\s)/g)) if (m.index > max * 0.4) cut = m.index + 1;
    if (cut === -1) { const sp = window.lastIndexOf(' '); cut = sp > max * 0.3 ? sp : max; }
    let end = pos + cut;
    while (end > pos && /\s/.test(text[end - 1])) end--;
    out.push({ start: pos, end, part: true });
    pos += cut;
    while (pos < sentence.end && /\s/.test(text[pos])) pos++;
  }
  if (pos < sentence.end) out.push({ start: pos, end: sentence.end, part: true });
  return out.map((p) => ({ ...p, text: text.slice(p.start, p.end).replace(/\s*\n\s*/g, ' ') }));
}

/**
 * Find a model's quote inside one range only (the sentence the model said it came from). Returns
 * { start, end } when it occurs exactly once there, else null: a quote that is missing, or that occurs
 * twice so the place is ambiguous, is not anchored anywhere.
 */
function locateWithin(text, quote, start, end) {
  const slice = text.slice(start, end);
  const first = locate(slice, quote, 0);
  if (!first) return null;
  const again = locate(slice.slice(first.end), quote, 0);
  if (again) return null;
  return { start: start + first.start, end: start + first.end };
}

module.exports = { MAX_WORDS, blocks, normalizeText, words, fold, capWords, segment, locate, locateWithin, splitLong, exclusions, inRanges };
