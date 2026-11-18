'use strict';
// Version 7 AI test texts: the plan, written before any text exists. Free: no model call.
//
//   node bench/v7/gen-plan.js    writes bench/data/v7/ai/plan.json
//
// Two kinds of AI text:
//   humanvoice  30 texts written by claude-haiku-5-5 to a request that asks for a natural human voice.
//   rewrite     15 AI texts from the version 6 TRAIN split, each passed through Lectern's own Rewrite tool
//               (runRewrite in server/checks/rewrite.js), styles general, casual, blog and academic in turn.
// Topics avoid the version 6 corpus and the owner's subjects. The requests are recorded word for word in plan.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'bench', 'data', 'v6', 'corpus.jsonl');
const OUT_DIR = path.join(ROOT, 'bench', 'data', 'v7', 'ai');
const WRITER = 'claude-haiku-5-5';
const REWRITE_STYLES = ['general', 'casual', 'blog', 'academic'];
const REWRITE_COUNT = 15;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const words = (t) => (String(t).match(/\S+/g) || []).length;

const AVOID = 'Avoid stock phrases such as "in today\'s world", "delve", "tapestry", "it is important to note", "game-changer" and "dive in", and do not end with a neat summary.';
const TAIL = 'Output only the text: no title, no headings, no bullet points, no notes before or after it.';
const VOICE = {
  student: 'Write like a second-year university student: plain and a little uneven, the way a decent student writes late at night. Vary sentence length.',
  casual: 'Write casually and in the first person, the way you would tell a friend. Use contractions and vary sentence length.',
  reflect: 'Write a personal reflection in the first person. Vary sentence length and include one specific personal detail.',
  blog: 'Write in a relaxed, personal blog voice. Vary sentence length and include one specific personal detail.',
  email: 'Write the way a real person types a short email: plain, polite and a little impatient. Vary sentence length.',
  encyc: 'Write in a plain, factual encyclopedia register, as a volunteer editor would: no flourish and one or two hedges.',
  report: 'Write in a plain, practical voice, as a junior researcher would: past tense for what was done and varied sentence length.',
  short: 'Write a short exam answer, plain and direct, the way a student writes it under time pressure. Keep it slightly uneven.',
};
const AIM_LONG = 'Aim for 150 to 260 words.';
const AIM_SHORT = 'Aim for 90 to 140 words.';

// [id, genre, voice, topic, task, aim]. The topics are checked against the version 6 corpus ids when the plan is made.
const HUMAN = [
  ['hv01', 'student essay', 'student', 'flood plains in the Netherlands', 'Answer the question: why do people still build homes on flood plains in the Netherlands? Use one detail from a bus ride past a polder.', AIM_LONG],
  ['hv02', 'student essay', 'student', 'a four-day working week for shift workers', 'Argue whether a four-day working week suits shift workers. Pick a side, but admit one point against your own view.', AIM_LONG],
  ['hv03', 'student essay', 'student', 'handwritten letters', 'Discuss what is lost when people stop writing letters by hand. Mention the shoebox of postcards your grandmother kept.', AIM_LONG],
  ['hv04', 'student essay', 'student', 'the decline of the Hanseatic League', 'Explain three causes of the decline of the Hanseatic League, in order of importance, and say which one you find least convincing.', AIM_LONG],
  ['hv05', 'student essay', 'student', 'acoustics in Gothic cathedrals', 'How do Gothic cathedrals sound, and why? Keep to the physics you can explain yourself.', AIM_LONG],
  ['hv06', 'student essay', 'student', 'funding small public libraries', 'Are small public libraries worth keeping funded? Use the library in your home town as the main example.', AIM_LONG],
  ['hv07', 'student essay', 'student', 'adoption of the metric system in Britain', 'Why did Britain take so long to use metric measures in everyday life? Give a clear answer in your own words.', AIM_LONG],
  ['hv08', 'student essay', 'student', 'late opening hours for university libraries', 'Should university libraries stay open all night? Use the library in your own university as the example, and say you are not sure of the numbers.', AIM_LONG],
  ['hv09', 'reflection', 'reflect', 'learning to swim as an adult', 'Reflect on learning to swim at 34 at a municipal pool, with the lifeguard who kept shouting the same two words.', AIM_LONG],
  ['hv10', 'reflection', 'reflect', 'a summer job at a car wash', 'Reflect on a summer job at a car wash, the manager who timed everything, and the customer who always asked for the wax.', AIM_LONG],
  ['hv11', 'reflection', 'reflect', 'caring for a grandparent with hearing loss', 'Reflect on the phone calls with a grandparent whose hearing was going, and what you learned about speaking clearly.', AIM_LONG],
  ['hv12', 'reflection', 'reflect', 'a first shop in a foreign supermarket', 'Reflect on the first weeks in a new city, when you could not read the labels in the supermarket and bought the wrong flour.', AIM_LONG],
  ['hv13', 'reflection', 'reflect', 'a first bicycle puncture repair', 'Reflect on fixing a bicycle puncture for the first time with a borrowed patch kit, on the kerb outside a bakery.', AIM_LONG],
  ['hv14', 'blog post', 'blog', 'insulating a rented flat cheaply', 'Write a blog post about cheap ways to cut draughts in a rented flat: a draught excluder, bubble wrap, and asking the landlord first.', AIM_LONG],
  ['hv15', 'blog post', 'blog', 'a month of slow cooker dinners', 'Write a blog post about a month of cooking dinners only in a slow cooker, including the one stew that went badly.', AIM_LONG],
  ['hv16', 'blog post', 'blog', 'buying a secondhand film camera', 'Write a blog post about buying a secondhand film camera from an online listing and developing the first roll of film.', AIM_LONG],
  ['hv17', 'blog post', 'blog', 'running a jam stall at a Saturday market', 'Write a blog post about a first Saturday selling homemade jam at a market stall, the rain, and the cash tin.', AIM_LONG],
  ['hv18', 'blog post', 'blog', 'learning to knit socks from a video', 'Write a blog post about learning to knit socks from a video, and the moment the heel turn finally made sense.', AIM_LONG],
  ['hv19', 'email', 'email', 'a dripping radiator reported to the landlord', 'Write an email to a landlord about a bathroom radiator that has dripped for three weeks, reported twice already.', AIM_SHORT],
  ['hv20', 'email', 'email', 'a seminar group swap because of a work shift', 'Write an email to a lecturer asking to move to another seminar group because a work shift now clashes with the usual time.', AIM_SHORT],
  ['hv21', 'email', 'email', 'a pothole outside a flat', 'Write an email to the council about a pothole outside the flat that has grown since the winter and nearly caught a cyclist.', AIM_SHORT],
  ['hv22', 'encyclopedic paragraph', 'encyc', 'the Shetland pony', 'Write one encyclopedia-style paragraph on the Shetland pony: its origin, its size, and where it was once used.', AIM_LONG],
  ['hv23', 'encyclopedic paragraph', 'encyc', 'the Fresnel lens in lighthouses', 'Write one encyclopedia-style paragraph on the Fresnel lens used in lighthouses and how it throws light to sea.', AIM_LONG],
  ['hv24', 'report section', 'report', 'microplastics in tap water', 'Write a literature gist for a project report on microplastics found in tap water, with one caution about how the studies were measured.', AIM_LONG],
  ['hv25', 'report section', 'report', 'a commute stress pilot survey', 'Write the limitations section of a small pilot survey of 40 bus drivers about commute stress, noting the sample and the self-report.', AIM_LONG],
  ['hv26', 'report section', 'report', 'water meters in a student housing block', 'Write the results section for a survey of water meters in 23 flats in a student housing block, with readings taken in March.', AIM_LONG],
  ['hv27', 'short answer', 'short', 'why people yawn', 'Answer the exam question: why do we yawn?', AIM_SHORT],
  ['hv28', 'short answer', 'short', 'what a tidal lock is', 'Answer the exam question: what is a tidal lock?', AIM_SHORT],
  ['hv29', 'short answer', 'short', 'cache misses in a CPU', 'Answer the exam question: what causes a cache miss in a CPU, and why does it slow a program down?', AIM_SHORT],
  ['hv30', 'short answer', 'short', 'Roman roads and trade', 'Answer the exam question: why did the Roman road network matter for trade?', AIM_SHORT],
];

