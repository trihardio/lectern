'use strict';
// The plan of the version 6 AI texts (bench/PREREGISTRATION.md, version 6): which model writes which text, from which
// plain request, and what the group is (a topic or a request never crosses two splits). Deterministic and written
// before any text exists. Texts are saved as bench/data/v6/texts/<id>.txt (git-ignored).
//
//   node bench/v6/data-plan.js     prints the plan summary and writes bench/data/v6/plan.json
//
// The owner's own test topics (Star Wars, Jabba, Jedi, Crocs, Beast Boy, Star Trek) are left out on purpose: they
// stay a final check only. 56 encyclopedic topics each have a human Wikipedia introduction on the SAME topic (from a
// revision before 2022-11-30), so the hard false-positive case is matched topic for topic.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'v6');

// [group id, topic shown to the writer, English Wikipedia title (for the matched human text), kind]
const ENCYCLOPEDIC = [
  // pop culture
  ['the-beatles', 'The Beatles', 'The Beatles', 'popculture'], ['minecraft', 'the video game Minecraft', 'Minecraft', 'popculture'],
  ['taylor-swift', 'Taylor Swift', 'Taylor Swift', 'popculture'], ['the-simpsons', 'the TV series The Simpsons', 'The Simpsons', 'popculture'],
  ['pokemon', 'the Pokémon franchise', 'Pokémon', 'popculture'], ['nirvana', 'the band Nirvana', 'Nirvana (band)', 'popculture'],
  ['super-mario-bros', 'the video game Super Mario Bros.', 'Super Mario Bros.', 'popculture'], ['friends-tv', 'the TV sitcom Friends', 'Friends', 'popculture'],
  ['tetris', 'the puzzle game Tetris', 'Tetris', 'popculture'], ['lego', 'the toy company Lego', 'Lego', 'popculture'],
  // history
  ['black-death', 'the Black Death', 'Black Death', 'history'], ['great-fire-london', 'the Great Fire of London', 'Great Fire of London', 'history'],
  ['battle-hastings', 'the Battle of Hastings', 'Battle of Hastings', 'history'], ['apollo-11', 'the Apollo 11 mission', 'Apollo 11', 'history'],
  ['magna-carta', 'the Magna Carta', 'Magna Carta', 'history'], ['industrial-revolution', 'the Industrial Revolution', 'Industrial Revolution', 'history'],
  ['berlin-wall', 'the fall of the Berlin Wall', 'Berlin Wall', 'history'], ['cuban-missile-crisis', 'the Cuban Missile Crisis', 'Cuban Missile Crisis', 'history'],
  ['printing-press', "Gutenberg's printing press", 'Printing press', 'history'], ['silk-road', 'the Silk Road', 'Silk Road', 'history'],
  // science
  ['photosynthesis', 'photosynthesis', 'Photosynthesis', 'science'], ['black-hole', 'black holes', 'Black hole', 'science'],
  ['plate-tectonics', 'plate tectonics', 'Plate tectonics', 'science'], ['crispr', 'CRISPR gene editing', 'CRISPR', 'science'],
  ['penicillin', 'penicillin', 'Penicillin', 'science'], ['octopus', 'the octopus', 'Octopus', 'science'],
  ['honey-bee', 'the honey bee', 'Western honey bee', 'science'], ['coral-reef', 'coral reefs', 'Coral reef', 'science'],
  ['mitochondrion', 'the mitochondrion', 'Mitochondrion', 'science'], ['tardigrade', 'tardigrades', 'Tardigrade', 'science'],
  // places
  ['eiffel-tower', 'the Eiffel Tower', 'Eiffel Tower', 'places'], ['machu-picchu', 'Machu Picchu', 'Machu Picchu', 'places'],
  ['grand-canyon', 'the Grand Canyon', 'Grand Canyon', 'places'], ['venice', 'the city of Venice', 'Venice', 'places'],
  ['iceland', 'Iceland', 'Iceland', 'places'], ['lake-baikal', 'Lake Baikal', 'Lake Baikal', 'places'],
  ['singapore', 'Singapore', 'Singapore', 'places'], ['petra', 'the ancient city of Petra', 'Petra', 'places'],
  ['kilimanjaro', 'Mount Kilimanjaro', 'Mount Kilimanjaro', 'places'], ['angkor-wat', 'Angkor Wat', 'Angkor Wat', 'places'],
  // products
  ['iphone', 'the Apple iPhone', 'IPhone', 'products'], ['coca-cola', 'Coca-Cola', 'Coca-Cola', 'products'],
  ['post-it', 'the Post-it Note', 'Post-it Note', 'products'], ['vw-beetle', 'the Volkswagen Beetle', 'Volkswagen Beetle', 'products'],
  ['walkman', 'the Sony Walkman', 'Walkman', 'products'], ['kindle', 'the Amazon Kindle', 'Amazon Kindle', 'products'],
  ['nutella', 'Nutella', 'Nutella', 'products'], ['rubiks-cube', "the Rubik's Cube", "Rubik's Cube", 'products'],
  // people
  ['marie-curie', 'Marie Curie', 'Marie Curie', 'people'], ['ada-lovelace', 'Ada Lovelace', 'Ada Lovelace', 'people'],
  ['nelson-mandela', 'Nelson Mandela', 'Nelson Mandela', 'people'], ['leonardo', 'Leonardo da Vinci', 'Leonardo da Vinci', 'people'],
  ['serena-williams', 'Serena Williams', 'Serena Williams', 'people'], ['frida-kahlo', 'Frida Kahlo', 'Frida Kahlo', 'people'],
  ['alan-turing', 'Alan Turing', 'Alan Turing', 'people'], ['bach', 'Johann Sebastian Bach', 'Johann Sebastian Bach', 'people'],
];

