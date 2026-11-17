'use strict';
// The Writing desk page: document text extraction, the AI-writing check and the similarity check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const mock = require('./mock-fetch');
const fx = require('./fixtures');
const { createApp } = require('../server');
const { Config } = require('../server/config');
const { Store } = require('../server/store');
const { extractText } = require('../server/checks/extract');
const T = require('../server/checks/text');
const { measure, runAiCheck } = require('../server/checks/aiscore');
const Sim = require('../server/checks/similarity');

const CLAUDE = path.join(__dirname, 'fakes', 'claude');
const CODEX = path.join(__dirname, 'fakes', 'codex');
const NO_BIN = '/nonexistent/bin';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

test('similarity: a shingle hash collision cannot manufacture matching words', () => {
  const text = 'Specific observations about migration patterns describe seasonal movement across continents and changing habitats.';
  const sub = Sim.prepareSubmission(text, {});
  const src = Sim.indexSource('Wholly different language records unrelated economics concerning trade policies across distant nations and regional markets.');
  // Deliberately collide every index key, without any common six-word phrase.
  for (const key of sub.gramAt) src.grams.set(key, [0]);
  assert.deepEqual(Sim.compare(sub, src, { skip: sub.skip }), []);
});

test('similarity: no comparison coverage produces no score, rather than zero percent', async () => {
  const { config, store } = scratchConfig({ claude: NO_BIN, codex: NO_BIN });
  const result = await Sim.runSimilarityCheck({ text: Array(30).fill('observation').join(' '), config, store, options: { web: false, papers: false } });
  assert.equal(result.score, null);
  assert.ok(result.notes.some((n) => /No sources/.test(n)));
});

test('similarity: mapped IPv6 cannot reach a private network', async () => {
  await assert.rejects(Sim.safeFetch('http://[::ffff:7f00:1]/'), /local network/);
});

