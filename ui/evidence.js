// Evidence views use database metadata and validated abstract readings; no model HTML or chart code.
(function () {
  'use strict';
  const E = window.LecternEvidence;
  const countLabel = (n) => `${n} paper${n === 1 ? '' : 's'}`;
  const TITLES = { supports: 'Supports', conditional: 'Depends on conditions', mixed: 'Mixed within study', against: 'Challenges', na: 'Not assessed' };
  const DESIGN = { randomised: 'Randomised', 'meta-analysis': 'Meta-analysis', 'systematic-review': 'Systematic review', observational: 'Observational', other: 'Other design', unclear: 'Unreported' };

  const KNOWN = (v) => !!v && v !== 'unclear';

  /**
   * Which evidence views this answer has enough data for. A view that would be mostly empty, or a
   * chart with a single bar, says less than the comparison table already does, so it is left out:
   *   compare    at least two relevant studies
   *   direction  'chart' when three or more studies report a direction, they are at least half of
   *              all studies, and they point more than one way; 'same' (a sentence) when they all
   *              point one way; for yes/no questions the stance reading is used the same way
   *   design     four or more studies with a known design, of at least two kinds
   *   coverage   three or more population groups, two or more methods, four or more filled cells
   */
  function plan(turn) {
    const papers = turn.papers || [];
    const none = { compare: false, direction: null, design: false, coverage: null, readings: [], relevant: [], charted: [] };
    if (!papers.length || turn.mode === 'verify') return none;
    const readings = E.cleanInsights({ papers: turn.insights || [] }, papers, { yesNo: turn.yesNo });
    const relevant = readings.filter((r) => r.relevant);
    const fact = (r, key) => r.facts[key]?.value || '';
    const charted = relevant.filter((r) => !['simulation', 'proposal'].includes(fact(r, 'evidenceStatus')));

    let direction = null;
    const known = charted.filter((r) => KNOWN(fact(r, 'direction')));
    if (known.length >= 3 && known.length * 2 >= charted.length) {
      direction = new Set(known.map((r) => fact(r, 'direction'))).size >= 2 ? 'chart' : 'same';
    } else if (turn.yesNo) {
      const judged = charted.filter((r) => r.stance !== 'na');
      if (judged.length >= 3) direction = new Set(judged.map((r) => r.stance)).size >= 2 ? 'stance' : 'same-stance';
    }

    const designs = charted.filter((r) => KNOWN(fact(r, 'designType')));
    const design = designs.length >= 4 && new Set(designs.map((r) => fact(r, 'designType'))).size >= 2;

    let coverage = null;
    const grid = E.coverage(papers, readings);
    const used = grid.columns.map((c, i) => grid.groups.some((g) => g.cells[i].length > 0));
    const filled = grid.groups.reduce((sum, g) => sum + g.cells.filter((ids, i) => used[i] && ids.length).length, 0);
    if (grid.groups.length >= 3 && used.filter(Boolean).length >= 2 && filled >= 4) coverage = { ...grid, used };

    return { compare: relevant.length >= 2, direction, design, coverage, readings, relevant, charted };
  }

  function build(turn, { h, label, inspect }) {
    const papers = turn.papers || [];
    const views = plan(turn);
    const readings = views.readings;
    const relevant = [...views.relevant].sort((a, b) => (turn.citeCounts?.get(b.n) || 0) - (turn.citeCounts?.get(a.n) || 0));
    const fact = (r, key) => r.facts[key]?.value || '';
    const charted = views.charted;
    const byN = new Map(papers.map((p) => [p.n, p]));
    const cite = (n) => h('button', { type: 'button', class: 'cite named', 'data-n': n,
      'data-stance': readings.find((r) => r.n === n)?.stance || 'na', 'aria-label': `Paper ${n}: ${label(n)}` }, label(n));
    const section = h('section', { class: 'evidence-workspace', 'aria-label': 'Explore the evidence' });
    if (!papers.length || turn.mode === 'verify') return section;

    const heading = (title, note) => h('div', { class: 'evidence-heading' }, h('h3', null, title), note && h('p', null, note));
    if (!readings.length) {
      section.append(h('div', { class: 'evidence-empty' }, heading('Compare the evidence', turn.running
        ? 'Reading abstracts to extract study designs, populations and findings…'
        : 'Structured study details are unavailable for this answer. Retry with “Read each paper” enabled to build the comparison and evidence map.')));
      return section;
    }

    // A guaranteed study table independent of whether the writer emits a markdown table.
    const comparison = h('section', { class: 'study-comparison', 'data-evidence-section': 'compare', tabindex: '-1' },
      heading('Where the studies agree — and differ', 'Read the finding alongside its design, setting and outcome. A null result, a loss and a gain can describe different questions.'));
    const tbody = h('tbody');
    const table = h('table', { class: 'comparison-table' },
      h('caption', { class: 'sr-only' }, 'Comparison of retrieved studies, their designs, settings and findings'),
      h('thead', null, h('tr', null, ['Study', 'Design & setting', 'Finding & measure'].map((t) => h('th', { scope: 'col' }, t)))), tbody);
    let all = false;
    const draw = () => {
      tbody.replaceChildren(...(all ? relevant : relevant.slice(0, 6)).map((r) => {
        const p = byN.get(r.n);
        const details = [['Design', fact(r, 'design') || r.design || 'Not stated'],
          ['Sample', fact(r, 'sample') || 'Not stated'], ['Setting', fact(r, 'setting') || 'Not stated']];
        const quotes = Object.entries(r.facts).filter(([key]) => ['result', 'measure', 'design', 'sample', 'population', 'timing', 'evidenceStatus'].includes(key));
        return h('tr', null,
          h('th', { scope: 'row' }, cite(r.n), h('span', { class: 'comparison-title' }, p.title), h('span', { class: 'study-kind' }, [p.kind || 'Study', fact(r, 'evidenceStatus')].filter(Boolean).join(' · '))),
          h('td', null, details.map(([key, value]) => h('div', { class: 'study-detail' }, h('small', null, key), h('span', null, value)))),
          h('td', null, h('span', { class: `result-tag ${r.stance}` }, fact(r, 'direction') || TITLES[r.stance]),
            h('p', { class: 'comparison-finding' }, fact(r, 'result') || r.finding || 'No finding extracted.'),
            h('div', { class: 'study-measure' }, h('strong', null, 'Measured: '), fact(r, 'measure') || 'Not stated in the extracted details'),
            quotes.length > 0 && h('details', { class: 'fact-quotes' }, h('summary', null, 'Inspect abstract excerpts'),
              quotes.map(([key, f]) => h('div', null, h('small', null, key), h('blockquote', null, f.quote))))));
      }));
    };
    draw(); comparison.append(h('div', { class: 'evidence-scroll', tabindex: '0', 'aria-label': 'Study comparison; scroll horizontally on a small screen' }, table));
    if (relevant.length > 6) {
      const more = h('button', { class: 'evidence-more', type: 'button', 'aria-expanded': 'false', onclick: () => {
        all = !all; draw(); more.textContent = all ? 'Show six studies' : `Compare all ${relevant.length} studies`; more.setAttribute('aria-expanded', String(all));
      } }, `Compare all ${relevant.length} studies`);
      comparison.append(more);
    }
    if (views.compare) section.append(comparison);

    const charts = h('section', { class: 'evidence-charts', 'data-evidence-section': 'charts', tabindex: '-1' });
    function barChart(title, items, note) {
      const max = Math.max(1, ...items.map((item) => item.ids.length));
      return h('figure', { class: 'evidence-chart' }, h('figcaption', null, title),
        h('ul', null, items.map(({ text, ids, key }) => h('li', null,
          h('button', { type: 'button', class: 'evidence-bar-row', disabled: !ids.length || null,
            title: `${text}: ${countLabel(ids.length)}. Show these references`, onclick: () => inspect(ids, text),
            'aria-label': `${text}: ${countLabel(ids.length)}. Show references` },
            h('span', { class: 'bar-label' }, text), h('span', { class: 'bar-track', 'aria-hidden': 'true' },
              h('span', { class: `bar-fill ${key || ''}`, style: `width:${ids.length / max * 100}%` })), h('b', null, ids.length))))),
        h('p', { class: 'evidence-caption' }, note));
    }
    const directions = [['higher', 'Higher outcome', 'supports'], ['lower', 'Lower outcome', 'against'],
      ['unchanged', 'No significant change', 'na'], ['mixed', 'Mixed within study', 'mixed']];
    const DIRECTION_WORDS = { higher: 'a higher outcome', lower: 'a lower outcome', unchanged: 'no significant change', mixed: 'mixed results within the study' };
    const nonzero = (items) => items.filter((item) => item.ids.length);
    const unreported = (n, what) => (n ? ` ${countLabel(n)} did not report ${what}, so ${n === 1 ? 'it is' : 'they are'} left out of this chart.` : '');
    if (views.direction === 'chart') {
      const known = charted.filter((r) => KNOWN(fact(r, 'direction')));
      charts.append(barChart('How the findings differ', nonzero(directions.map(([direction, text, key]) => ({ key, text,
        ids: known.filter((r) => fact(r, 'direction') === direction).map((r) => r.n) }))),
      `Reported directions of the question’s outcome. Counts are not a pooled effect: compare each study’s actual measure in the table.${unreported(charted.length - known.length, 'a direction')}`));
    } else if (views.direction === 'stance') {
      const judged = charted.filter((r) => r.stance !== 'na');
      charts.append(barChart('How the findings differ', nonzero(E.stances.filter((k) => k !== 'na').map((key) => ({ key, text: TITLES[key],
        ids: judged.filter((r) => r.stance === key).map((r) => r.n) }))),
      `Model reading of abstract findings. Paper counts are not a pooled effect or a vote on truth; designs and outcomes carry different weight.${unreported(charted.length - judged.length, 'a finding on this question')}`));
    } else if (views.direction === 'same' || views.direction === 'same-stance') {
      // Everything points one way: one sentence, not a one-bar chart.
      const rows = views.direction === 'same' ? charted.filter((r) => KNOWN(fact(r, 'direction'))) : charted.filter((r) => r.stance !== 'na');
      const what = views.direction === 'same' ? DIRECTION_WORDS[fact(rows[0], 'direction')] : TITLES[rows[0].stance].toLowerCase();
      const ids = rows.map((r) => r.n);
      charts.append(h('p', { class: 'evidence-stat' },
        h('button', { type: 'button', class: 'linkish', onclick: () => inspect(ids, 'Same direction') }, `All ${countLabel(ids.length)}`),
        views.direction === 'same' ? ` that report a direction found ${what}.` : ` judged on this question: ${what}.`,
        ' Agreement among the papers found is not proof: compare their designs and measures in the table.'));
    }
    if (views.design) {
      const known = charted.filter((r) => KNOWN(fact(r, 'designType')));
      const designKeys = [...new Set(known.map((r) => fact(r, 'designType')))];
      charts.append(barChart('What kinds of evidence?', designKeys.map((key) => ({ key: 'by-design', text: DESIGN[key],
        ids: known.filter((r) => fact(r, 'designType') === key).map((r) => r.n) })).sort((a, b) => b.ids.length - a.ids.length),
      `Designs extracted from abstract excerpts.${unreported(charted.length - known.length, 'a design')}`));
    }
    if (charts.childNodes.length) section.append(charts);

    const map = views.coverage;
    if (map) {
      const cols = map.columns.map((c, i) => ({ ...c, i })).filter((c) => map.used[c.i]); // no all-empty columns
      const coverage = h('section', { class: 'coverage-section', 'data-evidence-section': 'coverage', tabindex: '-1' },
        heading('Evidence coverage', 'Which populations and methods are represented in this retrieved set? Select a cell to inspect its papers.'));
      const grid = h('table', { class: 'coverage-table' },
        h('caption', { class: 'sr-only' }, 'Counts of retrieved papers by reported population and evidence characteristic'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Population'), cols.map((c) => h('th', { scope: 'col' }, c.label)))),
        h('tbody', null, map.groups.map((g) => h('tr', null, h('th', { scope: 'row' }, g.label),
          cols.map((c) => {
            const ids = g.cells[c.i];
            return h('td', null, h('button', { type: 'button', class: `coverage-cell${ids.length ? '' : ' empty'}`,
              style: `--density:${ids.length / map.max}`, disabled: !ids.length || null,
              'aria-label': `${g.label}, ${c.label}: ${countLabel(ids.length)}${ids.length ? '. Show references' : ' tagged in this set'}`,
              onclick: () => inspect(ids, `${g.label} · ${c.label}`) },
              h('span', null, ids.length ? countLabel(ids.length) : 'No tagged papers'), !ids.length && h('small', null, 'Not established here')));
          })))));
      coverage.append(h('div', { class: 'evidence-scroll', tabindex: '0', 'aria-label': 'Evidence coverage; scroll horizontally on a small screen' }, grid));
      coverage.append(h('p', { class: 'evidence-caption' }, `${countLabel(map.total)} judged relevant; ${map.unclassified} without an extracted population. ${map.excluded ? `${map.excluded} simulated/proposed papers excluded. ` : ''}Cells can overlap. Empty cells indicate missing tags in this search, not proof of a gap across all research.`));
      section.append(coverage);
    }
    return section;
  }
  window.LecternEvidenceUI = { build, plan };
})();
