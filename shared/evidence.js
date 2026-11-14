// Evidence classifications are tied to real paper ids and exact excerpts of supplied abstracts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LecternEvidence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const enums = {
    evidenceStatus: ['observed', 'synthesis', 'simulation', 'proposal', 'unclear'],
    measurement: ['objective', 'self-report', 'both', 'unclear'],
    designType: ['randomised', 'meta-analysis', 'systematic-review', 'observational', 'other', 'unclear'],
    timing: ['pandemic', 'non-pandemic', 'mixed', 'unclear'],
    arrangement: ['remote', 'hybrid', 'mixed', 'unclear'],
    direction: ['higher', 'lower', 'unchanged', 'mixed', 'unclear'],
  };
  const fields = ['population', 'setting', 'measure', 'design', 'sample', 'result', ...Object.keys(enums)];
  const text = (v, max) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const normal = (v) => text(v, 100000).toLowerCase();
  const stances = ['supports', 'conditional', 'mixed', 'against', 'na'];

  function cleanInsights(raw, papers, { yesNo = false } = {}) {
    const rows = Array.isArray(raw?.papers) ? raw.papers : [];
    const byN = new Map(papers.map((p) => [p.n, p]));
    const seen = new Set();
    return rows.flatMap((r) => {
      if (!r || !Number.isInteger(Number(r.n))) return [];
      const n = Number(r.n), p = byN.get(n);
      if (!p || seen.has(n)) return [];
      seen.add(n);
      // Only the abstract/summary supplied to the reader can substantiate a new classification.
      const source = normal(p.abstract ? p.abstract.slice(0, 1700) : p.tldr || '');
      const facts = {};
      for (const key of fields) {
        const f = r.facts?.[key];
        if (!f || typeof f !== 'object') continue;
        const value = text(f.value, key === 'result' ? 220 : 100);
        const quote = text(f.quote, 360);
        if (!value || quote.length < 8 || !source.includes(normal(quote))) continue;
        if (enums[key] && !enums[key].includes(value)) continue;
        facts[key] = { value, quote };
      }
      return [{ n, relevant: r.relevant !== false,
        stance: yesNo && r.relevant !== false && stances.includes(r.stance) ? r.stance : 'na',
        finding: text(r.finding, 320), design: text(r.design, 64), sample: text(r.sample, 80), facts }];
    });
  }

  function coverage(papers, insights) {
    const relevant = cleanInsights({ papers: insights }, papers, { yesNo: true }).filter((r) => r.relevant);
    const rows = relevant.filter((r) => !['simulation', 'proposal'].includes(r.facts.evidenceStatus?.value));
    const f = (r, key) => r.facts[key]?.value || '';
    const hasPandemic = rows.some((r) => ['pandemic', 'mixed'].includes(f(r, 'timing')));
    const columns = [
      { id: 'objective', label: 'Objective measures', test: (r) => ['objective', 'both'].includes(f(r, 'measurement')) },
      { id: 'self-report', label: 'Self-report', test: (r) => ['self-report', 'both'].includes(f(r, 'measurement')) },
      { id: 'randomised', label: 'Randomised design', test: (r) => f(r, 'designType') === 'randomised' },
      { id: 'review', label: 'Research synthesis', test: (r) => ['meta-analysis', 'systematic-review'].includes(f(r, 'designType')) },
      hasPandemic
        ? { id: 'pandemic', label: 'Pandemic period', test: (r) => ['pandemic', 'mixed'].includes(f(r, 'timing')) }
        : { id: 'observational', label: 'Observational', test: (r) => f(r, 'designType') === 'observational' },
    ];
    const groups = new Map();
    for (const r of rows) {
      const label = f(r, 'population');
      if (!label) continue;
      const key = normal(label);
      if (!groups.has(key)) groups.set(key, { label, papers: [], cells: columns.map(() => []) });
      const group = groups.get(key);
      group.papers.push(r.n);
      columns.forEach((c, i) => { if (c.test(r)) group.cells[i].push(r.n); });
    }
    return { columns: columns.map(({ id, label }) => ({ id, label })), groups: [...groups.values()],
      unclassified: rows.filter((r) => !f(r, 'population')).length,
      total: rows.length, excluded: relevant.length - rows.length, max: Math.max(1, ...[...groups.values()].flatMap((g) => g.cells.map((c) => c.length))) };
  }

  return { cleanInsights, coverage, stances };
});
