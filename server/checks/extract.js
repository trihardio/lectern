'use strict';
// Plain text from a document the user drops on the Writing desk page. Node built-ins only:
// .docx / .odt are zip files of XML (read with zlib), PDFs are parsed here (text layer only,
// no scanned images), web pages and plain text are stripped of markup.

const zlib = require('zlib');

const MAX_BYTES = 12 * 1024 * 1024;

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
    const files = unzip(data);
    if (files['word/document.xml']) { text = docxText(files); kind = 'Word document'; }
    else if (files['content.xml']) { text = odtText(files['content.xml'].toString('utf8')); kind = 'OpenDocument text'; }
    else if (files['ppt/presentation.xml']) throw new ExtractError('Slides are not supported. Save the text as a Word document or PDF.');
    else throw new ExtractError('This zip file is not a Word or OpenDocument file.');
  } else if (head.startsWith('{\\rtf')) { text = rtfText(data.toString('latin1')); kind = 'Rich text'; }
  else if (data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new ExtractError('Old Word files (.doc) are not supported. Save it as .docx or PDF, or paste the text.');
  } else {
    const s = decodeText(data);
    if (/[\u0000-\u0008\u000e-\u001f]/.test(s.slice(0, 4000))) throw new ExtractError('This file type is not supported. Use a PDF, Word (.docx), OpenDocument (.odt), text or web page file.');
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

/** Read a zip archive's files into { name: Buffer }. Only "stored" and "deflate" entries are supported. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new ExtractError('The file looks damaged (zip directory not found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
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
    if (!/\.xml$|\.rels$/.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    try {
      if (method === 0) files[name] = raw;
      else if (method === 8) files[name] = zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
    } catch { /* one unreadable part is skipped */ }
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', deg: '°', middot: '·', bull: '•', eacute: 'é', egrave: 'è', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', times: '×', minus: '−', shy: '' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

function docxText(files) {
  const parts = ['word/document.xml'];
  const out = [];
  for (const part of parts) {
    const xml = files[part].toString('utf8');
    const body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '') // deleted tracked changes are not part of the text
      .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
    for (const p of body.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || []) {
      let line = '';
      for (const t of p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) || []) {
        if (t === '<w:tab/>') line += '\t';
        else if (t === '<w:br/>' || t === '<w:cr/>') line += '\n';
        else line += decodeEntities(t.replace(/<[^>]+>/g, ''));
      }
      out.push(line);
    }
  }
  return out.join('\n\n');
}

function odtText(xml) {
  return decodeEntities(xml
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, c) => ' '.repeat(+c || 1))
    .replace(/<\/text:(p|h)>/g, '\n\n')
    .replace(/<[^>]+>/g, ''));
}

function rtfText(s) {
  return s.replace(/\{\\\*[^{}]*\}/g, '').replace(/\\par[d]?\b/g, '\n').replace(/\\'([0-9a-f]{2})/gi, (m, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

/** Readable text of a web page: no scripts, styles, menus or footers. */
function htmlText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = s.match(/<(article|main)\b[\s\S]*?<\/\1\s*>/i);
  if (main && main[0].length > 1500) s = main[0];
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|figcaption|dd|dt)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
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
  const objs = pdfObjects(buf, raw);
  const doc = new PdfDoc(objs);
  const pages = doc.pages();
  if (!pages.length) throw new ExtractError('No pages were found in this PDF.');
  const out = [];
  for (const page of pages.slice(0, 400)) {
    try { out.push(doc.pageText(page)); } catch { out.push(''); }
  }
  return tidyPdf(out.join('\n\n'));
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
function pdfObjects(buf, raw) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = +m[1];
    const start = m.index + m[0].length;
    const streamAt = raw.indexOf('stream', start);
    const endObj = raw.indexOf('endobj', start);
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
        dataEnd = raw.indexOf('endstream', dataStart);
        if (dataEnd === -1) dataEnd = endObj;
      }
      stream = buf.subarray(dataStart, dataEnd);
      const after = raw.indexOf('endobj', dataEnd);
      re.lastIndex = after === -1 ? dataEnd : after;
    } else {
      re.lastIndex = endObj;
    }
    objs.set(num, { dict, stream });
  }
  // Objects packed inside object streams.
  for (const [, o] of [...objs]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decodeStream(o);
    if (!data) continue;
    const s = data.toString('latin1');
    const n = +(o.dict.match(/\/N\s+(\d+)/) || [])[1] || 0;
    const first = +(o.dict.match(/\/First\s+(\d+)/) || [])[1] || 0;
    const nums = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = nums[2 * k];
      const off = first + nums[2 * k + 1];
      const end = k + 1 < n ? first + nums[2 * k + 3] : s.length;
      if (!objs.has(num) || !objs.get(num).fromStream) objs.set(num, { dict: s.slice(off, end), stream: null, fromStream: true });
    }
  }
  return objs;
}

function decodeStream(o) {
  if (!o.stream) return null;
  const filter = (o.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [, ''])[1];
  const filters = filter.match(/\/\w+/g) || [];
  let data = o.stream;
  for (const f of filters) {
    if (f === '/FlateDecode' || f === '/Fl') {
      try { data = zlib.inflateSync(data); } catch {
        try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
      }
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
  constructor(objs) { this.objs = objs; this.fonts = new Map(); }
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
    const data = Buffer.concat(refs.map((r) => decodeStream(this.get(r) || {}) || Buffer.alloc(0)).map((b) => Buffer.concat([b, Buffer.from('\n')])));
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
      const data = decodeStream(this.get(tu) || {});
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
      for (let k = 0; k < toks.length;) {
        const c = +toks[k];
        if (toks[k + 1] && toks[k + 1][0] === '[') { (toks[k + 1].match(/[\d.]+/g) || []).forEach((x, j) => map.set(c + j, +x)); k += 2; }
        else { const c2 = +toks[k + 1]; const x = +toks[k + 2]; for (let q = c; q <= c2 && q - c < 65536; q++) map.set(q, x); k += 3; }
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
        if (dy > h * 0.6) out += dy > h * 1.9 ? '\n\n' : '\n';
        else if (dx > h * 0.18 && !/\s$/.test(out)) out += ' ';
        else if (dx < -h * 2 && !/\s$/.test(out)) out += ' ';
      }
    };
    const show = (bytes) => {
      gap();
      const n = font.bytes === 2 || font.codeLen === 2 ? 2 : 1;
      out += this.decodeString(bytes, font);
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
          const data = decodeStream(obj);
          const r = dictValue(obj.dict, 'Resources');
          if (data) { out += '\n'; out += this.runContent(data.toString('latin1'), r ? (/^\d/.test(r) ? this.resolveDict(r) : r) : resDict, depth + 1); out += '\n'; end = null; }
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

function parseCMap(s) {
  const map = new Map();
  let codeLen = 1;
  const cs = s.match(/begincodespacerange\s*<([0-9a-f]+)>/i);
  if (cs) codeLen = cs[1].length > 2 ? 2 : 1;
  for (const block of s.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (m[1].length > 2) codeLen = 2;
      map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
    }
  }
  for (const block of s.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
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
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
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
    if (word === 'BI') { // inline image: skip its binary data
      const end = src.indexOf('EI', src.indexOf('ID', i));
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
