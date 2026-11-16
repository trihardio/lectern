// The AI score page: two separate checks on the same page.
//   AI writing  - a writing-pattern review: which sentences the selected model rates as showing generic,
//                 AI-like writing patterns, with the reasons, what was and was not reviewed, and writing
//                 suggestions anchored to the sentence they quote. Not an authorship verdict.
//   Similarity  - which passages match sources Lectern could find and read (paper abstracts, the
//                 Library, public web pages), with each source and the matching words side by side.
// Everything is built with h() (text nodes only); nothing here uses innerHTML.
(function () {
  'use strict';

  const ACCEPT = '.pdf,.docx,.odt,.rtf,.txt,.md,.html,.htm';
  const TONES = 8;
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const countWords = (s) => (String(s).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

  const TOOLS = {
    ai: {
      label: 'AI writing',
      title: 'Which sentences show AI-like writing patterns?',
      run: 'Review writing patterns',
      min: 40,
      steps: [['signals', 'Measure the writing signals'], ['model', 'Review it sentence by sentence']],
      limits: 'A writing-pattern review, not a validated AI detector. Its numbers are not probabilities that a person or a model wrote the text. Formal or carefully edited human writing can show these patterns, and short texts, edited texts and writing by non-native English speakers are judged least reliably. Do not use it as evidence against a writer.',
    },
    rewrite: {
      label: 'Rewrite',
      title: 'Rewrite for clarity and a more natural voice',
      run: 'Rewrite text',
      min: 1,
      steps: [['rewrite', 'Rewrite the passage']],
      limits: 'Review the rewrite against your original: a model can change meaning or introduce errors. Keep citations for borrowed ideas, even when rephrased. Lower scores are not guaranteed; the writing-pattern review is not a validated AI detector, and similarity checks cannot search every source.',
    },
    sim: {
      label: 'Plagiarism / similarity',
      title: 'Does this match text that already exists?',
      run: 'Check similarity',
      min: 25,
      steps: [['prepare', 'Pick distinctive passages'], ['papers', 'Search the paper databases'], ['web', 'Search the web and read pages'], ['compare', 'Compare word by word']],
      limits: 'Compares your text with paper abstracts, your Library and public web pages Lectern can find and read. It cannot see other students’ work, paywalled full texts or pages behind a sign-in, so a low score is not a clearance.',
    },
  };

  window.LecternChecks = function create(deps) {
    const { h, fill, api, toast, Motion, TOKEN, picker, state } = deps;
    const fresh = () => ({ text: '', file: null, phase: 'input', steps: {}, notices: [], result: null, error: '', abort: null, pick: null, tab: 'flags', source: null, extracting: false,
      options: { web: true, papers: true, quotes: true, references: true } });
    const st = { tool: 'ai', ai: fresh(), sim: fresh(), rewrite: fresh() };
    let aiChoice = 'codex|gpt-6.1-sol';
    try { aiChoice = localStorage.getItem('lectern.aiScoreModel') || aiChoice; } catch { /* use default */ }
    function choices() {
      return (state.app?.engines || []).flatMap((e) => {
        const ids = new Set([...(e.models || []), state.app.settings.models[e.id]]);
        if (e.id === 'codex') ids.add('gpt-6.1-sol');
        return [...ids].filter((id) => typeof id === 'string' && id.length > 0).map((id) => ({
          value: `${e.id}|${id}`, label: `${e.label} · ${id}${e.ready ? '' : ' (not connected)'}`,
        }));
      });
    }
    function selected() {
      const [engine, ...rest] = aiChoice.split('|');
      return { engine, model: rest.join('|') };
    }
    // The chosen model is never swapped for another one behind the user's back: when it is no longer offered,
    // it stays chosen, the page says so, and the check cannot start until the user picks a model.
    function modelPicker() {
      let opts = choices();
      const choice = selected();
      const known = opts.some((o) => o.value === aiChoice);
      if (!known) opts = [{ value: aiChoice, label: `${choice.model || 'default'} (not available)` }, ...opts];
      const ready = known && (state.app.engines || []).find((e) => e.id === choice.engine)?.ready;
      return h('div', { class: 'chk-model' },
        h('span', { class: 'chk-model-label' }, st.tool === 'rewrite' ? 'Rewrite model' : 'Review model'),
        picker({ label: st.tool === 'rewrite' ? 'Rewrite model' : 'AI writing review model', options: opts, value: aiChoice, cls: 'chk-model-picker', onChange: (value) => {
          aiChoice = value;
          try { localStorage.setItem('lectern.aiScoreModel', value); } catch { /* storage unavailable */ }
          draw();
        } }),
        h('span', { class: 'chk-model-help', role: ready ? null : 'status' }, ready
          ? 'Uses your connected plan. If this model is unavailable the request stops instead of switching.'
          : !known ? 'This model is no longer offered. Choose another one to run the review.' : 'This provider is not connected. Connect it in Settings or choose another model.'));
    }
    const modelReady = () => {
      const choice = selected();
      return choices().some((o) => o.value === aiChoice) && (state.app.engines || []).some((e) => e.id === choice.engine && e.ready);
    };
    const root = h('section', { class: 'view score checks' });
    let built = false;

    const cur = () => st[st.tool];
    const engineLabel = () => {
      const app = state.app || {};
      const e = (app.engines || []).find((x) => x.id === (state.compose.engine || app.activeEngine));
      return e ? e.label : null;
    };

    // ---------------------------------------------------------------- page frame

    function view() {
      if (!built) { draw(); built = true; }
      return root;
    }

    let drawnKey = '';
    function draw() {
      const t = cur();
      const key = `${st.tool}:${t.phase}`;
      const changed = built && key !== drawnKey;
      drawnKey = key;
      const oldSlip = root.querySelector('.chk-slip');
      const slipTop = !changed && oldSlip ? oldSlip.scrollTop : 0;
      fill(root,
        h('header', { class: 'chk-head' },
          h('h1', null, 'AI score'),
          toolSwitch()),
        h('div', { class: `chk-body${changed ? ' chk-enter' : ''}` }, t.phase === 'report' && t.result ? report() : t.phase === 'running' ? running() : input()));
      const slip = root.querySelector('.chk-slip');
      if (slip && slipTop) slip.scrollTop = slipTop;
    }

    function toolSwitch() {
      const group = h('div', { class: 'chk-switch', role: 'radiogroup', 'aria-label': 'Which check' },
        Object.entries(TOOLS).map(([id, tool]) => h('button', {
          type: 'button', role: 'radio', class: 'chk-tool', 'aria-checked': String(st.tool === id),
          onclick: () => { if (st.tool !== id) { st.tool = id; draw(); } },
        }, tool.label, st[id].phase === 'running' && h('span', { class: 'chk-busy', 'aria-label': 'running' }),
        id !== 'rewrite' && st[id].phase === 'report' && st[id].result && h('span', { class: 'chk-tool-score' }, scoreText(id)))));
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
      const runBtn = h('button', { type: 'button', class: 'btn primary chk-run', onclick: start }, tool.run);
      const ready = () => { const n = countWords(t.text); runBtn.disabled = n < tool.min || t.extracting || (st.tool !== 'sim' && !modelReady()) || (st.tool === 'rewrite' && t.text.length > 12000); count.textContent = `${fmt(n)} words${n && n < tool.min ? ` · at least ${tool.min} needed` : ''}${st.tool === 'rewrite' ? ` · ${fmt(t.text.length)} / 12,000 characters` : ''}`; };
      const area = h('textarea', {
        class: 'chk-text', 'aria-label': 'Text to check', spellcheck: 'false',
        placeholder: 'Paste your text here, or drop a PDF, Word, OpenDocument or text file anywhere on this sheet.',
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
        h('button', { type: 'button', class: 'btn small', onclick: () => picker.click(), disabled: t.extracting }, 'Choose a file'), picker),
      area,
      h('div', { class: 'chk-drop', 'aria-hidden': 'true' }, h('span', null, 'Drop to read the document')));
      requestAnimationFrame(ready);

      return h('div', { class: 'chk-input' },
        h('p', { class: 'chk-lede' }, tool.title),
        st.tool !== 'sim' && modelPicker(),
        sheet,
        t.error && h('p', { class: 'chk-error', role: 'alert' }, t.error),
        st.tool === 'sim' && simOptions(t),
        h('div', { class: 'chk-actions' }, runBtn, count,
          h('span', { class: 'chk-who' }, whoLine())),
        h('p', { class: 'chk-limits' }, tool.limits),
        st.tool === 'sim' && h('p', { class: 'chk-limits' }, 'Distinctive phrases from your text are sent as searches to the paper databases and, with web search on, to your model’s web search. Lectern itself keeps nothing.'));
    }

    function whoLine() {
      const eng = engineLabel();
      if (st.tool !== 'sim') return `Your text is sent to the selected model through your plan${st.tool === 'ai' ? ', in parts' : ''}. Lectern saves nothing.`;
      return eng ? `Paper databases, your Library, and the web through ${eng}. Nothing is saved.` : 'No model connected: paper databases and Library only.';
    }

    function simOptions(t) {
      const sw = (key, label, help) => h('label', { class: 'filter-switch chk-opt' },
        h('span', null, h('span', { class: 'chk-opt-name' }, label), h('span', { class: 'chk-opt-help' }, help)),
        h('input', { type: 'checkbox', role: 'switch', checked: t.options[key], onchange: (e) => { t.options[key] = e.target.checked; } }));
      return h('fieldset', { class: 'chk-opts' }, h('legend', null, 'What to compare'),
        sw('papers', 'Paper databases and Library', 'Titles and abstracts from OpenAlex, Semantic Scholar, Crossref and Europe PMC'),
        sw('web', 'Search the web', 'Your model searches for distinctive passages; each page is fetched and compared here'),
        sw('quotes', 'Leave out quotations', 'Text inside quotation marks does not count'),
        sw('references', 'Leave out the reference list', 'Everything after a References or Bibliography heading'));
    }

    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

    async function loadFile(file) {
      const t = cur();
      if (file.size > 12 * 1024 * 1024) { t.error = 'That file is larger than 12 MB. Paste the text instead.'; draw(); return; }
      t.error = '';
      t.extracting = true;
      draw();
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const r = await api('POST', '/api/checks/extract', { name: file.name, data: btoa(bin) });
        t.text = r.text;
        t.file = { name: file.name, kind: r.kind };
      } catch (e) {
        t.error = e.message;
      }
      t.extracting = false;
      draw();
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
          body: JSON.stringify({ text: t.text, options: t.options, ...(id !== 'sim' ? selected() : { engine: state.compose.engine }) }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
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
            if (ev && data) onEvent(id, ev[1], JSON.parse(data[1]));
          }
        }
        if (!t.result && !t.error) t.error = 'The check stopped before it finished.';
      } catch (e) {
        if (e.name !== 'AbortError') t.error = e.message;
      }
      t.abort = null;
      t.phase = t.result ? 'report' : 'input';
      if (st.tool === id) draw();
      if (t.result && st.tool !== id) toast(`${TOOLS[id].label} check finished`);
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
        h('button', { type: 'button', class: 'btn', onclick: () => { const t = cur(); if (t.abort) t.abort.abort(); } }, 'Stop'));
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
      const other = st.tool === 'ai' ? 'sim' : 'ai';
      const bar = h('div', { class: 'chk-bar' },
        h('button', { type: 'button', class: 'btn', onclick: () => { t.phase = 'input'; draw(); } }, 'Edit text'),
        h('button', { type: 'button', class: 'btn', onclick: () => { st[st.tool] = fresh(); draw(); } }, 'New check'),
        h('button', { type: 'button', class: 'btn', onclick: () => copyReport(st.tool, r) }, 'Copy report'),
        h('button', { type: 'button', class: 'btn', onclick: (e) => exportPdf(st.tool, t, r, e.currentTarget) }, 'Export PDF'),
        st.tool === 'sim' && r.spans.length > 0 && h('button', { type: 'button', class: 'btn', onclick: (e) => quoteAndCite(t, r, e.currentTarget) }, 'Quote and cite matches'),
        h('button', { type: 'button', class: 'btn', onclick: () => transfer('rewrite', r.text, t.file) }, 'Rewrite this text'),
        h('button', { type: 'button', class: 'chk-link chk-cross', onclick: () => { if (st[other].phase === 'running' || st[other].extracting) { st.tool = other; draw(); return; } st[other] = { ...fresh(), text: r.text, file: t.file, options: st[other].options }; st.tool = other; draw(); } },
          st.tool === 'ai' ? 'Check this text for similarity' : 'Check this text for AI writing'));
      const page = st.tool === 'ai' ? aiReport(t, r) : simReport(t, r);
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
      if (st[id].phase === 'running' || st[id].extracting) { st.tool = id; draw(); toast('A task is already running in this tool'); return; }
      st[id] = { ...fresh(), text, file: file || null, options: st[id].options };
      st.tool = id;
      draw();
    }

    function rewriteReport(t, r) {
      const output = h('textarea', { class: 'chk-text chk-rewrite-output', 'aria-label': 'Rewritten text', oninput: (e) => { r.text = e.target.value; } });
      output.value = r.text;
      return h('div', { class: 'chk-rewrite' },
        h('div', { class: 'chk-bar' },
          h('button', { type: 'button', class: 'btn', onclick: () => { t.phase = 'input'; draw(); } }, 'Edit original'),
          h('button', { type: 'button', class: 'btn', onclick: () => { st.rewrite = fresh(); draw(); } }, 'Start over'),
          h('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(r.text).then(() => toast('Rewrite copied'), () => toast('Could not copy the rewrite')) }, 'Copy rewrite'),
          h('button', { type: 'button', class: 'btn', onclick: () => transfer('ai', r.text) }, 'Review writing patterns'),
          h('button', { type: 'button', class: 'btn', onclick: () => transfer('sim', r.text) }, 'Check similarity')),
        h('p', { class: 'chk-limits' }, TOOLS.rewrite.limits),
        r.check && (r.check.ok
          ? h('p', { class: 'chk-check ok', role: 'status' }, h('b', null, 'Checked. '), `Every number, name and acronym from the original is still there, nothing new was added${r.protectedCount ? `, and all ${r.protectedCount} quotations and citations are unchanged` : ''}.${r.attempts > 1 ? ' (The first attempt changed a fact, so it was redone.)' : ''}`)
          : h('p', { class: 'chk-check bad', role: 'alert' }, h('b', null, 'Check the rewrite. '), r.check.missing.length ? `It dropped: ${r.check.missing.join(', ')}. ` : '', r.check.added.length ? `It added: ${r.check.added.join(', ')}. ` : '', 'This happened twice, so it is shown for you to fix by hand.')),
        h('p', { class: 'chk-note' }, 'Compare the original and rewrite, especially facts, qualifications, quotations and citations. Scores are not measured by rewriting; run the checks to see their results.'),
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

    function tabs(t, list) {
      const group = h('div', { class: 'chk-tabs', role: 'tablist' }, list.map(([id, label, n]) => h('button', {
        type: 'button', role: 'tab', class: 'chk-tab', 'aria-selected': String(t.tab === id), 'aria-checked': String(t.tab === id),
        onclick: () => { if (t.tab !== id) { t.tab = id; draw(); } },
      }, label, n != null && h('span', { class: 'chk-tab-n' }, fmt(n)))));
      return Motion.slide(group, `checks-tabs-${st.tool}`);
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
      const ms = manuscript(r.text, eligible.map((s) => ({ ...s })), inner, (s) => h('span', {
        class: `chk-s ${cls(s)}${t.pick === s.i ? ' picked' : ''}`, 'data-s': s.i, tabindex: '0', role: 'button',
        'aria-label': sentenceSay(s),
        onclick: () => pickSentence(t, s.i), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSentence(t, s.i); } },
      }));

      const pick = t.pick != null ? r.sentences.find((s) => s.i === t.pick && s.eligible) : null;
      const tabList = [['flags', 'Patterns', flagged.length], ['mistakes', 'Suggestions', r.issues.length]];
      if (unreviewed.length) tabList.push(['unreviewed', 'Not reviewed', unreviewed.length]);
      tabList.push(['signals', 'How it was read']);
      if (t.tab === 'unreviewed' && !unreviewed.length) t.tab = 'flags';
      const slip = h('aside', { class: 'chk-slip' },
        aiScore(r),
        pick && sentenceCard(r, pick),
        tabs(t, tabList),
        t.tab === 'flags' ? flagList(t, r, flagged, reviewed.length, unreviewed.length)
          : t.tab === 'mistakes' ? mistakeList(t, r)
            : t.tab === 'unreviewed' ? unreviewedList(t, r, unreviewed) : signalsPanel(r));

      return h('div', { class: 'chk-report ai' },
        h('div', { class: 'chk-ms-wrap' },
          h('div', { class: 'chk-legend' },
            h('span', { class: 'chk-key strong' }, 'Strong patterns (rated 65+)'),
            h('span', { class: 'chk-key some' }, 'Some patterns (40–64)'),
            unreviewed.length > 0 && h('span', { class: 'chk-key unreviewed' }, 'Not reviewed'),
            h('span', { class: 'chk-key word' }, 'Word or phrase that became common after ChatGPT'),
            r.issues.length > 0 && h('span', { class: 'chk-key err' }, 'Writing suggestion')),
          ms),
        slip);
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

    function aiScore(r) {
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
        h('p', { class: 'chk-readby' }, modelLine(r)),
        r.style && styleLine(r.style),
        r.summary && h('p', { class: 'chk-summary' }, h('span', { class: 'chk-from' }, 'Model'), r.summary),
        r.notes.filter((n) => !/^The model reviewed/.test(n)).map((n) => h('p', { class: 'chk-note' }, n)),
        h('ul', { class: 'chk-limits-list', 'aria-label': 'Limits of this review' }, r.limits.map((x) => h('li', null, x))));
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

    function pickSentence(t, i) {
      t.pick = t.pick === i ? null : i;
      draw();
      if (t.pick != null) selectInText(`.chk-s[data-s="${i}"]`);
    }

    function flagList(t, r, flagged, reviewedCount, unreviewedCount) {
      if (!flagged.length) {
        return h('p', { class: 'chk-empty' }, !reviewedCount
          ? 'Nothing was reviewed, so no sentence has a rating.'
          : `The model rated none of the ${reviewedCount} reviewed sentences 40 or more. This describes writing patterns, not who wrote the text.${unreviewedCount ? ` ${unreviewedCount} sentences were not reviewed.` : ''}`);
      }
      return h('ol', { class: 'chk-list' }, flagged.slice(0, 120).map((s) => h('li', null, h('button', {
        type: 'button', class: `chk-item${t.pick === s.i ? ' on' : ''}`, onclick: () => pickSentence(t, s.i), 'aria-label': `${sentenceSay(s)} ${clipText(r.text.slice(s.start, s.end), 140)}`,
      },
      h('span', { class: `chk-dot ${s.band}`, 'aria-hidden': 'true' }),
      h('span', { class: 'chk-item-text' }, clipText(r.text.slice(s.start, s.end), 140)),
      h('span', { class: 'chk-item-score', 'aria-hidden': 'true' }, `${s.rating}`)))));
    }

    function unreviewedList(t, r, list) {
      return h('ol', { class: 'chk-list' }, list.slice(0, 200).map((s) => h('li', null, h('button', {
        type: 'button', class: `chk-item${t.pick === s.i ? ' on' : ''}`, onclick: () => pickSentence(t, s.i), 'aria-label': `${sentenceSay(s)} ${clipText(r.text.slice(s.start, s.end), 140)}`,
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
        h('p', { class: 'chk-note' }, 'Lectern cannot measure perplexity (how predictable each word is to a model), which dedicated detectors use; the models on your plan do not expose it.'),
        h('ul', { class: 'chk-limits-list' }, r.limits.map((x) => h('li', null, x))));
    }

    // ---------------------------------------------------------------- similarity report

    function simReport(t, r) {
      const outer = r.spans.map((sp, k) => ({ ...sp, k }));
      const inner = r.excluded.map((x) => ({ start: x.start, end: x.end, cls: 'chk-out' }));
      const ms = manuscript(r.text, outer, inner, (sp) => {
        const tone = ((sp.source - 1) % TONES) + 1;
        const el = h('span', {
          class: `chk-m t${tone}${sp.type === 'paraphrase' ? ' para' : ''}${t.source && t.source !== sp.source ? ' dim' : ''}${t.source === sp.source ? ' lit' : ''}`,
          'data-src': sp.source, 'data-k': sp.k, tabindex: '0', role: 'button',
          'aria-label': `${sp.type === 'exact' ? 'Matches' : 'Close paraphrase of'} source ${sp.source}`,
          onclick: () => pickSource(t, sp.source, sp.k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSource(t, sp.source, sp.k); } },
        });
        if (!outer.some((o) => o.k < sp.k && o.source === sp.source && o.end === sp.start)) el.append(h('sup', { class: `chk-n t${tone}`, 'aria-hidden': 'true' }, String(sp.source)));
        return el;
      });

      const slip = h('aside', { class: 'chk-slip' },
        simScore(r),
        h('h2', { class: 'chk-h2' }, r.sources.length ? 'Sources' : 'No matching sources'),
        r.sources.length ? h('ol', { class: 'chk-sources' }, r.sources.map((s) => sourceRow(t, r, s))) : h('p', { class: 'chk-empty' }, 'Nothing Lectern could find and read matches this text. That covers paper abstracts and public web pages only.'),
        searchedNote(r));

      return h('div', { class: 'chk-report sim' },
        h('div', { class: 'chk-ms-wrap' },
          h('div', { class: 'chk-legend' },
            h('span', { class: 'chk-key exact' }, 'Same wording as a source'),
            h('span', { class: 'chk-key para' }, 'Close paraphrase'),
            r.excluded.length > 0 && h('span', { class: 'chk-key out' }, 'Left out (quotation or reference list)')),
          ms),
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
      const row = h('li', { class: `chk-src${on ? ' on' : ''}` },
        h('button', { type: 'button', class: 'chk-src-btn', 'aria-expanded': String(on), onclick: () => pickSource(t, s.n) },
          h('span', { class: `chk-badge t${tone}` }, String(s.n)),
          h('span', { class: 'chk-src-text' }, h('span', { class: 'chk-src-title' }, s.title), h('span', { class: 'chk-src-meta' }, meta)),
          h('span', { class: 'chk-src-pct' }, `${s.percent}%`, h('span', { class: `chk-src-bar t${tone}`, style: `--w:${Math.min(100, s.percent)}%` }))),
        on && h('div', { class: 'chk-src-more' },
          s.url && h('a', { class: 'chk-open', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.kind === 'web' ? 'Open the page' : 'Open the paper'),
          h('p', { class: 'chk-src-count' }, `${s.matches} matching passage${s.matches === 1 ? '' : 's'}, ${fmt(s.words)} words, compared with its ${s.part}.`),
          pairsFor(r, s, 30)));
      return row;
    }

    /** Your words beside the source's words, for each passage that matches source `s`. */
    function pairsFor(r, s, max) {
      const tone = ((s.n - 1) % TONES) + 1;
      return h('ol', { class: 'chk-pairs' }, r.spans.filter((sp) => sp.source === s.n).slice(0, max).map((sp) => h('li', { class: 'chk-pair' },
        h('div', { class: 'chk-side' }, h('span', { class: 'chk-side-label' }, 'Your text'), h('p', null, h('mark', { class: `t${tone}` }, r.text.slice(sp.start, sp.end)))),
        h('div', { class: 'chk-side' }, h('span', { class: 'chk-side-label' }, sp.type === 'exact' ? 'Source' : `Source · paraphrase, ${sp.similarity || ''}% of content words shared`),
          h('p', null, sp.excerpt.before && `…${sp.excerpt.before}`, h('mark', { class: `t${tone}` }, sp.excerpt.match), sp.excerpt.after && `${sp.excerpt.after}…`)))));
    }

    function pickSource(t, n, k) {
      t.source = t.source === n ? (k != null ? n : null) : n;
      draw();
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
      navigator.clipboard.writeText(out).then(() => toast('Report copied'), () => toast('Could not copy the report'));
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
          aiScore(r),
          section('Your text, marked',
            h('div', { class: 'chk-legend' },
              h('span', { class: 'chk-key strong' }, 'Strong patterns (rated 65+)'),
              h('span', { class: 'chk-key some' }, 'Some patterns (40–64)'),
              unreviewed.length > 0 && h('span', { class: 'chk-key unreviewed' }, 'Not reviewed'),
              h('span', { class: 'chk-key word' }, 'Word or phrase that became common after ChatGPT'),
              r.issues.length > 0 && h('span', { class: 'chk-key err' }, 'Writing suggestion')),
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
