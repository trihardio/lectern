'use strict';
// A steps file for scripts/ui-check.js: the animation, lag and evenness audit of the whole window.
//   FAKE_STREAM_MS=40 node scripts/ui-check.js --steps scripts/ui-audit.js --mock --no-ask --out <scratch folder>
// It records long tasks, layout shifts, frame gaps, every animation and transition (flagging any that animate
// layout properties), animations still running when the window is idle, classes left half way, page overflow,
// clipped text, uneven rows of controls, overlapping controls and small targets, on home, a streamed answer,
// citation hovers, folds, menus, Settings, Library, AI score, dark mode, 390px and Reduce motion.
// Read the numbers, then look at the pictures in <out>/shots. Overlaps under the docked composer and the sticky
// thread bar are expected (content scrolls beneath them), and so are overlaps with the page behind a dialog.
// First-use timings are cold (styles and fonts load once); repeat an action to judge lag.
const INSTR = `
if (window.__p) return 'already';
const desc = (n) => { if (!n || !n.tagName) return String(n && n.nodeName); let c = ''; if (typeof n.className === 'string' && n.className.trim()) c = '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.'); else if (n.className && n.className.baseVal) c = '.' + n.className.baseVal; return n.tagName.toLowerCase() + c; };
window.__desc = desc;
window.__p = { long: [], shifts: [], gaps: [], anims: [], trans: [] };
new PerformanceObserver((l) => l.getEntries().forEach((e) => __p.long.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }))).observe({ type: 'longtask' });
new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) __p.shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), src: (e.sources || []).map((s) => desc(s.node)).slice(0, 3) }); })).observe({ type: 'layout-shift' });
let last = performance.now(); const f = (now) => { const d = now - last; if (d > 40) __p.gaps.push({ t: Math.round(now), d: Math.round(d) }); last = now; requestAnimationFrame(f); }; requestAnimationFrame(f);
document.addEventListener('animationstart', (e) => __p.anims.push({ name: e.animationName, el: desc(e.target) }), true);
document.addEventListener('transitionrun', (e) => __p.trans.push({ prop: e.propertyName, el: desc(e.target), dur: getComputedStyle(e.target).transitionDuration }), true);
const LAYOUT = /^(width|height|top|left|right|bottom|margin|padding|block-size|inline-size|max-height|max-width|min-height|font-size|grid-template|inset|line-height|letter-spacing)/;
window.__take = () => {
  const p = __p; const out = {};
  out.long = p.long.splice(0); out.longMax = Math.max(0, ...out.long.map((x) => x.d));
  const sh = p.shifts.splice(0); out.cls = +sh.reduce((s, x) => s + x.v, 0).toFixed(4); out.shiftSrc = [...new Set(sh.flatMap((x) => x.src))].slice(0, 6);
  const g = p.gaps.splice(0); out.gaps = g.length; out.gapMax = Math.max(0, ...g.map((x) => x.d));
  const a = p.anims.splice(0); const ac = {}; a.forEach((x) => { const k = x.name + ' @ ' + x.el; ac[k] = (ac[k] || 0) + 1; }); out.anims = ac;
  const t = p.trans.splice(0); const lay = {}; t.filter((x) => LAYOUT.test(x.prop)).forEach((x) => { const k = x.prop + ' @ ' + x.el; lay[k] = (lay[k] || 0) + 1; }); out.layoutTransitions = lay; out.transitions = t.length;
  return out;
};
window.__running = () => document.getAnimations().filter((a) => a.playState === 'running').map((a) => ({ name: a.animationName || a.transitionProperty || 'waapi', el: desc(a.effect && a.effect.target), inf: a.effect && a.effect.getTiming().iterations === Infinity }));
window.__stuck = () => {
  // something left half way: a closing class still on, an element hidden by an animation that ended early
  const bad = [];
  document.querySelectorAll('.leaving, .closing, .panel-enter, .nav-enter, .slide-arrive, .flash').forEach((e) => bad.push('class still on: ' + desc(e)));
  document.querySelectorAll('.app *').forEach((e) => { const cs = getComputedStyle(e); if (+cs.opacity < 0.98 && +cs.opacity > 0 && e.getBoundingClientRect().width > 0 && !e.closest('[disabled],:disabled') && !/slide-box|glide-box|chk-drop|toast/.test(e.className)) bad.push('opacity ' + cs.opacity + ': ' + desc(e)); });
  return bad.slice(0, 12);
};
window.__even = (root = document.body) => {
  const W = innerWidth, H = innerHeight; const res = {};
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return null; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return null; if (e.closest('[hidden],[inert]')) return null; return r; };
  res.pageOverflowX = document.documentElement.scrollWidth - W;
  const main = document.querySelector('.main'); res.mainOverflowX = main ? main.scrollWidth - main.clientWidth : null;
  const scrollerX = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth) return true; if (/(hidden|clip)/.test(cs.overflowX)) return 'clip'; } return false; };
  const all = [...root.querySelectorAll('*')];
  res.offRight = all.filter((e) => { const r = vis(e); return r && r.right > W + 1 && scrollerX(e) === false; }).slice(0, 8).map((e) => desc(e) + ' right=' + Math.round(e.getBoundingClientRect().right));
  res.clipped = all.filter((e) => { const cs = getComputedStyle(e); if (!/(hidden|clip)/.test(cs.overflowX) || cs.textOverflow === 'ellipsis' || e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') return false; if (!vis(e)) return false; if (!e.textContent.trim()) return false; return e.scrollWidth > e.clientWidth + 2 && cs.whiteSpace !== 'normal' ; }).slice(0, 8).map((e) => desc(e) + ' ' + e.scrollWidth + '>' + e.clientWidth);
  // rows of controls: a flex row of buttons that should share one centre line and one height
  const rows = []; all.forEach((e) => { const cs = getComputedStyle(e); if (!/flex/.test(cs.display) || /column/.test(cs.flexDirection) || !vis(e)) return; const kids = [...e.children].filter((k) => vis(k) && /^(BUTTON|A|INPUT|KBD|LABEL)$|picker|chip|btn|tag|kbd/.test(k.tagName + ' ' + k.className) && k.getBoundingClientRect().height < 64 && getComputedStyle(k).position !== 'absolute'); if (kids.length < 2) return; const rs = kids.map((k) => k.getBoundingClientRect()); const lines = {}; rs.forEach((r, i) => { const key = Math.round(r.top / 30); (lines[key] = lines[key] || []).push([kids[i], r]); }); Object.values(lines).forEach((ln) => { if (ln.length < 2) return; const cs2 = ln.map(([, r]) => r.top + r.height / 2); const cd = Math.max(...cs2) - Math.min(...cs2); const btns = ln.filter(([k]) => /btn|picker-btn|chip/.test(k.className) || k.tagName === 'BUTTON'); const hs = btns.map(([, r]) => r.height); const hd = hs.length > 1 ? Math.max(...hs) - Math.min(...hs) : 0; if (cd > 1.5 || hd > 2.5) rows.push(desc(e) + ' centreDiff=' + cd.toFixed(1) + ' heightDiff=' + hd.toFixed(1) + ' [' + ln.map(([k, r]) => desc(k) + ':' + Math.round(r.height)).join(', ') + ']'); }); });
  res.unevenRows = rows.slice(0, 12);
  // controls that overlap each other
  const ctl = all.filter((e) => /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && vis(e));
  const ov = []; for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) { const a = ctl[i], b = ctl[j]; if (a.contains(b) || b.contains(a)) continue; const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top); if (x > 2 && y > 2) ov.push(desc(a) + ' x ' + desc(b) + ' ' + Math.round(x) + 'x' + Math.round(y)); }
  res.overlaps = ov.slice(0, 8);
  // small targets
  res.smallTargets = ctl.filter((e) => { const r = e.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && e.tagName !== 'A' && r.top < H; }).slice(0, 8).map((e) => desc(e) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height));
  return res;
};
return 'ok';`;

