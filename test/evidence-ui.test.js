'use strict';
// The evidence views in the window (ui/evidence.js build()), run with a tiny element stub instead of a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

function load() {
  const ctx = { window: {}, self: undefined };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'evidence.js'), 'utf8'), ctx);
  ctx.window.LecternEvidence = ctx.window.LecternEvidence || ctx.LecternEvidence;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui', 'evidence.js'), 'utf8'), ctx);
  return ctx.window.LecternEvidenceUI;
}
// enough of an element for build(): attributes, children, text
function h(tag, attrs, ...kids) {
  const el = { tag, attrs: attrs || {}, childNodes: [],
    append(...k) { for (const x of k.flat(Infinity)) if (x != null && x !== false) this.childNodes.push(x); },
    replaceChildren(...k) { this.childNodes = []; this.append(...k); },
    setAttribute(k, v) { this.attrs[k] = v; } };
  el.append(...kids);
  return el;
}
const text = (el) => (typeof el === 'string' || typeof el === 'number' ? String(el) : el.childNodes.map(text).join(''));
const all = (el, pred, out = []) => { if (el && typeof el === 'object') { if (pred(el)) out.push(el); el.childNodes.forEach((c) => all(c, pred, out)); } return out; };

test('evidence: an answer without readings says where "Read each paper" is, or to ask again when it is on', () => {
  const UI = load();
  const turn = { papers: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }], insights: [], mode: 'answer', running: false };
  const off = text(UI.build(turn, { h, label: (n) => `Paper ${n}`, inspect() {}, readingOn: false }));
  assert.match(off, /Turn on “Read each paper” in Settings, then ask again/);
  assert.doesNotMatch(off, /Retry with/);
  const on = text(UI.build(turn, { h, label: (n) => `Paper ${n}`, inspect() {}, readingOn: true }));
  assert.match(on, /could not be read for this answer\. Ask again/);
});

test('evidence: an empty coverage cell is a faint dash, and its name says it in words', () => {
  const UI = load();
  const quote = (k, v) => `the ${k} reported was ${v}`;
  const rows = [
    { direction: 'higher', designType: 'randomised', population: 'Nurses', measurement: 'objective' },
    { direction: 'lower', designType: 'observational', population: 'Teachers', measurement: 'self-report' },
    { direction: 'higher', designType: 'observational', population: 'Students', measurement: 'self-report' },
    { direction: 'unchanged', designType: 'randomised', population: 'Nurses', measurement: 'objective' },
  ];
  const papers = rows.map((r, i) => ({ n: i + 1, title: `Paper ${i + 1}`, abstract: `Abstract ${i + 1}. ${Object.entries(r).map(([k, v]) => quote(k, v)).join('. ')}.` }));
  const insights = rows.map((r, i) => ({ n: i + 1, relevant: true, stance: 'na', facts: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v, quote: quote(k, v) }])) }));
  const el = UI.build({ papers, insights, yesNo: false, mode: 'answer' }, { h, label: (n) => `Paper ${n}`, inspect() {} });
  const cells = all(el, (x) => x.tag === 'button' && /coverage-cell/.test(x.attrs.class || ''));
  const empty = cells.filter((c) => /\bempty\b/.test(c.attrs.class));
  assert.ok(empty.length > 0, 'the map has empty cells');
  for (const c of empty) {
    assert.equal(text(c), '–');
    assert.match(c.attrs['aria-label'], /0 papers tagged in this set$/);
  }
  assert.doesNotMatch(text(el), /No tagged papers|Not established here/);
});
