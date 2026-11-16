// The Writing desk's proofreader: the writer's text in an editable sheet, with spelling, grammar, punctuation,
// capital-letter and spacing mistakes underlined in place, and a rail of suggestions to accept or dismiss.
//   - Instant checks (shared/proofrules.js) run on every keystroke, on this computer, with no plan usage.
//   - "Check" sends the text to the selected model (server/checks/proofread.js); a second check sends only the
//     sentences that changed. Suggestions keep pointing at the right words while the writer keeps typing.
// The text box is a normal <textarea> lying over a mirror of the same text; the mirror draws the underlines, so the
// caret, selection, undo and spell-check of a real text box all keep working. Built with h() only (text nodes).
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
  const ACCEPT = '.pdf,.docx,.odt,.rtf,.txt,.md,.html,.htm';
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const wordList = (s) => String(s).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];

  /** Where the range [start, end) of `before` sits in `after`, when one stretch of text changed; null if it was touched. */
  function mapRange(before, after, start, end) {
    if (before === after) return { start, end };
    let p = 0;
    const max = Math.min(before.length, after.length);
    while (p < max && before[p] === after[p]) p++;
    let s = 0;
    while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    const oldEnd = before.length - s;
    if (end <= p) return { start, end };
    if (start >= oldEnd) { const d = after.length - before.length; return { start: start + d, end: end + d }; }
    return null;
  }

  window.LecternProofread = function create(deps) {
    const { h, fill, api, toast, TOKEN, picker, modelPicker, selected, modelReady, transfer, onBusy, nameOf } = deps;
    const Rules = window.LecternProofRules;

    let text = '';
    let file = null;
    let model = []; // the model's suggestions, kept in step with the text
    let rules = []; // the instant checks' suggestions for the current text
    let shown = []; // what is underlined and listed now
    const dismissed = new Set();
    let active = null;
    let run = null; // { abort, sent, parts, done, total }
    let last = null; // the last finished check
    let lastText = null; // the text that check read
    let notice = '';
    let error = '';
    const undo = [];
    let variant = 'auto';
    try { variant = localStorage.getItem('lectern.proofVariant') || 'auto'; } catch { /* default */ }
    let seq = 0;

    // ---------------------------------------------------------------- the editor
    const back = h('div', { class: 'pf-back', 'aria-hidden': 'true' });
    const ta = h('textarea', {
      class: 'pf-text', 'aria-label': 'Text to proofread', spellcheck: 'false',
      placeholder: 'Paste or type your writing. Repeated words, spacing and common misspellings are marked as you type; press Check to have the model read every sentence for grammar and punctuation.',
    });
    const edit = h('div', { class: 'pf-edit' }, back, ta);
    const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFile(f); } });
    const sheetTop = h('div', { class: 'chk-sheet-top' });
    const sheet = h('div', { class: 'chk-sheet pf-sheet' }, sheetTop, edit, h('div', { class: 'chk-drop', 'aria-hidden': 'true' }, h('span', null, 'Drop to read the document')));
    const status = h('div', { class: 'pf-status', role: 'status', 'aria-live': 'polite' });
    const list = h('ol', { class: 'pf-list', 'aria-label': 'Suggestions' });
    const railHead = h('div', { class: 'pf-rail-head' });
    const stats = h('dl', { class: 'pf-stats' });
    const rail = h('aside', { class: 'pf-rail', 'aria-label': 'Proofreading suggestions' }, railHead, list, h('div', { class: 'pf-stats-wrap' }, h('h2', { class: 'pf-h' }, 'This text'), stats));
    const controls = h('div', { class: 'pf-controls' });
    const root = h('section', { class: 'pf' },
      h('p', { class: 'chk-lede' }, 'Spelling, grammar and punctuation, marked in place'),
      controls,
      h('div', { class: 'pf-grid' }, h('div', { class: 'pf-main' }, sheet, status, limitsBlock()), rail));

    ta.addEventListener('input', () => changed(ta.value));
    ta.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); check(); return; }
      if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && undo.length && undo[undo.length - 1].after === ta.value) { e.preventDefault(); undoLast(); }
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
      const before = text;
      model = model.map((s) => {
        const r = mapRange(before, next, s.start, s.end);
        return r && next.slice(r.start, r.end) === s.from ? { ...s, ...r } : null;
      }).filter(Boolean);
      text = next;
      if (file && !text.trim()) file = null;
      notice = '';
      schedule();
    }

    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    }

    const keyOf = (s) => `${s.from}\u0000${s.to}\u0000${text.slice(Math.max(0, s.start - 30), s.start)}\u0000${text.slice(s.end, s.end + 30)}`;

    function refresh() {
      rules = Rules ? Rules.check(text).map((s) => ({ ...s, source: 'rule', id: `r${s.start}-${s.end}-${s.rule}` })) : [];
      // The model's suggestions go first (it read the whole sentence); an instant one is kept only where it overlaps none.
      shown = [];
      const free = (s) => !shown.some((t) => s.start < t.end && t.start < s.end);
      for (const s of model) if (!dismissed.has(keyOf(s)) && free(s)) shown.push(s);
      for (const s of rules) if (!dismissed.has(keyOf(s)) && free(s)) shown.push(s);
      shown.sort((a, b) => a.start - b.start);
      if (active && !shown.some((s) => s.id === active)) active = null;
      drawMirror();
      drawRail();
      drawStatus();
      drawTop();
      updateCheck();
    }

    function drawMirror() {
      const parts = [];
      let at0 = 0;
      for (const s of shown) {
        if (s.start > at0) parts.push(text.slice(at0, s.start));
        const k = KIND[s.kind] || KIND.grammar;
        parts.push(h('span', { class: `pf-u ${k.cls}${s.id === active ? ' on' : ''}`, 'data-id': s.id }, text.slice(s.start, Math.max(s.end, s.start + 1)) || ' '));
        at0 = Math.max(s.end, s.start + 1);
      }
      parts.push(text.slice(at0), '​'); // the zero-width space keeps a last empty line its height
      fill(back, parts);
    }

    const at = (pos) => shown.find((s) => pos >= s.start && pos <= s.end) || null;

    function setActive(id, fromText = false) {
      active = id;
      for (const el of back.querySelectorAll('.pf-u')) el.classList.toggle('on', el.dataset.id === id);
      for (const el of list.querySelectorAll('.pf-card')) el.classList.toggle('on', el.dataset.id === id);
      if (id && fromText) {
        const card = list.querySelector(`.pf-card[data-id="${CSS.escape(id)}"]`);
        if (card) { // scroll the rail only, never the page
          const top = card.offsetTop - list.offsetTop;
          if (top < rail.scrollTop || top + card.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = Math.max(0, top - 12);
        }
      }
    }

    // ---------------------------------------------------------------- the rail
    function drawRail() {
      const counts = {};
      for (const s of shown) counts[s.kind] = (counts[s.kind] || 0) + 1;
      fill(railHead,
        h('div', { class: 'pf-total' }, h('span', { class: 'pf-total-n' }, fmt(shown.length)), h('span', null, shown.length === 1 ? 'suggestion' : 'suggestions')),
        shown.length > 0 && h('ul', { class: 'pf-counts' }, ORDER.filter((k) => counts[k]).map((k) => h('li', { class: `pf-count ${KIND[k].cls}` },
          h('span', { class: 'pf-swatch', 'aria-hidden': 'true' }), KIND[k].label, h('span', { class: 'pf-n' }, fmt(counts[k]))))),
        shown.length > 1 && h('button', { type: 'button', class: 'btn small pf-all', onclick: acceptAll }, `Accept all ${fmt(shown.length)}`));
      const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('.pf-card')?.dataset.id : null;
      const focusedRole = focusedId ? document.activeElement.dataset.role : null;
      if (!shown.length) {
        fill(list, h('li', { class: 'pf-empty' }, emptyText()));
        return;
      }
      fill(list, shown.map((s) => card(s)));
      if (focusedId) list.querySelector(`.pf-card[data-id="${CSS.escape(focusedId)}"] [data-role="${focusedRole}"]`)?.focus({ preventScroll: true });
    }

    function emptyText() {
      if (!text.trim()) return 'Suggestions appear here, in the order they come in your text.';
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

    function card(s) {
      const k = KIND[s.kind] || KIND.grammar;
      const shownFrom = s.from.replace(/\n/g, ' ');
      const del = !s.to.trim() && s.from.trim();
      const fix = s.to.replace(/\n/g, ' ');
      const ctx = around(s);
      const say = ctx ? `${ctx.left}${shownFrom}${ctx.right}`.trim() : shownFrom.trim();
      const sayFix = ctx ? `${ctx.left}${fix}${ctx.right}`.trim() : fix.trim();
      return h('li', {
        class: `pf-card ${k.cls}${s.id === active ? ' on' : ''}`, 'data-id': s.id,
        onmouseenter: () => setActive(s.id), onmouseleave: () => { if (!list.contains(document.activeElement)) setActive(null); },
        onfocusin: () => setActive(s.id),
      },
      h('div', { class: 'pf-card-head' },
        h('span', { class: 'pf-kind' }, k.label),
        h('span', { class: 'pf-src', title: s.source === 'model' ? 'Found by the model' : 'Found by the instant checks, on this computer' }, s.source === 'model' ? 'model' : 'instant'),
        s.title && s.title !== k.label && h('span', { class: 'pf-title' }, s.title)),
      ctx
        ? h('p', { class: 'pf-change pf-in-context' },
          h('span', { class: 'pf-was' }, ctx.left, h('del', { class: 'pf-from' }, shownFrom), ctx.right),
          h('span', { class: 'pf-arrow', 'aria-hidden': 'true' }, ' → '),
          h('span', { class: 'pf-now' }, ctx.left, fix && h('ins', { class: 'pf-to' }, fix), ctx.right))
        : h('p', { class: 'pf-change' },
          h('del', { class: 'pf-from' }, shownFrom.trim()),
          h('span', { class: 'pf-arrow', 'aria-hidden': 'true' }, ' → '),
          del ? h('span', { class: 'pf-to pf-remove' }, 'remove') : h('ins', { class: 'pf-to' }, fix.trim())),
      s.why && h('p', { class: 'pf-why' }, s.why),
      h('div', { class: 'pf-acts' },
        h('button', { type: 'button', class: 'btn small pf-accept', 'data-role': 'accept', 'aria-label': `Accept: change “${say}” to “${del && !ctx ? 'nothing' : sayFix}”`, onclick: () => accept(s) }, 'Accept'),
        h('button', { type: 'button', class: 'btn small quiet', 'data-role': 'dismiss', 'aria-label': `Dismiss the suggestion for “${say}”`, onclick: () => dismiss(s) }, 'Dismiss')));
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
      if (before.slice(s.start, s.end) !== s.from) { refresh(); return; }
      undo.push({ before, model: model.slice(), after: null });
      replaceRange(s.start, s.end, s.to);
      undo[undo.length - 1].after = ta.value;
      model = model.filter((x) => x.id !== s.id);
      changed(ta.value);
      refreshNow();
      focusCard(next);
    }

    function acceptAll() {
      if (!shown.length) return;
      const before = ta.value;
      let out = before;
      for (const s of [...shown].sort((a, b) => b.start - a.start)) if (out.slice(s.start, s.end) === s.from) out = out.slice(0, s.start) + s.to + out.slice(s.end);
      undo.push({ before, model: model.slice(), after: out });
      const n = shown.length;
      ta.setRangeText(out, 0, before.length, 'end');
      model = [];
      changed(ta.value);
      refreshNow();
      toast(`${fmt(n)} change${n === 1 ? '' : 's'} made. Press ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Z in the text to undo.`);
    }

    function undoLast() {
      const u = undo.pop();
      ta.setRangeText(u.before, 0, ta.value.length, 'end');
      text = ta.value; // the saved suggestions belong to exactly this text
      model = u.model;
      refreshNow();
    }

    function dismiss(s) {
      const next = nextAfter(s);
      dismissed.add(keyOf(s));
      refreshNow();
      focusCard(next);
    }

    function refreshNow() { if (frame) { cancelAnimationFrame(frame); frame = 0; } refresh(); }

    function focusCard(s) {
      if (!s) { ta.focus({ preventScroll: true }); return; }
      const el = list.querySelector(`.pf-card[data-id="${CSS.escape(s.id)}"] [data-role="accept"]`);
      if (el) el.focus({ preventScroll: true });
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
      refresh();
      try {
        const res = await fetch('/api/checks/proofread', {
          method: 'POST', signal: run.abort.signal,
          headers: { 'x-lectern-token': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ text: sent, engine: c.engine, model: c.model, variant }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let result = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, k);
            buf = buf.slice(k + 2);
            const ev = /^event: (.*)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (!ev || !data) continue;
            const d = JSON.parse(data[1]);
            if (ev[1] === 'part') { take(d.suggestions, sent, !run.started); run.started = true; } // the first part replaces the last check's suggestions
            else if (ev[1] === 'step') { const m = /(\d+) of (\d+)/.exec(d.detail || ''); if (m) { run.done = +m[1]; run.total = +m[2]; } drawStatus(); }
            else if (ev[1] === 'notice') { notice = d.text; drawStatus(); }
            else if (ev[1] === 'result') result = d;
            else if (ev[1] === 'error') throw new Error(d.message);
          }
        }
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
      refresh();
    }

    /** Add the model's suggestions (offsets into `sent`) to the current text. `replace` drops the older ones first. */
    function take(list0, sent, replace) {
      const mapped = [];
      for (const s of list0 || []) {
        const r = mapRange(sent, text, s.start, s.end);
        if (!r || text.slice(r.start, r.end) !== s.from) continue;
        mapped.push({ ...s, ...r, source: 'model', id: `m${++seq}` });
      }
      if (replace) model = mapped;
      else model.push(...mapped.filter((s) => !model.some((t) => t.start === s.start && t.end === s.end && t.to === s.to)));
      refresh();
    }

    // ---------------------------------------------------------------- frame pieces
    let checkBtn = null;
    /** Keep the Check button's state in step with the text, without rebuilding the pickers on every key. */
    function updateCheck() {
      if (!checkBtn || run) return;
      const tooLong = text.length > MAX_CHARS;
      checkBtn.disabled = !text.trim() || !modelReady() || tooLong;
      checkBtn.title = tooLong ? `Up to ${fmt(MAX_CHARS)} characters at a time` : `Check (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter)`;
      checkBtn.textContent = last && lastText !== text ? 'Check again' : 'Check';
    }

    function drawControls() {
      checkBtn = run ? null : h('button', { type: 'button', class: 'btn primary pf-check', onclick: check }, 'Check');
      // The model's connection note goes on its own line, so the pickers and Check keep one row.
      const mp = modelPicker();
      const help = mp.querySelector('.chk-model-help');
      if (help) { help.remove(); help.classList.add('pf-help'); }
      fill(controls, h('div', { class: 'pf-row' },
        mp,
        h('div', { class: 'pf-run' },
          h('span', { class: 'chk-model-label' }, 'English'),
          picker({ label: 'Spelling variant', cls: 'pf-variant', options: VARIANTS, value: variant, onChange: (v) => {
            variant = v;
            try { localStorage.setItem('lectern.proofVariant', v); } catch { /* storage unavailable */ }
            last = null; lastText = null; // a different variant is a different check
            refresh();
          } }),
          run ? h('button', { type: 'button', class: 'btn', onclick: () => run && run.abort.abort() }, 'Stop') : checkBtn)), help);
      updateCheck();
    }

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
      fill(status, bits);
      drawStats();
    }

    function drawStats() {
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

    function drawTop() {
      fill(sheetTop,
        file
          ? h('span', { class: 'chk-file' }, h('span', { class: 'chk-file-name' }, file.name), h('span', { class: 'chk-file-kind' }, file.kind))
          : h('span', { class: 'chk-hint' }, 'Paste text or drop a document'),
        h('span', { class: 'pf-top-acts' },
          h('button', { type: 'button', class: 'btn small', onclick: () => fileInput.click() }, 'Choose a file'),
          text.trim() && h('button', { type: 'button', class: 'btn small', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Text copied'), () => toast('Could not copy the text')) }, 'Copy text'),
          text.trim() && h('button', { type: 'button', class: 'btn small', onclick: () => transfer('ai', text, file) }, 'AI writing'),
          text.trim() && h('button', { type: 'button', class: 'btn small', onclick: () => transfer('sim', text, file) }, 'Similarity')),
        fileInput);
    }

    function limitsBlock() {
      return h('div', { class: 'pf-limits' },
        h('p', { class: 'chk-limits' }, 'A proofreader, not a guarantee: it misses mistakes and some suggestions are wrong. Read each one before you accept it. Quotations, citations, links and code are never changed.'),
        h('details', { class: 'pf-acc' },
          h('summary', null, 'How accurate is it?'),
          h('p', null, 'Tested on 300 sentences of public web text that were held back from all tuning (CWEB, Flachs and others, 2020), with Claude Opus 5.5 reading them. 63% of the changes it made matched a human editor’s correction (95% interval 49 to 76%), and it changed 3% of the sentences the editors had left alone. It found 41% of the editors’ corrections.'),
          h('p', null, 'A change that no editor made counts as wrong in that score, even when it is a fair correction, so the true share is likely higher. The instant checks matched an editor 88% of the time (79 to 96%) and changed 2 of 4,335 sentences the editors had left alone. Other models, other kinds of writing and languages other than English were not tested.')));
    }

    async function loadFile(f) {
      if (f.size > 12 * 1024 * 1024) { error = 'That file is larger than 12 MB. Paste the text instead.'; drawStatus(); return; }
      error = '';
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const r = await api('POST', '/api/checks/extract', { name: f.name, data: btoa(bin) });
        setText(r.text, { name: f.name, kind: r.kind });
      } catch (e) {
        error = e.message;
        drawStatus();
      }
    }

    /** Put a new text in the sheet (from another tool or a file). */
    function setText(next, fromFile = null) {
      if (run) run.abort.abort();
      ta.value = next;
      file = fromFile;
      model = [];
      last = null;
      lastText = null;
      undo.length = 0;
      changed(ta.value);
      if (!ta.value) refreshNow();
    }

    let built = false;
    function view() {
      drawControls();
      if (!built) { built = true; refresh(); }
      return root;
    }

    return { view, setText, busy: () => !!run, text: () => text };
  };
})();
