# Search benchmark run: x-base-q1

Split dev, 56 questions. Queries: file:bench/search/data/plans/x-base-q1.json (x-base-q1). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T19:06:46.315Z. Offline replay from the cache: 0 live requests, 392 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 15.4% (7.8% to 24.3%) | 16.2% (8.5% to 25.1%) | 15.0% (7.4% to 23.9%) | 10.9% (5.5% to 17.4%) | 0.123 | 13.6% (6.1% to 22.5%) | 57 |
| cs | 18 | 34.9% (14.1% to 57.2%) | 34.9% (14.0% to 57.1%) | 34.9% (14.0% to 57.1%) | 23.1% (8.5% to 40.3%) | 0.203 | 34.7% (13.9% to 56.9%) | 59 |
| environment-other | 3 | 2.7% (0.0% to 8.0%) | 1.7% (0.0% to 5.0%) | 1.5% (0.0% to 4.5%) | 2.0% (0.0% to 5.9%) | 0.024 | 0.0% (0.0% to 0.0%) | 54 |
| health | 24 | 6.2% (1.8% to 12.1%) | 7.9% (2.8% to 14.7%) | 6.0% (1.6% to 11.9%) | 4.4% (1.4% to 8.6%) | 0.065 | 2.6% (0.2% to 6.6%) | 55 |
| social-business-education | 11 | 7.0% (1.1% to 15.1%) | 7.5% (1.6% to 15.5%) | 6.0% (0.7% to 13.8%) | 7.4% (0.8% to 16.1%) | 0.145 | 6.7% (0.0% to 14.6%) | 57 |
| source: clef | 18 | 7.6% (1.8% to 15.2%) | 9.9% (3.1% to 18.5%) | 7.5% (1.7% to 15.1%) | 5.4% (1.4% to 10.8%) | 0.077 | 3.4% (0.1% to 8.4%) | 55 |
| source: litsearch | 15 | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 40.0% (20.0% to 66.7%) | 26.3% (9.5% to 46.0%) | 0.221 | 40.0% (20.0% to 66.7%) | 59 |
| source: synergy | 23 | 5.5% (1.9% to 9.9%) | 5.5% (1.9% to 9.9%) | 4.6% (1.3% to 8.9%) | 5.1% (1.6% to 9.8%) | 0.094 | 4.4% (0.7% to 8.7%) | 57 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 33 | 21 |
| semanticscholar | 15 | 3 |
| crossref | 6 | 2 |
