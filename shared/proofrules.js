// Instant proofreading rules: mistakes that can be found without a model, while the writer types.
// Used by the window (underlines as you type, no plan usage) and by the tests and benchmark (bench/grammar).
// Every rule is built for precision: it only fires on patterns that are almost never correct, and each has its
// exceptions written out ("had had", "that that", "an hour", "an MBA", "should of course", "part a", ...).
// Quotations, citations, links, email addresses and code are never touched.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./misspellings'));
  else root.LecternProofRules = factory(root.LecternMisspellings);
})(typeof self !== 'undefined' ? self : this, function (Misspellings) {
  'use strict';

  const VERSION = 1;
  const L = '\\p{L}';

  // ---- what must not be edited (the same ranges as server/checks/proofread.js)
  function protectedRanges(text) {
    const out = [];
    const add = (re) => { for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]); };
    add(/"[^"\n]{1,2000}"|“[^”\n]{1,2000}”/g);
    add(/\((?:[^()\n]{0,120}?\b(?:1[5-9]|20)\d{2}[a-z]?\b[^()\n]{0,60}|[^()\n]{0,40}\bet al\.[^()\n]{0,60})\)/g);
    add(/\[\s*\d+(?:\s*[-–,;]\s*\d+)*\s*\]/g);
    add(/\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+/gi);
    add(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g);
    add(/`[^`\n]+`/g);
    // file names and dotted identifiers (app.js, Node.js, e.g. version numbers)
    add(/\b[\w-]+\.(?:js|ts|py|md|txt|pdf|docx?|html?|css|json|csv|png|jpe?g|svg|zip|exe|app|dmg)\b/gi);
    return out;
  }
  const touches = (s, e, ranges) => ranges.some(([a, b]) => s < b && e > a);

  // ---- word lists
  const REPEAT_OK = new Set(['had', 'that', 'is', 'can', 'do', 'bye', 'ha', 'haha', 'no', 'so', 'very', 'really', 'tsk', 'chop', 'knock',
    'yada', 'tut', 'boo', 'hush', 'night', 'pom', 'ba', 'ga', 'na', 'la', 'yo', 'go', 'well', 'now', 'there', 'oh', 'yes', 'blah', 'hip',
    'aye', 'mm', 'hmm', 'meow', 'woof', 'bang', 'tick', 'tock', 'ding', 'dong', 'choo', 'cha', 'ta', 'tom', 'mahi', 'bora', 'baden']);
  // "a" + these is a different mistake (or "a" is a label such as "part a"): never suggest "an".
  const NOT_AFTER_A = new Set(['and', 'or', 'is', 'are', 'was', 'were', 'if', 'in', 'into', 'of', 'on', 'onto', 'at', 'as', 'also', 'it', 'its',
    'either', 'each', 'else', 'even', 'ever', 'every', 'other', 'otherwise', 'after', 'about', 'above', 'across', 'against', 'among', 'around',
    'only', 'over', 'once', 'one', 'ones', 'oneself', 'onesie', 'equals', 'etc', 'ie', 'eg', 'e', 'i', 'o']);
  const A_LABEL = /\b(?:part|parts|option|options|type|types|grade|grades|vitamin|hepatitis|plan|group|groups|item|items|point|points|variable|variables|case|cases|model|models|class|classes|list|lists|column|columns|row|rows|set|sets|section|sections|appendix|figure|table|panel|panels|step|steps|level|exhibit|schedule|category|categories|condition|conditions|version|versions|form|forms|block|blocks|matrix|vector|vertex|node|nodes|series|letter|letters|size|sizes|track|tracks|side|sides|note|notes|parameter|parameters|constant|constants|coefficient|coefficients|player|team|phase|stage|zone|wing|floor|gate|room|building|block|unit|units)\s+$/i;
  const VOWEL_SOUND_CONSONANT = /^(?:eu|ewe|uni|use|usu|uti|ura|uro|uk|ouija|one\b|once\b)/i; // a European, a one-off
  const AN_OK = /^(?:h|x|nth\b|rpm\b|sms\b|mri\b|mba\b|ngo\b|nfl\b|nba\b|lcd\b|led\b|faq\b|fbi\b|rsvp\b|hr\b|html\b|http\b|sql\b|suv\b|xml\b)/i;
  // "could of" -> "could have". Not "may"/"will" ("the will of the people", "May of 2020"), not "of course".
  const MODALS = /\b(could|should|would|must|might)(\s+)of\b(?!\s+(?:course|necessity|which|whom|those|these))/gi;
  const NOUN_BEFORE = /\b(?:the|a|an|its|their|his|her|our|your|my|this|that|all|sheer|full|whole|economic|military|naval|industrial|great)\s+$/i; // "the might of"
  const PRONOUN_I_NEXT = new Set(['am', 'was', 'have', 'had', 'think', 'thought', 'will', 'would', 'can', 'could', 'do', 'did', "don't", "didn't",
    'know', 'knew', 'want', 'wanted', 'need', 'needed', 'feel', 'felt', 'believe', 'hope', 'love', 'like', 'see', 'saw', 'said', 'say', 'went',
    'go', 'got', 'get', 'should', 'must', 'might', 'really', 'also', 'just', 'never', 'always', 'guess', 'mean', 'agree', 'disagree', 'wish',
    'tried', 'try', 'found', 'remember', 'forgot', 'decided', 'learned', 'learnt', 'started', 'finished', "can't", "couldn't", "wasn't", "won't",
    "wouldn't", "haven't", "hadn't", 'personally', 'still', 'only', 'recently']);
  const ABBREV = new Set(['e.g', 'i.e', 'etc', 'et al', 'al', 'vs', 'cf', 'fig', 'figs', 'eq', 'eqs', 'no', 'nos', 'vol', 'vols', 'pp', 'p', 'ch',
    'sec', 'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'approx', 'ca', 'c', 'jan', 'feb', 'mar',
    'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'ed', 'eds', 'trans', 'op', 'ibid', 'resp', 'a.m', 'p.m',
    'est', 'min', 'max', 'avg', 'dept', 'gov', 'govt', 'assn', 'bros', 'ave', 'blvd', 'rd', 'mt', 'ft', 'oz', 'lb', 'lbs', 'kg', 'km', 'cm',
    'mm', 'hrs', 'hr', 'yr', 'yrs', 'wk', 'mo', 'misc', 'viz', 'n.b', 'ps', 'p.s', 'esp', 'incl', 'excl', 'abbr', 'cont', 'orig', 'repr', 'rev']);

  // ---- the misspelling list: "misspelling->correction" lines (single corrections only)
  let MISSPELT = null;
  function misspelt() {
    if (MISSPELT) return MISSPELT;
    MISSPELT = new Map();
    const src = Misspellings && Misspellings.LIST ? Misspellings.LIST : '';
    for (const line of src.split('\n')) {
      const k = line.indexOf('->');
      if (k > 0) MISSPELT.set(line.slice(0, k), line.slice(k + 2));
    }
    return MISSPELT;
  }
  const caseLike = (model, word) => (/^\p{Lu}/u.test(model) ? word.charAt(0).toUpperCase() + word.slice(1) : word);

  /**
   * Check `text`. Returns suggestions [{ start, end, from, to, kind, title, why, rule }] sorted by position, with
   * offsets into `text` exactly as given. Overlapping findings keep the first.
   */
  function check(text) {
    text = String(text || '');
    const guard = protectedRanges(text);
    const found = [];
    const add = (start, end, to, kind, title, why, rule) => {
      if (end <= start || touches(start, end, guard)) return;
      const from = text.slice(start, end);
      if (from === to) return;
      found.push({ start, end, from, to, kind, title, why, rule });
    };
    let m;

    // Repeated word on one line: "the the". Not "had had", "that that", or a repeated name ("Bora Bora").
    const rep = new RegExp(`(?<![${L}\\p{N}'’-])([${L}]+)([ \\t]+)\\1(?![${L}\\p{N}'’-])`, 'giu');
    while ((m = rep.exec(text))) {
      const w = m[1].toLowerCase();
      const second = m.index + m[1].length + m[2].length;
      if (REPEAT_OK.has(w)) continue;
      if (/^\p{Lu}/u.test(m[1]) && /^\p{Lu}/u.test(text.slice(second))) continue; // a name such as "Bora Bora"
      add(m.index + m[1].length, second + m[1].length, '', 'grammar', 'Repeated word', `“${m[1]}” appears twice in a row.`, 'repeat');
    }

    // a / an
    const art = new RegExp(`(?<![${L}\\p{N}'’.-])(a|an|A|An)([ \\t]+)([${L}][${L}'’-]*)`, 'gu');
    while ((m = art.exec(text))) {
      const a = m[1];
      const word = m[3];
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (/[(\[]\s*$/.test(before) || /[\p{N}]/u.test(word) || word.length < 2 || /^[\p{L}]-/u.test(word)) continue;
      if (/\p{Lu}/u.test(word.slice(1))) continue; // acronyms and names with inner capitals: MBA, mRNA, iPhone
      const lower = word.toLowerCase();
      if (/^a$/i.test(a)) {
        if (!/^[aeio]/i.test(word) || VOWEL_SOUND_CONSONANT.test(word) || NOT_AFTER_A.has(lower) || A_LABEL.test(before)) continue;
        if (a === 'a' && /\p{Lu}/u.test(word[0]) && before.trim() && !/[.!?]\s*$/.test(before)) continue; // "a Ontario law": names vary
        add(m.index, m.index + a.length, a === 'A' ? 'An' : 'an', 'grammar', 'Article', `Use “an” before a vowel sound: “an ${word}”.`, 'a-an');
      } else {
        if (!/^[bcdfgjklmnpqrstvwyz]/i.test(word) || AN_OK.test(word) || /\p{Lu}/u.test(word[0])) continue;
        add(m.index, m.index + a.length, a === 'An' ? 'A' : 'a', 'grammar', 'Article', `Use “a” before a consonant sound: “a ${word}”.`, 'a-an');
      }
    }

    // could of -> could have
    MODALS.lastIndex = 0;
    while ((m = MODALS.exec(text))) {
      if (/^(?:might|must)$/i.test(m[1]) && NOUN_BEFORE.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
      const start = m.index + m[1].length + m[2].length;
      add(start, start + 2, 'have', 'grammar', 'Verb form', `After “${m[1]}”, write “have”, not “of”.`, 'modal-of');
    }

    // spacing: two or more spaces between words on one line
    const sp = /(\S)( {2,})(?=\S)/g;
    while ((m = sp.exec(text))) add(m.index + 1, m.index + 1 + m[2].length, ' ', 'spacing', 'Extra space', 'More than one space between words.', 'space-double');
    // a space before , . ; : ? !
    const spb = new RegExp(`([${L}\\p{N})\\]])( +)([,.;:?!])(?=[\\s"”’]|$)`, 'gu');
    while ((m = spb.exec(text))) {
      if (m[3] === '.' && text[m.index + m[0].length] === '.') continue;
      add(m.index + 1, m.index + 1 + m[2].length, '', 'spacing', 'Space before punctuation', `No space goes before “${m[3]}”.`, 'space-before');
    }
    // a missing space after a comma between two words, or after a full stop before a capital
    const spa = /(\p{Ll}{2,}),(\p{Ll}{2,})/gu;
    while ((m = spa.exec(text))) {
      const comma = m.index + m[1].length;
      add(comma, comma + 1, ', ', 'spacing', 'Missing space', 'A comma is followed by a space.', 'space-after');
    }
    const spp = /(\p{Ll}{2,})\.(\p{Lu}\p{Ll}+)/gu;
    while ((m = spp.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/[\w/.@-]$/.test(before) && /(?:www|https?|[/@])/.test(before)) continue;
      const dot = m.index + m[1].length;
      add(dot, dot + 1, '. ', 'spacing', 'Missing space', 'A new sentence starts after a space.', 'space-after');
    }

    // doubled punctuation: ",," and ";;" (two full stops are often a home-made ellipsis, so they are left alone)
    const dp = /,,+|;;+/g;
    while ((m = dp.exec(text))) add(m.index, m.index + m[0].length, m[0][0], 'punctuation', 'Doubled punctuation', 'The mark is typed twice.', 'double-punct');

    // a sentence that starts with a small letter
    const cap = /([.!?])(["'”’)\]]*)(\s+)(\p{Ll}[\p{L}'’-]*)/gu;
    while ((m = cap.exec(text))) {
      if (m[2] && /[!?]/.test(m[1])) continue; // "Really?" she asked.
      const before = text.slice(Math.max(0, m.index - 15), m.index + 1);
      const word = m[4];
      if (/\.\.\.$|…$/.test(before) || /\.\s*\.$/.test(before)) continue;
      const last = (before.slice(0, -1).match(/([\p{L}.]+)$/u) || [, ''])[1].toLowerCase().replace(/\.$/, '');
      if (m[1] === '.' && (ABBREV.has(last) || /^\p{L}$/u.test(last) || /\./.test(last))) continue;
      if (/[\p{N}_]/u.test(word) || /\p{Lu}/u.test(word.slice(1))) continue; // iPhone, eBay, x2
      if (/\n\s*$/.test(m[3]) || /\n/.test(m[3])) continue; // a new line: a list or heading, judged by the model
      const start = m.index + m[1].length + m[2].length + m[3].length;
      if (text[start + word.length] === '.' && word.length <= 3) continue; // "i.e.", "e.g.", "etc."
      add(start, start + 1, word[0].toUpperCase(), 'capitalization', 'Capital letter', 'A sentence starts with a capital letter.', 'cap-start');
    }

    // "i" as a pronoun
    const pi = /(?<![\p{L}\p{N}'’.-])i(?=(?:['’](?:m|ve|ll|d)\b)|\s+([\p{L}'’]+))/gu;
    while ((m = pi.exec(text))) {
      const next = text.slice(m.index + 1);
      const contraction = /^['’](?:m|ve|ll|d)\b/i.test(next);
      const verb = (next.match(/^\s+([\p{L}'’]+)/u) || [, ''])[1].toLowerCase().replace(/’/g, "'");
      if (!contraction && !PRONOUN_I_NEXT.has(verb)) continue;
      add(m.index, m.index + 1, 'I', 'capitalization', 'Capital I', 'The pronoun “I” is always a capital letter.', 'cap-i');
    }

    // common misspellings (Wikipedia's list; see shared/misspellings.js)
    const list = misspelt();
    if (list.size) {
      const wr = new RegExp(`(?<![${L}\\p{N}'’_-])([${L}][${L}'’]*)(?![${L}\\p{N}'’_-])`, 'gu');
      while ((m = wr.exec(text))) {
        const w = m[1];
        if (w.length < 3 || (w === w.toUpperCase() && w.length > 1)) continue;
        // A capitalised word in mid-sentence is most likely a name ("Kit Holliday"): leave it to the writer.
        if (/^\p{Lu}/u.test(w) && !/(?:^|[.!?]["'”’)\]]*\s+|\n\s*)$/.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
        const key = /^\p{Lu}\p{Ll}/u.test(w) ? w.toLowerCase() : w;
        const fix = list.get(w) || list.get(key);
        if (!fix) continue;
        add(m.index, m.index + w.length, list.has(w) ? fix : caseLike(w, fix), 'spelling', 'Spelling', `A common misspelling of “${list.has(w) ? fix : caseLike(w, fix)}”.`, 'misspelling');
      }
    }

    found.sort((x, y) => x.start - y.start || x.end - y.end);
    const out = [];
    let edge = -1;
    for (const f of found) { if (f.start >= edge) { out.push(f); edge = f.end; } }
    return out;
  }

  return { VERSION, check, protectedRanges };
});
