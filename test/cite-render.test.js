'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Cite = require('../shared/cite');
const { renderAnswer, splitFollowUps } = require('../ui/render');

const paper = {
  title: 'Citation as a measure of impact', year: 2019, venue: 'University of New South Wales Law Journal',
  volume: '42', issue: '2', pages: '517-541', doi: '10.5555/example.42', kind: 'Article',
  authors: [{ given: 'Katy Ann', family: 'Barnett' }, { given: 'Wei', family: 'Li' }],
};
const many = { ...paper, authors: [{ given: 'A', family: 'One' }, { given: 'B', family: 'Two' }, { given: 'C', family: 'Three' }, { given: 'D', family: 'Four' }] };

test('APA 7', () => {
  const out = Cite.format(paper, 'apa');
  assert.equal(out.text, 'Barnett, K. A., & Li, W. (2019). Citation as a measure of impact. University of New South Wales Law Journal, 42(2), 517–541. https://doi.org/10.5555/example.42');
  assert.match(out.html, /<i>University of New South Wales Law Journal<\/i>, <i>42<\/i>\(2\)/);
  assert.equal(Cite.apaInText(paper), '(Barnett & Li, 2019)');
  assert.equal(Cite.apaInText(many), '(One et al., 2019)');
});

test('Harvard, MLA and AGLC4', () => {
  assert.equal(Cite.format(paper, 'harvard').text, "Barnett, K.A. and Li, W. (2019) 'Citation as a measure of impact', University of New South Wales Law Journal, 42(2), pp. 517–541. doi:10.5555/example.42.");
  assert.equal(Cite.format(paper, 'mla').text, 'Barnett, Katy Ann, and Wei Li. “Citation as a measure of impact.” University of New South Wales Law Journal, vol. 42, no. 2, 2019, pp. 517–541. https://doi.org/10.5555/example.42.');
  assert.equal(Cite.format(paper, 'aglc').text, "Barnett, Katy Ann and Wei Li, 'Citation as a measure of impact' (2019) 42(2) University of New South Wales Law Journal 517");
  assert.match(Cite.format(many, 'aglc').text, /^One, A et al, /);
});

test('BibTeX and RIS', () => {
  const bib = Cite.format(paper, 'bibtex').text;
  assert.match(bib, /^@article\{barnett2019citation,/);
  assert.match(bib, /author = \{Barnett, Katy Ann and Li, Wei\}/);
  assert.match(bib, /pages = \{517--541\}/);
  const ris = Cite.format(paper, 'ris').text;
  assert.match(ris, /^TY {2}- JOUR\nAU {2}- Barnett, Katy Ann\nAU {2}- Li, Wei/);
  assert.match(ris, /SP {2}- 517\nEP {2}- 541/);
  assert.ok(ris.endsWith('ER  - '));
});

test('reference lists sort by author and keep BibTeX keys unique', () => {
  const list = Cite.formatList([many, paper], 'apa').text.split('\n\n');
  assert.ok(list[0].startsWith('Barnett'));
  const bib = Cite.formatList([paper, paper], 'bibtex').text;
  assert.match(bib, /barnett2019citation,/);
  assert.match(bib, /barnett2019citationa,/);
});

test('handles missing fields without stray punctuation', () => {
  const bare = { title: 'Untitled working paper', authors: [], year: null, kind: 'Preprint' };
  assert.equal(Cite.format(bare, 'apa').text, 'Untitled working paper. (n.d.).');
  assert.ok(!/undefined|null/.test(Cite.format(bare, 'harvard').text + Cite.format(bare, 'mla').text + Cite.format(bare, 'aglc').text));
});

test('answer rendering: citations become marks, bad numbers stay as text', () => {
  const { html, cited } = renderAnswer('Remote work helps [1][3]. Ranges work [2-4], lists too [1, 5]. Not a paper [99] or [note].', { paperCount: 5 });
  assert.deepEqual([...cited].sort(), [1, 2, 3, 4, 5]);
  assert.equal((html.match(/class="cite"/g) || []).length, 7);
  assert.match(html, /\[99\]/);
  assert.match(html, /\[note\]/);
});

test('answer rendering: structure and links', () => {
  const { html } = renderAnswer('Intro line.\n\n## What the research shows\n\n- **Bold** point [1]\n- Second\n\n1. One\n2. Two\n\nSee [the report](http://www.example.org/r/) and [W1].', {
    paperCount: 2, webSources: [{ url: 'https://example.org/w', title: 'Web page' }, { url: 'https://example.org/r', title: 'The report' }],
  });
  assert.match(html, /<h3>What the research shows<\/h3>/);
  assert.match(html, /<ul><li><strong>Bold<\/strong> point/);
  assert.match(html, /<ol><li>One<\/li><li>Two<\/li><\/ol>/);
  assert.match(html, /<a href="https:\/\/example\.org\/r" target="_blank" rel="noopener noreferrer">the report<\/a>/, 'a web source links to its own address');
  assert.match(html, /class="cite cite-web" href="https:\/\/example\.org\/w"[^>]* aria-label="Web page 1: Web page">W1</);
});

test('answer rendering: a link the model wrote is live only if the turn has that page as a web source', () => {
  const md = 'See [a report](https://example.org/report) and [a page from memory](https://made-up.example/x?a=1&b=2).';
  const none = renderAnswer(md, { paperCount: 0 }).html;
  assert.ok(!/<a /.test(none), 'web search off: no live links at all');
  assert.match(none, /See a report and a page from memory\./);
  const some = renderAnswer(md, { paperCount: 0, webSources: [{ url: 'https://example.org/report#top', title: 'Report' }] }).html;
  assert.match(some, /<a href="https:\/\/example\.org\/report#top"[^>]*>a report<\/a>/);
  assert.ok(!/made-up\.example/.test(some), 'the page from memory is plain text, not a link');
});

test('answer rendering: a stash marker the model writes itself prints nothing odd', () => {
  const { html } = renderAnswer('Odd \u00000\u0000 and \u00001\u0000 marks with `code`.', { paperCount: 0 });
  assert.ok(!/undefined/.test(html), html);
  assert.match(html, /<code>code<\/code>/);
});

test('BibTeX: braces, backslashes and TeX specials cannot break an entry; DOIs stay balanced', () => {
  const odd = { title: 'Braces } and \\input{x}: 50% & more_~^', year: 2020, venue: 'J. {Odd}', kind: 'Article',
    authors: [{ given: 'A', family: 'O\\Brien}' }], doi: '10.1000/a{b}' };
  const bib = Cite.format(odd, 'bibtex').text;
  assert.match(bib, /title = \{\{Braces \\\} and \\textbackslash\{\}input\\\{x\\\}: 50\\% \\& more\\_\\textasciitilde\{\}\\textasciicircum\{\}\}\}/);
  assert.match(bib, /author = \{O\\textbackslash\{\}Brien\\\}, A\}/);
  assert.match(bib, /doi = \{10\.1000\/a%7Bb%7D\}/);
  // Every entry's braces balance once escaped braces are left out.
  const plain = bib.replace(/\\[{}]/g, '');
  let depth = 0;
  for (const ch of plain) { if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0); }
  assert.equal(depth, 0);
});

