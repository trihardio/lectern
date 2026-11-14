'use strict';
// The kinds of work Lectern can do with one request. "answer" is the normal cited answer;
// the other four are research tools picked from the ask box. The window gets this list from
// /api/state, so the names and hints live in one place.

const MODES = [
  {
    id: 'answer', label: 'Answer', maxInput: 2000,
    blurb: 'A cited answer from the paper abstracts',
    placeholder: 'Ask a research question',
  },
  {
    id: 'review', label: 'Literature review', maxInput: 2000,
    blurb: 'A wider search and a structured report, with the search record',
    placeholder: 'Give the topic or question to review',
  },
  {
    id: 'trail', label: 'Citation snowballing', maxInput: 1500,
    blurb: 'Start from one to three papers: see what they cite and what cites them',
    placeholder: 'Paste the DOI or full title of each starting paper, one per line',
  },
  {
    id: 'claim', label: 'Reverse citation search', maxInput: 1500,
    blurb: 'Paste a statement: find papers that support or challenge it',
    placeholder: 'Paste the statement you want to support or test',
  },
  {
    id: 'verify', label: 'Verify citations', maxInput: 12000,
    blurb: 'Paste text with its citations: check each cited paper supports its claim',
    placeholder: 'Paste a paragraph with its citations, and the reference list if you have it',
  },
];

const byId = new Map(MODES.map((m) => [m.id, m]));
const modeOf = (id) => byId.get(id) || byId.get('answer');

module.exports = { MODES, modeOf };
