'use strict';
// The plan of the version 5 corpus (bench/PREREGISTRATION.md, version 5): which texts the Claude agents write, with
// which request, and which split each text belongs to. Deterministic: the same plan every time, written before any
// text exists. Texts are saved as bench/data/review5/texts/<id>.txt (git-ignored).
//
//   node bench/review5/plan.js            prints the plan as JSON (also written to bench/data/review5/plan.json)

const fs = require('fs');
const path = require('path');

const GENRES = ['essay', 'labreport', 'litreview', 'abstract', 'reflection', 'blog'];
const STYLES = ['plain', 'student', 'humanlike', 'esl', 'concise'];

// 13 topics per genre: 1-5 for Haiku, 6-10 for Sonnet, 11-13 for the edited drafts (written by Sonnet).
const TOPICS = {
  essay: ['Should universities replace final exams with continuous assessment', 'Is remote work good for junior employees', 'Should plastic bags be banned nationwide', 'Do standardized tests predict success at university', 'Should voting be compulsory', 'Is social media harming the mental health of teenagers', 'Should cities make public transport free', 'Is nuclear power necessary to meet climate targets', 'Should homework be abolished in primary school', 'Is a four-day work week realistic', 'Should zoos exist', 'Are electric cars really greener than petrol cars', 'Should university tuition be free'],
  labreport: ['The effect of temperature on catalase activity', 'Measuring the acceleration due to gravity with a simple pendulum', 'Titrating vinegar to find its acetic acid concentration', 'The effect of light intensity on the rate of photosynthesis in Elodea', 'Measuring the specific heat capacity of aluminium', 'Osmosis in potato cylinders across sucrose concentrations', "Ohm's law and the resistance of a nichrome wire", 'The rate of reaction of magnesium with hydrochloric acid', 'The antibacterial effect of garlic extract on E. coli plates', 'Simple harmonic motion of a mass on a spring', 'Paper chromatography of plant pigments', 'The effect of exercise on heart rate', 'The density of sugar solutions and their refractive index'],
  litreview: ['Sleep deprivation and memory consolidation', 'Mobile phone bans in schools and academic performance', 'Microplastics in freshwater fish', 'Gamification in language-learning apps', 'Urban green space and mental health', 'Intermittent fasting and weight loss', 'Peer tutoring in undergraduate mathematics', 'Remote patient monitoring for heart failure', 'Bilingualism and executive function', 'Carbon pricing and emission reductions', 'Music therapy for people with dementia', 'Flipped classrooms in engineering education', 'Algorithmic bias in hiring tools'],
  abstract: ['A machine learning model to predict hospital readmission', "A survey of first-year students' study habits", 'Drought tolerance genes in sorghum', 'The effect of new bike lanes on traffic accidents in a mid-sized city', 'A low-cost water filter made from rice husk ash', 'Sentiment analysis of tweets about vaccination', 'Corrosion resistance of coated steel in seawater', 'Teacher burnout after the pandemic', 'Changes in the soil microbiome under no-till farming', 'Energy use in student dormitories', 'Reading comprehension with e-books versus paper books', 'Graph neural networks for predicting molecular properties', 'The impact of a minimum wage increase on small restaurants'],
  reflection: ['Failing my first programming assignment', 'A group project that went wrong', 'Volunteering at a food bank', 'My first time presenting at a conference', 'Moving to a new country for university', 'Working part-time while studying', 'Learning a musical instrument as an adult', 'A clinical placement on a busy hospital ward', 'Leading a student club', 'A teacher who changed my mind about mathematics', 'Recovering from a sports injury', 'Taking a gap year', 'Learning to cook for myself'],
  blog: ['Why I stopped using a to-do list app', 'The case for public libraries', 'How to survive your first week at university', 'What nobody tells you about learning a language', 'Is coffee bad for you', 'Why board games are having a comeback', 'How to write a better CV', 'The hidden cost of fast fashion', 'Why you should walk more', 'Budgeting on a student income', 'What I wish I had known before buying a used car', 'How to read more books', 'Gardening on a small balcony'],
};

const GENRE_ASK = {
  essay: (t) => `Write an argumentative essay for an undergraduate course on the question "${t}?"`,
  labreport: (t) => `Write the Discussion section of an undergraduate lab report on the experiment "${t}". Invent plausible results and refer to them.`,
  litreview: (t) => `Write a short literature review section for a student research paper on "${t}", citing studies in author-year form.`,
  abstract: (t) => `Write the abstract of a research paper on "${t}".`,
  reflection: (t) => `Write a reflective essay for a university course about "${t}", in the first person.`,
  blog: (t) => `Write a blog post on the theme "${t}".`,
};
const STYLE_ASK = {
  plain: '',
  student: 'Write it the way a second-year university student would write it themselves, including one specific personal example.',
  humanlike: 'Make it read naturally, as a person would write it: vary the sentence length, use contractions where they fit, and avoid stock phrases and clichés.',
  esl: 'Write it as a student whose first language is not English would write it, at about B2 level: simple vocabulary and a few unusual but understandable phrasings.',
  concise: 'Keep it concise and direct, with no filler.',
};
const FORMAT = 'Plain paragraphs only: no title, headings, bullet points or Markdown.';
const EDIT_ASK = 'Then revise the draft the way a student does who got it from an AI tool and edits it by hand before handing it in: rewrite roughly a third of the sentences in plainer, more personal words; cut one or two sentences; add one concrete detail of your own; split or join a few sentences; leave the other sentences exactly as they were. Keep plain paragraphs.';

const words = (genre, k) => (genre === 'abstract' ? [220, 260, 300] : [300, 400, 500])[k % 3];
const brief = (genre, topic, style, n) => [GENRE_ASK[genre](topic), STYLE_ASK[style], `About ${n} words.`, FORMAT].filter(Boolean).join(' ');

function plan() {
  const items = [];
  GENRES.forEach((genre, g) => {
    STYLES.forEach((style, s) => {
      // Haiku and Sonnet take complementary halves, so every style is in both splits for both writers.
      items.push({ id: `hk-${genre}-${style}`, writer: 'claude-haiku-5-5', label: 'ai', genre, style, topic: TOPICS[genre][s], targetWords: words(genre, s), split: (g + s) % 2 === 0 ? 'dev' : 'test' });
      items.push({ id: `sn-${genre}-${style}`, writer: 'claude-sonnet-5-5', label: 'ai', genre, style, topic: TOPICS[genre][5 + s], targetWords: words(genre, s + 1), split: (g + s) % 2 === 1 ? 'dev' : 'test' });
    });
    for (let k = 0; k < 3; k++) {
      const style = ['plain', 'student', 'humanlike'][k];
      items.push({ id: `ed-${genre}-${k + 1}`, writer: 'claude-sonnet-5-5', label: 'edited', genre, style, topic: TOPICS[genre][10 + k], targetWords: words(genre, k + 2), split: (g + k) % 2 === 0 ? 'dev' : 'test', edit: EDIT_ASK });
    }
  });
  for (const it of items) it.brief = brief(it.genre, it.topic, it.style, it.targetWords);
  return items;
}

const DATA = path.join(__dirname, '..', 'data', 'review5');
if (require.main === module) {
  const items = plan();
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'plan.json'), JSON.stringify(items, null, 1));
  console.log(JSON.stringify(items.map(({ id, split, brief: b, edit }) => ({ id, split, brief: b, edit: !!edit })), null, 1));
}
module.exports = { plan, GENRES, STYLES, TOPICS, EDIT_ASK, DATA };
