'use strict';
// "Quote and cite the matches": the honest way to deal with text that matches a source. Every exact match is put
// in quotation marks and followed by an author-date citation; every close paraphrase gets the citation at the end of
// its sentence; the matched sources are added to the reference list. Citations are built only from the source
// records the similarity check found (database metadata or the page's own title and address), never written by a
// model. Nothing is reworded, so the writer's text and meaning are unchanged apart from the added marks.

const ETAL = (names) => (names.length > 2 ? `${names[0]} et al.` : names.length === 2 ? `${names[0]} & ${names[1]}` : names[0]);
const family = (name) => {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.includes(',')) return n.split(',')[0].trim();
  const parts = n.split(/\s+/);
  return parts[parts.length - 1];
};

/** "Nicholas Bloom" or "Bloom, Nicholas" -> "Bloom, N." (APA reference-list form). */
function apaName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  let fam, giv;
  if (n.includes(',')) [fam, giv] = [n.split(',')[0].trim(), n.split(',').slice(1).join(' ').trim()];
  else { const p = n.split(/\s+/); fam = p.pop(); giv = p.join(' '); }
  const initials = giv.split(/[\s-]+/).filter(Boolean).map((g) => `${g[0].toUpperCase()}.`).join(' ');
  return initials ? `${fam}, ${initials}` : fam;
}

/** A web page's own title without the site name tacked on ("Industrial Revolution - Wikipedia" -> "Industrial Revolution"). */
const pageTitle = (t) => String(t || '').replace(/\s+[-|\u2013\u2014:]\s+[^-|\u2013\u2014:]{2,40}$/, '').trim() || String(t || '').trim();
const siteName = (src) => { const m = String(src.title || '').match(/\s[-|\u2013\u2014]\s([^-|\u2013\u2014]{2,40})$/); return m ? m[1].trim() : (src.host || ''); };

/**
 * In-text citation and reference-list line for one similarity source, author-date (APA 7 pattern):
 * with authors "(Rahman & Aldous, 2019)"; without, the title stands in: ("Industrial Revolution", n.d.).
 */
function citationFor(src) {
  const year = src.year ? String(src.year) : 'n.d.';
  const families = (src.authors || []).map(family).filter(Boolean);
  const title = src.kind === 'web' ? pageTitle(src.title) : String(src.title || 'Untitled').trim();
  const inText = families.length ? `(${ETAL(families)}, ${year})` : `(\u201c${title}\u201d, ${year})`;
  const link = src.doi ? `https://doi.org/${src.doi}` : src.url || '';
  const end = (t) => (/[.?!]$/.test(t) ? t : `${t}.`);
  const names = (src.authors || []).map(apaName).filter(Boolean);
  const authorList = names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : names[0];
  const reference = families.length
    ? [authorList, `(${year}).`, end(title), src.venue ? `${src.venue}.` : '', link]
    : [end(title), `(${year}).`, src.kind === 'web' && siteName(src) ? `${siteName(src)}.` : (src.venue ? `${src.venue}.` : ''), link];
  return { inText, reference: reference.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() };
}

/**
 * text: the checked text; result: the similarity result for exactly that text.
 * Returns { text, quoted, cited, references, skipped } where the counts say what changed.
 */
function quoteAndCite(text, result) {
  if (!result || result.text !== text) throw Object.assign(new Error('The text has changed since it was checked. Check it again first.'), { status: 409 });
  const sources = new Map(result.sources.map((s) => [s.n, s]));
  const edits = []; // { at, insert } applied from the end
  const used = new Set();
  let quoted = 0, cited = 0;
  const skipped = [];
  const sentenceEnd = (pos) => {
    const m = /[.!?](?=["'”’)\]]*(\s|$))/g;
    m.lastIndex = pos;
    const hit = m.exec(text);
    return hit ? hit.index : text.length;
  };
  const isQuoted = (a, b) => /["“‘]\s*$/.test(text.slice(Math.max(0, a - 2), a)) && /^\s*["”’]/.test(text.slice(b, b + 2));
  const citedSentence = new Set();
  for (const sp of [...result.spans].sort((x, y) => x.start - y.start)) {
    const src = sources.get(sp.source);
    if (!src) { skipped.push({ start: sp.start, why: 'source record missing' }); continue; }
    const { inText } = citationFor(src);
    if (sp.type === 'exact') {
      let a = sp.start, b = sp.end;
      // do not swallow the sentence's final full stop into the quotation
      while (b > a && /[\s.,;:]/.test(text[b - 1])) b--;
      if (isQuoted(a, b)) { edits.push({ at: b + 1, insert: ` ${inText}` }); cited++; }
      else { edits.push({ at: a, insert: '“' }, { at: b, insert: `” ${inText}` }); quoted++; }
      used.add(src.n);
    } else {
      const end = sentenceEnd(sp.end - 1);
      const key = `${end}|${src.n}`;
      if (citedSentence.has(key)) continue;
      citedSentence.add(key);
      edits.push({ at: end, insert: ` ${inText}` });
      cited++;
      used.add(src.n);
    }
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  const refs = [...used].sort((x, y) => x - y).map((n) => citationFor(sources.get(n)).reference);
  if (refs.length) {
    const heading = out.match(/(?:^|\n)\s*(references|reference list|bibliography|works cited)\s*:?\s*\n/i);
    const lines = refs.filter((r) => !out.includes(r));
    if (lines.length) out = heading ? `${out.trimEnd()}\n${lines.join('\n')}\n` : `${out.trimEnd()}\n\nReferences\n${lines.join('\n')}\n`;
  }
  return { text: out, quoted, cited, references: refs, skipped };
}

module.exports = { quoteAndCite, citationFor };
