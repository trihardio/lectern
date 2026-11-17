// The Writing desk (formerly "AI score"): four separate tools on one page.
//   Proofread   - spelling, grammar and punctuation marked in place, with suggestions to accept or dismiss
//                 (ui/proofread.js; instant checks from shared/proofrules.js, the model from server/checks/proofread.js).
//   AI writing  - a writing-pattern review: which sentences the selected model rates as showing generic,
//                 AI-like writing patterns, with the reasons, what was and was not reviewed, and writing
//                 suggestions anchored to the sentence they quote. Not an authorship verdict.
//   Similarity  - which passages match sources Lectern could find and read (paper abstracts, the
//                 Library, public web pages), with each source and the matching words side by side.
// Everything is built with h() (text nodes only); nothing here uses innerHTML.
(function () {
  'use strict';

  // The documents every tool on the desk reads (server/checks/extract.js), in one wording wherever they are named.
  const ACCEPT = '.pdf,.docx,.odt,.rtf,.html,.htm,.md,.txt';
  const FILE_TYPES = 'PDF, Word (.docx), OpenDocument (.odt), RTF, web page (.html), Markdown (.md) or text (.txt)';
  const MAX_WORDS = 20000; // the AI-writing and similarity checks read at most this many words (server/checks/text.js)
  const TONES = 8;
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const countWords = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

  /**
   * Read a server-sent event stream and call onEvent(event, data) for each event. Tolerant in the same ways as
   * readEvents in ui/app.js: "event:" and "data:" with or without a space, several data lines, CRLF line ends, and an
   * event whose data is not JSON is skipped rather than ending the read. An error thrown by onEvent ends the read and
   * is passed on. The stream is always cancelled when the read ends, so the server stops working on a request nobody
   * is reading any more. Used by every tool on the Writing desk (the proofreader gets it through its deps).
   */
  async function readEvents(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const dispatch = (block) => {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      let parsed;
      try { parsed = JSON.parse(data.join('\n')); } catch (e) { console.error('Skipped an event that is not JSON', e); return; }
      onEvent(event, parsed);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let end;
        while ((end = /\r?\n\r?\n/.exec(buf))) {
          const block = buf.slice(0, end.index);
          buf = buf.slice(end.index + end[0].length);
          dispatch(block);
        }
      }
    } finally {
      reader.cancel().catch(() => { /* already closed or failed */ });
    }
  }
  window.LecternSSE = { read: readEvents };

  /**
   * Copy plain text. The Clipboard API is missing or refused in some windows (no permission, an insecure address),
   * so a hidden text box and the copy command are tried next. Resolves true when the text was copied.
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* try the copy command */ }
    const before = document.activeElement;
    const box = document.createElement('textarea');
    box.className = 'chk-copy-buffer';
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('tabindex', '-1');
    box.setAttribute('readonly', '');
    box.value = text;
    document.body.append(box);
    let ok = false;
    try {
      box.focus({ preventScroll: true });
      box.select();
      ok = document.execCommand('copy');
    } catch { ok = false; }
    box.remove();
    if (before && before !== document.body && before.isConnected && before.focus) before.focus({ preventScroll: true });
    return ok;
  }

  // Each tool's fine print: `say` is one short line that is always shown and carries the meaning on its own; `more`
  // waits behind a small arrow (about() below). Similarity also keeps its full `limits`, which its report and PDF repeat.
  const TOOLS = {
    proof: {
      label: 'Proofread',
      title: 'Spelling, grammar and punctuation, marked in place',
      run: 'Check',
      min: 1,
      steps: [],
    },
    ai: {
      label: 'AI writing',
      title: 'Which sentences show AI-like writing patterns?',
      run: 'Review writing patterns',
      min: 40,
      steps: [['signals', 'Measure the writing signals'], ['model', 'Review it sentence by sentence']],
      say: 'A writing-pattern review, not a validated AI detector. Do not use it as evidence against a writer.',
      more: 'Its numbers are not probabilities that a person or a model wrote the text. Formal or carefully edited human writing can show these patterns, and short texts, edited texts and writing by non-native English speakers are judged least reliably.',
    },
    rewrite: {
      label: 'Rewrite',
      title: 'Rewrite for clarity and a more natural voice',
      run: 'Rewrite text',
      min: 1,
      steps: [['rewrite', 'Rewrite the passage']],
      say: 'Review the rewrite against your original: a model can change meaning or introduce errors.',
      more: 'Keep citations for borrowed ideas, even when rephrased. Lower scores are not guaranteed; the writing-pattern review is not a validated AI detector, and similarity checks cannot search every source.',
    },
    sim: {
      label: 'Similarity',
      title: 'Does this match text that already exists?',
      run: 'Check similarity',
      min: 25,
      steps: [['prepare', 'Pick distinctive passages'], ['papers', 'Search the paper databases'], ['web', 'Search the web and read pages'], ['compare', 'Compare word by word']],
      say: 'A low score is not a clearance: Lectern cannot search every source.',
      more: 'Distinctive phrases from your text are sent as searches to the paper databases and, with web search on, to your model’s web search. Lectern itself keeps nothing.',
      limits: 'Compares your text with paper abstracts, your Library and public web pages Lectern can find and read. It cannot see other students’ work, paywalled full texts or pages behind a sign-in, so a low score is not a clearance.',
    },
  };
  const STRICT = 'If the selected model is unavailable, the request stops instead of switching to another one.';

  window.LecternChecks = function create(deps) {
    const { h, fill, api, toast, Motion, TOKEN, picker, state, prettyModel } = deps;
    const fresh = () => ({ text: '', file: null, phase: 'input', steps: {}, notices: [], result: null, error: '', abort: null, pick: null, tab: 'flags', source: null, extracting: false,
      options: { web: true, papers: true, quotes: true, references: true } });
    const st = { tool: 'proof', proof: fresh(), ai: fresh(), sim: fresh(), rewrite: fresh() };
    // The page's model: the one the writer picked here (remembered), or else the model the composer uses.
    let savedChoice = null;
    try { savedChoice = localStorage.getItem('lectern.aiScoreModel'); } catch { /* use the composer's model */ }
    // Model menu in sections: one per provider, with ChatGPT's earlier generations in a section of their own.
    // Names read as people say them ("Opus 5.5", "GPT-6.1 Sol"); the provider is the section heading, not repeated.
    const EARLIER = /^gpt-5|^gpt-6-sol$/;
    const nameOf = (id, engine) => {
      const name = prettyModel ? prettyModel(id, engine) : id;
      return engine === 'claude-code' ? name.replace(/^Claude\s+/, '') : name;
    };
    function choices() {
      return (state.app?.engines || []).flatMap((e) => {
        const ids = new Set([...(e.models || []), state.app.settings.models[e.id]]);
        if (e.id === 'codex') ids.add('gpt-6.1-sol');
        const note = e.ready ? '' : 'not connected';
        return [...ids].filter((id) => typeof id === 'string' && id.length > 0)
          .map((id) => ({ id, older: e.id === 'codex' && EARLIER.test(id) }))
          .sort((a, b) => a.older - b.older)
          .map(({ id, older }) => ({
            value: `${e.id}|${id}`, label: nameOf(id, e.id), engineLabel: e.label,
            group: older ? `${e.label} · earlier models` : e.label, groupNote: note,
          }));
      });
    }
    /**
     * With nothing picked on this page, it uses the composer's engine and model (a Claude-only writer starts on Claude,
     * not on a ChatGPT model they cannot run). A model the menu does not offer falls back to the engine's first one.
     */
    function defaultChoice() {
      const app = state.app || {};
      const engines = app.engines || [];
      const ready = (id) => !!id && engines.some((e) => e.id === id && e.ready);
      const opts = choices();
      const engine = [state.compose && state.compose.engine, app.activeEngine].find(ready) || (engines.find((e) => e.ready) || {}).id;
      if (engine) {
        const models = [state.compose && state.compose.engine === engine ? state.compose.model : '', app.settings && app.settings.models && app.settings.models[engine]];
        for (const m of models) if (m && opts.some((o) => o.value === `${engine}|${m}`)) return `${engine}|${m}`;
        const first = opts.find((o) => o.value.startsWith(`${engine}|`));
        if (first) return first.value;
      }
      return opts.length ? opts[0].value : 'codex|gpt-6.1-sol';
    }
    const currentChoice = () => savedChoice || defaultChoice();
    function selected() {
      const [engine, ...rest] = currentChoice().split('|');
      return { engine, model: rest.join('|') };
    }
    // The chosen model is never swapped for another one behind the user's back: when it is no longer offered,
    // it stays chosen, the page says so, and the check cannot start until the user picks a model.
    function modelPicker() {
      let opts = choices();
      const aiChoice = currentChoice();
      const choice = selected();
      const known = opts.some((o) => o.value === aiChoice);
      if (!known) opts = [{ value: aiChoice, label: `${choice.model || 'default'} (not available)`, engineLabel: '', group: 'No longer offered' }, ...opts];
      const ready = known && (state.app.engines || []).find((e) => e.id === choice.engine)?.ready;
      const pick = picker({ label: st.tool === 'rewrite' ? 'Rewrite model' : st.tool === 'proof' ? 'Proofreading model' : st.tool === 'sim' ? 'Web search model' : 'AI writing review model', options: opts, value: aiChoice, cls: 'chk-model-picker',
        face: (o) => [o.engineLabel && h('span', { class: 'chk-model-engine' }, o.engineLabel), h('span', { class: 'picker-value' }, o.label)],
        onChange: (value) => {
          savedChoice = value;
          try { localStorage.setItem('lectern.aiScoreModel', value); } catch { /* storage unavailable */ }
          draw();
        } });
      pick.dataset.focus = 'model';
      return h('div', { class: 'chk-model' },
        h('span', { class: 'chk-model-label' }, st.tool === 'rewrite' ? 'Rewrite model' : st.tool === 'proof' ? 'Proofreading model' : st.tool === 'sim' ? 'Web search model' : 'Review model'),
        pick,
        // Only a problem is spelled out here; that the run uses your plan and never switches models is in the fine print.
        !ready && h('span', { class: 'chk-model-help', role: 'status' }, !known
          ? `This model is no longer offered. Choose another one to ${st.tool === 'sim' ? 'search the web' : 'run the check'}.`
          : `This provider is not connected. Connect it in Settings or choose another model${st.tool === 'sim' ? ' to search the web' : ''}.`));
    }
    // The proofreader keeps its own text, marks and undo history; it is made once and moved back in on each draw.
    let proof = null;
    function proofreader() {
      if (!proof && window.LecternProofread) {
        proof = window.LecternProofread({
          h, fill, api, toast, TOKEN, picker, nameOf, about, moreMenu, STRICT, modelPicker: () => modelPicker(), selected, modelReady: () => modelReady(),
          readEvents, copyText, keepFocus, ACCEPT, FILE_TYPES,
          transfer: (id, text, file) => transfer(id, text, file),
          onBusy: (busy) => { st.proof.phase = busy ? 'running' : 'input'; swapSwitch(); },
        });
      }
      return proof;
    }
    const modelReady = () => {
      const choice = selected();
      return choices().some((o) => o.value === currentChoice()) && (state.app.engines || []).some((e) => e.id === choice.engine && e.ready);
    };
    const root = h('section', { class: 'view score checks' });
    let built = false;

    // ---------------------------------------------------------------- keyboard focus across redraws
    // The page is rebuilt when the tool, the phase or a tab changes. Controls that survive a rebuild carry a
    // data-focus key, so focus comes back to the same control (or its stand-in: Run and Stop share "run"); when it has
    // no stand-in, focus goes to the view's data-focus-default (the text box, Stop, or the result). Never scrolls.
    const FOCUSABLE = 'button, textarea, input, a[href], summary, [tabindex]';
    /** The data-focus key of the control with focus inside `scope`, '' for one without a key, null when focus is elsewhere. */
    function focusedKey(scope) {
      const a = document.activeElement;
      if (!a || a === document.body || !scope.isConnected || !scope.contains(a)) return null;
      const holder = a.closest('[data-focus]');
      return holder && scope.contains(holder) ? holder.dataset.focus : '';
    }
    function focusKey(scope, key) {
      const el = (key && scope.querySelector(`[data-focus="${CSS.escape(key)}"]`)) || scope.querySelector('[data-focus-default]');
      const target = el && (el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE));
      if (target && !target.disabled) target.focus({ preventScroll: true });
    }
    /** Redraw part of the page, then give focus back to the control that had it (or `want`). */
    function keepFocus(scope, redraw, want = null) {
      const had = want != null ? want : focusedKey(scope);
      redraw();
      if (had != null) focusKey(scope, had);
    }
    /** The tool switch again (a running dot or a score changed), keeping focus on it. */
    function swapSwitch() {
      const head = root.querySelector('.chk-head');
      const sw = head && head.querySelector('.chk-switch');
      if (sw) keepFocus(head, () => sw.replaceWith(toolSwitch()));
    }
    /** Arrow keys, Home and End in a row of choices (the tool switch, the report tabs) move to a choice and pick it. */
    function arrowKeys(e, ids, current, pick, upDown) {
      const step = { ArrowRight: 1, ArrowLeft: -1, ...(upDown ? { ArrowDown: 1, ArrowUp: -1 } : {}) }[e.key];
      let i = ids.indexOf(current);
      if (step) i = (i + step + ids.length) % ids.length;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      else return;
      e.preventDefault();
      pick(ids[i]);
    }

    // ---------------------------------------------------------------- shared pieces: fine print and the More menu

    /**
     * Fine print in one style for every tool: `say` is always shown and carries the meaning on its own; the rest
     * sits behind a small arrow. `key` keeps a fold open across redraws (picking a sentence, switching a tab).
     */
    const folds = {};
    function about(key, say, handle, ...body) {
      return h('details', { class: 'chk-about', open: folds[key] || null, ontoggle: (e) => { folds[key] = e.currentTarget.open; } },
        h('summary', null, h('span', { class: 'chk-about-say' }, say), ' ', h('span', { class: 'chk-about-more' }, handle)),
        h('div', { class: 'chk-about-body' }, body));
    }

    /**
     * The less frequent actions of a report, in Lectern's own menu (never a system menu).
     * `items`: [{ label, run }] and [{ heading }]. Arrow keys, Home and End move; Escape closes; a click outside closes.
     * `align`: the button edge the menu lines up with ('left' in a row of buttons, 'right' at the end of a sheet);
     * it takes the other side when there is no room. Opening it never scrolls the page.
     */
    function moreMenu(items, { small = false, align = 'left' } = {}) {
      const btn = h('button', { type: 'button', class: `btn${small ? ' small' : ''} chk-more-btn`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More actions', 'data-focus': 'more' }, 'More');
      const wrap = h('div', { class: 'chk-more' }, btn);
      let menu = null;
      const onDocDown = (e) => { if (!wrap.contains(e.target)) close(false); };
      function close(refocus) {
        if (!menu) return;
        const m = menu;
        menu = null;
        document.removeEventListener('mousedown', onDocDown, true);
        btn.setAttribute('aria-expanded', 'false');
        Motion.leave(m, 160);
        if (refocus) btn.focus({ preventScroll: true });
      }
      function open() {
        if (menu) { close(true); return; }
        menu = h('div', {
          class: 'cmenu chk-more-menu', role: 'menu', 'aria-label': 'More actions',
          onkeydown: (e) => {
            const rows = [...menu.querySelectorAll('[role="menuitem"]')];
            const at = rows.indexOf(document.activeElement);
            const go = (i) => { e.preventDefault(); rows[(i + rows.length) % rows.length].focus({ preventScroll: true }); };
            if (e.key === 'ArrowDown') go(at + 1);
            else if (e.key === 'ArrowUp') go(at < 0 ? rows.length - 1 : at - 1);
            else if (e.key === 'Home') go(0);
            else if (e.key === 'End') go(rows.length - 1);
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
            else if (e.key === 'Tab') close(false);
          },
        }, items.map((it) => (it.heading
          ? h('div', { class: 'cmenu-head', role: 'presentation' }, it.heading)
          : h('button', { type: 'button', class: 'cmenu-row', role: 'menuitem', tabindex: '-1', onclick: () => { close(true); it.run(); } }, it.label))));
        wrap.append(menu);
        const b = wrap.getBoundingClientRect();
        const w = menu.offsetWidth;
        const hgt = menu.offsetHeight;
        const fits = { left: b.left + w <= window.innerWidth - 8, right: b.right - w >= 8 };
        menu.classList.add(fits[align] || !fits[align === 'left' ? 'right' : 'left'] ? align : align === 'left' ? 'right' : 'left');
        if (window.innerHeight - b.bottom < hgt + 12 && b.top > hgt + 12) menu.classList.add('up');
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDocDown, true);
        menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
      }
      btn.addEventListener('click', open);
      btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); open(); } });
      return wrap;
    }

    const cur = () => st[st.tool];

    // ---------------------------------------------------------------- page frame

    function view() {
      if (!built) { draw(); built = true; }
      return root;
    }

    let drawnKey = '';
    /** Rebuild the page. Keyboard focus returns to the same control (`focus` names another one, by its data-focus key). */
    function draw({ focus = null } = {}) {
      const had = focus != null ? focus : focusedKey(root); // read first: building the proofreader's view moves its controls
      const t = cur();
      const key = `${st.tool}:${t.phase}`;
      const changed = built && key !== drawnKey;
      drawnKey = key;
      const oldSlip = root.querySelector('.chk-slip');
      const slipTop = !changed && oldSlip ? oldSlip.scrollTop : 0;
      fill(root,
        h('header', { class: 'chk-head' },
          h('h1', null, 'Writing desk'),
          toolSwitch()),
        h('div', { class: `chk-body${changed ? ' chk-enter' : ''}` }, st.tool === 'proof' && proofreader() ? proofreader().view() : t.phase === 'report' && t.result ? report() : t.phase === 'running' ? running() : input()));
      const slip = root.querySelector('.chk-slip');
      if (slip && slipTop) slip.scrollTop = slipTop;
      if (had != null) focusKey(root, had);
    }

    /** The four tools: a radio group with one tab stop; the arrow keys, Home and End move to a tool and open it. */
    function toolSwitch() {
      const ids = Object.keys(TOOLS);
      const pick = (id) => { if (st.tool !== id) { st.tool = id; draw({ focus: `tool:${id}` }); } };
      const group = h('div', { class: 'chk-switch', role: 'radiogroup', 'aria-label': 'Which check', onkeydown: (e) => arrowKeys(e, ids, st.tool, pick, true) },
        ids.map((id) => h('button', {
          type: 'button', role: 'radio', class: 'chk-tool', 'aria-checked': String(st.tool === id), tabindex: st.tool === id ? '0' : '-1', 'data-focus': `tool:${id}`,
          onclick: () => pick(id),
        }, TOOLS[id].label, st[id].phase === 'running' && h('span', { class: 'chk-busy', 'aria-label': 'running' }),
        id !== 'rewrite' && id !== 'proof' && st[id].phase === 'report' && st[id].result && h('span', { class: 'chk-tool-score' }, scoreText(id)))));
      return Motion.slide(group, 'checks-tool');
    }

    const scoreText = (id) => {
      const r = st[id].result;
      if (!r) return '';
      return r.score == null ? '–' : `${r.score}%`;
    };

    // ---------------------------------------------------------------- input

    function input() {
      const t = cur();
      const tool = TOOLS[st.tool];
      const count = h('span', { class: 'chk-count' }, `${fmt(countWords(t.text))} words`);
      const runBtn = h('button', { type: 'button', class: 'btn primary chk-run', 'data-focus': 'run', onclick: start }, tool.run);
      // The word cap is said beside the count before the run, not only in the report after it.
      const capped = st.tool === 'ai' || st.tool === 'sim';
      const ready = () => {
        const n = countWords(t.text);
        runBtn.disabled = n < tool.min || t.extracting || (st.tool !== 'sim' && !modelReady()) || (st.tool === 'rewrite' && t.text.length > 12000);
        count.textContent = `${fmt(n)} words${n && n < tool.min ? ` · at least ${tool.min} needed` : ''}${capped && n > MAX_WORDS ? ` · only the first ${fmt(MAX_WORDS)} words are checked` : ''}${st.tool === 'rewrite' ? ` · ${fmt(t.text.length)} / 12,000 characters` : ''}`;
      };
      const area = h('textarea', {
        class: 'chk-text', 'aria-label': 'Text to check', spellcheck: 'false', 'data-focus': 'text', 'data-focus-default': '',
        placeholder: `Paste your text here, or drop a ${FILE_TYPES} file anywhere on this sheet.`,
        oninput: (e) => { t.text = e.target.value; if (t.file && !t.text.trim()) t.file = null; ready(); },
        onkeydown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !runBtn.disabled) { e.preventDefault(); start(); } },
      });
      area.value = t.text;
      const picker = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFile(f); } });
      const sheet = h('div', {
        class: `chk-sheet${t.extracting ? ' is-reading' : ''}`,
        ondragenter: (e) => { if (hasFiles(e)) { e.preventDefault(); sheet.classList.add('is-drag'); } },
        ondragover: (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; sheet.classList.add('is-drag'); } },
        ondragleave: (e) => { if (!sheet.contains(e.relatedTarget)) sheet.classList.remove('is-drag'); },
        ondrop: (e) => { if (!hasFiles(e)) return; e.preventDefault(); sheet.classList.remove('is-drag'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); },
      },
      h('div', { class: 'chk-sheet-top' },
        t.file
          ? h('span', { class: 'chk-file' }, h('span', { class: 'chk-file-name' }, t.file.name), h('span', { class: 'chk-file-kind' }, t.file.kind),
            h('button', { type: 'button', class: 'chk-link', onclick: () => { t.file = null; t.text = ''; draw(); } }, 'Remove'))
          : h('span', { class: 'chk-hint' }, t.extracting ? 'Reading the document…' : 'Paste text or drop a document'),
        // Not disabled while a document is read (that would drop keyboard focus); a newer file replaces the older one.
        h('button', { type: 'button', class: 'btn small', 'data-focus': 'choose', title: `${FILE_TYPES}, up to 12 MB`, onclick: () => picker.click() }, 'Choose a file'), picker),
      area,
      h('div', { class: 'chk-drop', 'aria-hidden': 'true' }, h('span', null, 'Drop to read the document')));
      requestAnimationFrame(ready);

      return h('div', { class: 'chk-input' },
        h('p', { class: 'chk-lede' }, tool.title),
        modelPicker(),
        sheet,
        t.error && h('p', { class: 'chk-error', role: 'alert' }, t.error),
        st.tool === 'sim' && simOptions(t),
        h('div', { class: 'chk-actions' }, runBtn, count,
          h('span', { class: 'chk-who' }, whoLine())),
        tool.say && about(`input-${st.tool}`, tool.say, 'Limits',
          st.tool === 'sim' && h('p', null, tool.limits),
          h('p', null, tool.more),
          h('p', null, STRICT)));
    }

    // Web search runs through the page's selected model (strictly, as the other tools do), so when that model cannot
    // be used the switch is off and cannot be turned on; the paper databases and the Library still work.
    const webReady = () => modelReady();
    /** The similarity options as sent: web search only when the selected model can do it. */
    const simSend = (t) => ({ ...t.options, web: !!t.options.web && webReady() });

    function whoLine() {
      if (st.tool !== 'sim') return `Your text is sent to the selected model through your plan${st.tool === 'ai' ? ', in parts' : ''}. Lectern saves nothing.`;
      if (webReady()) { const c = selected(); return `Paper databases, your Library, and the web through ${prettyModel ? prettyModel(c.model, c.engine) : c.model}. Nothing is saved.`; }
      return (state.app?.engines || []).some((e) => e.ready) ? 'The selected model is not connected: paper databases and Library only.' : 'No model connected: paper databases and Library only.';
    }

    /** What to compare: one line that says what is on, and the four switches behind a small arrow. */
    function simOptions(t) {
      const said = h('span', { class: 'chk-about-say' });
      const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
      const say = () => {
        const o = simSend(t);
        const from = [...(o.papers ? ['paper databases', 'your Library'] : []), ...(o.web ? ['the web'] : [])];
        const out = [o.quotes && 'quotations', o.references && 'the reference list'].filter(Boolean);
        said.textContent = `${from.length ? `Compares with ${list(from)}` : 'Nothing is chosen to compare with'}${out.length ? `; leaves out ${list(out)}` : ''}.`;
      };
      const sw = (key, label, help, off = false) => h('label', { class: `filter-switch chk-opt${off ? ' is-off' : ''}` },
        h('span', null, h('span', { class: 'chk-opt-name' }, label), h('span', { class: 'chk-opt-help' }, help)),
        h('input', { type: 'checkbox', role: 'switch', checked: !off && t.options[key], disabled: off, 'data-focus': `opt:${key}`, onchange: (e) => { t.options[key] = e.target.checked; say(); } }));
      say();
      const web = webReady();
      return h('details', { class: 'chk-about chk-opts-fold', open: folds['sim-options'] || null, ontoggle: (e) => { folds['sim-options'] = e.currentTarget.open; } },
        h('summary', null, said, ' ', h('span', { class: 'chk-about-more' }, 'Change')),
        h('fieldset', { class: 'chk-opts' }, h('legend', null, 'What to compare'),
          sw('papers', 'Paper databases and Library', 'Titles and abstracts from OpenAlex, Semantic Scholar, Crossref and Europe PMC'),
          sw('web', 'Search the web', web
            ? 'Your model searches for distinctive passages; each page is fetched and compared here'
            : 'Off: web search needs the selected model to be connected. Connect it in Settings or choose another model above.', !web),
          sw('quotes', 'Leave out quotations', 'Text inside quotation marks does not count'),
          sw('references', 'Leave out the reference list', 'Everything after a References or Bibliography heading')));
    }

    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

    async function loadFile(file) {
      const t = cur();
      // Two documents dropped one after the other: only the newer one is used, and only it ends "reading".
      const ticket = (t.loads = (t.loads || 0) + 1);
      const redraw = () => { if (st[st.tool] === t) draw(); };
      if (file.size > 12 * 1024 * 1024) { t.error = 'That file is larger than 12 MB. Paste the text instead.'; t.extracting = false; redraw(); return; }
      t.error = '';
      t.extracting = true;
      redraw();
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const r = await api('POST', '/api/checks/extract', { name: file.name, data: btoa(bin) });
        if (ticket !== t.loads) return;
        t.text = r.text;
        t.file = { name: file.name, kind: r.kind };
      } catch (e) {
        if (ticket !== t.loads) return;
        t.error = e.message;
      }
      t.extracting = false;
      redraw();
    }

    // ---------------------------------------------------------------- running

    async function start() {
      const id = st.tool;
      const t = st[id];
      t.phase = 'running'; t.steps = {}; t.notices = []; t.error = ''; t.result = null; t.pick = null; t.source = null; t.tab = 'flags';
      if (t.before && t.text !== t.beforeText) t.before = null; // the comparison only holds for the text that was quoted and cited
      t.abort = new AbortController();
      draw();
      try {
        const res = await fetch(id === 'ai' ? '/api/checks/ai' : id === 'rewrite' ? '/api/checks/rewrite' : '/api/checks/similarity', {
          method: 'POST', signal: t.abort.signal,
          headers: { 'x-lectern-token': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ text: t.text, options: id === 'sim' ? simSend(t) : t.options, ...selected() }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
        await readEvents(res, (event, data) => onEvent(id, event, data));
        if (!t.result && !t.error) t.error = 'The check stopped before it finished.';
      } catch (e) {
        if (e.name !== 'AbortError') t.error = e.message;
      }
      t.abort = null;
      t.phase = t.result ? 'report' : 'input';
      if (st.tool === id) draw(); else swapSwitch(); // the switch loses its running dot either way
      // A check that ends while the writer looks at another tool or another page says so.
      const away = st.tool !== id || !root.isConnected || state.view !== 'score';
      if (away && t.result) toast(`${TOOLS[id].label} check finished`);
      else if (away && t.error) toast(`${TOOLS[id].label} check stopped with an error`);
    }

    function onEvent(id, event, data) {
      const t = st[id];
      if (event === 'step') { t.steps[data.id] = data; if (st.tool === id) drawSteps(); }
      else if (event === 'notice') { t.notices.push(data.text); if (st.tool === id) drawSteps(); }
      else if (event === 'result') t.result = data;
      else if (event === 'error') t.error = data.message;
    }

    let stepsEl = null;
    function running() {
      stepsEl = h('ol', { class: 'chk-steps' });
      drawSteps();
      return h('div', { class: 'chk-running' },
        h('p', { class: 'chk-lede' }, st.tool === 'ai' ? 'Reading the text…' : st.tool === 'rewrite' ? 'Rewriting the passage…' : 'Looking for matching sources…'),
        stepsEl,
        h('button', { type: 'button', class: 'btn', 'data-focus': 'run', 'data-focus-default': '', onclick: () => { const t = cur(); if (t.abort) t.abort.abort(); } }, 'Stop'));
    }

    function drawSteps() {
      if (!stepsEl) return;
      const t = cur();
      const defs = TOOLS[st.tool].steps;
      let reached = false;
      const items = defs.slice().reverse().map(([id]) => { if (t.steps[id]) reached = true; return [id, reached]; }).reverse();
      fill(stepsEl, defs.map(([id, label], k) => {
        const s = t.steps[id];
        const stateName = s ? s.state : items[k][1] ? 'done' : 'todo';
        return h('li', { class: `chk-step ${stateName}` },
          h('span', { class: 'chk-step-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'chk-step-label' }, label),
          s && s.detail && h('span', { class: 'chk-step-detail' }, s.detail),
          h('span', { class: 'chk-sr' }, ` (${stateName})`));
      }), t.notices.map((n) => h('li', { class: 'chk-notice' }, n)));
    }

    // ---------------------------------------------------------------- report: shared parts

    function report() {
      const t = cur();
      const r = t.result;
      if (st.tool === 'rewrite') return rewriteReport(t, r);
      const id = st.tool;
      // One clear next step (quote and cite the matches, when there are any), Export PDF, and the rest under More.
      const bar = h('div', { class: 'chk-bar' },
        h('button', { type: 'button', class: 'btn', 'data-focus': 'edit', onclick: () => { t.phase = 'input'; draw({ focus: 'text' }); } }, 'Edit text'),
        id === 'sim' && r.spans.length > 0 && h('button', { type: 'button', class: 'btn primary', 'data-focus': 'cite', onclick: (e) => quoteAndCite(t, r, e.currentTarget) }, 'Quote and cite matches'),
        h('button', { type: 'button', class: 'btn', 'data-focus': 'pdf', onclick: (e) => exportPdf(id, t, r, e.currentTarget) }, 'Export PDF'),
        moreMenu([
          { label: 'Copy report', run: () => copyReport(id, r) },
          { label: 'New check', run: () => { st[id] = fresh(); draw({ focus: 'text' }); } },
          { heading: 'Use this text in' },
          ...['proof', 'ai', 'rewrite', 'sim'].filter((x) => x !== id).map((x) => ({ label: TOOLS[x].label, run: () => transfer(x, r.text, t.file) })),
        ]));
      const page = id === 'ai' ? aiReport(t, r) : simReport(t, r);
      return h('div', { class: 'chk-report-wrap' }, bar, page);
    }

    /**
     * Put each exact match in quotation marks and cite every matched source (author and year from the source record),
     * then check the new text again so the change is measured, not assumed. Nothing is reworded.
     */
    async function quoteAndCite(t, r, btn) {
      if (btn) btn.disabled = true;
      try {
        const out = await api('POST', '/api/checks/cite', { text: r.text, result: r });
        const before = { score: r.score, quoted: out.quoted, cited: out.cited, references: out.references.length };
        st.sim = { ...fresh(), text: out.text, file: t.file, options: { ...t.options, quotes: true }, before, beforeText: out.text };
        st.tool = 'sim';
        toast(`${out.quoted} passage${out.quoted === 1 ? '' : 's'} quoted, ${out.cited} citation${out.cited === 1 ? '' : 's'} added. Checking again…`);
        start();
      } catch (e) {
        toast(e.message || 'Could not add the quotation marks and citations');
        if (btn) btn.disabled = false;
      }
    }

    function transfer(id, text, file) {
      if (id === 'proof') {
        const p = proofreader();
        if (p && p.busy()) { st.tool = id; draw(); toast('A check is already running in this tool'); return; }
        if (p) p.setText(text, file || null);
        st.tool = id;
        draw();
        return;
      }
      if (st[id].phase === 'running' || st[id].extracting) { st.tool = id; draw(); toast('A task is already running in this tool'); return; }
      st[id] = { ...fresh(), text, file: file || null, options: st[id].options };
      st.tool = id;
      draw();
    }

    function rewriteReport(t, r) {
      // The rewrite box grows with its text and is never shorter than the original beside it (checks.css), so its
      // end is never cut off behind an inner scroll bar.
      const output = h('textarea', { class: 'chk-text chk-rewrite-output', 'aria-label': 'Rewritten text', 'data-focus': 'output', oninput: (e) => { r.text = e.target.value; } });
      output.value = r.text;
      return h('div', { class: 'chk-rewrite' },
        h('div', { class: 'chk-bar' },
          h('button', { type: 'button', class: 'btn', 'data-focus': 'edit', onclick: () => { t.phase = 'input'; draw({ focus: 'text' }); } }, 'Edit original'),
          h('button', { type: 'button', class: 'btn primary', 'data-focus': 'copy', 'data-focus-default': '', onclick: () => copyText(r.text).then((ok) => toast(ok ? 'Rewrite copied' : 'Could not copy the rewrite')) }, 'Copy rewrite'),
          moreMenu([
            { label: 'Start over', run: () => { st.rewrite = fresh(); draw({ focus: 'text' }); } },
            { heading: 'Use the rewrite in' },
            ...['proof', 'ai', 'sim'].map((x) => ({ label: TOOLS[x].label, run: () => transfer(x, r.text) })),
          ])),
        r.check && (r.check.ok
          ? h('p', { class: 'chk-check ok', role: 'status' }, h('b', null, 'Checked. '), `Every number, name, acronym, quotation and citation in your text is still there, and nothing new was added.${r.attempts > 1 ? ' The first attempt changed a fact, so it was redone.' : ''}`)
          : h('p', { class: 'chk-check bad', role: 'alert' }, h('b', null, 'Check the rewrite. '), r.check.missing.length ? `It dropped: ${r.check.missing.join(', ')}. ` : '', r.check.added.length ? `It added: ${r.check.added.join(', ')}. ` : '', 'This happened twice, so it is shown for you to fix by hand.')),
        about('rewrite-report', TOOLS.rewrite.say, 'Limits',
          h('p', null, 'Compare the original and rewrite, especially facts, qualifications, quotations and citations. Scores are not measured by rewriting; run the checks to see their results.'),
          h('p', null, TOOLS.rewrite.more)),
        h('div', { class: 'chk-rewrite-grid' },
          h('div', { class: 'chk-rewrite-panel' }, h('h2', null, 'Original'), h('div', { class: 'chk-rewrite-original' }, t.text)),
          h('div', { class: 'chk-rewrite-panel' }, h('h2', null, 'Rewrite · editable'), output)));
    }

    /** Paragraphs of the submitted text, with outer ranges (sentences or matches) and inner marks. */
    function manuscript(text, outer, inner, makeOuter) {
      const cuts = new Set([0, text.length]);
      for (const r of outer) { cuts.add(r.start); cuts.add(r.end); }
      for (const r of inner) { cuts.add(r.start); cuts.add(r.end); }
      for (const m of text.matchAll(/\n\s*\n/g)) { cuts.add(m.index); cuts.add(m.index + m[0].length); }
      const points = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
      const outerAt = (pos) => { let lo = 0, hi = outer.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; const o = outer[mid]; if (pos < o.start) hi = mid - 1; else if (pos >= o.end) lo = mid + 1; else return o; } return null; };
      const paras = [];
      let para = [];
      let open = null;
      let openEl = null;
      const flush = () => { if (para.length) paras.push(h('p', null, para)); para = []; open = null; openEl = null; };
      for (let k = 0; k < points.length - 1; k++) {
        const a = points[k], b = points[k + 1];
        const piece = text.slice(a, b);
        if (/^\n\s*\n$/.test(piece) || (/^\s+$/.test(piece) && piece.includes('\n\n'))) { flush(); continue; }
        const o = outerAt(a);
        const marks = inner.filter((r) => r.start <= a && r.end >= b);
        const node = marks.length ? h('span', { class: marks.map((m) => m.cls).join(' ') }, piece) : document.createTextNode(piece);
        if (o) {
          if (open !== o) { open = o; openEl = makeOuter(o); para.push(openEl); }
          openEl.append(node);
        } else { open = null; openEl = null; para.push(node); }
      }
      flush();
      return h('div', { class: 'chk-ms' }, paras);
    }

    function selectInText(sel) {
      requestAnimationFrame(() => {
        const el = root.querySelector(sel);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: Motion.calm() ? 'instant' : 'smooth' });
      });
    }

    /**
     * The report's sections: a tab list with one tab stop (the arrow keys, Home and End move between the tabs) that
     * controls the panel tabPanel() draws below it. The picked tab also has the class "on" for the sliding box.
     */
    function tabs(t, list) {
      const ids = list.map(([id]) => id);
      const pick = (id) => { if (t.tab !== id) { t.tab = id; draw({ focus: `tab:${id}` }); } };
      const group = h('div', { class: 'chk-tabs', role: 'tablist', 'aria-label': 'Report sections', onkeydown: (e) => arrowKeys(e, ids, t.tab, pick, false) },
        list.map(([id, label, n]) => h('button', {
          type: 'button', role: 'tab', id: `chk-tab-${st.tool}-${id}`, class: `chk-tab${t.tab === id ? ' on' : ''}`,
          'aria-selected': String(t.tab === id), 'aria-controls': `chk-panel-${st.tool}`, tabindex: t.tab === id ? '0' : '-1', 'data-focus': `tab:${id}`,
          onclick: () => pick(id),
        }, label, n != null && h('span', { class: 'chk-tab-n' }, fmt(n)))));
      return Motion.slide(group, `checks-tabs-${st.tool}`);
    }
    const tabPanel = (t, content) => h('div', { class: 'chk-panel', role: 'tabpanel', id: `chk-panel-${st.tool}`, 'aria-labelledby': `chk-tab-${st.tool}-${t.tab}`, tabindex: '0' }, content);

    /** Hidden descriptions for marks in the text (aria-describedby), one element per distinct wording. */
    let describeSeq = 0;
    function describer() {
      const prefix = `chk-d${++describeSeq}`;
      const ids = new Map();
      const nodes = [];
      return {
        id(text) {
          if (!ids.has(text)) { const id = `${prefix}-${ids.size}`; ids.set(text, id); nodes.push(h('span', { id }, text)); }
          return ids.get(text);
        },
        box: () => h('div', { class: 'chk-descs', hidden: true }, nodes),
      };
    }

    // ---------------------------------------------------------------- AI writing report

    const BAND = { strong: 'Strong AI-like writing patterns', some: 'Some AI-like writing patterns', few: 'Few AI-like writing patterns', unreviewed: 'Not reviewed' };
    const PROVIDER = { codex: 'ChatGPT (Codex)', 'claude-code': 'Claude' };
    const pct = (x) => `${Math.round(x * 100)}%`;
    const cls = (s) => (s.review === 'model' ? s.band : 'unreviewed');

    /** Spoken and written description of one sentence: the band, the model's rating, or why it was not reviewed. */
    function sentenceSay(s) {
      if (s.review !== 'model') return `Not reviewed. ${s.unreviewedReason}`;
      return `${BAND[s.band]}: the model rated it ${s.rating} out of 100.${s.part ? ' Part of a long sentence.' : ''}`;
    }

    /** Who reviewed the text, as precisely as the provider lets us say it. */
    function modelLine(r) {
      const p = r.provenance;
      if (!p.engine) return 'No model reviewed this text.';
      const who = PROVIDER[p.engine] || p.engine;
      const asked = p.requestedModel || 'the provider’s default model';
      if (p.reportedModels.length) {
        const same = p.requestedModel && p.reportedModels.length === 1 && p.reportedModels[0] === p.requestedModel;
        return same ? `Reviewed by ${who}, ${asked} (confirmed by the provider).` : `Reviewed by ${who}. Requested ${asked}; the provider reported ${p.reportedModels.join(', ')}.`;
      }
      return `Reviewed by ${who}, requested ${asked}. ${who} does not report which model answered.`;
    }

    function aiReport(t, r) {
      const eligible = r.sentences.filter((s) => s.eligible);
      const reviewed = eligible.filter((s) => s.review === 'model');
      const unreviewed = eligible.filter((s) => s.review !== 'model');
      const flagged = reviewed.filter((s) => s.band !== 'few').sort((a, b) => b.rating - a.rating);
      const inner = [
        ...eligible.flatMap((s) => s.marks.map((m) => ({ start: m.start, end: m.end, cls: 'chk-word' }))),
        ...r.issues.map((iss, k) => ({ start: iss.start, end: iss.end, cls: `chk-err chk-err-${k}` })),
      ];
      // A sentence is read out as its own words; its rating is its description (shared hidden elements), not a
      // label that would replace the sentence.
      const desc = describer();
      const ms = manuscript(r.text, eligible.map((s) => ({ ...s })), inner, (s) => h('span', {
        class: `chk-s ${cls(s)}${t.pick === s.i ? ' picked' : ''}`, 'data-s': s.i, tabindex: '0', role: 'button',
        'aria-describedby': desc.id(sentenceSay(s)),
        onclick: () => pickSentence(t, s.i), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSentence(t, s.i); } },
      }));

      const pick = t.pick != null ? r.sentences.find((s) => s.i === t.pick && s.eligible) : null;
      const tabList = [['flags', 'Patterns', flagged.length], ['mistakes', 'Suggestions', r.issues.length]];
      if (unreviewed.length) tabList.push(['unreviewed', 'Not reviewed', unreviewed.length]);
      tabList.push(['signals', 'How it was read']);
      if (t.tab === 'unreviewed' && !unreviewed.length) t.tab = 'flags';
      const score = aiScore(r);
      score.tabIndex = -1; // where focus goes when the report replaces the running view
      score.dataset.focusDefault = '';
      const slip = h('aside', { class: 'chk-slip' },
        score,
        pick && sentenceCard(r, pick),
        tabs(t, tabList),
        tabPanel(t, t.tab === 'flags' ? flagList(t, r, flagged, reviewed.length, unreviewed.length)
          : t.tab === 'mistakes' ? mistakeList(t, r)
            : t.tab === 'unreviewed' ? unreviewedList(t, r, unreviewed) : signalsPanel(r)));

      return h('div', { class: 'chk-report ai' },
        h('div', { class: 'chk-ms-wrap' }, aiLegend(unreviewed.length > 0, r.issues.length > 0), ms, desc.box()),
        slip);
    }

    /** The key to the marks in the text (on the page and on paper). */
    function aiLegend(unreviewed, issues) {
      return h('div', { class: 'chk-legend' },
        h('span', { class: 'chk-key strong' }, 'Strong patterns (65+)'),
        h('span', { class: 'chk-key some' }, 'Some patterns (40–64)'),
        unreviewed && h('span', { class: 'chk-key unreviewed' }, 'Not reviewed'),
        h('span', { class: 'chk-key word' }, 'Word or phrase common since ChatGPT'),
        issues && h('span', { class: 'chk-key err' }, 'Writing suggestion'));
    }

    /** The trained style model: a separate reading, with its tested accuracy and weak spots, never part of the score. */
    function styleLine(sr) {
      return h('p', { class: 'chk-style' },
        h('span', { class: 'chk-from' }, 'Style model'),
        h('span', null, sr.flagged ? 'Its writing style resembles AI text in the public test sets' : 'Its writing style does not stand out as AI-like in the public test sets',
          ` (${Math.round(sr.probability * 100)} of 100; flags at ${Math.round(sr.threshold * 100)}). A second reading, not part of the score.`));
    }
    function styleTable(sr) {
      const t = sr.tested;
      return h('div', { class: 'chk-style-tested' },
        h('h3', { class: 'chk-h3' }, `Style model (version ${sr.version}), tested before use`),
        h('p', { class: 'chk-note' }, `A logistic regression over 30 measurable style features, trained on public labelled human and AI texts (HC3, RAID, MAGE, DACTYL). On a fresh test set of 2024–25 models (${t.set}) it separated human and AI text with AUROC ${t.auroc}, flagged ${t.falsePositive} of human texts and caught ${t.detection} of AI texts.`),
        h('p', { class: 'chk-note' }, `Known weak spots: it wrongly flags ${t.nonNativeFalsePositive}, against ${t.nativeStudentFalsePositive} for native student writing, and it barely separates student essays (AUROC ${t.studentEssayAuroc}). Treat it as a pointer to read the text, never as evidence about who wrote it.`));
    }

    /** The result card. On the page its limits and the model line fold behind one line; on paper (`print`) all is shown. */
    function aiScore(r, print = false) {
      const b = r.bands;
      const status = r.status === 'unavailable'
        ? h('p', { class: 'chk-status unavailable', role: 'alert' }, h('b', null, 'Not reviewed. '), r.scoreWithheld)
        : r.status === 'partial'
          ? h('p', { class: 'chk-status partial', role: 'status' }, h('b', null, 'Partly reviewed. '), `${pct(r.coverage)} of the eligible text was reviewed; the rest is marked “not reviewed” and is not counted either way.`)
          : null;
      const notEligible = Math.max(0, r.words - r.eligibleWords);
      return h('section', { class: 'chk-score', 'aria-label': 'Writing-pattern review result' },
        h('div', { class: 'chk-score-head' }, h('span', null, 'Writing-pattern review'), h('span', { class: 'chk-nv', title: 'This method has not been tested on an independent benchmark.' }, r.validated ? 'Validated' : 'Not validated')),
        status,
        h('div', { class: 'chk-score-main' },
          h('span', { class: 'chk-num' }, r.score == null ? '–' : `${r.score}%`),
          r.score == null
            ? h('span', { class: 'chk-withheld' }, r.status === 'unavailable' ? 'No score.' : `No score. ${r.scoreWithheld}`)
            : h('span', { class: 'chk-num-say' }, 'of the reviewed words are in sentences the model rated 65 or more for strong AI-like writing patterns.')),
        h('p', { class: 'chk-denom' },
          'Reviewed ', h('b', null, fmt(r.reviewedWords)), ' of ', h('b', null, fmt(r.eligibleWords)), ` eligible words (${pct(r.coverage)}).`,
          notEligible > 0 ? ` ${fmt(notEligible)} words were not eligible: headings, short lines and the reference list.` : ''),
        r.eligibleWords > 0 && h('div', { class: 'chk-bands', role: 'img', 'aria-label': `Of ${fmt(r.eligibleWords)} eligible words: strong patterns ${b.strong}%, some patterns ${b.some}%, few patterns ${b.few}%, not reviewed ${b.notReviewed}%.` },
          h('span', { class: 'chk-band strong', style: `flex-grow:${b.strong}` }),
          h('span', { class: 'chk-band some', style: `flex-grow:${b.some}` }),
          h('span', { class: 'chk-band few', style: `flex-grow:${b.few}` }),
          h('span', { class: 'chk-band notReviewed', style: `flex-grow:${b.notReviewed}` })),
        h('ul', { class: 'chk-band-key', 'aria-label': 'Share of eligible words' },
          h('li', null, h('i', { class: 'strong' }), 'Strong patterns', h('b', null, `${b.strong}%`)),
          h('li', null, h('i', { class: 'some' }), 'Some patterns', h('b', null, `${b.some}%`)),
          h('li', null, h('i', { class: 'few' }), 'Few patterns', h('b', null, `${b.few}%`)),
          b.notReviewed > 0 && h('li', null, h('i', { class: 'notReviewed' }), 'Not reviewed', h('b', null, `${b.notReviewed}%`))),
        r.lengthCategory === 'brief' && h('p', { class: 'chk-caution' }, 'Brief text (under 300 eligible words): the totals describe little writing, so read the sentences themselves.'),
        print && h('p', { class: 'chk-readby' }, modelLine(r)),
        r.style && styleLine(r.style),
        r.summary && h('p', { class: 'chk-summary' }, h('span', { class: 'chk-from' }, 'Model'), r.summary),
        r.notes.filter((n) => !/^The model reviewed/.test(n)).map((n) => h('p', { class: 'chk-note' }, n)),
        print
          ? h('ul', { class: 'chk-limits-list', 'aria-label': 'Limits of this review' }, r.limits.map((x) => h('li', null, x)))
          : about('ai-limits', 'Not validated: do not use this result as evidence against a writer.', 'Limits',
            h('ul', { class: 'chk-limits-list', 'aria-label': 'Limits of this review' }, r.limits.map((x) => h('li', null, x))),
            r.style && h('p', null, `The style model’s known weak spots: it wrongly flags ${r.style.tested.nonNativeFalsePositive}, against ${r.style.tested.nativeStudentFalsePositive} for native student writing, and it barely separates student essays (AUROC ${r.style.tested.studentEssayAuroc}).`),
            h('p', null, modelLine(r))));
    }

    function sentenceCard(r, s) {
      return h('section', { class: 'chk-card', 'aria-live': 'polite' },
        h('div', { class: 'chk-card-head' },
          h('span', { class: `chk-pill ${cls(s)}` }, BAND[cls(s)]),
          s.review === 'model' && h('span', { class: 'chk-card-score', 'aria-label': `model rating ${s.rating} out of 100` }, `${s.rating}`, h('small', null, '/100'))),
        h('blockquote', { class: 'chk-quote' }, r.text.slice(s.start, s.end)),
        s.review === 'model'
          ? (s.why ? h('ul', { class: 'chk-reasons' }, h('li', null, h('span', { class: 'chk-from' }, 'Model'), s.why)) : h('p', { class: 'chk-note' }, 'The model gave no reason.'))
          : h('p', { class: 'chk-note' }, s.unreviewedReason),
        s.signals.length > 0 && h('div', { class: 'chk-measured' },
          h('div', { class: 'chk-measured-head' }, 'Measured in the text · not part of the rating'),
          h('ul', { class: 'chk-reasons' }, s.signals.map((x) => h('li', null, x)))),
        s.part && h('p', { class: 'chk-note' }, 'This is part of a long sentence that was cut so the model could read every part whole.'));
    }

    /**
     * Pick a sentence (or unpick it). Only what depends on the pick changes: the outline in the text, the row in the
     * list and the card above the tabs. The rest of the report stays as it is, so focus and the slip's scroll stay put.
     */
    function pickSentence(t, i) {
      t.pick = t.pick === i ? null : i;
      const page = root.querySelector('.chk-report.ai');
      if (!page || !t.result) { draw(); return; }
      for (const el of page.querySelectorAll('.chk-s.picked, .chk-item.on')) el.classList.remove(el.classList.contains('chk-s') ? 'picked' : 'on');
      if (t.pick != null) {
        for (const el of page.querySelectorAll(`.chk-s[data-s="${t.pick}"]`)) el.classList.add('picked');
        for (const el of page.querySelectorAll(`.chk-item[data-s="${t.pick}"]`)) el.classList.add('on');
      }
      const slip = page.querySelector('.chk-slip');
      const old = slip.querySelector(':scope > .chk-card');
      const s = t.pick != null ? t.result.sentences.find((x) => x.i === t.pick && x.eligible) : null;
      const card = s ? sentenceCard(t.result, s) : null;
      if (old && card) old.replaceWith(card);
      else if (old) old.remove();
      else if (card) slip.querySelector(':scope > .chk-score').after(card);
      if (t.pick != null) selectInText(`.chk-s[data-s="${i}"]`);
    }

    function flagList(t, r, flagged, reviewedCount, unreviewedCount) {
      if (!flagged.length) {
        return h('p', { class: 'chk-empty' }, !reviewedCount
          ? 'Nothing was reviewed, so no sentence has a rating.'
          : `The model rated none of the ${reviewedCount} reviewed sentences 40 or more. This describes writing patterns, not who wrote the text.${unreviewedCount ? ` ${unreviewedCount} sentences were not reviewed.` : ''}`);
      }
      return h('ol', { class: 'chk-list' }, flagged.slice(0, 120).map((s) => h('li', null, h('button', {
        type: 'button', class: `chk-item${t.pick === s.i ? ' on' : ''}`, 'data-s': s.i, onclick: () => pickSentence(t, s.i), 'aria-label': `${sentenceSay(s)} ${clipText(r.text.slice(s.start, s.end), 140)}`,
      },
      h('span', { class: `chk-dot ${s.band}`, 'aria-hidden': 'true' }),
      h('span', { class: 'chk-item-text' }, clipText(r.text.slice(s.start, s.end), 140)),
      h('span', { class: 'chk-item-score', 'aria-hidden': 'true' }, `${s.rating}`)))));
    }

    function unreviewedList(t, r, list) {
      return h('ol', { class: 'chk-list' }, list.slice(0, 200).map((s) => h('li', null, h('button', {
        type: 'button', class: `chk-item${t.pick === s.i ? ' on' : ''}`, 'data-s': s.i, onclick: () => pickSentence(t, s.i), 'aria-label': `${sentenceSay(s)} ${clipText(r.text.slice(s.start, s.end), 140)}`,
      },
      h('span', { class: 'chk-dot unreviewed', 'aria-hidden': 'true' }),
      h('span', { class: 'chk-item-text' }, clipText(r.text.slice(s.start, s.end), 140), h('span', { class: 'chk-note-line' }, s.unreviewedReason))))));
    }

    function mistakeList(t, r) {
      if (!r.issues.length) {
        return h('p', { class: 'chk-empty' }, r.status === 'unavailable'
          ? 'Suggestions come from the model review, and nothing was reviewed.'
          : `No writing suggestions.${r.rejectedSuggestions ? ` ${r.rejectedSuggestions} suggestion${r.rejectedSuggestions === 1 ? ' was' : 's were'} dropped because the quoted words were not found once in the sentence the model named.` : ''}`);
      }
      return h('div', null,
        h('p', { class: 'chk-note' }, 'Suggestions from the model. Check each one before you change anything; they are separate from the pattern ratings.'),
        h('ol', { class: 'chk-list' }, r.issues.map((iss, k) => h('li', null, h('button', {
          type: 'button', class: 'chk-item chk-mistake',
          onclick: () => { selectInText(`.chk-err-${k}`); const el = root.querySelector(`.chk-err-${k}`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } },
        },
        h('span', { class: 'chk-kind' }, iss.kind),
        h('span', { class: 'chk-fix' },
          h('s', null, r.text.slice(iss.start, iss.end)),
          iss.fix && h('span', { class: 'chk-arrow', 'aria-hidden': 'true' }),
          iss.fix && h('ins', { 'aria-label': `suggested: ${iss.fix}` }, iss.fix)),
        iss.note && h('span', { class: 'chk-note-line' }, iss.note))))),
        r.rejectedSuggestions > 0 && h('p', { class: 'chk-note' }, `${r.rejectedSuggestions} more suggestion${r.rejectedSuggestions === 1 ? ' was' : 's were'} dropped: the quoted words were not found exactly once in the sentence the model named.`));
    }

    function signalsPanel(r) {
      const g = r.readings;
      const p = r.provenance;
      const row = (name, value, say) => h('tr', null, h('th', { scope: 'row' }, name), h('td', null, value), h('td', null, say));
      const STATUS = { complete: 'Complete', partial: 'Partly rated', failed: 'Failed', 'not sent': 'Not sent' };
      return h('div', { class: 'chk-signals' },
        h('p', { class: 'chk-note' }, `How the result is made: the model rates each sentence 0–100 for how strongly it shows generic, formulaic writing patterns. Sentences rated 65 or more count as strong, 40–64 as some. The headline is the share of reviewed words in strong sentences. A sentence the model did not rate validly is “not reviewed” and counts nowhere. Long sentences are cut into parts so the model reads every part whole. Scoring rules version ${p.scoring.version}; no score below ${p.scoring.minReviewedWords} reviewed words or ${Math.round(p.scoring.minCoverage * 100)}% coverage.`),
        h('h3', { class: 'chk-h3' }, 'Review parts'),
        h('table', { class: 'chk-prov' },
          h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Sentences'), h('th', null, 'Words'), h('th', null, 'Result'), h('th', null, 'Time'))),
          h('tbody', null, p.batches.map((b) => h('tr', null,
            h('td', null, String(b.n)), h('td', null, `${b.from}–${b.to}`), h('td', null, fmt(b.words)),
            h('td', { class: b.status === 'complete' ? 'ok' : 'bad' }, STATUS[b.status] || b.status, b.status === 'partial' ? ` (${b.unrated} unrated)` : '', b.error ? `: ${b.error}` : ''),
            h('td', null, b.ms ? `${(b.ms / 1000).toFixed(1)} s` : '–'))))),
        h('p', { class: 'chk-note' }, modelLine(r)),
        h('h3', { class: 'chk-h3' }, 'Measured in the text (not part of the score)'),
        h('table', null,
          h('tbody', null,
            row('Sentence rhythm', g.rhythm == null ? 'n/a' : g.rhythm.toFixed(2), 'How much sentence length varies (coefficient of variation).'),
            row('Words common after ChatGPT', `${g.vocabularyPer1000}`, 'Per 1,000 words, weighted (Kobak et al., 2025).'),
            row('Stock phrases', `${g.phrasesPer1000}`, 'Per 1,000 words, such as “plays a crucial role”.'),
            row('Signpost openers', `${Math.round(g.signpostShare * 100)}%`, 'Sentences opening with Furthermore, Moreover, In conclusion and similar.'),
            row('Measured index', `${g.docSignal}/100`, 'A fixed, uncalibrated summary of the rows above. Shown for transparency only.'))),
        r.style && styleTable(r.style),
        // The limits themselves are in the result card above (folded on the page, in full on paper), not repeated here.
        h('p', { class: 'chk-note' }, 'Lectern cannot measure perplexity (how predictable each word is to a model), which dedicated detectors use; the models on your plan do not expose it.'));
    }

    // ---------------------------------------------------------------- similarity report

    function simReport(t, r) {
      const outer = r.spans.map((sp, k) => ({ ...sp, k }));
      const inner = r.excluded.map((x) => ({ start: x.start, end: x.end, cls: 'chk-out' }));
      // A match is read out as its own words; which source it matches is its description, not a replacing label.
      const desc = describer();
      const ms = manuscript(r.text, outer, inner, (sp) => {
        const tone = ((sp.source - 1) % TONES) + 1;
        const el = h('span', {
          class: `chk-m t${tone}${sp.type === 'paraphrase' ? ' para' : ''}${t.source && t.source !== sp.source ? ' dim' : ''}${t.source === sp.source ? ' lit' : ''}`,
          'data-src': sp.source, 'data-k': sp.k, tabindex: '0', role: 'button',
          'aria-describedby': desc.id(`${sp.type === 'exact' ? 'Same wording as' : 'Close paraphrase of'} source ${sp.source}.`),
          onclick: () => pickSource(t, sp.source, sp.k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSource(t, sp.source, sp.k); } },
        });
        if (!outer.some((o) => o.k < sp.k && o.source === sp.source && o.end === sp.start)) el.append(h('sup', { class: `chk-n t${tone}`, 'aria-hidden': 'true' }, String(sp.source)));
        return el;
      });

      const score = simScore(r);
      score.tabIndex = -1; // where focus goes when the report replaces the running view
      score.dataset.focusDefault = '';
      const slip = h('aside', { class: 'chk-slip' },
        score,
        h('h2', { class: 'chk-h2' }, r.sources.length ? 'Sources' : 'No matching sources'),
        r.sources.length ? h('ol', { class: 'chk-sources' }, r.sources.map((s) => sourceRow(t, r, s))) : h('p', { class: 'chk-empty' }, 'Nothing Lectern could find and read matches this text. That covers paper abstracts and public web pages only.'),
        searchedNote(r));

      return h('div', { class: 'chk-report sim' },
        h('div', { class: 'chk-ms-wrap' },
          h('div', { class: 'chk-legend' },
            h('span', { class: 'chk-key exact' }, 'Same wording as a source'),
            h('span', { class: 'chk-key para' }, 'Close paraphrase'),
            r.excluded.length > 0 && h('span', { class: 'chk-key out' }, 'Left out (quotation or reference list)')),
          ms, desc.box()),
        slip);
    }

    function simScore(r) {
      const share = (n) => (r.countedWords ? Math.round((100 * n) / r.countedWords) : 0);
      return h('section', { class: 'chk-score' },
        h('div', { class: 'chk-score-head' }, h('span', null, 'Similarity'), h('span', null, `${fmt(r.countedWords)} words compared`)),
        h('div', { class: 'chk-score-main' },
          h('span', { class: 'chk-num' }, r.score == null ? '–' : `${r.score}%`),
          h('span', { class: 'chk-num-say' }, r.score == null ? 'No score: no comparable sources or eligible text.' : r.sources.length ? `of the text matches ${r.sources.length} source${r.sources.length === 1 ? '' : 's'} Lectern found.` : 'matching text found.')),
        h('ul', { class: 'chk-band-key' },
          h('li', null, h('i', { class: 'exact' }), 'Same wording', h('b', null, `${share(r.exactWords)}%`)),
          h('li', null, h('i', { class: 'para' }), 'Close paraphrase', h('b', null, `${share(r.paraphraseWords)}%`))),
        cur().before && h('p', { class: 'chk-check ok', role: 'status' }, h('b', null, 'Quoted and cited. '),
          `Before: ${cur().before.score == null ? 'no score' : `${cur().before.score}%`}. ${plural(cur().before.quoted, 'exact passage is', 'exact passages are')} now in quotation marks and left out of the score; ${plural(cur().before.cited, 'paraphrased or already-quoted passage', 'paraphrased or already-quoted passages')} now carr${cur().before.cited === 1 ? 'ies' : 'y'} a citation; ${plural(cur().before.references, 'source was', 'sources were')} added to the reference list. Check each citation against the source before you submit.`),
        r.notes.map((n) => h('p', { class: 'chk-note' }, n)),
        h('p', { class: 'chk-note' }, 'A match is not plagiarism by itself: quoted and properly cited text is fine. Check each match against your citations.'));
    }

    const KIND = { web: 'Web page', paper: 'Paper abstract', library: 'Your Library' };
    function sourceRow(t, r, s) {
      const tone = ((s.n - 1) % TONES) + 1;
      const on = t.source === s.n;
      const meta = [KIND[s.kind], s.host, s.venue, s.year, s.authors.length ? s.authors.slice(0, 2).join(', ') + (s.authors.length > 2 ? ' et al.' : '') : ''].filter(Boolean).join(' · ');
      const row = h('li', { class: `chk-src${on ? ' on' : ''}`, 'data-n': s.n },
        h('button', { type: 'button', class: 'chk-src-btn', 'aria-expanded': String(on), 'data-focus': `src:${s.n}`, onclick: () => pickSource(t, s.n) },
          h('span', { class: `chk-badge t${tone}` }, String(s.n)),
          h('span', { class: 'chk-src-text' }, h('span', { class: 'chk-src-title' }, s.title), h('span', { class: 'chk-src-meta' }, meta)),
          h('span', { class: 'chk-src-pct' }, `${s.percent}%`, h('span', { class: `chk-src-bar t${tone}`, style: `--w:${Math.min(100, s.percent)}%` }))),
        on && sourceMore(r, s));
      return row;
    }
    /** An open source row: the link, the counts and the passages side by side. */
    function sourceMore(r, s) {
      return h('div', { class: 'chk-src-more' },
        s.url && h('a', { class: 'chk-open', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.kind === 'web' ? 'Open the page' : 'Open the paper'),
        h('p', { class: 'chk-src-count' }, `${s.matches} matching passage${s.matches === 1 ? '' : 's'}, ${fmt(s.words)} words, compared with its ${s.part}.`),
        pairsFor(r, s, 30));
    }

    /** Your words beside the source's words, for each passage that matches source `s`. */
    function pairsFor(r, s, max) {
      const tone = ((s.n - 1) % TONES) + 1;
      return h('ol', { class: 'chk-pairs' }, r.spans.filter((sp) => sp.source === s.n).slice(0, max).map((sp) => h('li', { class: 'chk-pair' },
        h('div', { class: 'chk-side' }, h('span', { class: 'chk-side-label' }, 'Your text'), h('p', null, h('mark', { class: `t${tone}` }, r.text.slice(sp.start, sp.end)))),
        h('div', { class: 'chk-side' }, h('span', { class: 'chk-side-label' }, sp.type === 'exact' ? 'Source' : `Source · paraphrase, ${sp.similarity || ''}% of content words shared`),
          h('p', null, sp.excerpt.before && `…${sp.excerpt.before}`, h('mark', { class: `t${tone}` }, sp.excerpt.match), sp.excerpt.after && `${sp.excerpt.after}…`)))));
    }

    /**
     * Pick a source (or close it). Only what depends on the pick changes: the matches in the text light up or dim,
     * and the rows that open or close. The rest of the report stays as it is, so focus and the slip's scroll stay put.
     */
    function pickSource(t, n, k) {
      t.source = t.source === n ? (k != null ? n : null) : n;
      const page = root.querySelector('.chk-report.sim');
      if (!page || !t.result) { draw(); return; }
      for (const el of page.querySelectorAll('.chk-ms .chk-m')) {
        const src = Number(el.dataset.src);
        el.classList.toggle('dim', t.source != null && t.source !== src);
        el.classList.toggle('lit', t.source === src);
      }
      for (const row of page.querySelectorAll('.chk-sources > .chk-src')) {
        const s = t.result.sources.find((x) => x.n === Number(row.dataset.n));
        const on = !!s && t.source === s.n;
        if (!s || row.classList.contains('on') === on) continue;
        row.classList.toggle('on', on);
        row.querySelector('.chk-src-btn').setAttribute('aria-expanded', String(on));
        if (on) row.append(sourceMore(t.result, s));
        else row.querySelector(':scope > .chk-src-more')?.remove();
      }
      if (t.source != null) selectInText(k != null ? `.chk-m[data-k="${k}"]` : `.chk-m[data-src="${n}"]`);
    }

    function searchedNote(r) {
      const s = r.searched;
      return h('details', { class: 'chk-searched fsec' },
        h('summary', null, 'What was searched'),
        h('p', null, `${s.passages} distinctive passages were searched. ${s.papers} paper records and ${s.pages} web pages were compared word by word.`),
        s.skipped.length > 0 && h('div', null,
          h('p', null, `${s.skipped.length} page${s.skipped.length === 1 ? ' was' : 's were'} not read:`),
          h('ul', { class: 'chk-skipped' }, s.skipped.map((x) => h('li', null, h('span', { class: 'chk-skip-url' }, x.url), ` — ${x.why}`)))),
        h('p', null, TOOLS.sim.limits));
    }

    // ---------------------------------------------------------------- copy

    function copyReport(id, r) {
      let out = '';
      if (id === 'ai') {
        const p = r.provenance;
        out += 'Writing-pattern review (Lectern) - NOT VALIDATED, not an AI detector\n';
        out += r.score == null ? `No score. ${r.scoreWithheld}\n` : `${r.score}% of reviewed words are in sentences the model rated 65+ for strong AI-like writing patterns\n`;
        out += `Reviewed ${r.reviewedWords} of ${r.eligibleWords} eligible words (${Math.round(r.coverage * 100)}%); status: ${r.status}\n`;
        out += `Of eligible words: strong patterns ${r.bands.strong}% · some patterns ${r.bands.some}% · few patterns ${r.bands.few}% · not reviewed ${r.bands.notReviewed}%\n`;
        out += `${modelLine(r)}\nChecked ${p.finishedAt}; scoring rules version ${p.scoring.version}\n`;
        if (r.style) out += `Style model (second reading, not in the score): ${Math.round(r.style.probability * 100)}/100, flags at ${Math.round(r.style.threshold * 100)}; non-native writers are wrongly flagged ${r.style.tested.nonNativeFalsePositive}\n`;
        out += '\n';
        for (const s of r.sentences.filter((x) => x.eligible && x.review === 'model' && x.band !== 'few')) out += `[model rating ${s.rating}/100, ${s.band} patterns] ${r.text.slice(s.start, s.end)}\n  ${s.why}\n`;
        const un = r.sentences.filter((x) => x.eligible && x.review !== 'model');
        if (un.length) out += `\nNot reviewed (${un.length} sentences, not counted either way)\n` + un.slice(0, 50).map((s) => `- ${r.text.slice(s.start, s.end).slice(0, 120)} (${s.unreviewedReason})`).join('\n') + '\n';
        if (r.issues.length) out += '\nWriting suggestions (from the model; check before applying)\n' + r.issues.map((i) => `- ${i.kind}: "${r.text.slice(i.start, i.end)}"${i.fix ? ` -> suggested "${i.fix}"` : ''}${i.note ? ` (${i.note})` : ''}`).join('\n') + '\n';
        out += `\nLimits\n${r.limits.map((x) => `- ${x}`).join('\n')}\n`;
      } else {
        out += `Similarity check (Lectern)\n${r.score == null ? 'No score: no comparable sources or eligible text' : `${r.score}% of the text matches sources found`}\n\n`;
        for (const s of r.sources) out += `${s.n}. ${s.title} (${KIND[s.kind]}) ${s.percent}%\n   ${s.url}\n`;
        out += `\n${TOOLS.sim.limits}\n`;
      }
      copyText(out).then((ok) => toast(ok ? 'Report copied' : 'Could not copy the report'));
    }

    // ---------------------------------------------------------------- PDF export

    /**
     * The whole report on paper: everything the page shows across its tabs and folds, in one column,
     * always in the light theme. It exists only while the PDF is being made, then is removed.
     */
    function printReport(id, t, r) {
      const when = new Date((id === 'ai' && r.provenance && r.provenance.finishedAt) || Date.now());
      const head = h('header', { class: 'chk-print-head' },
        h('div', { class: 'chk-print-brand' }, 'Lectern'),
        h('h1', null, id === 'ai' ? 'Writing-pattern review' : 'Similarity report'),
        h('p', { class: 'chk-print-meta' }, [t.file ? t.file.name : 'Pasted text', `${fmt(countWords(r.text))} words`, when.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })].join(' · ')));
      const section = (title, ...kids) => h('section', { class: 'chk-print-sec' }, h('h2', null, title), kids);
      let body;
      if (id === 'ai') {
        const eligible = r.sentences.filter((s) => s.eligible);
        const reviewed = eligible.filter((s) => s.review === 'model');
        const unreviewed = eligible.filter((s) => s.review !== 'model');
        const flagged = reviewed.filter((s) => s.band !== 'few').sort((a, b) => a.start - b.start);
        const inner = [
          ...eligible.flatMap((s) => s.marks.map((m) => ({ start: m.start, end: m.end, cls: 'chk-word' }))),
          ...r.issues.map((iss) => ({ start: iss.start, end: iss.end, cls: 'chk-err' })),
        ];
        body = [
          aiScore(r, true),
          section('Your text, marked',
            aiLegend(unreviewed.length > 0, r.issues.length > 0),
            manuscript(r.text, eligible.map((s) => ({ ...s })), inner, (s) => h('span', { class: `chk-s ${cls(s)}` }))),
          section(`Sentences with AI-like patterns (${flagged.length})`,
            flagged.length
              ? h('ol', { class: 'chk-print-list' }, flagged.map((s) => h('li', null,
                h('p', { class: 'chk-print-line' }, h('span', { class: `chk-pill ${s.band}` }, BAND[s.band]), h('span', { class: 'chk-print-num' }, `${s.rating}/100`)),
                h('blockquote', { class: 'chk-quote' }, r.text.slice(s.start, s.end)),
                s.why && h('p', { class: 'chk-print-why' }, h('span', { class: 'chk-from' }, 'Model'), s.why),
                s.signals.length > 0 && h('p', { class: 'chk-print-why' }, h('span', { class: 'chk-from' }, 'Measured'), s.signals.join(' ')))))
              : h('p', { class: 'chk-empty' }, reviewed.length ? 'The model rated no reviewed sentence 40 or more.' : 'Nothing was reviewed.')),
          r.issues.length > 0 && section(`Writing suggestions (${r.issues.length})`,
            h('p', { class: 'chk-note' }, 'Suggestions from the model. Check each one before you change anything; they are separate from the pattern ratings.'),
            h('table', { class: 'chk-print-table' },
              h('thead', null, h('tr', null, h('th', null, 'Kind'), h('th', null, 'Text'), h('th', null, 'Suggested'), h('th', null, 'Why'))),
              h('tbody', null, r.issues.map((iss) => h('tr', null,
                h('td', null, iss.kind), h('td', null, h('s', null, r.text.slice(iss.start, iss.end))), h('td', null, iss.fix ? h('ins', null, iss.fix) : '–'), h('td', null, iss.note || '')))))),
          unreviewed.length > 0 && section(`Not reviewed (${unreviewed.length})`,
            h('ol', { class: 'chk-print-list compact' }, unreviewed.map((s) => h('li', null, clipText(r.text.slice(s.start, s.end), 160), h('span', { class: 'chk-note-line' }, ` ${s.unreviewedReason}`))))),
          section('How it was read', signalsPanel(r)),
        ];
      } else {
        const outer = r.spans.map((sp, k) => ({ ...sp, k }));
        body = [
          simScore(r),
          section(r.sources.length ? `Sources (${r.sources.length})` : 'No matching sources',
            r.sources.length
              ? h('ol', { class: 'chk-print-sources' }, r.sources.map((src) => {
                const tone = ((src.n - 1) % TONES) + 1;
                const meta = [KIND[src.kind], src.host, src.venue, src.year, src.authors.length ? src.authors.slice(0, 3).join(', ') + (src.authors.length > 3 ? ' et al.' : '') : ''].filter(Boolean).join(' · ');
                return h('li', null,
                  h('span', { class: `chk-badge t${tone}` }, String(src.n)),
                  h('div', null,
                    h('p', { class: 'chk-src-title' }, src.title),
                    h('p', { class: 'chk-src-meta' }, meta),
                    src.url && h('a', { class: 'chk-print-url', href: src.url }, src.url)),
                  h('span', { class: 'chk-print-num' }, `${src.percent}%`));
              }))
              : h('p', { class: 'chk-empty' }, 'Nothing Lectern could find and read matches this text. That covers paper abstracts and public web pages only.')),
          section('Your text, marked',
            h('div', { class: 'chk-legend' },
              h('span', { class: 'chk-key exact' }, 'Same wording as a source'),
              h('span', { class: 'chk-key para' }, 'Close paraphrase'),
              r.excluded.length > 0 && h('span', { class: 'chk-key out' }, 'Left out (quotation or reference list)')),
            manuscript(r.text, outer, r.excluded.map((x) => ({ start: x.start, end: x.end, cls: 'chk-out' })), (sp) => {
              const tone = ((sp.source - 1) % TONES) + 1;
              const el = h('span', { class: `chk-m t${tone}${sp.type === 'paraphrase' ? ' para' : ''}` });
              if (!outer.some((o) => o.k < sp.k && o.source === sp.source && o.end === sp.start)) el.append(h('sup', { class: `chk-n t${tone}` }, String(sp.source)));
              return el;
            })),
          r.sources.length > 0 && section('Matching passages',
            r.sources.map((src) => h('div', { class: 'chk-print-src' },
              h('h3', null, h('span', { class: `chk-badge t${((src.n - 1) % TONES) + 1}` }, String(src.n)), src.title),
              h('p', { class: 'chk-src-count' }, `${src.matches} matching passage${src.matches === 1 ? '' : 's'}, ${fmt(src.words)} words, compared with its ${src.part}.`),
              pairsFor(r, src, 60)))),
          section('What was searched',
            h('p', { class: 'chk-note' }, `${r.searched.passages} distinctive passages were searched. ${r.searched.papers} paper records and ${r.searched.pages} web pages were compared word by word.`),
            r.searched.skipped.length > 0 && h('ul', { class: 'chk-skipped' }, r.searched.skipped.map((x) => h('li', null, h('span', { class: 'chk-skip-url' }, x.url), ` — ${x.why}`))),
            h('p', { class: 'chk-note' }, TOOLS.sim.limits)),
        ];
      }
      return h('div', { class: 'chk-print', 'aria-hidden': 'true' }, head, body,
        h('footer', { class: 'chk-print-foot' }, 'Made with Lectern on this computer. Nothing was stored.'));
    }

    async function exportPdf(id, t, r, btn) {
      const base = (t.file ? t.file.name.replace(/\.[a-z0-9]{1,5}$/i, '') : 'Pasted text').slice(0, 80);
      const name = `${base} - ${id === 'ai' ? 'writing-pattern review' : 'similarity report'}.pdf`;
      document.querySelectorAll('.chk-print').forEach((e) => e.remove());
      const sheet = printReport(id, t, r);
      document.body.append(sheet);
      document.documentElement.classList.add('chk-printing');
      if (btn) btn.disabled = true;
      try {
        if (state.app && state.app.pdfExport) {
          const out = await api('POST', '/api/checks/pdf', { name });
          if (out.ok) toast('PDF saved');
          else if (!out.canceled) toast(out.error || 'Could not save the PDF');
        } else {
          // In a browser: the system print dialog, where "Save as PDF" is one of the printers.
          window.print();
        }
      } catch (e) {
        toast(e.message || 'Could not save the PDF');
      } finally {
        sheet.remove();
        document.documentElement.classList.remove('chk-printing');
        if (btn) btn.disabled = false;
      }
    }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

    return { view, draw };
  };
})();
