# Search benchmark run: x-base-nonull

Split dev, 56 questions. Queries: file:bench/search/data/plans/x-base-nonull.json (x-base-nonull). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T19:04:43.633Z. Offline replay from the cache: 0 live requests, 824 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 18.0% (10.6% to 26.6%) | 19.0% (11.5% to 27.6%) | 17.1% (9.6% to 25.8%) | 12.7% (7.6% to 18.9%) | 0.171 | 19.0% (11.5% to 27.6%) | 124 |
| cs | 18 | 34.7% (13.4% to 56.9%) | 35.1% (14.3% to 57.3%) | 34.7% (13.4% to 56.9%) | 21.7% (7.6% to 39.0%) | 0.181 | 35.3% (14.4% to 57.3%) | 131 |
| environment-other | 3 | 5.3% (0.0% to 8.0%) | 4.2% (0.0% to 7.5%) | 2.5% (0.0% to 4.5%) | 5.4% (0.0% to 8.1%) | 0.139 | 3.2% (0.0% to 6.8%) | 122 |
| health | 24 | 10.7% (6.2% to 16.5%) | 13.1% (7.6% to 20.0%) | 10.0% (5.4% to 15.9%) | 8.2% (5.3% to 11.6%) | 0.150 | 13.3% (8.3% to 19.2%) | 120 |
| social-business-education | 11 | 10.0% (4.0% to 17.3%) | 9.6% (4.5% to 16.2%) | 7.8% (2.8% to 14.5%) | 9.8% (3.4% to 17.7%) | 0.207 | 9.1% (2.9% to 16.5%) | 124 |
| source: clef | 18 | 12.0% (6.0% to 19.2%) | 15.4% (8.2% to 24.0%) | 11.5% (5.5% to 18.8%) | 8.8% (5.2% to 13.1%) | 0.158 | 14.8% (8.5% to 22.3%) | 116 |
| source: litsearch | 15 | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 25.1% (9.2% to 44.3%) | 0.207 | 40.0% (20.0% to 66.7%) | 134 |
| source: synergy | 23 | 8.3% (5.0% to 12.3%) | 8.1% (4.9% to 11.9%) | 6.5% (3.6% to 10.1%) | 7.6% (4.3% to 11.8%) | 0.157 | 8.5% (4.7% to 12.8%) | 125 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 86 | 53 |
| semanticscholar | 43 | 12 |
| crossref | 15 | 5 |
