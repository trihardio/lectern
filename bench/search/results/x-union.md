# Search benchmark run: x-union

Split dev, 56 questions. Queries: file:bench/search/data/plans/x-union.json (x-union). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T19:20:34.887Z. Offline replay from the cache: 0 live requests, 1624 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 22.4% (13.8% to 31.8%) | 24.5% (15.8% to 34.0%) | 21.5% (12.9% to 31.0%) | 15.5% (9.6% to 22.4%) | 0.191 | 30.1% (21.4% to 39.6%) | 241 |
| cs | 18 | 45.8% (23.6% to 68.1%) | 47.3% (25.1% to 69.4%) | 45.8% (23.6% to 68.1%) | 27.3% (11.5% to 45.7%) | 0.227 | 49.6% (27.8% to 71.6%) | 235 |
| environment-other | 3 | 2.7% (0.0% to 4.0%) | 4.2% (0.0% to 7.5%) | 1.2% (0.0% to 2.3%) | 2.9% (0.0% to 5.3%) | 0.116 | 5.4% (3.7% to 6.8%) | 250 |
| health | 24 | 12.3% (7.0% to 18.8%) | 16.1% (9.1% to 24.6%) | 11.6% (6.3% to 18.3%) | 10.3% (6.1% to 15.4%) | 0.178 | 25.7% (17.2% to 35.7%) | 238 |
| social-business-education | 11 | 11.6% (4.7% to 20.2%) | 11.1% (5.1% to 18.8%) | 8.7% (3.7% to 15.2%) | 10.8% (3.8% to 19.8%) | 0.182 | 14.8% (6.4% to 24.7%) | 253 |
| source: clef | 18 | 14.3% (7.5% to 22.3%) | 19.0% (10.0% to 29.3%) | 13.9% (7.1% to 22.0%) | 11.7% (6.4% to 18.1%) | 0.183 | 30.3% (20.2% to 42.5%) | 231 |
| source: litsearch | 15 | 53.3% (26.7% to 80.0%) | 53.3% (26.7% to 80.0%) | 53.3% (26.7% to 80.0%) | 31.8% (14.0% to 52.2%) | 0.260 | 53.3% (26.7% to 80.0%) | 240 |
| source: synergy | 23 | 8.6% (4.6% to 13.5%) | 10.0% (5.8% to 15.0%) | 6.6% (3.4% to 10.4%) | 7.8% (4.0% to 12.6%) | 0.153 | 14.8% (9.0% to 21.4%) | 249 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 177 | 112 |
| semanticscholar | 82 | 20 |
| crossref | 15 | 4 |
