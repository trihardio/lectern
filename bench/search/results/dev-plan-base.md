# Search benchmark run: dev-plan-base

Split dev, 56 questions. Queries: file:bench/search/data/plans/dev-plan-base.json (dev-plan-base). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T18:23:32.482Z. Live run: 0 live requests, 1008 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 506.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 16.8% (9.4% to 25.5%) | 18.1% (10.7% to 26.8%) | 16.2% (8.7% to 24.9%) | 12.0% (6.9% to 18.2%) | 0.169 | 20.5% (12.9% to 29.1%) | 161 |
| cs | 18 | 34.7% (13.9% to 56.9%) | 35.1% (14.3% to 57.3%) | 34.7% (13.9% to 56.9%) | 22.0% (7.8% to 39.0%) | 0.183 | 35.7% (15.3% to 57.8%) | 162 |
| environment-other | 3 | 2.7% (0.0% to 4.0%) | 3.3% (0.0% to 5.0%) | 1.2% (0.0% to 2.3%) | 2.2% (0.0% to 3.3%) | 0.052 | 3.2% (0.0% to 6.8%) | 162 |
| health | 24 | 9.2% (5.1% to 14.3%) | 11.8% (6.9% to 18.0%) | 8.7% (4.6% to 13.8%) | 7.6% (4.5% to 11.1%) | 0.179 | 16.3% (10.3% to 23.3%) | 155 |
| social-business-education | 11 | 8.1% (2.9% to 13.8%) | 8.2% (3.2% to 14.2%) | 6.1% (1.9% to 10.9%) | 8.0% (2.4% to 14.6%) | 0.160 | 9.6% (3.2% to 17.3%) | 171 |
| source: clef | 18 | 10.5% (5.1% to 16.9%) | 13.7% (7.5% to 21.5%) | 10.1% (4.7% to 16.7%) | 8.5% (4.6% to 13.0%) | 0.208 | 18.6% (11.1% to 27.4%) | 150 |
| source: litsearch | 15 | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 25.3% (9.1% to 44.6%) | 0.209 | 40.0% (20.0% to 66.7%) | 165 |
| source: synergy | 23 | 6.7% (3.6% to 10.3%) | 7.4% (4.2% to 11.0%) | 5.4% (2.6% to 8.5%) | 6.1% (3.0% to 9.7%) | 0.113 | 9.3% (5.1% to 14.0%) | 166 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 92 | 53 |
| semanticscholar | 57 | 20 |
| crossref | 17 | 6 |
