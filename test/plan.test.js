'use strict';
// The query planner (server/pipeline.js planQueries and its helpers, prompts in server/prompts.js).
// Offline: the model is a fake that returns a canned reply, so these tests check what Lectern does
// with a reply and what it asks for, never how good a real model's queries are. Retrieval quality
// is measured in bench/search, on recorded plans.
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../server/llm');
const prompts = require('../server/prompts');
const { planQueries, keywords, looksYesNo, cleanQuery, parsePlan, fallbackQueries } = require('../server/pipeline');

/** Replaces llm.complete for one test; `reply` is a string, an Error, or a function of the call. */
async function withModel(reply, fn) {
  const original = llm.complete;
  const calls = [];
  llm.complete = async (opts) => {
    calls.push(opts);
    const r = typeof reply === 'function' ? reply(opts) : reply;
    if (r instanceof Error) throw r;
    return { text: r, usage: { input: 1, output: 1 } };
  };
  try { return await fn(calls); } finally { llm.complete = original; }
}
const settings = (profile = {}) => ({ profile });
const ask = (question, opts = {}) => planQueries({ engine: 'claude-code', settings: settings(opts.profile), question, history: opts.history || [], ...opts.args });

/** The properties every plan must have, whatever the question. Returns a list of problems (empty = fine). */
function planProblems(plan, { max = 4, min = 1 } = {}) {
  const bad = [];
  if (plan.queries.length < min || plan.queries.length > max) bad.push(`has ${plan.queries.length} queries`);
  const keys = new Set();
  for (const q of plan.queries) {
    const words = q.split(' ');
    if (words.length < 1 || words.length > 8) bad.push(`"${q}" has ${words.length} words`);
    if (q.length > 140) bad.push(`"${q}" is too long`);
    if (/[-"'()+:;,.?!/\\]/.test(q)) bad.push(`"${q}" has punctuation`);
    if (/\b(AND|OR|NOT)\b/.test(q)) bad.push(`"${q}" has an operator`);
    if (/\s{2,}|^\s|\s$/.test(q)) bad.push(`"${q}" has stray spaces`);
    const key = words.map((w) => w.toLowerCase()).sort().join(' ');
    if (keys.has(key)) bad.push(`"${q}" repeats another query`);
    keys.add(key);
  }
  if (typeof plan.yesNo !== 'boolean') bad.push('yesNo is not a boolean');
  return bad;
}

test('cleanQuery: plain words only, safe for OpenAlex, Semantic Scholar and Crossref', () => {
  assert.equal(cleanQuery('"remote work" AND (productivity OR output)'), 'remote work productivity output');
  assert.equal(cleanQuery('work-from-home productivity'), 'work from home productivity', 'Semantic Scholar finds nothing for a hyphenated term');
  assert.equal(cleanQuery("Alzheimer's disease biomarkers"), 'Alzheimer disease biomarkers', 'the possessive is dropped, not left as a lone "s"');
  assert.equal(cleanQuery('Alzheimer’s disease'), 'Alzheimer disease');
  assert.equal(cleanQuery('NOT a drill'), 'a drill');
  assert.equal(cleanQuery('  spaced \n  out\twords  '), 'spaced out words');
  assert.equal(cleanQuery('COVID-19 vaccine hesitancy: a review?'), 'COVID 19 vaccine hesitancy a review');
  assert.equal(cleanQuery('producción agrícola sostenible'), 'producción agrícola sostenible', 'letters outside a-z are kept');
  assert.equal(cleanQuery('一带一路 经济 影响'), '一带一路 经济 影响');
  assert.equal(cleanQuery(null), '');
  assert.equal(cleanQuery(undefined), '');
  assert.equal(cleanQuery(12345), '12345');
  // Every word of an OpenAlex query must match, so a runaway query is cut, on a word boundary.
  const long = cleanQuery('one two three four five six seven eight nine ten eleven twelve');
  assert.equal(long, 'one two three four five six seven eight');
  assert.ok(cleanQuery('x'.repeat(300)).length <= 140);
});

test('parsePlan: reads the shapes a small model really sends', () => {
  const good = parsePlan('{"queries": ["remote work productivity", "telework output", "home office performance"], "yes_no": true, "topic": "Remote work"}');
  assert.deepEqual(good, { queries: ['remote work productivity', 'telework output', 'home office performance'], yesNo: true, topic: 'Remote work' });

  const fenced = parsePlan('Here you go:\n```json\n{"queries": ["a b", "c d"], "yes_no": false}\n```');
  assert.deepEqual(fenced.queries, ['a b', 'c d']);
  assert.equal(fenced.yesNo, false);

  assert.deepEqual(parsePlan('{"queries": "sleep apnea heart\\nCPAP cardiovascular risk"}').queries, ['sleep apnea heart', 'CPAP cardiovascular risk'], 'queries sent as one string');
  assert.deepEqual(parsePlan('["sleep apnea heart", "CPAP cardiovascular risk"]').queries, ['sleep apnea heart', 'CPAP cardiovascular risk'], 'a bare array');
  assert.deepEqual(parsePlan('{"queries": [{"query": "gene therapy hemophilia"}, "gene therapy safety"]}').queries, ['gene therapy hemophilia', 'gene therapy safety'], 'objects with a query field');

  // Repeats, including the same words in another order, and fragments too short to search.
  const dup = parsePlan('{"queries": ["remote work productivity", "Remote Work Productivity", "productivity remote work", "ab", "", null, 7]}');
  assert.deepEqual(dup.queries, ['remote work productivity']);

  assert.equal(parsePlan('{"queries": ["a b c", "d e f", "g h i", "j k l", "m n o"]}', 3).queries.length, 3, 'capped at max');
  assert.equal(parsePlan('{"queries": ["a b c"], "yes_no": "yes"}').yesNo, null, 'only a real boolean counts');
  assert.equal(parsePlan('{"queries": ["a b c"], "topic": 5}').topic, '');
  assert.equal(parsePlan('{"queries": ["a b c"], "topic": "' + 'x'.repeat(200) + '"}').topic.length <= 61, true);

  for (const junk of ['', null, undefined, 'I cannot help with that.', '{"queries": 5}', '{"queries": {}}', '{ not json', '[1, 2']) {
    assert.deepEqual(parsePlan(junk).queries, [], `no queries from ${JSON.stringify(junk)}`);
  }
});

test('looksYesNo: questions that can be answered yes or no, and not requests or choices', () => {
  for (const q of ['Does remote work improve productivity?', 'Is coffee bad for you?', 'Are electric cars cleaner than petrol cars?',
    'Should schools ban phones?', 'Has inflation targeting worked?', 'Can exercise reduce depression?', 'Did the 2008 crisis change lending?']) {
    assert.equal(looksYesNo(q), true, q);
  }
  for (const q of ['Can you explain how vaccines work?', 'Could you summarise the research on sleep?', 'Would you list the causes of inflation',
    'Does remote work raise or lower productivity?', 'Is it better to rent or buy?',
    'How does remote work affect productivity?', 'Why do people procrastinate?', 'What causes inflation?', '', null, undefined,
    '¿Mejora el teletrabajo la productividad?']) {
    assert.equal(looksYesNo(q), false, String(q));
  }
  assert.equal(looksYesNo('Does it matter whether or not a firm is listed?'), true, '"whether or not" is not a choice');
});

test('keywords and the no-model fallback', () => {
  assert.equal(keywords('What is the effect of remote work on employee productivity?'), 'remote work employee productivity');
  assert.equal(keywords('Do dogs understand human pointing?'), 'dogs understand human pointing');
  assert.equal(keywords('¿Cómo afecta la producción agrícola al clima?'), 'cómo afecta la producción agrícola al clima', 'accented letters stay whole (they were split before)');
  assert.equal(keywords('？？？'), '？？？', 'nothing searchable: the question itself, cut at 80 characters');
  assert.ok(keywords('x '.repeat(100) + 'là').length <= 80 + 200);

  // A short question gives one query; a long one gives two, the second from the most specific words.
  assert.deepEqual(fallbackQueries('Do dogs understand pointing?'), ['dogs understand pointing']);
  const q = 'What is the effect of interest rate changes on housing affordability for first-time buyers in large cities?';
  const plan = fallbackQueries(q);
  assert.equal(plan.length, 2);
  assert.ok(plan[0].split(' ').length <= 6, 'six words at most: every word must match on OpenAlex');
  assert.ok(plan[1].split(' ').length <= 3);
  assert.deepEqual(planProblems({ queries: plan, yesNo: false }, { min: 1 }), []);
  assert.deepEqual(fallbackQueries('？？？'), [], 'no letters or digits: nothing to search for, and no crash');
  assert.deepEqual(fallbackQueries(''), []);
});

test('planQueries: a normal reply becomes a clean plan', async () => {
  const reply = JSON.stringify({ queries: ['"remote work" productivity', 'telework employee output meta-analysis', 'work-from-home performance randomized trial'], yes_no: false, topic: 'Remote work output' });
  await withModel(reply, async (calls) => {
    const plan = await ask('Does remote work improve employee productivity?');
    assert.equal(plan.planned, true);
    assert.deepEqual(plan.queries, ['remote work productivity', 'telework employee output meta analysis', 'work from home performance randomized trial']);
    assert.equal(plan.yesNo, true, 'a question that starts with Does is yes/no even when the model said false');
    assert.equal(plan.topic, 'Remote work output');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, 'helper', 'planning runs on the small helper model');
    assert.match(calls[0].prompt, /Question: Does remote work improve employee productivity\?/);
    assert.deepEqual(planProblems(plan, { min: 3 }), []);
  });
});

test('planQueries: a model that fails or sends nonsense falls back to keywords and never throws', async () => {
  const q = 'How does social media use affect adolescent sleep quality?';
  await withModel(new Error('claude exited with code 1'), async () => {
    const plan = await ask(q);
    assert.equal(plan.planned, false);
    assert.match(plan.error, /exited/);
    assert.deepEqual(plan.queries, fallbackQueries(q));
    assert.ok(plan.queries.length >= 1);
    assert.equal(plan.yesNo, false);
  });
  for (const junk of ['', 'Sorry, I cannot do that.', '{"queries": []}', '{"queries": ["a", "!!"]}', '{ "queries": [', '{"queries": 5}']) {
    await withModel(junk, async () => {
      const plan = await ask(q);
      assert.equal(plan.planned, false, JSON.stringify(junk));
      assert.equal(plan.error, undefined);
      assert.deepEqual(plan.queries, fallbackQueries(q));
    });
  }
});

test('planQueries: an aborted search stays aborted (the fallback must not hide it)', async () => {
  const ctl = new AbortController();
  await withModel(() => { ctl.abort(); return new Error('aborted'); }, async () => {
    await assert.rejects(() => ask('Does X affect Y?', { args: { signal: ctl.signal } }), /aborted/);
  });
});

test('planQueries: the system prompt carries the field and, for the answer planner, the evidence addendum', async () => {
  const reply = '{"queries": ["a b", "c d", "e f"], "yes_no": false}';
  await withModel(reply, async (calls) => {
    await ask('Why do bridges collapse?', { profile: { field: 'engineering' } });
    const s = calls[0].system;
    assert.ok(s.startsWith(prompts.PLAN_SYSTEM));
    assert.match(s, /The student's field is: Engineering/);
    await ask('Why do bridges collapse?');
    assert.doesNotMatch(calls[1].system, /The student's field is/, 'no field set, no hint');

    await ask('Topic', { args: { system: prompts.REVIEW_PLAN_SYSTEM, max: 6 } });
    assert.ok(calls[2].system.startsWith(prompts.REVIEW_PLAN_SYSTEM));
    assert.ok(!calls[2].system.includes(prompts.EVIDENCE_PLANNING_ADDENDUM) || prompts.EVIDENCE_PLANNING_ADDENDUM === '', 'the review planner has its own recipe');
  });
});

test('planQueries: the tools keep their query counts (answer 4 at most, review 6, claim 4)', async () => {
  const many = JSON.stringify({ queries: ['q one', 'q two', 'q three', 'q four', 'q five', 'q six', 'q seven'], yes_no: false });
  await withModel(many, async () => {
    assert.equal((await ask('A question here')).queries.length, 4);
    assert.equal((await ask('A topic here', { args: { system: prompts.REVIEW_PLAN_SYSTEM, max: 6 } })).queries.length, 6);
    assert.equal((await ask('A claim here', { args: { system: prompts.CLAIM_PLAN_SYSTEM, max: 4 } })).queries.length, 4);
  });
});

test('planPrompt: earlier questions are listed for follow-ups and left out otherwise', () => {
  assert.equal(prompts.planPrompt('What about small firms?', []), 'Question: What about small firms?');
  assert.equal(prompts.planPrompt('What about small firms?', undefined), 'Question: What about small firms?');
  const p = prompts.planPrompt('What about small firms?', [{ question: 'Does remote work help productivity?', answer: 'long answer text that must not be sent' }]);
  assert.match(p, /Earlier in this conversation:\n- The student asked: Does remote work help productivity\?\n\nQuestion: What about small firms\?$/);
  assert.doesNotMatch(p, /long answer text/);
  assert.ok(prompts.planPrompt('q', [{ question: 'x'.repeat(2000) }]).length < 600, 'a long earlier question is clipped');
});

test('planAudience: names the field, never invents one', () => {
  assert.equal(prompts.planAudience({}), '');
  assert.equal(prompts.planAudience(null), '');
  assert.match(prompts.planAudience({ field: 'law' }), /field is: Law/);
  assert.match(prompts.planAudience({ field: 'other', fieldOther: 'Marine biology' }), /field is: Marine biology/);
  assert.equal(prompts.planAudience({ field: 'not-a-field' }), '');
});

test('the planner prompts promise what the code can use', () => {
  for (const [name, text, n] of [['answer', prompts.PLAN_SYSTEM, 3], ['review', prompts.REVIEW_PLAN_SYSTEM, 6], ['claim', prompts.CLAIM_PLAN_SYSTEM, 4]]) {
    assert.match(text, /JSON object/, name);
    assert.match(text, /"queries"/, name);
    assert.match(text, /"yes_no"/, name);
    assert.match(text, new RegExp(`Exactly ${n} queries`), name);
    assert.doesNotMatch(text, /\bhyphen\w* (is|are) (fine|allowed)/i, name);
  }
});

// Questions of every kind that students type, each with the reply a sensible model would give and
// the properties the finished plan must have. The fake reply is not a measure of any model: it shows
// that the plan reaching the search is clean even when the reply is untidy, and gives the same checks
// to run on a recorded real plan.
const TRICKY = [
  { name: 'specific effect question', q: 'Does a four-day work week improve employee well-being?', yesNo: true,
    reply: { queries: ['four-day work week wellbeing', 'shortened working week employee health', 'reduced working hours trial'], yes_no: true } },
  { name: 'vague question', q: 'is social media bad', yesNo: true,
    reply: { queries: ['social media mental health', 'social media use adolescents depression', 'screen time wellbeing review'], yes_no: true } },
  { name: 'a topic, not a question', q: 'home fragrance sustainability', yesNo: false,
    reply: { queries: ['home fragrance environmental impact', 'indoor air fragrance emissions', 'scented candle sustainability consumer'], yes_no: false } },
  { name: 'a statement to check', q: 'Intermittent fasting is better than calorie restriction for weight loss.', yesNo: false,
    reply: { queries: ['intermittent fasting calorie restriction weight loss', 'time restricted eating body weight', 'fasting diets randomized trial'], yes_no: false } },
  { name: 'a follow-up', q: 'And what about older adults?', history: [{ question: 'Does resistance training improve bone density?' }], yesNo: false,
    reply: { queries: ['resistance training bone density older adults', 'strength exercise osteoporosis elderly', 'exercise bone mineral density aging'], yes_no: false },
    promptHas: /Does resistance training improve bone density\?/ },
  { name: 'Spanish', q: '¿Cómo afecta el teletrabajo a la productividad de los empleados?', yesNo: false,
    reply: { queries: ['telework employee productivity', 'remote work performance', 'working from home output'], yes_no: false } },
  { name: 'Chinese', q: '数字货币对国际贸易有什么影响？', yesNo: false,
    reply: { queries: ['digital currency international trade', 'central bank digital currency cross-border payments', 'cryptocurrency trade finance'], yes_no: false } },
  { name: 'acronyms', q: 'Is CBT effective for PTSD in veterans?', yesNo: true,
    reply: { queries: ['cognitive behavioural therapy posttraumatic stress veterans', 'CBT PTSD military veterans', 'trauma focused therapy veterans review'], yes_no: true } },
  { name: 'a request, not a yes/no', q: 'Can you explain how mRNA vaccines work?', yesNo: false,
    reply: { queries: ['mRNA vaccine mechanism', 'messenger RNA vaccine immune response', 'lipid nanoparticle mRNA delivery'], yes_no: false } },
  { name: 'a choice question', q: 'Does remote work increase or decrease productivity?', yesNo: false,
    reply: { queries: ['remote work productivity', 'telework performance', 'working from home output'], yes_no: false } },
  { name: 'a named case', q: "How did Brexit affect UK fisheries?", yesNo: false,
    reply: { queries: ['Brexit UK fisheries', 'Brexit fishing quotas trade agreement', 'United Kingdom European Union fisheries policy'], yes_no: false } },
  { name: 'law', q: 'When is a company director personally liable for insolvent trading in Australia?', yesNo: false,
    reply: { queries: ['director liability insolvent trading Australia', 'insolvent trading safe harbour directors', 'corporations act directors duty insolvency'], yes_no: false } },
  { name: 'an untidy reply (long, hyphenated, quoted, repeated)', q: 'Does mindfulness reduce stress in students?', yesNo: true,
    reply: { queries: ['"mindfulness-based stress reduction" AND (university students OR college students) academic stress outcomes randomized trial', 'Mindfulness-based stress reduction students', 'students mindfulness based stress reduction'], yes_no: true } },
];

for (const t of TRICKY) {
  test(`tricky question: ${t.name}`, async () => {
    await withModel(JSON.stringify(t.reply), async (calls) => {
      const plan = await ask(t.q, { history: t.history });
      assert.equal(plan.planned, true);
      assert.deepEqual(planProblems(plan, { min: 2 }), [], t.q);
      assert.equal(plan.yesNo, t.yesNo, `yes/no for: ${t.q}`);
      if (t.promptHas) assert.match(calls[0].prompt, t.promptHas);
      if (!/[a-z]/i.test(t.q.replace(/[^a-z]/gi, '')) || /[^\x00-\x7f]/.test(t.q)) {
        // A question in another language: the queries that reach the databases are English.
        assert.ok(plan.queries.every((x) => /^[a-z0-9 ]+$/i.test(x)), `English queries for: ${t.q} (${plan.queries.join(' | ')})`);
      }
    });
    // The same question with a failed model still produces a searchable plan.
    await withModel(new Error('offline'), async () => {
      const plan = await ask(t.q, { history: t.history });
      assert.equal(plan.planned, false);
      assert.ok(plan.queries.length >= 1 && plan.queries.every((x) => x.length > 0), `fallback for: ${t.q}`);
      assert.deepEqual(planProblems(plan, { min: 1 }).filter((p) => !/yesNo/.test(p)), []);
    });
  });
}
