# Search benchmark run: dev-plan-c1

Split dev, 56 questions. Queries: file:bench/search/data/plans/dev-plan-c1.json (dev-plan-c1). Databases: openalex, semanticscholar, crossref. Keys used: OpenAlex, Semantic Scholar (values never stored).
Code: commit f41450c, finished 2026-11-17T18:58:31.438Z. Live run: 61 live requests, 896 cache hits, 0 model calls.
OpenAlex search calls used today by the team (UTC 2026-11-17): 693.2 of 750 allowed.

Capped recall divides by min(gold papers, k); the other recall divides by all gold papers. Intervals are 95% bootstrap over questions.

| Group | n | Recall@25 (capped) | Recall@40 (capped) | Recall@25 (all gold) | nDCG@25 | MRR | Found anywhere | Mean pool |
|---|---|---|---|---|---|---|---|---|
| All | 56 | 17.9% (10.1% to 26.6%) | 18.3% (10.6% to 27.0%) | 17.1% (9.2% to 25.8%) | 13.4% (7.8% to 20.0%) | 0.192 | 20.7% (12.8% to 29.3%) | 144 |
| cs | 18 | 35.4% (14.3% to 57.4%) | 35.6% (14.7% to 57.2%) | 34.9% (13.6% to 56.9%) | 21.6% (8.1% to 37.8%) | 0.184 | 37.1% (16.8% to 58.7%) | 142 |
| environment-other | 3 | 2.7% (0.0% to 4.0%) | 2.9% (2.5% to 3.7%) | 1.2% (0.0% to 2.3%) | 4.4% (0.0% to 7.8%) | 0.261 | 2.9% (2.3% to 3.7%) | 153 |
| health | 24 | 11.4% (5.2% to 19.2%) | 12.4% (6.1% to 20.2%) | 10.8% (4.7% to 18.7%) | 11.0% (4.8% to 18.8%) | 0.211 | 15.4% (8.7% to 23.7%) | 145 |
| social-business-education | 11 | 7.8% (1.2% to 16.2%) | 7.3% (1.1% to 15.2%) | 5.8% (0.8% to 12.7%) | 7.7% (0.8% to 16.7%) | 0.143 | 10.0% (2.4% to 19.4%) | 144 |
| source: clef | 18 | 14.8% (6.8% to 24.5%) | 16.0% (7.9% to 25.8%) | 14.1% (6.1% to 23.9%) | 14.3% (6.4% to 24.0%) | 0.271 | 19.4% (11.0% to 29.9%) | 143 |
| source: litsearch | 15 | 40.0% (13.3% to 66.7%) | 40.0% (13.3% to 66.7%) | 40.0% (13.3% to 66.7%) | 23.6% (7.7% to 42.6%) | 0.191 | 40.0% (13.3% to 66.7%) | 143 |
| source: synergy | 23 | 6.0% (2.3% to 10.5%) | 6.0% (2.4% to 10.3%) | 4.5% (1.6% to 8.2%) | 6.0% (2.2% to 10.7%) | 0.131 | 9.0% (4.2% to 14.6%) | 146 |

Gold papers in these questions: 1182. Per database, summed over questions (found = returned by that database for any query; unique = returned by that database only):

| Database | Gold found | Gold found only here |
|---|---|---|
| openalex | 114 | 83 |
| semanticscholar | 37 | 7 |
| crossref | 11 | 6 |
