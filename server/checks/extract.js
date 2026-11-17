'use strict';
// Plain text from a document the user drops on the Writing desk page. Node built-ins only:
// .docx / .odt are zip files of XML (read with zlib), PDFs are parsed here (text layer only,
// no scanned images), web pages and plain text are stripped of markup.

const zlib = require('zlib');

const MAX_BYTES = 12 * 1024 * 1024;
// Unpacked data allowed from one document, all parts together. A real thesis is a few megabytes of XML or
// content streams; a "bomb" (a small file that unpacks to gigabytes) stops here instead of filling the memory.
const ZIP_BUDGET = 64 * 1024 * 1024;
const PDF_BUDGET = 128 * 1024 * 1024;
const PDF_STREAM_MAX = 48 * 1024 * 1024;
const TYPES = 'Use a PDF, Word (.docx), OpenDocument (.odt), rich text (.rtf), web page (.html), Markdown (.md) or plain text (.txt) file, or paste the text.';

class ExtractError extends Error { constructor(msg) { super(msg); this.status = 422; } }

/** { name, data: Buffer } -> { text, kind } */
function extractText({ name = '', data }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new ExtractError('The file is empty.');
  if (data.length > MAX_BYTES) throw new ExtractError('The file is larger than 12 MB. Paste the text instead.');
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];
  const head = data.subarray(0, 8).toString('latin1');
  let text;
  let kind;
  if (head.startsWith('%PDF')) { text = pdfText(data); kind = 'PDF'; }
  else if (head.startsWith('PK\u0003\u0004')) {
    const { names, files } = unzip(data);
    if (files['word/document.xml']) { text = docxText(files['word/document.xml'].toString('utf8')); kind = 'Word document'; }
    else if (files['content.xml']) { text = odtText(files['content.xml'].toString('utf8')); kind = 'OpenDocument text'; }
    else if (names.has('word/document.xml') || names.has('content.xml')) throw new ExtractError('The text of this document could not be unpacked; the file looks damaged. Save it again from your word processor, or paste the text.');
    else if (names.has('ppt/presentation.xml')) throw new ExtractError(`Slides (.pptx) are not supported. ${TYPES}`);
    else throw new ExtractError(`This zip file is not a Word (.docx) or OpenDocument (.odt) document. ${TYPES}`);
  } else if (head.startsWith('{\\rtf')) { text = rtfText(data.toString('latin1')); kind = 'Rich text'; }
  else if (data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new ExtractError('Old Word files (.doc) are not supported. Save it as .docx or PDF, or paste the text.');
  } else {
    const s = decodeText(data);
    if (/[\u0000-\u0008\u000e-\u001f]/.test(s.slice(0, 4000))) throw new ExtractError(`This file type is not supported. ${TYPES}`);
    if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype html|html)/i.test(s)) { text = htmlText(s); kind = 'Web page'; }
    else { text = s; kind = ext === 'md' ? 'Markdown' : 'Text'; }
  }
  text = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s/g, '').length < 20) {
    throw new ExtractError(kind === 'PDF'
      ? 'No text was found in this PDF. It may be a scanned image; run it through text recognition first or paste the text.'
      : 'No text was found in this file.');
  }
  return { text, kind };
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  const s = buf.toString('utf8').replace(/^﻿/, '');
  // Not valid UTF-8 (replacement characters everywhere): read it as Windows-1252 instead.
  return (s.match(/�/g) || []).length > 5 ? buf.toString('latin1') : s;
}

// ------------------------------------------------------------------ zip (.docx, .odt)

/**
 * Read a zip archive (.docx, .odt): { names: every part's name, files: { name: Buffer } for the `wanted` parts only }.
 * Only "stored" and "deflate" parts are supported. Only the wanted parts are unpacked, each once, within one total
 * budget, so neither a part that unpacks to gigabytes nor many directory entries pointing at one compressed body
 * can fill the memory.
 */
function unzip(buf, wanted = ['word/document.xml', 'content.xml']) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new ExtractError('This file could not be opened: it looks damaged or incomplete. Save it again from your word processor, or paste the text.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = new Set();
  const files = {};
  let left = ZIP_BUDGET;
  const tooBig = () => new ExtractError('This document unpacks to more text than Lectern can read at once (over 64 MB). Split it into smaller files, or paste the text.');
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    names.add(name);
    if (!wanted.includes(name) || files[name]) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) {
      if (raw.length > left) throw tooBig();
      files[name] = raw;
    } else if (method === 8) {
      try { files[name] = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, left) }); } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
        continue; // a damaged part is reported by the caller
      }
    } else continue;
    left -= files[name].length;
  }
  return { names, files };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', deg: '°', middot: '·', bull: '•', eacute: 'é', egrave: 'è', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', times: '×', minus: '−', shy: '' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,9}|[a-z]{1,32});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

