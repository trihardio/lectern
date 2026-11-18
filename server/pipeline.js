'use strict';
// What happens when you ask a question:
//   1. plan    – a small model turns the question into database search queries
//   2. search  – the queries go to the paper databases; results are merged and ranked
//   3. write   – the chosen model answers from the abstracts, citing by number,
//                while the small model reads each abstract for its finding and stance
// Papers and links come from the databases, never from the model, so a citation
// can't point at a paper that doesn't exist.
//
// The research tools (server/modes.js) change only how the papers are found and what the
// model is asked to write; see PREPARE below. The write step is shared.

const llm = require('./llm');
const Evidence = require('../shared/evidence');
const prompts = require('./prompts');
const { searchAll, gather, merge, rank, enrich, paperId } = require('./sources');
const trail = require('./sources/trail');
const figureSource = require('./sources/figures');
const { describe: describeFilters } = require('./filters');
const { modeOf } = require('./modes');
const { pathTo } = require('./store');
const { extractJson, clip, urlKey } = require('./util');

const STOPWORDS = new Set('a an and are as at be by can could did do does for from has have how in is it its of on or should than that the their there these this to was were what when where which who why will with would about into between among effect effects impact affect'.split(' '));

/** The question's content words, lower case, without filler words. Letters of any script count (not only a-z). */
function contentWords(question) {
  return String(question).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
}

function keywords(question) {
  const words = contentWords(question);
  return words.slice(0, 9).join(' ') || String(question).slice(0, 80);
}

/**
 * Words that belong to the way a question is asked, not to its topic. On the dev questions of bench/search
 * (agent A's miss analysis, 2026-11-18) most gold papers that a keyword query missed lacked such words
 * ("accurate", "good", "say", "people", "makes", "new", "check", "support"); OpenAlex needs every query word.
 * Used only for the no-model fallback: keywords() keeps its own shorter list so that the recorded baseline stays comparable.
 * Topic words that can also be filler ("work", "higher") are left in on purpose.
 */
const QUESTION_FILLER = new Set(('well good better best accurate accurately say says said makes make made people research researchers study studies paper papers ' +
  'improve improves improved effective effectively effectiveness new check checks support supports first which whom some any most many much more less ' +
  'you your we our me my suggest suggests provide reference references discuss discusses discussed find finding looking look interested specific specifically ' +
  'focus focusing focused context realm idea particular regarding related relating article articles literature like need know tell explain list summarise summarize ' +
  'evidence exist exists available currently also very not no if whether because using use used versus vs').split(' '));

/**
 * The queries used when no model plan is available. OpenAlex requires every word of a query
 * to be present (checked 2026-11-18: an 8-word query matched 2,189 works, the first 3 words
 * 441,342), so one long query is a single point of failure. The first query keeps the first six
 * content words; the second keeps only the three longest words, which are usually the most
 * specific terms, and is added only when the question is long enough to make it different.
 */
function fallbackQueries(question) {
  // Hyphens become spaces first, so "first-time" counts as the two words OpenAlex will see.
  const words = contentWords(question).flatMap((w) => w.split('-')).filter((w) => w.length > 1 && !STOPWORDS.has(w) && !QUESTION_FILLER.has(w));
  if (!words.length) return [cleanQuery(String(question).slice(0, 80))].filter(Boolean);
  const first = words.slice(0, 6);
  const out = [first.join(' ')];
  if (words.length >= 5) {
    const longest = new Set([...words].sort((a, b) => b.length - a.length).slice(0, 3));
    const core = words.filter((w) => longest.has(w)).slice(0, 3);
    out.push(core.join(' '));
  }
  return dedupeQueries(out.map(cleanQuery));
}

/**
 * True for a question that can be answered yes or no. A polite request ("Can you explain ...")
 * and a choice ("Does X raise or lower Y?") start like a yes/no question but are not one: a
 * yes/no question makes the reading pass sort every paper into for or against.
 */
function looksYesNo(question) {
  const q = String(question || '');
  if (!/^\s*(does|do|is|are|can|could|should|will|would|has|have|did|was|were)\b/i.test(q)) return false;
  if (/^\s*(can|could|would|will)\s+(you|we|i)\b/i.test(q)) return false;
  if (/\bor\b/i.test(q.replace(/\bwhether or not\b/ig, ''))) return false;
  return true;
}

