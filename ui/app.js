// The window's logic: state, rendering, and talking to the local server.
// Plain DOM code, no framework and no build step — edit and reload.
(function () {
  'use strict';

  const TOKEN = document.querySelector('meta[name="lectern-token"]').content;
  const Cite = window.LecternCite;
  const Render = window.LecternRender;
  // The Mac window has no title bar (the traffic lights sit on the rail); Windows keeps its own.
  if (/Electron/i.test(navigator.userAgent) && /Macintosh/i.test(navigator.userAgent)) document.documentElement.classList.add('is-desktop');

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
    // The row's choices are its children; the picked one has aria-checked="true", the class "on" or "active".
    // The window builds such a row again on every change, so the box is remembered under `name`: the new row's
    // box starts where the old row's box is drawn at that moment (part way, if it was still sliding) and goes on
    // from there. It never waits a frame, fades in, or jumps to the end, and the picked choice's own look never
    // shows under it.
    const SLIDE_MS = 340; // how long the move takes: `[data-slide] > .slide-box.go` in ui/styles.css
    const near = (a, b) => Math.abs(a - b) < 0.5;
    const same = (a, b) => !!(a && b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h));
    const isPicked = (c) => c.getAttribute('aria-checked') === 'true' || c.classList.contains('on') || c.classList.contains('active');
    const placeOf = (c) => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });    const putBox = (box, q) => { box.style.transform = `translate(${q.x}px, ${q.y}px)`; box.style.width = `${q.w}px`; box.style.height = `${q.h}px`; };
    /** Where the box is drawn right now, part way through a move included. */
    function boxNow(box) {
      const cs = getComputedStyle(box);
      const m = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform) : null;
      return { x: m ? m.m41 : 0, y: m ? m.m42 : 0, w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0 };
    }
    /** Put the box at `q` at once, shown or hidden. */
    function snapBox(box, q, shown) {
      box.classList.remove('go');
      if (q) putBox(box, q);
      box.style.opacity = shown ? '1' : '0';
      void box.offsetWidth; // commit this place before the move transitions are turned back on
      box.classList.add('go');
    }
    /** Slide the box from `a` to `b`, starting `elapsed` ms into the move (a rebuilt row's box carries on). */
    function runBox(box, a, b, elapsed) {
      snapBox(box, a, true);
      if (elapsed > 0) box.style.transitionDelay = `${-Math.round(elapsed)}ms`;
      putBox(box, b);
      if (elapsed > 0) { void box.offsetWidth; box.style.transitionDelay = ''; } // this move started part way; later ones start at the beginning
    }
    function slide(group, name) {
      group.dataset.slide = name;
      // Set before the row is first styled. Added later, the picked choice was first drawn with its own look,
      // which then faded out under the box while the box was still on its way (two highlights at once).
      group.classList.add('slide-ready');
      const mem = recall('slide', name);
      let start = null; // null: nothing to slide from (the first drawing, or a row opened again a while later)
      if (mem && mem.group !== group) {
        const old = mem.group;
        if (old && old.isConnected && old.getClientRects().length) {
          // The row this one replaces is still on screen: start where its box is drawn now.
          const b = mem.to && old.querySelector(':scope > .slide-box');
          start = { at: b ? boxNow(b) : mem.to, mem };
        } else if (now() - mem.t < 1500) start = { at: mem.to, mem }; // a row closed and built again at once (the model menu)
      }
      const used = () => { const m = recall('slide', name); if (m && m.group === group) m.t = now(); };
      group.addEventListener('pointerdown', used, true);
      group.addEventListener('keydown', used, true);
      // Placed as soon as the code that built the row has put it on the page, before the next frame is drawn.
      let tries = 60;
      const place = () => {
        if (group.isConnected) placeSlide(group, name, start);
        else if (tries-- > 0) requestAnimationFrame(place);
        else group.classList.remove('slide-ready'); // never shown: if it is shown later, its choices keep their own look
      };
      queueMicrotask(place);
      return group;
    }
    function placeSlide(group, name, start) {
      const on = [...group.children].find(isPicked);
      const r = on ? placeOf(on) : null;
      const box = h('i', { class: 'slide-box', 'aria-hidden': 'true' });
      box.style.opacity = '0';
      group.append(box); // last, so code that counts the choices by index is not thrown off
      if (window.ResizeObserver) new ResizeObserver(() => resizedSlide(group, name, box)).observe(group);
      const t = now();
      const mem = start && start.mem;
      let from = null;
      let t0 = -Infinity;
      if (!start || calm()) snapBox(box, r, !!r); // first drawing, or Reduce motion: the end state at once
      else if (!r) { snapBox(box, start.at, !!start.at); box.style.opacity = '0'; } // the pick was cleared: fade out where it was
      else if (!start.at) { snapBox(box, r, false); box.style.opacity = '1'; } // nothing was picked: fade in
      else if (mem.from && same(mem.to, r) && t - mem.t0 < SLIDE_MS) { from = mem.from; t0 = mem.t0; runBox(box, from, r, t - t0); } // still on its way here: carry on
      else if (!same(start.at, r)) { from = start.at; t0 = t; runBox(box, from, r, 0); } // slide from where the box is now
      else snapBox(box, r, true);
      keep('slide', name, { group, to: r, from, t0, t });
    }
    /** The row changed size (a label grew, the window narrowed): the box follows the picked choice. */
    function resizedSlide(group, name, box) {
      const mem = recall('slide', name);
      if (!group.isConnected || !mem || mem.group !== group) return; // a row that has been replaced
      const on = [...group.children].find((c) => c !== box && isPicked(c));
      const r = on ? placeOf(on) : null;
      if (!r || same(mem.to, r)) return;
      const t = now();
      if (!calm() && mem.from && t - mem.t0 < SLIDE_MS) { const at = boxNow(box); runBox(box, at, r, 0); mem.from = at; mem.t0 = t; } // part way: turn to the new place
      else { snapBox(box, r, true); mem.from = null; mem.t0 = -Infinity; }
      mem.to = r;
      mem.t = t;
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
    // they arrive instead of all at once. Only the block of the answer that changed is drawn again
    // (syncBlocks); the stretches of it still fading are remembered by their place in the block's text and
    // given a negative delay on the new block, so a stretch keeps fading where it was instead of jumping to full.
    const STREAM_MS = 520;
    /** The stretches of a block's text that are fading: those still fading in its last version, plus what is new. */
    function fadeNext(prev, len, t) {
      const pieces = (prev ? prev.pieces : []).filter((p) => t - p.t0 < STREAM_MS && p.from < len).map((p) => ({ ...p, to: Math.min(p.to, len) }));
      const from = prev ? prev.len : 0;
      if (len > from) {
        const last = pieces[pieces.length - 1];
        // text that arrives within a tenth of a second of the stretch before it joins that stretch (fewer spans to fade)
        if (last && last.to === from && t - last.t0 < 100) last.to = len;
        else pieces.push({ from, to: len, t0: t });
      }
      return pieces;
    }
    /** Wrap the stretches of `root`'s text that are still fading in .tok-in spans, each carrying on from where it was. */
    function fadeIn(root, pieces, t) {
      const live = pieces.filter((p) => t - p.t0 < STREAM_MS && p.to > p.from);
      if (calm() || !live.length) return root;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
      let pos = 0;
      for (const node of nodes) {
        const text = node.nodeValue;
        const start = pos;
        const end = pos + text.length;
        pos = end;
        const hits = live.filter((p) => p.to > start && p.from < end).sort((x, y) => x.from - y.from);
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

    return { calm, changed, age, appeared, settle, enter, play, pop, leave, count, roll, say, slide, glide, fadeNext, fadeIn, animateDialog, keepDialogOpen };
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
          // plain text is escaped for the rich copy (a "<" must not become a tag) and keeps its line breaks
          'text/html': new Blob([out.html || Render.esc(out.text).replace(/\r?\n/g, '<br>')], { type: 'text/html' }),
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
    'gpt-6-sol': 'GPT-6 Sol', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gemini-4-hydrogen': 'Gemini 4 Hydrogen', 'gemini-4-argon': 'Gemini 4 Argon', 'gemini-4-carbon': 'Gemini 4 Carbon',
    'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  };
  // Engines the menus offer: Gemini only once its key is linked and accepted (the owner's rule, 2026-11-19).
  const menuEngines = () => S.app.engines.filter((e) => !e.hiddenUntilReady || e.ready);
  const prettyModel = (id, engine) => MODEL_NAMES[id] || id || (engine === 'codex' ? 'Codex default' : 'Default');
  const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
  const STANCE_LABEL = { supports: 'Supports', conditional: 'Conditional', mixed: 'Mixed', against: 'Against', na: 'Not tested' };
  const nf = new Intl.NumberFormat('en');
  const isWebUrl = (u) => /^https?:\/\//i.test(u || '');
  /** A DOI as a link: encoded, with "?", "#" and "%" escaped too (they are legal in a DOI but end a URL path). */
  const doiHref = (doi) => (doi ? `https://doi.org/${encodeURI(String(doi)).replace(/[?#]/g, encodeURIComponent)}` : '');

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
    usage: {},
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
    libraryTab: 'papers', // 'papers' or 'chats'
    editing: null, // id of the question being edited in place
    renaming: null, // id of the conversation being renamed in the sidebar
    renameDraft: null, // { id, value, start, end, focused }: the name being typed, kept when the sidebar is drawn again
    oaRefused: false, // OpenAlex turned a search away because there was no key (it works without one, within a smaller allowance)
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
  const USAGE_PROVIDERS = [['claude-code', 'Claude'], ['codex', 'GPT']];
  let usageRequest = null;
  let usageLastFetch = 0;
  let redrawUsageDialog = null;

  // A reset is not evidence of 0% usage: wait for a new reading after the reset.
  function currentUsageWindow(provider, name) {
    const w = S.usage[provider]?.[name];
    return w && (!w.resetsAt || Date.parse(w.resetsAt) > Date.now()) ? w : null;
  }
  const usagePercent = (w) => w ? `${Math.round(w.usedPercent)}% used` : 'Unavailable';
  function usageDescription(id, label) {
    const data = S.usage[id];
    const weekly = currentUsageWindow(id, 'weekly');
    const fiveHour = currentUsageWindow(id, 'fiveHour');
    return `${label}${id === 'codex' ? ' (Codex)' : ''}: weekly ${usagePercent(weekly)}, five-hour ${usagePercent(fiveHour)}${data?.stale ? '. Last known reading' : ''}`;
  }

  function usageRing(id) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 40 40', width: '36', height: '36', fill: 'none', 'aria-hidden': 'true', class: 'usage-ring' })) svg.setAttribute(key, value);
    const point = (angle) => [20 + 15.5 * Math.cos(angle * Math.PI / 180), 20 + 15.5 * Math.sin(angle * Math.PI / 180)];
    // Leave room for the round caps at both breaks; remaining arc lengths have a 2:1 ratio.
    const weeklySweep = 328 * 2 / 3;
    for (const [name, start, sweep] of [['weekly', -82, weeklySweep], ['fiveHour', -82 + weeklySweep + 16, 328 / 3]]) {
      const a = point(start), b = point(start + sweep);
      const d = `M${a.join(' ')} A15.5 15.5 0 ${sweep > 180 ? 1 : 0} 1 ${b.join(' ')}`;
      const w = currentUsageWindow(id, name);
      for (const layer of ['track', 'fill']) {
        if (layer === 'fill' && w?.usedPercent === 0) continue;
        const p = document.createElementNS(NS, 'path');
        for (const [key, value] of Object.entries({ d, pathLength: '100', 'stroke-width': '3',
          'stroke-linecap': w ? 'round' : 'butt',
          class: `usage-${layer} usage-${name}${!w ? ' usage-unknown' : ''}`,
          ...(layer === 'fill' ? { 'stroke-dasharray': w ? `${w.usedPercent} 100` : '2 8' } : {}),
        })) p.setAttribute(key, value);
        svg.append(p);
      }
    }
    return svg;
  }

  // Pointing at a ring shows its numbers at once (the click still opens the full details).
  const usageCard = h('div', { class: 'usage-card', role: 'tooltip', hidden: true });
  let usageCardFor = null; // the provider id whose numbers are showing
  function hideUsageCard() { usageCard.hidden = true; usageCardFor = null; }
  function showUsageCard(button, id, label) {
    const data = S.usage[id];
    const time = (iso, long) => new Date(iso).toLocaleString([], long ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
    const row = (name, title, long) => {
      const w = currentUsageWindow(id, name);
      return h('div', { class: 'uc-row' },
        h('span', { class: 'uc-name' }, title),
        h('b', { class: 'uc-pct' }, w ? `${Math.round(w.usedPercent)}%` : 'n/a'),
        h('span', { class: 'uc-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${w ? Math.min(100, Math.max(0, w.usedPercent)) : 0}%` })),
        h('small', null, w ? `${Math.round(100 - w.usedPercent)}% left${w.resetsAt ? ` · resets ${time(w.resetsAt, long)}` : ''}` : 'No reading yet'));
    };
    usageCard.className = `usage-card usage-${id}`;
    fill(usageCard,
      h('div', { class: 'uc-head' }, `${label}${id === 'codex' ? ' / Codex' : ''} plan usage`),
      row('weekly', 'This week', true), row('fiveHour', 'Last 5 hours', false),
      h('small', { class: 'uc-foot' }, data?.stale ? 'Last known reading. Click for details.' : 'Click for details.'));
    if (!usageCard.isConnected) document.body.append(usageCard);
    usageCard.hidden = false;
    usageCardFor = id;
    const r = button.getBoundingClientRect();
    const w = usageCard.offsetWidth, hgt = usageCard.offsetHeight;
    usageCard.style.left = `${Math.max(10, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 10))}px`;
    usageCard.style.top = `${r.top - hgt - 10 < 8 ? r.bottom + 10 : r.top - hgt - 10}px`;
  }
  document.addEventListener('scroll', hideUsageCard, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideUsageCard(); });

  function renderUsageMeters() {
    return h('div', { class: 'usage-meters', role: 'group', 'aria-label': 'Plan usage' },
      USAGE_PROVIDERS.map(([id, label]) => {
        const btn = h('button', {
          type: 'button', class: `usage-meter usage-${id}${S.usage[id]?.stale ? ' is-stale' : ''}`,
          'aria-label': `${usageDescription(id, label)}. Show usage details`, 'aria-haspopup': 'dialog',
          onclick: () => { hideUsageCard(); openUsage(id, label); },
          onmouseenter: () => showUsageCard(btn, id, label),
          onmouseleave: hideUsageCard,
          onfocus: () => showUsageCard(btn, id, label),
          onblur: hideUsageCard,
        }, usageRing(id), h('span', { class: 'usage-label' }, label));
        return btn;
      }));
  }

  async function refreshUsage() {
    if (!S.app || document.hidden || usageRequest || Date.now() - usageLastFetch < 15000) return usageRequest;
    usageLastFetch = Date.now();
    usageRequest = (async () => {
      try { S.usage = (await api('GET', '/api/usage')).providers; }
      catch {
        for (const [id] of USAGE_PROVIDERS) S.usage[id] = { ...S.usage[id], stale: true, detail: 'Could not refresh usage. Check your connection.' };
      }
      // Update only the meters, preserving focus, the composer and conversation scroll.
      const old = $('.usage-meters');
      const focused = old && [...old.children].indexOf(document.activeElement);
      if (old) {
        const next = renderUsageMeters();
        const showing = usageCardFor; // a card being read stays up and shows the fresh numbers
        old.replaceWith(next);
        if (focused >= 0) next.children[focused]?.focus();
        const at = USAGE_PROVIDERS.findIndex(([id]) => id === showing);
        if (showing && at >= 0 && !usageCard.hidden) showUsageCard(next.children[at], showing, USAGE_PROVIDERS[at][1]);
      }
      if (redrawUsageDialog) redrawUsageDialog();
    })().finally(() => { usageRequest = null; });
    return usageRequest;
  }

  function openUsage(id, label) {
    const body = h('div', { class: `dialog-body usage-details usage-${id}` });
    const draw = () => {
      const data = S.usage[id];
      const checked = data?.checkedAt && new Date(data.checkedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      fill(body,
        h('p', { class: 'help' }, id === 'codex' ? 'Your GPT usage through Codex, shared across apps using this account.' : 'Your Claude account usage, shared across apps using this plan.'),
        h('div', { class: 'usage-detail-head' }, usageRing(id), h('span', null, 'Filled = used', h('small', null, 'Empty = 0% · Full = 100%'))),
        [['weekly', 'Weekly', '⅔ of the ring'], ['fiveHour', 'Five-hour', '⅓ of the ring']].map(([name, title, portion]) => {
          const w = currentUsageWindow(id, name);
          const expired = data?.[name]?.resetsAt && Date.parse(data[name].resetsAt) <= Date.now();
          const reset = w?.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}` : '';
          return h('div', { class: 'usage-detail-row' },
            h('div', null, h('b', null, title), h('small', null, portion)),
            h('div', null, h('b', null, usagePercent(w)), h('small', null, w ? `${Math.round(100 - w.usedPercent)}% left` : expired ? 'Reset passed; awaiting a fresh reading' : 'No reading available'),
              reset && h('small', null, reset)));
        }),
        data?.detail && h('p', { class: 'help' }, data.detail),
        h('p', { class: 'help usage-updated' }, data ? `${data.stale ? 'Last known reading' : 'Updated'}${checked ? ` · ${checked}` : ''}. Checks automatically every 2 minutes.` : 'Checking account usage…'));
    };
    draw();
    openDialog(`${label}${id === 'codex' ? ' / Codex' : ''} usage`, body);
    redrawUsageDialog = draw;
    $('#dialog').addEventListener('close', () => { if (redrawUsageDialog === draw) redrawUsageDialog = null; }, { once: true });
    refreshUsage();
  }

  /**
   * The name box of a conversation being renamed. The sidebar can be drawn again while the reader types (an answer
   * finishes, say): the new box keeps what was typed and where the caret was, and the old box going away saves nothing.
   */
  function renameField(t) {
    let done = false;
    const draft = S.renameDraft && S.renameDraft.id === t.id ? S.renameDraft : null;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      S.renaming = null;
      S.renameDraft = null;
      if (save && title && title !== t.title) {
        try {
          await api('PUT', '/api/thread', { id: t.id, title });
          t.title = title;
          if (S.thread && S.thread.id === t.id) S.thread.title = title;
          const shown = S.thread && S.thread.id === t.id ? $('.thread-title') : null;
          if (shown) { shown.textContent = title; shown.title = title; }
        } catch (e) { toast(e.message); }
      }
      renderRailOnly();
    };
    const input = h('input', {
      class: 'input history-rename', value: draft ? draft.value : t.title, maxlength: '120', 'aria-label': 'Chat name',
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      },
      onblur: () => { if (!input._replaced) finish(true); },
    });
    input._keep = () => { // called just before the sidebar is drawn again
      input._replaced = true;
      S.renameDraft = { id: t.id, value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input };
    };
    requestAnimationFrame(() => {
      if (!input.isConnected || (draft && !draft.focused)) return;
      input.focus();
      if (draft) input.setSelectionRange(draft.start, draft.end); else input.select();
    });
    return input;
  }

  function renderRail() {
    $('.history-rename')?._keep?.(); // a name being typed survives this drawing
    const active = engineInfo(S.compose.engine);
    const liveElsewhere = S.live && S.live.running && !(S.view === 'thread' && S.thread === S.live.thread);
    // a conversation that was not in the list a moment ago rises in; the first list drawn is not "new"
    const rise = (li, id, i) => { const a = Motion.appeared('history', id); return a == null ? li : Motion.enter(li, i, a); };

    const rail = h('aside', { class: 'rail' },
      h('div', { class: 'wordmark' }, h('span', null, 'Lectern')),
      h('button', { class: 'btn new', onclick: newQuestion, title: `New question (${NEW_KEYS})`, 'aria-keyshortcuts': IS_MAC ? 'Meta+N' : 'Control+N' }, 'New question', h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, NEW_KEYS)),
      h('nav', { class: 'rail-nav' },
        h('button', { class: `rail-link${S.view === 'library' ? ' on' : ''}`, onclick: openLibrary, title: `Library (${mod('L')})`, 'aria-keyshortcuts': IS_MAC ? 'Meta+L' : 'Control+L' },
          'Library', h('span', { class: 'rail-keys' }, h('span', { class: 'count' }, (S.library.length + S.threads.filter((x) => x.saved).length + S.threads.reduce((n, x) => n + (x.prompts || []).length, 0)) || ''), h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, mod('L')))),
        h('button', { class: `rail-link${S.view === 'score' ? ' on' : ''}`, onclick: openScore, title: `Writing desk (${mod('K')})`, 'aria-keyshortcuts': IS_MAC ? 'Meta+K' : 'Control+K' },
          'Writing desk', h('span', { class: 'rail-keys' }, h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, mod('K'))))),
      h('div', { class: 'rail-label' }, 'Recent'),
      h('ul', { class: 'history' },
        liveElsewhere && h('li', null,
          h('button', { class: 'history-item', onclick: () => { S.thread = S.live.thread; S.view = 'thread'; render(); } },
            `Answering: ${S.live.question}`)),
        S.threads.length === 0 && !liveElsewhere && h('li', { class: 'history-empty' }, 'Your questions will appear here.'),
        S.threads.map((t, i) => rise(h('li', { class: S.view === 'thread' && S.thread && S.thread.id === t.id ? 'on' : '', 'data-id': t.id },
          S.renaming === t.id
            ? renameField(t)
            : [
              h('button', { class: 'history-item', title: t.title, onclick: () => openThread(t.id) }, t.title),
              t.saved && h('span', { class: 'saved-mark', title: 'In your library', 'aria-hidden': 'true' }, icon('bookmark')),
              h('span', { class: 'history-acts' },
                h('button', { class: `history-act save${t.saved ? ' on' : ''}`, title: t.saved ? 'Remove from library' : 'Save to library', 'aria-pressed': String(!!t.saved),
                  'aria-label': `${t.saved ? 'Remove' : 'Save'} "${t.title}" ${t.saved ? 'from' : 'to'} the library`, onclick: () => setChatSaved(t.id, !t.saved) }, icon('bookmark')),
                h('button', { class: 'history-act', title: 'Rename', 'aria-label': `Rename "${t.title}"`, onclick: () => { S.renaming = t.id; renderRailOnly(); } }, '✎'),
                h('button', { class: 'history-act', title: 'Duplicate', 'aria-label': `Duplicate "${t.title}"`, onclick: () => duplicateThread(t) }, '⧉'),
                // a conversation whose answer is being written cannot be deleted: the answer would be lost
                answering(t)
                  ? h('button', { class: 'history-act del', disabled: true, title: 'Wait until the answer is written, or stop it', 'aria-label': `Delete "${t.title}" (available once the answer is written)` }, '×')
                  : h('button', { class: 'history-act del', title: 'Delete', 'aria-label': `Delete "${t.title}"`, onclick: () => deleteThread(t) }, '×')),
            ]), t.id, i))),
      h('div', { class: 'rail-foot' },
        h('div', { class: 'rail-model-row' }, h('button', { class: 'rail-link engine-pill', onclick: openSettings,
          'aria-label': active ? `Model: ${prettyModel(S.compose.model, active.id)}, ${EFFORT_LABEL[S.compose.effort].toLowerCase()} effort. Open Settings` : 'No model connected. Open Settings' },
          h('span', null,
            h('span', { class: `dot${active ? '' : ' off'}` }), ' ',
            active ? active.short : 'No model connected',
            active && h('small', { title: `${prettyModel(S.compose.model, active.id)}, ${EFFORT_LABEL[S.compose.effort].toLowerCase()} effort` }, `${prettyModel(S.compose.model, active.id)}, ${EFFORT_LABEL[S.compose.effort].toLowerCase()} effort`))),
          renderUsageMeters()),
        h('button', { class: 'rail-link', onclick: openSettings }, 'Settings')));
    Motion.settle('history');
    Motion.glide($('.history', rail), 'li:not(.history-empty)');
    rail._key = railKey();
    return rail;
  }
  const answering = (t) => !!(S.live && S.live.running && S.live.thread.id === t.id);

  // ------------------------------------------------------------------ composer
  /** Small line icons, drawn as SVG (built element by element, no markup strings). */
  const ICONS = {
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    stop: ['M7 7h10v10H7z'],
    plus: ['M12 5v14', 'M5 12h14'],
    check: ['M5 12.5 10 17.5 19 7'],
    eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
    eyeoff: ['M3 3l18 18', 'M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9', 'M6.5 7.6C3.9 9.2 2 12 2 12s3.6 6 10 6c1.4 0 2.7-.3 3.8-.8', 'M9.9 9.9a2.5 2.5 0 0 0 3.2 3.2'],
    wave: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 7v10', 'M20 10v4'],
    bookmark: ['M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z'],
    chev: ['M7 10l5 5 5-5'],
    list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
    trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5', 'M14 11v5'],
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
    low: 'Quick thinking. Fastest',
    medium: 'Balanced thinking and speed',
    high: 'Longer thinking. Slower',
    xhigh: 'Much longer thinking. Much slower',
    max: 'Longest thinking. Slowest, uses the most of your plan',
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

    const mode = modeInfo(c.mode);
    // A tool brings its own hint; a plain answer keeps the hint of the box it is in.
    if (mode.id !== 'answer') placeholder = mode.id === 'trail' || mode.id === 'verify' ? `${mode.placeholder} (Shift+Enter for a new line)` : mode.placeholder;

    const ta = h('textarea', {
      class: 'ask', rows: '1', placeholder, 'aria-label': placeholder, maxlength: mode.maxInput,
      oninput: (e) => {
        if (e.isTrusted && voiceOn()) stopDictation();
        c.draft = e.target.value; grow(e.target); sendBtn.disabled = !e.target.value.trim() && !isBusy();
      },
      onkeydown: (e) => {
        if (voiceOn() && !['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'Fn'].includes(e.key)) stopDictation();
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

    const sendFor = () => (isBusy()
      ? h('button', { type: 'button', class: 'send stop', 'aria-label': 'Stop', title: 'Stop', onclick: stopAsk }, icon('stop'))
      : h('button', { type: 'submit', class: 'send', 'aria-label': 'Ask', title: 'Ask (Enter)', disabled: !c.draft.trim() || null }, icon('send')));
    let sendBtn = sendFor();

    const micBtn = h('button', {
      type: 'button', class: `mic${voiceActive() ? ' on' : ''}`, 'aria-pressed': String(voiceOn()),
      'aria-busy': String(voiceOn() && !voiceActive()), 'aria-label': voiceLabel(), title: voiceLabel(),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => toggleDictation(),
    }, icon(voiceActive() ? 'wave' : 'mic'));
    micBtn._shown = voiceActive(); // a rebuilt button already shows the right symbol, so it does not pop again

    const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('div', { class: 'composer-main' }, ta, micBtn, sendBtn));

    // ---- the row under the box
    const n = filterCount();
    const toggleWeb = () => { c.web = !c.web; savePrefs(); render(); };
    const setMode = (id) => {
      stopDictation(); c.mode = id; if (closeMenu) closeMenu(); render(); requestAnimationFrame(() => $(dock ? '.dock .ask' : '.ask')?.focus());
      // the text stays as typed (nothing is cut off), but the reader learns at once that this tool takes less
      const max = modeInfo(id).maxInput;
      if (c.draft.length > max) toast(`${id === 'answer' ? 'A question' : modeInfo(id).label} takes up to ${nf.format(max)} characters. Your text has ${nf.format(c.draft.length)}: shorten it before you ask.`);
    };
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
        h('div', { class: 'cmenu-head', 'aria-hidden': 'true' }, 'Research tools'),
        S.app.modes.map((m) => h('button', {
          type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(m.id === c.mode), onclick: () => setMode(m.id),
        }, icon(m.id), h('span', { class: 'cmenu-text' }, h('b', null, m.label), h('small', null, m.blurb)), m.id === c.mode && icon('check'))),
        h('div', { class: 'cmenu-sep', role: 'separator' }),
        h('button', { type: 'button', class: 'cmenu-row', role: 'menuitemcheckbox', 'aria-checked': String(c.web), onclick: toggleWeb },
          icon('globe'), h('span', { class: 'cmenu-text' }, h('b', null, 'Web search'), h('small', null, 'Also look at the open web for context the papers lack')),
          c.web && icon('check')),
      ], 'left', 'Research tools'),
    }, icon('plus'));

    const info = engineInfo(c.engine);
    const modelBtn = h('button', {
      type: 'button', class: 'model-btn cmenu-anchor', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': info ? `Model: ${prettyModel(c.model, c.engine)}, ${EFFORT_LABEL[c.effort]} effort. Change` : 'Connect a model',
      onclick: () => (info || S.app.engines.some((e) => e.found) ? openMenu(modelBtn, () => modelMenu(), 'right', 'Model and effort') : openSettings()),
    }, info
      // the names roll when the model or the effort changes (the same memory serves the home box and the follow-up box)
      ? [Motion.roll(h('span', { class: 'model-name' }), 'composer', 'model', prettyModel(c.model, c.engine)),
        Motion.roll(h('span', { class: 'model-effort' }), 'composer', 'effort', EFFORT_LABEL[c.effort])]
      : h('span', { class: 'model-name' }, 'Connect Claude or ChatGPT'));

    /** The model menu: Claude / ChatGPT, the models, then Effort (a sub-page). */
    function modelMenu(page) {
      if (page === 'effort') {
        return [
          h('button', { type: 'button', class: 'cmenu-row back', role: 'menuitem', 'aria-label': 'Back to the models', onclick: () => redrawMenu(modelMenu()) }, icon('left'), h('b', null, 'Effort')),
          S.app.efforts.map((lvl) => h('button', {
            type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(lvl === c.effort),
            onclick: () => { c.effort = lvl; savePrefs(); closeMenu(); render(); },
          }, h('span', { class: 'cmenu-text' }, h('b', null, EFFORT_LABEL[lvl]), h('small', null, EFFORT_HELP[lvl])), lvl === c.effort && icon('check'))),
        ];
      }
      const eng = engineInfo(c.engine);
      return [
        Motion.slide(h('div', { class: 'cmenu-engines', role: 'group', 'aria-label': 'Which plan to use' },
          menuEngines().map((e) => h('button', {
            type: 'button', role: 'menuitemradio', 'aria-checked': String(e.id === c.engine), disabled: !e.ready || null,
            title: e.detail,
            onclick: () => { menuQuiet = performance.now(); c.engine = e.id; c.model = S.app.settings.models[e.id] || ''; savePrefs(); closeMenu(); render(); requestAnimationFrame(() => $('.model-btn')?.click()); },
          }, e.short, !e.ready && h('small', null, e.found ? 'not signed in' : 'not installed')))), 'engine-toggle'),
        eng && modelChoices(c.engine).map((id) => h('button', {
          type: 'button', class: 'cmenu-row', role: 'menuitemradio', 'aria-checked': String(id === c.model),
          onclick: () => { c.model = id; savePrefs(); closeMenu(); render(); },
        }, h('span', { class: 'cmenu-text' }, h('b', null, prettyModel(id, c.engine)), h('small', null, (eng.blurbs || {})[id] || 'Custom model from Settings')), id === c.model && icon('check'))),
        eng && h('div', { class: 'cmenu-sep', role: 'separator' }),
        eng && h('button', { type: 'button', class: 'cmenu-row', role: 'menuitem', 'aria-haspopup': 'menu', onclick: () => redrawMenu(modelMenu('effort')) },
          h('b', null, 'Effort'), h('span', { class: 'cmenu-value' }, EFFORT_LABEL[c.effort]), icon('right')),
        h('p', { class: 'cmenu-note', role: 'none' }, eng ? `${eng.billing}. ${String(eng.detail || '').replace(/\.$/, '')}.` : 'Sign in to Claude or ChatGPT on this computer, or add a Gemini API key in Settings, to start.',
          ' ', h('button', { type: 'button', class: 'linkish', role: 'menuitem', onclick: () => { closeMenu(); openSettings(); } }, 'Settings')),
      ];
    }

    let menuEl = null;
    function redrawMenu(kids) {
      if (!menuEl) return;
      fill(menuEl, kids);
      Motion.play(menuEl, 'swap', 340); // the new page of the menu slides in
      menuEl.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    }
    function openMenu(anchor, build, side, label) {
      if (closeMenu) { const same = menuEl && menuEl.dataset.side === side; closeMenu(); if (same) return; }
      // The room on each side is measured before the menu is added, while the page's layout is still clean,
      // so opening the menu lays out the page once, not twice.
      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const below = window.innerHeight - wrapRect.bottom - 12;
      const above = anchorRect.top - 12;
      menuEl = h('div', {
        class: `cmenu ${side}${dock ? ' up' : ''}`, role: 'menu', 'data-side': side, 'aria-label': label,
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
      // with room and constrain the menu itself so every tool stays reachable. (The docked box always
      // opens upwards when there is more room above, so only the home box needs the menu's height.)
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
        if (refocus) anchor.focus({ preventScroll: true });
      };
      const first = menuEl.querySelector('button:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    }

    fill(wrap,
      form,
      h('div', { class: 'composer-under' },
        h('div', { class: 'under-left' }, plusBtn, filtersBtn, modeChip, webChip),
        h('span', { class: 'under-note' }, 'Lectern reads abstracts, not full papers. Check what you cite.'),
        h('div', { class: 'under-right' }, modelBtn)));

    requestAnimationFrame(() => { grow(ta); if (autofocus) ta.focus(); });
    // An answer started or finished in place: only the send button changes (and the text, when it was just sent),
    // so the box keeps its caret, its focus and an input method's unfinished word.
    wrap._mode = c.mode;
    wrap._sync = () => {
      const fresh = sendFor(); // (focus is not moved onto Stop: a key pressed next must not stop the answer)
      sendBtn.replaceWith(fresh);
      sendBtn = fresh;
      if (ta.value !== c.draft) { ta.value = c.draft; grow(ta); }
    };
    return wrap;
  }

  // ---- voice input
  // A session owns its original textarea. Late callbacks cannot overwrite another draft.
  // Native recognition reports actual startup, transcripts, permission failures and end.
  let voiceSession = null;
  const voiceStartHint = 'Starting voice input… Allow Lectern Voice if macOS asks for microphone or speech recognition access.';
  const voiceOn = () => !!voiceSession;
  const voiceActive = () => voiceSession?.state === 'listening';
  const voiceLabel = () => !voiceOn() ? 'Speak your question' : voiceActive() ? 'Stop voice input' : 'Cancel voice input startup';
  const askBox = () => $('.dock .ask') || $('.ask');

  function paintMic() {
    const on = voiceActive();
    if ((on || !voiceOn()) && $('#toast')?.textContent === voiceStartHint) $('#toast').classList.remove('show');
    document.querySelectorAll('.mic').forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(voiceOn()));
      b.setAttribute('aria-busy', String(voiceOn() && !on));
      b.setAttribute('aria-label', voiceLabel());
      b.title = voiceLabel();
      if (b._shown !== on) {
        if (b._shown !== undefined) Motion.play(b, 'mic-pop', 320);
        b._shown = on;
        fill(b, icon(on ? 'wave' : 'mic'));
      }
    });
  }
  function stopDictation() {
    const session = voiceSession;
    voiceSession = null;
    if (session) {
      clearTimeout(session.timer);
      try { session.rec?.abort(); } catch { /* Already ended. */ }
      if (session.id) api('POST', '/api/voice', { action: 'stop', id: session.id }).catch(() => {});
    }
    paintMic();
  }
  function voiceText(session, text) {
    if (voiceSession !== session) return;
    if (!session.box.isConnected) { stopDictation(); return; }
    const value = (session.before + text + session.after).slice(0, modeInfo(S.compose.mode).maxInput);
    session.box.value = value;
    session.box.dispatchEvent(new Event('input'));
  }
  async function pollVoice(session) {
    if (voiceSession !== session) return;
    try {
      const result = await api('GET', `/api/voice?id=${encodeURIComponent(session.id)}`);
      if (voiceSession !== session) return;
      // An empty startup response must not delete the selected text.
      if (result.text) voiceText(session, result.text);
      if (!result.ok || result.state === 'error') throw new Error(result.error || 'Voice input stopped. Try again.');
      if (result.state === 'stopped') { stopDictation(); return; }
      session.state = result.state;
      paintMic();
      session.timer = setTimeout(() => pollVoice(session), 200);
    } catch (e) {
      if (voiceSession !== session) return;
      stopDictation(); toast(e.message);
    }
  }
  async function toggleDictation() {
    if (voiceOn()) { stopDictation(); return; }
    const box = askBox();
    if (!box) return;
    box.focus();
    if (/Electron/i.test(navigator.userAgent) && /Windows/i.test(navigator.userAgent)) {
      toast('Press Windows key + H to dictate into the box.');
      return;
    }
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!S.app.dictation && (!Speech || /Electron/i.test(navigator.userAgent))) {
      toast('Voice input is unavailable here. Use your system’s dictation shortcut or open Lectern in a browser with speech recognition.');
      return;
    }
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? start;
    const prefix = box.value.slice(0, start);
    const suffix = box.value.slice(end);
    const session = voiceSession = {
      box, state: 'starting',
      before: prefix + (prefix && !/\s$/.test(prefix) ? ' ' : ''),
      after: (suffix && !/^\s/.test(suffix) ? ' ' : '') + suffix,
    };
    paintMic();
    if (S.app.dictation) {
      toast(voiceStartHint);
      try {
        const result = await api('POST', '/api/voice', { action: 'start', language: navigator.language || 'en-US' });
        session.id = result.id;
        if (voiceSession !== session) {
          if (result.id) await api('POST', '/api/voice', { action: 'stop', id: result.id });
          return;
        }
        if (!result.ok || !result.id) throw new Error(result.error || 'Voice input could not start.');
        pollVoice(session);
      } catch (e) {
        if (voiceSession === session) { stopDictation(); toast(e.message); }
      }
      return;
    }
    try {
      const rec = session.rec = new Speech();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onstart = () => {
        if (voiceSession !== session) { try { rec.abort(); } catch {} return; }
        session.state = 'listening'; paintMic();
      };
      rec.onresult = (e) => {
        if (voiceSession !== session) return;
        const text = Array.from(e.results, (r) => r[0].transcript.trim()).join(' ');
        voiceText(session, text);
      };
      rec.onerror = (e) => {
        if (voiceSession !== session) return;
        const why = {
          'not-allowed': 'Allow microphone access for this page in your browser’s site settings.',
          'service-not-allowed': 'Speech recognition is blocked by this browser. Check its settings or use the Mac app.',
          'audio-capture': 'No microphone was found. Check your sound input settings.',
          network: 'The speech service could not connect. Check your internet connection or use the Mac app.',
          'no-speech': 'No speech was heard. Check your microphone and try again.',
        }[e.error];
        stopDictation();
        if (e.error !== 'aborted') toast(why || `Voice input stopped (${e.error}).`);
      };
      rec.onend = () => { if (voiceSession === session) { voiceSession = null; paintMic(); } };
      rec.start();
    } catch (e) {
      stopDictation(); toast(`Voice input could not start: ${e.message}`);
    }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && voiceOn()) stopDictation(); });
  window.addEventListener('pagehide', stopDictation);

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
    // Lectern's own drop-down, not the system menu. Its button keeps the id, so the label names it and a redraw
    // puts the keyboard focus back on it.
    const journalPicker = () => {
      const p = picker({ label: 'Journal impact', cls: 'journal', value: Number(draft.journalMin) || 0,
        options: opts.journalTiers.map((t) => ({ value: t.min, label: t.label })),
        onChange: (v) => { draft.journalMin = Number(v); draw(); } });
      p.querySelector('.picker-btn').id = 'f-journal';
      return p;
    };

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
          h('div', { class: 'frow' }, h('label', { class: 'flabel', for: 'f-journal' }, 'Journal impact'), journalPicker()),
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
        h('p', null, 'Lectern uses the plan you already have, through the login saved on this computer. No API key needed. Open the Claude app or the ChatGPT app and sign in, then come back here. To use Gemini instead, add a Gemini API key in Settings.'),
        h('button', { class: 'btn primary', onclick: async () => { try { await refreshState(); if (!S.app.activeEngine) openSettings(); } catch (e) { toast(e.message); } } }, 'I have signed in'), ' ',
        h('button', { class: 'btn quiet', onclick: openSettings }, 'Settings')),
      // OpenAlex works without a key; the note appears only once it has turned a search away for want of one.
      !noEngine && oaMissing && S.oaRefused && h('p', { class: 'hint' },
        'OpenAlex, the largest database here, turned a search away. It works without a key, but a free key gives a much larger daily allowance and steadier results. ',
        h('button', { onclick: openSettings }, 'Add one in Settings')),
      // (this line's words fade up when they change, e.g. after the reader picks a level)
      Motion.say(h('p', { class: 'hint' },
        profileLabel() ? `Answers are written for: ${profileLabel()}. ` : 'Answers can match your level and field of study. ',
        h('button', { onclick: () => openProfile() }, profileLabel() ? 'Change' : 'Tell Lectern what you study')), 'home', 'profile-hint', profileLabel()),
      h('div', { class: 'examples' },
        h('p', null, 'Or try one of these'),
        h('ul', null, EXAMPLES.map((q) => h('li', null,
          h('button', { class: 'example', onclick: () => ask(q) }, q)))))); // what is typed in the box stays there
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

  /**
   * The herbarium folder a paper is filed in: its kind of study, read from the abstract when there is a
   * reading, else from the database record. Only a colour and a word; never a judgement of quality.
   */
  function folderOf(p, ins) {
    const d = `${(ins && ins.design) || ''} ${p.kind || ''}`.toLowerCase();
    if (/meta-analy|systematic/.test(d)) return 'meta';
    if (/random|trial|experiment/.test(d)) return 'trial';
    if (/cohort|longitudinal|panel|prospective|follow-up/.test(d)) return 'cohort';
    if (/cross-section|survey|questionnaire/.test(d)) return 'cross';
    if (/qualitative|interview|case stud|ethnograph/.test(d)) return 'qual';
    return 'other';
  }
  const FOLDER_LABEL = { meta: 'Review of studies', trial: 'Trial', cohort: 'Cohort', cross: 'Survey', qual: 'Qualitative', other: 'Study' };

  function paperRow(p, { turn, showNumber }) {
    const ins = turn ? insightFor(turn, p.n) : null;
    const saved = S.library.some((x) => x.id === p.id);
    const href = p.doi ? doiHref(p.doi) : (isWebUrl(p.url) ? p.url : '');
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

    return h('li', { class: `paper${ins && !ins.relevant ? ' dim' : ''}`, 'data-n': showNumber ? p.n : null, 'data-folder': folderOf(p, ins) },
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
          p.doi && h('a', { href: doiHref(p.doi), target: '_blank', rel: 'noopener noreferrer' }, 'DOI'),
          isWebUrl(p.pdfUrl) && h('a', { href: p.pdfUrl, target: '_blank', rel: 'noopener noreferrer' }, 'PDF'),
          h('a', { href: `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Scholar'),
          h('button', { type: 'button', onclick: () => openCite(p) }, 'Cite'),
          saveBtn,
          (p.doi || p.title) && h('button', {
            type: 'button', 'data-busy': '', disabled: isBusy() || null, title: 'See what this paper cites and what cites it',
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
    // "12 of 30 papers": the numbers are label data (mono, and the first counts to its new value), the words are sans
    const countNum = h('span', { class: 'reference-count' });
    const countOf = h('span', { hidden: true }, ' of ', h('span', { class: 'reference-count' }));
    const countRest = document.createTextNode('');
    const count = h('span', { class: 'shelf-count' }, countNum, countOf, countRest);
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
      Motion.count(countNum, 'refs', 'shelf', list.length);
      countOf.hidden = list.length === papers.length;
      countOf.lastChild.textContent = String(papers.length);
      countRest.nodeValue = papers.length === 1 ? ' paper' : ' papers';
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
      picker({ label: 'Sort papers', cls: 'sort', value: st.sort,
        options: [['relevance', 'Most relevant'], ['cited', 'Most cited'], ['newest', 'Newest']].map(([value, label]) => ({ value, label })),
        onChange: (v) => { st.sort = v; draw(); } }));
    const filterBtn = h('button', { class: 'btn quiet small', type: 'button', 'aria-expanded': String(!!st.toolsOpen), onclick: () => {
      st.toolsOpen = !st.toolsOpen; toolbar.hidden = !st.toolsOpen; filterBtn.setAttribute('aria-expanded', String(st.toolsOpen));
      if (st.toolsOpen) toolbar.querySelector('input').focus();
    } }, 'Filter');
    // The same Export menu as under an answer; here it exports the papers the list shows (after Filter).
    fill(shelf, h('div', { class: 'shelf-head' }, count), filterLine, toolbar, listEl,
      h('div', { class: 'reference-bottom' }, filterBtn,
        menuButton({ label: 'Export references', cls: 'refs-export', btnCls: 'btn quiet small', align: 'right', items: [
          { label: `Copy list (${Cite.STYLES[S.app.settings.citeStyle].label})`, note: 'The papers shown in this list',
            run: () => exportSome(visible, () => copyRich(Cite.formatList(visible, S.app.settings.citeStyle), 'References copied')) },
          { label: 'Download .bib', note: 'BibTeX, for LaTeX and reference managers',
            run: () => exportSome(visible, () => download('lectern-references.bib', Cite.formatList(visible, 'bibtex').text)) },
          { label: 'Download .ris', note: 'RIS, for Zotero, Mendeley or EndNote',
            run: () => exportSome(visible, () => download('lectern-references.ris', Cite.formatList(visible, 'ris').text, 'application/x-research-info-systems')) },
        ] })));
    draw();
    Motion.settle(st.mscope);
    return shelf;
  }

  /** Export only when there is something to export: an empty list (a filter that matches nothing) says so. */
  function exportSome(papers, run) {
    if (!papers.length) { toast('Nothing to export: no papers match. Clear the filter or the search first.'); return; }
    run();
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
      turns.length > 1 && picker({ label: 'References for question', cls: 'reference-turn',
        value: turns.indexOf(turn), options: turns.map((t, i) => ({ value: i, tag: String(i + 1).padStart(2, '0'), label: t.question })),
        onChange: (v) => { S.referenceTurn = turns[Number(v)]; refreshReferences(); } }),
      // With one question there is no picker, so the question is named here; the picker already names it otherwise.
      turn && turns.length < 2 && h('p', { class: 'reference-question', title: turn.question }, turn.question),
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
    if (e.key === 'Escape' && !e.defaultPrevented && S.referencesOpen && !document.querySelector('dialog[open]') && !closeMenu && !citeCardFor && !e.target.closest('.edit-box')) {
      e.preventDefault(); closeReferences();
    }
  });

  /**
   * Point at a paper (its stamp, its margin label or its row in References): its stamps light, and a
   * highlighter sweeps over every claim it supports, in the colour of what the paper found.
   */
  const ARTICLES = new WeakMap(); // a turn -> its <article> on the page (set by buildTurn)
  let lit = null; // { turn, key }: the paper lit right now, so a block of a streaming answer drawn again comes in lit
  function highlightPaper(turn, n) {
    const key = n == null ? '' : String(Number(n));
    lit = key ? { turn, key } : null;
    const article = ARTICLES.get(turn);
    if (article && article.isConnected) paintLit(article, turn, key);
  }
  /** Light one paper's stamps, labels and claims inside `root` (an article, or a block not yet on the page). */
  function paintLit(root, turn, key) {
    for (const chip of root.querySelectorAll('.cite[data-n], .specimen[data-n]')) chip.classList.toggle('hot', chip.dataset.n === key);
    const tone = key ? (insightFor(turn, Number(key))?.stance || 'plain') : '';
    for (const claim of root.querySelectorAll('.claim')) {
      const on = !!key && claim.dataset.ns.split(' ').includes(key);
      claim.classList.toggle('lit', on);
      if (on) claim.dataset.tone = ['supports', 'against', 'conditional', 'mixed'].includes(tone) ? tone : 'plain';
    }
  }

  /**
   * Light a paper, or clear it. Clearing waits a moment and is cancelled by the next lighting, so moving the
   * pointer or the keyboard focus from a stamp to its row in References (or back) never blinks the highlight off
   * and on again. Lighting is immediate and harmless to repeat.
   */
  let clearTimer = 0;
  function lightPaper(turn, n) {
    clearTimeout(clearTimer);
    if (n == null) clearTimer = setTimeout(() => highlightPaper(turn, null), 40); // just long enough to bridge stamp -> row
    else highlightPaper(turn, n);
  }

  function focusPaper(turn, n) {
    const st = shelfState(turn);
    const unchanged = S.referencesOpen && $('#references-panel')?._turn === turn && !st.paperNs && !st.query && !st.citedOnly;
    st.paperNs = null; st.query = ''; st.citedOnly = false;
    if (!unchanged) openReferences(turn); // already showing this paper list: just go to the row, no redraw
    const row = $(`#references-panel .paper[data-n="${n}"]`);
    if (!row) return;
    const list = row.closest('.papers');
    list.scrollTo({ top: row.offsetTop - list.clientHeight / 3, behavior: 'instant' });
    row.querySelector('.paper-title')?.focus({ preventScroll: true });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }

  const STEP_SINCE = new WeakMap(); // a running turn -> { at: the step under way, t: when it started }
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
      // The dots after the step under way keep their rhythm when the line is drawn again: their animation starts
      // as far back as the step has been under way.
      const since = STEP_SINCE.get(turn);
      if (!since || since.at !== at) STEP_SINCE.set(turn, { at, t: performance.now() });
      const dotsAge = Math.round(performance.now() - STEP_SINCE.get(turn).t);
      return h('ol', { class: 'runline steps', 'aria-label': 'Progress', 'aria-live': 'polite' }, steps.map(([label, now, done], i) => {
        const state = i < at ? 'done' : (i === at ? 'now' : 'todo');
        const detail = state === 'done' ? done : (state === 'now' ? now : label);
        // a step that has just changed fills in (and its line draws across); the animation survives the rebuilds
        const a = Motion.age(turn, `step${i}`, state);
        const fresh = a != null && state !== 'todo';
        const li = h('li', { class: fresh ? `${state} fresh` : state, title: detail, 'aria-label': detail, 'aria-current': state === 'now' ? 'step' : null },
          h('i', { class: 'pip', 'aria-hidden': 'true' }), h('span', { class: state === 'now' ? 'live' : '', style: state === 'now' ? `--dots-age:${dotsAge}` : null }, label));
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

  const reasoningLabel = (turn) => (turn.running && !turn.answer ? 'Thinking it through' : 'How the model reasoned');
  function buildReasoning(turn) {
    if (!turn.thinking || !turn.thinking.trim()) return h('div', { hidden: true });
    return h('details', { class: 'reasoning' }, h('summary', null, reasoningLabel(turn)), h('pre', null, turn.thinking.trim()));
  }
  /** The reasoning of the answer being written grows in place, so a reader who opened it keeps it open and can click it. */
  function patchReasoning(v, turn) {
    const text = (turn.thinking || '').trim();
    const d = v.reasoning;
    if (!text || d.tagName !== 'DETAILS') { if (text || d.tagName === 'DETAILS') swapPart(v, 'reasoning', buildReasoning(turn)); return; }
    const summary = d.querySelector('summary');
    if (summary.textContent !== reasoningLabel(turn)) summary.textContent = reasoningLabel(turn);
    const pre = d.querySelector('pre');
    if (pre.textContent !== text) pre.textContent = text;
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

  /** The answer drawn once: the brief, the body, the questions to ask next. Also counts which papers it cites. */
  function answerParts(turn) {
    const labels = citeLabels(turn);
    const opts = { paperCount: (turn.papers || []).length, webSources: turn.webSources || [],
      citeLabel: labels ? (n) => labels.get(n) : null, citeStance: (n) => insightFor(turn, n)?.stance || '' };
    const split = Render.splitFollowUps(turn.answer || '');
    const parts = Render.splitLead(split.body); // no brief for a meta opening
    const lead = Render.renderAnswer(parts.lead, opts);
    const body = Render.renderAnswer(parts.body, opts);
    turn.cited = new Set([...lead.cited, ...body.cited]);
    turn.citeCounts = new Map();
    for (const match of (lead.html + body.html).matchAll(/data-n="(\d+)"/g)) {
      const n = Number(match[1]); turn.citeCounts.set(n, (turn.citeCounts.get(n) || 0) + 1);
    }
    return { lead, body, hasLead: !!parts.lead, followUps: split.followUps };
  }

  const summaryTally = (turn) => `${(turn.papers || []).length} papers · abstracts`;
  function buildSummary(turn, parts = answerParts(turn)) {
    // asked every time, so the memory knows the card was not there before the opening arrived
    const shown = Motion.age(turn, 'lead', !!parts.hasLead);
    if (!parts.hasLead) return h('div', { hidden: true });
    const text = h('div', { class: 'answer summary-text' });
    drawText(text, parts.lead.html, turn);
    const card = h('section', { class: 'answer-summary', 'aria-label': 'Answer in brief' },
      h('p', { class: 'summary-eyebrow' }, h('span', null, 'Answer in brief'), h('span', { class: 'summary-tally' }, summaryTally(turn))),
      text,
      h('p', { class: 'summary-source' }, 'Summary from abstracts. Open the evidence you rely on.'));
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
    const page = isWebUrl(f.page) ? f.page : ''; // links and images only ever point at web addresses
    const img = h('img', {
      src: f.img, alt: name, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
      // A failed image leaves the card (caption, source, link) and says so in one line, instead of hiding the
      // whole card and pulling everything below it up while the reader is there.
      onerror: (e) => {
        const box = e.target.closest('.pf-image');
        // one line, the same height as the loading box, so nothing moves; the source line below links the article
        if (box) box.replaceWith(h('p', { class: 'pf-missing' }, 'The image could not be loaded.'));
      },
    });
    const card = h('figure', { class: 'paper-figure', 'data-evidence-section': first ? 'figures' : null, tabindex: first ? '-1' : null },
      h('figcaption', { class: 'pf-head' },
        h('button', { type: 'button', class: 'cite named', 'data-n': f.n, 'aria-label': `Paper ${f.n}: ${labels?.get(f.n) || `Paper ${f.n}`}` }, labels?.get(f.n) || `Paper ${f.n}`),
        h('span', { class: 'pf-label' }, f.label), f.title && h('span', { class: 'pf-title' }, f.title)),
      page
        ? h('a', { class: 'pf-image', href: page, target: '_blank', rel: 'noopener noreferrer', title: 'Open the full article, with the figure at full size' }, img)
        : h('div', { class: 'pf-image' }, img),
      f.read && h('p', { class: 'pf-read' }, h('strong', null, 'How to read: '), f.read),
      f.caption && h('details', { class: 'pf-caption' }, h('summary', null, 'Full caption'), h('p', null, f.caption)),
      h('p', { class: 'pf-source' }, 'From ', h('cite', null, p ? p.title : `paper ${f.n}`),
        f.license && ` · ${f.license}`, page && ' · ', page && h('a', { href: page, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Europe PMC')));
    return card;
  }
  /** Figures whose image is a web address (the server only sends those; this keeps the window from trusting it). */
  const figuresOf = (turn) => (turn.figures || []).filter((f) => isWebUrl(f.img));

  /**
   * Wrap the words each group of citation marks supports in a .claim span, back to the previous
   * sentence end, so pointing at a stamp can sweep a highlighter over exactly that claim. Existing
   * nodes only move into the span: nothing is parsed or re-escaped.
   */
  const ENDS_SENTENCE = /[.!?;:]["'”’)\]]*\s*$/;
  function markClaims(root) {
    for (const group of root.querySelectorAll('.cites')) {
      const ns = [...new Set([...group.querySelectorAll('.cite[data-n]')].map((c) => c.dataset.n))];
      if (!ns.length) continue;
      const take = [];
      const hasWords = () => take.some((n) => /\S/.test(n.textContent));
      let node = group.previousSibling;
      while (node) {
        if (node.nodeType === 1 && node.matches('.cites, .claim, br')) break;
        const text = node.textContent;
        if (hasWords() && ENDS_SENTENCE.test(text)) break; // the sentence before this claim
        if (node.nodeType === 3) {
          let cut = -1;
          for (const m of text.matchAll(/[.!?;:]["'”’)\]]*\s+(?=\S)/g)) cut = m.index + m[0].length;
          if (cut > 0) { take.unshift(node.splitText(cut)); break; } // the tail of the text is this claim
        }
        take.unshift(node);
        node = node.previousSibling;
      }
      if (!hasWords()) continue;
      const claim = h('span', { class: 'claim', 'data-ns': ns.join(' ') });
      take[0].before(claim);
      claim.append(...take);
    }
  }

  /**
   * Draw answer text (render.js output, in which every piece of text is escaped) into `el`. A finished answer is
   * drawn in one go. While an answer streams it is drawn block by block (each paragraph, heading, list or table):
   * a block that did not change stays exactly as it is, so the reader can point at it, click, select or fold it, and
   * only the block being written (usually the last) is drawn again. That block's new words fade in, the paper being
   * pointed at stays lit in it, and the card of a stamp in it stays up.
   */
  function drawText(el, html, turn) {
    if (turn.running && syncBlocks(el, html, turn)) return;
    el._blocks = null;
    el.innerHTML = html; // render.js output (see above)
    markClaims(el);
  }
  /** render.js puts each block on a line of its own; only a code block has line breaks inside it. */
  function htmlBlocks(html) {
    const out = [];
    for (const line of html ? html.split('\n') : []) {
      const i = out.length - 1;
      if (i >= 0 && out[i].startsWith('<pre>') && !out[i].endsWith('</pre>')) out[i] += `\n${line}`;
      else out.push(line);
    }
    return out;
  }
  const blockTpl = document.createElement('template');
  /** Returns false when the text is not made of whole blocks (then drawText draws it in one go). */
  function syncBlocks(el, html, turn) {
    const want = htmlBlocks(html);
    const have = el._blocks || [];
    if (!el._blocks && el.firstChild) el.replaceChildren();
    const t = performance.now();
    const next = [];
    for (let i = 0; i < want.length; i++) {
      const old = have[i];
      if (old && old.src === want[i]) { next.push(old); continue; }
      blockTpl.innerHTML = want[i]; // one block of render.js output (escaped)
      const node = blockTpl.content.firstChild;
      if (!node || node.nodeType !== 1 || blockTpl.content.childNodes.length !== 1) return false;
      markClaims(node);
      if (lit && lit.turn === turn) paintLit(node, turn, lit.key); // comes in lit, so its highlight does not sweep again
      const len = node.textContent.length;
      const pieces = Motion.fadeNext(old, len, t);
      Motion.fadeIn(node, pieces, t);
      if (old) replaceBlock(old.node, node); else el.append(node);
      next.push({ src: want[i], node, len, pieces });
    }
    for (let i = want.length; i < have.length; i++) have[i].node.remove();
    el._blocks = next;
    return true;
  }
  /** Put a new version of a block in place of the old one. The cite card and the keyboard focus move to its twin. */
  function replaceBlock(was, node) {
    const twin = (x, sel) => { const i = [...was.querySelectorAll(sel)].indexOf(x); return i < 0 ? null : node.querySelectorAll(sel)[i] || null; };
    if (citeCardFor && was.contains(citeCardFor)) {
      const next = twin(citeCardFor, '.cite[data-n]');
      if (next && next.dataset.n === citeCardFor.dataset.n) {
        citeCardFor.removeAttribute('aria-describedby');
        citeCardFor = next;
        next.setAttribute('aria-describedby', 'cite-card');
      } else hideCiteCard();
    }
    const focused = was.contains(document.activeElement) ? twin(document.activeElement, 'button, a[href]') : null;
    was.replaceWith(node);
    if (focused) focused.focus({ preventScroll: true });
  }

  /**
   * The margin: beside each paragraph, a small specimen label for each paper it cites for the first
   * time (kind of study as a folder colour, author and year, sample when the abstract states one).
   * Laid out on the answer's own grid, so each label sits level with its paragraph; hidden by CSS when
   * the window is too narrow for a margin.
   */
  function addMargin(turn, el) {
    const labels = citeLabels(turn);
    const byN = new Map((turn.papers || []).map((p) => [p.n, p]));
    const seen = new Set();
    let row = 0;
    const notes = [];
    // "84 distributed teams": the number is label data (mono), the words are words (sans)
    const sample = (s) => { const m = /^([\d.,]+(?:\s*[–-]\s*[\d.,]+)?)(.*)$/s.exec(String(s)); return m ? [h('span', { class: 'sp-num' }, `N ${m[1]}`), m[2]] : [h('span', { class: 'sp-num' }, 'N'), ` ${s}`]; };
    for (const block of [...el.children]) {
      row += 1;
      block.style.gridRow = String(row);
      if (block.classList.contains('paper-figure')) continue;
      const fresh = [...new Set([...block.querySelectorAll('.cite[data-n]')].map((c) => Number(c.dataset.n)))]
        .filter((n) => byN.has(n) && !seen.has(n));
      if (!fresh.length) continue;
      fresh.forEach((n) => seen.add(n));
      const shown = fresh.slice(0, 3);
      const note = h('div', { class: 'margin-note' },
        shown.map((n) => {
          const p = byN.get(n);
          const ins = insightFor(turn, n);
          const folder = folderOf(p, ins);
          const name = labels?.get(n) || byLine(p)[0];
          return h('button', { type: 'button', class: 'specimen', 'data-n': n, 'data-folder': folder, 'aria-label': `Paper ${n}: ${name}. Show it in References.` },
            h('span', { class: 'sp-no' }, `No. ${String(n).padStart(2, '0')}`, p.year ? ` · ${p.year}` : ''),
            h('span', { class: 'sp-name' }, name),
            h('span', { class: 'sp-det' }, (ins && ins.design) || (p.kind !== 'Article' ? p.kind : FOLDER_LABEL[folder])),
            ins && ins.sample && h('span', { class: 'sp-n' }, sample(ins.sample)));
        }),
        fresh.length > 3 && h('span', { class: 'sp-more' }, h('span', { class: 'sp-num' }, `+${fresh.length - 3}`), ' more in References'));
      note.style.gridRow = String(row);
      notes.push(note);
    }
    if (notes.length) { el.classList.add('has-margin'); el.append(...notes); }
  }

  /**
   * A small arrow at the right of a heading that hides or shows what belongs under it. Everything starts
   * open. Which ones the reader closed is kept with the turn (and handed on to the saved turn when a streamed
   * answer is saved), so a redraw (streaming, a new version, the finish) does not reopen them.
   */
  const FOLDS = new WeakMap(); // a turn -> the keys of its folded headings
  const foldsOf = (turn) => { let s = FOLDS.get(turn); if (!s) FOLDS.set(turn, (s = new Set())); return s; };
  /** The arrow after a heading. The heading's last word (or last piece) and the arrow never part at a line end. */
  function foldButton(heading, onClick) {
    const btn = h('button', { type: 'button', class: 'fold' }, icon('chev'));
    btn.addEventListener('click', onClick);
    const tail = h('span', { class: 'fold-tail' });
    const last = heading.lastChild;
    if (last && last.nodeType === 3) {
      const text = last.nodeValue.replace(/\s+$/, '');
      const cut = text.search(/\S+$/);
      if (cut > 0) { last.nodeValue = text.slice(0, cut); tail.append(text.slice(cut)); } else { last.remove(); tail.append(text); }
    } else if (last) tail.append(last);
    tail.append(btn);
    heading.append(tail);
    return btn;
  }
  function paintFold(btn, folded, label) {
    btn.setAttribute('aria-expanded', String(!folded));
    btn.setAttribute('aria-label', `${folded ? 'Show' : 'Hide'} ${label}`);
    btn.title = folded ? 'Show' : 'Hide';
  }
  // A folded part is hidden with its own class, not the `hidden` attribute, so that opening a fold never shows
  // something that is hidden for another reason (a figure whose image could not be loaded).
  const foldAway = (el, hide) => { if (el.classList.contains('fold-hide') !== hide) el.classList.toggle('fold-hide', hide); };
  /** One fold that hides `content()` (the evidence views: the comparison, each chart, the coverage map). */
  function addFold(turn, heading, key, content) {
    const folds = foldsOf(turn);
    const label = heading.textContent.trim();
    const apply = () => { paintFold(btn, folds.has(key), label); for (const el of content()) foldAway(el, folds.has(key)); };
    const btn = foldButton(heading, () => { if (folds.has(key)) folds.delete(key); else folds.add(key); apply(); });
    apply();
  }

  /**
   * The headings of the answer text, each hiding what sits under it up to the next heading of the same or a
   * higher level. Safe to call again (a streaming answer gains headings): a new heading gets its arrow, and a
   * block is hidden exactly when a heading above it in the outline is folded, so opening an outer heading
   * leaves a folded inner one closed. A margin label hides with the block level with it.
   */
  function foldAnswer(turn, el) {
    const folds = foldsOf(turn);
    const seen = new Map();
    const outline = []; // the headings the current block sits under: { level, folded }
    const hiddenRows = new Set();
    for (const x of el.children) {
      if (x.classList.contains('margin-note')) continue;
      const level = /^H[2-4]$/.test(x.tagName) ? Number(x.tagName[1]) : 0;
      if (level) while (outline.length && outline[outline.length - 1].level >= level) outline.pop();
      const hide = outline.some((o) => o.folded);
      foldAway(x, hide);
      if (hide && x.style.gridRow) hiddenRows.add(x.style.gridRow);
      if (!level) continue;
      const label = x.textContent.trim();
      const base = label.toLowerCase().slice(0, 60);
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      let btn = x.querySelector('.fold');
      if (!btn) {
        btn = foldButton(x, () => { const key = btn._key; if (folds.has(key)) folds.delete(key); else folds.add(key); foldAnswer(turn, el); });
      }
      btn._key = `a:${base}:${n}`;
      paintFold(btn, folds.has(btn._key), label);
      outline.push({ level, folded: folds.has(btn._key) });
    }
    for (const note of el.querySelectorAll(':scope > .margin-note')) foldAway(note, hiddenRows.has(note.style.gridRow));
  }

  /** The evidence views: the comparison, each chart, the coverage map. */
  function foldEvidence(turn, el) {
    for (const box of el.querySelectorAll('.evidence-heading')) {
      const kind = box.closest('[data-evidence-section]')?.dataset.evidenceSection || 'evidence';
      addFold(turn, box.querySelector('h3'), `e:${kind}`, () => {
        const out = box.querySelector('p') ? [box.querySelector('p')] : [];
        for (let x = box.nextElementSibling; x; x = x.nextElementSibling) out.push(x);
        return out;
      });
    }
    el.querySelectorAll('.evidence-chart').forEach((fig, i) => {
      const cap = fig.querySelector('figcaption');
      addFold(turn, cap, `e:chart:${i}`, () => [...fig.children].filter((c) => c !== cap));
    });
  }

  function buildAnswer(turn, parts = answerParts(turn)) {
    const el = h('div', { class: 'answer answer-body', 'data-evidence-section': 'synthesis', tabindex: '-1' });
    drawText(el, parts.body.html, turn);
    // Once the answer is complete, each figure goes after the first paragraph that cites its paper
    // (while it streams they wait below it, in buildFigures, so images do not reload on every word).
    if (!turn.running) {
      const lastAfter = new Map(); // two figures after the same paragraph keep their order
      figuresOf(turn).forEach((f, i) => {
        const mark = el.querySelector(`.cite[data-n="${f.n}"]`);
        let block = mark;
        while (block && block.parentElement !== el) block = block.parentElement;
        const card = figureCard(turn, f, i === 0);
        if (block) { (lastAfter.get(block) || block).after(card); lastAfter.set(block, card); } else el.append(card);
      });
      addMargin(turn, el);
    }
    foldAnswer(turn, el);
    return el;
  }

  function buildFigures(turn) {
    const figures = figuresOf(turn);
    if (!turn.running || !figures.length) return h('div', { hidden: true });
    return h('div', { class: 'figures-live' }, figures.map((f, i) => figureCard(turn, f, i === 0)));
  }

  function buildEvidence(turn) {
    // A failed answer has no evidence to compare: its card would only say what to try, and wrongly.
    if (turn.error) return h('div', { hidden: true });
    const labels = citeLabels(turn);
    const el = window.LecternEvidenceUI.build(turn, { h, label: (n) => labels?.get(n) || `Paper ${n}`,
      readingOn: !!S.app.settings.insights,
      inspect: (ids, name) => {
        if (!ARTICLES.get(turn)?.isConnected) return;
        const st = shelfState(turn);
        Object.assign(st, { paperNs: ids, filterLabel: name, citedOnly: false, query: '' });
        openReferences(turn, true);
      },
    });
    // the comparison, charts and map rise in when the readings of the abstracts first arrive
    foldEvidence(turn, el);
    const a = Motion.age(turn, 'evidence', window.LecternEvidenceUI.plan(turn).readings.length > 0);
    return a == null ? el : Motion.enter(el, 0, a);
  }

  /** Links to the parts of this answer. Only the views it actually has are listed (see evidence.js plan). */
  function buildAnswerNav(turn) {
    if (turn.mode === 'verify' || turn.error) return h('div', { hidden: true });
    const views = window.LecternEvidenceUI.plan(turn);
    const figures = figuresOf(turn);
    const items = [['synthesis', 'Synthesis'],
      figures.length > 0 && ['figures', (figures.length === 1 ? 'Figure' : 'Figures')],
      views.compare && ['compare', 'Compare studies'],
      (views.direction || views.design) && ['charts', 'Evidence charts'],
      views.coverage && ['coverage', 'Coverage map']].filter(Boolean);
    if (items.length < 2) return h('div', { hidden: true });
    return h('nav', { class: 'answer-nav', 'aria-label': 'Explore this answer' }, items.map(([key, label]) =>
      h('button', { type: 'button', onclick: (e) => {
        const section = e.currentTarget.closest('.turn').querySelector(`[data-evidence-section="${key}"]`);
        section?.querySelectorAll('.fold[aria-expanded="false"]').forEach((b) => b.click()); // a closed section opens when you jump to it
        if (section) { section.scrollIntoView({ block: 'start', behavior: Motion.calm() ? 'instant' : 'smooth' }); section.focus({ preventScroll: true }); }
      } }, label)));
  }

  /** The questions the answer suggests asking next, as buttons that ask them in this conversation. */
  function buildNext(turn, questions = Render.splitFollowUps(turn.answer || '').followUps) {
    if (!questions.length) return h('div', { hidden: true });
    return h('div', { class: 'next' },
      h('h3', null, 'Ask next'),
      h('ul', null, questions.map((q) => h('li', null,
        h('button', { type: 'button', class: 'example', 'data-busy': '', disabled: isBusy() || null, onclick: () => ask(q, { parent: turn.id }) }, q)))));
  }

  // Pointing at a citation mark (or tabbing to it) shows which paper it is, without leaving the sentence.
  const citeCard = h('div', { class: 'cite-card', id: 'cite-card', role: 'tooltip', hidden: true });
  let citeCardFor = null;
  let citeCardFrame = 0;
  function hideCiteCard() {
    citeCard.hidden = true;
    cancelAnimationFrame(citeCardFrame);
    if (citeCardFor) citeCardFor.removeAttribute('aria-describedby');
    citeCardFor = null;
  }
  function showCiteCard(chip, turn) {
    if (citeCardFor === chip) return;
    const p = (turn.papers || []).find((x) => x.n === Number(chip.dataset.n));
    if (!p) { hideCiteCard(); return; }
    const r = chip.getBoundingClientRect(); // read before anything is written, so this read costs no layout
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
    // Placed when the frame is drawn, when its size is known anyway, and shown in the same frame.
    citeCard.style.visibility = 'hidden';
    citeCardFrame = requestAnimationFrame(() => {
      if (!citeCardFor) return; // (a redraw of a streaming answer may have handed the card to the stamp's twin)
      const below = r.bottom + 8;
      const tall = citeCard.offsetHeight;
      citeCard.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - citeCard.offsetWidth - 12))}px`;
      citeCard.style.top = `${below + tall > window.innerHeight - 12 ? Math.max(12, r.top - tall - 8) : below}px`;
      citeCard.style.visibility = '';
    });
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
        h('button', { class: 'btn small', 'data-busy': '', disabled: isBusy() || null, onclick: () => ask(turn.question, { parent: turn.parentId, mode: turn.mode }) }, 'Try again'), ' ',
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
      // Two everyday actions and one menu for the exports, instead of six buttons of equal weight.
      kids.push(h('div', { class: 'turn-actions' },
        saved && h('button', {
          class: 'btn small', 'data-busy': '', disabled: isBusy() || null, title: 'Ask the same question again. This answer is kept as an earlier version.',
          onclick: () => ask(turn.question, { parent: turn.parent, mode: turn.mode }),
        }, 'Retry'),
        hasRefs && h('button', { class: 'btn small', onclick: () => copyAnswer(turn) }, 'Copy answer'),
        hasRefs && menuButton({ label: 'Export', cls: 'answer-export', items: [
          // The whole answer as a PDF: answer, findings by paper, figures, references and abstracts (ui/answerpdf.js).
          // The Export button is passed as the button, so it is disabled while the PDF is made.
          { label: 'Download PDF', note: 'The answer, its findings, figures and references',
            run: (button) => window.LecternAnswerPdf.export({ turn, button,
              deps: { h, api, toast, Cite, Render, state: S, answerParts, insightFor, citeLabels, prettyModel, engineInfo } }) },
          'sep',
          { label: `Copy reference list (${Cite.STYLES[style].label})`, note: 'The papers this answer draws on',
            run: () => copyRich(Cite.formatList(exportPapers(turn), style), 'Reference list copied') },
          { label: 'Download .bib', note: 'BibTeX, for LaTeX and reference managers',
            run: () => download('lectern-references.bib', Cite.formatList(exportPapers(turn), 'bibtex').text) },
          { label: 'Download .ris', note: 'RIS, for Zotero, Mendeley or EndNote',
            run: () => download('lectern-references.ris', Cite.formatList(exportPapers(turn), 'ris').text, 'application/x-research-info-systems') },
        ] })));
    }
    if (!turn.running && turn.engine) {
      const info = engineInfo(turn.engine);
      const u = turn.usage;
      const model = prettyModel(turn.model, turn.engine);
      const maker = info ? info.short : turn.engine;
      // "Claude Opus 5.5" already names its maker, so "Claude, " in front would only repeat it; "GPT-6.1 Sol" keeps "ChatGPT, ".
      const who = model.toLowerCase().startsWith(String(maker).toLowerCase()) ? model : `${maker}, ${model}`;
      const bits = [`${who}, ${(EFFORT_LABEL[turn.effort] || '').toLowerCase()} effort`];
      if (turn.web) bits.push('web search on');
      if (u && (u.input || u.output)) bits.push(`${nf.format(u.input)} tokens read, ${nf.format(u.output)} written`);
      kids.push(h('div', { class: 'turn-meta' }, bits.join('; ')));
    }
    return h('div', { class: 'foot' }, kids);
  }

  /**
   * The question, with its version switcher and actions (save, edit, copy, new chat from here, delete). The bar is
   * also drawn while the answer is written, with the actions that need a saved answer waiting, so the page does not
   * move when the answer is saved. A failed or stopped answer is not saved: it can be edited, copied or put away.
   */
  const editKey = (turn) => turn.id || 'live';
  function buildPrompt(turn) {
    const t = S.thread;
    const saved = !!(t && turn.id && t.turns.includes(turn));
    const unsaved = !saved && turn === S.live && !turn.running; // failed or stopped
    if ((saved || unsaved) && S.editing === editKey(turn)) return buildEditBox(turn);
    const busy = isBusy();
    const vers = saved ? versionsOf(t, turn) : [];
    const i = vers.indexOf(turn);
    const tool = turn.mode && turn.mode !== 'answer' ? modeInfo(turn.mode) : null;
    const long = turn.question.length > 240;
    const heading = h('h2', { class: `question${long ? ' long' : ''}` }, long ? `${turn.question.slice(0, 220).trimEnd()}…` : turn.question);
    const copy = h('button', { class: 'icon-btn', onclick: () => copyRich({ text: turn.question }, 'Question copied') }, 'Copy');
    const wait = 'Available once the answer is saved';
    const edit = () => { S.editing = editKey(turn); render(); };
    let actions;
    if (saved) {
      actions = [
        h('button', { class: `icon-btn save-prompt${turn.saved ? ' on' : ''}`, 'aria-pressed': String(!!turn.saved), title: turn.saved ? 'Remove this question from your library' : 'Keep this question and its answer in your library',
          onclick: () => setPromptSaved(t.id, turn.id, !turn.saved) }, turn.saved ? 'Unsave' : 'Save'),
        h('button', { class: 'icon-btn', 'data-busy': '', disabled: busy || null, title: 'Edit this question and ask again. The current answer is kept as an earlier version.', onclick: edit }, 'Edit'),
        copy,
        h('button', { class: 'icon-btn', 'data-busy': '', disabled: busy || null, title: 'Start a new chat with everything up to here', onclick: () => branchFrom(turn) }, 'New chat from here'),
        h('button', { class: 'icon-btn del', 'data-busy': '', disabled: busy || null, onclick: () => deleteTurn(turn) }, 'Delete')];
    } else if (turn.running) {
      actions = [
        h('button', { class: 'icon-btn save-prompt', disabled: true, title: wait }, 'Save'),
        h('button', { class: 'icon-btn', disabled: true, title: wait }, 'Edit'),
        copy,
        h('button', { class: 'icon-btn', disabled: true, title: wait }, 'New chat from here'),
        h('button', { class: 'icon-btn del', disabled: true, title: wait }, 'Delete')];
    } else {
      actions = [
        h('button', { class: 'icon-btn', 'data-busy': '', disabled: busy || null, title: 'Edit this question and ask it again', onclick: edit }, 'Edit'),
        copy,
        h('button', { class: 'icon-btn del', 'data-busy': '', disabled: busy || null, title: 'Remove this question. Its answer was not saved.', onclick: () => discardLive(turn) }, 'Delete')];
    }
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
      h('div', { class: 'prompt-bar' },
        turn.saved && h('span', { class: 'prompt-saved', title: 'This question is in your library' }, icon('bookmark'), 'Saved'),
        vers.length > 1 && h('span', { class: 'versions', role: 'group', 'aria-label': 'Versions of this question' },
          h('button', { class: 'icon-btn', 'aria-label': 'Previous version', disabled: i === 0 || null, onclick: () => showVersion(vers[i - 1]) }, '‹'),
          h('span', { 'aria-live': 'polite' }, `${i + 1} / ${vers.length}`),
          h('button', { class: 'icon-btn', 'aria-label': 'Next version', disabled: i === vers.length - 1 || null, onclick: () => showVersion(vers[i + 1]) }, '›')),
        h('span', { class: 'prompt-actions' }, actions)));
  }

  /** Put away a failed or stopped answer, which was never saved (after asking, as with any delete). */
  async function discardLive(turn) {
    if (turn !== S.live || turn.running) return;
    const ok = await confirmDialog({ title: 'Remove this question?', message: 'Its answer was not saved, so it cannot be brought back.', confirmLabel: 'Remove' });
    if (!ok || turn !== S.live) return;
    S.live = null;
    S.editing = null;
    if (S.thread && !S.thread.id) goHome(); // a new conversation whose only question failed
    else render();
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
      // A saved question gets a new version beside it; a failed or stopped one is asked again in its place.
      ask(q, { parent: turn.id ? turn.parent : turn.parentId, mode: turn.mode });
    };
    requestAnimationFrame(() => { grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return h('div', { class: 'edit-box' },
      ta,
      h('div', { class: 'edit-row' },
        h('small', null, turn.id ? 'Sends as a new version. The current answer stays in the version arrows beside the question.' : 'Asks the edited question in place of this unsaved answer.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: cancel }, 'Cancel'),
        h('button', { class: 'btn small primary', onclick: send }, 'Send')));
  }

  function buildTurn(turn) {
    const view = { turn };
    const parts = answerParts(turn); // drawn once for the brief, the body and the questions to ask next
    view.runline = buildRunline(turn);
    view.summary = buildSummary(turn, parts);
    view.reasoning = buildReasoning(turn);
    view.answer = buildAnswer(turn, parts);
    view.figures = buildFigures(turn);
    view.nav = buildAnswerNav(turn);
    view.evidence = buildEvidence(turn);
    view.foot = buildFoot(turn);
    view.next = buildNext(turn, parts.followUps);
    view.nextKey = parts.followUps.join('\n');
    view.el = h('article', { class: 'turn evidence-turn' },
      h('div', { class: 'page' }, buildPrompt(turn), view.runline, view.summary,
        view.nav, view.reasoning, view.answer, view.figures, view.evidence, view.foot, view.next));
    view.el._turn = turn;
    ARTICLES.set(turn, view.el);
    const citeChip = (e) => e.target.closest('button.cite[data-n]');
    const specimen = (e) => e.target.closest('button.specimen[data-n]');
    const point = (n) => lightPaper(turn, n);
    view.el.addEventListener('click', (e) => {
      const chip = citeChip(e) || specimen(e);
      if (chip) focusPaper(turn, Number(chip.dataset.n));
    });
    view.el.addEventListener('mouseover', (e) => {
      const chip = citeChip(e);
      if (chip) showCiteCard(chip, turn); else hideCiteCard();
      const any = chip || specimen(e);
      point(any ? any.dataset.n : null);
    });
    view.el.addEventListener('mouseleave', () => { hideCiteCard(); point(null); });
    view.el.addEventListener('focusin', (e) => {
      const chip = citeChip(e); if (chip) showCiteCard(chip, turn);
      const any = chip || specimen(e); point(any ? any.dataset.n : null);
    });
    view.el.addEventListener('focusout', () => { hideCiteCard(); point(null); });
    return view;
  }

  /**
   * Draw again the parts of the turn being answered that changed, without touching the rest of the page. At most
   * once a frame; the answer's text about 30 times a second (a frame that comes sooner leaves it for the next).
   * 'text' is the brief, the body and the questions to ask next, from one drawing of the answer.
   */
  const BUILDERS = { runline: buildRunline, evidence: buildEvidence, foot: buildFoot, figures: buildFigures, nav: buildAnswerNav };
  const pending = new Set();
  let frame = 0;
  let textDrawnAt = -Infinity;
  function refreshLive(...parts) {
    for (const p of parts) pending.add(p);
    if (!frame) frame = requestAnimationFrame(flushLive);
  }
  function swapPart(v, part, fresh) { v[part].replaceWith(fresh); v[part] = fresh; }
  function flushLive(now) {
    frame = 0;
    const v = S.liveView;
    const todo = new Set(pending);
    pending.clear();
    if (!v || !v.el.isConnected || !S.live || v.turn !== S.live) return;
    const turn = S.live;
    if (todo.has('text')) {
      if (now - textDrawnAt < 30) refreshLive('text');
      else { textDrawnAt = now; drawLiveText(v, turn); }
    }
    for (const part of todo) if (BUILDERS[part]) swapPart(v, part, BUILDERS[part](turn));
    if (todo.has('reasoning')) patchReasoning(v, turn);
    if (todo.has('shelf') && (!S.referenceTurn || S.referenceTurn === turn)) refreshReferences();
  }
  function drawLiveText(v, turn) {
    const parts = answerParts(turn);
    if (parts.hasLead && v.summary.classList.contains('answer-summary')) {
      drawText(v.summary.querySelector('.summary-text'), parts.lead.html, turn);
      const tally = v.summary.querySelector('.summary-tally');
      if (tally.textContent !== summaryTally(turn)) tally.textContent = summaryTally(turn);
    } else if (parts.hasLead || v.summary.classList.contains('answer-summary')) swapPart(v, 'summary', buildSummary(turn, parts));
    drawText(v.answer, parts.body.html, turn);
    foldAnswer(turn, v.answer);
    const key = parts.followUps.join('\n');
    if (key !== v.nextKey) { v.nextKey = key; swapPart(v, 'next', buildNext(turn, parts.followUps)); }
  }

  /** Buttons that wait while an answer is written (data-busy) follow isBusy() without their turns being drawn again. */
  function syncBusy() {
    const busy = isBusy();
    for (const b of document.querySelectorAll('[data-busy]')) b.disabled = busy;
  }

  // Long conversations: a question far off screen is not styled or laid out (content-visibility in world.css); it
  // keeps the height it had when it was last drawn. If it is drawn again at another height while it is wholly above
  // what the reader sees (the window became narrower, say), the page moves by the difference, so what the reader
  // sees stays still. Scroll anchoring cannot do this: it is off, because it moved the page when a fold opened.
  const turnHeights = new WeakMap();
  let holdTurns = false; // true while the page is moved on purpose (a jump to a question): it is not held still then
  const turnSizes = window.ResizeObserver ? new ResizeObserver((entries) => {
    const main = $('.main');
    if (!main) return;
    const top = main.getBoundingClientRect().top;
    let shift = 0;
    for (const e of entries) {
      const el = e.target;
      const now = e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : el.offsetHeight;
      const was = turnHeights.get(el);
      turnHeights.set(el, now);
      if (was != null && el.isConnected && el.getBoundingClientRect().bottom <= top) shift += now - was;
    }
    if (shift && !holdTurns) main.scrollTop += shift;
  }) : null;
  function watchTurn(el) {
    if (!turnSizes) return;
    turnHeights.delete(el);
    turnSizes.observe(el);
  }

  /**
   * Scroll to one question of the conversation. Questions passed on the way may be drawn again at another height
   * (content-visibility); they are not what the reader is reading, so the page is not held still for them while it
   * moves, and when it stops it lands exactly on the question.
   */
  function jumpToTurn(i) {
    stopStick(); // do not let "stay at the end" pull the page back
    const el = document.querySelectorAll('.thread > .turn')[i];
    const main = $('.main');
    if (!el || !main) return;
    holdTurns = true;
    let landed = false;
    const inputs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    const end = (exact) => {
      if (landed) return;
      landed = true;
      clearTimeout(timer);
      main.removeEventListener('scrollend', land);
      for (const ev of inputs) main.removeEventListener(ev, leave, true);
      holdTurns = false;
      if (exact && el.isConnected) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    const land = () => end(true);
    const leave = () => end(false); // the reader took over the scrolling: the page goes where they take it
    const timer = setTimeout(land, 1500); // (if the scroll ends without a scrollend event)
    main.addEventListener('scrollend', land);
    for (const ev of inputs) main.addEventListener(ev, leave, true);
    el.scrollIntoView({ block: 'start', behavior: Motion.calm() ? 'instant' : 'smooth' });
    if (Motion.calm()) requestAnimationFrame(() => requestAnimationFrame(land));
  }

  /** The bar above a conversation: its title, Save chat, the jump to a question and the References button. */
  function buildTopbar(t, turns) {
    // With more than one question on the page, a button jumps to any of them.
    const jump = turns.length > 1 ? picker({
      label: 'Jump to a question', cls: 'jump', always: true, value: turns.length - 1,
      options: turns.map((turn, i) => ({ value: i, tag: String(i + 1).padStart(2, '0'), label: turn.question })),
      face: (o) => [icon('list'), h('span', { class: 'picker-value' }, 'Questions'), h('span', { class: 'picker-tag' }, `${Number(o.value) + 1}/${turns.length}`)],
      onChange: (i) => jumpToTurn(Number(i)),
    }) : null;
    return h('header', { class: 'thread-topbar' },
      h('span', { class: 'thread-title', title: t.title }, t.title),
      saveChatButton(t),
      jump,
      h('button', { type: 'button', class: 'btn references-toggle', 'aria-controls': 'references-panel', 'aria-expanded': String(S.referencesOpen), onclick: () => {
        if (S.referencesOpen) closeReferences(); else openReferences(null, true);
      } }, icon('review'), 'References'));
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
    panel.addEventListener('mouseover', (e) => lightPaper(S.referenceTurn, e.target.closest('.paper[data-n]')?.dataset.n));
    panel.addEventListener('mouseleave', () => lightPaper(S.referenceTurn, null));
    panel.addEventListener('focusin', (e) => lightPaper(S.referenceTurn, e.target.closest('.paper[data-n]')?.dataset.n));
    panel.addEventListener('focusout', () => lightPaper(S.referenceTurn, null));
    const thread = h('div', { class: 'thread' }, views.map((v) => v.el));
    if (turnSizes) { turnSizes.disconnect(); views.forEach((v) => watchTurn(v.el)); }
    // Skipping far questions starts once every question has been laid out once, so each keeps its true height.
    requestAnimationFrame(() => requestAnimationFrame(() => thread.classList.add('cv')));
    return h('section', { class: 'thread-workspace' },
      buildTopbar(t, views.map((v) => v.turn)),
      h('div', { class: `thread-layout${S.referencesOpen ? ' references-open' : ''}` },
        h('div', { class: 'view thread-view' },
          thread,
          h('div', { class: 'dock' }, buildComposer({ placeholder: 'Ask a follow-up', autofocus: false, dock: true }))),
        panel));
  }

  /** Is this conversation the one drawn on screen right now? Then a question can be added or finished in place. */
  const drawnThread = (thread) => S.view === 'thread' && S.thread === thread && renderedView === 'thread' && renderedThread === thread && !!$('.thread');

  /** After a question is added or answered in place: the bar above the thread, the follow-up box, the sidebar. */
  function refreshThreadChrome() {
    const bar = $('.thread-topbar');
    if (bar) bar.replaceWith(buildTopbar(S.thread, [...document.querySelectorAll('.thread > .turn')].map((el) => el._turn)));
    const dock = $('.dock');
    const box = dock && dock.querySelector('.composer-wrap');
    if (box && box._sync && box._mode === S.compose.mode) box._sync();
    else if (dock) {
      const typing = dock.contains(document.activeElement);
      if (closeMenu) closeMenu();
      fill(dock, buildComposer({ placeholder: 'Ask a follow-up', autofocus: false, dock: true }));
      if (typing) $('.dock .ask')?.focus({ preventScroll: true });
    }
    syncBusy();
    renderRailOnly();
    refreshReferences();
  }

  // ------------------------------------------------------------------ library
  // ---- keeping a conversation in the library
  async function setChatSaved(id, saved) {
    try {
      const res = await api('PUT', '/api/thread', { id, saved });
      const row = S.threads.find((x) => x.id === id);
      if (row) { row.saved = !!res.thread.saved; row.savedAt = res.thread.savedAt || null; }
      if (S.thread && S.thread.id === id) { S.thread.saved = !!res.thread.saved; S.thread.savedAt = res.thread.savedAt || null; }
      renderRailOnly();
      const btn = $('.save-chat');
      if (btn && S.thread) btn.replaceWith(saveChatButton(S.thread)); // only the button changes: the page is not rebuilt
      if (S.view === 'library') render();
      toast(saved ? 'Chat saved to your library' : 'Chat removed from your library');
    } catch (e) { toast(e.message); }
  }
  /** Keep one question and its answer in the library (or take it out). Works from the chat or from the Library list. */
  async function setPromptSaved(threadId, turnId, saved) {
    try {
      const res = await api('PUT', '/api/turn', { thread: threadId, id: turnId, saved });
      const turn = S.thread && S.thread.id === threadId ? S.thread.turns.find((x) => x.id === turnId) : null;
      if (turn) { turn.saved = !!res.turn.saved; turn.savedAt = res.turn.savedAt || null; }
      await refreshThreads();
      renderRailOnly();
      const art = turn ? [...document.querySelectorAll('.turn')].find((el) => el._turn === turn) : null;
      if (art) art.querySelector('.prompt')?.replaceWith(buildPrompt(turn)); // only this question's bar changes
      if (S.view === 'library') render();
      toast(saved ? 'Question saved to your library' : 'Question removed from your library');
    } catch (e) { toast(e.message); }
  }

  /** Open a chat at one saved question: its branch is shown and the page scrolls to it. */
  async function openPrompt(threadId, turnId) {
    stopDictation();
    try {
      const t = S.live && S.live.running && S.live.thread.id === threadId ? S.live.thread : await api('GET', `/api/thread?id=${encodeURIComponent(threadId)}`);
      if (!t.turns.some((x) => x.id === turnId)) throw new Error('That question no longer exists.');
      if (!pathTo(t, t.leaf).some((x) => x.id === turnId)) { // it is on another version: show that one
        t.leaf = newestLeaf(t, turnId);
        api('PUT', '/api/thread', { id: t.id, leaf: t.leaf }).catch(() => { /* the view still switches */ });
      }
      S.thread = t; S.view = 'thread'; S.editing = null;
      render();
      stopStick(); // do not let "land at the end" pull the page past the question
      const i = pathTo(t, t.leaf).findIndex((x) => x.id === turnId);
      requestAnimationFrame(() => document.querySelectorAll('.thread > .turn')[i]?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    } catch (e) { toast(e.message); }
  }

  function saveChatButton(t) {
    const saved = !!t.saved;
    // Before the first answer is saved there is no chat to keep. The button says why instead of doing nothing
    // (it stays focusable, so the reason can be read and heard).
    const why = 'You can save this chat once its first answer has been saved.';
    return h('button', {
      type: 'button', class: `btn save-chat${saved ? ' on' : ''}`, 'aria-pressed': String(saved), 'aria-disabled': t.id ? null : 'true',
      title: !t.id ? why : (saved ? 'Remove this chat from your library' : 'Keep this chat in your library'),
      onclick: () => (t.id ? setChatSaved(t.id, !saved) : toast(why)),
    }, icon('bookmark'), saved ? 'Saved' : 'Save chat');
  }

  /** The Writing desk: proofreading, AI-writing, similarity and rewrite tools (ui/checks.js keeps its own state). */
  let checks = null;
  function renderScore() {
    if (!checks) checks = window.LecternChecks({ h, fill, api, toast, Motion, TOKEN, picker, prettyModel, state: S });
    return checks.view();
  }

  const LIB_TABS = [['papers', 'Papers'], ['chats', 'Chats'], ['prompts', 'Prompts']];
  function renderLibrary() {
    const chats = S.threads.filter((t) => t.saved).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    const prompts = savedPrompts();
    const tab = ['chats', 'prompts'].includes(S.libraryTab) ? S.libraryTab : 'papers';
    const counts = { papers: S.library.length, chats: chats.length, prompts: prompts.length };
    const pick = (id, focus) => { S.libraryTab = id; S.libraryQuery = ''; render(); if (focus) $(`#lib-tab-${id}`)?.focus(); };
    // Tabs: one tab stop; the arrow keys, Home and End move between them (and open the one they land on).
    const tabs = h('div', {
      class: 'lib-tabs', role: 'tablist', 'aria-label': 'Library',
      onkeydown: (e) => {
        const i = LIB_TABS.findIndex(([id]) => id === tab);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: LIB_TABS.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        pick(LIB_TABS[(to + LIB_TABS.length) % LIB_TABS.length][0], true);
      },
    }, LIB_TABS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: `lib-tab-${id}`, class: `lib-tab${tab === id ? ' on' : ''}`, 'aria-selected': String(tab === id),
      'aria-controls': 'lib-panel', tabindex: tab === id ? '0' : '-1', onclick: () => pick(id, false),
    }, label, h('span', { class: 'lib-count' }, counts[id]))));
    return h('section', { class: 'view library' }, h('h1', null, 'Library'), tabs,
      h('div', { class: 'lib-panel', id: 'lib-panel', role: 'tabpanel', 'aria-labelledby': `lib-tab-${tab}` },
        tab === 'chats' ? libraryChats(chats) : tab === 'prompts' ? libraryPrompts(prompts) : libraryPapers()));
  }

  /**
   * The search box shared by the tabs. Typing filters the list under it in place: the box itself is never drawn
   * again, so it keeps its caret and an input method's unfinished word (the list waits for the finished word).
   */
  let drawLibraryList = null; // set by the tab on screen
  function librarySearch(placeholder) {
    return h('input', {
      class: 'input search', type: 'search', placeholder, value: S.libraryQuery, 'aria-label': placeholder,
      oninput: (e) => { S.libraryQuery = e.target.value; if (!e.isComposing && drawLibraryList) drawLibraryList(); },
      oncompositionend: () => { if (drawLibraryList) drawLibraryList(); },
    });
  }
  /** The list under the search box, drawn by `draw()` now and again whenever the search changes. */
  function libraryList(draw) {
    const box = h('div', { class: 'lib-results' });
    drawLibraryList = () => fill(box, draw());
    drawLibraryList();
    return box;
  }

  /** Every saved question across all chats, newest saved first. */
  function savedPrompts() {
    return S.threads.flatMap((t) => (t.prompts || []).map((p) => ({ ...p, threadId: t.id, chat: t.title })))
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  }

  function libraryPrompts(prompts) {
    const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
    return [
      h('p', { class: 'sub' }, prompts.length
        ? `${prompts.length} saved question${prompts.length === 1 ? '' : 's'}. Open one to see its answer in its chat.`
        : 'Single questions you save are kept here, with their answers.'),
      prompts.length > 0 && h('div', { class: 'bar' }, librarySearch('Find in your saved questions')),
      libraryList(() => {
        const q = S.libraryQuery.trim().toLowerCase();
        const shown = q ? prompts.filter((p) => `${p.question} ${p.preview} ${p.chat}`.toLowerCase().includes(q)) : prompts;
        if (!prompts.length) return h('p', { class: 'empty' }, 'No saved questions yet. Hover a question in a chat and press Save.');
        if (!shown.length) return h('p', { class: 'empty' }, 'No saved question matches that search.');
        return h('ol', { class: 'chats prompts' }, shown.map((p) => h('li', { class: 'chat' },
          h('button', { type: 'button', class: 'chat-open', onclick: () => openPrompt(p.threadId, p.id) },
            icon('bookmark'),
            h('span', { class: 'chat-text' },
              h('span', { class: 'chat-title wrap' }, p.question),
              p.preview && h('span', { class: 'chat-preview' }, p.preview),
              h('span', { class: 'chat-meta' }, `From ${p.chat}${p.savedAt ? ` · saved ${when(p.savedAt)}` : ''}`))),
          h('button', { type: 'button', class: 'btn small chat-remove', 'aria-label': `Remove "${p.question}" from your library`, onclick: () => setPromptSaved(p.threadId, p.id, false) }, 'Remove'))));
      }),
    ];
  }

  function libraryChats(chats) {
    const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
    return [
      h('p', { class: 'sub' }, chats.length
        ? `${chats.length} saved chat${chats.length === 1 ? '' : 's'}. Open one to carry on where you left off.`
        : 'Chats you save are kept here.'),
      chats.length > 0 && h('div', { class: 'bar' }, librarySearch('Find in your saved chats')),
      libraryList(() => {
        const q = S.libraryQuery.trim().toLowerCase();
        const shown = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
        if (!chats.length) return h('p', { class: 'empty' }, 'No saved chats yet. Open a chat and press Save chat, or use the bookmark beside it in the sidebar.');
        if (!shown.length) return h('p', { class: 'empty' }, 'No saved chat matches that search.');
        return h('ol', { class: 'chats' }, shown.map((c) => h('li', { class: 'chat' },
          h('button', { type: 'button', class: 'chat-open', onclick: () => openThread(c.id) },
            icon('bookmark'),
            h('span', { class: 'chat-text' },
              h('span', { class: 'chat-title' }, c.title),
              h('span', { class: 'chat-meta' }, `${c.turns} question${c.turns === 1 ? '' : 's'}${c.savedAt ? ` · saved ${when(c.savedAt)}` : ''}`))),
          h('button', { type: 'button', class: 'btn small chat-remove', 'aria-label': `Remove "${c.title}" from your library`, onclick: () => setChatSaved(c.id, false) }, 'Remove'))));
      }),
    ];
  }

  function libraryPapers() {
    const shownPapers = () => {
      const q = S.libraryQuery.trim().toLowerCase();
      return q ? S.library.filter((p) => `${p.title} ${p.venue} ${p.year} ${p.authors.map((a) => a.family).join(' ')}`.toLowerCase().includes(q)) : S.library;
    };
    const style = S.app.settings.citeStyle;
    // the exports take the papers the search shows at the moment of the click
    const exportShown = (run) => { const shown = shownPapers(); exportSome(shown, () => run(shown)); };
    return [
      h('p', { class: 'sub' }, S.library.length
        ? `${S.library.length} saved paper${S.library.length === 1 ? '' : 's'}. Export them as a reference list, or into Zotero, Mendeley or EndNote.`
        : 'Papers you save are kept here, ready to export as a reference list.'),
      S.library.length > 0 && h('div', { class: 'bar' },
        librarySearch('Find in your library'),
        picker({ label: 'Reference style', cls: 'library-style', value: style,
          options: Object.entries(Cite.STYLES).filter(([, s]) => s.list).map(([value, s]) => ({ value, label: s.label })),
          onChange: async (v) => { try { await saveSettings({ citeStyle: v }); render(); } catch (e) { toast(e.message); } } }),
        h('button', { class: 'btn', onclick: () => exportShown((shown) => copyRich(Cite.formatList(shown, style), 'Reference list copied')) }, 'Copy reference list'),
        h('button', { class: 'btn', onclick: () => exportShown((shown) => download('lectern-library.bib', Cite.formatList(shown, 'bibtex').text)) }, 'Download .bib'),
        h('button', { class: 'btn', onclick: () => exportShown((shown) => download('lectern-library.ris', Cite.formatList(shown, 'ris').text, 'application/x-research-info-systems')) }, 'Download .ris')),
      libraryList(() => {
        const shown = shownPapers();
        if (!S.library.length) return h('p', { class: 'empty' }, 'Nothing saved yet. Ask a question, then press Save on any paper you want to keep.');
        if (!shown.length) return h('p', { class: 'empty' }, 'No saved paper matches that search.');
        return h('ol', { class: 'papers' }, shown.map((p) => paperRow(p, { turn: null, showNumber: false })));
      }),
    ];
  }

  // ------------------------------------------------------------------ cite dialog
  function openDialog(title, body) {
    const d = $('#dialog');
    Motion.animateDialog(d);   // it fades out when closed, Escape included
    Motion.keepDialogOpen(d);  // opened again while it was still fading out: it stays
    d.setAttribute('aria-labelledby', 'dialog-title'); // the dialog is named by its heading
    d.replaceChildren(
      h('div', { class: 'dialog-head' }, h('h2', { id: 'dialog-title' }, title),
        h('button', { class: 'btn quiet', onclick: () => d.close(), 'aria-label': 'Close' }, 'Close')),
      body);
    if (!d.open) d.showModal();
    return d;
  }

  /**
   * Ask before something that cannot be undone. Replaces the system confirm box with a Lectern dialog.
   * Resolves true only when the red button is pressed; Cancel, Escape and a click outside all resolve false.
   * `name` is shown in quotes on its own line, so a long title never breaks the sentence.
   */
  function confirmDialog({ title, name, message, confirmLabel = 'Delete', cancelLabel = 'Cancel' }) {
    return new Promise((resolve) => {
      const d = h('dialog', { class: 'dialog confirm', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text' });
      let answer = false;
      const done = (value) => { answer = value; d.close(); };
      Motion.animateDialog(d);
      d.append(
        h('div', { class: 'confirm-body' },
          h('div', { class: 'confirm-mark', 'aria-hidden': 'true' }, icon('trash')),
          h('div', { class: 'confirm-copy' },
            h('h2', { id: 'confirm-title' }, title),
            name && h('p', { class: 'confirm-name' }, name),
            h('p', { id: 'confirm-text' }, message))),
        h('div', { class: 'confirm-actions' },
          h('button', { type: 'button', class: 'btn', autofocus: true, onclick: () => done(false) }, cancelLabel),
          h('button', { type: 'button', class: 'btn danger', onclick: () => done(true) }, confirmLabel)));
      d.addEventListener('mousedown', (e) => { if (e.target === d) done(false); }); // the dimmed area around the card
      d.addEventListener('close', () => { d.remove(); resolve(answer); });
      document.body.append(d);
      d.showModal();
      d.querySelector('[autofocus]').focus(); // Cancel first, so Enter never deletes by accident
    });
  }

  /**
   * A drop-down in Lectern's own style, used instead of the system's <select> menu.
   * `options`: [{ value, label, tag? }]. Calls onChange(value) after the menu has closed.
   * Keyboard: Enter, Space or Down open it; Up, Down, Home, End move; Enter picks; Escape closes.
   */
  function picker({ label, options, value, onChange, cls = '', face = null, always = false }) {
    let current = value;
    let menu = null;
    const find = (v) => options.find((o) => String(o.value) === String(v)) || options[0];
    const btn = h('button', { type: 'button', class: 'picker-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label });
    const wrap = h('div', { class: `picker ${cls}` }, btn);
    const paint = () => { const o = find(current); fill(btn, face ? face(o) : [o.tag && h('span', { class: 'picker-tag' }, o.tag), h('span', { class: 'picker-value' }, o.label)]); btn.title = face ? label : o.label; };
    const onDocDown = (e) => { if (!wrap.contains(e.target)) close(false); };
    function close(refocus) {
      if (!menu) return;
      const m = menu; menu = null;
      document.removeEventListener('mousedown', onDocDown, true);
      btn.setAttribute('aria-expanded', 'false');
      m.classList.add('leaving');
      setTimeout(() => m.remove(), 160);
      if (refocus) btn.focus();
    }
    function pick(v) { close(true); if (always || String(v) !== String(current)) { current = v; paint(); onChange(v); } }
    function open() {
      if (menu) { close(true); return; }
      // Options may carry `group` (and `groupNote`): a heading is shown where the group changes. Headings are not options.
      menu = h('ul', { class: 'cmenu left picker-menu', role: 'listbox', tabindex: '-1', 'aria-label': label },
        options.map((o, i) => {
          const on = String(o.value) === String(current);
          const heading = o.group && (i === 0 || options[i - 1].group !== o.group)
            && h('li', { class: 'picker-group', role: 'presentation' }, h('span', null, o.group), o.groupNote && h('span', { class: 'picker-group-note' }, o.groupNote));
          return [heading, h('li', { class: `picker-opt${on ? ' on' : ''}`, role: 'option', tabindex: '-1', 'aria-selected': String(on), 'data-value': o.value, onclick: () => pick(o.value) },
            h('span', { class: 'picker-check' }, on && icon('check')),
            o.tag && h('span', { class: 'picker-tag' }, o.tag),
            h('span', { class: 'picker-text' }, o.label))];
        }));
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('.picker-opt')];
        const at = items.indexOf(document.activeElement);
        const go = (i) => { e.preventDefault(); items[(i + items.length) % items.length].focus(); };
        if (e.key === 'ArrowDown') go(at + 1);
        else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(items.length - 1);
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (at >= 0) pick(items[at].dataset.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'Tab') close(false);
      });
      wrap.append(menu);
      // A picker low on the page (the Rewrite style under the text box) opens upward when the menu does not fit
      // below the button and there is more room above. Room is counted inside the window and inside the nearest box
      // that scrolls or clips (a dialog), so the menu is not cut off by either. Nothing is scrolled to show it.
      const at = btn.getBoundingClientRect();
      let top = 0, bottom = innerHeight;
      for (let p = wrap.parentElement; p && p !== document.body; p = p.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)) continue;
        const r = p.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); break;
      }
      if (menu.offsetHeight + 12 > bottom - at.bottom && at.top - top > bottom - at.bottom) menu.classList.add('up');
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onDocDown, true);
      (menu.querySelector('.picker-opt.on') || menu.querySelector('.picker-opt')).focus();
    }
    btn.addEventListener('click', open);
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); open(); } });
    wrap._set = (v) => { if (String(v) === String(current)) return; current = v; paint(); }; // the page moved: show where it is (only when that changed)
    paint();
    return wrap;
  }

  /**
   * A button that opens a short menu of actions, drawn like the ask box's menus. It is used where a row would
   * otherwise hold many buttons of equal weight (an answer's exports). `items`: { label, note?, run(button) } or 'sep'.
   * Keyboard: Enter, Space or Down open it; Up, Down, Home and End move; Enter runs; Escape or Tab closes.
   * It shares `closeMenu` with the ask box's menus, so a click elsewhere, Escape or a redraw closes it, and only one
   * menu is open at a time.
   */
  function menuButton({ label, items, cls = '', btnCls = 'btn small', align = 'left' }) {
    let menu = null;
    const btn = h('button', { type: 'button', class: `${btnCls} menu-btn cmenu-anchor`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      label, icon('chev'));
    const wrap = h('span', { class: `menu-wrap ${cls}` }, btn);
    const open = () => {
      if (closeMenu) closeMenu();
      // The room is measured before the menu exists: a menu that stuck out of a narrow window, even for a moment,
      // would widen the page (or zoom it out on a phone-sized screen) and move what the reader is looking at.
      const vw = document.documentElement.clientWidth;
      const b = btn.getBoundingClientRect();
      const floor = Math.min(window.innerHeight, $('.dock')?.getBoundingClientRect().top ?? Infinity); // the docked ask box
      const ceiling = Math.max(0, $('.thread-topbar')?.getBoundingClientRect().bottom ?? 0);
      menu = h('div', {
        class: `cmenu ${align === 'right' ? 'right' : 'left'} action-menu`, role: 'menu', 'aria-label': label,
        onkeydown: (e) => {
          const rows = [...menu.querySelectorAll('.cmenu-row:not([disabled])')];
          const at = rows.indexOf(document.activeElement);
          const go = (i) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus(); };
          if (e.key === 'ArrowDown') go(at + 1);
          else if (e.key === 'ArrowUp') go(at < 0 ? rows.length - 1 : at - 1);
          else if (e.key === 'Home') go(0);
          else if (e.key === 'End') go(rows.length - 1);
          else if (e.key === 'Tab') closeMenu();
        },
      }, items.filter(Boolean).map((it) => (it === 'sep'
        ? h('div', { class: 'cmenu-sep', role: 'separator' })
        : h('button', { type: 'button', class: 'cmenu-row', role: 'menuitem', onclick: () => { closeMenu(true); it.run(btn); } },
          h('span', { class: 'cmenu-text' }, h('b', null, it.label), it.note && h('small', null, it.note))))));
      // Added hanging left from the button's right edge, where it cannot widen the page; placed once its size is known.
      menu.style.left = 'auto';
      menu.style.right = '0';
      wrap.append(menu);
      const w = menu.offsetWidth;
      // Open towards the room: upwards when the space below it (down to the docked ask box) is too small.
      const below = floor - b.bottom - 12;
      const above = b.top - ceiling - 12;
      const up = below < menu.offsetHeight && above > below;
      menu.classList.toggle('up', up);
      menu.style.maxHeight = `${Math.max(120, Math.min(530, up ? above : below))}px`;
      // Lined up with the button's left edge (or right edge), and kept 12px inside the window.
      const x = Math.max(12, Math.min(align === 'right' ? b.right - w : b.left, vw - 12 - w));
      menu.style.left = `${Math.round(x - b.left)}px`;
      menu.style.right = 'auto';
      btn.setAttribute('aria-expanded', 'true');
      // a question on the page is drawn whole while its menu is open (content-visibility would clip the menu)
      const turnEl = btn.closest('.turn');
      turnEl?.classList.add('menu-open');
      closeMenu = (refocus) => {
        Motion.leave(menu);
        menu = null;
        closeMenu = null;
        btn.setAttribute('aria-expanded', 'false');
        setTimeout(() => turnEl?.classList.remove('menu-open'), 200); // after the menu's fade
        if (refocus) btn.focus({ preventScroll: true }); // the page stays where the reader left it
      };
      menu.querySelector('.cmenu-row')?.focus({ preventScroll: true });
    };
    btn.addEventListener('click', () => { if (menu && closeMenu) closeMenu(true); else open(); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); open(); } });
    return wrap;
  }

  function openCite(p) {
    let style = S.app.settings.citeStyle;
    const body = h('div', { class: 'dialog-body' });
    const draw = () => {
      const out = Cite.format(p, style);
      const mono = style === 'bibtex' || style === 'ris';
      fill(body,
        Motion.slide(h('div', { class: 'cite-styles', role: 'group', 'aria-label': 'Reference style' },
          Object.entries(Cite.STYLES).map(([id, s]) => h('button', {
            type: 'button', class: `btn small${id === style ? ' primary on' : ''}`, 'aria-pressed': String(id === style),
            onclick: () => {
              style = id;
              if (s.list) saveSettings({ citeStyle: id }).catch((e) => toast(`The style was not kept for next time: ${e.message}`));
              draw();
              body.querySelector('.cite-styles .on')?.focus({ preventScroll: true }); // the redraw keeps the keyboard where it was
            },
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
    const choices = (key, label, list, wide) => Motion.slide(h('div', { class: `choices${wide ? ' wide' : ''}`, role: 'group', 'aria-label': label },
      list.map((o) => h('button', {
        type: 'button', class: `choice${draft[key] === o.id ? ' on' : ''}`, 'aria-pressed': String(draft[key] === o.id),
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
        h('h3', null, 'What is your field of study?'),
        choices('field', 'Field of study', S.app.profileOptions.fields),
        draft.field === 'other' && h('div', { class: 'engine-row' },
          h('label', { for: 'fieldOther' }, 'Your field of study'),
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
    refreshUsage();
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
    // The email goes to Crossref with each search, so it must at least look like one (or be left blank).
    const emailOk = () => {
      if (!draft.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) return true;
      toast('Enter a full email address, like name@example.org, or leave it blank.');
      $('#email')?.focus();
      return false;
    };
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
      // A key you are typing can be shown (the eye). A key already saved stays on the server: the window only ever
      // learns its last four characters, so that is what is shown for it.
      const input = h('input', {
        class: 'input', id: `key-${name}`, type: 'password', autocomplete: 'off', spellcheck: 'false', value: draft.keys[name] || '',
        placeholder: k.set ? 'Paste a new key to replace it' : 'Paste key',
        oninput: (e) => { if (e.target.value.trim()) draft.keys[name] = e.target.value.trim(); else delete draft.keys[name]; },
      });
      const eye = h('button', { type: 'button', class: 'key-toggle', 'aria-pressed': 'false', 'aria-label': `Show ${label}`, title: 'Show what you typed',
        onclick: () => {
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          eye.setAttribute('aria-pressed', String(show));
          eye.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${label}`);
          eye.title = show ? 'Hide' : 'Show what you typed';
          fill(eye, icon(show ? 'eyeoff' : 'eye'));
        } }, icon('eye'));
      return h('div', { class: 'engine-row' },
        h('label', { for: `key-${name}` }, label),
        h('span', { class: 'key-field' }, input, eye,
          k.set && h('small', { class: 'key-saved' }, 'Saved key ending ', h('code', null, k.hint), k.fromEnv ? ' (from your shell environment)' : '')),
        h('span', { class: 'key-actions' },
          link && !k.set && h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key'),
          k.set && !k.fromEnv && h('button', { type: 'button', class: 'btn small key-remove', onclick: async () => {
            try { await saveSettings({ keys: { [name]: '' } }); draw(); render(); } catch (e) { toast(e.message); }
          } }, 'Remove')));
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
      // How it works, then how to sign in. Once the engine is signed in, the sign-in steps are left out.
      const [works, signIn] = {
        'claude-code': ['Uses your saved Claude sign-in through Claude Code.', 'To sign in, open Claude Code in the Claude app, or run "claude" in Terminal.'],
        codex: ['Uses your saved ChatGPT sign-in through Codex. Answers arrive in one piece.', 'To sign in, open Codex in the ChatGPT app, or run "codex login" in Terminal.'],
        gemini: ['Uses your own Gemini API key from Google AI Studio. Google bills the key, not a Google AI Pro or Ultra plan: Google does not let other apps use those plans or the Gemini app\'s sign-in.', 'Make a key in Google AI Studio and paste it below.'],
      }[e.id] || ['', ''];
      const blurb = e.signedIn ? works : `${works} ${signIn}`.trim();
      const stateWord = e.ready ? 'Ready' : e.usesKey ? (e.found ? 'Key not accepted' : 'No key') : (e.found ? 'Not signed in' : 'Not installed');
      return h('div', { class: `engine${isDefault ? ' active' : ''}` },
        h('div', { class: 'engine-top' },
          h('strong', null, e.label),
          h('span', { class: `engine-state${e.ready ? ' ready' : ''}` }, stateWord),
          // an engine that is not linked cannot be made the default (Gemini stays out of the menus until then)
          !isDefault && (!e.hiddenUntilReady || e.ready) && h('button', { class: 'btn small', onclick: () => { draft.engine = e.id; draw(); } }, 'Make default')), // the default carries its own DEFAULT tab
        h('p', { class: 'engine-detail' }, e.detail),
        h('p', null, blurb),
        e.usesKey && keyField(e.id, 'Gemini API key', 'https://aistudio.google.com/apikey'),
        e.usesKey && h('p', { class: 'help' }, 'Privacy: on a free key Google uses what you send to improve its products, and people may read it, so use a paid key for drafts or data you would not share. Web search needs a paid key. Lectern asks Google not to keep the conversation.'),
        modelField(e.id, 'models', 'Answer model'),
        modelField(e.id, 'helperModels', 'Helper model'),
        h('datalist', { id: `models-${e.id}` }, e.models.map((m) => h('option', { value: m }))),
        h('div', { class: 'engine-row' },
          h('button', {
            class: 'btn small', disabled: (r && r.pending) || null, // drawn again while it runs: still pressed once only
            onclick: async (ev) => {
              if (results[e.id]?.pending || !emailOk()) return;
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
          r.ok ? `Connected. ${prettyModel(r.model, e.id)} replied in ${(r.ms / 1000).toFixed(1)} s.` : r.error), 'settings', `test-${e.id}`, r.ok ? 'ok' : `bad:${r.error}`, true, 'enter'));
    };

    function draw() {
      const scroll = body.parentElement ? body.parentElement.scrollTop : 0;
      fill(body,
        h('h3', { class: 'set-h' }, 'Model'),
        h('p', { class: 'help' }, 'Connect at least one. The answer model writes the answer at the effort you pick; the helper model does the quick jobs (planning the search, reading each abstract).'),
        // the highlighted edge slides to whichever card is made the default
        Motion.slide(h('div', { class: 'engine-list' }, S.app.engines.map(engineBlock)), 'default-engine'),

        h('h3', { class: 'set-h' }, 'Paper databases'),
        h('p', { class: 'help' }, 'Lectern searches these and merges the results. Links and reference details always come from the databases, not from the model.'),
        h('div', { class: 'rows' },
          h('div', { class: 'row sources' }, S.app.sources.map((src) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: draft.sources[src.name], onchange: (e) => { draft.sources[src.name] = e.target.checked; } }),
            src.label + (src.name === 'europepmc' ? ' (medicine and life sciences)' : '')))),
          keyField('openalex', 'OpenAlex key', 'https://openalex.org/settings/api'),
          keyField('semanticscholar', 'Semantic Scholar key', 'https://www.semanticscholar.org/product/api#api-key-form'),
          h('div', { class: 'engine-row' },
            h('label', { for: 'email' }, 'Your email'),
            h('input', { class: 'input', id: 'email', type: 'email', value: draft.email, placeholder: 'Optional. Crossref gives steadier service to identified requests', oninput: (e) => { draft.email = e.target.value.trim(); } }))),
        h('p', { class: 'help' }, 'OpenAlex is the broadest database and works without a key; a free key (about a minute to get) gives a much larger daily allowance and steadier results. Semantic Scholar also works without one but is often busy; a free key fixes that.'),

        h('h3', { class: 'set-h' }, 'What you study'),
        h('p', { class: 'help' }, 'Answers are pitched at this level and framed for this field. The papers Lectern finds stay the same.'),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, h('label', { for: 'profileLevel' }, 'Level'),
            picker({ label: 'Level', value: draft.profile.level || '',
              options: [{ value: '', label: 'Not set' }, ...S.app.profileOptions.levels.map((l) => ({ value: l.id, label: l.label }))],
              onChange: (v) => { draft.profile.level = v; } })),
          h('div', { class: 'row' }, h('label', { for: 'profileField' }, 'Field of study'),
            picker({ label: 'Field of study', value: draft.profile.field || '',
              options: [{ value: '', label: 'Not set' }, ...S.app.profileOptions.fields.map((f) => ({ value: f.id, label: f.label }))],
              onChange: (v) => { draft.profile.field = v; draw(); } }),
            draft.profile.field === 'other' && h('input', {
              class: 'input wide', 'aria-label': 'Your field of study', maxlength: '60', value: draft.profile.fieldOther, placeholder: 'Your field of study, for example: Architecture',
              oninput: (e) => { draft.profile.fieldOther = e.target.value; },
            }))),

        h('h3', { class: 'set-h' }, 'Answers'),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, h('label', { for: 'maxPapers' }, 'Papers per answer'),
            paperSlider(),
            h('span', { class: 'engine-state' }, 'More papers means a broader answer that costs more to write.')),
          h('div', { class: 'row' }, h('label', { for: 'citeStyle' }, 'Reference style'),
            picker({ label: 'Reference style', value: draft.citeStyle,
              options: Object.entries(Cite.STYLES).filter(([, st]) => st.list).map(([value, st]) => ({ value, label: st.label })),
              onChange: (v) => { draft.citeStyle = v; } })),
          h('div', { class: 'row' }, h('label', { for: 'citeMarks' }, 'Citations in answers'),
            picker({ label: 'Citations in answers', value: draft.citeMarks,
              options: [['author', 'Author and year'], ['number', 'Numbers']].map(([value, label]) => ({ value, label })),
              onChange: (v) => { draft.citeMarks = v; } }),
            h('span', { class: 'engine-state' }, 'How each citation is marked inside the answer text.')),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: draft.insights, onchange: (e) => { draft.insights = e.target.checked; } }),
            'Read each paper for its finding, design and stance (one extra model call per question)')),

        h('p', { class: 'help set-path' }, `Settings, chats and your library are stored on this computer in ${S.app.dataDir}`),
        h('div', { class: 'set-foot' },
          h('button', { class: 'btn', onclick: () => $('#dialog').close() }, 'Cancel'),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              if (!emailOk()) return;
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
    // A follow-up in the conversation on screen adds only its own article; anything else draws the page again.
    const failed = S.live && !S.live.running && S.live.thread === thread ? S.live : null; // a failed answer it replaces
    const inPlace = drawnThread(thread) && live.parentId === undefined && !S.editing && !failed;
    S.live = live;
    S.referenceTurn = live;
    S.view = 'thread';
    S.editing = null;
    if (fromBox) { S.compose.draft = ''; S.compose.mode = 'answer'; }
    if (inPlace) {
      hideCiteCard();
      S.liveView = buildTurn(live);
      $('.thread').append(S.liveView.el);
      watchTurn(S.liveView.el);
      refreshThreadChrome();
    } else render();
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
          case 'source':
            live.sources.push(d);
            if (d.name === 'openalex' && d.needsKey) S.oaRefused = true; // the home page then suggests a free key
            refreshLive('runline');
            break;
          case 'papers': live.papers = d.papers; refreshLive('text', 'shelf', 'evidence', 'runline'); break;
          case 'status': live.status = d.text; refreshLive('runline'); break;
          case 'delta': {
            const first = !live.answer;
            live.answer += d.text;
            if (live.status !== 'Writing the answer' && d.text.trim()) { live.status = 'Writing the answer'; refreshLive('runline'); }
            refreshLive('text');
            if (first && live.thinking) refreshLive('reasoning'); // its label changes once the answer starts
            break;
          }
          case 'thinking': live.thinking += d.text; refreshLive('reasoning'); break;
          case 'insights': live.insights = d.insights; refreshLive('text', 'shelf', 'evidence', 'nav'); break;
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
    refreshUsage();

    let saved = null;
    if (finished) {
      // The answer is saved on disk; move it from "live" into the conversation.
      thread.id = finished.threadId;
      thread.title = finished.title;
      const { thread: _t, running: _r, stage: _s, status: _st, parentId: _p, ...turn } = live;
      saved = { id: finished.turnId, parent: finished.parent === undefined ? null : finished.parent, ...turn };
      thread.turns.push(saved);
      thread.leaf = finished.turnId;
      // what the reader set on the answer while it was written carries over: folds, the reference list's filter
      FOLDS.set(saved, foldsOf(live));
      S.shelf.set(saved, shelfState(live));
      if (S.referenceTurn === live) S.referenceTurn = saved;
      if (lit && lit.turn === live) lit = { turn: saved, key: lit.key };
      S.live = null;
      try { S.threads = (await api('GET', '/api/threads')).threads; } catch { /* list refreshes next time */ }
      if (!(S.view === 'thread' && S.thread === thread)) toast('Your answer is ready');
    }
    // On screen, only this question's article is drawn again (the questions above it stay as they are).
    const view = S.liveView;
    if (drawnThread(thread) && view && view.turn === live && view.el.isConnected) {
      hideCiteCard();
      const next = buildTurn(saved || live);
      if (view.reasoning.open && next.reasoning.tagName === 'DETAILS') next.reasoning.open = true;
      if (lit && lit.turn === (saved || live)) paintLit(next.el, lit.turn, lit.key);
      if (turnSizes) turnSizes.unobserve(view.el);
      view.el.replaceWith(next.el);
      watchTurn(next.el);
      S.liveView = saved ? null : next;
      refreshThreadChrome();
    } else render();
    if (saved && saved.parent === null && thread.turns.some((x) => x !== saved && x.parent === null)) followTitle(thread);
  }

  /**
   * A conversation is titled with its first question unless the reader renamed it. When the first question on the
   * path shown changes (it was edited, or another version of it is shown), the title follows it.
   */
  function clipTitle(s, max = 80) { // the server's clip() in server/util.js, which made the title
    s = String(s || '');
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  async function followTitle(t) {
    const root = t && t.id ? pathTo(t, t.leaf)[0] : null;
    if (!root) return;
    const named = !t.turns.some((x) => x.parent === null && clipTitle(x.question) === t.title); // renamed by the reader
    const want = clipTitle(root.question);
    if (named || want === t.title) return;
    try {
      await api('PUT', '/api/thread', { id: t.id, title: want });
      t.title = want;
      const row = S.threads.find((x) => x.id === t.id);
      if (row) row.title = want;
      renderRailOnly();
      const title = S.thread === t ? $('.thread-title') : null;
      if (title) { title.textContent = want; title.title = want; }
    } catch { /* the old title stays until the next change */ }
  }

  // ------------------------------------------------------------------ navigation
  // Keyboard shortcuts, as in the ChatGPT app: Command (Mac) or Ctrl (Windows) with N, L or K.
  const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
  const mod = (k) => (IS_MAC ? `\u2318${k}` : `Ctrl+${k}`);
  const NEW_KEYS = mod('N');
  function newQuestion() {
    goHome();
    requestAnimationFrame(() => $('.ask')?.focus());
  }
  function openLibrary() { stopDictation(); S.view = 'library'; render(); }
  function openScore() { stopDictation(); S.view = 'score'; render(); }
  const SHORTCUTS = { n: newQuestion, l: openLibrary, k: openScore };
  document.addEventListener('keydown', (e) => {
    const action = SHORTCUTS[String(e.key).toLowerCase()];
    if (!action || e.shiftKey || e.altKey || !(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
    if (document.querySelector('dialog[open]')) return; // a settings or confirm window is open: leave it alone
    e.preventDefault();
    action();
  });

  function goHome() { stopDictation(); S.view = 'home'; S.thread = null; S.editing = null; render(); }

  async function openThread(id) {
    // The conversation already open stays as it is: no new fetch, no jump to its end, no entrance.
    if (S.view === 'thread' && S.thread && S.thread.id === id) return;
    stopDictation();
    // Only an answer still being written lives in memory; one that finished or failed is read from disk again.
    if (S.live && S.live.running && S.live.thread.id === id) { S.thread = S.live.thread; S.view = 'thread'; return render(); }
    try {
      S.thread = await api('GET', `/api/thread?id=${encodeURIComponent(id)}`);
      S.view = 'thread';
      S.editing = null;
      render(); // opening a conversation lands on its end (render does the scrolling)
    } catch (e) { toast(e.message); }
  }

  /** Show another version of a question, and the conversation that followed it. */
  function showVersion(turn) {
    const t = S.thread;
    if (!t || !turn) return;
    t.leaf = newestLeaf(t, turn.id);
    render();
    api('PUT', '/api/thread', { id: t.id, leaf: t.leaf })
      .then(() => { if (turn.parent === null) followTitle(t); }) // another version of the first question: the title follows
      .catch(() => { /* the view still switched; it resets on reload */ });
  }

  async function refreshThreads() {
    try { S.threads = (await api('GET', '/api/threads')).threads; } catch { /* list refreshes next time */ }
  }

  async function deleteTurn(turn) {
    const t = S.thread;
    const later = pathTo(t, t.leaf).indexOf(turn) < pathTo(t, t.leaf).length - 1;
    const msg = `Its answer is deleted with it.${later ? ' The questions asked after it are deleted too.' : ''} This cannot be undone.`;
    if (!(await confirmDialog({ title: 'Delete this question?', message: msg, confirmLabel: 'Delete' }))) return;
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
      toast('Opened as a new chat');
    } catch (e) { toast(e.message); }
  }

  async function duplicateThread(t) {
    try {
      const res = await api('POST', '/api/thread/branch', { id: t.id });
      S.thread = res.thread;
      S.view = 'thread';
      await refreshThreads();
      render();
      toast('Chat duplicated');
    } catch (e) { toast(e.message); }
  }

  async function deleteThread(t) {
    if (answering(t)) { toast('Wait until the answer is written, or stop it, before deleting this chat.'); return; }
    if (!(await confirmDialog({ title: 'Delete this chat?', name: t.title, message: 'All its questions and answers are deleted. This cannot be undone.', confirmLabel: 'Delete chat' }))) return;
    try {
      const result = await api('DELETE', `/api/thread?id=${encodeURIComponent(t.id)}`);
      if (!result.ok) throw new Error('The chat could not be deleted.');
      S.threads = S.threads.filter((x) => x.id !== t.id);
      if (S.thread && S.thread.id === t.id) { S.thread = null; S.view = 'home'; }
      render();
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ render
  function renderRailOnly() { const old = $('.rail'); if (old) old.replaceWith(renderRail()); }
  /** Everything the sidebar shows apart from which page is open. While it is unchanged, render() keeps the sidebar. */
  function railKey() {
    const active = engineInfo(S.compose.engine);
    return JSON.stringify([
      S.threads.map((t) => [t.id, t.title, !!t.saved, (t.prompts || []).length]),
      S.library.length, S.renaming, S.live && S.live.running ? [S.live.question, S.live.thread.id || ''] : null,
      !!(S.live && S.live.running && !(S.view === 'thread' && S.thread === S.live.thread)),
      active && [active.id, active.short, active.ready], S.compose.model, S.compose.effort,
    ]);
  }
  /** Mark the open page and the open conversation in a sidebar that is kept. */
  function syncRailOn(rail) {
    const [library, desk] = rail.querySelectorAll('.rail-nav .rail-link');
    library?.classList.toggle('on', S.view === 'library');
    desk?.classList.toggle('on', S.view === 'score');
    for (const li of rail.querySelectorAll('.history > li[data-id]')) li.classList.toggle('on', S.view === 'thread' && !!S.thread && S.thread.id === li.dataset.id);
  }

  /**
   * Opening a conversation shows its end: the latest answer and the follow-up box. The page is still
   * growing for a moment (figures load, fonts settle), so the end is re-applied until it stops
   * growing, and dropped at once if the reader scrolls, presses a key or opens something else.
   */
  let stopStick = () => {};
  // The jump button always shows which question is at the top of the page.
  let syncQueued = false;
  document.addEventListener('scroll', (e) => {
    if (syncQueued || !(e.target instanceof Element) || !e.target.matches('.main')) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      const jump = $('.picker.jump');
      const turns = [...document.querySelectorAll('.thread > .turn')];
      if (!jump || !turns.length) return;
      const edge = e.target.getBoundingClientRect().top + 110; // below the sticky bar
      let at = 0;
      turns.forEach((el, i) => { if (el.getBoundingClientRect().top <= edge) at = i; });
      jump._set(at);
    });
  }, true);
  function stickToEnd(main) {
    stopStick();
    let active = true;
    const go = () => { if (active) main.scrollTo({ top: main.scrollHeight, behavior: 'instant' }); };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    let timer = 0;
    const stop = () => {
      active = false; // also cancels the frames already queued
      clearTimeout(timer);
      main.removeEventListener('load', go, true);
      for (const ev of events) main.removeEventListener(ev, stop, true);
      stopStick = () => {};
    };
    stopStick = stop;
    go();
    requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
    main.addEventListener('load', go, true); // an image finished loading and made the page taller
    for (const ev of events) main.addEventListener(ev, stop, true);
    timer = setTimeout(stop, 1500);
  }

  let renderedView = null;
  let renderedThread = null;
  function render() {
    if (voiceOn()) stopDictation();
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
    else if (S.view === 'score') view = renderScore();
    else { S.view = 'home'; view = renderHome(); }
    // going to another screen (not redrawing this one): the new screen eases in
    if (!preserve) view.classList.add('nav-enter');
    const main = previousMain || h('main', { class: 'main' });
    main.replaceChildren(h('div', { class: 'topstrip' }), view);
    // The sidebar is drawn again only when what it lists changed; going to another page only moves its marks.
    const oldRail = $('.rail');
    const rail = oldRail && oldRail._key === railKey() ? oldRail : renderRail();
    if (rail === oldRail) syncRailOn(rail);
    if (rail !== oldRail || !main.isConnected) $('#app').replaceChildren(rail, main);
    refreshReferences();
    if (!preserve && S.view === 'thread') stickToEnd(main);
    else { stopStick(); main.scrollTo({ top: scroll, behavior: 'instant' }); }
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
      let stored = false; // storage can be blocked (a private window, cleared site data): then the defaults apply
      try { stored = !!localStorage.getItem('lectern.compose'); } catch { /* not available */ }
      if (!stored) { S.compose.effort = app.settings.effort; S.compose.web = app.settings.web; }
      render();
      // First launch: ask once what the reader studies. After that it lives on the home page and in Settings.
      refreshUsage();
      if (!app.settings.profile.asked && !profileLabel()) {
        openProfile();
        saveSettings({ profile: { asked: true } }).catch(() => { /* asking again next time is harmless */ });
      }
    } catch (e) {
      $('#app').replaceChildren(h('div', { class: 'view' }, h('div', { class: 'error' }, `Lectern could not start: ${e.message}`)));
    }
  }

  setInterval(refreshUsage, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUsage(); });
  window.addEventListener('focus', () => refreshUsage());
  boot();
})();
