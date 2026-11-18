# Search benchmark run: x-c1-q1

Split dev, 56 questions. Queries: file:bench/search/data/plans/x-c1-q1.json (x-c1-q1). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T19:08:48.964Z. Offline replay from the cache: 0 live requests, 392 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 10.7% (5.1% to 17.7%) | 11.1% (5.5% to 18.1%) | 10.1% (4.5% to 17.1%) | 9.5% (4.8% to 15.6%) | 0.157 | 11.0% (5.2% to 18.0%) | 55 |
| cs | 18 | 18.9% (3.2% to 36.9%) | 19.0% (3.3% to 37.1%) | 18.4% (2.6% to 36.0%) | 16.1% (2.6% to 32.7%) | 0.189 | 19.6% (4.0% to 38.1%) | 54 |
| environment-other | 3 | 1.3% (0.0% to 4.0%) | 1.2% (0.0% to 3.7%) | 1.2% (0.0% to 3.7%) | 1.0% (0.0% to 2.9%) | 0.022 | 1.7% (0.0% to 3.7%) | 59 |
| health | 24 | 7.5% (2.9% to 13.4%) | 8.4% (4.0% to 14.1%) | 7.1% (2.5% to 13.0%) | 7.1% (3.1% to 12.1%) | 0.161 | 8.1% (3.1% to 14.8%) | 56 |
| social-business-education | 11 | 6.7% (0.8% to 14.3%) | 6.8% (1.2% to 14.6%) | 5.3% (0.7% to 12.1%) | 6.4% (0.7% to 14.2%) | 0.132 | 5.5% (0.7% to 13.1%) | 53 |
| source: clef | 18 | 9.8% (3.9% to 17.4%) | 11.0% (5.4% to 18.3%) | 9.3% (3.5% to 16.8%) | 9.3% (4.1% to 15.7%) | 0.206 | 10.7% (4.2% to 19.4%) | 56 |
| source: litsearch | 15 | 20.0% (0.0% to 40.0%) | 20.0% (0.0% to 40.0%) | 20.0% (0.0% to 40.0%) | 16.2% (0.0% to 35.3%) | 0.150 | 20.0% (0.0% to 40.0%) | 53 |
| source: synergy | 23 | 5.3% (1.7% to 9.6%) | 5.4% (1.8% to 9.9%) | 4.2% (1.3% to 7.9%) | 5.4% (1.4% to 10.4%) | 0.124 | 5.3% (1.5% to 10.1%) | 55 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 52 | 41 |
| semanticscholar | 15 | 5 |
| crossref | 5 | 2 |
