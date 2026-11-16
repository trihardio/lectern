'use strict';
// Drives Lectern's window in headless Chrome so a UI change can be MEASURED and SEEN, not guessed.
// Not part of `npm test`, not shipped in the app (the packager ignores scripts/).
//
//   node scripts/ui-check.js --steps my-steps.js [--out <dir>] [--mock] [--ask "question"] [--no-ask] [--port 4500]
//
//   --mock      replace fetch with the test fixtures (offline, instant). Without it the real paper databases are used
//               (the model is still the fake CLI in test/fakes, so no plan usage).
//   --ask       the question to run before the steps (default: a remote-work question). --no-ask starts on the home page.
//   --steps     a module exporting async ({ ev, send, sleep, until, shot, clip, dark, motion, errors, OUT, port, fs, path }) => {...}
//   --settings  a JSON file merged into the scratch settings (for example saved keys).
//
// Needs Node 22+ (global WebSocket) and Google Chrome (set CHROME=/path/to/chrome elsewhere than the macOS default).
// Everything runs in a scratch folder (default: the OS temp dir); your real Lectern data is never touched.
//
// In a steps file:
//   await ev(`return document.querySelector('.x').getBoundingClientRect().height`)  // run code in the page, get the value
//   await clip('name', '.selector', 8)                                              // a 2x screenshot of one element
//   await shot('name')                                                              // a screenshot of the window
//   await dark(true); await motion('reduce')                                        // prefers-color-scheme / reduced-motion
//   await send('Input.dispatchMouseEvent', {...})                                   // real mouse and key events (CDP)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), `lectern-ui-check-${process.pid}`)));
const PORT = Number(arg('port', 4500 + Math.floor(Math.random() * 300)));
const CDP = PORT + 4000;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stepsFile = arg('steps', null);
  if (!stepsFile || stepsFile === true) { console.error('Give --steps <file>. See the top of scripts/ui-check.js.'); process.exit(2); }
  if (typeof WebSocket === 'undefined') { console.error('Node 22 or newer is needed (global WebSocket).'); process.exit(2); }
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const settings = {
    bins: { claude: path.join(ROOT, 'test', 'fakes', 'claude'), codex: '/nonexistent/bin' },
    sources: { openalex: true, semanticscholar: true, crossref: true, europepmc: true },
    profile: { asked: true }, insights: true, figures: true,
  };
  const extra = arg('settings', null);
  if (extra && extra !== true) Object.assign(settings, JSON.parse(fs.readFileSync(extra, 'utf8')));
  fs.writeFileSync(path.join(OUT, 'data', 'settings.json'), JSON.stringify(settings));

  const serverArgs = arg('mock', false) ? ['-r', './test/mock-fetch.js', 'server/start.js'] : ['server/start.js'];
  const server = spawn(process.execPath, serverArgs, { cwd: ROOT, env: { ...process.env, LECTERN_DATA_DIR: path.join(OUT, 'data'), LECTERN_PORT: String(PORT), LECTERN_NO_OPEN: '1' }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(OUT, 'chrome')}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ } }
    if (!target) throw new Error('Chrome did not start. Set CHROME=/path/to/chrome.');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    };
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (code) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed');
      return r.result.result.value;
    };
    const until = async (cond, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`return !!(${cond})`)) return true; await sleep(200); } return false; };
    const save = (name, b64) => fs.writeFileSync(path.join(OUT, 'shots', `${name}.png`), Buffer.from(b64, 'base64'));
    const shot = async (name) => save(name, (await send('Page.captureScreenshot', { format: 'png' })).result.data);
    const clip = async (name, selector, pad = 0) => {
      const r = await ev(`const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}`);
      if (!r) { console.log(`clip ${name}: no element for ${selector}`); return; }
      save(name, (await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2, scale: 2 } })).result.data);
    };
    let scheme = 'light'; let reduced = 'no-preference';
    const media = () => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: reduced }] });
    const dark = async (on) => { scheme = on ? 'dark' : 'light'; await media(); };
    const motion = async (value) => { reduced = value; await media(); };

    await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await media();
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* not up yet */ } await sleep(250); }
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    if (!(await until(`document.querySelector('.ask')`, 15000))) throw new Error('The window did not draw the ask box.');
    await sleep(500);

    if (!arg('no-ask', false)) {
      const question = arg('ask', 'Does remote work affect employee wellbeing and productivity?');
      await ev(`const ta=document.querySelector('.ask'); ta.value=${JSON.stringify(String(question))}; ta.dispatchEvent(new Event('input')); document.querySelector('.send').click(); return true`);
      const done = await until(`!document.querySelector('.send.stop') && document.querySelector('.turn') && !document.querySelector('.steps')`, arg('mock', false) ? 60000 : 150000);
      if (!done) console.log('WARNING: the answer did not finish in time.');
      await sleep(900);
    }
    const steps = require(path.resolve(stepsFile));
    await steps({ ev, send, sleep, until, shot, clip, dark, motion, errors, OUT, port: PORT, fs, path });
  } catch (e) {
    console.log('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    console.log(`page errors: ${errors.length ? errors.slice(0, 5).join(' | ') : 'none'}`);
    console.log(`screenshots: ${path.join(OUT, 'shots')}`);
    server.kill(); chrome.kill();
  }
})();