// Variants of the request for an encyclopedic text; chosen by position so every writer gets a mix.
const ENC_ASK = [
  (t, n) => `Write an encyclopedia-style introduction to ${t}. About ${n} words.`,
  (t, n) => `Explain ${t} to me in a few paragraphs. Around ${n} words.`,
  (t, n) => `Write a plain, human-sounding paragraph about ${t}, the way a well-read person would explain it to a friend. No stock phrases. About ${n} words.`,
  (t, n) => `Write about ${t} like a student writing for a class assignment. Roughly ${n} words.`,
  (t, n) => `Give me a short overview of ${t}, in about ${n} words.`,
  (t, n) => `Write the opening section of an article about ${t}. About ${n} words.`,
];
const LENGTHS = [120, 160, 200, 250, 300, 350];

const SHORT_ANSWERS = ['Why is the sky blue?', 'How do vaccines work?', 'What causes inflation?', 'Why do cats purr?', 'How does a refrigerator keep food cold?', 'What is the difference between weather and climate?', 'Why do we dream?', 'How do airplanes stay in the air?', 'What is a blockchain?', 'Why is the ocean salty?', 'How does compound interest work?', 'What happened to the dinosaurs?', 'How do noise-cancelling headphones work?', 'Is it better to rent or buy a home?'];
const ESSAYS = ['Should schools start later in the morning', 'Is a college degree still worth the cost', 'Should animal testing for cosmetics be banned', 'Does money buy happiness', 'Should the voting age be lowered to 16', 'Are video games good for children', 'Should junk food be taxed', 'Is space exploration worth the money', 'Should cars be banned from city centres', 'Is online learning as good as classroom learning', 'Should people be paid to donate blood', 'Should museums return artefacts to their countries of origin', 'Is it ethical to eat meat', 'Should English be the only language of instruction in universities'];
const REPORTS = ['the Findings section of a short report on customer complaints at a small cafe over six months', 'the executive summary of a report on switching an office to LED lighting', 'the Recommendations section of a report on a city bike-share pilot', 'the Background section of a report on a school recycling programme', 'an incident summary for a warehouse near-miss involving a forklift', 'a project status update on a website redesign that is two weeks behind schedule', 'the Methods section of a survey of gym members about opening hours', 'a risk assessment paragraph for an outdoor community festival', 'the Conclusion of a market analysis for a food truck business', 'the Introduction of a report on remote onboarding for new hires'];
const EMAILS = ['an email to a professor asking for a two-day extension on an essay because of a family illness', 'an email to a landlord complaining that the heating has been broken for a week', 'a follow-up email after a job interview for a marketing assistant role', 'an email to the team announcing the office is moving to a new building next month', 'an email to a shop asking for a refund on a faulty blender', 'a polite reminder to a client about an overdue invoice', 'an email introducing a new colleague to the department', 'an email declining a wedding invitation because of a work trip', 'a thank-you email to a mentor who helped with a career change', 'an email asking a former teacher for a letter of recommendation'];
const BLOGS = ['Five mistakes beginner runners make', 'What I learned from baking sourdough for a year', 'Why I switched to a standing desk', 'A weekend in Lisbon on a budget', 'How to start a vegetable garden', 'Why old video games still matter', 'Tips for travelling with a toddler', 'The joy of second-hand bookshops', 'Morning routines that actually work', 'Why I deleted my social media apps', 'Choosing your first road bike', 'How to learn guitar as an adult'];