/**
 * Paragraph text of word/document.xml, read in one pass over its tags (a missing closing tag cannot make it slow).
 * Deleted tracked changes and field codes are not part of the text.
 */
function docxText(xml) {
  const out = [];
  const outer = []; // a paragraph inside a paragraph (a text box) is read on its own
  let line = null;  // the paragraph being read; null between paragraphs
  let inText = false;
  let skip = 0;     // depth inside <w:del> and <w:instrText>
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^<>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) { if (inText && !skip && line !== null) line += decodeEntities(m[4]); continue; }
    const close = !!m[1];
    const name = m[2];
    const self = !!m[3];
    if (name === 'w:p') {
      if (self) out.push('');
      else if (!close) { if (line !== null) outer.push(line); line = ''; }
      else if (line !== null) { out.push(line); line = outer.length ? outer.pop() : null; }
    } else if (name === 'w:t') inText = !close && !self;
    else if (name === 'w:del' || name === 'w:instrText') { if (!self) skip = close ? Math.max(0, skip - 1) : skip + 1; }
    else if (!skip && line !== null && self) {
      if (name === 'w:tab' && /^<w:tab\s*\/>$/.test(m[0])) line += '\t'; // a tab; <w:tab w:pos=…/> is a tab stop setting
      else if (name === 'w:br' || name === 'w:cr') line += '\n';
    }
  }
  if (line !== null) out.push(line);
  return out.join('\n\n');
}

function odtText(xml) {
  return decodeEntities(xml
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, c) => ' '.repeat(Math.min(+c || 1, 200)))
    .replace(/<\/text:(p|h)>/g, '\n\n')
    .replace(/<[^<>]+>/g, ''));
}

// Groups whose words are settings, not text (fonts, colours, styles, document details, pictures, headers).
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'expandedcolortbl', 'fldinst']);
const RTF_CHARS = { par: '\n', line: '\n', sect: '\n\n', page: '\n\n', row: '\n', cell: '\t', tab: '\t', emdash: '—', endash: '–',
  lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ', qmspace: ' ' };

/**
 * Plain text of an RTF file, read character by character. Font, colour and style tables and other settings
 * groups are skipped, \'hh bytes are read in the file's code page, and after a \uN character the N fallback
 * characters that follow it (\ucN, 1 by default) are skipped.
 */
function rtfText(s) {
  let page = 1252;
  const cp = /\\ansicpg(\d{3,5})/.exec(s.slice(0, 2000));
  if (cp) page = Number(cp[1]);
  let decoder = null;
  if (page !== 1252) { try { decoder = new TextDecoder(`windows-${page}`); } catch { decoder = null; } }
  const byte = (b) => (decoder ? decoder.decode(Uint8Array.of(b)) : (b >= 0x80 && b <= 0x9f ? WIN[b] || '' : String.fromCharCode(b)));
  let out = '';
  const stack = [];
  let skip = false;
  let uc = 1;        // fallback characters after each \uN
  let fallback = 0;  // fallback characters still to skip
  const emit = (t) => { if (fallback > 0) { fallback--; return; } if (!skip) out += t; };
  const word = /\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '{') { stack.push([skip, uc]); fallback = 0; i++; continue; }
    if (c === '}') { const top = stack.pop(); if (top) [skip, uc] = top; fallback = 0; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; } // line breaks in the file are not text
    if (c !== '\\') { emit(c); i++; continue; }
    const n = s[i + 1];
    if (n === '\\' || n === '{' || n === '}') { emit(n); i += 2; continue; }
    if (n === "'") { const h = s.substr(i + 2, 2); if (/^[0-9a-fA-F]{2}$/.test(h)) emit(byte(parseInt(h, 16))); i += 4; continue; }
    if (n === '*') { skip = true; i += 2; continue; } // an optional destination this reader does not know
    if (n === '~') { emit(' '); i += 2; continue; }
    if (n === '_') { emit('-'); i += 2; continue; }
    if (n === '-') { i += 2; continue; } // optional hyphen
    if (n === '\n' || n === '\r') { emit('\n'); i += 2; continue; } // "\" + line break = \par
    word.lastIndex = i;
    const m = word.exec(s);
    if (!m) { i += 2; continue; }
    i = word.lastIndex;
    const w = m[1];
    const arg = m[2] === undefined ? null : Number(m[2]);
    if (RTF_SKIP.has(w)) skip = true;
    else if (w === 'u' && arg !== null) { emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); fallback = uc; }
    else if (w === 'uc' && arg !== null) uc = Math.max(0, Math.min(arg, 10));
    else if (Object.prototype.hasOwnProperty.call(RTF_CHARS, w)) emit(RTF_CHARS[w]);
  }
  return out;
}