/** A minimal zip archive (deflated entries), enough for .docx and .odt. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A small PDF: one page with a compressed content stream, one font with a ToUnicode map, TJ kerning. */
function makePdf() {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Working from home made staff) Tj ( more productive.) Tj 0 -14 Td [(Attri) 30 (tion) -400 (fell.)] TJ 0 -40 Td <0102> Tj ET'));
  const cmap = '/CIDInit /ProcSet findresource begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0048> <02> <0069> endbfchar endcmap';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    null,
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  objs.forEach((o, k) => {
    const n = k + 1;
    if (n === 4) parts.push(Buffer.from(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n'));
    else if (n === 6) parts.push(Buffer.from(`6 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`));
    else parts.push(Buffer.from(`${n} 0 obj\n${o}\nendobj\n`));
  });
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'));
  return Buffer.concat(parts);
}

const AI_TEXT = `In today's fast-paced world, remote work plays a crucial role in shaping the modern workplace. It is important to note that this transformative shift is not only reshaping how we work but also redefining collaboration. Furthermore, organisations must navigate the complexities of a hybrid landscape. Moreover, leveraging digital tools can foster a seamless and inclusive culture. Additionally, leaders must delve into the intricate interplay between autonomy, accountability, and wellbeing. Ultimately, remote work represents a pivotal opportunity to unlock the full potential of the workforce. In conclusion, these findings underscore the multifaceted nature of this rich tapestry of change.`;

const HUMAN_TEXT = `Bloom and his co-authors ran a nine-month trial at Ctrip, a Shanghai travel agency with about 16,000 staff. Call-centre workers who volunteered were split by the parity of their birthday: even went home, odd stayed. The home group handled 13% more calls. Why? Mostly fewer breaks and sick days, and a quieter room. But half of them asked to come back to the office afterwards, because they felt lonely. I recieve the same complaint from friends who work remotely now, which surprised me. The informations about promotions also matter: home workers were promoted less often, even though they performed better.`;

test('documents: Word, OpenDocument, PDF, web page and plain text become plain text', () => {
  const docx = makeZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Working from home</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">made staff </w:t></w:r><w:del><w:r><w:t>deleted words</w:t></w:r></w:del><w:r><w:t>13% more productive &amp; happier.</w:t></w:r></w:p></w:body></w:document>',
  });
  const d = extractText({ name: 'essay.docx', data: docx });
  assert.equal(d.kind, 'Word document');
  assert.equal(d.text, 'Working from home\n\nmade staff 13% more productive & happier.');

  const odt = makeZip({ 'mimetype': 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:document-content><text:h>Title here</text:h><text:p>First<text:s/>paragraph of the essay text.</text:p></office:document-content>' });
  assert.equal(extractText({ name: 'essay.odt', data: odt }).text, 'Title here\n\nFirst paragraph of the essay text.');

  const pdf = extractText({ name: 'essay.pdf', data: makePdf() });
  assert.equal(pdf.kind, 'PDF');
  assert.match(pdf.text, /Working from home made staff more productive\./);
  assert.match(pdf.text, /Attrition fell\./, 'small kerning joins letters; a big gap is a space');
  assert.match(pdf.text, /\n\nHi$/, 'the ToUnicode map decodes the codes, a large drop starts a paragraph');

  const html = extractText({ name: 'page.html', data: Buffer.from('<html><head><style>p{}</style><script>var x=1</script></head><body><nav>Menu</nav><p>Para one of the page &mdash; ok.</p><p>Para two here.</p></body></html>') });
  assert.equal(html.text, 'Para one of the page — ok.\n\nPara two here.');
  assert.equal(extractText({ name: 'a.txt', data: Buffer.from('﻿Plain text file with enough words.\r\n') }).text, 'Plain text file with enough words.');

  assert.throws(() => extractText({ name: 'old.doc', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) }), /Old Word files/);
  assert.throws(() => extractText({ name: 'x.pdf', data: Buffer.from('%PDF-1.4\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>') }), /password-protected/);
  assert.throws(() => extractText({ name: 'x.bin', data: Buffer.from([1, 2, 3, 4, 5, 0, 0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) }), /not supported/);
});

test('text: sentences keep exact offsets, headings stand alone, quotes from a model are found loosely', () => {
  const t = T.normalizeText('Method\nDr. Smith et al. measured 3.5 times more. It rose, e.g. in May!\n\nReferences\nSmith, J. (2020). Title.');
  const { sentences } = T.segment(t);
  for (const s of sentences) assert.equal(t.slice(s.start, s.end).replace(/\s*\n\s*/g, ' '), s.text);
  assert.deepEqual(sentences.slice(0, 3).map((s) => s.text), ['Method', 'Dr. Smith et al. measured 3.5 times more.', 'It rose, e.g. in May!']);
  assert.deepEqual(T.locate(t, 'it ROSE,  e.g.'), { start: t.indexOf('It rose'), end: t.indexOf('It rose') + 'It rose, e.g.'.length });
  assert.equal(T.locate(t, 'not there'), null);
  const ex = T.exclusions(t);
  assert.equal(ex.length, 1);
  assert.equal(t.slice(ex[0].start).trim().split('\n')[0], 'References');
});

test('AI signals: stock vocabulary, phrases and even rhythm raise the measured score; specific writing does not', () => {
  const ai = measure(AI_TEXT);
  const human = measure(HUMAN_TEXT);
  assert.ok(ai.readings.docSignal > human.readings.docSignal + 25, `${ai.readings.docSignal} vs ${human.readings.docSignal}`);
  assert.ok(ai.readings.phrasesPer1000 > 20);
  const first = ai.perSentence.get(0);
  assert.ok(first.phrases.some((p) => /fast-paced world/.test(p.word)) && first.phrases.some((p) => /crucial role/.test(p.word)));
  assert.ok(first.reasons.length >= 2);
});

function scratchConfig(bins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-checks-'));
  const config = new Config(dir);
  config.update({ keys: { openalex: 'oa' }, bins });
  return { config, store: new Store(config.dataDir) };
}

test('AI check sends the selected provider and model, and records what the provider reported', async () => {
  const { config } = scratchConfig({ claude: CLAUDE, codex: CODEX });
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-check-model-')), 'runs.jsonl');
  process.env.FAKE_LOG = log;
  try {
    const result = await runAiCheck({ text: `${AI_TEXT}\n\n${HUMAN_TEXT}`, config, engine: 'codex', selectedModel: 'gpt-6.1-sol' });
    assert.equal(result.provenance.engine, 'codex');
    assert.equal(result.provenance.requestedModel, 'gpt-6.1-sol');
    assert.deepEqual(result.provenance.reportedModels, [], 'Codex does not say which model answered, so nothing is claimed');
    assert.equal(result.provenance.modelConfirmed, false);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(runs.length && runs.every((r) => r.tool === 'codex' && r.args[r.args.indexOf('-m') + 1] === 'gpt-6.1-sol'));
    const claudeResult = await runAiCheck({ text: `${AI_TEXT}\n\n${HUMAN_TEXT}`, config, engine: 'claude-code', selectedModel: 'claude-sonnet-5-5' });
    assert.equal(claudeResult.provenance.requestedModel, 'claude-sonnet-5-5');
    assert.deepEqual(claudeResult.provenance.reportedModels, ['claude-sonnet-5-5'], 'Claude Code names its model in the stream');
    assert.equal(claudeResult.provenance.modelConfirmed, true);
    const all = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(all.some((r) => r.tool === 'claude' && r.args[r.args.indexOf('--model') + 1] === 'claude-sonnet-5-5'));
  } finally { delete process.env.FAKE_LOG; }
});

test('AI check does not silently switch providers or models', async () => {
  const { config } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  await assert.rejects(runAiCheck({ text: AI_TEXT, config, engine: 'codex', selectedModel: 'gpt-6.1-sol' }), /selected model provider is not connected/);
  // A Codex that rejects -m: the review stops with a clear reason instead of using Codex's default model.
  const { config: c2 } = scratchConfig({ claude: NO_BIN, codex: CODEX });
  process.env.FAKE_REJECT_FLAG = '-m';
  try {
    const r = await runAiCheck({ text: `${AI_TEXT}\n\n${HUMAN_TEXT}`, config: c2, engine: 'codex', selectedModel: 'gpt-6.1-sol' });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.score, null);
    assert.match(r.scoreWithheld, /rejected the model option/);
    assert.ok(r.sentences.filter((s) => s.eligible).every((s) => s.review === 'unreviewed'));
  } finally { delete process.env.FAKE_REJECT_FLAG; }
});

