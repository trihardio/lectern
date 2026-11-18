# Search benchmark run: x-c1-plus-baseq1

Split dev, 56 questions. Queries: file:bench/search/data/plans/x-c1-plus-baseq1.json (x-c1-plus-baseq1). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T19:28:25.348Z. Offline replay from the cache: 0 live requests, 1176 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 20.9% (12.3% to 30.6%) | 21.6% (12.9% to 31.3%) | 20.2% (11.5% to 29.9%) | 14.8% (8.6% to 21.9%) | 0.187 | 25.5% (16.7% to 34.9%) | 176 |
| cs | 18 | 47.2% (25.0% to 69.4%) | 47.1% (24.9% to 69.4%) | 46.8% (24.6% to 69.1%) | 29.0% (13.4% to 47.0%) | 0.243 | 48.7% (27.2% to 70.5%) | 171 |
| environment-other | 3 | 2.7% (0.0% to 4.0%) | 2.9% (2.5% to 3.7%) | 1.2% (0.0% to 2.3%) | 2.9% (0.0% to 4.4%) | 0.120 | 2.9% (2.3% to 3.7%) | 186 |
| health | 24 | 9.7% (4.1% to 17.0%) | 11.5% (5.5% to 18.9%) | 9.2% (3.5% to 16.5%) | 9.0% (3.6% to 15.9%) | 0.174 | 16.8% (9.7% to 25.6%) | 178 |
| social-business-education | 11 | 7.4% (0.8% to 16.1%) | 6.8% (0.9% to 14.5%) | 5.6% (0.7% to 12.5%) | 7.5% (0.6% to 16.7%) | 0.143 | 12.9% (4.5% to 22.9%) | 178 |
| source: clef | 18 | 12.3% (5.1% to 21.6%) | 14.9% (7.1% to 24.1%) | 11.7% (4.4% to 21.2%) | 11.5% (4.6% to 20.1%) | 0.221 | 21.1% (12.3% to 32.0%) | 175 |
| source: litsearch | 15 | 53.3% (26.7% to 80.0%) | 53.3% (26.7% to 80.0%) | 53.3% (26.7% to 80.0%) | 32.2% (14.4% to 52.6%) | 0.264 | 53.3% (26.7% to 80.0%) | 173 |
| source: synergy | 23 | 6.6% (2.5% to 11.4%) | 6.2% (2.4% to 10.7%) | 5.1% (1.7% to 9.4%) | 6.1% (2.1% to 10.9%) | 0.111 | 10.8% (5.3% to 17.2%) | 179 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 132 | 95 |
| semanticscholar | 43 | 7 |
| crossref | 11 | 6 |
