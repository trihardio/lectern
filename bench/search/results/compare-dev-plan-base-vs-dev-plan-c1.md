# Compare dev-plan-base (A) with dev-plan-c1 (B)

Split dev. Questions in both runs: 56; complete in both: 56. Only in A: 0; only in B: 0.
A: queries file:bench/search/data/plans/dev-plan-base.json (dev-plan-base), code f41450c; B: queries file:bench/search/data/plans/dev-plan-c1.json (dev-plan-c1), code f41450c.

### All questions (n = 56)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 16.8% | 17.9% | +1.1% | -6.4% to +8.4% | 38.3% |
| recall@40 | 18.1% | 18.3% | +0.2% | -7.2% to +7.5% | 48.1% |
| recallAll@25 | 16.2% | 17.1% | +0.9% | -6.5% to +8.1% | 39.9% |
| recallAll@40 | 17.9% | 18.1% | +0.2% | -7.2% to +7.6% | 48.3% |
| ndcg@25 | 12.0% | 13.4% | +1.4% | -4.5% to +6.7% | 29.7% |
| mrr | 0.169 | 0.192 | +0.022 | -0.066 to +0.109 | 29.8% |
| foundAnywhere | 20.5% | 20.7% | +0.1% | -7.6% to +7.6% | 48.7% |

### discipline: cs (n = 18)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 34.7% | 35.4% | +0.6% | -21.6% to +22.4% | 48.1% |
| recall@40 | 35.1% | 35.6% | +0.4% | -21.8% to +22.3% | 48.0% |
| recallAll@25 | 34.7% | 34.9% | +0.2% | -22.0% to +22.2% | 49.8% |
| recallAll@40 | 35.1% | 35.5% | +0.4% | -21.8% to +22.2% | 48.0% |
| ndcg@25 | 22.0% | 21.6% | -0.4% | -17.0% to +13.4% | 49.9% |
| mrr | 0.183 | 0.184 | +0.001 | -0.161 to +0.142 | 47.4% |
| foundAnywhere | 35.7% | 37.1% | +1.4% | -20.8% to +23.2% | 42.8% |

### discipline: health (n = 24)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 9.2% | 11.4% | +2.2% | -1.8% to +6.5% | 15.3% |
| recall@40 | 11.8% | 12.4% | +0.6% | -3.5% to +4.9% | 39.9% |
| recallAll@25 | 8.7% | 10.8% | +2.1% | -1.6% to +6.1% | 14.1% |
| recallAll@40 | 11.7% | 12.3% | +0.6% | -3.4% to +4.8% | 39.4% |
| ndcg@25 | 7.6% | 11.0% | +3.4% | -1.7% to +9.2% | 10.4% |
| mrr | 0.179 | 0.211 | +0.033 | -0.138 to +0.201 | 34.2% |
| foundAnywhere | 16.3% | 15.4% | -1.0% | -6.9% to +4.6% | 62.1% |

### discipline: social-business-education (n = 11)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 8.1% | 7.8% | -0.3% | -5.7% to +4.4% | 53.2% |
| recall@40 | 8.2% | 7.3% | -0.9% | -5.6% to +3.4% | 63.4% |
| recallAll@25 | 6.1% | 5.8% | -0.3% | -5.1% to +4.0% | 54.2% |
| recallAll@40 | 7.5% | 6.5% | -1.1% | -5.6% to +2.8% | 67.6% |
| ndcg@25 | 8.0% | 7.7% | -0.3% | -4.6% to +3.4% | 53.2% |
| mrr | 0.160 | 0.143 | -0.017 | -0.059 to +0.024 | 77.6% |
| foundAnywhere | 9.6% | 10.0% | +0.5% | -6.7% to +6.1% | 41.8% |