function humanPlan() {
  return HUMAN.map(([id, genre, voice, topic, task, aim]) => ({
    id,
    kind: 'humanvoice',
    genre,
    topic,
    voice,
    writer: WRITER,
    request: `${VOICE[voice]} ${task} ${AVOID} ${TAIL} ${aim}`,
  }));
}

/** The 15 rewrite sources: AI, train split, 150 to 380 words, chosen by a hash of the id (no choice by hand). */
function rewritePlan() {
  const rows = fs.readFileSync(CORPUS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const pool = rows
    .filter((r) => r.label === 'ai' && r.split === 'train' && words(r.text) >= 150 && words(r.text) <= 380)
    .sort((a, b) => (sha(`v7-rewrite|${a.id}`) < sha(`v7-rewrite|${b.id}`) ? -1 : 1))
    .slice(0, REWRITE_COUNT);
  return pool.map((src, i) => ({
    id: `rw${String(i + 1).padStart(2, '0')}`,
    kind: 'rewrite',
    genre: src.genre,
    topic: src.id,
    source: src.id,
    sourceWords: words(src.text),
    style: REWRITE_STYLES[i % REWRITE_STYLES.length],
    writer: WRITER,
    sourceText: src.text,
  }));
}

function plan() {
  return { version: 7, writer: WRITER, humanvoice: humanPlan(), rewrite: rewritePlan() };
}

if (require.main === module) {
  const p = plan();
  const ids = [...p.humanvoice, ...p.rewrite].map((x) => x.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate ids in the plan.');
  const byGenre = {};
  for (const h of p.humanvoice) byGenre[h.genre] = (byGenre[h.genre] || 0) + 1;
  const byStyle = {};
  for (const r of p.rewrite) byStyle[r.style] = (byStyle[r.style] || 0) + 1;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // The source text is kept out of plan.json: only its id, genre and length are written there.
  const file = { ...p, rewrite: p.rewrite.map(({ sourceText, ...rest }) => rest) };
  fs.writeFileSync(path.join(OUT_DIR, 'plan.json'), `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Plan written: ${p.humanvoice.length} humanvoice (${JSON.stringify(byGenre)}), ${p.rewrite.length} rewrite (${JSON.stringify(byStyle)}).`);
}

module.exports = { plan, humanPlan, rewritePlan, WRITER, VOICE, AVOID, TAIL };
