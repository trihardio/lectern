# Compare holdout-old (A) with holdout-new (B)

Split holdout. Questions in both runs: 57; complete in both: 57. Only in A: 0; only in B: 0.
A: queries file:bench/search/data/plans/holdout-plan-base-orig.json (holdout-plan-base-orig), code f41450c; B: queries file:bench/search/data/plans/holdout-plan-base.json (baseline), code f41450c.

### All questions (n = 57)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 14.6% | 21.2% | +6.5% | +2.3% to +12.2% (B better) | 0.0% |
| recall@40 | 17.0% | 22.0% | +5.0% | +2.0% to +9.4% (B better) | 0.0% |
| recallAll@25 | 14.2% | 20.5% | +6.3% | +2.0% to +11.9% (B better) | 0.0% |
| recallAll@40 | 16.8% | 21.9% | +5.0% | +2.0% to +9.4% (B better) | 0.0% |
| ndcg@25 | 10.5% | 15.4% | +5.0% | -0.1% to +10.9% | 3.0% |
| mrr | 0.154 | 0.182 | +0.029 | -0.047 to +0.107 | 23.2% |
| foundAnywhere | 19.9% | 18.3% | -1.5% | -3.2% to -0.2% (B worse) | 99.3% |

### discipline: cs (n = 18)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 38.9% | 50.0% | +11.1% | +0.0% to +27.8% | 12.1% |
| recall@40 | 44.6% | 50.0% | +5.4% | -0.4% to +16.7% | 35.4% |
| recallAll@25 | 38.9% | 50.0% | +11.1% | +0.0% to +27.8% | 12.1% |
| recallAll@40 | 44.5% | 50.0% | +5.5% | -0.2% to +16.7% | 35.4% |
| ndcg@25 | 25.7% | 34.7% | +9.0% | -6.6% to +26.5% | 14.9% |
| mrr | 0.224 | 0.309 | +0.085 | -0.094 to +0.287 | 19.6% |
| foundAnywhere | 44.6% | 44.5% | -0.1% | -0.2% to +0.0% | 100.0% |

### discipline: health (n = 25)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 4.5% | 9.9% | +5.4% | +1.6% to +9.4% (B better) | 0.3% |
| recall@40 | 5.3% | 11.5% | +6.1% | +2.8% to +9.7% (B better) | 0.0% |
| recallAll@25 | 3.7% | 8.6% | +4.9% | +1.4% to +8.8% (B better) | 0.3% |
| recallAll@40 | 5.2% | 11.2% | +6.0% | +2.7% to +9.6% (B better) | 0.0% |
| ndcg@25 | 4.7% | 7.8% | +3.1% | +0.3% to +5.9% (B better) | 1.6% |
| mrr | 0.176 | 0.128 | -0.047 | -0.149 to +0.034 | 84.7% |
| foundAnywhere | 10.6% | 7.8% | -2.9% | -6.6% to -0.0% (B worse) | 97.7% |

### discipline: social-business-education (n = 11)

| Metric | A | B | B minus A | 95% interval | Resamples where B is not better |
|---|---|---|---|---|---|
| recall@25 | 2.0% | 4.8% | +2.8% | +0.0% to +6.2% | 3.1% |
| recall@40 | 2.5% | 5.5% | +3.0% | -0.7% to +7.4% | 6.8% |
| recallAll@25 | 1.7% | 4.2% | +2.5% | +0.0% to +5.8% | 3.1% |
| recallAll@40 | 2.4% | 5.4% | +3.0% | -0.7% to +7.3% | 6.8% |
| ndcg@25 | 1.5% | 4.8% | +3.4% | +0.6% to +7.0% (B better) | 0.1% |
| mrr | 0.026 | 0.128 | +0.102 | +0.021 to +0.198 (B better) | 0.1% |
| foundAnywhere | 4.7% | 3.4% | -1.3% | -3.3% to +0.0% | 100.0% |
