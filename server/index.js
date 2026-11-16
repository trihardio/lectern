'use strict';
// The local server behind the window. It listens on 127.0.0.1 only, serves the interface,
// and exposes a small JSON API. Nothing here is reachable from other machines.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { Config, EFFORTS } = require('./config');
const { Store } = require('./store');
const llm = require('./llm');
const { createUsageMonitor } = require('./llm/usage');
const { runAsk } = require('./pipeline');
const { SOURCES } = require('./sources');
const { cleanFilters, options: filterOptions } = require('./filters');
const { MODES, modeOf } = require('./modes');
const Profile = require('./profile');
const { extractText } = require('./checks/extract');
const { runAiCheck } = require('./checks/aiscore');
const { runSimilarityCheck } = require('./checks/similarity');
const { runRewrite } = require('./checks/rewrite');
const { quoteAndCite } = require('./checks/citefix');

const ROOT = path.join(__dirname, '..');
const STATIC = {
  '/evidence.css': ['ui/evidence.css', 'text/css; charset=utf-8'],
  '/evidence-data.js': ['shared/evidence.js', 'text/javascript; charset=utf-8'],
  '/evidence-ui.js': ['ui/evidence.js', 'text/javascript; charset=utf-8'],
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['ui/styles.css', 'text/css; charset=utf-8'],
  '/world.css': ['ui/world.css', 'text/css; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/render.js': ['ui/render.js', 'text/javascript; charset=utf-8'],
  '/cite.js': ['shared/cite.js', 'text/javascript; charset=utf-8'],
  '/checks.js': ['ui/checks.js', 'text/javascript; charset=utf-8'],
  '/checks.css': ['ui/checks.css', 'text/css; charset=utf-8'],
};
const CSP = "default-src 'self'; img-src 'self' data: https://pmc-oa-opendata.s3.amazonaws.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * `voice` is supplied by the Mac desktop shell and owns native speech sessions.
 * `pdf` is supplied by the desktop shell: it prints the window to a PDF and asks where to save it.
 * In a plain browser the window uses the browser's own speech recognition.
 */
function createApp({ dataDir, voice, pdf } = {}) {
  const config = new Config(dataDir);
  const store = new Store(config.dataDir);
  const usage = createUsageMonitor();
  // The window receives this token inside its HTML and must send it back with every API call.
  // Another website open in a browser can reach 127.0.0.1 but cannot read the token, so it
  // cannot spend your credits or read your library.
  const token = crypto.randomBytes(24).toString('hex');
  let port = 0;

  async function publicState() {
    const settings = config.getPublic();
    const engines = await llm.engineStatus(config.get());
    const active = await llm.pickEngine(config.get());
    return {
      settings, engines, activeEngine: active, efforts: EFFORTS,
      sources: Object.values(SOURCES).map((s) => ({ name: s.name, label: s.label })),
      profileOptions: Profile.options(),
      filterOptions: filterOptions(),
      modes: MODES,
      dictation: !!voice,
      pdfExport: !!(pdf && typeof pdf.save === 'function'),
      dataDir: config.dataDir,
    };
  }

  const routes = {
    'GET /api/state': async () => publicState(),
    'GET /api/usage': async () => usage(config.get()),

    'PUT /api/settings': async (body) => { config.update(body); return publicState(); },

    'GET /api/models': async (_body, url) => {
      const engine = url.searchParams.get('engine') || '';
      return { models: await llm.listModels(engine, config.get()) };
    },

    'POST /api/test-engine': async (body) => {
      const settings = config.get();
      const engine = body.engine;
      if (body.model) settings.models[engine] = String(body.model);
      const started = Date.now();
      try {
        const out = await llm.complete({
          engine, role: 'main', settings, effort: 'low',
          system: 'Reply with exactly the word: ready',
          prompt: 'Say the word.',
          signal: AbortSignal.timeout(90000),
        });
        return { ok: true, reply: String(out.text || '').trim().slice(0, 80), ms: Date.now() - started, model: settings.models[engine] || 'default' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    'GET /api/threads': async () => ({ threads: store.listThreads() }),
    'GET /api/thread': async (_b, url) => {
      const t = store.getThread(url.searchParams.get('id'));
      if (!t) throw Object.assign(new Error('That conversation no longer exists.'), { status: 404 });
      return t;
    },
    // Rename ({ title }), show another version of an edited question ({ leaf }), keep it in the library ({ saved }).
    'PUT /api/thread': async (body) => ({
      thread: store.updateThread(body.id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        leaf: typeof body.leaf === 'string' ? body.leaf : undefined,
        saved: typeof body.saved === 'boolean' ? body.saved : undefined,
      }),
    }),
    // Keep one question in the library ({ thread, id, saved }).
    'PUT /api/turn': async (body) => {
      const turn = store.updateTurn(String(body.thread || ''), String(body.id || ''), { saved: typeof body.saved === 'boolean' ? body.saved : undefined });
      if (!turn) throw Object.assign(new Error('That conversation no longer exists.'), { status: 404 });
      return { turn };
    },
    'DELETE /api/thread': async (_b, url) => ({ ok: store.deleteThread(url.searchParams.get('id')) }),
    // Copy a conversation, up to and including one question, into a new conversation.
    'POST /api/thread/branch': async (body) => ({ thread: store.branchThread(body.id, typeof body.turnId === 'string' ? body.turnId : null) }),
    // Delete one question, its answer, and everything asked after it on that branch.
    'DELETE /api/turn': async (_b, url) => ({ thread: store.deleteTurn(url.searchParams.get('thread'), url.searchParams.get('id')) }),

    'POST /api/voice': async (body) => {
      if (!voice) return { ok: false, error: 'Native voice input needs the Mac desktop app.' };
      if (body.action === 'stop' && typeof body.id === 'string') return voice.stop(body.id);
      if (body.action === 'start') return voice.start(body.language);
      return { ok: false, error: 'Unknown voice input action.' };
    },
    'GET /api/voice': async (_body, url) => voice
      ? voice.status(url.searchParams.get('id'))
      : { ok: false, error: 'Native voice input needs the Mac desktop app.' },

    'GET /api/library': async () => ({ papers: store.getLibrary() }),
    'POST /api/library': async (body) => ({ papers: store.addToLibrary(body.paper) }),
    'DELETE /api/library': async (_b, url) => ({ papers: store.removeFromLibrary(url.searchParams.get('id')) }),

    // AI score page: save the report the window is showing as a PDF (desktop app only; a browser prints instead).
    'POST /api/checks/pdf': async (body) => {
      if (!pdf || typeof pdf.save !== 'function') return { ok: false, error: 'Saving a PDF needs the desktop app. In a browser, use Print and choose Save as PDF.' };
      const base = String(body.name || 'Lectern report').replace(/\.pdf$/i, '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim() || 'Lectern report';
      try { return await pdf.save({ name: `${base}.pdf` }); } catch (e) { return { ok: false, error: `The PDF could not be saved: ${e.message}` }; }
    },

    // AI score page: put matched passages in quotation marks and cite their sources (from the similarity result).
    'POST /api/checks/cite': async (body) => {
      const r = body.result;
      if (!r || typeof r.text !== 'string' || !Array.isArray(r.spans) || !Array.isArray(r.sources)) throw Object.assign(new Error('Run the similarity check first.'), { status: 400 });
      return quoteAndCite(String(body.text || ''), r);
    },

    // AI score page: plain text from a dropped document ({ name, data: base64 }). Nothing is stored.
    'POST /api/checks/extract': async (body) => {
      const data = Buffer.from(String(body.data || ''), 'base64');
      const { text, kind } = extractText({ name: String(body.name || '').slice(0, 200), data });
      return { text, kind, name: String(body.name || '').slice(0, 200) };
    },
  };

  async function handleAsk(req, res) {
    const body = await readBody(req);
    const mode = modeOf(body.mode).id;
    const question = String(body.question || '').trim().slice(0, modeOf(mode).maxInput);
    if (!question) return json(res, 400, { error: 'Type a question first.' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const abort = new AbortController();
    let open = true;
    res.on('close', () => { open = false; if (!res.writableEnded) abort.abort(); });
    const emit = (event, data) => { if (open && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const beat = setInterval(() => { if (open && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);

    try {
      const o = body.overrides || {};
      await runAsk({
        question,
        threadId: body.threadId || null,
        parentId: body.parentId === null || (typeof body.parentId === 'string' && /^[a-f0-9]{8,32}$/.test(body.parentId)) ? body.parentId : undefined,
        mode,
        filters: cleanFilters(body.filters),
        overrides: {
          engine: typeof o.engine === 'string' ? o.engine : undefined,
          model: typeof o.model === 'string' ? o.model.slice(0, 100) : undefined,
          effort: EFFORTS.includes(o.effort) ? o.effort : undefined,
          web: typeof o.web === 'boolean' ? o.web : undefined,
        },
        config, store, signal: abort.signal, emit,
      });
    } catch (e) {
      if (!abort.signal.aborted) emit('error', { message: e.message || 'Something went wrong.' });
    } finally {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  }

  /** AI score page: run one check and stream its progress as server-sent events. Nothing is stored. */
  async function handleCheck(req, res, kind) {
    const body = await readBody(req, 3 * 1024 * 1024);
    const text = String(body.text || '');
    if (!text.trim()) return json(res, 400, { error: 'Paste some text or drop a document first.' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const abort = new AbortController();
    let open = true;
    res.on('close', () => { open = false; if (!res.writableEnded) abort.abort(); });
    const emit = (event, data) => { if (open && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const beat = setInterval(() => { if (open && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    const engine = typeof body.engine === 'string' ? body.engine : undefined;
    try {
      const o = body.options || {};
      const result = kind === 'rewrite'
        ? await runRewrite({ text, config, signal: abort.signal, emit, engine, selectedModel: typeof body.model === 'string' ? body.model.slice(0, 100) : undefined })
        : kind === 'ai'
        ? await runAiCheck({ text, config, signal: abort.signal, emit, engine, selectedModel: typeof body.model === 'string' ? body.model.slice(0, 100) : undefined })
        : await runSimilarityCheck({
          text, config, store, signal: abort.signal, emit, engine,
          options: { quotes: o.quotes !== false, references: o.references !== false, web: o.web !== false, papers: o.papers !== false },
        });
      emit('result', result);
    } catch (e) {
      if (!abort.signal.aborted) emit('error', { message: e.message || 'Something went wrong.' });
    } finally {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // Refuse requests addressed to any other host name (blocks DNS-rebinding tricks).
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403); return res.end('Forbidden');
      }

      // The typefaces ship inside the app (ui/fonts, SIL Open Font License); names are checked
      // against a strict pattern so nothing outside that folder can be read.
      const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname);
      if (req.method === 'GET' && font) {
        let data;
        try { data = fs.readFileSync(path.join(ROOT, 'ui', 'fonts', font[1])); } catch { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        return res.end(data);
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        let content = fs.readFileSync(path.join(ROOT, file), 'utf8');
        if (url.pathname === '/') content = content.replace('__LECTERN_TOKEN__', token);
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP,
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        return res.end(content);
      }

      if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
      if (req.headers['x-lectern-token'] !== token) return json(res, 403, { error: 'This window is out of date. Reload it.' });

      if (req.method === 'POST' && url.pathname === '/api/ask') return await handleAsk(req, res);
      if (req.method === 'POST' && url.pathname === '/api/checks/ai') return await handleCheck(req, res, 'ai');
      if (req.method === 'POST' && url.pathname === '/api/checks/rewrite') return await handleCheck(req, res, 'rewrite');
      if (req.method === 'POST' && url.pathname === '/api/checks/similarity') return await handleCheck(req, res, 'similarity');

      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return json(res, 404, { error: 'Not found' });
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, url.pathname === '/api/checks/extract' ? 17 * 1024 * 1024 : url.pathname === '/api/checks/cite' ? 8 * 1024 * 1024 : undefined);
      return json(res, 200, await route(body, url));
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* socket already closed */ } return; }
      return json(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });

  return {
    config, store, server, token,
    /** Start listening. Port 0 picks any free port. Resolves the URL to open. */
    listen(wantedPort = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', () => {
          port = server.address().port;
          resolve(`http://127.0.0.1:${port}/`);
        });
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

module.exports = { createApp };
