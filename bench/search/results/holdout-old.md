# Search benchmark run: holdout-old

Split holdout, 57 questions. Queries: file:bench/search/data/plans/holdout-plan-base-orig.json (holdout-plan-base-orig). Databases: openalex, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-18T06:01:14.293Z. Live run: 66 live requests, 618 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-18): 68 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 57 | 14.6% (7.0% to 23.5%) | 17.0% (8.8% to 26.1%) | 14.2% (6.6% to 23.1%) | 10.5% (4.8% to 17.3%) | 0.154 | 19.9% (11.7% to 28.9%) | 120 |
| cs | 18 | 38.9% (16.7% to 61.1%) | 44.6% (22.4% to 66.8%) | 38.9% (16.7% to 61.1%) | 25.7% (9.5% to 44.0%) | 0.224 | 44.6% (22.4% to 66.8%) | 120 |
| environment-other | 3 | 0.0% (0.0% to 0.0%) | 1.7% (0.0% to 5.0%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) | 0.018 | 4.2% (0.0% to 7.7%) | 124 |
| health | 25 | 4.5% (2.7% to 6.5%) | 5.3% (3.2% to 7.7%) | 3.7% (2.1% to 5.6%) | 4.7% (2.5% to 7.4%) | 0.176 | 10.6% (6.5% to 15.7%) | 118 |
| social-business-education | 11 | 2.0% (0.4% to 4.0%) | 2.5% (0.3% to 5.0%) | 1.7% (0.2% to 3.6%) | 1.5% (0.3% to 2.9%) | 0.026 | 4.7% (1.6% to 8.6%) | 123 |
| source: clef | 18 | 4.8% (2.5% to 7.4%) | 5.8% (3.0% to 8.8%) | 4.2% (2.0% to 6.7%) | 5.4% (2.4% to 8.7%) | 0.217 | 11.6% (6.1% to 18.2%) | 117 |
| source: litsearch | 15 | 46.7% (20.0% to 73.3%) | 53.3% (26.7% to 80.0%) | 46.7% (20.0% to 73.3%) | 30.9% (12.2% to 51.8%) | 0.266 | 53.3% (26.7% to 80.0%) | 119 |
| source: synergy | 24 | 2.0% (0.8% to 3.3%) | 2.7% (1.3% to 4.2%) | 1.5% (0.6% to 2.6%) | 1.6% (0.7% to 2.6%) | 0.036 | 5.1% (3.1% to 7.3%) | 123 |

Gold papers in these questions: 1298. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| crossref | 30 | 23 |
| openalex | 63 | 56 |
