// Reference formatting. This one file is used by the server (tests) and by the window
// (copy / export buttons), so it avoids anything Node- or browser-specific.
// Each formatter returns { text, html } — html keeps italics when pasted into Word or Docs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LecternCite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const doiUrl = (p) => (p.doi ? `https://doi.org/${p.doi}` : (p.url || ''));
  const enDash = (pages) => String(pages || '').replace(/\s*-+\s*/g, '–');
  const firstPage = (pages) => String(pages || '').split(/[-–]/)[0].trim();

  function initials(given, sep) {
    return String(given || '').split(/[\s]+/).filter(Boolean)
      .map((part) => part.split('-').map((x) => (x[0] ? x[0].toUpperCase() + '.' : '')).join('-'))
      .join(sep == null ? ' ' : sep);
  }

  /** Build output from parts; a part is a string or { i: 'italic text' }. */
  function build(parts) {
    let text = '', html = '';
    for (const part of parts) {
      if (part == null || part === '') continue;
      if (typeof part === 'object') { text += part.i; html += `<i>${esc(part.i)}</i>`; }
      else { text += part; html += esc(part); }
    }
    return { text: text.replace(/\s+/g, ' ').trim(), html: html.replace(/\s+/g, ' ').trim() };
  }

  function joinAuthors(list, lastSep, pairSep) {
    if (list.length <= 1) return list.join('');
    if (list.length === 2) return list.join(pairSep != null ? pairSep : lastSep);
    return `${list.slice(0, -1).join(', ')}${lastSep}${list[list.length - 1]}`;
  }

  // ---- APA 7th ----
  function apa(p) {
    const a = (p.authors || []).map((x) => (x.given ? `${x.family}, ${initials(x.given)}` : x.family));
    let authors;
    if (a.length === 0) authors = '';
    else if (a.length <= 20) authors = joinAuthors(a, ', & ', ', & ');
    else authors = `${a.slice(0, 19).join(', ')}, … ${a[a.length - 1]}`;
    const year = `(${p.year || 'n.d.'}).`;
    const title = `${String(p.title || '').replace(/[.]$/, '')}.`;
    const parts = authors ? [authors, ' ', year, ' ', title] : [title, ' ', year];
    if (p.venue) {
      parts.push(' ', { i: p.venue });
      if (p.volume) { parts.push(', ', { i: p.volume }); if (p.issue) parts.push(`(${p.issue})`); }
      if (p.pages) parts.push(`, ${enDash(p.pages)}`);
      parts.push('.');
    }
    if (doiUrl(p)) parts.push(' ', doiUrl(p));
    return build(parts);
  }

  function apaInText(p) {
    const a = p.authors || [];
    const y = p.year || 'n.d.';
    if (!a.length) return `("${String(p.title || '').split(' ').slice(0, 4).join(' ')}…", ${y})`;
    if (a.length === 1) return `(${a[0].family}, ${y})`;
    if (a.length === 2) return `(${a[0].family} & ${a[1].family}, ${y})`;
    return `(${a[0].family} et al., ${y})`;
  }

  // ---- Harvard (Cite Them Right) ----
  function harvard(p) {
    const a = (p.authors || []).map((x) => (x.given ? `${x.family}, ${initials(x.given, '')}` : x.family));
    const authors = a.length > 3 ? `${a[0]} et al.` : joinAuthors(a, ' and ');
    const parts = [authors, authors ? ' ' : '', `(${p.year || 'no date'}) `, `'${String(p.title || '').replace(/[.]$/, '')}'`];
    if (p.venue) {
      parts.push(', ', { i: p.venue });
      if (p.volume) parts.push(`, ${p.volume}${p.issue ? `(${p.issue})` : ''}`);
      if (p.pages) parts.push(`, pp. ${enDash(p.pages)}`);
    }
    parts.push('.');
    if (p.doi) parts.push(` doi:${p.doi}.`);
    else if (p.url) parts.push(` Available at: ${p.url}.`);
    return build(parts);
  }

  // ---- MLA 9th ----
  function mla(p) {
    const a = p.authors || [];
    const full = (x) => (x.given ? `${x.given} ${x.family}` : x.family);
    const inverted = (x) => (x.given ? `${x.family}, ${x.given}` : x.family);
    let authors = '';
    if (a.length === 1) authors = inverted(a[0]);
    else if (a.length === 2) authors = `${inverted(a[0])}, and ${full(a[1])}`;
    else if (a.length > 2) authors = `${inverted(a[0])}, et al`;
    const parts = [authors ? `${authors.replace(/[.]$/, '')}. ` : '', `“${String(p.title || '').replace(/[.]$/, '')}.”`];
    if (p.venue) parts.push(' ', { i: p.venue });
    if (p.volume) parts.push(`, vol. ${p.volume}`);
    if (p.issue) parts.push(`, no. ${p.issue}`);
    if (p.year) parts.push(`, ${p.year}`);
    if (p.pages) parts.push(`, pp. ${enDash(p.pages)}`);
    parts.push('.');
    if (doiUrl(p)) parts.push(` ${doiUrl(p)}.`);
    return build(parts);
  }

  // ---- AGLC4 (bibliography form: first author inverted, no closing full stop) ----
  function aglc(p) {
    const a = p.authors || [];
    const full = (x) => (x.given ? `${x.given} ${x.family}` : x.family);
    const inverted = (x) => (x.given ? `${x.family}, ${x.given}` : x.family);
    let authors = '';
    if (a.length === 1) authors = inverted(a[0]);
    else if (a.length === 2 || a.length === 3) authors = joinAuthors([inverted(a[0]), ...a.slice(1).map(full)], ' and ');
    else if (a.length > 3) authors = `${inverted(a[0])} et al`;
    const parts = [authors, authors ? ', ' : '', `'${String(p.title || '').replace(/[.]$/, '')}'`];
    parts.push(` (${p.year || 'n.d.'})`);
    if (p.volume) parts.push(` ${p.volume}${p.issue ? `(${p.issue})` : ''}`);
    if (p.venue) parts.push(' ', { i: p.venue });
    if (p.pages) parts.push(` ${firstPage(p.pages)}`);
    return build(parts);
  }

  // ---- BibTeX ----
  function bibKey(p) {
    const fam = ((p.authors && p.authors[0] && p.authors[0].family) || 'anon').toLowerCase()
      .normalize('NFKD').replace(/[^a-z]/g, '');
    const word = (String(p.title || '').toLowerCase().match(/[a-z]{4,}/) || ['paper'])[0];
    return `${fam || 'anon'}${p.year || ''}${word}`;
  }
  // Characters TeX reads as commands or grouping are written so they print as themselves: a title with a brace or
  // a backslash can no longer end its field early or run a command.
  const bibEsc = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\u0000')
    .replace(/([{}&%$#_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')
    .replace(/\u0000/g, '\\textbackslash{}');
  // DOIs and web addresses are read verbatim, so they are kept whole; only braces and backslashes, which would
  // unbalance the braces around the field, are percent-encoded (the address still resolves to the same page).
  const bibUrl = (s) => String(s || '').replace(/[{}\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const BIB_TYPES = { 'Conference paper': 'inproceedings', 'Book chapter': 'incollection', Book: 'book', Thesis: 'phdthesis', Preprint: 'misc', Report: 'techreport' };

  function bibtex(p, usedKeys) {
    let key = bibKey(p);
    if (usedKeys) { let k = key, n = 97; while (usedKeys.has(k)) k = key + String.fromCharCode(n++); usedKeys.add(k); key = k; }
    const type = BIB_TYPES[p.kind] || 'article';
    const venueField = type === 'inproceedings' || type === 'incollection' ? 'booktitle' : (type === 'article' ? 'journal' : 'howpublished');
    const fields = [
      ['author', (p.authors || []).map((x) => (x.given ? `${bibEsc(x.family)}, ${bibEsc(x.given)}` : `{${bibEsc(x.family)}}`)).join(' and ')],
      ['title', p.title ? `{${bibEsc(p.title)}}` : ''],
      [venueField, bibEsc(p.venue)],
      ['year', bibEsc(p.year)],
      ['volume', bibEsc(p.volume)],
      ['number', bibEsc(p.issue)],
      ['pages', bibEsc(String(p.pages || '').replace(/\s*[-–]+\s*/g, '--'))],
      ['publisher', type !== 'article' ? bibEsc(p.publisher) : ''],
      ['doi', bibUrl(p.doi)],
      ['url', bibUrl(doiUrl(p))],
    ].filter(([, v]) => v);
    const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
    const text = `@${type}{${key},\n${body}\n}`;
    return { text, html: `<pre>${esc(text)}</pre>` };
  }

  // ---- RIS (imports into Zotero, Mendeley, EndNote) ----
  const RIS_TYPES = { 'Conference paper': 'CONF', 'Book chapter': 'CHAP', Book: 'BOOK', Thesis: 'THES', Preprint: 'GEN', Report: 'RPRT' };
  function ris(p) {
    const lines = [`TY  - ${RIS_TYPES[p.kind] || 'JOUR'}`];
    for (const x of p.authors || []) lines.push(`AU  - ${x.given ? `${x.family}, ${x.given}` : x.family}`);
    const add = (tag, v) => { if (v) lines.push(`${tag}  - ${String(v).replace(/\s+/g, ' ')}`); };
    add('TI', p.title); add('T2', p.venue); add('PY', p.year); add('VL', p.volume); add('IS', p.issue);
    const [sp, ep] = String(p.pages || '').split(/[-–]+/).map((s) => s.trim());
    add('SP', sp); add('EP', ep); add('PB', p.publisher); add('DO', p.doi); add('UR', doiUrl(p)); add('AB', p.abstract);
    lines.push('ER  - ');
    const text = lines.join('\n');
    return { text, html: `<pre>${esc(text)}</pre>` };
  }

  const STYLES = {
    apa: { label: 'APA 7', format: apa, list: true },
    harvard: { label: 'Harvard', format: harvard, list: true },
    mla: { label: 'MLA 9', format: mla, list: true },
    aglc: { label: 'AGLC4', format: aglc, list: true },
    bibtex: { label: 'BibTeX', format: bibtex, ext: 'bib' },
    ris: { label: 'RIS', format: ris, ext: 'ris' },
  };

  function format(p, style) {
    return (STYLES[style] || STYLES.apa).format(p);
  }

  /** A whole reference list. Prose styles are sorted by first author, as reference lists are. */
  function formatList(papers, style) {
    const s = STYLES[style] || STYLES.apa;
    if (style === 'bibtex') {
      const used = new Set();
      const text = papers.map((p) => bibtex(p, used).text).join('\n\n');
      return { text, html: `<pre>${esc(text)}</pre>` };
    }
    if (style === 'ris') {
      const text = papers.map((p) => ris(p).text).join('\n');
      return { text, html: `<pre>${esc(text)}</pre>` };
    }
    const sortKey = (p) => `${(p.authors && p.authors[0] && p.authors[0].family) || p.title || ''}`.toLowerCase();
    const items = [...papers].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || (a.year || 0) - (b.year || 0)).map((p) => s.format(p));
    return {
      text: items.map((x) => x.text).join('\n\n'),
      html: items.map((x) => `<p style="margin:0 0 12px 36px;text-indent:-36px">${x.html}</p>`).join(''),
    };
  }

  return { STYLES, format, formatList, apaInText, doiUrl };
});
