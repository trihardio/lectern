'use strict';
// Who the answers are written for: the reader's level of study and their field.
// The window gets only the ids and labels (through /api/state). The "write" text is
// the instruction added to the answer prompt, and stays on the server.
// The profile changes framing and depth only. It never filters or re-ranks papers.

const LEVELS = [
  {
    id: 'school', label: 'High school',
    write: 'The reader is a high school student. Use everyday words and short sentences. Define every technical term the first time it appears, and say in a few words what a study type means when you name one (for example, what a meta-analysis is).',
  },
  {
    id: 'foundation', label: 'Foundation or pre-university',
    write: 'The reader is in a foundation or pre-university programme. Assume no earlier study of the discipline. Define technical terms in a few words, and explain briefly why one kind of study is stronger evidence than another when it matters to the answer.',
  },
  {
    id: 'diploma', label: 'Diploma',
    write: 'The reader is a diploma student. Define technical terms briefly and bring out what the findings mean in practice, since applied understanding matters more to them than theory.',
  },
  {
    id: 'undergrad', label: 'Undergraduate (bachelor\'s)',
    write: 'The reader is an undergraduate. Use the discipline\'s standard terms and define only the less common ones. Where the papers support it, name the theories or concepts a coursework essay on this question would be expected to cover.',
  },
  {
    id: 'masters', label: 'Master\'s',
    write: 'The reader is a master\'s student. Assume they know the discipline\'s core concepts and do not define standard terms. Give more room to methods, how the key constructs were measured, and limitations. Point out gaps in the literature that could frame a dissertation.',
  },
  {
    id: 'phd', label: 'PhD or doctorate',
    write: 'The reader is a doctoral researcher. Write at specialist level and skip textbook background. Emphasise research design, identification and measurement, competing theoretical accounts, and what remains unresolved.',
  },
  {
    id: 'researcher', label: 'Academic or professional researcher',
    write: 'The reader is a working researcher. Write at specialist level, be brief, and skip background. Emphasise research design, the strength of the evidence, points of dispute, and what remains unresolved.',
  },
];

const FIELDS = [
  { id: 'business', label: 'Business and management' },
  { id: 'economics', label: 'Economics and finance' },
  { id: 'accounting', label: 'Accounting' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'computing', label: 'Computer science and IT' },
  { id: 'medicine', label: 'Medicine and health' },
  { id: 'biology', label: 'Biology and life sciences' },
  { id: 'physical', label: 'Physical sciences and mathematics' },
  { id: 'environment', label: 'Environmental science' },
  { id: 'psychology', label: 'Psychology' },
  { id: 'education', label: 'Education' },
  { id: 'social', label: 'Social sciences' },
  { id: 'law', label: 'Law' },
  { id: 'humanities', label: 'Arts and humanities' },
  { id: 'other', label: 'Other' },
];

const EMPTY = { level: '', field: '', fieldOther: '', asked: false };

/** Keep only known ids, and reduce the free-text field to one short plain line. */
function sanitize(p) {
  const src = p && typeof p === 'object' ? p : {};
  const level = LEVELS.some((l) => l.id === src.level) ? src.level : '';
  const field = FIELDS.some((f) => f.id === src.field) ? src.field : '';
  const fieldOther = field === 'other'
    ? String(src.fieldOther || '').replace(/[^\p{L}\p{N} ,&'()/+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';
  return { level, field, fieldOther, asked: src.asked === true };
}

/** The field as plain words ("Engineering"), or '' when it is not set. */
function fieldName(profile) {
  const p = sanitize(profile);
  if (p.field === 'other') return p.fieldOther;
  const f = FIELDS.find((x) => x.id === p.field);
  return f ? f.label : '';
}

function levelOf(profile) {
  return LEVELS.find((l) => l.id === sanitize(profile).level) || null;
}

/** What the window needs to draw the choices. */
function options() {
  return {
    levels: LEVELS.map(({ id, label }) => ({ id, label })),
    fields: FIELDS.map(({ id, label }) => ({ id, label })),
  };
}

module.exports = { LEVELS, FIELDS, EMPTY, sanitize, fieldName, levelOf, options };