const DROPPED = 'script|style|noscript|svg|template|iframe|nav|header|footer|form|button|select';

/**
 * Find <name …>…</name> elements of the given names, first to last, in one pass. An element without a closing tag is
 * left alone (once a closing tag is known to be missing it is not looked for again), so unclosed tags cannot make this
 * slow. Calls visit(start, end) for each element found; visit returns false to stop.
 */
function eachElement(s, names, visit) {
  const open = new RegExp(`<(${names})\\b`, 'gi');
  const closers = new Map();
  let m;
  while ((m = open.exec(s))) {
    const name = m[1].toLowerCase();
    let close = closers.get(name);
    if (close === null) continue;
    if (!close) { close = new RegExp(`</${name}\\s*>`, 'gi'); closers.set(name, close); }
    close.lastIndex = open.lastIndex;
    const end = close.exec(s);
    if (!end) { closers.set(name, null); continue; }
    if (visit(m.index, close.lastIndex) === false) return;
    open.lastIndex = close.lastIndex;
  }
}

function dropElements(s, names, once = false) {
  let out = '';
  let at = 0;
  eachElement(s, names, (start, end) => { out += `${s.slice(at, start)} `; at = end; return !once; });
  return out + s.slice(at);
}

/** Comments out; an unclosed comment hides the rest of the page, as it does in a browser. */
function dropComments(s) {
  let out = '';
  let at = 0;
  for (;;) {
    const i = s.indexOf('<!--', at);
    if (i === -1) return out + s.slice(at);
    out += `${s.slice(at, i)} `;
    const j = s.indexOf('-->', i + 4);
    if (j === -1) return out;
    at = j + 3;
  }
}

/** Readable text of a web page: no scripts, styles, menus or footers. Every step is linear in the page's length. */
function htmlText(html) {
  let s = dropElements(dropElements(dropComments(String(html)), 'head', true), DROPPED);
  let main = null;
  eachElement(s, 'article|main', (start, end) => { main = s.slice(start, end); return false; });
  if (main && main.length > 1500) s = main;
  s = s.replace(/<(br|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|figcaption|dd|dt)>/gi, '\n\n')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<[^<>]+>/g, ' ');
  return decodeEntities(s).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ PDF

/**
 * Text layer of a PDF. Handles compressed objects and object streams, page trees with inherited
 * resources, ToUnicode maps, standard encodings with /Differences, form XObjects and TJ spacing.
 * Encrypted PDFs and scanned images are reported, not guessed at.
 */
function pdfText(buf) {
  const raw = buf.toString('latin1');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(raw.slice(-4096)) || /trailer[\s\S]{0,400}\/Encrypt\b/.test(raw)) {
    throw new ExtractError('This PDF is password-protected or encrypted. Save an unprotected copy, or paste the text.');
  }
  const budget = { left: PDF_BUDGET }; // unpacked bytes still allowed for this file
  const objs = pdfObjects(buf, raw, budget);
  const doc = new PdfDoc(objs, budget);
  const pages = doc.pages();
  if (!pages.length) throw new ExtractError('No pages were found in this PDF.');
  const out = [];
  for (const page of pages.slice(0, 400)) {
    try { out.push(doc.pageText(page)); } catch (e) {
      if (e instanceof ExtractError) throw e; // too large: say so rather than return part of the text
      out.push('');
    }
  }
  return tidyPdf(out.join('\n\n'));
}

/**
 * indexOf for searches that move forward through one string: it remembers where the next match is, so many
 * searches (one per PDF object) stay linear even when the word is far away or missing.
 */
function forwardFinder(s, word) {
  let from0 = Infinity;
  let at = -1;
  return (from) => {
    if (from >= from0 && (at === -1 || at >= from)) return at;
    from0 = from;
    at = s.indexOf(word, from);
    return at;
  };
}

