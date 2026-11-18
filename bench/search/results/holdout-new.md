# Search benchmark run: holdout-new

Split holdout, 57 questions. Queries: file:bench/search/data/plans/holdout-plan-base.json (baseline). Databases: openalex, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-18T06:10:26.738Z. Live run: 342 live requests, 285 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-18): 296 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 57 | 21.2% (12.7% to 30.7%) | 22.0% (13.5% to 31.5%) | 20.5% (11.9% to 30.0%) | 15.4% (8.9% to 23.4%) | 0.182 | 18.3% (10.2% to 27.5%) | 102 |
| cs | 18 | 50.0% (27.8% to 72.2%) | 50.0% (27.8% to 72.2%) | 50.0% (27.8% to 72.2%) | 34.7% (15.5% to 55.5%) | 0.309 | 44.5% (22.3% to 66.7%) | 104 |
| environment-other | 3 | 2.6% (0.0% to 7.7%) | 2.6% (0.0% to 7.7%) | 2.6% (0.0% to 7.7%) | 2.4% (0.0% to 7.2%) | 0.073 | 4.2% (0.0% to 7.7%) | 104 |
| health | 25 | 9.9% (5.6% to 14.5%) | 11.5% (7.1% to 16.2%) | 8.6% (4.4% to 13.2%) | 7.8% (4.6% to 11.2%) | 0.128 | 7.8% (4.9% to 10.7%) | 99 |
| social-business-education | 11 | 4.8% (1.6% to 8.8%) | 5.5% (1.2% to 10.7%) | 4.2% (1.1% to 8.0%) | 4.8% (1.6% to 8.9%) | 0.128 | 3.4% (1.0% to 6.0%) | 107 |
| source: clef | 18 | 11.9% (6.3% to 17.8%) | 13.3% (7.5% to 19.4%) | 10.4% (5.0% to 16.2%) | 9.3% (5.3% to 13.7%) | 0.151 | 7.6% (4.0% to 11.5%) | 100 |
| source: litsearch | 15 | 60.0% (33.3% to 86.7%) | 60.0% (33.3% to 86.7%) | 60.0% (33.3% to 86.7%) | 41.6% (20.0% to 64.6%) | 0.369 | 53.3% (26.7% to 80.0%) | 103 |
| source: synergy | 24 | 3.9% (1.9% to 6.3%) | 4.8% (2.4% to 7.6%) | 3.4% (1.5% to 5.7%) | 3.7% (1.7% to 6.0%) | 0.089 | 4.5% (2.5% to 6.5%) | 104 |

Gold papers in these questions: 1298. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 67 | 63 |
| crossref | 16 | 12 |