const OTHER_STYLE = [
  { id: 'plain', add: '' }, { id: 'humantone', add: 'Use a plain, human tone.' }, { id: 'student', add: 'Write like a student.' },
  { id: 'concise', add: 'Keep it concise and direct.' }, { id: 'plain', add: '' },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const FORMAT = 'Reply with the text only, as plain paragraphs: no title, headings, bullet points or Markdown, and no comment before or after it.';
const EMAIL_FORMAT = 'Reply with the email text only (greeting, body, sign-off), with no subject line and no comment before or after it.';

function plan() {
  const items = [];
  // Writers for the 56 encyclopedic topics: Haiku 24, Sonnet 26, Opus 6, interleaved by position.
  const encWriters = [];
  const counts = { 'claude-haiku-5-5': 24, 'claude-sonnet-5-5': 26, 'claude-opus-5-5': 6 };
  const order = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  for (let i = 0; encWriters.length < 56; i++) { const w = order[i % order.length]; if (counts[w] > 0) { counts[w]--; encWriters.push(w); } else if (Object.values(counts).every((c) => c === 0)) break; }
  while (encWriters.length < 56) { const w = Object.keys(counts).find((k) => counts[k] > 0); counts[w]--; encWriters.push(w); }
  ENCYCLOPEDIC.forEach(([group, topic, wiki, kind], i) => {
    const v = (i * 5 + Math.floor(i / 6)) % ENC_ASK.length;
    const n = LENGTHS[(i * 7 + 2) % LENGTHS.length];
    items.push({ id: `${tag(encWriters[i])}-enc-${group}`, writer: encWriters[i], genre: 'encyclopedic', kind, group: `topic:${group}`, topic, wiki, style: ['intro', 'explain', 'humantone', 'student', 'brief', 'opening'][v], targetWords: n, brief: `${ENC_ASK[v](topic, n)} ${FORMAT}` });
  });
  // Other genres: 60 texts, Haiku 26 and Sonnet 34, alternating inside each genre.
  const others = [];
  SHORT_ANSWERS.forEach((q, i) => others.push({ genre: 'shortanswer', topic: q, n: [90, 120, 150][i % 3], ask: (s, n) => `${q} Answer in about ${n} words. ${s.add}`, fmt: FORMAT }));
  ESSAYS.forEach((q, i) => others.push({ genre: 'essay', topic: q, n: [250, 300, 350, 400][i % 4], ask: (s, n) => `Write an argumentative essay on the question "${q}?" About ${n} words. ${s.add}`, fmt: FORMAT }));
  REPORTS.forEach((q, i) => others.push({ genre: 'report', topic: q, n: [150, 200, 250][i % 3], ask: (s, n) => `Write ${q}. About ${n} words. ${s.add}`, fmt: FORMAT }));
  EMAILS.forEach((q, i) => others.push({ genre: 'email', topic: q, n: [100, 150, 200][i % 3], ask: (s, n) => `Write ${q}. About ${n} words. ${s.add}`, fmt: EMAIL_FORMAT }));
  BLOGS.forEach((q, i) => others.push({ genre: 'blog', topic: q, n: [250, 300, 350][i % 3], ask: (s, n) => `Write a blog post titled "${q}", without the title line. About ${n} words. ${s.add}`, fmt: FORMAT }));
  // 26 Haiku, 34 Sonnet: Sonnet on 6 of every 10 by position.
  const sonnetAt = (i) => [1, 3, 5, 7, 8, 9].includes(i % 10);
  let h = 0; let s = 0;
  others.forEach((o, i) => {
    let writer = sonnetAt(i) ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
    if (writer === 'claude-sonnet-5-5' && s >= 34) writer = 'claude-haiku-5-5';
    if (writer === 'claude-haiku-5-5' && h >= 26) writer = 'claude-sonnet-5-5';
    if (writer === 'claude-haiku-5-5') h++; else s++;
    const st = OTHER_STYLE[i % OTHER_STYLE.length];
    items.push({ id: `${tag(writer)}-${o.genre.slice(0, 3)}-${slug(o.topic)}`, writer, genre: o.genre, kind: o.genre, group: `topic:${o.genre}:${slug(o.topic)}`, topic: o.topic, style: st.id, targetWords: o.n, brief: `${o.ask(st, o.n).replace(/\s+/g, ' ').trim()} ${o.fmt}` });
  });
  return items;
}
function tag(w) { return { 'claude-haiku-5-5': 'hk', 'claude-sonnet-5-5': 'sn', 'claude-opus-5-5': 'op' }[w]; }

if (require.main === module) {
  const items = plan();
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'plan.json'), JSON.stringify(items, null, 1));
  const c = {};
  for (const it of items) { c[it.writer] = (c[it.writer] || 0) + 1; c[`genre:${it.genre}`] = (c[`genre:${it.genre}`] || 0) + 1; }
  const ids = new Set(items.map((x) => x.id));
  console.log(items.length, 'texts,', ids.size, 'distinct ids', JSON.stringify(c));
}
module.exports = { plan, DATA, ENCYCLOPEDIC, tag };