function tidyPdf(s) {
  return s
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')        // words hyphenated at a line end
    .replace(/[ﬀ-ﬆ]/g, (c) => ({ 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' }[c]))
    // TeX draws an accent as its own glyph before the letter ("Gonz\u00b4alez"): join them ("Gonz\u00e1lez").
    .replace(/([\u00b4\u00a8\u02dd\u02c6\u02dc\u02c7\u02d8\u02da\u00b8`])\s?(\p{L})/gu, (m, a, l) => (l + { '\u00b4': '\u0301', '\u00a8': '\u0308', '\u02dd': '\u030b', '\u02c6': '\u0302', '\u02dc': '\u0303', '\u02c7': '\u030c', '\u02d8': '\u0306', '\u02da': '\u030a', '\u00b8': '\u0327', '`': '\u0300' }[a]).normalize('NFC'))
    .replace(/([^\n])\n(?!\n)/g, '$1 ')          // a line break inside a paragraph is a space
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n /g, '\n');
}

/** All objects: number -> { dict: string, stream: Buffer|null }. Later definitions win (incremental saves). */
function pdfObjects(buf, raw, budget) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const nextStream = forwardFinder(raw, 'stream');
  const nextEndobj = forwardFinder(raw, 'endobj');
  const nextEndstream = forwardFinder(raw, 'endstream');
  let m;
  while ((m = re.exec(raw))) {
    const num = +m[1];
    const start = m.index + m[0].length;
    const streamAt = nextStream(start);
    const endObj = nextEndobj(start);
    if (endObj === -1) break;
    let dict = raw.slice(start, endObj);
    let stream = null;
    if (streamAt !== -1 && streamAt < endObj && raw[streamAt - 1] !== 'd') { // not "endstream"
      dict = raw.slice(start, streamAt);
      let dataStart = streamAt + 6;
      if (raw[dataStart] === '\r') dataStart++;
      if (raw[dataStart] === '\n') dataStart++;
      const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let dataEnd = lenM ? dataStart + +lenM[1] : -1;
      if (dataEnd === -1 || raw.slice(dataEnd, dataEnd + 20).indexOf('endstream') === -1) {
        dataEnd = nextEndstream(dataStart);
        if (dataEnd === -1) dataEnd = endObj;
      }
      stream = buf.subarray(dataStart, dataEnd);
      const after = nextEndobj(dataEnd);
      re.lastIndex = after === -1 ? dataEnd : after;
    } else {
      re.lastIndex = endObj;
    }
    objs.set(num, { dict, stream });
  }
  // Objects packed inside object streams.
  for (const [, o] of [...objs]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decodeStream(o, budget);
    if (!data) continue;
    const s = data.toString('latin1');
    const first = +(o.dict.match(/\/First\s+(\d+)/) || [])[1] || 0;
    const nums = s.slice(0, first).trim().split(/\s+/).map(Number);
    const n = Math.min(+(o.dict.match(/\/N\s+(\d+)/) || [])[1] || 0, Math.floor(nums.length / 2));
    for (let k = 0; k < n; k++) {
      const num = nums[2 * k];
      const off = first + nums[2 * k + 1];
      const end = k + 1 < n ? first + nums[2 * k + 3] : s.length;
      if (!objs.has(num) || !objs.get(num).fromStream) objs.set(num, { dict: s.slice(off, end), stream: null, fromStream: true });
    }
  }
  return objs;
}

/**
 * A stream's data with its filters undone. Unpacking draws on the file's budget (and at most PDF_STREAM_MAX per
 * stream), so a small PDF that unpacks to gigabytes is refused instead of filling the memory.
 */
function decodeStream(o, budget = { left: PDF_BUDGET }) {
  if (!o.stream) return null;
  const filter = (o.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [, ''])[1];
  const filters = filter.match(/\/\w+/g) || [];
  let data = o.stream;
  for (const f of filters) {
    if (f === '/FlateDecode' || f === '/Fl') {
      const limit = { maxOutputLength: Math.max(1, Math.min(PDF_STREAM_MAX, budget.left)) };
      const tooBig = (e) => e && e.code === 'ERR_BUFFER_TOO_LARGE';
      try { data = zlib.inflateSync(data, limit); } catch (e) {
        if (tooBig(e)) throw new ExtractError('This PDF unpacks to more than Lectern can read at once. Save the pages you need as a smaller PDF, or paste the text.');
        try { data = zlib.inflateSync(data, { ...limit, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e2) {
          if (tooBig(e2)) throw new ExtractError('This PDF unpacks to more than Lectern can read at once. Save the pages you need as a smaller PDF, or paste the text.');
          return null;
        }
      }
      budget.left -= data.length;
      const pred = +(o.dict.match(/\/Predictor\s+(\d+)/) || [])[1] || 1;
      if (pred >= 10) data = unpredict(data, +(o.dict.match(/\/Columns\s+(\d+)/) || [])[1] || 1);
    } else if (f === '/ASCIIHexDecode' || f === '/AHx') {
      data = Buffer.from(data.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
    } else return null; // images and rarer filters hold no text we can read
  }
  return data;
}

function unpredict(data, cols) {
  const rowLen = cols + 1;
  const out = Buffer.alloc(Math.floor(data.length / rowLen) * cols);
  const prev = Buffer.alloc(cols);
  for (let r = 0; r * rowLen < data.length - cols; r++) {
    const type = data[r * rowLen];
    for (let c = 0; c < cols; c++) {
      const x = data[r * rowLen + 1 + c];
      const left = c ? out[r * cols + c - 1] : 0;
      const up = prev[c];
      let v = x;
      if (type === 1) v = x + left; else if (type === 2) v = x + up; else if (type === 3) v = x + ((left + up) >> 1);
      else if (type === 4) { const p = left + up - (c ? prev[c - 1] : 0); const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - (c ? prev[c - 1] : 0)); v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : (c ? prev[c - 1] : 0)); }
      out[r * cols + c] = v & 255;
    }
    out.copy(prev, 0, r * cols, r * cols + cols);
  }
  return out;
}

/** The raw text of a dictionary value: a reference "12 0 R", a <<dict>>, an [array] or a token. */
function dictValue(dict, key) {
  const re = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`, 'g');
  const m = re.exec(dict);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (dict.startsWith('<<', i)) {
    let depth = 0;
    for (let j = i; j < dict.length - 1; j++) {
      if (dict.startsWith('<<', j)) { depth++; j++; } else if (dict.startsWith('>>', j)) { depth--; j++; if (!depth) return dict.slice(i, j + 1); }
    }
    return dict.slice(i);
  }
  if (dict[i] === '[') {
    let depth = 0;
    for (let j = i; j < dict.length; j++) { if (dict[j] === '[') depth++; else if (dict[j] === ']' && !--depth) return dict.slice(i, j + 1); }
    return dict.slice(i);
  }
  const ref = dict.slice(i).match(/^(\d+)\s+(\d+)\s+R/);
  if (ref) return ref[0];
  const tok = dict.slice(i).match(/^(\/[^\s/<>[\]()]+|[^\s/<>[\]()]+)/);
  return tok ? tok[0] : null;
}

/** Entries of an inline dictionary: "<< /F1 5 0 R /F2 6 0 R >>" -> { F1: "5 0 R", ... } */
function dictEntries(d) {
  const out = {};
  if (!d) return out;
  const inner = d.replace(/^<<|>>$/g, '');
  for (const m of inner.matchAll(/\/([^\s/<>[\]()]+)\s*(\d+\s+\d+\s+R|<<[\s\S]*?>>|\/[^\s/<>[\]()]+|\[[^\]]*\]|[^\s/<>[\]()]+)/g)) out[m[1]] = m[2];
  return out;
}

const WIN = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };
const GLYPHS = { space: ' ', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesingle: "'", endash: '–', emdash: '—', hyphen: '-', minus: '−', bullet: '•', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', ellipsis: '…', period: '.', comma: ',', colon: ':', semicolon: ';', exclam: '!', question: '?', parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']', slash: '/', percent: '%', ampersand: '&', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', dollar: '$', numbersign: '#', at: '@', plus: '+', equal: '=', less: '<', greater: '>', asterisk: '*', underscore: '_', degree: '°', dieresis: '¨', acute: '´', grave: '`', copyright: '©', registered: '®', section: '§', paragraph: '¶', dagger: '†' };

class PdfDoc {
  constructor(objs, budget = { left: PDF_BUDGET }) { this.objs = objs; this.fonts = new Map(); this.budget = budget; }
  get(v) {
    if (v == null) return null;
    const m = String(v).match(/^(\d+)\s+\d+\s+R/);
    if (!m) return { dict: String(v), stream: null };
    return this.objs.get(+m[1]) || null;
  }
  resolveDict(v) { const o = this.get(v); return o ? o.dict : ''; }
  pages() {
    let root = null;
    for (const o of this.objs.values()) if (/\/Type\s*\/Catalog\b/.test(o.dict)) root = o;
    const out = [];
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      if (!node || depth > 40 || seen.has(node)) return;
      seen.add(node);
      const res = dictValue(node.dict, 'Resources') || inherited;
      if (/\/Type\s*\/Pages\b/.test(node.dict) || (dictValue(node.dict, 'Kids') && !/\/Type\s*\/Page\b(?!s)/.test(node.dict))) {
        const kids = dictValue(node.dict, 'Kids') || '';
        for (const r of kids.match(/\d+\s+\d+\s+R/g) || []) walk(this.get(r), res, depth + 1);
      } else if (/\/Type\s*\/Page\b/.test(node.dict)) out.push({ node, res });
    };
    if (root) walk(this.get(dictValue(root.dict, 'Pages')), null, 0);
    if (!out.length) for (const o of this.objs.values()) if (/\/Type\s*\/Page\b(?!s)/.test(o.dict)) out.push({ node: o, res: dictValue(o.dict, 'Resources') });
    return out;
  }
  pageText({ node, res }) {
    const contents = dictValue(node.dict, 'Contents');
    if (!contents) return '';
    const refs = contents.startsWith('[') ? contents.match(/\d+\s+\d+\s+R/g) || [] : [contents];
    const data = Buffer.concat(refs.map((r) => decodeStream(this.get(r) || {}, this.budget) || Buffer.alloc(0)).map((b) => Buffer.concat([b, Buffer.from('\n')])));
    return this.runContent(data.toString('latin1'), this.resolveDict(res), 0);
  }
  font(resDict, name) {
    const fontsVal = dictValue(resDict, 'Font');
    const fonts = dictEntries(fontsVal && /^\d/.test(fontsVal) ? this.resolveDict(fontsVal) : fontsVal);
    const ref = fonts[name];
    const key = ref || name;
    if (this.fonts.has(key)) return this.fonts.get(key);
    const fd = this.resolveDict(ref);
    const font = { bytes: 1, map: null, enc: {} };
    const tu = dictValue(fd, 'ToUnicode');
    if (tu && /^\d/.test(tu)) {
      const data = decodeStream(this.get(tu) || {}, this.budget);
      if (data) Object.assign(font, parseCMap(data.toString('latin1')));
    }
    if (/\/Subtype\s*\/Type0/.test(fd) || /Identity-H|Identity-V/.test(fd)) font.bytes = 2;
    font.widths = this.widths(fd, font.bytes === 2);
    let enc = dictValue(fd, 'Encoding');
    if (enc && /^\d/.test(enc)) enc = this.resolveDict(enc);
    const diffs = enc && dictValue(enc, 'Differences');
    if (diffs) {
      let code = 0;
      for (const t of diffs.replace(/[[\]]/g, ' ').match(/\/[^\s/[\]]+|\d+/g) || []) {
        if (/^\d/.test(t)) code = +t;
        else { const g = t.slice(1); font.enc[code++] = GLYPHS[g] || (/^uni([0-9A-F]{4})/.test(g) ? String.fromCharCode(parseInt(g.slice(3, 7), 16)) : g.length === 1 ? g : ''); }
      }
    }
    this.fonts.set(key, font);
    return font;
  }
  /** Glyph widths in thousandths of an em: { get(code) }. Used only to tell word gaps from kerning. */
  widths(fd, cid) {
    const arr = (v) => (v && /^\d+\s+\d+\s+R/.test(v) ? this.resolveDict(v) : v) || '';
    const map = new Map();
    let dflt = cid ? 1000 : 500;
    if (cid) {
      const desc = arr(dictValue(fd, 'DescendantFonts'));
      const ref = (desc.match(/\d+\s+\d+\s+R/) || [])[0];
      const cf = ref ? this.resolveDict(ref) : desc;
      dflt = +(dictValue(cf, 'DW') || 1000);
      const w = arr(dictValue(cf, 'W'));
      const toks = w.replace(/^\[|\]$/g, '').match(/\[[^\]]*\]|[\d.]+/g) || [];
      let left = 200000; // widths set for one font: enough for any real font, and a bound for a hostile one
      for (let k = 0; k < toks.length && left > 0;) {
        const c = +toks[k];
        if (toks[k + 1] && toks[k + 1][0] === '[') { (toks[k + 1].match(/[\d.]+/g) || []).forEach((x, j) => { map.set(c + j, +x); left--; }); k += 2; }
        else { const c2 = +toks[k + 1]; const x = +toks[k + 2]; for (let q = c; q <= c2 && q - c < 65536 && left > 0; q++, left--) map.set(q, x); k += 3; }
      }
    } else {
      const first = +(dictValue(fd, 'FirstChar') || 0);
      (arr(dictValue(fd, 'Widths')).match(/[\d.]+/g) || []).forEach((x, j) => map.set(first + j, +x));
      const avg = [...map.values()].filter(Boolean);
      if (avg.length) dflt = avg.reduce((a, b) => a + b, 0) / avg.length;
    }
    return { get: (code) => map.get(code) || dflt };
  }
  decodeString(bytes, font) {
    let s = '';
    if (font.map) {
      const n = font.bytes === 2 || font.codeLen === 2 ? 2 : 1;
      for (let i = 0; i + n <= bytes.length; i += n) {
        const code = n === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
        const u = font.map.get(code);
        s += u != null ? u : (n === 1 ? (font.enc[code] ?? latin(code)) : '');
      }
      return s;
    }
    if (font.bytes === 2) return ''; // two-byte font without a Unicode map: the glyphs cannot be read as letters
    for (const b of bytes) s += font.enc[b] ?? latin(b);
    return s;
  }
  runContent(src, resDict, depth) {
    const toks = tokenize(src);
    let out = '';
    // Whether the text so far ends in white space. Kept here because reading the end of a long string that was
    // built piece by piece makes V8 copy all of it, which on a long page would happen thousands of times.
    let spaced = true;
    const add = (t) => { if (t) { out += t; spaced = /\s$/.test(t); } };
    let font = { bytes: 1, map: null, enc: {}, widths: { get: () => 500 } };
    let fs = 10, tc = 0, tw = 0, leading = 0;
    let tm = [1, 0, 0, 1, 0, 0];
    let lm = [1, 0, 0, 1, 0, 0];
    let end = null; // where the previous piece of text stopped, in page space
    const stack = [];
    const scaleY = () => Math.hypot(tm[2], tm[3]) * fs || 10;
    const move = (tx, ty) => { lm = [lm[0], lm[1], lm[2], lm[3], lm[4] + tx * lm[0] + ty * lm[2], lm[5] + tx * lm[1] + ty * lm[3]]; tm = lm.slice(); };
    const advance = (tx) => { tm[4] += tx * tm[0]; tm[5] += tx * tm[1]; };
    // Before new text: a jump down is a new line (a big jump a new paragraph); a gap sideways is a space.
    const gap = () => {
      if (end) {
        const h = scaleY();
        const dy = Math.abs(tm[5] - end.y);
        const dx = tm[4] - end.x;
        if (dy > h * 0.6) add(dy > h * 1.9 ? '\n\n' : '\n');
        else if (dx > h * 0.18 && !spaced) add(' ');
        else if (dx < -h * 2 && !spaced) add(' ');
      }
    };
    const show = (bytes) => {
      gap();
      const n = font.bytes === 2 || font.codeLen === 2 ? 2 : 1;
      add(this.decodeString(bytes, font));
      for (let i = 0; i + n <= bytes.length; i += n) {
        const code = n === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
        advance((font.widths.get(code) / 1000) * fs + tc + (n === 1 && code === 32 ? tw : 0));
      }
      end = { x: tm[4], y: tm[5] };
    };
    for (const t of toks) {
      if (t.op === undefined) { stack.push(t); continue; }
      const op = t.op;
      const num = (k) => (stack[stack.length - k] && typeof stack[stack.length - k].v === 'number' ? stack[stack.length - k].v : 0);
      if (op === 'BT') { tm = [1, 0, 0, 1, 0, 0]; lm = tm.slice(); }
      else if (op === 'Tf') { const nm = stack[stack.length - 2]; if (nm && nm.name) font = this.font(resDict, nm.name); fs = num(1) || fs; }
      else if (op === 'Tc') tc = num(1);
      else if (op === 'Tw') tw = num(1);
      else if (op === 'TL') leading = num(1);
      else if (op === 'Td') move(num(2), num(1));
      else if (op === 'TD') { leading = -num(1); move(num(2), num(1)); }
      else if (op === 'Tm') { tm = [num(6), num(5), num(4), num(3), num(2), num(1)]; lm = tm.slice(); }
      else if (op === 'T*') move(0, -leading);
      else if (op === 'Tj') { const s = stack[stack.length - 1]; if (s && s.str) show(s.str); }
      else if (op === "'" || op === '"') { if (op === '"') { tw = num(3); tc = num(2); } move(0, -leading); const s = stack[stack.length - 1]; if (s && s.str) show(s.str); }
      else if (op === 'TJ') {
        const arr = stack[stack.length - 1];
        if (arr && arr.arr) {
          for (const e of arr.arr) {
            if (e.str) show(e.str);
            else if (typeof e.v === 'number') advance((-e.v / 1000) * fs);
          }
        }
      } else if (op === 'Do' && depth < 3) {
        const nm = stack[stack.length - 1];
        const xo = dictEntries((() => { const v = dictValue(resDict, 'XObject'); return v && /^\d/.test(v) ? this.resolveDict(v) : v; })());
        const obj = nm && nm.name && xo[nm.name] ? this.get(xo[nm.name]) : null;
        if (obj && /\/Subtype\s*\/Form/.test(obj.dict)) {
          const data = decodeStream(obj, this.budget);
          const r = dictValue(obj.dict, 'Resources');
          if (data) { add('\n'); add(this.runContent(data.toString('latin1'), r ? (/^\d/.test(r) ? this.resolveDict(r) : r) : resDict, depth + 1)); add('\n'); end = null; }
        }
      }
      stack.length = 0;
    }
    return out;
  }
}

function latin(code) { return WIN[code] || (code >= 32 ? String.fromCharCode(code) : code === 9 ? ' ' : ''); }

function hexBytes(h) { const s = h.replace(/[^0-9a-f]/gi, ''); return Buffer.from(s.length % 2 ? s + '0' : s, 'hex'); }
function hexToUnicode(h) {
  const b = hexBytes(h);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}

/** The text between each open and close keyword, found with indexOf (an unclosed block cannot make it slow). */
function between(s, open, close) {
  const out = [];
  for (let at = 0; ;) {
    const i = s.indexOf(open, at);
    if (i === -1) return out;
    const j = s.indexOf(close, i + open.length);
    if (j === -1) return out;
    out.push(s.slice(i + open.length, j));
    at = j + close.length;
  }
}

function parseCMap(s) {
  const map = new Map();
  let codeLen = 1;
  const cs = s.match(/begincodespacerange\s*<([0-9a-f]+)>/i);
  if (cs) codeLen = cs[1].length > 2 ? 2 : 1;
  for (const block of between(s, 'beginbfchar', 'endbfchar')) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (m[1].length > 2) codeLen = 2;
      map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
    }
  }
  let left = 1000000; // codes mapped from ranges: a bound for a hostile map
  for (const block of between(s, 'beginbfrange', 'endbfrange')) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[1].length > 2) codeLen = 2;
      if (m[3][0] === '[') {
        const list = m[3].match(/<([0-9a-f]*)>/gi) || [];
        list.forEach((h, k) => map.set(lo + k, hexToUnicode(h.slice(1, -1))));
      } else {
        const base = hexToUnicode(m[3].slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && left > 0; c++, left--) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map.size ? { map, codeLen } : {};
}

/** Tokens of a content stream: { v: number } | { name } | { str: bytes } | { arr: [...] } | { op }. */
function tokenize(src) {
  const out = [];
  const stack = [out];
  let i = 0;
  const n = src.length;
  const push = (t) => stack[stack.length - 1].push(t);
  while (i < n) {
    const c = src[i];
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') {
      let depth = 1; i++;
      const bytes = [];
      while (i < n && depth) {
        let ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          i += 2;
          if (nx === 'n') bytes.push(10); else if (nx === 'r') bytes.push(13); else if (nx === 't') bytes.push(9);
          else if (nx === 'b') bytes.push(8); else if (nx === 'f') bytes.push(12);
          else if (nx === '\r') { if (src[i] === '\n') i++; }
          else if (nx === '\n') { /* line continuation */ }
          else if (/[0-7]/.test(nx)) { let o = nx; while (o.length < 3 && /[0-7]/.test(src[i])) o += src[i++]; bytes.push(parseInt(o, 8) & 255); }
          else bytes.push(nx.charCodeAt(0));
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) { i++; break; } }
        bytes.push(ch.charCodeAt(0) & 255);
        i++;
      }
      push({ str: Buffer.from(bytes) });
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const j = src.indexOf('>', i);
      push({ str: hexBytes(src.slice(i + 1, j === -1 ? n : j)) });
      i = j === -1 ? n : j + 1;
      continue;
    }
    if (c === '<' || c === '>') { i += 2; continue; } // dictionaries (marked content): ignored
    if (c === '[') { const arr = []; push({ arr }); stack.push(arr); i++; continue; }
    if (c === ']') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === '{' || c === '}') { i++; continue; }
    if (c === '/') { let j = i + 1; while (j < n && !/[\s/<>[\]()%{}]/.test(src[j])) j++; push({ name: src.slice(i + 1, j) }); i = j; continue; }
    let j = i;
    while (j < n && !/[\s/<>[\]()%{}]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    const word = src.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ v: parseFloat(word) }); continue; }
    if (word === 'BI') { // inline image: skip its binary data (always forward: a missing ID or EI ends the stream)
      const id = src.indexOf('ID', i);
      const end = id === -1 ? -1 : src.indexOf('EI', id + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (word === 'true' || word === 'false' || word === 'null') { push({ v: word }); continue; }
    if (stack.length > 1) continue; // an operator inside an array is malformed: ignore it
    out.push({ op: word });
  }
  return out;
}

module.exports = { extractText, ExtractError, htmlText, pdfText, unzip, decodeEntities, MAX_BYTES };