module.exports = async ({ ev, send, sleep, until, shot, dark, motion, errors }) => {
  const j = (x) => JSON.stringify(x);
  const take = async (label) => { const r = await ev('return __take()'); console.log(`\n## ${label}\n` + j(r)); return r; };
  const even = async (label) => { const r = await ev('return __even()'); console.log(`EVEN ${label}: ` + j(r)); };
  const idle = async (label) => { await sleep(1200); const r = await ev('return { running: __running(), stuck: __stuck() }'); console.log(`IDLE ${label}: ` + j(r)); };
  const mouse = async (sel, type = 'mouseMoved', i = 0) => { const r = await ev(`const e=document.querySelectorAll(${j(sel)})[${i}]; if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}`); if (!r) { console.log('no element', sel); return false; } await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }); return r; };
  const click = async (sel, i = 0) => { if (!(await mouse(sel, 'mouseMoved', i))) return false; await mouse(sel, 'mousePressed', i); await mouse(sel, 'mouseReleased', i); return true; };
  const key = async (k, mods = 0, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || ('Key' + k.toUpperCase()), modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : (k === 'Escape' ? 27 : 0) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || ('Key' + k.toUpperCase()), modifiers: mods }); };
  const MOD = process.platform === 'darwin' ? 4 : 2; // meta : ctrl

  console.log(await ev(INSTR));
  await idle('home first draw'); await even('home 1440'); await take('home settle');

  // ---- ask a question and watch the stream
  await ev(`const ta=document.querySelector('.ask'); ta.value='Does remote work affect employee wellbeing and productivity?'; ta.dispatchEvent(new Event('input')); return true`);
  await click('.send');
  const t0 = Date.now(); let maxGap = 0; let lastBottom = true; let unstuck = 0;
  while (Date.now() - t0 < 60000) {
    const s = await ev(`const m=document.querySelector('.main'); return {busy: !!document.querySelector('.send.stop'), gap: m ? m.scrollHeight - m.clientHeight - m.scrollTop : 0, h: m && m.scrollHeight}`);
    if (s.gap > 40 && s.h > 1000) unstuck++;
    maxGap = Math.max(maxGap, s.gap);
    if (!s.busy && Date.now() - t0 > 1500) break;
    await sleep(120);
  }
  console.log(`stream: ${Date.now() - t0}ms, distance from end max=${Math.round(maxGap)} samples-away=${unstuck}`);
  await take('streaming answer');
  await idle('thread after answer'); await even('thread 1440'); await shot('thread-light');

  // ---- hover a citation stamp, then leave: the claim highlighter sweeps in and out
  await mouse('.answer .cite'); await sleep(80);
  const lit1 = await ev(`return [...document.querySelectorAll('.claim.lit')].length`);
  await sleep(500); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(30);
  const t1 = performance.now(); let clearMs = null;
  for (let i = 0; i < 40; i++) { const n = await ev(`return document.querySelectorAll('.claim.lit').length`); if (!n) { clearMs = Math.round(performance.now() - t1); break; } await sleep(15); }
  console.log(`cite hover: lit=${lit1}, cleared after ~${clearMs}ms`);
  // sweep across several stamps quickly: count lit toggles (flicker = off then on for the same claim)
  await ev(`window.__flips=0; window.__mo=new MutationObserver(ms=>ms.forEach(m=>{ if(m.target.classList && m.target.classList.contains('claim')) __flips++; })); __mo.observe(document.querySelector('.answer'),{attributes:true,subtree:true,attributeFilter:['class']}); return 1`);
  const nCites = await ev(`return document.querySelectorAll('.answer .cite').length`);
  for (let i = 0; i < Math.min(nCites, 8); i++) { await mouse('.answer .cite', 'mouseMoved', i); await sleep(60); }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(400);
  console.log(`claim class changes over ${Math.min(nCites, 8)} stamps: ` + await ev(`__mo.disconnect(); return __flips`));
  await take('cite hovers');

  // ---- stamp click: paper flashes in the references panel
  await click('.answer .cite'); await sleep(700); await take('stamp click'); await idle('after stamp click');

  // ---- fold arrows
  const folds = await ev(`return document.querySelectorAll('.fold').length`);
  if (folds) { const y0 = await ev(`return document.querySelector('.main').scrollTop`); await click('.fold'); await sleep(500); await click('.fold'); await sleep(500); console.log(`folds=${folds} scrollTop ${y0} -> ` + await ev(`return document.querySelector('.main').scrollTop`)); await take('fold twice'); }

  // ---- references panel toggle
  await click('.references-toggle'); await sleep(600); await take('references toggle 1'); await click('.references-toggle'); await sleep(600); await take('references toggle 2'); await idle('after refs');

  // ---- a picker menu (the effort / model picker in the composer, or any picker on screen)
  const pk = await ev(`return document.querySelectorAll('.picker-btn').length`);
  if (pk) { await click('.picker-btn'); await sleep(350); await key('Escape', 0, 'Escape'); await sleep(350); await take('picker open/close'); await idle('after picker'); }

  // ---- composer menu (the + / engine menu), if present
  if (await ev(`return !!document.querySelector('.composer .model-btn, .composer .icon-round')`)) { await click('.composer .model-btn, .composer .icon-round'); await sleep(350); await even('composer menu open'); await key('Escape', 0, 'Escape'); await sleep(350); await take('composer menu'); await idle('after composer menu'); }

  // ---- rail hover glide across history items
  const hist = await ev(`return document.querySelectorAll('.history li').length`);
  for (let i = 0; i < hist; i++) { await mouse('.history-item', 'mouseMoved', i); await sleep(80); }
  await take('history glide');

  // ---- settings dialog
  await click('.rail-foot .rail-link:not(.engine-pill)'); await sleep(600); await even('settings dialog'); await shot('settings');
  await take('settings open');
  await key('Escape', 0, 'Escape'); await sleep(500); await take('settings close'); await idle('after settings');

  // ---- library and its tabs; AI score; new question
  await key('l', MOD); await sleep(700); await even('library'); await shot('library');
  for (const tab of [1, 2, 0]) { await click('.lib-tab', tab); await sleep(400); }
  await take('library tabs'); await idle('library');
  await key('k', MOD); await sleep(800); await even('score'); await shot('score'); await take('score open'); await idle('score');
  const tools = await ev(`return document.querySelectorAll('.chk-tool, [role=tab].chk-tab, .chk-tools button').length`);
  console.log('score tool buttons', tools);
  await key('n', MOD); await sleep(800); await take('new question'); await idle('home again');

  // ---- dark, 390px, reduce motion
  await dark(true); await ev(`document.querySelector('.history-item')?.click(); return 1`); await sleep(1200); await shot('thread-dark'); await even('thread dark'); await take('dark');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(800); await even('thread 390'); await shot('thread-390');
  await key('k', MOD); await sleep(800); await even('score 390'); await shot('score-390');
  await key('l', MOD); await sleep(800); await even('library 390'); await shot('library-390');
  await send('Emulation.clearDeviceMetricsOverride'); await dark(false);
  await motion('reduce'); await ev(`document.querySelector('.history-item')?.click(); return 1`); await sleep(900);
  await click('.references-toggle'); await sleep(300); await click('.rail-foot .rail-link:not(.engine-pill)'); await sleep(300); await even('reduce settings'); await key('Escape', 0, 'Escape'); await sleep(300);
  await take('reduce motion pass'); console.log('running under reduce: ' + j(await ev('return __running()')));
  console.log('errors so far: ' + j(errors));
};