test('answer rendering: nothing the model writes can inject HTML or scripts', () => {
  const nasty = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>alert(2)</script> **<b>x</b>**';
  const { html } = renderAnswer(nasty, { paperCount: 0 });
  assert.ok(!/<img|<script|<b>/.test(html));
  assert.ok(!/href="javascript/i.test(html));
  const web = renderAnswer('x [W1]', { paperCount: 0, webSources: [{ url: 'javascript:alert(1)', title: 't' }] }).html;
  assert.ok(!/href=/.test(web));
});

test('answer rendering: author-and-year marks come from the window, escaped, and fall back to the number', () => {
  const labels = { 1: 'Rahman & Aldous 2019', 2: '<i>Odd</i> "name" 2020' };
  const { html, cited } = renderAnswer('Gains for routine work [1], less so elsewhere [2][3].', { paperCount: 3, citeLabel: (n) => labels[n] });
  assert.deepEqual([...cited].sort(), [1, 2, 3]);
  assert.match(html, /class="cite named" data-n="1" aria-label="Paper 1: Rahman &amp; Aldous 2019">Rahman &amp; Aldous 2019</);
  assert.ok(!/<i>/.test(html) && html.includes('&lt;i&gt;Odd&lt;/i&gt; &quot;name&quot; 2020'));
  assert.match(html, /class="cite" data-n="3" aria-label="Paper 3">3</, 'no label: the number stays');
});

test('answer rendering: comparison tables, with citations and escaping inside cells', () => {
  const md = [
    'Before.', '',
    '| Kind of work | What changed | Papers |',
    '|---|:--|--:|',
    '| Call centre | **13%** more calls | [2] |',
    '| <script>x</script> | a \\| b |',
    '', 'After the table.',
  ].join('\n');
  const { html, cited } = renderAnswer(md, { paperCount: 2 });
  assert.match(html, /<table><thead><tr><th>Kind of work<\/th><th>What changed<\/th><th>Papers<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Call centre<\/td><td><strong>13%<\/strong> more calls<\/td><td><span class="cites"><button[^>]*data-n="2"/);
  assert.match(html, /<td>&lt;script&gt;x&lt;\/script&gt;<\/td><td>a \| b<\/td><td><\/td>/, 'short rows are padded; an escaped bar stays in its cell');
  assert.ok(!/<script/.test(html));
  assert.match(html, /<\/table><\/div>\n<p>After the table\.<\/p>/);
  assert.deepEqual([...cited], [2]);
  // A bar in ordinary prose, or a rule between paragraphs, is not a table.
  assert.ok(!/<table/.test(renderAnswer('either a | b\n\n---\n\nnext', { paperCount: 0 }).html));
});

test('follow-up questions are split from the answer as plain text', () => {
  const md = 'Answer [1].\n\n## Where the evidence is thin\n\nThin.\n\n## Worth following up\n\n- Does **hybrid** work differ [1]?\n- What about [managers](https://example.org/m)?\n- ok\n';
  const { body, followUps } = splitFollowUps(md);
  assert.deepEqual(followUps, ['Does hybrid work differ?', 'What about managers?']);
  assert.ok(body.endsWith('Thin.') && !/Worth following up/.test(body));
  // No such section, or prose under the heading: the answer is left whole.
  assert.deepEqual(splitFollowUps('Just an answer [1].'), { body: 'Just an answer [1].', followUps: [] });
  const prose = 'A.\n\n## Worth following up\n\nLook into hybrid schedules.';
  assert.deepEqual(splitFollowUps(prose), { body: prose, followUps: [] });
});

test('a missing web-source entry does not crash answer rendering', () => {
  const sources = [];
  sources[1] = { url: 'https://example.org/source', title: 'Source' };
  const result = renderAnswer('Evidence [W1] and [W2].', { paperCount: 0, webSources: sources });
  assert.match(result.html, /W1/);
  assert.match(result.html, /https:\/\/example.org\/source/);
});
