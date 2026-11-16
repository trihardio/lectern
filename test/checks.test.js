'use strict';
// The AI score page: document text extraction, the AI-writing check and the similarity check.
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
  const base = await app.listen(0);
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
    const page = await (await mock.realFetch(base)).text();
    assert.ok(page.includes('/checks.js') && page.includes('/checks.css'));
  } finally { await app.close(); }
});

test('PDF export: the desktop hook gets a safe file name; without it the window is told to print instead', async () => {
  const saved = [];
  const pdf = { save: async ({ name }) => { saved.push(name); return { ok: true, path: `/tmp/${name}` }; } };
  const run = async (opts) => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-test-')), ...opts });
    const base = await app.listen(0);
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
