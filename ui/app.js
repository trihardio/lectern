// The window's logic: state, rendering, and talking to the local server.
// Plain DOM code, no framework and no build step — edit and reload.
(function () {
  'use strict';

  const TOKEN = document.querySelector('meta[name="lectern-token"]').content;
  const Cite = window.LecternCite;
  const Render = window.LecternRender;
  if (/Electron/i.test(navigator.userAgent)) document.documentElement.classList.add('is-desktop');

  // ------------------------------------------------------------------ helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only ever fed output of render.js, which escapes everything
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  /** Replace an element's children, accepting the same nested arrays and falsy values as h(). */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity)
      .filter((k) => k != null && k !== false)
      .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
    return el;
  }

  // ------------------------------------------------------------------ motion
  // Lectern's motion, carried over from the owner's Flow app (vault note "Motion carried over from Flow").
  // Two curves: --ease for things that arrive and settle, --ease-soft for things that slide. Utility moves
  // take 0.22-0.34 s, openings 0.42-0.56 s; never make one quicker to fit a rule. Nothing animates when it is
  // first drawn, only when it changes. The page is rebuilt often, so each helper remembers the last value
  // under a name and carries an animation that is under way across a rebuild instead of restarting or
  // cutting it. With Reduce motion every helper puts the end state in place at once.
  const Motion = (() => {
    const calmQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const calm = () => !!(calmQuery && calmQuery.matches);
    const now = () => performance.now();

    // Memory: (an object such as a turn, or a string scope) + a name -> the last value.
    const objMem = new WeakMap();
    const strMem = new Map();
    function slot(owner, name) {
      if (owner && typeof owner === 'object') {
        if (!objMem.has(owner)) objMem.set(owner, new Map());
        return [objMem.get(owner), name];
      }
      return [strMem, `${owner}\u0000${name}`];
    }
    const recall = (owner, name) => { const [m, k] = slot(owner, name); return m.get(k); };
    const keep = (owner, name, v) => { const [m, k] = slot(owner, name); m.set(k, v); };

    /** Did this value change since the last call? The first call says no, so first drawings stay still. */
    function changed(owner, name, value) {
      const [m, k] = slot(owner, name);
      const had = m.has(k);
      const was = m.get(k);
      m.set(k, value);
      return had && was !== value;
    }

    /**
     * How long ago did this value change? A number of ms when it changed within `within` ms (0 right at the
     * change), otherwise null, and null the first time a value is seen. A page that is rebuilt keeps a keyframe
     * animation going by giving the new element `--age`, which the CSS turns into a negative delay.
     */
    function age(owner, name, value, within = 700) {
      const [m, k] = slot(owner, name);
      const st = m.get(k);
      const t = now();
      if (!st || typeof st !== 'object' || !('seen' in st)) { m.set(k, { seen: true, v: value, t: -Infinity }); return null; }
      if (st.v !== value) { m.set(k, { seen: true, v: value, t }); return 0; }
      const a = t - st.t;
      return a < within ? a : null;
    }

    /** Is this id new in a list that is already on screen? Whatever the first list in a scope holds is old. */
    const scopes = new Map();
    function appeared(scope, id, within = 420) {
      let s = scopes.get(scope);
      if (!s) { s = { ids: new Map(), ready: false }; scopes.set(scope, s); }
      if (!s.ids.has(id)) s.ids.set(id, s.ready ? now() : -Infinity);
      const a = now() - s.ids.get(id);
      return a < within ? a : null; // null: it was there from the start, or it appeared a while ago
    }
    /** Call after the first drawing of a list: from here on, an id that was not there before is new. */
    function settle(scope) {
      let s = scopes.get(scope);
      if (!s) { s = { ids: new Map(), ready: true }; scopes.set(scope, s); }
      s.ready = true;
    }

    /** Fade and rise in, `i` steps after the first of a group (Flow's day tiles: 18 ms apart). */
    function enter(el, i = 0, ageMs = 0) {
      if (calm() || !el) return el;
      el.classList.add('enter');
      el.style.setProperty('--i', String(Math.min(i, 12)));
      if (ageMs > 0) el.style.setProperty('--age', String(Math.round(ageMs)));
      return el;
    }

    /** Play a one-off animation class on an element (restarting it), then take the class off again. */
    function play(el, cls, ms = 700) {
      if (!el || calm()) return el;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), ms);
      return el;
    }

    /** A chip, badge or button that has just appeared pops in (when `when`), and carries on across a rebuild. */
    function pop(el, owner, name, value, when = true, cls = 'pop-in') {
      const a = age(owner, name, value);
      if (when && a != null && el && !calm()) { el.classList.add(cls); el.style.setProperty('--age', String(Math.round(a))); }
      return el;
    }

    /** Take an element out with a short fade (a menu that closes). It cannot be clicked or focused meanwhile. */
    function leave(el, ms = 170) {
      if (!el) return;
      if (calm() || !el.isConnected) { el.remove(); return; }
      el.classList.add('leaving');
      el.setAttribute('inert', '');
      setTimeout(() => el.remove(), ms);
    }

    /** A figure that counts to its new value (Flow's Num), written straight into the element each frame. */
    function count(el, owner, name, value, format = (n) => String(Math.round(n)), ms = 560) {
      const at = (s, t) => {
        const p = Math.min(1, (t - s.t0) / ms);
        return s.from + (s.to - s.from) * (1 - (1 - p) ** 3);
      };
      let st = recall(owner, name);
      if (!st || !Number.isFinite(value) || !Number.isFinite(st.to)) st = { from: value, to: value, t0: -Infinity };
      else if (st.to !== value) st = { from: at(st, now()), to: value, t0: now() };
      keep(owner, name, st);
      el.textContent = format(value);
      if (calm() || now() - st.t0 >= ms) return el;
      el.textContent = format(at(st, now()));
      let waits = 0;
      const step = (t) => {
        if (recall(owner, name) !== st) return; // a newer count took over
        if (!el.isConnected && waits++ > 2) return; // replaced by a rebuild, which carries on from here
        const done = t - st.t0 >= ms;
        el.textContent = format(done ? st.to : at(st, t));
        if (!done) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return el;
    }

    // A word that changes rolls (Flow's RollWord): the old letters leave one after another, then the new
    // letters come in the same way. Spaces keep their width (.rollw is white-space: pre).
    const RW_STEP = 24, RW_OUT = 150, RW_SPREAD = 130, RW_IN = 340;
    function roll(el, owner, name, text, up = true) {
      text = String(text);
      let st = recall(owner, name);
      const t = now();
      if (!st) st = { text, old: null, t0: -Infinity };
      else if (st.text !== text) st = { text, old: st.text, t0: t };
      keep(owner, name, st);
      const gone = st.old == null ? 0 : RW_OUT + Math.min(RW_STEP * (st.old.length - 1), RW_SPREAD);
      const inEach = Math.min(RW_STEP, 260 / Math.max(1, text.length - 1)); // a long phrase sweeps in no more than ~260 ms
      const total = gone + inEach * Math.max(0, text.length - 1) + RW_IN;
      const elapsed = t - st.t0;
      if (calm() || st.old == null || elapsed >= total || text.length > 48 || st.old.length > 48) {
        el.textContent = text;
        return el;
      }
      const outEach = Math.min(RW_STEP, RW_SPREAD / Math.max(1, st.old.length - 1));
      const letters = (word, cls, base, each) => [...word].map((ch, i) =>
        h('span', { class: cls, style: `animation-delay:${Math.round(base + i * each - elapsed)}ms` }, ch));
      el.classList.add('rollw');
      el.style.setProperty('--ry', up ? '65%' : '-65%');
      el.setAttribute('aria-label', text);
      fill(el,
        h('span', { class: 'rollw-old', 'aria-hidden': 'true' }, letters(st.old, 'rw-out', 0, outEach)),
        h('span', { 'aria-hidden': 'true' }, letters(text, 'rw-in', gone, inEach)));
      // when it has finished, go back to plain text (an ellipsis works again, and the page holds fewer nodes)
      setTimeout(() => {
        if (recall(owner, name) === st && el.isConnected) { el.classList.remove('rollw'); el.removeAttribute('aria-label'); el.textContent = text; }
      }, Math.max(0, total - elapsed) + 80);
      return el;
    }

    /** A line whose words changed fades up into place (Flow's SetSay). Never on first drawing. */
    function say(el, owner, name, text) {
      if (changed(owner, name, String(text)) && !calm() && el.animate) {
        el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      return el;
    }

    // A row of choices whose picked look is one box that slides to the choice (Flow's SlideSeg and Pick).
    // The row's choices are its children; the picked one has aria-checked="true" or the class "on". The box
    // remembers where it was under `name`, so a row that is drawn again slides from the old choice.
    const same = (a, b) => !!(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
    function slide(group, name) {
      group.dataset.slide = name;
      requestAnimationFrame(() => placeSlide(group, name, true));
      return group;
    }
    function placeSlide(group, name, fromMemory) {
      if (!group.isConnected) return;
      let box = group.querySelector(':scope > .slide-box');
      if (!box) {
        box = h('i', { class: 'slide-box', 'aria-hidden': 'true' });
        group.append(box); // last, so code that counts the choices by index is not thrown off
        group.classList.add('slide-ready');
        if (window.ResizeObserver) new ResizeObserver(() => placeSlide(group, name, false)).observe(group);
      }
      const on = [...group.children].find((c) => c !== box && (c.getAttribute('aria-checked') === 'true' || c.classList.contains('on') || c.classList.contains('active')));
      if (!on) { box.style.opacity = '0'; box._at = null; keep('slide', name, null); return; }
      const r = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
      if (!fromMemory && same(box._at, r)) return;
      const put = (q) => { box.style.transform = `translate(${q.x}px, ${q.y}px)`; box.style.width = `${q.w}px`; box.style.height = `${q.h}px`; };
      const rec = fromMemory ? recall('slide', name) : null;
      const was = rec && now() - rec.t < 1500 ? rec : null; // a memory from long ago (a dialog opened again) is not slid from
      box.classList.remove('go');
      if (was && !same(was, r) && !calm()) {
        put(was);
        box.style.opacity = '1';
        void box.offsetWidth; // commit the old place before moving
        box.classList.add('go');
        put(r);
        on.classList.add('slide-arrive');
        setTimeout(() => on.classList.remove('slide-arrive'), 400);
      } else {
        put(r);
        box.style.opacity = '1';
        void box.offsetWidth;
        box.classList.add('go');
      }
      box._at = r;
      keep('slide', name, { ...r, t: now() });
    }

    /** A highlight that glides to the item under the pointer or keyboard focus, and fades when it leaves. */
    function glide(container, itemSel) {
      if (container._glide || calm() || !window.matchMedia('(hover: hover)').matches) return container;
      container._glide = true;
      container.classList.add('has-glide');
      const box = h('i', { class: 'glide-box', 'aria-hidden': 'true' });
      let shown = false;
      const to = (item) => {
        if (box.parentNode !== container) container.append(box); // the list was refilled
        if (!item) { box.style.opacity = '0'; shown = false; return; }
        const q = () => {
          box.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
          box.style.width = `${item.offsetWidth}px`;
          box.style.height = `${item.offsetHeight}px`;
        };
        if (!shown || calm()) { box.classList.remove('go'); q(); void box.offsetWidth; box.classList.add('go'); }
        else q();
        box.style.opacity = '1';
        shown = true;
      };
      const pick = (target) => {
        const it = target && target.closest ? target.closest(itemSel) : null;
        return it && container.contains(it) && !it.matches(':disabled, [aria-disabled="true"]') ? it : null;
      };
      container.addEventListener('pointerover', (e) => { const it = pick(e.target); if (it) to(it); });
      container.addEventListener('pointerleave', () => to(null));
      container.addEventListener('focusin', (e) => { const it = pick(e.target); if (it && e.target.matches(':focus-visible')) to(it); });
      container.addEventListener('focusout', (e) => { if (!container.contains(e.relatedTarget)) to(null); });
      return container;
    }

    // The answer while it streams: each new stretch of text fades in over STREAM_MS, so words appear as
    // they arrive instead of all at once. The answer element is rebuilt on every update; the stretches
    // still fading are remembered by their place in the text and given a negative delay on the new
    // element, so a stretch keeps fading where it was instead of jumping to full.
    const STREAM_MS = 520;
    function stream(root, owner, name = 'stream') {
      const a = root && (root.classList && root.classList.contains('answer') ? root : root.querySelector && root.querySelector('.answer'));
      if (!a) return root;
      const t = now();
      const len = a.textContent.length;
      const st = recall(owner, name) || { len: 0, pieces: [] }; // one memory per part of the answer (the brief, the body)
      const pieces = st.pieces.filter((p) => t - p.t0 < STREAM_MS && p.from < len).map((p) => ({ ...p, to: Math.min(p.to, len) }));
      if (len > st.len) pieces.push({ from: st.len, to: len, t0: t });
      keep(owner, name, { len, pieces });
      if (calm() || !pieces.length) return root;
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
      let pos = 0;
      for (const node of nodes) {
        const text = node.nodeValue;
        const start = pos;
        const end = pos + text.length;
        pos = end;
        const hits = pieces.filter((p) => p.to > start && p.from < end).sort((x, y) => x.from - y.from);
        if (!hits.length) continue;
        const frag = document.createDocumentFragment();
        let cur = start;
        for (const p of hits) {
          const s = Math.max(p.from, cur);
          const e = Math.min(p.to, end);
          if (s >= e) continue;
          if (s > cur) frag.append(text.slice(cur - start, s - start));
          frag.append(h('span', { class: 'tok-in', style: `animation-delay:${Math.round(p.t0 - t)}ms` }, text.slice(s - start, e - start)));
          cur = e;
        }
        if (cur < end) frag.append(text.slice(cur - start));
        node.replaceWith(frag);
      }
      return root;
    }

    // Opening a <details> by hand eases its content in (rebuilt, already-open ones stay still).
    let lastSummary = 0;
    document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('summary')) lastSummary = now(); }, true);
    document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('summary')) lastSummary = now(); }, true);
    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.open || calm() || now() - lastSummary > 500) return;
      for (const kid of d.children) {
        if (kid.tagName === 'SUMMARY' || !kid.animate) continue;
        kid.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
    }, true);

    // The dialog closes with a short fade (Escape too) instead of vanishing.
    const nativeClose = HTMLDialogElement.prototype.close;
    function animateDialog(d) {
      if (d._motion) return;
      d._motion = true;
      d.close = function (value) {
        if (!d.open || d._closing) return;
        if (calm()) { nativeClose.call(d, value); return; }
        d._closing = true;
        d.classList.add('closing');
        d._closeTimer = setTimeout(() => {
          d.classList.remove('closing');
          d._closing = false;
          nativeClose.call(d, value);
        }, 190);
      };
      d.addEventListener('cancel', (e) => { e.preventDefault(); d.close(); });
    }
    /** Opening the dialog again while it is still fading out keeps it open. */
    function keepDialogOpen(d) {
      if (!d._closing) return;
      clearTimeout(d._closeTimer);
      d._closing = false;
      d.classList.remove('closing');
    }

    return { calm, changed, age, appeared, settle, enter, play, pop, leave, count, roll, say, slide, glide, stream, animateDialog, keepDialogOpen };
  })();

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'x-lectern-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    const replacing = t.classList.contains('show') && t.textContent !== msg;
    t.textContent = msg;
    t.classList.add('show');
    // a new message while one is showing: the words fade up into place instead of being swapped in one frame
    if (replacing && !Motion.calm() && t.animate) {
      t.animate([{ opacity: 0.2, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }],
        { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function copyRich(out, label) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([out.text], { type: 'text/plain' }),
          'text/html': new Blob([out.html || out.text], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(out.text);
      }
      toast(label || 'Copied');
    } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = out.text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? (label || 'Copied') : 'Could not copy. Select the text and copy it by hand.');
    }
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const MODEL_NAMES = {
    'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-2': 'Claude Fable 5.2',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5',
    opus: 'Opus (latest)', sonnet: 'Sonnet (latest)', haiku: 'Haiku (latest)', fable: 'Fable (latest)',
    'gpt-6-astra': 'GPT-6 Astra', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6-luna': 'GPT-6 Luna',
  };
  const prettyModel = (id, engine) => MODEL_NAMES[id] || id || (engine === 'codex' ? 'Codex default' : 'Default');
  const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
  const STANCE_LABEL = { supports: 'Supports', conditional: 'Conditional', mixed: 'Mixed', against: 'Against', na: 'Not tested' };
  const nf = new Intl.NumberFormat('en');
  const isWebUrl = (u) => /^https?:\/\//i.test(u || '');

  // ------------------------------------------------------------------ state
  /** Every search filter, switched off. The server (server/filters.js) cleans whatever is sent. */
  function noFilters() {
    return {
      yearFrom: '', yearTo: '', minCitations: '', oaOnly: false, noPreprints: false, journalMin: 0,
      designs: [], minSample: '', fields: [], venues: '',
    };
  }

  const S = {
    app: null, // { settings, engines, activeEngine, efforts, sources, dataDir }
    threads: [],
    library: [],
    view: 'home', // home | thread | library
    thread: null, // { id, title, turns }
    live: null, // the question currently being answered (or the last one that failed)
    liveView: null,
    compose: {
      engine: '', model: '', effort: 'medium', web: false, dockOpen: false, draft: '',
      mode: 'answer', // which tool the next request uses (the list comes from the server: S.app.modes)
      filters: noFilters(),
    },
    shelf: new WeakMap(), // per-turn { sort, citedOnly }
    referencesOpen: false,
    referenceTurn: null,
    libraryQuery: '',
    editing: null, // id of the question being edited in place
    renaming: null, // id of the conversation being renamed in the sidebar
  };

  // ------------------------------------------------------------------ conversation tree
  // A thread is a tree: each turn names its `parent`. Editing or retrying a question adds a
  // sibling (a new version). `thread.leaf` is the last turn of the branch on screen.
  // Same rules as server/store.js.
  function pathTo(thread, id) {
    const byId = new Map(thread.turns.map((t) => [t.id, t]));
    const out = [];
    for (let t = byId.get(id); t && out.length <= byId.size; t = byId.get(t.parent)) out.unshift(t);
    return out;
  }
  function newestLeaf(thread, id) {
    let cur = id;
    for (;;) {
      const kids = thread.turns.filter((t) => t.parent === cur);
      if (!kids.length) return cur;
      cur = kids[kids.length - 1].id;
    }
  }
  const versionsOf = (thread, turn) => thread.turns.filter((t) => t.parent === turn.parent);
  const isBusy = () => !!(S.live && S.live.running);

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('lectern.compose') || '{}');
      for (const k of ['engine', 'model', 'effort', 'web']) if (saved[k] != null) S.compose[k] = saved[k];
      if (saved.filters) {
        const f = S.compose.filters;
        for (const k of Object.keys(f)) {
          const v = saved.filters[k];
          if (Array.isArray(f[k])) { if (Array.isArray(v)) f[k] = v.map(String); } else if (v != null && typeof v === typeof f[k]) f[k] = v;
        }
        // The older "reviews and meta-analyses only" switch is now a study-design choice.
        if (saved.filters.reviewsOnly && !f.designs.length) f.designs = ['Meta-analysis', 'Systematic review', 'Review'];
      }
    } catch { /* storage unavailable: use defaults */ }
  }
  function savePrefs() {
    try {
      const { engine, model, effort, web, filters } = S.compose;
      localStorage.setItem('lectern.compose', JSON.stringify({ engine, model, effort, web, filters }));
    } catch { /* ignore */ }
  }

  const engineInfo = (id) => (S.app.engines.find((e) => e.id === id) || null);

  /** Make sure the composer points at an engine that is ready, and a model that belongs to it. */
  function settleCompose() {
    const c = S.compose;
    const chosen = engineInfo(c.engine);
    if (!chosen || !chosen.ready) {
      c.engine = S.app.activeEngine || '';
      c.model = S.app.settings.models[c.engine] || '';
    }
    if (!S.app.efforts.includes(c.effort)) c.effort = S.app.settings.effort;
  }

  function modelChoices(engineId) {
    const info = engineInfo(engineId);
    const ids = new Set([...(info ? info.models : [])]);
    const configured = S.app.settings.models[engineId];
    if (configured) ids.add(configured);
    if (S.compose.engine === engineId && S.compose.model) ids.add(S.compose.model);
    const list = [...ids];
    if (engineId === 'codex' && !ids.has('')) list.unshift('');
    return list;
  }

  function activeFilters() {
    const f = S.compose.filters;
    return {
      yearFrom: f.yearFrom || null, yearTo: f.yearTo || null, minCitations: Number(f.minCitations) || 0,
      oaOnly: !!f.oaOnly, noPreprints: !!f.noPreprints, journalMin: Number(f.journalMin) || 0,
      designs: f.designs, minSample: Number(f.minSample) || 0, fields: f.fields, venues: f.venues,
    };
  }
  const filterCount = (f = S.compose.filters) => [
    f.yearFrom, f.yearTo, Number(f.minCitations) > 0, f.oaOnly, f.noPreprints, Number(f.journalMin) > 0,
    f.designs.length, Number(f.minSample) > 0, f.fields.length, f.venues.trim(),
  ].filter(Boolean).length;
  const modeInfo = (id) => S.app.modes.find((m) => m.id === id) || S.app.modes[0];

  // ------------------------------------------------------------------ rail
  function renameField(t) {
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      S.renaming = null;
      if (save && title && title !== t.title) {
        try {
          await api('PUT', '/api/thread', { id: t.id, title });
          t.title = title;
          if (S.thread && S.thread.id === t.id) S.thread.title = title;
        } catch (e) { toast(e.message); }
      }
      renderRailOnly();
    };
    const input = h('input', {
      class: 'input history-rename', value: t.title, maxlength: '120', 'aria-label': 'Conversation name',
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      },
      onblur: () => finish(true),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  function renderRail() {
    const active = engineInfo(S.compose.engine);
    const liveElsewhere = S.live && S.live.running && !(S.view === 'thread' && S.thread === S.live.thread);
    // a conversation that was not in the list a moment ago rises in; the first list drawn is not "new"
    const rise = (li, id, i) => { const a = Motion.appeared('history', id); return a == null ? li : Motion.enter(li, i, a); };

    const rail = h('aside', { class: 'rail' },
      h('div', { class: 'wordmark' }, h('span', null, 'Lectern')),
      h('button', { class: 'btn new', onclick: goHome }, 'New question'),
      h('nav', { class: 'rail-nav' },
        h('button', { class: `rail-link${S.view === 'library' ? ' on' : ''}`, onclick: () => { stopDictation(); S.view = 'library'; render(); } },
          'Library', h('span', { class: 'count' }, S.library.length || ''))),
      h('div', { class: 'rail-label' }, 'Recent'),
      h('ul', { class: 'history' },
        liveElsewhere && h('li', null,
          h('button', { class: 'history-item', onclick: () => { S.thread = S.live.thread; S.view = 'thread'; render(); } },
            `Answering: ${S.live.question}`)),
        S.threads.length === 0 && !liveElsewhere && h('li', { class: 'history-empty' }, 'Your questions will appear here.'),
        S.threads.map((t, i) => rise(h('li', { class: S.view === 'thread' && S.thread && S.thread.id === t.id ? 'on' : '' },
          S.renaming === t.id
            ? renameField(t)
            : [
              h('button', { class: 'history-item', title: t.title, onclick: () => openThread(t.id) }, t.title),
              h('span', { class: 'history-acts' },
                h('button', { class: 'history-act', title: 'Rename', 'aria-label': `Rename "${t.title}"`, onclick: () => { S.renaming = t.id; renderRailOnly(); } }, '✎'),
                h('button', { class: 'history-act', title: 'Duplicate', 'aria-label': `Duplicate "${t.title}"`, onclick: () => duplicateThread(t) }, '⧉'),
                h('button', { class: 'history-act del', title: 'Delete', 'aria-label': `Delete "${t.title}"`, onclick: () => deleteThread(t) }, '×')),
            ]), t.id, i))),
      h('div', { class: 'rail-foot' },
        h('button', { class: 'rail-link engine-pill', onclick: openSettings },
          h('span', null,
            h('span', { class: `dot${active ? '' : ' off'}` }), ' ',
            active ? active.short : 'No model connected',
            active && h('small', null, `${prettyModel(S.compose.model, active.id)}, ${EFFORT_LABEL[S.compose.effort].toLowerCase()} effort`))),
        h('button', { class: 'rail-link', onclick: openSettings }, 'Settings')));
    Motion.settle('history');
    Motion.glide($('.history', rail), 'li:not(.history-empty)');
    return rail;
  }

  // ------------------------------------------------------------------ composer
  /** Small line icons, drawn as SVG (built element by element, no markup strings). */
  const ICONS = {
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    stop: ['M7 7h10v10H7z'],
    plus: ['M12 5v14', 'M5 12h14'],
    check: ['M5 12.5 10 17.5 19 7'],
    right: ['M9 6l6 6-6 6'],
    left: ['M15 6l-6 6 6 6'],
    globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'],
    filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
    mic: ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4'],
    tools: ['M5 5h6v6H5z', 'M13 13h6v6h-6z', 'M16 5v6', 'M13 8h6', 'M5 16h6'],
    answer: ['M5 6h14', 'M5 11h14', 'M5 16h8'],
    review: ['M7 3h8l4 4v14H7z', 'M15 3v4h4', 'M10 12h6', 'M10 16h6'],
    trail: ['M6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M18 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M6 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M6 9v6', 'M6 12h8a4 4 0 0 1 4 4'],
    claim: ['M5 8h5v5H5z', 'M10 13c0 3-2 4-4 4', 'M14 8h5v5h-5z', 'M19 13c0 3-2 4-4 4'],
    verify: ['M4 7l2 2 3-4', 'M12 7h8', 'M4 15l2 2 3-4', 'M12 15h8'],
    close: ['M6 6l12 12', 'M18 6 6 18'],
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' })) svg.setAttribute(k, v);
    for (const d of ICONS[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }

  const EFFORT_HELP = {
    low: 'Fastest. Fine for simple questions',
    medium: 'Balanced speed and depth',
    high: 'Thinks longer before answering',
    xhigh: 'Thinks much longer. Slower',
    max: 'Deepest thinking. Slowest, uses the most of your plan',
  };

  /** Close any open composer menu when clicking elsewhere or pressing Escape. */
  let motionScopes = 0; // numbers the lists whose newcomers rise in (one scope per answer's reference list)
  let closeMenu = null;
  let menuQuiet = 0; // when a menu was closed only to be opened again at once, the second one does not fade in
  document.addEventListener('mousedown', (e) => { if (closeMenu && !e.target.closest('.cmenu, .cmenu-anchor')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeMenu) { e.preventDefault(); closeMenu(true); } });

  /**
   * The ask box: one rounded box with the send button inside, and a slim row underneath with
   * the extras (web search, filters) on the left and the model and effort on the right.
   */
  function buildComposer({ placeholder, autofocus, dock }) {
    const c = S.compose;
    const running = isBusy();

    const mode = modeInfo(c.mode);
    // A tool brings its own hint; a plain answer keeps the hint of the box it is in.
    if (mode.id !== 'answer') placeholder = mode.id === 'trail' || mode.id === 'verify' ? `${mode.placeholder} (Shift+Enter for a new line)` : mode.placeholder;

    const ta = h('textarea', {
      class: 'ask', rows: '1', placeholder, 'aria-label': placeholder, maxlength: mode.maxInput,
      oninput: (e) => { if (e.isTrusted) stopDictation(); c.draft = e.target.value; grow(e.target); sendBtn.disabled = !e.target.value.trim() && !running; },
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      },
    });
    ta.value = c.draft;
    const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 240)}px`; };
    const submit = () => {
      if (isBusy() || !c.draft.trim()) return;
      const m = c.mode;
      ask(c.draft, { mode: m, fromBox: true });
    };

    const sendBtn = running
      ? h('button', { type: 'button', class: 'send stop', 'aria-label': 'Stop', title: 'Stop', onclick: stopAsk }, icon('stop'))
      : h('button', { type: 'submit', class: 'send', 'aria-label': 'Ask', title: 'Ask (Enter)', disabled: !c.draft.trim() || null }, icon('send'));

    const micBtn = h('button', {
      type: 'button', class: `mic${listening ? ' on' : ''}`, 'aria-pressed': String(!!listening),
      'aria-label': listening ? 'Stop voice input' : 'Speak your question', title: S.app.dictation ? 'Dictate (uses macOS Dictation)' : 'Speak your question',
      onclick: () => toggleDictation(),
    }, icon('mic'));

    const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('div', { class: 'composer-main' }, ta, micBtn, sendBtn));

    // ---- the row under the box
    const n = filterCount();
    const toggleWeb = () => { c.web = !c.web; savePrefs(); render(); };
    const setMode = (id) => { stopDictation(); c.mode = id; if (closeMenu) closeMenu(); render(); requestAnimationFrame(() => $(dock ? '.dock .ask' : '.ask')?.focus()); };
    const webChip = Motion.pop(h('button', { type: 'button', class: 'chip', hidden: !c.web, title: 'Web search is on. Click to turn it off', onclick: toggleWeb }, icon('globe'), 'Web'), 'composer', 'web', !!c.web, !!c.web);
    const filtersBtn = h('button', {
      type: 'button', class: `chip filters-btn${n ? ' on' : ''}`, title: 'Year, journal, study design, field of study and more',
      'aria-label': n ? `Filters, ${n} on` : 'Filters', onclick: openFilters,
    }, icon('filter'), 'Filters', n > 0 && Motion.pop(h('span', { class: 'badge-count' }, String(n)), 'composer', 'filters', n));
    const modeChip = mode.id !== 'answer' && Motion.pop(h('button', {
      type: 'button', class: 'chip on', title: `${mode.blurb}. Click to go back to a normal answer`, onclick: () => setMode('answer'),
    }, icon(mode.id), mode.label, icon('close')), 'composer', 'mode', mode.id);

    const wrap = h('div', { class: `composer-wrap${dock ? ' docked' : ''}` });
    const plusBtn = h('button', {
      type: 'button', class: 'icon-round cmenu-anchor', 'aria-label': 'Research tools and web search', title: 'Research tools and web search', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => openMenu(plusBtn, () => [
        h('div', { class: 'cmenu-head' }, 'Research tools'),
        S.app.modes.map((m) => h('button', {
          type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(m.id === c.mode), onclick: () => setMode(m.id),
        }, icon(m.id), h('span', { class: 'cmenu-text' }, h('b', null, m.label), h('small', null, m.blurb)), m.id === c.mode && icon('check'))),
        h('div', { class: 'cmenu-sep' }),
        h('button', { type: 'button', class: 'cmenu-row', role: 'menuitemcheckbox', 'aria-checked': String(c.web), onclick: toggleWeb },
          icon('globe'), h('span', { class: 'cmenu-text' }, h('b', null, 'Web search'), h('small', null, 'Also look at the open web for context the papers lack')),
          c.web && icon('check')),
      ], 'left'),
    }, icon('plus'));

    const info = engineInfo(c.engine);
    const modelBtn = h('button', {
      type: 'button', class: 'model-btn cmenu-anchor', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': info ? `Model: ${prettyModel(c.model, c.engine)}, ${EFFORT_LABEL[c.effort]} effort. Change` : 'Connect a model',
      onclick: () => (info || S.app.engines.some((e) => e.found) ? openMenu(modelBtn, () => modelMenu(), 'right') : openSettings()),
    }, info
      // the names roll when the model or the effort changes (the same memory serves the home box and the follow-up box)
      ? [Motion.roll(h('span', { class: 'model-name' }), 'composer', 'model', prettyModel(c.model, c.engine)),
        Motion.roll(h('span', { class: 'model-effort' }), 'composer', 'effort', EFFORT_LABEL[c.effort])]
      : h('span', { class: 'model-name' }, 'Connect Claude or ChatGPT'));

    /** The model menu: Claude / ChatGPT, the models, then Effort (a sub-page). */
    function modelMenu(page) {
      if (page === 'effort') {
        return [
          h('button', { type: 'button', class: 'cmenu-row back', onclick: () => redrawMenu(modelMenu()) }, icon('left'), h('b', null, 'Effort')),
          S.app.efforts.map((lvl) => h('button', {
            type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(lvl === c.effort),
            onclick: () => { c.effort = lvl; savePrefs(); closeMenu(); render(); },
          }, h('span', { class: 'cmenu-text' }, h('b', null, EFFORT_LABEL[lvl]), h('small', null, EFFORT_HELP[lvl])), lvl === c.effort && icon('check'))),
        ];
      }
      const eng = engineInfo(c.engine);
      return [
        Motion.slide(h('div', { class: 'cmenu-engines', role: 'radiogroup', 'aria-label': 'Which plan to use' },
          S.app.engines.map((e) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(e.id === c.engine), disabled: !e.ready || null,
            title: e.detail,
            onclick: () => { menuQuiet = performance.now(); c.engine = e.id; c.model = S.app.settings.models[e.id] || ''; savePrefs(); closeMenu(); render(); requestAnimationFrame(() => $('.model-btn')?.click()); },
          }, e.short, !e.ready && h('small', null, e.found ? 'not signed in' : 'not installed')))), 'engine-toggle'),
        eng && modelChoices(c.engine).map((id) => h('button', {
          type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(id === c.model),
          onclick: () => { c.model = id; savePrefs(); closeMenu(); render(); },
        }, h('span', { class: 'cmenu-text' }, h('b', null, prettyModel(id, c.engine)), h('small', null, (eng.blurbs || {})[id] || 'Custom model from Settings')), id === c.model && icon('check'))),
        eng && h('div', { class: 'cmenu-sep' }),
        eng && h('button', { type: 'button', class: 'cmenu-row', onclick: () => redrawMenu(modelMenu('effort')) },
          h('b', null, 'Effort'), h('span', { class: 'cmenu-value' }, EFFORT_LABEL[c.effort]), icon('right')),
        h('p', { class: 'cmenu-note' }, eng ? `${eng.billing}. ${eng.detail}.` : 'Sign in to Claude or ChatGPT on this Mac to start.',
          ' ', h('button', { type: 'button', class: 'linkish', onclick: () => { closeMenu(); openSettings(); } }, 'Settings')),
      ];
    }

    let menuEl = null;
    function redrawMenu(kids) {
      if (!menuEl) return;
      fill(menuEl, kids);
      Motion.play(menuEl, 'swap', 340); // the new page of the menu slides in
      menuEl.querySelector('button:not([disabled])')?.focus();
    }
    function openMenu(anchor, build, side) {
      if (closeMenu) { const same = menuEl && menuEl.dataset.side === side; closeMenu(); if (same) return; }
      menuEl = h('div', {
        class: `cmenu ${side}${dock ? ' up' : ''}`, role: 'menu', 'data-side': side,
        onkeydown: (e) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const items = [...menuEl.querySelectorAll('button:not([disabled])')];
          const at = items.indexOf(document.activeElement);
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
            : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        },
      }, build());
      if (performance.now() - menuQuiet < 500) menuEl.classList.add('quiet');
      wrap.append(menuEl);
      // A home composer can also be near the bottom of a narrow window. Choose the side
      // with room and constrain the menu itself so every tool stays reachable.
      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const below = window.innerHeight - wrapRect.bottom - 12;
      const above = anchorRect.top - 12;
      const up = (dock || below < Math.min(menuEl.scrollHeight, 530)) && above > below;
      menuEl.classList.toggle('up', up);
      if (up) menuEl.style.bottom = `${wrapRect.bottom - anchorRect.top + 6}px`;
      menuEl.style.maxHeight = `${Math.max(80, Math.min(530, up ? above : below))}px`;
      anchor.setAttribute('aria-expanded', 'true');
      closeMenu = (refocus) => {
        if (menuEl) Motion.leave(menuEl);
        menuEl = null;
        closeMenu = null;
        anchor.setAttribute('aria-expanded', 'false');
        if (refocus) anchor.focus();
      };
      const first = menuEl.querySelector('button:not([disabled])');
      if (first) first.focus();
    }

    fill(wrap,
      form,
      h('div', { class: 'composer-under' },
        h('div', { class: 'under-left' }, plusBtn, filtersBtn, modeChip, webChip),
        h('span', { class: 'under-note' }, 'Lectern reads abstracts, not full papers. Check what you cite.'),
        h('div', { class: 'under-right' }, modelBtn)));

    requestAnimationFrame(() => { grow(ta); if (autofocus) ta.focus(); });
    return wrap;
  }

  // ---- voice input
  // In the desktop app the server asks macOS to start Dictation in the focused box (the browser
  // engine inside Electron has no speech service of its own). In a browser, the browser's own
  // speech recognition is used where it exists (Chrome, Edge, Safari).
  let listening = null;
  function stopDictation() {
    if (!listening) return;
    const rec = listening;
    listening = null;
    rec.abort();
    document.querySelectorAll('.mic').forEach((b) => {
      b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Speak your question');
    });
  }
  function toggleDictation() {
    const box = () => $('.dock .ask') || $('.ask');
    if (S.app.dictation) {
      box()?.focus();
      api('POST', '/api/dictate', {})
        .then((r) => { if (!r.ok) toast(r.error || 'Dictation did not start. Turn it on in System Settings, Keyboard, Dictation.'); })
        .catch((e) => toast(e.message));
      return;
    }
    if (listening) { stopDictation(); return; }
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) { toast('This browser has no voice input. On a Mac, click in the box and press the Dictation key.'); return; }
    const before = S.compose.draft ? `${S.compose.draft.trimEnd()} ` : '';
    const rec = new Speech();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    const mark = (on) => document.querySelectorAll('.mic').forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Stop voice input' : 'Speak your question'); });
    rec.onresult = (e) => {
      if (listening !== rec) return;
      let said = '';
      for (const r of e.results) said += r[0].transcript;
      S.compose.draft = (before + said).slice(0, modeInfo(S.compose.mode).maxInput);
      const ta = box();
      if (ta) { ta.value = S.compose.draft; ta.dispatchEvent(new Event('input')); }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('The microphone was refused. Allow it for this page in the browser\'s site settings.');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Voice input stopped (${e.error}).`);
    };
    rec.onend = () => { if (listening === rec) { listening = null; mark(false); } };
    try { rec.start(); listening = rec; mark(true); } catch (e) { toast(`Voice input could not start: ${e.message}`); }
  }

  // ---- filters
  function openFilters() {
    if (closeMenu) closeMenu();
    const opts = S.app.filterOptions;
    const draft = JSON.parse(JSON.stringify(S.compose.filters));
    const body = h('div', { class: 'dialog-body filters-body' });
    const year = new Date().getFullYear();
    const open = { general: true, method: draft.designs.length > 0 || Number(draft.minSample) > 0, venues: !!draft.venues.trim(), fields: draft.fields.length > 0 };

    const toggleIn = (list, value) => { const i = list.indexOf(value); if (i === -1) list.push(value); else list.splice(i, 1); };
    const section = (key, title, hint, count, ...kids) => h('details', { class: 'fsec', open: open[key] || null, ontoggle: (e) => { open[key] = e.target.open; } },
      h('summary', null, h('span', { class: 'fsec-title' }, title, count > 0 && h('span', { class: 'badge-count' }, String(count))), h('small', null, hint)),
      h('div', { class: 'fsec-body' }, kids));
    const checks = (list, items, cls) => h('div', { class: `fchecks ${cls || ''}` }, items.map(([value, label]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: `fc-${String(value).replace(/\W+/g, '-')}`, checked: list.includes(value), onchange: () => { toggleIn(list, value); draw(); } }), label)));
    const preset = (label, from) => h('button', {
      type: 'button', id: `fp-${from || 'any'}`, class: `btn small${String(draft.yearFrom) === String(from) && !draft.yearTo ? ' primary' : ''}`,
      'aria-pressed': String(String(draft.yearFrom) === String(from) && !draft.yearTo),
      onclick: () => { draft.yearFrom = from; draft.yearTo = ''; draw(); },
    }, label);

    function draw() {
      const scroll = body.parentElement ? body.parentElement.scrollTop : 0;
      const active = document.activeElement && document.activeElement.id;
      const n = filterCount(draft);
      fill(body,
        section('general', 'General', 'Year, journal, citations, access',
          [draft.yearFrom, draft.yearTo, Number(draft.minCitations) > 0, draft.oaOnly, draft.noPreprints, Number(draft.journalMin) > 0].filter(Boolean).length,
          h('div', { class: 'frow' }, h('span', { class: 'flabel' }, 'Published'),
            preset('Any year', ''), preset('Past 2 years', String(year - 2)), preset('Past 5 years', String(year - 5)), preset('Past 10 years', String(year - 10))),
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-from' }, 'From year'),
            h('input', { class: 'input year', id: 'f-from', type: 'number', min: '1800', max: '2100', placeholder: 'any', value: draft.yearFrom, oninput: (e) => { draft.yearFrom = e.target.value; }, onchange: draw }),
            h('label', { for: 'f-to' }, 'to'),
            h('input', { class: 'input year', id: 'f-to', type: 'number', min: '1800', max: '2100', placeholder: String(year), value: draft.yearTo, oninput: (e) => { draft.yearTo = e.target.value; }, onchange: draw })),
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-journal' }, 'Journal impact'),
            h('select', { class: 'select wide', id: 'f-journal', onchange: (e) => { draft.journalMin = Number(e.target.value); draw(); } },
              opts.journalTiers.map((t) => h('option', { value: t.min, selected: t.min === Number(draft.journalMin) }, t.label)))),
          h('p', { class: 'fnote' }, 'Uses OpenAlex\'s 2-year mean citedness. This is a citation impact measure, not a Q1–Q4 journal rank. Papers whose journal impact is unknown are left out.'),
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-cites' }, 'Citations'), 'At least',
            h('input', { class: 'input num', id: 'f-cites', type: 'number', min: '0', placeholder: '0', value: draft.minCitations, oninput: (e) => { draft.minCitations = e.target.value; }, onchange: draw })),
          h('div', { class: 'frow' },
            h('label', { class: 'filter-switch' }, 'Exclude preprints', h('input', { id: 'f-preprints', type: 'checkbox', role: 'switch', checked: draft.noPreprints, onchange: (e) => { draft.noPreprints = e.target.checked; draw(); } })),
            h('label', { class: 'filter-switch' }, 'Open access', h('input', { id: 'f-open-access', type: 'checkbox', role: 'switch', checked: draft.oaOnly, onchange: (e) => { draft.oaOnly = e.target.checked; draw(); } })))),

        section('method', 'Methodology', 'Study design and sample size', draft.designs.length + (Number(draft.minSample) > 0 ? 1 : 0),
          checks(draft.designs, opts.designs.map((d) => [d, d]), 'cols'),
          h('p', { class: 'fnote' }, 'The design is recognised from the paper\'s title and its database record. A paper that does not name its design there is left out when you tick any box.'),
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-sample' }, 'Sample size'), 'At least',
            h('input', { class: 'input num', id: 'f-sample', type: 'number', min: '0', placeholder: 'any', value: draft.minSample, oninput: (e) => { draft.minSample = e.target.value; }, onchange: draw })),
          h('p', { class: 'fnote' }, 'The sample size is the number of participants the abstract states. Papers whose abstract does not state one are left out. Study length cannot be filtered: abstracts rarely state it in a form that can be read reliably.')),

        section('venues', 'Sources', 'Journals and publishers', draft.venues.trim() ? 1 : 0,
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-venues' }, 'Name contains'),
            h('input', { class: 'input wide', id: 'f-venues', maxlength: '300', placeholder: 'For example: Nature, Journal of Finance, Elsevier', value: draft.venues, oninput: (e) => { draft.venues = e.target.value; }, onchange: draw })),
          h('p', { class: 'fnote' }, 'Separate names with commas. A paper is kept when its journal or publisher name contains any of them.')),

        section('fields', 'Fields of study', `${opts.fields.length} fields`, draft.fields.length,
          checks(draft.fields, opts.fields.map((f) => [f.id, f.label]), 'cols'),
          h('p', { class: 'fnote' }, 'Fields come from OpenAlex. Papers it has no field for are left out when you tick any box.')),

        h('div', { class: 'cite-foot filter-foot' },
          h('small', null, n ? `${n} filter${n === 1 ? '' : 's'} on. Filters apply to every search until you clear them.` : 'No filters on.'),
          h('button', { class: 'btn quiet', disabled: n === 0 || null, onclick: () => { Object.assign(draft, noFilters()); draw(); } }, 'Clear all'),
          h('button', { class: 'btn', onclick: () => $('#dialog').close() }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => {
            if (draft.yearFrom && draft.yearTo && Number(draft.yearFrom) > Number(draft.yearTo)) {
              toast('The start year must come before the end year.'); $('#f-from').focus(); return;
            }
            const invalid = [...body.querySelectorAll('input')].find((el) => !el.checkValidity());
            if (invalid) { invalid.reportValidity(); return; }
            S.compose.filters = draft; savePrefs(); $('#dialog').close(); render();
          } }, 'Apply')));
      if (body.parentElement) body.parentElement.scrollTop = scroll;
      if (active) document.getElementById(active)?.focus();
    }
    draw();
    openDialog('Filters', body);
  }

  /** Redraw the ask box(es) in place after a change made from inside one of them. */
  function refreshComposers() {
    for (const old of document.querySelectorAll('.composer-wrap')) {
      const dock = old.classList.contains('docked');
      old.replaceWith(buildComposer({ placeholder: dock ? 'Ask a follow-up' : 'Ask a research question', autofocus: false, dock }));
    }
  }

  // ------------------------------------------------------------------ home
  const EXAMPLES = [
    'Does remote work improve employee productivity?',
    'How does ESG performance affect a firm\'s cost of capital?',
    'What makes customers stay loyal to a mobile banking app?',
    'Is spaced repetition better than rereading for long-term retention?',
  ];

  function renderHome() {
    const noEngine = !S.app.activeEngine;
    const oaMissing = S.app.settings.sources.openalex && !S.app.settings.keys.openalex.set;
    return h('section', { class: 'view home' },
      h('h1', { class: 'display' }, 'What does the research say?'),
      h('p', { class: 'lede' }, 'Ask in plain words. Lectern searches the paper databases, reads the abstracts, and answers with citations you can open and check.'),
      buildComposer({ placeholder: 'Ask a research question', autofocus: !noEngine }),
      noEngine && h('div', { class: 'setup' },
        h('h2', null, 'Sign in to Claude or ChatGPT to start'),
        h('p', null, 'Lectern uses the plan you already have, through the login saved on this Mac. No API key needed. Open the Claude app or the ChatGPT app and sign in, then come back here.'),
        h('button', { class: 'btn primary', onclick: async () => { try { await refreshState(); if (!S.app.activeEngine) openSettings(); } catch (e) { toast(e.message); } } }, 'I have signed in'), ' ',
        h('button', { class: 'btn quiet', onclick: openSettings }, 'Settings')),
      !noEngine && oaMissing && h('p', { class: 'hint' },
        'OpenAlex, the largest database here, needs a free key to work. ',
        h('button', { onclick: openSettings }, 'Add it in Settings')),
      // (this line's words fade up when they change, e.g. after the reader picks a level)
      Motion.say(h('p', { class: 'hint' },
        profileLabel() ? `Answers are written for: ${profileLabel()}. ` : 'Answers can match your level and field of study. ',
        h('button', { onclick: () => openProfile() }, profileLabel() ? 'Change' : 'Tell Lectern what you study')), 'home', 'profile-hint', profileLabel()),
      h('div', { class: 'examples' },
        h('p', null, 'Or try one of these'),
        h('ul', null, EXAMPLES.map((q) => h('li', null,
          h('button', { class: 'example', onclick: () => ask(q, { fromBox: true }) }, q))))));
  }

  // ------------------------------------------------------------------ a turn (one question and its answer)
  function shelfState(turn) {
    if (!S.shelf.has(turn)) S.shelf.set(turn, { sort: 'relevance', citedOnly: false });
    return S.shelf.get(turn);
  }
  const insightFor = (turn, n) => (turn.insights || []).find((i) => i.n === n) || null;

  function byLine(p) {
    const fam = p.authors.map((a) => a.family);
    let who = 'Unknown authors';
    if (fam.length === 1) who = fam[0];
    else if (fam.length === 2) who = `${fam[0]} & ${fam[1]}`;
    else if (fam.length === 3) who = `${fam[0]}, ${fam[1]} & ${fam[2]}`;
    else if (fam.length > 3) who = `${fam[0]}, ${fam[1]} et al.`;
    return [`${who} (${p.year || 'n.d.'})`, p.venue && '. ', p.venue && h('i', null, p.venue)];
  }

  function paperRow(p, { turn, showNumber }) {
    const ins = turn ? insightFor(turn, p.n) : null;
    const saved = S.library.some((x) => x.id === p.id);
    const href = p.doi ? `https://doi.org/${p.doi}` : (isWebUrl(p.url) ? p.url : '');
    const stance = ins && turn.yesNo ? ins.stance : null;
    const tabClass = showNumber ? (stance || 'plain') : 'plain';
    const strongKind = p.kind === 'Meta-analysis' || p.kind === 'Systematic review';
    const links = (p.rel || []).map((r) => {
      if (r === 'seed') return 'Starting paper';
      const [kind, k] = r.split(':');
      const which = (turn && (turn.papers || []).filter((x) => (x.rel || []).includes('seed')).length > 1) ? ` ${k}` : '';
      return kind === 'ref' ? `Cited by starting paper${which}` : `Cites starting paper${which}`;
    });

    const abstract = h('p', { class: 'abstract', hidden: true }, p.abstract || (p.tldr ? `Summary: ${p.tldr}` : ''));
    const saveBtn = h('button', {
      type: 'button', class: saved ? 'saved' : '',
      onclick: async () => {
        try {
          const now = S.library.some((x) => x.id === p.id);
          const res = now ? await api('DELETE', `/api/library?id=${encodeURIComponent(p.id)}`) : await api('POST', '/api/library', { paper: p });
          S.library = res.papers;
          toast(now ? 'Removed from library' : 'Saved to library');
          render();
        } catch (e) { toast(e.message); }
      },
    }, saved ? 'Saved' : 'Save');

    return h('li', { class: `paper${ins && !ins.relevant ? ' dim' : ''}`, 'data-n': showNumber ? p.n : null },
      showNumber ? h('span', { class: `tab ${tabClass}`, title: stance ? STANCE_LABEL[stance] : null }, p.n) : h('span'),
      h('div', { class: 'paper-body' },
        href ? h('a', { class: 'paper-title', href, target: '_blank', rel: 'noopener noreferrer' }, p.title) : h('span', { class: 'paper-title' }, p.title),
        h('div', { class: 'paper-by' }, byLine(p)),
        h('div', { class: 'badges' },
          links.map((l) => h('span', { class: `badge link${l === 'Starting paper' ? ' strong' : ''}` }, l)),
          p.kind !== 'Article' && h('span', { class: `badge${strongKind ? ' strong' : ''}` }, p.kind),
          p.isOA && h('span', { class: 'badge oa' }, 'Open access'),
          p.journalScore != null && h('span', { class: 'badge', title: 'Average citations per paper in this journal over two years (OpenAlex)' }, `Journal impact ${Number(p.journalScore).toFixed(1)}`),
          p.citations != null && h('span', { class: 'badge' }, `${nf.format(p.citations)} citation${p.citations === 1 ? '' : 's'}`),
          ins && !ins.relevant && h('span', { class: 'badge' }, 'Off-topic')),
        ins && ins.finding && h('p', { class: 'finding' },
          stance && stance !== 'na' && h('span', { class: `stance ${stance}` }, STANCE_LABEL[stance]),
          ins.finding),
        ins && (ins.design || ins.sample) && h('div', { class: 'design' }, [ins.design, ins.sample].filter(Boolean).join(', ')),
        h('div', { class: 'paper-actions' },
          p.doi && h('a', { href: `https://doi.org/${p.doi}`, target: '_blank', rel: 'noopener noreferrer' }, 'DOI'),
          isWebUrl(p.pdfUrl) && h('a', { href: p.pdfUrl, target: '_blank', rel: 'noopener noreferrer' }, 'PDF'),
          h('a', { href: `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Scholar'),
          h('button', { type: 'button', onclick: () => openCite(p) }, 'Cite'),
          saveBtn,
          (p.doi || p.title) && h('button', {
            type: 'button', disabled: isBusy() || null, title: 'See what this paper cites and what cites it',
            // Title for the reader, DOI for an exact match: the server looks the DOI up first.
            onclick: () => ask(p.doi ? `${p.title} https://doi.org/${p.doi}` : p.title, { mode: 'trail' }),
          }, 'Citation trail'),
          (p.abstract || p.tldr) && h('button', {
            type: 'button', 'aria-expanded': 'false',
            onclick: (e) => { abstract.hidden = !abstract.hidden; e.currentTarget.setAttribute('aria-expanded', String(!abstract.hidden)); },
          }, 'Abstract')),
        abstract));
  }

  function buildShelf(turn) {
    const st = shelfState(turn);
    const papers = turn.papers || [];
    const shelf = h('section', { class: 'shelf references-list', 'aria-label': 'Reference papers' });
    const listEl = h('ol', { class: 'papers' });
    const count = h('span', { class: 'reference-count' });
    const filterLine = h('div', { class: 'reference-filter' });
    let visible = [];
    st.mscope = st.mscope || `refs-${++motionScopes}`; // papers that arrive after the list is first drawn rise in
    const draw = () => {
      let list = [...papers];
      if (st.citedOnly && turn.cited) list = list.filter((p) => turn.cited.has(p.n));
      if (st.paperNs) list = list.filter((p) => st.paperNs.includes(p.n));
      if (st.query) list = list.filter((p) => `${p.title} ${p.authors.map((a) => a.family).join(' ')} ${p.venue || ''}`.toLowerCase().includes(st.query.toLowerCase()));
      if (st.sort === 'relevance') list.sort((a, b) => (turn.citeCounts?.get(b.n) || 0) - (turn.citeCounts?.get(a.n) || 0));
      if (st.sort === 'cited') list.sort((a, b) => (b.citations || 0) - (a.citations || 0));
      if (st.sort === 'newest') list.sort((a, b) => (b.year || 0) - (a.year || 0));
      visible = list;
      Motion.count(count, 'refs', 'shelf', list.length, (n) => `${Math.round(n)}${list.length !== papers.length ? ` of ${papers.length}` : ''} papers`);
      filterLine.hidden = !st.paperNs;
      fill(filterLine, st.filterLabel || 'Selected evidence', h('button', { class: 'linkish', type: 'button', onclick: () => { st.paperNs = null; st.filterLabel = ''; draw(); } }, 'Clear selection'));
      listEl.replaceChildren(...list.map((p, i) => {
        const row = paperRow(p, { turn, showNumber: true });
        const a = Motion.appeared(st.mscope, p.id || p.n);
        return a == null ? row : Motion.enter(row, i, a);
      }));
      if (!list.length) listEl.append(h('li', { class: 'shelf-empty' }, papers.length ? 'No references match these filters.' : turn.running ? 'References will appear as papers are found.' : 'No papers were retrieved.'));
    };
    const toolbar = h('div', { class: 'reference-toolbar', hidden: !st.toolsOpen },
      h('input', { class: 'input', type: 'search', placeholder: 'Filter references', 'aria-label': 'Filter references', value: st.query || '', oninput: (e) => { st.query = e.target.value; draw(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.citedOnly, onchange: (e) => { st.citedOnly = e.target.checked; draw(); } }), 'Cited only'),
      h('select', { class: 'select', 'aria-label': 'Sort papers', onchange: (e) => { st.sort = e.target.value; draw(); } },
        [['relevance', 'Most relevant'], ['cited', 'Most cited'], ['newest', 'Newest']].map(([v, t]) => h('option', { value: v, selected: st.sort === v }, t))));
    const filterBtn = h('button', { class: 'btn quiet small', type: 'button', 'aria-expanded': String(!!st.toolsOpen), onclick: () => {
      st.toolsOpen = !st.toolsOpen; toolbar.hidden = !st.toolsOpen; filterBtn.setAttribute('aria-expanded', String(st.toolsOpen));
      if (st.toolsOpen) toolbar.querySelector('input').focus();
    } }, 'Filter');
    fill(shelf, h('div', { class: 'shelf-head' }, count), filterLine, toolbar, listEl,
      h('div', { class: 'reference-bottom' }, filterBtn,
        h('details', { class: 'reference-exports' }, h('summary', null, 'Export references'),
          h('button', { class: 'btn small', onclick: () => copyRich(Cite.formatList(visible, S.app.settings.citeStyle), 'References copied') }, 'Copy list'),
          h('button', { class: 'btn small', onclick: () => download('lectern-references.bib', Cite.formatList(visible, 'bibtex').text) }, 'BibTeX'),
          h('button', { class: 'btn small', onclick: () => download('lectern-references.ris', Cite.formatList(visible, 'ris').text, 'application/x-research-info-systems') }, 'RIS'))));
    draw();
    Motion.settle(st.mscope);
    return shelf;
  }

  function referenceTurns() {
    if (!S.thread) return [];
    const live = S.live && S.live.thread === S.thread ? S.live : null;
    const end = live && live.parentId !== undefined ? live.parentId : S.thread.leaf;
    return [...(end ? pathTo(S.thread, end) : []), ...(live ? [live] : [])];
  }

  function selectReferenceTurn() {
    const turns = referenceTurns();
    S.referenceTurn = turns.find((t) => t === S.referenceTurn || (t.id && t.id === S.referenceTurn?.id)) || turns.at(-1) || null;
    return S.referenceTurn;
  }

  function refreshReferences() {
    const panel = $('#references-panel');
    if (!panel) return;
    const main = $('.main');
    const mainScroll = main.scrollTop;
    const pageScroll = window.scrollY;
    const restoreScroll = () => {
      main.scrollTo({ top: mainScroll, behavior: 'instant' });
      if (window.scrollY !== pageScroll) window.scrollTo({ top: pageScroll, behavior: 'instant' });
    };
    const turn = selectReferenceTurn();
    const scroll = $('.papers', panel)?.scrollTop || 0;
    const previousTurn = panel._turn;
    panel.hidden = !S.referencesOpen;
    // the panel slides in when it is opened (not when a page that already has it open is drawn)
    if (Motion.age('refs', 'open', S.referencesOpen) === 0 && S.referencesOpen) Motion.play(panel, 'panel-enter', 520);
    $('.thread-layout')?.classList.toggle('references-open', S.referencesOpen);
    const toggle = $('.references-toggle');
    toggle?.setAttribute('aria-expanded', String(S.referencesOpen));
    if (toggle) fill(toggle, icon('review'), 'References', Motion.count(h('span', { class: 'reference-count' }), 'refs', 'toggle', (turn?.papers || []).length));
    if (!S.referencesOpen) { panel.replaceChildren(); restoreScroll(); return; }
    const turns = referenceTurns();
    fill(panel,
      h('div', { class: 'references-panel-head' }, h('h2', { id: 'references-heading' }, 'References'),
        h('button', { type: 'button', class: 'btn quiet small', 'aria-label': 'Close references', onclick: closeReferences }, icon('close'))),
      turns.length > 1 && h('select', { class: 'select reference-turn', 'aria-label': 'References for question', onchange: (e) => {
        S.referenceTurn = turns[Number(e.target.value)]; refreshReferences();
      } }, turns.map((t, i) => h('option', { value: i, selected: t === turn }, `${i + 1}. ${t.question}`))),
      turn && h('p', { class: 'reference-question', title: turn.question }, turn.question),
      turn ? buildShelf(turn) : h('p', { class: 'shelf-empty' }, 'References will appear as papers are found.'));
    panel._turn = turn;
    if (turn === previousTurn && $('.papers', panel)) $('.papers', panel).scrollTop = scroll;
    restoreScroll();
  }

  function openReferences(turn, focus = false) {
    hideCiteCard();
    if (turn) S.referenceTurn = turn;
    S.referencesOpen = true;
    refreshReferences();
    if (focus) $('[aria-label="Close references"]')?.focus({ preventScroll: true });
  }

  function closeReferences() {
    S.referencesOpen = false;
    refreshReferences();
    $('.references-toggle')?.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && S.referencesOpen && !$('#dialog').open && !closeMenu && !citeCardFor && !e.target.closest('.edit-box')) {
      e.preventDefault(); closeReferences();
    }
  });

  function highlightPaper(turn, n) {
    const article = [...document.querySelectorAll('.turn')].find((el) => el._turn === turn);
    if (!article) return;
    for (const chip of article.querySelectorAll('.cite[data-n]')) chip.classList.toggle('hot', Number(chip.dataset.n) === Number(n));
  }

  function focusPaper(turn, n) {
    const st = shelfState(turn);
    st.paperNs = null; st.query = ''; st.citedOnly = false;
    openReferences(turn);
    const row = $(`#references-panel .paper[data-n="${n}"]`);
    if (!row) return;
    const list = row.closest('.papers');
    list.scrollTo({ top: row.offsetTop - list.clientHeight / 3, behavior: 'instant' });
    row.querySelector('.paper-title')?.focus({ preventScroll: true });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }

  function buildRunline(turn) {
    if (turn.running) {
      // The three steps of an answer, on one line: what is done, what is happening, what is left.
      const at = Math.max(0, ['plan', 'search', 'write'].indexOf(turn.stage));
      const q = (turn.queries || []).length;
      const n = (turn.papers || []).length;
      const found = (turn.sources || []).map((s) => `${s.label} ${s.error && !s.count ? 'unavailable' : s.count}`).join(', ');
      const steps = [
        ['Plan', 'Planning the search', `Planned ${q} search${q === 1 ? '' : 'es'}`],
        ['Search', found ? `Searching the databases (${found})` : 'Searching the databases', `Found ${n} paper${n === 1 ? '' : 's'}`],
        ['Read and write', turn.status || `Reading ${n} abstract${n === 1 ? '' : 's'} and writing`, 'Answer ready'],
      ];
      if (turn.mode === 'trail') {
        steps[0] = ['Find', 'Finding the starting papers', `Found ${q} starting paper${q === 1 ? '' : 's'}`];
        steps[1] = ['Trace', 'Following the citations in OpenAlex', `Found ${n} linked paper${n === 1 ? '' : 's'}`];
      } else if (turn.mode === 'verify') {
        steps[0] = ['Read', 'Reading your text for citations', `Found ${q} citation${q === 1 ? '' : 's'}`];
        steps[1] = ['Look up', 'Looking up each cited paper', `Matched ${n} paper${n === 1 ? '' : 's'}`];
        steps[2] = ['Check', turn.status || 'Checking each claim against its paper', 'Check ready'];
      }
      return h('ol', { class: 'runline steps', 'aria-label': 'Progress', 'aria-live': 'polite' }, steps.map(([label, now, done], i) => {
        const state = i < at ? 'done' : (i === at ? 'now' : 'todo');
        const detail = state === 'done' ? done : (state === 'now' ? now : label);
        // a step that has just changed fills in (and its line draws across); the animation survives the rebuilds
        const a = Motion.age(turn, `step${i}`, state);
        const fresh = a != null && state !== 'todo';
        const li = h('li', { class: fresh ? `${state} fresh` : state, title: detail, 'aria-label': detail, 'aria-current': state === 'now' ? 'step' : null },
          h('i', { class: 'pip', 'aria-hidden': 'true' }), h('span', { class: state === 'now' ? 'live' : '' }, label));
        if (fresh) li.style.setProperty('--age', String(Math.round(a)));
        return li;
      }));
    }
    const sources = turn.sources || [];
    const queries = turn.queries || [];
    if (!sources.length && !queries.length) return h('div', { class: 'runline' });
    const okCount = sources.filter((s) => s.count > 0).length;
    const kept = (turn.papers || []).length;
    const qn = queries.length;
    let summary = `Searched ${okCount} database${okCount === 1 ? '' : 's'} with ${qn} quer${qn === 1 ? 'y' : 'ies'}, kept ${kept} papers`;
    let each = 'Query';
    if (turn.mode === 'trail') { summary = `Followed citations from ${qn} starting paper${qn === 1 ? '' : 's'} in OpenAlex, kept ${kept} papers`; each = 'Starting paper'; }
    if (turn.mode === 'verify') { summary = `Looked up ${qn} citation${qn === 1 ? '' : 's'}, matched ${kept} paper${kept === 1 ? '' : 's'}`; each = 'Citation'; }
    return h('div', { class: 'runline' },
      h('details', { class: 'searched' },
        h('summary', null, summary),
        h('ul', null,
          queries.map((q) => h('li', null, `${each}: ${q}`)),
          sources.map((s) => h('li', { class: s.error && !s.count ? 'bad' : '' },
            `${s.label}: ${s.count} result${s.count === 1 ? '' : 's'}${s.error ? ` — ${s.error}` : ''}`)))));
  }

  function buildTally(turn, turnEl) {
    const ins = turn.insights || [];
    if (!turn.yesNo || !ins.length) return h('div', { hidden: true });
    const order = ['supports', 'conditional', 'mixed', 'against', 'na'];
    const rows = (turn.papers || []).map((p) => ({ n: p.n, stance: (insightFor(turn, p.n) || {}).stance || 'na' }));
    const counted = rows.filter((r) => r.stance !== 'na');
    if (!counted.length) return h('div', { hidden: true });
    rows.sort((a, b) => order.indexOf(a.stance) - order.indexOf(b.stance) || a.n - b.n);
    const count = (s) => rows.filter((r) => r.stance === s).length;
    return h('div', { class: 'tally' },
      h('p', { class: 'tally-title' }, 'Where the papers point', h('small', null, `${counted.length} of ${rows.length} test this question`)),
      h('div', { class: 'tabs' }, rows.map((r) => h('button', {
        type: 'button', class: `tab ${r.stance}`, title: `Paper ${r.n}: ${STANCE_LABEL[r.stance]}`,
        'aria-label': `Paper ${r.n}: ${STANCE_LABEL[r.stance]}`,
        onclick: (e) => focusPaper(e.currentTarget.closest('.turn'), turn, r.n),
      }, r.n))),
      h('div', { class: 'legend' }, order.filter((s) => count(s) > 0).map((s) =>
        h('span', null, h('i', { class: `tab ${s}` }), `${STANCE_LABEL[s]} ${count(s)}`))),
      h('p', { class: 'tally-note' }, 'One tab per paper, judged from its abstract. A count of papers is not a verdict: open the ones you rely on.'));
  }

  function buildReasoning(turn) {
    if (!turn.thinking || !turn.thinking.trim()) return h('div', { hidden: true });
    const wasOpen = S.liveView && S.liveView.turn === turn && S.liveView.reasoning && S.liveView.reasoning.open;
    return h('details', { class: 'reasoning', open: wasOpen || null },
      h('summary', null, turn.running && !turn.answer ? 'Thinking it through' : 'How the model reasoned'),
      h('pre', null, turn.thinking.trim()));
  }

  // "Rahman & Aldous 2019" for each paper number, built from the database records. Two papers
  // that would read the same get a letter (2019a, 2019b), as they would in a reference list.
  const LABELS = new WeakMap();
  function citeLabels(turn) {
    if (S.app.settings.citeMarks !== 'author') return null;
    const papers = turn.papers || [];
    if (LABELS.has(papers)) return LABELS.get(papers);
    const base = new Map();
    const count = new Map();
    for (const p of papers) {
      const fam = p.authors.map((a) => a.family).filter(Boolean);
      if (!fam.length) continue; // no author on record: the mark keeps its number
      const who = fam.length === 1 ? fam[0] : (fam.length === 2 ? `${fam[0]} & ${fam[1]}` : `${fam[0]} et al.`);
      const label = `${who} ${p.year || 'n.d.'}`;
      base.set(p.n, label);
      count.set(label, (count.get(label) || 0) + 1);
    }
    const used = new Map();
    const labels = new Map();
    for (const [n, label] of base) {
      if (count.get(label) === 1) { labels.set(n, label); continue; }
      const k = used.get(label) || 0;
      used.set(label, k + 1);
      labels.set(n, `${label}${String.fromCharCode(97 + (k % 26))}`);
    }
    LABELS.set(papers, labels);
    return labels;
  }

  function answerParts(turn) {
    const labels = citeLabels(turn);
    const opts = { paperCount: (turn.papers || []).length, webSources: turn.webSources || [],
      citeLabel: labels ? (n) => labels.get(n) : null, citeStance: (n) => insightFor(turn, n)?.stance || '' };
    const parts = Render.splitLead(Render.splitFollowUps(turn.answer || '').body); // no brief for a meta opening
    const lead = Render.renderAnswer(parts.lead, opts);
    const body = Render.renderAnswer(parts.body, opts);
    turn.cited = new Set([...lead.cited, ...body.cited]);
    turn.citeCounts = new Map();
    for (const match of (lead.html + body.html).matchAll(/data-n="(\d+)"/g)) {
      const n = Number(match[1]); turn.citeCounts.set(n, (turn.citeCounts.get(n) || 0) + 1);
    }
    return { lead, body, hasLead: !!parts.lead };
  }

  function buildSummary(turn) {
    const parts = answerParts(turn);
    // asked every time, so the memory knows the card was not there before the opening arrived
    const shown = Motion.age(turn, 'lead', !!parts.hasLead);
    if (!parts.hasLead) return h('div', { hidden: true });
    const card = h('section', { class: 'answer-summary', 'aria-label': 'Answer in brief' },
      h('p', { class: 'summary-eyebrow' }, 'Answer in brief'),
      h('div', { class: 'answer summary-text', html: parts.lead.html }),
      h('p', { class: 'summary-source' }, `${(turn.papers || []).length} retrieved papers · Abstract-level synthesis · Open the evidence you rely on`));
    return shown == null ? card : Motion.enter(card, 0, shown); // the card rises in when the opening first arrives
  }

  /**
   * One figure from a paper. The image, label, caption, licence and links come from the article's
   * open-access record (server/sources/figures.js); only "How to read" is model-written, and the
   * server drops it when it states a number the caption does not.
   */
  function figureCard(turn, f, first) {
    const labels = citeLabels(turn);
    const p = (turn.papers || []).find((x) => x.n === f.n);
    const name = `${f.label}${f.title ? `: ${f.title}` : ''}`;
    const card = h('figure', { class: 'paper-figure', 'data-evidence-section': first ? 'figures' : null, tabindex: first ? '-1' : null },
      h('figcaption', { class: 'pf-head' },
        h('button', { type: 'button', class: 'cite named', 'data-n': f.n, 'aria-label': `Paper ${f.n}: ${labels?.get(f.n) || `Paper ${f.n}`}` }, labels?.get(f.n) || `Paper ${f.n}`),
        h('span', { class: 'pf-label' }, f.label), f.title && h('span', { class: 'pf-title' }, f.title)),
      h('a', { class: 'pf-image', href: f.page, target: '_blank', rel: 'noopener noreferrer', title: 'Open the full article, with the figure at full size' },
        h('img', {
          src: f.img, alt: name, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
          onerror: (e) => { const fig = e.target.closest('.paper-figure'); if (fig) fig.hidden = true; },
        })),
      f.read && h('p', { class: 'pf-read' }, h('strong', null, 'How to read: '), f.read),
      f.caption && h('details', { class: 'pf-caption' }, h('summary', null, 'Full caption'), h('p', null, f.caption)),
      h('p', { class: 'pf-source' }, 'From ', h('cite', null, p ? p.title : `paper ${f.n}`),
        f.license && ` · ${f.license}`, ' · ', h('a', { href: f.page, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Europe PMC')));
    return card;
  }

  function buildAnswer(turn) {
    const el = h('div', { class: 'answer answer-body', 'data-evidence-section': 'synthesis', tabindex: '-1', html: answerParts(turn).body.html });
    // Once the answer is complete, each figure goes after the first paragraph that cites its paper
    // (while it streams they wait below it, in buildFigures, so images do not reload on every word).
    if (!turn.running) {
      const lastAfter = new Map(); // two figures after the same paragraph keep their order
      (turn.figures || []).forEach((f, i) => {
        const mark = el.querySelector(`.cite[data-n="${f.n}"]`);
        let block = mark;
        while (block && block.parentElement !== el) block = block.parentElement;
        const card = figureCard(turn, f, i === 0);
        if (block) { (lastAfter.get(block) || block).after(card); lastAfter.set(block, card); } else el.append(card);
      });
    }
    return el;
  }

  function buildFigures(turn) {
    if (!turn.running || !(turn.figures || []).length) return h('div', { hidden: true });
    return h('div', { class: 'figures-live' }, turn.figures.map((f, i) => figureCard(turn, f, i === 0)));
  }

  function buildEvidence(turn) {
    const labels = citeLabels(turn);
    const el = window.LecternEvidenceUI.build(turn, { h, label: (n) => labels?.get(n) || `Paper ${n}`,
      inspect: (ids, name) => {
        const turnEl = [...document.querySelectorAll('.turn')].find((el) => el._turn === turn);
        if (!turnEl) return;
        const st = shelfState(turn);
        Object.assign(st, { paperNs: ids, filterLabel: name, citedOnly: false, query: '' });
        openReferences(turn, true);
      },
    });
    // the comparison, charts and map rise in when the readings of the abstracts first arrive
    const a = Motion.age(turn, 'evidence', window.LecternEvidenceUI.plan(turn).readings.length > 0);
    return a == null ? el : Motion.enter(el, 0, a);
  }

  /** Links to the parts of this answer. Only the views it actually has are listed (see evidence.js plan). */
  function buildAnswerNav(turn) {
    if (turn.mode === 'verify') return h('div', { hidden: true });
    const views = window.LecternEvidenceUI.plan(turn);
    const items = [['synthesis', 'Synthesis'],
      (turn.figures || []).length > 0 && ['figures', (turn.figures.length === 1 ? 'Figure' : 'Figures')],
      views.compare && ['compare', 'Compare studies'],
      (views.direction || views.design) && ['charts', 'Evidence charts'],
      views.coverage && ['coverage', 'Coverage map']].filter(Boolean);
    if (items.length < 2) return h('div', { hidden: true });
    return h('nav', { class: 'answer-nav', 'aria-label': 'Explore this answer' }, items.map(([key, label]) =>
      h('button', { type: 'button', onclick: (e) => {
        const section = e.currentTarget.closest('.turn').querySelector(`[data-evidence-section="${key}"]`);
        if (section) { section.scrollIntoView({ block: 'start', behavior: 'smooth' }); section.focus({ preventScroll: true }); }
      } }, label)));
  }

  /** The questions the answer suggests asking next, as buttons that ask them in this conversation. */
  function buildNext(turn) {
    const questions = Render.splitFollowUps(turn.answer || '').followUps;
    if (!questions.length) return h('div', { hidden: true });
    const busy = !!(S.live && S.live.running);
    return h('div', { class: 'next' },
      h('h3', null, 'Ask next'),
      h('ul', null, questions.map((q) => h('li', null,
        h('button', { type: 'button', class: 'example', disabled: busy || null, onclick: () => ask(q, { parent: turn.id }) }, q)))));
  }

  // Pointing at a citation mark (or tabbing to it) shows which paper it is, without leaving the sentence.
  const citeCard = h('div', { class: 'cite-card', id: 'cite-card', role: 'tooltip', hidden: true });
  let citeCardFor = null;
  function hideCiteCard() {
    citeCard.hidden = true;
    if (citeCardFor) citeCardFor.removeAttribute('aria-describedby');
    citeCardFor = null;
  }
  function showCiteCard(chip, turn) {
    if (citeCardFor === chip) return;
    const p = (turn.papers || []).find((x) => x.n === Number(chip.dataset.n));
    if (!p) { hideCiteCard(); return; }
    hideCiteCard();
    citeCardFor = chip;
    chip.setAttribute('aria-describedby', 'cite-card');
    const ins = insightFor(turn, p.n);
    const facts = [
      p.kind !== 'Article' && p.kind,
      p.citations != null && `${nf.format(p.citations)} citation${p.citations === 1 ? '' : 's'}`,
      `number ${p.n} in the paper list`,
    ].filter(Boolean).join(', ');
    fill(citeCard,
      h('strong', null, p.title),
      h('span', { class: 'paper-by' }, byLine(p)),
      ins && ins.relevant && ins.finding && h('span', { class: 'finding' }, ins.finding),
      h('small', null, facts));
    if (!citeCard.isConnected) document.body.append(citeCard);
    citeCard.hidden = false;
    const r = chip.getBoundingClientRect();
    const below = r.bottom + 8;
    const tall = citeCard.offsetHeight;
    citeCard.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - citeCard.offsetWidth - 12))}px`;
    citeCard.style.top = `${below + tall > window.innerHeight - 12 ? Math.max(12, r.top - tall - 8) : below}px`;
  }
  document.addEventListener('scroll', hideCiteCard, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCiteCard(); });

  function exportPapers(turn) {
    const cited = (turn.papers || []).filter((p) => turn.cited && turn.cited.has(p.n));
    return cited.length ? cited : (turn.papers || []);
  }

  function copyAnswer(turn) {
    const style = S.app.settings.citeStyle;
    const cited = (turn.papers || []).filter((p) => turn.cited && turn.cited.has(p.n));
    const refsText = cited.map((p) => `[${p.n}] ${Cite.format(p, style).text}`).join('\n');
    // The copy keeps numbered citations so they match the numbered reference list under it,
    // and leaves out the "ask next" questions, which belong to the app and not to the answer.
    const body = Render.splitFollowUps(turn.answer).body;
    const tmp = h('div', { html: Render.renderAnswer(body, { paperCount: turn.papers.length, webSources: turn.webSources || [] }).html });
    tmp.querySelectorAll('.cite').forEach((el) => el.replaceWith(`[${el.textContent}]`));
    const refsHtml = cited.map((p) => `<p>[${p.n}] ${Cite.format(p, style).html}</p>`).join('');
    const web = (turn.webSources || []).map((w, i) => `[W${i + 1}] ${w.title} ${w.url}`).join('\n');
    copyRich({
      text: `${turn.question}\n\n${body}\n\nReferences\n${refsText}${web ? `\n\nWeb pages\n${web}` : ''}`,
      html: `<h2>${Render.esc(turn.question)}</h2>${tmp.innerHTML}<h3>References</h3>${refsHtml}`,
    }, 'Answer copied with its references');
  }

  function buildFoot(turn) {
    const kids = [];
    for (const n of turn.notices || []) kids.push(h('div', { class: 'notice' }, n));
    if (turn.stopped) kids.push(h('div', { class: 'notice' }, 'Stopped. This partial answer was not saved.'));
    if (turn.error) {
      kids.push(h('div', { class: 'error' }, turn.error, h('br'),
        h('button', { class: 'btn small', onclick: () => ask(turn.question, { parent: turn.parentId, mode: turn.mode }) }, 'Try again'), ' ',
        h('button', { class: 'btn small', onclick: openSettings }, 'Open Settings')));
    }
    const web = turn.webSources || [];
    if (web.length) {
      kids.push(h('div', { class: 'websources' },
        h('h3', null, 'Web pages used'),
        h('ol', null, web.map((w, i) => h('li', null,
          h('span', { class: 'cite cite-web' }, `W${i + 1}`),
          isWebUrl(w.url) ? h('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer' }, w.title || w.url) : (w.title || ''),
          h('small', null, (() => { try { return new URL(w.url).hostname.replace(/^www\./, ''); } catch { return ''; } })()))))));
    }
    const saved = !!(S.thread && turn.id && S.thread.turns.includes(turn));
    const hasRefs = !turn.running && turn.answer && (turn.papers || []).length;
    if (saved || hasRefs) {
      const style = S.app.settings.citeStyle;
      kids.push(h('div', { class: 'turn-actions' },
        saved && h('button', {
          class: 'btn small', disabled: isBusy() || null, title: 'Ask the same question again. This answer is kept as an earlier version.',
          onclick: () => ask(turn.question, { parent: turn.parent, mode: turn.mode }),
        }, 'Retry'),
        hasRefs && [
        h('button', { class: 'btn small', onclick: () => copyAnswer(turn) }, 'Copy answer'),
        h('button', { class: 'btn small', onclick: () => copyRich(Cite.formatList(exportPapers(turn), style), 'Reference list copied') },
          `Copy reference list (${Cite.STYLES[style].label})`),
        h('button', { class: 'btn small', onclick: () => download('lectern-references.bib', Cite.formatList(exportPapers(turn), 'bibtex').text) }, 'Download .bib'),
        h('button', { class: 'btn small', onclick: () => download('lectern-references.ris', Cite.formatList(exportPapers(turn), 'ris').text, 'application/x-research-info-systems') }, 'Download .ris')]));
    }
    if (!turn.running && turn.engine) {
      const info = engineInfo(turn.engine);
      const u = turn.usage;
      const bits = [`${info ? info.short : turn.engine}, ${prettyModel(turn.model, turn.engine)}, ${(EFFORT_LABEL[turn.effort] || '').toLowerCase()} effort`];
      if (turn.web) bits.push('web search on');
      if (u && (u.input || u.output)) bits.push(`${nf.format(u.input)} tokens read, ${nf.format(u.output)} written`);
      kids.push(h('div', { class: 'turn-meta' }, bits.join('; ')));
    }
    return h('div', { class: 'foot' }, kids);
  }

  /** The question, with its version switcher and actions (edit, copy, new chat from here, delete). */
  function buildPrompt(turn) {
    const t = S.thread;
    const saved = !!(t && turn.id && t.turns.includes(turn));
    if (saved && S.editing === turn.id) return buildEditBox(turn);
    const busy = isBusy();
    const vers = saved ? versionsOf(t, turn) : [];
    const i = vers.indexOf(turn);
    const tool = turn.mode && turn.mode !== 'answer' ? modeInfo(turn.mode) : null;
    const long = turn.question.length > 240;
    const heading = h('h2', { class: `question${long ? ' long' : ''}` }, long ? `${turn.question.slice(0, 220).trimEnd()}…` : turn.question);
    return h('div', { class: 'prompt' },
      tool && h('div', { class: 'mode-tag' }, icon(tool.id), tool.label),
      heading,
      long && h('button', {
        type: 'button', class: 'icon-btn show-all', 'aria-expanded': 'false',
        onclick: (e) => {
          const openNow = e.currentTarget.getAttribute('aria-expanded') !== 'true';
          heading.textContent = openNow ? turn.question : `${turn.question.slice(0, 220).trimEnd()}…`;
          e.currentTarget.setAttribute('aria-expanded', String(openNow));
          e.currentTarget.textContent = openNow ? 'Show less' : 'Show all';
        },
      }, 'Show all'),
      saved && h('div', { class: 'prompt-bar' },
        vers.length > 1 && h('span', { class: 'versions', role: 'group', 'aria-label': 'Versions of this question' },
          h('button', { class: 'icon-btn', 'aria-label': 'Previous version', disabled: i === 0 || null, onclick: () => showVersion(vers[i - 1]) }, '‹'),
          h('span', { 'aria-live': 'polite' }, `${i + 1} / ${vers.length}`),
          h('button', { class: 'icon-btn', 'aria-label': 'Next version', disabled: i === vers.length - 1 || null, onclick: () => showVersion(vers[i + 1]) }, '›')),
        h('span', { class: 'prompt-actions' },
          h('button', { class: 'icon-btn', disabled: busy || null, title: 'Edit this question and ask again. The current answer is kept as an earlier version.', onclick: () => { S.editing = turn.id; render(); } }, 'Edit'),
          h('button', { class: 'icon-btn', onclick: () => copyRich({ text: turn.question }, 'Question copied') }, 'Copy'),
          h('button', { class: 'icon-btn', disabled: busy || null, title: 'Start a new conversation with everything up to here', onclick: () => branchFrom(turn) }, 'New chat from here'),
          h('button', { class: 'icon-btn del', disabled: busy || null, onclick: () => deleteTurn(turn) }, 'Delete'))));
  }

  function buildEditBox(turn) {
    const ta = h('textarea', {
      class: 'input edit-question', rows: '2', 'aria-label': 'Edit your question',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      },
      oninput: (e) => grow(e.target),
    });
    ta.value = turn.question;
    const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 260)}px`; };
    const cancel = () => { S.editing = null; render(); };
    const send = () => {
      const q = ta.value.trim();
      if (!q || isBusy()) return;
      S.editing = null;
      ask(q, { parent: turn.parent, mode: turn.mode });
    };
    requestAnimationFrame(() => { grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return h('div', { class: 'edit-box' },
      ta,
      h('div', { class: 'edit-row' },
        h('small', null, 'Sends as a new version. The current answer stays under ‹ ›.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: cancel }, 'Cancel'),
        h('button', { class: 'btn small primary', onclick: send }, 'Send')));
  }

  function buildTurn(turn) {
    const view = { turn };
    view.runline = buildRunline(turn);
    view.summary = buildSummary(turn);
    view.reasoning = buildReasoning(turn);
    view.answer = buildAnswer(turn);
    view.figures = buildFigures(turn);
    view.nav = buildAnswerNav(turn);
    view.evidence = buildEvidence(turn);
    view.foot = buildFoot(turn);
    view.next = buildNext(turn);
    view.el = h('article', { class: 'turn evidence-turn' },
      h('div', { class: 'page' }, buildPrompt(turn), view.runline, view.summary,
        view.nav, view.reasoning, view.answer, view.figures, view.evidence, view.foot, view.next));
    view.el._turn = turn;
    const citeChip = (e) => e.target.closest('button.cite[data-n]');
    view.el.addEventListener('click', (e) => {
      const chip = citeChip(e);
      if (chip) focusPaper(turn, Number(chip.dataset.n));
    });
    view.el.addEventListener('mouseover', (e) => {
      const chip = citeChip(e);
      if (chip) showCiteCard(chip, turn); else hideCiteCard();
    });
    view.el.addEventListener('mouseleave', hideCiteCard);
    view.el.addEventListener('focusin', (e) => { const chip = citeChip(e); if (chip) showCiteCard(chip, turn); });
    view.el.addEventListener('focusout', hideCiteCard);
    return view;
  }

  /** Re-draw one part of the turn being answered, without touching the rest of the page. */
  const BUILDERS = { runline: buildRunline, summary: buildSummary, evidence: buildEvidence, tally: buildTally, reasoning: buildReasoning, answer: buildAnswer, foot: buildFoot, next: buildNext, figures: buildFigures, nav: buildAnswerNav };
  const pending = new Set();
  let frame = 0;
  function refreshLive(...parts) {
    for (const p of parts) pending.add(p);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const v = S.liveView;
      const todo = [...pending];
      pending.clear();
      if (!v || !v.el.isConnected || !S.live || v.turn !== S.live) return;
      if (todo.includes('answer')) hideCiteCard(); // its mark is about to be replaced
      for (const part of todo) {
        if (part === 'shelf') continue;
        const fresh = BUILDERS[part](S.live);
        v[part].replaceWith(fresh);
        v[part] = fresh;
        if (part === 'answer' || part === 'summary') Motion.stream(fresh, S.live, part); // the text that has just arrived fades in
      }
      if (todo.includes('shelf') && (!S.referenceTurn || S.referenceTurn === S.live)) refreshReferences();
    });
  }

  function renderThread() {
    const t = S.thread;
    const showLive = S.live && S.live.thread === t;
    // While a new version is being written, show the conversation up to the question it follows.
    const end = showLive && S.live.parentId !== undefined ? S.live.parentId : t.leaf;
    const turns = end ? pathTo(t, end) : [];
    const views = turns.map(buildTurn);
    if (showLive) { S.liveView = buildTurn(S.live); views.push(S.liveView); } else S.liveView = null;
    const panel = h('aside', { id: 'references-panel', class: 'references-panel', hidden: !S.referencesOpen, 'aria-labelledby': 'references-heading' });
    panel.addEventListener('mouseover', (e) => highlightPaper(S.referenceTurn, e.target.closest('.paper[data-n]')?.dataset.n));
    panel.addEventListener('mouseleave', () => highlightPaper(S.referenceTurn, null));
    panel.addEventListener('focusin', (e) => highlightPaper(S.referenceTurn, e.target.closest('.paper[data-n]')?.dataset.n));
    panel.addEventListener('focusout', () => highlightPaper(S.referenceTurn, null));
    return h('section', { class: 'thread-workspace' },
      h('header', { class: 'thread-topbar' },
        h('span', { class: 'thread-title', title: t.title }, t.title),
        h('button', { type: 'button', class: 'btn references-toggle', 'aria-controls': 'references-panel', 'aria-expanded': String(S.referencesOpen), onclick: () => {
          if (S.referencesOpen) closeReferences(); else openReferences(null, true);
        } }, icon('review'), 'References')),
      h('div', { class: `thread-layout${S.referencesOpen ? ' references-open' : ''}` },
        h('div', { class: 'view thread-view' },
          h('div', { class: 'thread' }, views.map((v) => v.el)),
          h('div', { class: 'dock' }, buildComposer({ placeholder: 'Ask a follow-up', autofocus: false, dock: true }))),
        panel));
  }

  // ------------------------------------------------------------------ library
  function renderLibrary() {
    const q = S.libraryQuery.trim().toLowerCase();
    const shown = q
      ? S.library.filter((p) => `${p.title} ${p.venue} ${p.year} ${p.authors.map((a) => a.family).join(' ')}`.toLowerCase().includes(q))
      : S.library;
    const style = S.app.settings.citeStyle;
    const list = h('ol', { class: 'papers' }, shown.map((p) => paperRow(p, { turn: null, showNumber: false })));
    return h('section', { class: 'view library' },
      h('h1', null, 'Library'),
      h('p', { class: 'sub' }, S.library.length
        ? `${S.library.length} saved paper${S.library.length === 1 ? '' : 's'}. Export them as a reference list, or into Zotero, Mendeley or EndNote.`
        : 'Papers you save are kept here, ready to export as a reference list.'),
      S.library.length > 0 && h('div', { class: 'bar' },
        h('input', {
          class: 'input search', type: 'search', placeholder: 'Find in your library', value: S.libraryQuery, 'aria-label': 'Find in your library',
          oninput: (e) => { S.libraryQuery = e.target.value; const pos = e.target.selectionStart; render(); const el = $('.input.search'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } },
        }),
        h('select', { class: 'select', 'aria-label': 'Reference style', onchange: async (e) => { await saveSettings({ citeStyle: e.target.value }); render(); } },
          Object.entries(Cite.STYLES).filter(([, s]) => s.list).map(([id, s]) => h('option', { value: id, selected: id === style }, s.label))),
        h('button', { class: 'btn', onclick: () => copyRich(Cite.formatList(shown, style), 'Reference list copied') }, 'Copy reference list'),
        h('button', { class: 'btn', onclick: () => download('lectern-library.bib', Cite.formatList(shown, 'bibtex').text) }, 'Download .bib'),
        h('button', { class: 'btn', onclick: () => download('lectern-library.ris', Cite.formatList(shown, 'ris').text, 'application/x-research-info-systems') }, 'Download .ris')),
      S.library.length === 0
        ? h('p', { class: 'empty' }, 'Nothing saved yet. Ask a question, then press Save on any paper you want to keep.')
        : (shown.length ? list : h('p', { class: 'empty' }, 'No saved paper matches that search.')));
  }

  // ------------------------------------------------------------------ cite dialog
  function openDialog(title, body) {
    const d = $('#dialog');
    Motion.animateDialog(d);   // it fades out when closed, Escape included
    Motion.keepDialogOpen(d);  // opened again while it was still fading out: it stays
    d.replaceChildren(
      h('div', { class: 'dialog-head' }, h('h2', null, title),
        h('button', { class: 'btn quiet', onclick: () => d.close(), 'aria-label': 'Close' }, 'Close')),
      body);
    if (!d.open) d.showModal();
    return d;
  }

  function openCite(p) {
    let style = S.app.settings.citeStyle;
    const body = h('div', { class: 'dialog-body' });
    const draw = () => {
      const out = Cite.format(p, style);
      const mono = style === 'bibtex' || style === 'ris';
      fill(body,
        Motion.slide(h('div', { class: 'cite-styles', role: 'radiogroup', 'aria-label': 'Reference style' },
          Object.entries(Cite.STYLES).map(([id, s]) => h('button', {
            type: 'button', class: `btn small${id === style ? ' primary' : ''}`, role: 'radio', 'aria-checked': String(id === style),
            onclick: () => { style = id; if (s.list) saveSettings({ citeStyle: id }); draw(); },
          }, s.label))), 'cite-style'),
        mono ? h('pre', { class: 'cite-out mono' }, out.text) : h('p', { class: 'cite-out', html: out.html }),
        style === 'apa' && h('p', { class: 'help' }, 'In text: ', Cite.apaInText(p)),
        h('div', { class: 'cite-foot' },
          h('small', null, 'Built from database records. Check names, capitalisation and page numbers against the paper before you submit.'),
          h('button', { class: 'btn primary', onclick: () => copyRich(out, 'Reference copied') }, 'Copy')));
    };
    draw();
    openDialog('Cite this paper', body);
  }

  // ------------------------------------------------------------------ reader profile (level and field of study)
  /** "Master's · Engineering", or '' when nothing is set. Labels come from the server's lists. */
  function profileLabel(p) {
    const prof = p || S.app.settings.profile;
    const opts = S.app.profileOptions;
    const level = opts.levels.find((l) => l.id === prof.level);
    const field = prof.field === 'other' ? { label: prof.fieldOther } : opts.fields.find((f) => f.id === prof.field);
    return [level && level.label, field && field.label].filter(Boolean).join(' · ');
  }

  function openProfile() {
    const cur = S.app.settings.profile;
    const draft = { level: cur.level, field: cur.field, fieldOther: cur.fieldOther };
    const body = h('div', { class: 'dialog-body' });

    // One set of cards where at most one is chosen. Choosing the chosen card again clears it.
    const choices = (key, label, list, wide) => Motion.slide(h('div', { class: `choices${wide ? ' wide' : ''}`, role: 'radiogroup', 'aria-label': label },
      list.map((o) => h('button', {
        type: 'button', class: `choice${draft[key] === o.id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(draft[key] === o.id),
        onclick: () => { draft[key] = draft[key] === o.id ? '' : o.id; draw(key, o.id); },
      }, o.label))), `profile-${key}`);

    const save = async (patch, message) => {
      try { await saveSettings({ profile: { ...patch, asked: true } }); $('#dialog').close(); toast(message); render(); }
      catch (e) { toast(e.message); }
    };

    function draw(focusKey, focusId) {
      const scroll = body.parentElement ? body.parentElement.scrollTop : 0;
      const needsName = draft.field === 'other' && !draft.fieldOther.trim();
      fill(body,
        h('p', { class: 'help', style: 'margin-top:14px' }, 'Lectern uses this to pitch each answer: how much it explains, how deep it goes into methods, and which field\'s point of view it takes. The papers it finds stay the same. Both are optional.'),
        h('h3', null, 'What level are you studying at?'),
        choices('level', 'Level of study', S.app.profileOptions.levels, true),
        h('h3', null, 'What is your field or major?'),
        choices('field', 'Field of study', S.app.profileOptions.fields),
        draft.field === 'other' && h('div', { class: 'engine-row' },
          h('label', { for: 'fieldOther' }, 'Your field'),
          h('input', {
            class: 'input', id: 'fieldOther', maxlength: '60', value: draft.fieldOther, placeholder: 'For example: Architecture',
            oninput: (e) => { draft.fieldOther = e.target.value; $('#profile-save').disabled = !e.target.value.trim(); },
          })),
        h('div', { class: 'cite-foot' }, h('small'),
          (cur.level || cur.field) && h('button', { class: 'btn quiet', onclick: () => save({ level: '', field: '', fieldOther: '' }, 'Answers are back to the general style') }, 'Clear'),
          h('button', { class: 'btn', onclick: () => $('#dialog').close() }, 'Not now'),
          h('button', { class: 'btn primary', id: 'profile-save', disabled: needsName || null, onclick: () => save(draft, 'Saved. New answers will follow this') }, 'Save')));
      if (body.parentElement) body.parentElement.scrollTop = scroll;
      // Redrawing replaces the cards, so put the keyboard focus back where it was.
      if (focusKey === 'field' && focusId === 'other' && draft.field === 'other') $('#fieldOther').focus();
      else if (focusKey) {
        const group = body.querySelectorAll('.choices')[focusKey === 'level' ? 0 : 1];
        const list = S.app.profileOptions[focusKey === 'level' ? 'levels' : 'fields'];
        const btn = group.children[list.findIndex((o) => o.id === focusId)];
        if (btn) btn.focus();
      }
    }
    draw();
    openDialog('What you study', body);
  }

  // ------------------------------------------------------------------ settings dialog
  async function saveSettings(patch) {
    const before = S.app.settings;
    S.app = await api('PUT', '/api/settings', patch);
    const after = S.app.settings;
    const c = S.compose;
    // If the default engine or its model changed in Settings, the ask box follows.
    if (after.engine && after.engine !== before.engine) { c.engine = after.engine; c.model = after.models[c.engine] || ''; }
    else if (c.engine && after.models[c.engine] !== before.models[c.engine]) c.model = after.models[c.engine] || '';
    settleCompose();
    savePrefs();
    return S.app;
  }

  async function refreshState() {
    S.app = await api('GET', '/api/state');
    settleCompose();
    render();
  }

  function openSettings() {
    const s = S.app.settings;
    const draft = {
      engine: s.engine || S.app.activeEngine || '',
      models: { ...s.models }, helperModels: { ...s.helperModels },
      keys: {}, bins: { ...s.bins }, sources: { ...s.sources },
      email: s.email, maxPapers: s.maxPapers, effort: s.effort, insights: s.insights, citeStyle: s.citeStyle, citeMarks: s.citeMarks,
      profile: { level: s.profile.level, field: s.profile.field, fieldOther: s.profile.fieldOther },
    };
    const body = h('div', { class: 'dialog-body' });
    const results = {};

    const collect = () => ({ ...draft, maxPapers: Number(draft.maxPapers) || 16 });
    // How many papers go into an answer: a slider, with the number beside it counting to the new value as it is dragged.
    const paperSlider = () => {
      const lo = 6, hi = 30;
      const val = h('output', { class: 'range-val', for: 'maxPapers' });
      const set = (n) => {
        draft.maxPapers = n;
        input.style.setProperty('--p', `${((n - lo) / (hi - lo)) * 100}%`);
        input.setAttribute('aria-valuetext', `${n} papers`);
        Motion.count(val, 'settings', 'maxPapers', n, undefined, 260);
      };
      const input = h('input', {
        class: 'range', id: 'maxPapers', type: 'range', min: String(lo), max: String(hi), step: '1',
        value: Math.min(hi, Math.max(lo, Number(draft.maxPapers) || 16)), 'aria-label': 'Papers per answer',
        oninput: (e) => set(Number(e.target.value)),
      });
      set(Number(input.value));
      return h('span', { class: 'range-row' }, input, val);
    };
    const keyField = (name, label, link) => {
      const k = S.app.settings.keys[name];
      return h('div', { class: 'engine-row' },
        h('label', { for: `key-${name}` }, label),
        h('input', {
          class: 'input', id: `key-${name}`, type: 'password', autocomplete: 'off', spellcheck: 'false',
          placeholder: k.set ? `Saved (${k.hint})${k.fromEnv ? ', from your shell environment' : ''}` : 'Paste key',
          oninput: (e) => { if (e.target.value.trim()) draft.keys[name] = e.target.value.trim(); else delete draft.keys[name]; },
        }),
        link && h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key'),
        k.set && !k.fromEnv && h('button', { class: 'btn small quiet', onclick: async () => { await saveSettings({ keys: { [name]: '' } }); draw(); render(); } }, 'Remove'));
    };
    const modelField = (engine, which, label) => h('div', { class: 'engine-row' },
      h('label', { for: `${which}-${engine}` }, label),
      h('input', {
        class: 'input', id: `${which}-${engine}`, list: `models-${engine}`, spellcheck: 'false', value: draft[which][engine],
        placeholder: engine === 'codex' ? 'Blank uses Codex\'s own default' : 'Model ID',
        oninput: (e) => { draft[which][engine] = e.target.value.trim(); },
      }));

    const engineBlock = (e) => {
      const isDefault = draft.engine === e.id;
      const r = results[e.id];
      const blurb = {
        'claude-code': 'Uses your saved Claude sign-in through Claude Code. To sign in, open Claude Code in the Claude app, or run "claude" in Terminal.',
        codex: 'Uses your saved ChatGPT sign-in through Codex. To sign in, open Codex in the ChatGPT app, or run "codex login" in Terminal. Answers arrive in one piece.',
      }[e.id];
      return h('div', { class: `engine${isDefault ? ' active' : ''}` },
        h('div', { class: 'engine-top' },
          h('strong', null, e.label),
          h('span', { class: `engine-state${e.ready ? ' ready' : ''}` }, e.ready ? 'Ready' : (e.found ? 'Not signed in' : 'Not installed')),
          h('button', { class: `btn small${isDefault ? ' primary' : ''}`, disabled: isDefault || null, onclick: () => { draft.engine = e.id; draw(); } }, isDefault ? 'Default' : 'Make default')),
        h('p', { class: 'engine-detail' }, e.detail),
        h('p', null, blurb),
        modelField(e.id, 'models', 'Answer model'),
        modelField(e.id, 'helperModels', 'Helper model'),
        h('datalist', { id: `models-${e.id}` }, e.models.map((m) => h('option', { value: m }))),
        h('div', { class: 'engine-row' },
          h('button', {
            class: 'btn small',
            onclick: async (ev) => {
              ev.currentTarget.disabled = true;
              results[e.id] = { pending: true };
              draw();
              try {
                await saveSettings(collect());
                draft.keys = {};
                results[e.id] = await api('POST', '/api/test-engine', { engine: e.id });
              } catch (err) { results[e.id] = { ok: false, error: err.message }; }
              draw(); render();
            },
          }, 'Save and test'),
          r && r.pending && (Motion.age('settings', `test-${e.id}`, 'pending'), h('span', { class: 'test-result' }, 'Asking the model to reply…'))),
        // the result rises in when it arrives (the pending line above is what the memory is told about)
        r && !r.pending && Motion.pop(h('div', { class: `test-result ${r.ok ? 'ok' : 'bad'}` },
          r.ok ? `Working. ${prettyModel(r.model, e.id)} replied in ${(r.ms / 1000).toFixed(1)} s.` : r.error), 'settings', `test-${e.id}`, r.ok ? 'ok' : `bad:${r.error}`, true, 'enter'));
    };

    function draw() {
      const scroll = body.parentElement ? body.parentElement.scrollTop : 0;
      fill(body,
        h('h3', null, 'Model'),
        h('p', { class: 'help' }, 'Connect at least one. The answer model writes the answer at the effort you pick; the helper model does the quick jobs (planning the search, reading each abstract).'),
        // the highlighted edge slides to whichever card is made the default
        Motion.slide(h('div', { class: 'engine-list' }, S.app.engines.map(engineBlock)), 'default-engine'),

        h('h3', null, 'Paper databases'),
        h('p', { class: 'help' }, 'Lectern searches these and merges the results. Links and reference details always come from the databases, not from the model.'),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, S.app.sources.map((src) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: draft.sources[src.name], onchange: (e) => { draft.sources[src.name] = e.target.checked; } }),
            src.label + (src.name === 'europepmc' ? ' (medicine and life sciences)' : '')))),
          keyField('openalex', 'OpenAlex key', 'https://openalex.org/settings/api'),
          keyField('semanticscholar', 'Semantic Scholar key', 'https://www.semanticscholar.org/product/api#api-key-form'),
          h('div', { class: 'engine-row' },
            h('label', { for: 'email' }, 'Your email'),
            h('input', { class: 'input', id: 'email', type: 'email', value: draft.email, placeholder: 'Optional. Crossref gives steadier service to identified requests', oninput: (e) => { draft.email = e.target.value.trim(); } }))),
        h('p', { class: 'help' }, 'OpenAlex is the broadest database and needs a free key (about a minute to get). Semantic Scholar works without one but is often busy; a free key fixes that.'),

        h('h3', null, 'What you study'),
        h('p', { class: 'help' }, 'Answers are pitched at this level and framed for this field. The papers Lectern finds stay the same.'),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, h('label', { for: 'profileLevel' }, 'Level'),
            h('select', { class: 'select', id: 'profileLevel', onchange: (e) => { draft.profile.level = e.target.value; } },
              h('option', { value: '', selected: !draft.profile.level }, 'Not set'),
              S.app.profileOptions.levels.map((l) => h('option', { value: l.id, selected: l.id === draft.profile.level }, l.label)))),
          h('div', { class: 'row' }, h('label', { for: 'profileField' }, 'Field or major'),
            h('select', { class: 'select', id: 'profileField', onchange: (e) => { draft.profile.field = e.target.value; draw(); } },
              h('option', { value: '', selected: !draft.profile.field }, 'Not set'),
              S.app.profileOptions.fields.map((f) => h('option', { value: f.id, selected: f.id === draft.profile.field }, f.label))),
            draft.profile.field === 'other' && h('input', {
              class: 'input wide', 'aria-label': 'Your field', maxlength: '60', value: draft.profile.fieldOther, placeholder: 'Your field, for example: Architecture',
              oninput: (e) => { draft.profile.fieldOther = e.target.value; },
            }))),

        h('h3', null, 'Answers'),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, h('label', { for: 'maxPapers' }, 'Papers per answer'),
            paperSlider(),
            h('span', { class: 'engine-state' }, 'More papers means a broader answer that costs more to write.')),
          h('div', { class: 'row' }, h('label', { for: 'citeStyle' }, 'Reference style'),
            h('select', { class: 'select', id: 'citeStyle', onchange: (e) => { draft.citeStyle = e.target.value; } },
              Object.entries(Cite.STYLES).filter(([, st]) => st.list).map(([id, st]) => h('option', { value: id, selected: id === draft.citeStyle }, st.label)))),
          h('div', { class: 'row' }, h('label', { for: 'citeMarks' }, 'Citations in answers'),
            h('select', { class: 'select', id: 'citeMarks', onchange: (e) => { draft.citeMarks = e.target.value; } },
              [['author', 'Author and year'], ['number', 'Numbers']].map(([v, l]) => h('option', { value: v, selected: v === draft.citeMarks }, l))),
            h('span', { class: 'engine-state' }, 'How each citation is marked inside the answer text.')),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: draft.insights, onchange: (e) => { draft.insights = e.target.checked; } }),
            'Read each paper for its finding, design and stance (one extra helper call per question)')),

        h('p', { class: 'help', style: 'margin-top:22px' }, `Settings, conversations and your library are stored on this Mac in ${S.app.dataDir}`),
        h('div', { class: 'cite-foot' }, h('small'),
          h('button', { class: 'btn', onclick: () => $('#dialog').close() }, 'Cancel'),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              try { await saveSettings(collect()); $('#dialog').close(); toast('Settings saved'); render(); }
              catch (e) { toast(e.message); }
            },
          }, 'Save')));
      if (body.parentElement) body.parentElement.scrollTop = scroll;
    }
    draw();
    openDialog('Settings', body);
  }

  // ------------------------------------------------------------------ asking
  async function readEvents(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) { try { onEvent(event, JSON.parse(data)); } catch (e) { console.error(e); } }
      }
    }
  }

  let aborter = null;
  function stopAsk() { if (aborter) aborter.abort(); }

  /**
   * Ask a question. `parent` undefined = follow on from the conversation on screen.
   * Editing or retrying passes the parent of the question being replaced (null for the
   * first question), so the answer becomes a new version beside the old one.
   */
  async function ask(question, { parent, mode = 'answer', fromBox = false } = {}) {
    question = String(question || '').trim();
    if (!question || (S.live && S.live.running)) return;
    if (!S.compose.engine) { toast('Connect a model first'); openSettings(); return; }
    if (question.length > modeInfo(mode).maxInput) { toast(`This tool accepts up to ${nf.format(modeInfo(mode).maxInput)} characters. Shorten the text and try again.`); return; }
    stopDictation();

    if (S.view !== 'thread' || !S.thread) S.thread = { id: null, title: question, turns: [], leaf: null };
    const thread = S.thread;
    const live = {
      question, mode, thread, parentId: thread.id ? parent : undefined, running: true, stage: '', status: '', sources: [], queries: [], yesNo: false,
      papers: [], answer: '', thinking: '', insights: [], figures: [], webSources: [], notices: [], error: null, usage: null,
      engine: S.compose.engine, model: S.compose.model, effort: S.compose.effort, web: S.compose.web,
    };
    S.live = live;
    S.referenceTurn = live;
    S.view = 'thread';
    S.editing = null;
    if (fromBox) { S.compose.draft = ''; S.compose.mode = 'answer'; }
    render();
    requestAnimationFrame(() => { if (S.liveView && S.liveView.turn === live) S.liveView.el.scrollIntoView({ block: 'start', behavior: 'instant' }); });

    aborter = new AbortController();
    let finished = null;
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'x-lectern-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          question, mode, threadId: thread.id, parentId: live.parentId, filters: activeFilters(),
          overrides: { engine: live.engine, model: live.model, effort: live.effort, web: live.web },
        }),
        signal: aborter.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);

      await readEvents(res, (event, d) => {
        switch (event) {
          case 'meta': Object.assign(live, { engine: d.engine, model: d.model, effort: d.effort, web: d.web, mode: d.mode || mode }); break;
          case 'stage': live.stage = d.id; live.status = ''; refreshLive('runline'); break;
          case 'plan': live.queries = d.queries; live.yesNo = d.yesNo; break;
          case 'source': live.sources.push(d); refreshLive('runline'); break;
          case 'papers': live.papers = d.papers; refreshLive('summary', 'shelf', 'evidence', 'runline'); break;
          case 'status': live.status = d.text; refreshLive('runline'); break;
          case 'delta':
            live.answer += d.text;
            if (live.status !== 'Writing the answer' && d.text.trim()) { live.status = 'Writing the answer'; refreshLive('runline'); }
            refreshLive('summary', 'answer', 'next', live.thinking ? 'reasoning' : 'answer');
            break;
          case 'thinking': live.thinking += d.text; refreshLive('reasoning'); break;
          case 'insights': live.insights = d.insights; refreshLive('summary', 'answer', 'shelf', 'evidence', 'nav'); break;
          case 'figures': live.figures = d.figures; refreshLive('figures', 'nav'); break;
          case 'websource': if (isWebUrl(d.url)) live.webSources[d.n - 1] = { url: d.url, title: d.title }; break;
          case 'notice': live.notices.push(d.text); break;
          case 'error': live.error = d.message; break;
          case 'done': finished = d; live.usage = d.usage; break;
          default:
        }
      });
      if (!finished && !live.error) live.error = 'The connection closed before the answer finished.';
    } catch (e) {
      if (e.name === 'AbortError') live.stopped = true;
      else live.error = e.message;
    }
    aborter = null;
    live.running = false;

    if (finished) {
      // The answer is saved on disk; move it from "live" into the conversation.
      thread.id = finished.threadId;
      thread.title = finished.title;
      const { thread: _t, running: _r, stage: _s, status: _st, parentId: _p, ...turn } = live;
      thread.turns.push({ id: finished.turnId, parent: finished.parent === undefined ? null : finished.parent, ...turn });
      thread.leaf = finished.turnId;
      S.live = null;
      try { S.threads = (await api('GET', '/api/threads')).threads; } catch { /* list refreshes next time */ }
      if (!(S.view === 'thread' && S.thread === thread)) toast('Your answer is ready');
    }
    render();
  }

  // ------------------------------------------------------------------ navigation
  function goHome() { stopDictation(); S.view = 'home'; S.thread = null; S.editing = null; render(); }

  async function openThread(id) {
    stopDictation();
    if (S.live && S.live.thread.id === id) { S.thread = S.live.thread; S.view = 'thread'; return render(); }
    try {
      S.thread = await api('GET', `/api/thread?id=${encodeURIComponent(id)}`);
      S.view = 'thread';
      S.editing = null;
      render();
      $('.main').scrollTop = 0;
    } catch (e) { toast(e.message); }
  }

  /** Show another version of a question, and the conversation that followed it. */
  function showVersion(turn) {
    const t = S.thread;
    if (!t || !turn) return;
    t.leaf = newestLeaf(t, turn.id);
    render();
    api('PUT', '/api/thread', { id: t.id, leaf: t.leaf }).catch(() => { /* the view still switched; it resets on reload */ });
  }

  async function refreshThreads() {
    try { S.threads = (await api('GET', '/api/threads')).threads; } catch { /* list refreshes next time */ }
  }

  async function deleteTurn(turn) {
    const t = S.thread;
    const later = pathTo(t, t.leaf).indexOf(turn) < pathTo(t, t.leaf).length - 1;
    const msg = `Delete this question and its answer?${later ? ' The questions asked after it are deleted too.' : ''} This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      const res = await api('DELETE', `/api/turn?thread=${encodeURIComponent(t.id)}&id=${encodeURIComponent(turn.id)}`);
      if (res.thread) S.thread = res.thread;
      else { S.thread = null; S.view = 'home'; }
      await refreshThreads();
      render();
      toast('Deleted');
    } catch (e) { toast(e.message); }
  }

  async function branchFrom(turn) {
    try {
      const res = await api('POST', '/api/thread/branch', { id: S.thread.id, turnId: turn.id });
      S.thread = res.thread;
      S.view = 'thread';
      await refreshThreads();
      render();
      toast('Opened as a new conversation');
    } catch (e) { toast(e.message); }
  }

  async function duplicateThread(t) {
    try {
      const res = await api('POST', '/api/thread/branch', { id: t.id });
      S.thread = res.thread;
      S.view = 'thread';
      await refreshThreads();
      render();
      toast('Conversation duplicated');
    } catch (e) { toast(e.message); }
  }

  async function deleteThread(t) {
    if (!window.confirm(`Delete "${t.title}"? This cannot be undone.`)) return;
    try {
      const result = await api('DELETE', `/api/thread?id=${encodeURIComponent(t.id)}`);
      if (!result.ok) throw new Error('The conversation could not be deleted.');
      S.threads = S.threads.filter((x) => x.id !== t.id);
      if (S.thread && S.thread.id === t.id) { S.thread = null; S.view = 'home'; }
      render();
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ render
  function renderRailOnly() { const old = $('.rail'); if (old) old.replaceWith(renderRail()); }

  let renderedView = null;
  let renderedThread = null;
  function render() {
    const previousMain = $('.main');
    const preserve = renderedView === S.view && (S.view !== 'thread' || renderedThread === S.thread);
    const scroll = preserve && previousMain ? previousMain.scrollTop : 0;
    const pageScroll = preserve ? window.scrollY : 0;
    if (closeMenu) closeMenu();
    settleCompose();
    hideCiteCard();
    let view;
    if (S.view === 'thread' && S.thread) view = renderThread();
    else if (S.view === 'library') view = renderLibrary();
    else { S.view = 'home'; view = renderHome(); }
    // going to another screen (not redrawing this one): the new screen eases in
    if (!preserve) view.classList.add('nav-enter');
    const main = previousMain || h('main', { class: 'main' });
    main.replaceChildren(h('div', { class: 'topstrip' }), view);
    $('#app').replaceChildren(renderRail(), main);
    refreshReferences();
    main.scrollTo({ top: scroll, behavior: 'instant' });
    if (preserve && window.scrollY !== pageScroll) window.scrollTo({ top: pageScroll, behavior: 'instant' });
    renderedView = S.view;
    renderedThread = S.thread;
  }

  async function boot() {
    try {
      loadPrefs();
      const [app, threads, library] = await Promise.all([
        api('GET', '/api/state'), api('GET', '/api/threads'), api('GET', '/api/library'),
      ]);
      S.app = app;
      S.threads = threads.threads;
      S.library = library.papers;
      if (!localStorage.getItem('lectern.compose')) { S.compose.effort = app.settings.effort; S.compose.web = app.settings.web; }
      render();
      // First launch: ask once what the reader studies. After that it lives on the home page and in Settings.
      if (!app.settings.profile.asked && !profileLabel()) {
        openProfile();
        saveSettings({ profile: { asked: true } }).catch(() => { /* asking again next time is harmless */ });
      }
    } catch (e) {
      $('#app').replaceChildren(h('div', { class: 'view' }, h('div', { class: 'error' }, `Lectern could not start: ${e.message}`)));
    }
  }

  boot();
})();
