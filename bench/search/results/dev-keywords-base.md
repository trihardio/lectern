# Search benchmark run: dev-keywords-base

Split dev, 56 questions. Queries: keywords. Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T17:10:31.404Z. Live run: 0 live requests, 336 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 65.8 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 8.1% (3.0% to 14.8%) | 8.2% (3.1% to 14.9%) | 7.7% (2.6% to 14.4%) | 6.6% (2.3% to 12.4%) | 0.096 | 8.4% (3.3% to 15.1%) | 59 |
| cs | 18 | 17.6% (1.9% to 35.2%) | 17.6% (1.9% to 35.2%) | 17.6% (1.9% to 35.2%) | 14.4% (2.0% to 31.1%) | 0.177 | 18.2% (2.9% to 36.4%) | 60 |
| environment-other | 3 | 4.0% (0.0% to 8.0%) | 2.5% (0.0% to 5.0%) | 2.0% (0.0% to 4.5%) | 4.1% (0.0% to 8.9%) | 0.141 | 2.0% (0.0% to 4.5%) | 59 |
| health | 24 | 3.4% (1.6% to 5.7%) | 3.8% (1.8% to 6.2%) | 3.0% (1.2% to 5.3%) | 2.4% (1.2% to 3.8%) | 0.044 | 3.8% (1.8% to 6.2%) | 59 |
| social-business-education | 11 | 3.7% (0.0% to 8.1%) | 4.1% (0.0% to 9.3%) | 3.3% (0.0% to 7.8%) | 3.5% (0.0% to 8.3%) | 0.064 | 4.1% (0.5% to 9.3%) | 59 |
| source: clef | 18 | 3.9% (1.5% to 6.6%) | 4.2% (1.8% to 7.0%) | 3.5% (1.2% to 6.2%) | 2.6% (1.1% to 4.3%) | 0.048 | 4.3% (1.8% to 7.1%) | 58 |
| source: litsearch | 15 | 20.0% (0.0% to 40.0%) | 20.0% (0.0% to 40.0%) | 20.0% (0.0% to 40.0%) | 15.7% (0.0% to 35.7%) | 0.144 | 20.0% (0.0% to 40.0%) | 60 |
| source: synergy | 23 | 3.6% (1.4% to 6.2%) | 3.6% (1.2% to 6.7%) | 3.0% (0.9% to 5.6%) | 3.7% (1.2% to 6.8%) | 0.102 | 4.0% (1.3% to 7.4%) | 59 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 32 | 27 |
| semanticscholar | 11 | 6 |
| crossref | 4 | 3 |
