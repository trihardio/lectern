'use strict';
// The markdown summary written next to each run.

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const cell = (g, m) => (g && g[m] ? `${pct(g[m].mean)} (${pct(g[m].lo)} to ${pct(g[m].hi)})` : 'n/a');

function renderSummary(meta, s) {
  const L = [];
  L.push(`# Search benchmark run: ${meta.label}`, '');
  L.push(`Split ${meta.split}, ${meta.n} questions. Queries: ${meta.queriesMode}${meta.planLabel ? ` (${meta.planLabel})` : ''}. Databases: ${meta.sources.join(', ')}. Keys used: ${meta.keys.openalex ? 'OpenAlex' : 'none for OpenAlex'}, ${meta.keys.semanticscholar ? 'Semantic Scholar' : 'none for Semantic Scholar'} (values never stored).`);
  L.push(`Code: commit ${meta.code.commit || 'unknown'}, finished ${meta.finished}. ${meta.offline ? 'Offline replay from the cache' : 'Live run'}: ${meta.liveRequests} live requests, ${meta.cacheHits} cache hits, ${meta.modelCalls} model calls.`);
  L.push(`OpenAlex search calls used today by the team (UTC ${meta.counters.day}): ${meta.counters.openalexCostToday} of ${meta.counters.openalexStop} allowed.`);
  if (meta.skippedNoPlan.length) L.push(`Skipped, no plan: ${meta.skippedNoPlan.length} (${meta.skippedNoPlan.slice(0, 5).join(', ')}${meta.skippedNoPlan.length > 5 ? ', ...' : ''}).`);
  if (meta.incomplete.length) L.push(`**Incomplete: ${meta.incomplete.length} questions had a database error. Do not compare this run.**`);
  L.push('', 'Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.', '');
  const rows = [['All', s.overall], ...Object.entries(s.byDiscipline).map(([k, v]) => [k, v]), ...Object.entries(s.bySource).map(([k, v]) => [`source: ${k}`, v])];
  L.push('| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |', '|---|---|---|---|---|---|---|---|---|');
  for (const [name, g] of rows) {
    L.push(`| ${name} | ${g.n} | ${cell(g, 'recall@25')} | ${cell(g, 'recall@40')} | ${cell(g, 'recallAll@25')} | ${cell(g, 'ndcg@25')} | ${g.mrr ? g.mrr.mean.toFixed(3) : 'n/a'} | ${cell(g, 'foundAnywhere')} | ${g.pool === null ? 'n/a' : g.pool.toFixed(0)} |`);
  }
  L.push('', `Gold papers in these questions: ${s.goldTotal}. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):`, '');
  L.push('| Database | Gold found | Gold found only here |', '|---|---|---|');
  for (const [name, c] of Object.entries(s.perDatabase)) L.push(`| ${name} | ${c.found} | ${c.unique} |`);
  return L.join('\n') + '\n';
}

module.exports = { renderSummary, pct };
