// Turns the model's markdown answer into safe HTML and wires up citation marks.
// Everything is escaped first; only the small set of tags built here can appear.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LecternRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  /**
   * A web address in a form for telling whether two links name the same page: http and https, "www.", a trailing
   * slash and the #fragment do not count. '' for anything that is not a web address. Same rule as urlKey() in
   * server/util.js, which picks the turn's web sources.
   */
  function urlKey(u) {
    let x;
    try { x = new URL(String(u || '').trim()); } catch (e) { return ''; }
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
    return x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search;
  }

  /** The turn's web source for a link the model wrote, or null: only pages the web search really returned. */
  function webSourceFor(url, ctx) {
    const key = urlKey(url);
    if (!key) return null;
    for (const w of ctx.webSources) if (w && /^https?:\/\//i.test(w.url || '') && urlKey(w.url) === key) return w;
    return null;
  }

  /** "[1, 3-5]" -> [1, 3, 4, 5]; "[W2]" -> ['W2']. Returns null if any part is not a valid reference. */
  function parseCiteGroup(inner, ctx) {
    const out = [];
    for (const part of inner.split(/\s*[,;]\s*/)) {
      const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part);
      if (range) {
        const a = Number(range[1]), b = Number(range[2]);
        if (a < 1 || b < a || b - a > 8 || b > ctx.paperCount) return null;
        for (let n = a; n <= b; n++) out.push(n);
      } else if (/^\d+$/.test(part)) {
        const n = Number(part);
        if (n < 1 || n > ctx.paperCount) return null;
        out.push(n);
      } else if (/^W\d+$/.test(part)) {
        const n = Number(part.slice(1));
        if (n < 1 || n > ctx.webSources.length) return null;
        out.push(part);
      } else return null;
    }
    return out.length ? out : null;
  }

  function inline(raw, ctx) {
    const stash = [];
    const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
    // \u0000 marks a stashed piece below, so the model's own text may not contain it.
    let s = esc(raw).replace(/\u0000/g, '');

    s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`));
    // Links: only to a page the turn has as a web source (one the web search returned in that run), and then
    // to that source's own address. Any other link the model wrote, such as one from memory, is its plain text.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const w = webSourceFor(unesc(url), ctx);
      return w ? keep(`<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`) : label;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

    s = s.replace(/\s*\[([^\]]{1,40})\]/g, (whole, inner) => {
      const refs = parseCiteGroup(inner.trim(), ctx);
      if (!refs) return whole;
      const marks = refs.map((r) => {
        if (typeof r === 'number') {
          ctx.cited.add(r);
          // The label ("Rahman & Aldous 2019") is built by the window from the database record, never by the model.
          const label = ctx.citeLabel ? String(ctx.citeLabel(r) || '') : '';
          const stance = ctx.citeStance ? ctx.citeStance(r) : '';
          const tone = ['supports', 'conditional', 'mixed', 'against', 'na'].includes(stance) ? ` data-stance="${stance}"` : '';
          if (label) return `<button type="button" class="cite named" data-n="${r}" aria-label="Paper ${r}: ${esc(label)}"${tone}>${esc(label)}</button>`;
          return `<button type="button" class="cite" data-n="${r}" aria-label="Paper ${r}">${r}</button>`;
        }
        const w = ctx.webSources[Number(r.slice(1)) - 1] || {};
        if (!/^https?:\/\//i.test(w.url || '')) return `<span class="cite cite-web">${r}</span>`;
        return `<a class="cite cite-web" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer" title="${esc(w.title || w.url)}" aria-label="Web page ${r.slice(1)}: ${esc(w.title || w.url)}">${r}</a>`;
      }).join('');
      return `<span class="cites">${marks}</span>`;
    });

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  }

  // ---- tables: "| a | b |" rows under a header row and a "|---|---|" line
  const isTableRow = (line) => /\|/.test(line || '') && /\S/.test(String(line).replace(/\|/g, ''));
  const isTableRule = (line) => /\|/.test(line || '') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  function tableCells(line) {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }
  function tableHtml(head, rows, ctx) {
    const cellsOf = (cells, tag) => `<tr>${head.map((_, i) => `<${tag}>${inline(cells[i] || '', ctx)}</${tag}>`).join('')}</tr>`;
    return `<div class="table-wrap"><table><thead>${cellsOf(head, 'th')}</thead><tbody>${rows.map((r) => cellsOf(r, 'td')).join('')}</tbody></table></div>`;
  }

  /**
   * The answer ends with a "Worth following up" list of questions. The window shows those as
   * buttons, so split them off: { body: the answer without that section, followUps: [plain text] }.
   * If the section is missing, or is prose instead of a list, the answer is returned whole.
   */
  function splitFollowUps(markdown) {
    const text = String(markdown || '').replace(/\r\n?/g, '\n');
    const whole = { body: text, followUps: [] };
    const m = /(^|\n)#{1,4}[ \t]+Worth following up[ \t]*#*[ \t]*(\n|$)/i.exec(text);
    if (!m) return whole;
    const items = [];
    for (const line of text.slice(m.index + m[0].length).split('\n')) {
      const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) items.push(li[1]);
      else if (!line.trim()) continue;
      else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
      else return whole;
    }
    const plain = (s) => s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/\s*\[W?\d+(?:\s*[,;–-]\s*W?\d+)*\]/g, '')
      .replace(/\*\*|`/g, '').replace(/(^|\s)\*(\S[^*]*?)\*/g, '$1$2')
      .replace(/\s+([?.!,])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 220);
    const followUps = items.map(plain).filter((q) => q.length > 8).slice(0, 5);
    if (!followUps.length) return whole;
    return { body: text.slice(0, m.index).replace(/\s+$/, ''), followUps };
  }

  /**
   * Render an answer. options: { paperCount, webSources: [{url,title}], citeLabel?: (n) => text }.
   * Returns { html, cited } where cited is the set of paper numbers the answer refers to.
   */
  function renderAnswer(markdown, options) {
    const ctx = {
      paperCount: (options && options.paperCount) || 0,
      webSources: (options && options.webSources) || [],
      citeLabel: (options && typeof options.citeLabel === 'function') ? options.citeLabel : null,
      citeStance: options && typeof options.citeStance === 'function' ? options.citeStance : null,
      cited: new Set(),
    };
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [];
    let list = null; // { type: 'ul' | 'ol', items: [] }

    const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(' '), ctx)}</p>`); para = []; } };
    const flushList = () => {
      if (list) { html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i, ctx)}</li>`).join('')}</${list.type}>`); list = null; }
    };
    const flush = () => { flushPara(); flushList(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      if (isTableRow(line) && isTableRule(lines[i + 1])) {
        flush();
        const head = tableCells(line);
        const rows = [];
        for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(tableCells(lines[i]));
        i--;
        html.push(tableHtml(head, rows, ctx));
        continue;
      }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        flush();
        const level = Math.min(4, Math.max(2, m[1].length + 1)); // answers start at h2 inside the page
        html.push(`<h${level}>${inline(m[2].replace(/\s*#+\s*$/, ''), ctx)}</h${level}>`);
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(m[1]);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(m[1]);
      } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        flush();
        html.push('<hr>');
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        flush();
        html.push(`<blockquote>${inline(m[1], ctx)}</blockquote>`);
      } else if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`; // wrapped list item
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flush();
    return { html: html.join('\n'), cited: ctx.cited };
  }

  // An opening that describes the answer ("I'll lay out both sides…") is not a brief answer.
  const META_OPENING = /^\s*(?:\*\*)?\s*(?:i['’]ll\b|i will\b|i['’]m going to\b|i am going to\b|let me\b|let['’]s\b|below\b|here(?:['’]s| is| are)\b|this answer\b|in this answer\b|the following\b)/i;

  function splitLead(markdown) {
    const text = String(markdown || '').trim();
    if (!text || /^(?:#{1,4} |[-*] |\d+[.)] |\||```)/.test(text) || META_OPENING.test(text)) return { lead: '', body: text };
    const end = text.indexOf('\n\n');
    return end === -1 ? { lead: text, body: '' } : { lead: text.slice(0, end), body: text.slice(end + 2).trim() };
  }

  return { renderAnswer, splitFollowUps, splitLead, esc };
});