test('AI check: the model rating decides the band, measured signals are evidence only, suggestions are anchored', async () => {
  const { config } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  const events = [];
  const r = await runAiCheck({ text: `${AI_TEXT}\n\n${HUMAN_TEXT}`, config, emit: (e, d) => events.push([e, d]) });
  assert.equal(r.provenance.engine, 'claude-code');
  assert.equal(r.status, 'complete');
  assert.equal(r.lengthCategory, 'brief');
  assert.equal(r.validated, false);
  const aiSent = r.sentences.find((s) => s.eligible && /delve into/.test(r.text.slice(s.start, s.end)));
  const humanSent = r.sentences.find((s) => s.eligible && /Ctrip/.test(r.text.slice(s.start, s.end)));
  assert.equal(aiSent.band, 'strong');
  assert.equal(aiSent.rating, 88);
  assert.equal(humanSent.band, 'few');
  assert.ok(aiSent.why && aiSent.signals.length > 0, 'the model reason and the measured evidence are kept apart');
  assert.ok(aiSent.marks.some((m) => r.text.slice(m.start, m.end).toLowerCase() === 'delve'));
  assert.equal(r.reviewedWords, r.eligibleWords);
  const strongWords = r.sentences.filter((s) => s.band === 'strong').reduce((n, s) => n + s.words, 0);
  assert.equal(r.score, Math.round((100 * strongWords) / r.reviewedWords), 'the headline is strong words over reviewed words');
  assert.equal(Object.values(r.bands).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(r.issues.map((i) => [i.kind, r.text.slice(i.start, i.end), i.fix]), [['spelling', 'recieve', 'receive'], ['grammar', 'informations', 'information']]);
  assert.equal(r.rejectedSuggestions, 1, 'the invented quote is dropped and counted');
  assert.ok(events.some(([e, d]) => e === 'step' && d.id === 'model' && d.state === 'done'));
  assert.ok(r.limits.length >= 3 && r.limits.some((x) => /not a validated|not an AI detector/i.test(x)));
});

test('AI check without a model: nothing is reviewed and nothing is scored', async () => {
  const { config } = scratchConfig({ claude: NO_BIN, codex: NO_BIN });
  const r = await runAiCheck({ text: AI_TEXT, config });
  assert.equal(r.provenance.engine, null);
  assert.equal(r.status, 'unavailable');
  assert.equal(r.score, null);
  assert.match(r.scoreWithheld, /No model is connected/);
  assert.equal(r.bands.notReviewed, 100);
  assert.ok(r.sentences.filter((s) => s.eligible).every((s) => s.review === 'unreviewed' && s.band === null), 'never "few patterns" for text nobody reviewed');
  await assert.rejects(runAiCheck({ text: 'Too short.', config }), /at least 40 words/);
});

test('similarity: matches survive small edits, paraphrase is labelled, excluded quotes and references do not count', () => {
  const src = Sim.indexSource(fx.CHECK_SOURCE_TEXT);
  const text = 'Remote work has become a defining feature of the modern workplace since the pandemic, writers agree. In one randomised trial at a Chinese travel agency, call-centre staff who worked from home were 13 percent more productive than colleagues in the office. "Managers reported that the gains came mostly from fewer breaks and sick days" according to the study. Managers said the productivity gains came mainly from fewer breaks, fewer sick days and a quieter environment at home.\n\nReferences\nBloom, N. Remote work has become a defining feature of the modern workplace since the pandemic.';
  const sub = Sim.prepareSubmission(text, { quotes: true, references: true });
  const m = Sim.compare(sub, src, { skip: sub.skip });
  const said = m.map((x) => [x.type, text.slice(sub.ws[x.from].start, sub.ws[x.to - 1].end)]);
  assert.equal(said[0][1], 'Remote work has become a defining feature of the modern workplace since the pandemic');
  assert.match(said[1][1], /^randomised trial at a Chinese travel agency, call-centre staff who worked from home were 13 percent more productive than colleagues in the office$/);
  assert.ok(said.some(([type, s]) => type === 'paraphrase' && /quieter environment/.test(s)));
  assert.ok(!said.some(([, s]) => /gains came mostly from fewer breaks and sick days"/.test(s)), 'the quotation is excluded');
  assert.equal(said.filter(([, s]) => /defining feature/.test(s)).length, 1, 'the reference list is excluded');
});

test('similarity: safe fetching refuses local addresses and honours robots.txt', async () => {
  assert.equal(Sim.privateAddress('192.168.1.1'), true);
  assert.equal(Sim.privateAddress('fd00::1'), true);
  assert.equal(Sim.privateAddress('93.184.216.34'), false);
  await assert.rejects(Sim.safeFetch('http://localhost:4319/api/state', { lookup: PUBLIC_DNS }), /local address/);
  await assert.rejects(Sim.safeFetch('https://intranet.example/', { lookup: async () => [{ address: '10.0.0.5' }] }), /local network/);
  await assert.rejects(Sim.safeFetch('https://example.edu/to-local', { lookup: PUBLIC_DNS }), /local network/);
  const moved = await Sim.safeFetch('https://example.edu/moved', { lookup: PUBLIC_DNS });
  assert.equal(moved.url, 'https://example.edu/remote-work');
  assert.equal(await Sim.robotsAllow('https://example.edu/members/x', { lookup: PUBLIC_DNS }), false);
  assert.equal(await Sim.robotsAllow('https://example.edu/remote-work', { lookup: PUBLIC_DNS }), true);
});

test('similarity check: papers and web pages are compared word by word; model URLs are only candidates', async () => {
  mock.reset();
  const { config, store } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  const text = `Working from home: a short essay. Remote work has become a defining feature of the modern workplace since the pandemic. In a randomised trial at a Chinese travel agency, call-centre employees who worked from home were 13 percent more productive than colleagues in the office, and attrition among them fell by half. My own view is different, because my cousin hated it and went back after two weeks of video calls and cold coffee in her kitchen.`;
  const events = [];
  const r = await Sim.runSimilarityCheck({ text, config, store, lookup: PUBLIC_DNS, emit: (e, d) => events.push([e, d]) });
  const web = r.sources.find((s) => s.kind === 'web');
  assert.ok(web, 'the copied web page is found');
  assert.equal(web.url, 'https://example.edu/remote-work');
  assert.equal(web.title, 'Working from home: the evidence');
  assert.ok(web.percent >= 40, `percent ${web.percent}`);
  assert.ok(r.score >= 40 && r.score <= 80, `score ${r.score}`);
  const span = r.spans.find((s) => s.source === web.n && s.type === 'exact');
  assert.match(span.excerpt.match, /randomised trial|defining feature/);
  assert.ok(!r.spans.some((s) => /cousin hated it/.test(r.text.slice(s.start, s.end))));
  const skipped = r.searched.skipped.map((s) => [s.url, s.why]);
  assert.ok(skipped.some(([u, why]) => /members/.test(u) && /does not allow/.test(why)));
  assert.ok(skipped.some(([u, why]) => /to-local/.test(u) && /local network/.test(why)));
  assert.ok(!mock.calls.some((c) => c.host === '127.0.0.1'), 'nothing on this computer is fetched');
  assert.ok(mock.calls.some((c) => c.host === 'api.openalex.org'), 'the paper databases are searched');
  assert.ok(events.some(([e, d]) => e === 'step' && d.id === 'web' && d.state === 'done'));
});

test('server: extract, AI check and similarity check over the API', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-test-'));
  const app = createApp({ dataDir });
  app.config.update({ bins: { claude: CLAUDE, codex: NO_BIN } });
  const pageUrl = await app.listen(0); // the window's address, with the token
  const base = pageUrl.slice(0, pageUrl.indexOf('?'));
  const post = (p, body) => mock.realFetch(base + p, { method: 'POST', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = async (res) => (await res.text()).split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { event: e.slice(7), data: JSON.parse(d.slice(6)) }; });
  try {
    await mock.realFetch(base + 'api/settings', { method: 'PUT', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify({ keys: { openalex: 'oa' }, bins: { claude: CLAUDE, codex: NO_BIN } }) });
    const ex = await (await post('api/checks/extract', { name: 'essay.txt', data: Buffer.from(HUMAN_TEXT).toString('base64') })).json();
    assert.equal(ex.kind, 'Text');
    assert.equal(ex.text, HUMAN_TEXT);
    const bad = await post('api/checks/extract', { name: 'x.pdf', data: Buffer.from('%PDF-1.4 nothing').toString('base64') });
    assert.equal(bad.status, 422);

    const ai = await events(await post('api/checks/ai', { text: `${AI_TEXT}\n\n${HUMAN_TEXT}` }));
    const result = ai.find((e) => e.event === 'result');
    assert.ok(result && result.data.sentences.length > 10);
    assert.equal(result.data.kind, 'writing-pattern-review');
    assert.ok(result.data.provenance.batches.length >= 1);
    const sim = await events(await post('api/checks/similarity', { text: HUMAN_TEXT, options: { web: false } }));
    const simResult = sim.find((e) => e.event === 'result').data;
    assert.equal(simResult.options.web, false);
    assert.ok(sim.some((e) => e.event === 'step' && e.data.id === 'web' && e.data.state === 'skipped'));
    const empty = await post('api/checks/ai', { text: '  ' });
    assert.equal(empty.status, 400);
    const page = await (await mock.realFetch(pageUrl)).text();
    assert.ok(page.includes('/checks.js') && page.includes('/checks.css'));
  } finally { await app.close(); }
});

test('PDF export: the desktop hook gets a safe file name; without it the window is told to print instead', async () => {
  const saved = [];
  const pdf = { save: async ({ name }) => { saved.push(name); return { ok: true, path: `/tmp/${name}` }; } };
  const run = async (opts) => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-test-')), ...opts });
    // Pinned before the first request: GET api/state looks for the engines, which must never find the real tools.
    app.config.update({ bins: { claude: NO_BIN, codex: NO_BIN } });
    const pageUrl = await app.listen(0); // the window's address, with the token
    const base = pageUrl.slice(0, pageUrl.indexOf('?'));
    const call = async (m, p, body) => (await mock.realFetch(base + p, { method: m, headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
    try { return { state: await call('GET', 'api/state'), out: await call('POST', 'api/checks/pdf', { name: '../../etc/essay: "draft"?.pdf' }) }; } finally { await app.close(); }
  };
  const desk = await run({ pdf });
  assert.equal(desk.state.pdfExport, true);
  assert.equal(desk.out.ok, true);
  assert.deepEqual(saved, ['.. .. etc essay draft.pdf']);
  const web = await run({});
  assert.equal(web.state.pdfExport, false);
  assert.equal(web.out.ok, false);
  assert.match(web.out.error, /Save as PDF/);
});

// ---------------------------------------------------------------- 2026-11-17: style model, rewrite check, quote and cite
const { styleReading, MODEL: STYLE_MODEL } = require('../server/checks/style');
const { preservation, runRewrite } = require('../server/checks/rewrite');
const { quoteAndCite, citationFor } = require('../server/checks/citefix');

test('style model: a second reading with its tested accuracy; stock AI prose reads higher than specific human prose', () => {
  const ai = styleReading(AI_TEXT.repeat(2));
  const human = styleReading(HUMAN_TEXT.repeat(2));
  assert.ok(ai && human);
  assert.ok(ai.probability > human.probability, `${ai.probability} vs ${human.probability}`);
  assert.equal(ai.threshold, STYLE_MODEL.threshold);
  assert.match(ai.tested.nonNativeFalsePositive, /TOEFL/);
  assert.equal(styleReading('Too short to read.'), null);
});

test('rewrite check: lost or invented numbers, names and acronyms are caught', () => {
  const o = 'In a 2015 trial at Ctrip, a Shanghai travel agency, staff were 13% more productive (Bloom et al., 2015). The OECD counted 1.5 million.';
  assert.deepEqual(preservation(o, 'Staff at Ctrip, a Shanghai travel agency, were 13% more productive in a 2015 trial (Bloom et al., 2015). Later the OECD counted 1.5 million.'), { ok: true, missing: [], added: [] });
  const bad = preservation(o, 'Staff at a travel agency were 15% more productive (Bloom et al., 2015), says Stanford. The OECD counted many.');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing.sort(), ['1.5', '13%', '2015', 'Ctrip', 'Shanghai'].sort());
  assert.deepEqual(bad.added.sort(), ['15%', 'Stanford'].sort());
});

test('rewrite: a fact-changing first answer is redone once; the second answer is checked too', async () => {
  const { config } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  const text = 'Remote work raised output by 13% at Ctrip in 2015, according to one trial (Bloom et al., 2015). Many firms followed.';
  const replies = [
    { text: JSON.stringify({ text: 'Working from home lifted output by 15% at a travel firm in 2015, one trial found LECTERNPROTECTED. Many firms followed.' }) },
    { text: JSON.stringify({ text: 'One trial found that working from home lifted output by 13% at Ctrip in 2015 LECTERNPROTECTED. Many firms followed.' }) },
  ];
  const prompts = [];
  const complete = async (o) => {
    prompts.push(o.prompt);
    const token = (o.prompt.match(/LECTERNPROTECTED[0-9a-f]+X0END/) || [])[0];
    const r = replies[prompts.length - 1];
    return { text: r.text.replace('LECTERNPROTECTED', token) };
  };
  const r = await runRewrite({ text, config, engine: 'claude-code', complete });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /It dropped: 13%, Ctrip/);
  assert.match(prompts[1], /It added, which is not allowed: 15%/);
  assert.equal(r.check.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(r.text, /\(Bloom et al\., 2015\)/);
});

test('quote and cite: exact matches are quoted, paraphrases cited, sources listed; the similarity score then drops', async () => {
  mock.reset();
  const { config, store } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  const copied = 'In a nine-month randomised trial at a 16,000-person services firm, call-centre employees assigned to work from home completed 13% more calls, driven by fewer breaks and sick days, and quit at half the rate.';
  const text = `Working from home: a short essay. ${copied} My own view is different, because my cousin hated it and went back to the office after two weeks of video calls and cold coffee in her kitchen, and she says the quiet made her lonely.`;
  const first = await Sim.runSimilarityCheck({ text, config, store, lookup: PUBLIC_DNS, options: { web: false } });
  assert.ok(first.score >= 40, `before ${first.score}`);
  const fixed = quoteAndCite(first.text, first);
  assert.ok(fixed.quoted >= 1);
  const src = first.sources[0];
  const cite = citationFor(src).inText;
  assert.ok(fixed.text.includes(`“`) && fixed.text.includes(`” ${cite}`), fixed.text);
  assert.match(fixed.text, /\nReferences\n/);
  assert.ok(fixed.text.includes(src.title));
  // the writer's own words are untouched
  assert.ok(fixed.text.includes('My own view is different, because my cousin hated it'));
  assert.equal(fixed.text.replace(/[“”]/g, '').replace(/ \([^()]*\d{4}\)| \([^()]*n\.d\.\)/g, '').split('\nReferences')[0].trim(), text.trim());
  const second = await Sim.runSimilarityCheck({ text: fixed.text, config, store, lookup: PUBLIC_DNS, options: { web: false, quotes: true } });
  assert.ok(second.score < first.score, `after ${second.score} vs before ${first.score}`);
  assert.throws(() => quoteAndCite(text + ' changed', first), /changed since it was checked/);
});

// ---------------------------------------------------------------- 2026-11-17: hostile documents and pages, safe fetching
const { htmlText, pdfText } = require('../server/checks/extract');

/** A zip whose directory lists `names`, every entry pointing at one deflated body (the "shared body" zip bomb). */
function sharedBodyZip(names, body) {
  const comp = zlib.deflateRawSync(body, { level: 9 });
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt16LE(5, 26);
  const head = Buffer.concat([local, Buffer.from('a.xml'), comp]);
  const cens = names.flatMap((name) => {
    const nb = Buffer.from(name);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(0, 42);
    return [cen, nb];
  });
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(head.length, 16);
  return Buffer.concat([head, cd, end]);
}

/** A one-page PDF with `content` as its (deflated) content stream. */
function pdfWith(content) {
  const comp = zlib.deflateSync(content, { level: 9 });
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >> endobj\n'
    + `4 0 obj << /Length ${comp.length} /Filter /FlateDecode >> stream\n`), comp, Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF')]);
}

const quick = (label, fn, ms) => { const t = Date.now(); const out = fn(); assert.ok(Date.now() - t < ms, `${label}: ${Date.now() - t} ms`); return out; };

test('documents: zip and PDF bombs are refused within a fixed budget', () => {
  // 3000 directory entries share one 1 MB body: only word/document.xml is unpacked, once.
  const names = ['word/document.xml', ...Array.from({ length: 3000 }, (_, i) => `part${i}.xml`)];
  const shared = sharedBodyZip(names, Buffer.from(`<w:body><w:p><w:t>${'x'.repeat(1024 * 1024)}</w:t></w:p></w:body>`));
  const text = quick('shared-body zip', () => extractText({ name: 'bomb.docx', data: shared }).text, 3000);
  assert.equal(text.length, 1024 * 1024);
  // One part that unpacks past the 64 MB budget.
  const big = sharedBodyZip(['word/document.xml'], Buffer.alloc(65 * 1024 * 1024, 0x20));
  assert.throws(() => extractText({ name: 'big.docx', data: big }), /more text than Lectern can read at once/);
  // A PDF content stream that unpacks past the per-stream limit.
  const pdf = pdfWith(Buffer.concat([Buffer.from('BT (Some readable words here) Tj ET\n'), Buffer.alloc(49 * 1024 * 1024, 0x20)]));
  assert.throws(() => extractText({ name: 'bomb.pdf', data: pdf }), /This PDF unpacks to more than Lectern can read at once/);
});

test('documents and web pages: unclosed tags and markers cannot make reading slow', () => {
  const kb = 300 * 1024;
  quick('unclosed comments', () => htmlText('<p>Words before.</p>' + '<!--x'.repeat(kb / 5)), 300);
  assert.equal(htmlText('<p>Kept text.</p><!-- an unclosed comment hides the rest <p>hidden</p>'), 'Kept text.');
  quick('unclosed scripts', () => htmlText('<p>text</p>' + '<script>'.repeat(kb / 8)), 300);
  quick('tags with no end', () => htmlText('<p>text</p>' + '<a'.repeat(kb / 2)), 300);
  quick('unclosed articles', () => htmlText('<p>text</p>' + '<article '.repeat(kb / 9)), 300);
  quick('unclosed head', () => htmlText('<head>'.repeat(kb / 6) + '<p>text</p>'), 300);
  assert.equal(htmlText('<html><head><title>T</title></head><body><nav>Menu</nav><article><p>Main part.</p></article><footer>F</footer></body></html>'), 'Main part.');
  const docx = (xml) => makeZip({ 'word/document.xml': xml });
  const t1 = quick('unclosed w:del', () => extractText({ name: 'a.docx', data: docx('<w:body><w:p><w:t>Words that stay in the text.</w:t></w:p>' + '<w:del '.repeat(kb / 7)) }).text, 500);
  assert.equal(t1, 'Words that stay in the text.');
  const t2 = quick('unclosed w:p', () => extractText({ name: 'a.docx', data: docx('<w:body><w:p><w:t>Words that stay in the text.</w:t></w:p>' + '<w:p '.repeat(kb / 5)) }).text, 500);
  assert.equal(t2, 'Words that stay in the text.');
  // Tab stops in paragraph settings are not tabs in the text; a real tab and a break are.
  assert.equal(extractText({ name: 'a.docx', data: docx('<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>One</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three words here.</w:t></w:r></w:p>') }).text, 'One\ttwo\nthree words here.');
});

test('PDF: an inline image with no data marker ends the stream instead of looping forever', () => {
  const text = quick('BI after EI', () => pdfText(pdfWith(Buffer.from('BT (Some readable words for the reader to find) Tj ET EI BI /W 1'))), 1000);
  assert.match(text, /Some readable words for the reader to find/);
});

test('RTF: font, colour and style tables stay out of the text, and \\uN is read once', () => {
  const B = '\\';
  const rtf = `{${B}rtf1${B}ansi${B}ansicpg1252${B}cocoartf2761{${B}fonttbl${B}f0${B}fswiss${B}fcharset0 Helvetica;${B}f1${B}froman Times New Roman;}`
    + `{${B}colortbl;${B}red255${B}green255${B}blue255;}{${B}*${B}expandedcolortbl;;}{${B}stylesheet{${B}s0 Normal;}}{${B}info{${B}title Draft}{${B}author Someone}}`
    + `${B}paperw11900${B}pard${B}f0${B}fs24 The student${B}uc1${B}u8217${B}'92s essay argues that ${B}'93remote work${B}'94 raises output.${B}par Second paragraph${B}u8212 ?ends here.}`;
  const { text, kind } = extractText({ name: 'essay.rtf', data: Buffer.from(rtf, 'latin1') });
  assert.equal(kind, 'Rich text');
  assert.equal(text, 'The student’s essay argues that “remote work” raises output.\nSecond paragraph—ends here.');
});

test('similarity: a site answering 204, 205, 304 or 999 cannot stop the app', async () => {
  const http = require('http');
  const srv = http.createServer((q, r) => { const code = Number(q.url.slice(1)); r.writeHead(code, { 'content-type': 'text/plain' }); r.end(code === 200 ? 'User-agent: *\nDisallow: /x\n' : undefined); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    // The connection is pinned to a checked address; a local test server stands in for the site here.
    const get = (code) => Sim.publicRequest(new URL(`http://lectern-test.example:${port}/${code}`), { headers: {}, signal: AbortSignal.timeout(3000) }, [{ address: '127.0.0.1', family: 4 }]);
    for (const code of [204, 205, 304]) {
      const res = await get(code);
      assert.equal(res.status, code);
      assert.equal(res.body, null, `${code} has no body`);
    }
    await assert.rejects(get(999), (e) => e.status === 999 && /answered 999/.test(e.message), 'LinkedIn-style 999 is an error, not a crash');
    assert.equal(await (await get(200)).text(), 'User-agent: *\nDisallow: /x\n');
  } finally { srv.close(); }
});

test('similarity: robots.txt rules match in linear time, with * and $', () => {
  const m = Sim.robotsMatch;
  assert.equal(m('/private', '/private/x'), true);
  assert.equal(m('/private', '/public'), false);
  assert.equal(m('/*.pdf$', '/files/a.pdf'), true);
  assert.equal(m('/*.pdf$', '/files/a.pdf?x=1'), false);
  assert.equal(m('/a*b*c', '/a-x-b-y-c-z'), true);
  assert.equal(m('/a*b*c', '/a-x-c-y-b'), false);
  assert.equal(m('/fish$', '/fish'), true);
  assert.equal(m('/fish$', '/fish/'), false);
  assert.equal(m('*', '/anything'), true);
  assert.equal(m('/a$b', '/a$b/c'), true, 'a "$" inside the rule is a plain character');
  const hostile = `/${'*a'.repeat(200)}*b`;
  quick('hostile rule', () => { for (let i = 0; i < 200; i++) m(hostile, `/${'a'.repeat(5000)}`); }, 500);
  const rules = Sim.parseRobots(`User-agent: *\nDisallow: /${'x'.repeat(600)}\nDisallow: /ok\n`);
  assert.deepEqual(rules.map((r) => r.path), ['/ok'], 'an overlong rule is ignored');
});

test('similarity: IPv6 forms that carry a local IPv4 address, and local IPv6 ranges, are refused', () => {
  for (const ip of ['fe80::1', 'febf::1', 'fec0::1', 'feff::1', '::1', '::', '::127.0.0.1', '::10.0.0.1', '::ffff:192.168.0.1', '::ffff:c0a8:1',
    '::ffff:0:10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.1.2.3', '64:ff9b:1::a00:1', '2002:7f00:1::', '2002:c0a8:101::1', 'ff02::1', 'fd12:3456::1', 'fe80::1%en0']) {
    assert.equal(Sim.privateAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700::1111', '::8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1', '2a00:1450:4009::200e', '93.184.216.34']) {
    assert.equal(Sim.privateAddress(ip), false, ip);
  }
});

test('similarity: the selected provider and model search the web, or the check says why it did not', async () => {
  mock.reset();
  const { config, store } = scratchConfig({ claude: CLAUDE, codex: NO_BIN });
  const text = 'Remote work has become a defining feature of the modern workplace since the pandemic, and in a randomised trial at a Chinese travel agency the call-centre employees who worked from home were thirteen percent more productive than colleagues in the office.';
  const notConnected = await Sim.runSimilarityCheck({ text, config, store, lookup: PUBLIC_DNS, engine: 'codex', options: { papers: false } });
  assert.ok(notConnected.notes.some((n) => /selected model provider is not connected/.test(n)), notConnected.notes.join(' | '));
  assert.equal(notConnected.searched.pages, 0, 'no other provider searched instead');

  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-sim-model-')), 'runs.jsonl');
  process.env.FAKE_LOG = log;
  try {
    await Sim.runSimilarityCheck({ text, config, store, lookup: PUBLIC_DNS, engine: 'claude-code', selectedModel: 'claude-sonnet-5-5', options: { papers: false } });
    const run = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.equal(run.args[run.args.indexOf('--model') + 1], 'claude-sonnet-5-5', 'the chosen model searched');
  } finally { delete process.env.FAKE_LOG; mock.reset(); }
});

test('quote and cite: a passage already in quotes, ending in punctuation, is not quoted twice', () => {
  const src = [{ n: 1, kind: 'paper', title: 'Working from home', authors: ['Noor Rahman', 'Peter Aldous'], year: 2019 }];
  for (const [text, close] of [
    ['As one study put it, "remote workers completed thirteen percent more calls than office staff did." That was big.', '."'],
    ['He wrote “remote workers completed thirteen percent more calls than office staff did,” and moved on.', ',”'],
  ]) {
    const span = { start: text.indexOf('remote'), end: text.indexOf(close) + 1, source: 1, type: 'exact' };
    const out = quoteAndCite(text, { text, sources: src, spans: [span] });
    assert.equal(out.quoted, 0);
    assert.equal(out.cited, 1);
    assert.ok(!/["“]["“]/.test(out.text), out.text);
    assert.ok(out.text.includes(`${close} (Rahman & Aldous, 2019)`), out.text);
  }
});
