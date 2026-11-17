// The Writing desk's proofreader: the writer's text in an editable sheet, with spelling, grammar, punctuation,
// capital-letter and spacing mistakes underlined in place, and a rail of suggestions to accept or dismiss.
//   - Instant checks (shared/proofrules.js) run as the writer types, on this computer, with no plan usage. A long text
//     is checked again after a short pause in the typing; until then the marks already found move with their words.
//   - "Check" sends the text to the selected model (server/checks/proofread.js); a second check sends only the
//     sentences that changed. Suggestions keep pointing at the right words while the writer keeps typing.
// The text box is a normal <textarea> lying over a mirror of the same text; the mirror draws the underlines, so the
// caret, selection, undo and spell-check of a real text box all keep working. The mirror is one block per line of the
// text and the rail one card per suggestion, and a change redraws only the lines and cards it touched, so typing in a
// long text stays quick. Built with h() only (text nodes).
(function () {
  'use strict';

  const KIND = {
    spelling: { label: 'Spelling', cls: 'spell' },
    word: { label: 'Word choice', cls: 'spell' },
    grammar: { label: 'Grammar', cls: 'gram' },
    punctuation: { label: 'Punctuation', cls: 'mech' },
    capitalization: { label: 'Capitals', cls: 'mech' },
    spacing: { label: 'Spacing', cls: 'mech' },
  };
  const ORDER = ['spelling', 'grammar', 'punctuation', 'capitalization', 'spacing', 'word'];
  const VARIANTS = [
    { value: 'auto', label: 'Any English' }, { value: 'us', label: 'American English' }, { value: 'uk', label: 'British English' },
    { value: 'au', label: 'Australian English' }, { value: 'ca', label: 'Canadian English' },
  ];
  const MAX_CHARS = 40000;
  const WPM = 238; // average adult silent reading rate for non-fiction in English (Brysbaert 2019)
  // After a key press the instant checks read again only the paragraphs around the change, at once when that is at
  // most this many characters (a long paragraph without blank lines waits for a pause in the typing; its marks move
  // with their words meanwhile). The word counts of a text longer than this also wait for the pause.
  const INSTANT_MAX = 20000;
  const PAUSE_MS = 300;
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const wordList = (s) => String(s).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];

  /** The one stretch that changed between two texts: [p, oldEnd) of `before` became [p, oldEnd + delta) of `after`. */
  function editOf(before, after) {
    const max = Math.min(before.length, after.length);
    let p = 0;
    while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
    return { p, oldEnd: before.length - s, delta: after.length - before.length };
  }
  /** Where the range [start, end) sits after the edit (null: no edit), or null when the edit touched it. */
  function through(edit, start, end) {
    if (!edit || end <= edit.p) return { start, end };
    if (start >= edit.oldEnd) return { start: start + edit.delta, end: end + edit.delta };
    return null;
  }
  /** Suggestions moved through an edit; one whose words were touched is dropped. */
  function move(list, edit, next) {
    const out = [];
    for (const s of list) {
      const r = through(edit, s.start, s.end);
      if (r && next.slice(r.start, r.end) === s.from) out.push(r.start === s.start ? s : { ...s, ...r });
    }
    return out;
  }

  /** The part of the text not yet read by the instant checks, [start, end), after one more edit (null: none before). */
  function joinDirty(dirty, edit) {
    const a = edit.p;
    const b = edit.oldEnd + edit.delta;
    if (!dirty) return [a, b];
    const at = (pos, end) => (pos <= edit.p ? pos : pos >= edit.oldEnd ? pos + edit.delta : end ? b : a);
    return [Math.min(at(dirty[0], false), a), Math.max(at(dirty[1], true), b)];
  }

  // Paragraphs are separated by a blank line (spaces or tabs allowed on it). No instant check finds a mistake across a
  // blank line; a few look at the last word of the paragraph before (up to 40 characters back) or at the first word of
  // the next one ("i" and "could of" at a paragraph's end). So after a change the checks read again the paragraphs it
  // touched and one paragraph on each side, with one more paragraph on each side as context.
  const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const isBlankChar = (c) => c === 32 || c === 9 || c === 13;
  /** Where the paragraph holding `pos` starts: just after the blank line before it, or 0. */
  function paraStart(text, pos) {
    for (let i = Math.min(pos, text.length) - 1; i > 0; i--) {
      if (text.charCodeAt(i) !== 10) continue;
      let j = i - 1;
      while (j >= 0 && isBlankChar(text.charCodeAt(j))) j--;
      if (j < 0 || text.charCodeAt(j) === 10) return i + 1;
    }
    return 0;
  }
  /** Where the paragraph holding `pos` ends: at the line break that begins the next blank line, or the end of the text. */
  function paraEnd(text, pos) {
    for (let i = Math.max(0, pos); i < text.length; i++) {
      if (text.charCodeAt(i) !== 10) continue;
      let j = i + 1;
      while (j < text.length && isBlankChar(text.charCodeAt(j))) j++;
      if (j >= text.length || text.charCodeAt(j) === 10) return i;
    }
    return text.length;
  }
  /** The start of the paragraph before the one that starts at `start` (0 when there is none). */
  function prevPara(text, start) {
    let k = start;
    while (k > 0 && isSpace(text.charCodeAt(k - 1))) k--;
    return k > 0 ? paraStart(text, k) : 0;
  }
  /** The end of the paragraph after the one that ends at `end` (the end of the text when there is none). */
  function nextPara(text, end) {
    let n = end;
    while (n < text.length && isSpace(text.charCodeAt(n))) n++;
    return n < text.length ? paraEnd(text, n) : text.length;
  }
  /**
   * What to read again after a change in [s, e): findings that start in [from, to) are found again; [ctx, from) and
   * [to, tail) are only read as context.
   */
  function recheckSpan(text, s, e) {
    const first = paraStart(text, s);
    const from = prevPara(text, first);
    const to = nextPara(text, paraEnd(text, Math.max(e, first)));
    return { ctx: prevPara(text, from), from, to, tail: nextPara(text, to) };
  }
  /** The instant checks' findings after a change: those in [from, to) found again, the others kept as they were. */
  function recheck(Rules, text, old, span) {
    const { ctx, from, to, tail } = span;
    if (ctx === 0 && tail >= text.length) return Rules.check(text);
    const fresh = [];
    for (const f of Rules.check(text.slice(ctx, tail))) {
      const a = f.start + ctx;
      if (a >= from && a < to) fresh.push({ ...f, start: a, end: f.end + ctx });
    }
    return [...old.filter((r) => r.end <= from), ...fresh, ...old.filter((r) => r.start >= to)];
  }

  window.LecternProofread = function create(deps) {
    const { h, fill, api, toast, TOKEN, picker, modelPicker, selected, modelReady, transfer, onBusy, nameOf, about, moreMenu, STRICT,
      readEvents, copyText, keepFocus, ACCEPT, FILE_TYPES } = deps;
    const Rules = window.LecternProofRules;

    let text = '';
    let file = null;
    let model = []; // the model's suggestions, kept in step with the text
    let rules = []; // the instant checks' suggestions, kept in step with the text
    let dirty = null; // [start, end) of the text the instant checks have not read since it changed (null: none)
    let shown = []; // what is underlined and listed now
    const dismissed = new Set();
    let active = null;
    let run = null; // { abort, sent, parts, done, total }
    let last = null; // the last finished check
    let lastText = null; // the text that check read
    let notice = '';
    let error = '';
    const undo = []; // accepted suggestions: { before, model, after }
    const redo = []; // undone ones: { before, model, after, modelAfter }
    let variant = 'auto';
    try { variant = localStorage.getItem('lectern.proofVariant') || 'auto'; } catch { /* default */ }
    let seq = 0;
    let loads = 0;

    // ---------------------------------------------------------------- the editor
    const back = h('div', { class: 'pf-back', 'aria-hidden': 'true' });
    const ta = h('textarea', {
      class: 'pf-text', 'aria-label': 'Text to proofread', spellcheck: 'false', 'data-focus': 'text', 'data-focus-default': '',
      placeholder: 'Paste or type your writing.',
    });
    const edit = h('div', { class: 'pf-edit' }, back, ta);
    const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFile(f); } });
    const sheetTop = h('div', { class: 'chk-sheet-top' });
    const sheet = h('div', { class: 'chk-sheet pf-sheet' }, sheetTop, edit, h('div', { class: 'chk-drop', 'aria-hidden': 'true' }, h('span', null, 'Drop to read the document')));
    const status = h('div', { class: 'pf-status', role: 'status', 'aria-live': 'polite' });
    const list = h('ol', { class: 'pf-list', 'aria-label': 'Suggestions' });
    const railHead = h('div', { class: 'pf-rail-head' });
    const stats = h('dl', { class: 'pf-stats' });
    const statsWrap = h('div', { class: 'pf-stats-wrap', hidden: true }, h('h2', { class: 'pf-h' }, 'This text'), stats);
    const rail = h('aside', { class: 'pf-rail', 'aria-label': 'Proofreading suggestions' }, railHead, list, statsWrap);
    const controls = h('div', { class: 'pf-controls' });
    const root = h('section', { class: 'pf' },
      h('p', { class: 'chk-lede' }, 'Spelling, grammar and punctuation, marked in place'),
      controls,
      h('div', { class: 'pf-grid' }, h('div', { class: 'pf-main' }, sheet, status, limitsBlock()), rail));

    ta.addEventListener('input', () => changed(ta.value));
    ta.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = String(e.key).toLowerCase();
      if (key === 'enter') { e.preventDefault(); check(); return; }
      // Accepted suggestions are undone and redone here; typing keeps the text box's own undo and redo.
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey); // Ctrl+Y on Windows
      if (isUndo && undo.length && undo[undo.length - 1].after === ta.value) { e.preventDefault(); undoLast(); }
      else if (isRedo && redo.length && redo[redo.length - 1].before === ta.value) { e.preventDefault(); redoLast(); }
    });
    const follow = () => { const s = at(ta.selectionStart); if ((s && s.id) !== active) setActive(s ? s.id : null, true); };
    ta.addEventListener('click', follow);
    ta.addEventListener('keyup', (e) => { if (/^(Arrow|Home|End|Page)/.test(e.key)) follow(); });
    ta.addEventListener('blur', () => { if (!rail.contains(document.activeElement)) setActive(null); });
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    sheet.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); sheet.classList.add('is-drag'); } });
    sheet.addEventListener('dragleave', (e) => { if (!sheet.contains(e.relatedTarget)) sheet.classList.remove('is-drag'); });
    sheet.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); sheet.classList.remove('is-drag'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

    /** The text changed (typing, an accepted suggestion, undo, a new document). */
    function changed(next) {
      if (next === text) return;
      const ed = editOf(text, next); // once per change, not once per suggestion
      model = move(model, ed, next);
      rules = move(rules, ed, next);
      dirty = joinDirty(dirty, ed);
      text = next;
      if (file && !text.trim()) file = null;
      notice = '';
      schedule(true);
    }

    let frame = 0;
    let pause = 0;
    /** Redraw on the next frame. After typing in a long text, the word counts (and a very long paragraph) wait for a pause. */
    function schedule(typed = false) {
      if (typed && text.length > INSTANT_MAX) {
        clearTimeout(pause);
        pause = setTimeout(() => { pause = 0; refreshNow(); }, PAUSE_MS);
      }
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(text.length <= INSTANT_MAX || !pause); });
    }

    const keyOf = (s) => `${s.from}\u0000${s.to}\u0000${text.slice(Math.max(0, s.start - 30), s.start)}\u0000${text.slice(s.end, s.end + 30)}`;
    const isDismissed = (s) => dismissed.size > 0 && dismissed.has(keyOf(s));

    /** Ids for fresh findings: one that was already listed keeps its object (and so its mark and card). */
    function named(list) {
      const known = new Map(rules.map((s) => [`${s.start}:${s.end}:${s.rule}:${s.to}`, s]));
      return list.map((f) => {
        if (f.id) return f; // kept as it was
        const o = known.get(`${f.start}:${f.end}:${f.rule}:${f.to}`);
        if (o && o.from === f.from && o.why === f.why && o.title === f.title && o.kind === f.kind) return o;
        return { ...f, source: 'rule', id: o ? o.id : `r${++seq}` };
      });
    }

    /** Redraw. `full` also reads any long changed stretch again and counts the words. */
    function refresh(full = true) {
      if (full) { clearTimeout(pause); pause = 0; }
      if (dirty) {
        const span = recheckSpan(text, dirty[0], dirty[1]);
        if (!Rules) { rules = []; dirty = null; }
        else if (full || span.tail - span.ctx <= INSTANT_MAX) { rules = named(recheck(Rules, text, rules, span)); dirty = null; }
      }
      // The model's suggestions go first (it read the whole sentence); an instant one is kept only where it overlaps
      // none of them. The instant checks never overlap each other.
      const kept = [];
      for (const s of model) if (!isDismissed(s) && !kept.some((t) => s.start < t.end && t.start < s.end)) kept.push(s);
      const fromModel = kept.length;
      for (const s of rules) {
        if (isDismissed(s)) continue;
        let clash = false;
        for (let i = 0; i < fromModel && !clash; i++) clash = s.start < kept[i].end && kept[i].start < s.end;
        if (!clash) kept.push(s);
      }
      kept.sort((a, b) => a.start - b.start || a.end - b.end);
      shown = kept;
      if (active && !shown.some((s) => s.id === active)) active = null;
      drawMirror();
      drawRail();
      drawStatus();
      drawTop();
      updateCheck();
      if (full) drawStats();
    }

    function refreshNow() { if (frame) { cancelAnimationFrame(frame); frame = 0; } refresh(true); }

    /** Redraw at once after an edit made with a click (Accept, undo, redo); on a long text the word counts wait for a pause. */
    function redrawEdit() {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (text.length <= INSTANT_MAX) { refresh(true); return; }
      clearTimeout(pause);
      pause = setTimeout(() => { pause = 0; refreshNow(); }, PAUSE_MS);
      refresh(false);
    }

    // ---------------------------------------------------------------- the mirror
    // One block per line of the text. A line is drawn again only when its words or its marks change, so a key press
    // lays out one paragraph instead of the whole document. A suggestion that runs over a line end is drawn in parts.
    let mirrorLines = [];
    let mirrorMarks = [];
    function drawMirror() {
      const lines = text.split('\n');
      const segsOf = new Array(lines.length);
      const marks = new Array(lines.length);
      let k = 0;
      let lineStart = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = lines[i].length;
        const lineEnd = lineStart + len; // where this line's line break is (or the end of the text)
        const segs = [];
        while (k < shown.length) {
          const s = shown[k];
          if (s.start > lineEnd) break;
          // An insertion point marks the character after it, unless the next suggestion starts there.
          const next = shown[k + 1];
          const end = s.end > s.start ? s.end : (next && next.start === s.start ? s.start : s.start + 1);
          const a = Math.max(s.start, lineStart) - lineStart;
          const b = Math.min(end, lineEnd) - lineStart;
          if (b > a || (s.end === s.start && end > s.start && a === len)) segs.push([a, Math.max(a, b), s]);
          if (end > lineEnd + 1) break; // it runs on into the next line, which draws the rest
          k++;
        }
        segsOf[i] = segs;
        marks[i] = segs.length ? segs.map(([a, b, s]) => `${a},${b},${(KIND[s.kind] || KIND.grammar).cls},${s.id}`).join(';') : '';
        lineStart = lineEnd + 1;
      }
      const n0 = mirrorLines.length;
      const n1 = lines.length;
      const same = (i, j) => mirrorLines[i] === lines[j] && mirrorMarks[i] === marks[j];
      let p = 0;
      while (p < n0 && p < n1 && same(p, p)) p++;
      let q = 0;
      while (q < n0 - p && q < n1 - p && same(n0 - 1 - q, n1 - 1 - q)) q++;
      if (p === n0 && p === n1) return;
      const blocks = [...back.children];
      if (n0 === n1) {
        // The same lines: only those whose words or marks changed are drawn again (a dismissed suggestion that
        // repeats through the text changes lines far apart, and the ones between stay as they are).
        for (let i = p; i < n0 - q; i++) if (!same(i, i)) blocks[i].replaceWith(lineBlock(lines[i], segsOf[i]));
      } else {
        for (let i = n0 - q - 1; i >= p; i--) blocks[i].remove();
        const add = document.createDocumentFragment();
        for (let j = p; j < n1 - q; j++) add.append(lineBlock(lines[j], segsOf[j]));
        back.insertBefore(add, blocks[n0 - q] || null);
      }
      mirrorLines = lines;
      mirrorMarks = marks;
    }

    function lineBlock(line, segs) {
      const parts = [];
      let at0 = 0;
      for (const [a, b, s] of segs) {
        if (a > at0) parts.push(line.slice(at0, a));
        const k = KIND[s.kind] || KIND.grammar;
        parts.push(h('span', { class: `pf-u ${k.cls}${s.id === active ? ' on' : ''}`, 'data-id': s.id }, b > a ? line.slice(a, b) : ' '));
        at0 = Math.max(at0, b);
      }
      if (at0 < line.length) parts.push(line.slice(at0));
      if (!line.length && !segs.length) parts.push('​'); // an empty line keeps its height
      return h('div', { class: 'pf-line' }, parts);
    }

    const at = (pos) => shown.find((s) => pos >= s.start && pos <= s.end) || null;

    /** Light up one suggestion's marks and card; only the old and the new one are touched. */
    function setActive(id, fromText = false) {
      if (id !== active) {
        const marks = (x) => back.querySelectorAll(`.pf-u[data-id="${CSS.escape(x)}"]`);
        const cardOf = (x) => list.querySelector(`.pf-card[data-id="${CSS.escape(x)}"]`);
        if (active) { for (const el of marks(active)) el.classList.remove('on'); cardOf(active)?.classList.remove('on'); }
        active = id;
        if (id) { for (const el of marks(id)) el.classList.add('on'); cardOf(id)?.classList.add('on'); }
      }
      if (id && fromText) {
        const card = list.querySelector(`.pf-card[data-id="${CSS.escape(id)}"]`);
        if (card) { // scroll the rail only, never the page
          const top = card.offsetTop - list.offsetTop;
          if (top < rail.scrollTop || top + card.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = Math.max(0, top - 12);
        }
      }
    }

    // ---------------------------------------------------------------- the rail
    let headKey = null;
    let cardKeys = [];
    function drawRail() {
      const counts = {};
      for (const s of shown) counts[s.kind] = (counts[s.kind] || 0) + 1;
      const hk = `${shown.length}|${ORDER.map((k) => counts[k] || 0).join(',')}`;
      if (hk !== headKey) {
        headKey = hk;
        keepFocus(railHead, () => fill(railHead,
          h('div', { class: 'pf-total' }, h('span', { class: 'pf-total-n' }, fmt(shown.length)), h('span', null, shown.length === 1 ? 'suggestion' : 'suggestions')),
          shown.length > 0 && h('ul', { class: 'pf-counts' }, ORDER.filter((k) => counts[k]).map((k) => h('li', { class: `pf-count ${KIND[k].cls}` },
            h('span', { class: 'pf-swatch', 'aria-hidden': 'true' }), KIND[k].label, h('span', { class: 'pf-n' }, fmt(counts[k]))))),
          shown.length > 1 && h('button', { type: 'button', class: 'btn small pf-all', 'data-focus': 'all', onclick: acceptAll }, `Accept all ${fmt(shown.length)}`)));
      }
      const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('.pf-card')?.dataset.id : null;
      const focusedRole = focusedId ? document.activeElement.dataset.role : null;
      if (!shown.length) {
        const say = emptyText();
        const only = list.childElementCount === 1 ? list.firstElementChild : null;
        if (!(only && only.classList.contains('pf-empty') && only.textContent === say)) fill(list, h('li', { class: 'pf-empty' }, say));
        cardKeys = [];
        return;
      }
      // Only the cards whose suggestion changed are built again; the rest stay where they are (and keep focus and
      // hover). Cards are matched by what they show, so cards taken out far apart leave the ones between alone.
      const keys = shown.map(cardKey);
      if (keys.length !== cardKeys.length || keys.some((k, i) => k !== cardKeys[i])) {
        const want = new Set(keys);
        const kept = new Map();
        for (const el of [...list.children]) {
          if (el._key != null && want.has(el._key) && !kept.has(el._key)) kept.set(el._key, el);
          else el.remove(); // also the empty-state line
        }
        let at0 = list.firstElementChild;
        for (let j = 0; j < keys.length; j++) {
          const el = kept.get(keys[j]);
          if (el === at0 && el) { at0 = at0.nextElementSibling; continue; }
          const c = el || card(shown[j]);
          c._key = keys[j];
          list.insertBefore(c, at0);
        }
      }
      cardKeys = keys;
      if (focusedId && !list.contains(document.activeElement)) list.querySelector(`.pf-card[data-id="${CSS.escape(focusedId)}"] [data-role="${focusedRole}"]`)?.focus({ preventScroll: true });
    }

    /** Everything a card shows: when it is unchanged, the card is kept. */
    function cardKey(s) {
      const ctx = around(s);
      return `${s.id}\u0001${s.kind}\u0001${s.source}\u0001${s.title || ''}\u0001${s.from}\u0001${s.to}\u0001${s.why || ''}\u0001${ctx ? `${ctx.left}\u0002${ctx.right}` : ''}`;
    }

    function emptyText() {
      if (!text.trim()) return 'Repeated words, spacing and common misspellings are marked as you type. Press Check to have the model read every sentence.';
      if (run) return 'Reading your text…';
      if (last && lastText === text) return `No suggestions. ${modelName()} read ${last.checked.sentences === 1 ? 'the sentence' : `all ${fmt(last.checked.sentences)} sentences`} and found nothing to change. It can still miss mistakes.`;
      return 'The instant checks found nothing. Press Check to have the model read every sentence.';
    }

    /** A change of a space or one mark is unreadable on its own: show it between the words around it. */
    function around(s) {
      const tiny = (x) => x.replace(/\s/g, '').length <= 1;
      if (!tiny(s.from) && !tiny(s.to)) return null;
      const left = (text.slice(Math.max(0, s.start - 40), s.start).match(/(\S+\s*)$/) || ['', ''])[1];
      const right = (text.slice(s.end, s.end + 40).match(/^(\s*\S+(?:\s+\S+)?)/) || ['', ''])[1];
      return { left: left.replace(/\s+/g, (m) => (m.length > 1 && !/\n/.test(m) ? m : ' ')), right: right.replace(/\s+/g, ' ') };
    }

    /** The words on either side of a deletion, joined by one space (or none, before a mark). */
    const joinAround = (left, right) => ({ left: left.replace(/\s+$/, ''), gap: /\s$/.test(left) || /^\s/.test(right) ? ' ' : '', right: right.replace(/^\s+/, '') });

    function card(s) {
      const k = KIND[s.kind] || KIND.grammar;
      const id = s.id;
      // A kept card outlives its suggestion object (its offsets move as the writer types), so it acts on the current one.
      const current = () => shown.find((x) => x.id === id);
      const shownFrom = s.from.replace(/\n/g, ' ');
      const del = !s.to.trim() && s.from.trim();
      const fix = s.to.replace(/\n/g, ' ');
      const ctx = around(s);
      // A struck word keeps the spaces next to it outside the strike ("the ~~the~~ results", not "the~~ the~~ results");
      // when only spaces change (an extra space), the spaces are what is struck.
      const core = shownFrom.trim();
      const lead = core && /^\s/.test(shownFrom) ? ' ' : '';
      const trail = core && /\s$/.test(shownFrom) ? ' ' : '';
      const joined = ctx && !fix ? joinAround(ctx.left, ctx.right) : null;
      const say = ctx ? `${ctx.left}${shownFrom}${ctx.right}`.trim() : shownFrom.trim();
      const sayFix = ctx ? (joined ? `${joined.left}${joined.gap}${joined.right}` : `${ctx.left}${fix}${ctx.right}`).trim() : fix.trim();
      return h('li', {
        class: `pf-card ${k.cls}${id === active ? ' on' : ''}`, 'data-id': id,
        onmouseenter: () => setActive(id), onmouseleave: () => { if (!list.contains(document.activeElement)) setActive(null); },
        onfocusin: () => setActive(id),
      },
      h('div', { class: 'pf-card-head' },
        h('span', { class: 'pf-kind' }, k.label),
        h('span', { class: 'pf-src', title: s.source === 'model' ? 'Found by the model' : 'Found by the instant checks, on this computer' }, s.source === 'model' ? 'model' : 'instant'),
        s.title && s.title !== k.label && h('span', { class: 'pf-title' }, s.title)),
      ctx
        ? h('p', { class: 'pf-change pf-in-context' },
          h('span', { class: 'pf-was' }, ctx.left, lead, h('del', { class: 'pf-from' }, core || shownFrom), trail, ctx.right),
          h('span', { class: 'pf-arrow', 'aria-hidden': 'true' }, ' → '),
          h('span', { class: 'pf-now' }, joined ? [joined.left, joined.gap, joined.right] : [ctx.left, fix && h('ins', { class: 'pf-to' }, fix), ctx.right]))
        : h('p', { class: 'pf-change' },
          h('del', { class: 'pf-from' }, core),
          h('span', { class: 'pf-arrow', 'aria-hidden': 'true' }, ' → '),
          del ? h('span', { class: 'pf-to pf-remove' }, 'remove') : h('ins', { class: 'pf-to' }, fix.trim())),
      s.why && h('p', { class: 'pf-why' }, s.why),
      h('div', { class: 'pf-acts' },
        h('button', { type: 'button', class: 'btn small pf-accept', 'data-role': 'accept', 'aria-label': `Accept: change “${say}” to “${del && !ctx ? 'nothing' : sayFix}”`, onclick: () => { const c = current(); if (c) accept(c); } }, 'Accept'),
        h('button', { type: 'button', class: 'btn small quiet', 'data-role': 'dismiss', 'aria-label': `Dismiss the suggestion for “${say}”`, onclick: () => { const c = current(); if (c) dismiss(c); } }, 'Dismiss')));
    }

    function nextAfter(s) {
      const i = shown.findIndex((x) => x.id === s.id);
      return shown[i + 1] || shown[i - 1] || null;
    }

    /** Replace a range of the text box without moving the page; returns nothing. */
    function replaceRange(start, end, to) {
      ta.setRangeText(to, start, end, 'preserve');
    }

    function accept(s) {
      const next = nextAfter(s);
      const before = ta.value;
      if (before.slice(s.start, s.end) !== s.from) { refreshNow(); return; }
      // Focus moves first: taking out the focused card, or focusing once the text box has changed, costs a long rail
      // or a long text an extra layout.
      focusCard(next);
      undo.push({ before, model: model.slice(), after: null });
      redo.length = 0;
      replaceRange(s.start, s.end, s.to);
      undo[undo.length - 1].after = ta.value;
      model = model.filter((x) => x.id !== s.id);
      changed(ta.value);
      redrawEdit();
      focusCard(next); // its card was drawn again (the words around it changed)
    }

    function acceptAll() {
      if (!shown.length) return;
      const before = ta.value;
      let out = before;
      for (const s of [...shown].sort((a, b) => b.start - a.start)) if (out.slice(s.start, s.end) === s.from) out = out.slice(0, s.start) + s.to + out.slice(s.end);
      undo.push({ before, model: model.slice(), after: out });
      redo.length = 0;
      const n = shown.length;
      ta.setRangeText(out, 0, before.length, 'end');
      model = [];
      changed(ta.value);
      redrawEdit();
      if (!root.contains(document.activeElement)) ta.focus({ preventScroll: true }); // the button itself is gone
      toast(`${fmt(n)} change${n === 1 ? '' : 's'} made. Press ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Z in the text to undo.`);
    }

    /** Put back a saved text and its model suggestions; the caret goes to the place that changed. */
    function restore(value, nextModel) {
      const cur = ta.value;
      const ed = editOf(cur, value);
      ta.setRangeText(value.slice(ed.p, ed.oldEnd + ed.delta), ed.p, ed.oldEnd, 'end');
      const moved = editOf(text, ta.value);
      rules = move(rules, moved, ta.value);
      dirty = joinDirty(dirty, moved);
      text = ta.value; // the saved suggestions belong to exactly this text
      model = nextModel;
      redrawEdit();
    }

    function undoLast() {
      const u = undo.pop();
      redo.push({ before: u.before, model: u.model, after: ta.value, modelAfter: model.slice() });
      restore(u.before, u.model);
    }

    function redoLast() {
      const r = redo.pop();
      undo.push({ before: r.before, model: r.model, after: r.after });
      restore(r.after, r.modelAfter);
    }

    function dismiss(s) {
      const next = nextAfter(s);
      dismissed.add(keyOf(s));
      focusCard(next); // before its card goes, as in accept()
      refreshNow();
      focusCard(next);
    }

    function focusCard(s) {
      if (!s) { if (document.activeElement !== ta) ta.focus({ preventScroll: true }); return; }
      const el = list.querySelector(`.pf-card[data-id="${CSS.escape(s.id)}"] [data-role="accept"]`);
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- the model check
    const modelName = () => {
      const c = selected();
      return c.model ? (nameOf ? nameOf(c.model, c.engine) : c.model) : 'The model';
    };

    async function check() {
      if (run || !text.trim() || !modelReady() || text.length > MAX_CHARS) return;
      const sent = text;
      const c = selected();
      run = { abort: new AbortController(), sent, done: 0, total: 0, started: false };
      error = '';
      onBusy(true);
      drawControls();
      refreshNow();
      try {
        const res = await fetch('/api/checks/proofread', {
          method: 'POST', signal: run.abort.signal,
          headers: { 'x-lectern-token': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ text: sent, engine: c.engine, model: c.model, variant }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
        let result = null;
        await readEvents(res, (event, d) => {
          // Parts arriving together are drawn once, on the next frame.
          if (event === 'part') { take(d.suggestions, sent, !run.started); run.started = true; schedule(); } // the first part replaces the last check's suggestions
          else if (event === 'step') { const m = /(\d+) of (\d+)/.exec(d.detail || ''); if (m) { run.done = +m[1]; run.total = +m[2]; } drawStatus(); }
          else if (event === 'notice') { notice = d.text; drawStatus(); }
          else if (event === 'result') result = d;
          else if (event === 'error') throw new Error(d.message);
        });
        if (!result) throw new Error('The check stopped before it finished.');
        take(result.suggestions, sent, true);
        last = result;
        lastText = text === sent ? sent : null;
        if (!root.isConnected) toast('Proofreading finished');
      } catch (e) {
        if (e.name !== 'AbortError') error = e.message || 'The check failed.';
      }
      run = null;
      onBusy(false);
      drawControls();
      refreshNow();
    }

    /**
     * Add the model's suggestions (offsets into `sent`) to the current text. `replace` drops the older ones first.
     * A suggestion that was already listed keeps its id, so its mark and card are not drawn again.
     */
    function take(list0, sent, replace) {
      const ed = sent === text ? null : editOf(sent, text);
      const known = new Map(model.map((s) => [`${s.start}:${s.end}:${s.to}`, s.id]));
      const used = new Set();
      const mapped = [];
      for (const s of list0 || []) {
        const r = through(ed, s.start, s.end);
        if (!r || text.slice(r.start, r.end) !== s.from) continue;
        const key = `${r.start}:${r.end}:${s.to}`;
        const old = known.get(key);
        if (!replace && old) continue; // already listed
        const id = old && !used.has(old) ? old : `m${++seq}`;
        used.add(id);
        mapped.push({ ...s, ...r, source: 'model', id });
      }
      if (replace) model = mapped;
      else model.push(...mapped);
    }

    // ---------------------------------------------------------------- frame pieces
    let checkBtn = null;
    /** Keep the Check button's state in step with the text, without rebuilding the pickers on every key. */
    function updateCheck() {
      if (!checkBtn || run) return;
      const tooLong = text.length > MAX_CHARS;
      const off = !text.trim() || !modelReady() || tooLong;
      if (checkBtn.disabled !== off) checkBtn.disabled = off;
      const title = tooLong ? `Up to ${fmt(MAX_CHARS)} characters at a time` : `Check (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter)`;
      if (checkBtn.title !== title) checkBtn.title = title;
      const label = last && lastText !== text ? 'Check again' : 'Check';
      if (checkBtn.textContent !== label) checkBtn.textContent = label;
    }

    function drawControls() {
      checkBtn = run ? null : h('button', { type: 'button', class: 'btn primary pf-check', 'data-focus': 'run', onclick: check }, 'Check');
      // The model's connection note goes on its own line, so the pickers and Check keep one row.
      const mp = modelPicker();
      const help = mp.querySelector('.chk-model-help');
      if (help) { help.remove(); help.classList.add('pf-help'); }
      const vp = picker({ label: 'Spelling variant', cls: 'pf-variant', options: VARIANTS, value: variant, onChange: (v) => {
        variant = v;
        try { localStorage.setItem('lectern.proofVariant', v); } catch { /* storage unavailable */ }
        last = null; lastText = null; // a different variant is a different check
        refresh();
      } });
      vp.dataset.focus = 'variant';
      // Check and Stop take each other's place, and keyboard focus moves with them.
      keepFocus(controls, () => fill(controls, h('div', { class: 'pf-row' },
        mp,
        h('div', { class: 'pf-run' },
          h('span', { class: 'chk-model-label' }, 'English'),
          vp,
          run ? h('button', { type: 'button', class: 'btn', 'data-focus': 'run', onclick: () => run && run.abort.abort() }, 'Stop') : checkBtn)), help));
      updateCheck();
    }

    let statusKey = null;
    function drawStatus() {
      const bits = [];
      if (run) bits.push(h('span', { class: 'chk-busy', 'aria-hidden': 'true' }), run.total ? `Reading… ${fmt(run.done)} of ${fmt(run.total)} part${run.total === 1 ? '' : 's'}` : 'Reading…');
      else if (error) bits.push(h('span', { class: 'pf-error', role: 'alert' }, error));
      else if (last) {
        const p = last.provenance || {};
        const name = p.reportedModels && p.reportedModels[0] ? (nameOf ? nameOf(p.reportedModels[0], p.engine) : p.reportedModels[0]) : modelName();
        bits.push(`Read by ${name}: ${fmt(last.checked.sentences)} sentence${last.checked.sentences === 1 ? '' : 's'}`,
          last.checked.reused ? ` (${fmt(last.checked.sent)} sent, ${fmt(last.checked.reused)} unchanged since the last check)` : '', '.');
        if (lastText !== text) bits.push(' You have edited the text since.');
        if (last.checked.unchecked && last.checked.unchecked.length) bits.push(h('span', { class: 'pf-warn' }, ` ${fmt(last.checked.unchecked.length)} sentence${last.checked.unchecked.length === 1 ? '' : 's'} could not be read; check again.`));
      } else if (text.trim()) bits.push('Instant checks are on. The model has not read this text yet.');
      if (notice && run) bits.push(h('span', { class: 'pf-warn' }, ` ${notice}`));
      if (text.length > MAX_CHARS) bits.push(h('span', { class: 'pf-warn' }, ` The model reads up to ${fmt(MAX_CHARS)} characters at a time; this text has ${fmt(text.length)}.`));
      // The line is a live region: it is only rewritten when what it says changes, not on every key press.
      const key = bits.map((b) => (typeof b === 'string' ? b : `${b.className}:${b.textContent}`)).join('\u0001');
      if (key === statusKey) return;
      statusKey = key;
      fill(status, bits);
    }

    let statsFor = null;
    function drawStats() {
      if (statsFor === text) return;
      statsFor = text;
      const has = !!text.trim();
      statsWrap.hidden = !has; // the six numbers wait until there is text to count
      if (!has) return;
      const words = wordList(text).length;
      const sentences = text.split(/(?<=[.!?…])["'”’)\]]*\s+|\n{2,}/).map((s) => wordList(s).length).filter((n) => n > 0);
      const longest = sentences.length ? Math.max(...sentences) : 0;
      const avg = sentences.length ? words / sentences.length : 0;
      const minutes = words / WPM;
      const row = (label, value) => [h('dt', null, label), h('dd', null, value)];
      fill(stats,
        row('Words', fmt(words)),
        row('Characters', fmt(text.length)),
        row('Sentences', fmt(sentences.length)),
        row('Average sentence', sentences.length ? `${avg.toFixed(1)} words` : '–'),
        row('Longest sentence', longest ? `${fmt(longest)} words` : '–'),
        row('Reading time', words ? (minutes < 1 ? 'under a minute' : `about ${Math.round(minutes)} min`) : '–'));
    }

    // The top of the sheet changes only with the file and with whether there is any text, so it is not rebuilt on
    // every key (an open More menu stays open while the rail updates).
    let topKey = null;
    function drawTop() {
      const key = `${file ? `${file.name}\u0000${file.kind}` : ''}\u0000${!!text.trim()}`;
      if (key === topKey) return;
      topKey = key;
      sheetTop.classList.toggle('has-text', !!text.trim());
      keepFocus(sheetTop, () => fill(sheetTop,
        file
          ? h('span', { class: 'chk-file' }, h('span', { class: 'chk-file-name' }, file.name), h('span', { class: 'chk-file-kind' }, file.kind))
          : h('span', { class: 'chk-hint' }, 'Paste text or drop a document'),
        h('span', { class: 'pf-top-acts' },
          h('button', { type: 'button', class: 'btn small', 'data-focus': 'choose', title: `${FILE_TYPES}, up to 12 MB`, onclick: () => fileInput.click() }, 'Choose a file'),
          text.trim() && h('button', { type: 'button', class: 'btn small', 'data-focus': 'copy', onclick: () => copyText(text).then((ok) => toast(ok ? 'Text copied' : 'Could not copy the text')) }, 'Copy text'),
          text.trim() && moreMenu([
            { heading: 'Use this text in' },
            { label: 'AI writing', run: () => transfer('ai', text, file) },
            { label: 'Rewrite', run: () => transfer('rewrite', text, file) },
            { label: 'Similarity', run: () => transfer('sim', text, file) },
          ], { small: true, align: 'right' })),
        fileInput));
    }

    /** The limits in one line that keeps its meaning; what it sends, and how accurate it measured, behind the arrow. */
    function limitsBlock() {
      return about('proof', 'A proofreader, not a guarantee: read each suggestion before you accept it.', 'How accurate is it?',
        h('p', null, 'It misses mistakes, and some suggestions are wrong. Quotations, citations, links and code are never changed.'),
        h('p', null, `The instant checks run on this computer. Check sends the text to the selected model through your plan. ${STRICT} Lectern saves nothing.`),
        h('p', null, 'Tested on 300 sentences of public web text that were held back from all tuning (CWEB, Flachs and others, 2020), with Claude Opus 5.5 reading them. 63% of the changes it made matched a human editor’s correction (95% interval 49 to 76%), and it changed 3% of the sentences the editors had left alone. It found 41% of the editors’ corrections.'),
        h('p', null, 'A change that no editor made counts as wrong in that score, even when it is a fair correction, so the true share is likely higher. The instant checks matched an editor 88% of the time (79 to 96%) and changed 2 of 4,335 sentences the editors had left alone. Other models, other kinds of writing and languages other than English were not tested.'));
    }

    async function loadFile(f) {
      const ticket = ++loads; // when two documents are dropped, only the newer one is used
      if (f.size > 12 * 1024 * 1024) { error = 'That file is larger than 12 MB. Paste the text instead.'; drawStatus(); return; }
      error = '';
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const r = await api('POST', '/api/checks/extract', { name: f.name, data: btoa(bin) });
        if (ticket !== loads) return;
        setText(r.text, { name: f.name, kind: r.kind });
      } catch (e) {
        if (ticket !== loads) return;
        error = e.message;
        drawStatus();
      }
    }

    /**
     * Put a new text in the sheet (from another tool or a file). It is always a fresh start, even when the text is the
     * same as before: no model suggestions, no dismissed ones, nothing to undo or redo.
     */
    function setText(next, fromFile = null) {
      if (run) run.abort.abort();
      ta.value = next;
      file = fromFile;
      text = ta.value;
      model = [];
      rules = [];
      dirty = [0, text.length];
      last = null;
      lastText = null;
      undo.length = 0;
      redo.length = 0;
      dismissed.clear();
      active = null;
      notice = '';
      error = '';
      refreshNow();
    }

    let built = false;
    function view() {
      drawControls();
      if (!built) { built = true; refresh(); }
      return root;
    }

    return { view, setText, busy: () => !!run, text: () => text };
  };
  // The arithmetic that keeps marks on their words while the text changes, for test/desk.test.js.
  Object.assign(window.LecternProofread, { editOf, through, move, joinDirty, recheckSpan, recheck });
})();