/** Most words one query may keep. Every word must match on OpenAlex, so extra words only remove papers. */
const MAX_QUERY_WORDS = 8;

/**
 * Makes one planned query safe for all three databases: plain words only. Semantic Scholar's
 * relevance search has no query syntax and finds nothing for a hyphenated term, so hyphens and every
 * other mark become spaces; the possessive 's is dropped; AND/OR/NOT would be read as operators by OpenAlex.
 */
function cleanQuery(q) {
  return String(q || '')
    .replace(/['’]s\b/gi, '')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, MAX_QUERY_WORDS).join(' ')
    .slice(0, 140).trim();
}

/** Drops queries that repeat another one, including the same words in a different order. */
function dedupeQueries(queries) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const key = q.toLowerCase().split(' ').sort().join(' ');
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Reads the planner's reply. The prompt asks for {"queries": [...], "yes_no": bool, "topic": "..."},
 * but a small model sometimes sends the queries as one string, as a bare array or as objects.
 * Returns { queries (cleaned, de-duplicated, at most max), yesNo (true, false or null when not stated), topic }.
 */
function parsePlan(text, max = 4) {
  const json = extractJson(text);
  let raw = json && json.queries;
  if (typeof raw === 'string') raw = raw.split(/\n|;|\|/);
  if (!Array.isArray(raw)) {
    const arr = String(text || '').match(/\[[^\[\]]*\]/);
    try { raw = arr ? JSON.parse(arr[0]) : []; } catch { raw = []; }
  }
  const items = Array.isArray(raw) ? raw : [];
  const queries = dedupeQueries(items.map((x) => cleanQuery(x && typeof x === 'object' ? x.query : x)).filter((q) => q.length > 2)).slice(0, max);
  return {
    queries,
    yesNo: json && typeof json.yes_no === 'boolean' ? json.yes_no : null,
    topic: clip(json && typeof json.topic === 'string' ? json.topic : '', 60),
  };
}

/** Step 1. Never throws: if the model is unavailable, fall back to plain keywords. */
async function planQueries({ engine, settings, question, history, signal, system = prompts.PLAN_SYSTEM, max = 4 }) {
  const fallback = { queries: fallbackQueries(question), yesNo: looksYesNo(question), topic: '', planned: false };
  try {
    const out = await llm.complete({
      engine, role: 'helper', settings, signal,
      system: system + (system === prompts.PLAN_SYSTEM ? prompts.EVIDENCE_PLANNING_ADDENDUM : '') + prompts.planAudience(settings.profile),
      prompt: prompts.planPrompt(question, history),
    });
    const plan = parsePlan(out.text, max);
    if (!plan.queries.length) return fallback;
    return { queries: plan.queries, yesNo: plan.yesNo === true || looksYesNo(question), topic: plan.topic, planned: true, usage: out.usage };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return { ...fallback, error: e.message };
  }
}

/** Step 3b. Per-paper finding, design and stance. Returns [] on any failure. */
async function readPapers({ engine, settings, question, papers, yesNo, signal }) {
  const out = await llm.complete({
    engine, role: 'helper', settings, signal,
    system: prompts.INSIGHTS_SYSTEM + prompts.EVIDENCE_READING_ADDENDUM,
    prompt: prompts.insightsPrompt(question, papers, yesNo),
  });
  const json = extractJson(out.text);
  return Evidence.cleanInsights(json, papers, { yesNo });
}

/** Tools whose answer is about findings, so a figure of results can help. */
const FIGURE_MODES = new Set(['answer', 'review', 'claim', 'trail']);

/**
 * Figures from the open-access papers among the answer's papers, at most two, chosen by the
 * helper model by id. Returns [] on any failure: the answer stands without figures.
 */
async function findFigures({ engine, settings, question, papers, signal }) {
  const candidates = await figureSource.candidates(papers, { signal });
  if (!candidates.length) return [];
  const out = await llm.complete({
    engine, role: 'helper', settings, signal,
    system: prompts.FIGURES_SYSTEM,
    prompt: prompts.figuresPrompt(question, candidates),
  });
  const json = extractJson(out.text);
  const picks = (json && Array.isArray(json.figures)) ? json.figures : [];
  const chosen = [];
  for (const pick of picks) {
    const fig = candidates.find((f) => pick && f.id === String(pick.id));
    if (!fig || chosen.some((c) => c.id === fig.id)) continue;
    chosen.push({
      n: fig.n, pmcid: fig.pmcid, label: fig.label, title: fig.title, caption: fig.caption,
      license: fig.license, img: fig.img, page: fig.page, id: fig.id,
      read: figureSource.groundedRead(pick.read, fig),
    });
    if (chosen.length === 2) break;
  }
  return chosen;
}

function noPapersMessage(sourceReports) {
  const failed = sourceReports.filter((s) => s.error);
  let msg = 'No papers came back for this question.';
  if (failed.length) {
    msg += '\n\n' + failed.map((s) => `- **${s.label}**: ${s.error}`).join('\n');
    msg += '\n\nCheck your connection and the paper sources in Settings, then ask again.';
  } else {
    msg += ' Try broader wording, or loosen the filters (year range, open access, minimum citations).';
  }
  return msg;
}

// ---------------------------------------------------------------------------------------
// Finding the papers. One function per tool. Each receives the same context and returns
//   { papers, system, prompt, readQuestion, yesNo, empty }
// readQuestion is what the reading pass judges each abstract against (null = skip it).
// empty, when set, is shown instead of calling the model: there is nothing to write from.

/** How many papers the wider tools read: about twice a normal answer, within what a prompt can hold. */
const widePapers = (settings) => Math.min(40, Math.max(24, settings.maxPapers * 2));

async function searchStep(c, plan, max) {
  c.emit('plan', { queries: plan.queries, yesNo: plan.yesNo, topic: plan.topic, planned: plan.planned });
  c.turn.queries = plan.queries;
  c.emit('stage', { id: 'search' });
  // The student's own words go along with the planned queries, so ranking can score each paper against both.
  // A follow-up ("and in schools?") leans on earlier questions, so ranking is told when the question is one.
  const found = await gather({
    queries: plan.queries, question: c.question, followUp: !!(c.history && c.history.length),
    filters: c.filters, settings: c.settings, signal: c.signal, onSource: c.onSource, max,
  });
  found.notices.forEach(c.note);
  return found;
}

const PREPARE = {
  async answer(c) {
    c.emit('stage', { id: 'plan' });
    const plan = await planQueries({ engine: c.engine, settings: c.settings, question: c.question, history: c.history, signal: c.signal });
    const { papers } = await searchStep(c, plan, c.settings.maxPapers);
    return {
      papers, yesNo: plan.yesNo, readQuestion: c.question,
      // The table rule depends on whether the window will build its own study table from the reading pass.
      system: prompts.answerSystem({ profile: c.settings.profile, readingOn: !!c.settings.insights }),
      prompt: prompts.answerPrompt(c.question, papers, c.history),
    };
  },

  async review(c) {
    c.emit('stage', { id: 'plan' });
    const plan = await planQueries({ engine: c.engine, settings: c.settings, question: c.question, history: c.history, signal: c.signal, system: prompts.REVIEW_PLAN_SYSTEM, max: 6 });
    const { papers, found } = await searchStep(c, plan, widePapers(c.settings));
    const record = prompts.searchRecord({ queries: plan.queries, sources: c.turn.sources, found, kept: papers.length, filterText: describeFilters(c.filters) });
    return {
      papers, yesNo: false, readQuestion: c.question,
      system: prompts.REVIEW_SYSTEM + prompts.answerAudience(c.settings.profile),
      prompt: prompts.reviewPrompt(c.question, papers, c.history, record),
    };
  },

  async claim(c) {
    c.emit('stage', { id: 'plan' });
    const plan = await planQueries({ engine: c.engine, settings: c.settings, question: c.question, history: [], signal: c.signal, system: prompts.CLAIM_PLAN_SYSTEM, max: 4 });
    plan.yesNo = true; // every paper is judged for or against the statement
    const { papers } = await searchStep(c, plan, c.settings.maxPapers);
    return {
      papers, yesNo: true, readQuestion: prompts.claimQuestion(c.question),
      system: prompts.CLAIM_SYSTEM + prompts.answerAudience(c.settings.profile),
      prompt: prompts.claimPrompt(c.question, papers),
    };
  },

  async trail(c) {
    const opts = { settings: c.settings, signal: c.signal };
    c.emit('stage', { id: 'plan' });
    const { seeds, missing } = await trail.findSeeds(c.question, opts);
    if (!seeds.length) throw new Error('Lectern could not find that paper in OpenAlex. Paste its DOI or its full title, one paper per line.');
    if (missing.length) c.note(`Not found, so left out: ${missing.map((m) => `"${clip(m, 80)}"`).join(', ')}`);
    const titles = seeds.map((p) => clip(p.title, 120));
    c.emit('plan', { queries: titles, yesNo: false, topic: '', planned: true });
    c.turn.queries = titles;

    c.emit('stage', { id: 'search' });
    const all = merge(await trail.trace(seeds, { ...opts, filters: c.filters }));
    c.onSource({ name: 'openalex', label: 'OpenAlex', count: all.length, error: null, needsKey: false });
    const problem = await enrich(all, { ...opts, filters: c.filters });
    if (problem) c.note(`Some linked papers could not be checked against the selected filters and were left out. ${problem}`);
    if (describeFilters(c.filters)) c.note('Filters apply to linked papers. Starting papers are kept for context.');
    // A starting paper can also sit in another starting paper's references: keep it once, as a seed.
    const seedPapers = seeds.map((p) => ({ ...p, rel: ['seed'], score: 1 }));
    const isSeed = (p) => seedPapers.find((sp) => sp.oaId === p.oaId);
    for (const p of all) { const sp = isSeed(p); if (sp) for (const r of p.rel) if (!sp.rel.includes(r)) sp.rel.push(r); }
    const linked = rank(all.filter((p) => !isSeed(p)), { filters: c.filters, max: widePapers(c.settings) - seedPapers.length });
    const papers = [...seedPapers, ...linked].map((p, i) => ({ ...p, id: paperId(p), n: i + 1 }));
    return {
      papers, yesNo: false,
      readQuestion: `What does each paper contribute to the line of research around: ${titles.join('; ')}?`,
      system: prompts.TRAIL_SYSTEM + prompts.answerAudience(c.settings.profile),
      prompt: prompts.trailPrompt(papers),
      empty: linked.length ? null : `OpenAlex lists no references and no citing papers for ${titles.map((t) => `"${t}"`).join(', ')}${describeFilters(c.filters) ? ' with these filters. Loosen the filters and try again.' : '.'}`,
    };
  },

  async verify(c) {
    c.emit('stage', { id: 'plan' });
    if (describeFilters(c.filters)) c.note('Search filters are not used for citation verification: every cited paper is checked regardless of its date, journal or access status.');
    const out = await llm.complete({
      engine: c.engine, role: 'helper', settings: c.settings, signal: c.signal,
      system: prompts.EXTRACT_SYSTEM, prompt: c.question,
    });
    const json = extractJson(out.text);
    const items = ((json && Array.isArray(json.items)) ? json.items : [])
      .filter((it) => it && typeof it.claim === 'string' && it.claim.trim() && typeof it.citation === 'string' && it.citation.trim())
      .slice(0, 12)
      .map((it) => ({
        claim: clip(it.claim.trim(), 400),
        citation: clip(it.citation.trim(), 200),
        authors: (Array.isArray(it.authors) ? it.authors : []).map((a) => clip(String(a), 60)).slice(0, 6),
        year: Number(it.year) || null,
        title: clip(String(it.title || ''), 300),
        doi: String(it.doi || ''),
        keywords: cleanQuery(it.keywords),
      }));
    const queries = items.map((it) => it.citation);
    c.emit('plan', { queries, yesNo: false, topic: '', planned: true });
    c.turn.queries = queries;
    if (!items.length) {
      return { papers: [], empty: 'Lectern found no citations in that text. Paste a paragraph that cites its sources, such as "Remote work raised output (Bloom et al., 2015)", with the reference list if you have it.' };
    }

    c.emit('stage', { id: 'search' });
    // Look each citation up with the normal database search, then report each database once.
    const tally = new Map();
    const search = async (q) => merge(await searchAll({
      queries: [q], filters: {}, settings: c.settings, signal: c.signal,
      onSource: (r) => {
        const t = tally.get(r.name) || { name: r.name, label: r.label, count: 0, error: null, needsKey: false };
        t.count += r.count; t.error = t.error || r.error; t.needsKey = t.needsKey || r.needsKey;
        tally.set(r.name, t);
      },
    })).sort((a, b) => b.score - a.score);
    const papers = [];
    for (let i = 0; i < items.length; i += 3) {
      await Promise.all(items.slice(i, i + 3).map(async (it) => {
        const hit = await trail.resolve(it, { search, settings: c.settings, signal: c.signal });
        it.how = hit.how;
        it.paper = hit.paper;
      }));
    }
    for (const it of items) { // number the papers in the order their claims appear
      if (!it.paper) continue;
      const id = paperId(it.paper);
      let p = papers.find((x) => x.id === id);
      if (!p) { p = { ...it.paper, id, n: papers.length + 1, score: Number((it.paper.score || 0).toFixed(5)) }; papers.push(p); }
      it.n = p.n;
    }
    [...tally.values()].forEach(c.onSource);
    const lost = items.filter((it) => !it.n);
    if (lost.length) c.note(`${lost.length} of ${items.length} citations could not be matched to a database record: ${lost.map((it) => it.citation).join(', ')}`);
    return {
      papers, yesNo: false, readQuestion: null,
      system: prompts.VERIFY_SYSTEM,
      prompt: prompts.verifyPrompt(items, papers),
      empty: papers.length ? null : `None of the ${items.length} citations could be matched to a record in the paper databases: ${items.map((it) => it.citation).join(', ')}. Paste the reference list too, so Lectern can search by title or DOI.`,
    };
  },
};

/**
 * Run one request end to end. `emit(event, data)` streams progress to the window.
 * `mode` picks the tool (server/modes.js). Returns the saved thread.
 */
async function runAsk({ question, mode = 'answer', threadId, parentId, filters = {}, overrides = {}, config, store, signal, emit }) {
  const settings = config.get();
  if (typeof overrides.model === 'string' && overrides.engine) settings.models[overrides.engine] = overrides.model;
  const engine = await llm.pickEngine(settings, overrides.engine);
  if (!engine) throw new Error('No model is connected yet. Sign in to Claude or ChatGPT on this computer, or add a Gemini API key in Settings, then try again.');
  const effort = overrides.effort || settings.effort;
  const web = overrides.web != null ? !!overrides.web : settings.web;
  const model = settings.models[engine] || '';
  mode = modeOf(mode).id;

  // parentId: undefined = follow on from the branch on screen; null = a new first question
  // (an edit of the opening question); otherwise the turn this question follows.
  const thread = threadId ? store.getThread(threadId) : null;
  if (threadId && !thread) throw new Error('That chat no longer exists. Reload the window.');
  if (thread && parentId && !thread.turns.some((t) => t.id === parentId)) throw new Error('That earlier question no longer exists. Reload the chat.');
  // The turn this answer follows is fixed now, once: the branch on screen can change while the answer is
  // written (another version shown, another answer saved), and the answer belongs where it was asked.
  const parent = parentId === undefined ? (thread ? thread.leaf : null) : parentId;
  const before = thread ? pathTo(thread, parent) : [];
  const history = before.slice(-3).map((t) => ({ question: clip(t.question, 600), answer: t.answer }));

  emit('meta', { engine, model, effort, web, mode });

  const turn = {
    question, mode, filters, engine, model, effort, web,
    queries: [], yesNo: false, sources: [],
    papers: [], answer: '', thinking: '', insights: [], figures: [], webSources: [], notices: [], usage: null,
  };
  const note = (text) => { turn.notices.push(text); emit('notice', { text }); };
  const onSource = (s) => { turn.sources.push(s); emit('source', s); };

  // 1 and 2. plan and search, in the way this tool needs
  const job = await PREPARE[mode]({ question, history, filters, settings, engine, signal, emit, turn, note, onSource });
  const papers = job.papers;
  turn.papers = papers;
  turn.yesNo = !!job.yesNo;
  emit('papers', { papers });

  if (!papers.length || job.empty) {
    turn.answer = job.empty || noPapersMessage(turn.sources);
    emit('delta', { text: turn.answer });
  } else {
    // 3. write the answer and read the papers, side by side
    emit('stage', { id: 'write' });
    const helperAbort = new AbortController();
    const helperSignal = signal ? AbortSignal.any([signal, helperAbort.signal]) : helperAbort.signal;

    let readingDone = false;
    const insightsP = settings.insights && job.readQuestion
      ? readPapers({ engine, settings, question: job.readQuestion, papers, yesNo: turn.yesNo, signal: helperSignal })
        .then((rows) => {
          turn.insights = rows; emit('insights', { insights: rows });
          if (!rows.length) note('The abstract-reading pass returned no usable study details. The answer is available; retry to build the evidence views.');
        })
        .catch((e) => {
          if (!helperSignal.aborted) note(`Study details could not be extracted: ${clip(e.message || 'reading failed', 180)}. The answer is available without the evidence views.`);
        })
        .finally(() => { readingDone = true; })
      : Promise.resolve();

    // Figures from the open-access papers, looked for while the answer is written.
    const figuresP = settings.figures !== false && FIGURE_MODES.has(mode)
      ? findFigures({ engine, settings, question: job.readQuestion || question, papers, signal: helperSignal })
        .then((figures) => { if (figures.length) { turn.figures = figures; emit('figures', { figures }); } })
        .catch(() => { /* no figures: the answer and the evidence views still stand */ })
      : Promise.resolve();

    // Each tool's system prompt is complete as PREPARE built it (the answer's table rule already reflects the
    // reading pass). Both engines run a signed-in CLI, which cites web pages as markdown links (read back below).
    const system = job.system + (web ? prompts.WEB_ADDENDUM_LINKS : '');
    const addWebSource = (url, title) => {
      let i = turn.webSources.findIndex((w) => w.url === url);
      if (i === -1) { turn.webSources.push({ url, title }); i = turn.webSources.length - 1; emit('websource', { n: i + 1, url, title }); }
      return i + 1;
    };

    let out;
    try {
      out = await llm.complete({
        engine, role: 'main', settings, effort, web, signal, system,
        prompt: job.prompt,
        onEvent: (ev) => {
          if (ev.type === 'delta') { turn.answer += ev.text; emit('delta', { text: ev.text }); }
          else if (ev.type === 'thinking') { turn.thinking += ev.text; emit('thinking', { text: ev.text }); }
          else if (ev.type === 'status') emit('status', { text: ev.text });
          else if (ev.type === 'notice') note(ev.text);
          else if (ev.type === 'websource') {
            const n = addWebSource(ev.url, ev.title);
            if (ev.inline) { const mark = ` [W${n}]`; turn.answer += mark; emit('delta', { text: mark }); }
          }
        },
      });
      turn.usage = out.usage;
    } catch (e) {
      helperAbort.abort();
      throw e;
    }

    // Web pages cited as markdown links (the CLI engines) belong in the source list only when the web tools really
    // returned that page in this run (out.webResults). A link the model wrote from memory is not a source, and the
    // window shows it as plain text (ui/render.js links only the turn's web sources).
    if (web) {
      const found = new Map();
      for (const w of (out && out.webResults) || []) if (w && w.url && !found.has(urlKey(w.url))) found.set(urlKey(w.url), w);
      const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
      let m;
      while ((m = re.exec(turn.answer))) {
        const hit = found.get(urlKey(m[2]));
        if (hit) addWebSource(hit.url, hit.title || clip(m[1], 300));
      }
    }

    // The answer is already visible. Structured excerpts need longer than the old short reading.
    if (settings.insights && job.readQuestion && !readingDone) emit('status', { text: 'Extracting study comparisons and evidence coverage' });
    let waitTimer;
    await Promise.race([Promise.all([insightsP, figuresP]), new Promise((r) => { waitTimer = setTimeout(r, 120000); })]);
    if (settings.insights && job.readQuestion && !readingDone) note('Study-detail extraction reached its time limit. The answer was saved; retry to build the comparison and coverage views.');
    clearTimeout(waitTimer);
    helperAbort.abort();
  }

  turn.thinking = clip(turn.thinking, 20000);
  const saved = store.saveTurn(threadId, turn, parent);
  const savedTurn = saved.turns[saved.turns.length - 1];
  emit('done', { threadId: saved.id, turnId: savedTurn.id, parent: savedTurn.parent, title: saved.title, usage: turn.usage });
  return saved;
}

module.exports = { runAsk, planQueries, readPapers, findFigures, keywords, looksYesNo, cleanQuery, parsePlan, fallbackQueries };
