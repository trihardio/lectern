# Benchmark for finding papers

This folder measures whether Lectern's search finds the papers that matter for a question: the databases, the merge, the
ranking and the queries. It runs Lectern's real search code on 113 questions whose relevant papers were chosen by experts,
and scores the ranked list. Read `PREREGISTRATION.md` first: it fixes the metrics and the rule for "improved" before any
tuning. Tune on **dev** only. The **holdout** is frozen and runs once, when the project lead says go.

## Quick start (agents B, C and D)

Everything below runs from the repository root. The data and the cache are already on this computer
(`bench/search/data/`, git-ignored).

```
# 1. The reference run: pipeline.keywords(question), one query, no model. Live, with the owner's saved keys.
node bench/search/run.js --split dev --queries keywords --label dev-keywords-base --use-saved-keys

# 2. Replay any run offline from the cache (free, identical numbers if the code is unchanged).
node bench/search/run.js --split dev --queries keywords --label try1 --offline

# 3. Planner output from a file (agent D records it): {"version":1,"label":"...","plans":{"<id>":{"queries":["..."],"yesNo":true,"topic":"..."}}}
node bench/search/run.js --split dev --queries file:bench/search/data/plans/d1.json --label d1 --use-saved-keys

# 4. Ranking change (agent C): edit the ranking code, then replay the SAME queries on the SAME cached answers.
#    Use the plans recorded by the baseline run, so only the ranking differs:
node bench/search/run.js --split dev --queries file:bench/search/results/dev-keywords-base.plans.json --label c1 --offline

# 5. Compare two runs: paired bootstrap, B minus A. Add --by discipline (or source) for the groups, --write to save it.
node bench/search/compare.js dev-keywords-base c1 --by discipline --write
```

Running an OLD version of the code (for the final old-against-new comparison), read-only, with no stash, checkout or worktree:
```
OLD=<an empty scratch folder>
git archive f41450c server shared package.json | tar -x -C $OLD        # package.json: server/util.js reads the version from it
node bench/search/run.js --split dev --queries keywords --label old-dev --use-saved-keys --code-dir $OLD --code-commit f41450c
node bench/search/run.js --split dev --queries keywords --label old-dev --offline --code-dir $OLD --code-commit f41450c   # replay
```
`--code-dir` loads `server/sources` and `server/pipeline` from that folder; the run's meta records the folder, the
commit you name and the hashes of the files. The old code builds its own URLs, so its first run fetches its own database
answers (cached afterwards), which is the point of an old-against-new comparison.

Why a database lost a gold paper: `node bench/search/miss.js --label <run> --use-saved-keys` writes
`results/<split>-miss-analysis.md` (batched filter-only OpenAlex lookups, about 25 requests).

Other options: `--sources openalex,semanticscholar,crossref,europepmc` (databases to switch on; default is the owner's
setting, the first three), `--limit N`, `--ids a,b`, `--depth N` (ranked papers kept per question, default 100),
`--max-live N` (stop after N live requests, default 500), `--keyless` (offline only: take the keyless code path).
A live run needs `--use-saved-keys`: keyless OpenAlex is asked one query only and has a tiny daily allowance, so it would
not behave like the app. `--queries fallback` uses `pipeline.fallbackQueries`, the app's no-model path when the planner fails.

What a run writes to `results/` (label `L`):
- `L.json`: settings, code version (commit and hashes of the files that matter), request counts, per-question metrics,
  the summary with intervals. `compare.js` reads this.
- `L.md`: the summary table. `L.plans.json`: the queries used, in the plan-file format, so a later run can replay them.
- `L.lists.json` (git-ignored): the ranked list per question (rank, DOI, title, sources, which gold paper it is) and the
  gold papers that were missing.

A run that had a database error on any question exits with code 3 and marks those questions `incomplete`; `compare.js`
leaves them out. A run that stops because the budget ran out writes nothing, and the cache keeps what was fetched, so
running the same command again continues from there. Offline replay exits with code 2 if a request was not cached.

## Question files
`data/dev.jsonl` and `data/holdout.jsonl` (git-ignored because they hold question texts and papers): one object per line,
`{"id", "question", "discipline", "source", "gold": ["10.x/..."], "goldItems": [{doi, title, oa, ...}], "reference"}`.
`gold` lists the DOIs; `goldItems` also carries titles and OpenAlex ids used for matching. `data/splits.json` (committed)
lists the ids of each split with the seed. Rebuild from scratch with
`node bench/search/fetch.js && node bench/search/reviews.js && node bench/search/build.js select && node bench/search/build.js build`
(a few dozen requests, all through the cache).

## What the metrics mean
All are means over questions. Intervals are 95% bootstrap over questions; differences between runs are paired.
- **Recall@25 (capped)**, the primary metric: gold papers in the top 25 divided by min(number of gold papers, 25).
  25 is the owner's `maxPapers`: what an answer reads. The cap stops a question with 60 gold papers from limiting the score.
- **Recall@40 (capped)**: the same at 40, the wide tools. **Recall (all gold)**: divided by every gold paper, so it
  cannot reach 1 when there are more than 25 gold papers.
- **nDCG@25**: rewards gold papers near the top; binary gain; 1 means the gold papers fill the first places.
- **MRR**: 1 / the rank of the first gold paper (0 if none in the ranked list).
- **Found anywhere**: the share of gold papers in the merged pool before the top-k cut. If this is low, the databases or
  the queries missed the paper; if it is high but recall@25 is low, ranking lost it. This is how to tell database work
  (agent B) and query work (D) from ranking work (C).
- **Per database**: gold papers each database returned, and the ones only it returned (summed over questions).
- **Mean pool**: distinct papers after merging, before the cut.

A gold paper is matched by DOI (arXiv DOIs included), else OpenAlex work id, else identical title (20 or more
characters). A gold paper counts once. Duplicate records of one work that Lectern does not merge take extra places in
the list; that is a real cost and the metrics count it.

## Gold sources, versions, licences, limits
Read on 2026-11-18. Downloaded texts stay local; the repository keeps the manifest, the splits (ids) and the question
files written by hand.

| Source | URL and version | Licence | What the gold set means | Used |
|---|---|---|---|---|
| SYNERGY | github.com/asreview/synergy-dataset, commit `7efde4a37bed9e8d71f19421b90eae3485184c4d` (2026-11-12); 119 reviews | Repository licence CC0-1.0; `ATTRIBUTION.md` thanks the review authors who shared their data | Records the authors of a published systematic review included after full-text screening (`label_included = 1`) | 47 questions |
| CLEF eHealth TAR 2017 to 2019 | github.com/CLEF-TAR/tar, commit `dbc13d02bb3e2f8ebc90e62ff47f5eb591e5ca20` (2025-04-17) | Repository licence MIT; the reviews are Cochrane's | PubMed ids of studies included in a Cochrane review (full-text "content" qrels with relevance 1); topic titles are the review titles | 36 questions: 14 intervention reviews (2019 test) and 22 diagnostic-accuracy reviews drawn at random from 2017 and 2018 test |
| LitSearch | huggingface.co/datasets/princeton-nlp/LitSearch, revision `9573fb284a1026c998df47024b888a163f0f0e25` (2024-07-09), query set read through the dataset viewer | The dataset card states no licence; the code repository github.com/princeton-nlp/LitSearch is MIT. Treated as evaluation-only: texts are not committed | Questions about ML and NLP papers (597); the gold is the paper(s) a question is about. 20 written by paper authors, 10 generated by GPT-4 from a citing sentence and checked by experts | 30 questions, quality 2 |

Not used: CSMeD (Kusa et al. 2023). The repository address I tried (github.com/ielab/CSMeD) returned HTTP 404 and I did
not research it further, so its data and licence are unchecked. TREC-COVID was not used either: a single topic family
(the pandemic) with judged pools of hundreds of papers per topic.

Known limits (state these whenever a number is quoted):
- **Gold answers a narrow question about a whole literature.** A systematic review of 60 included studies sits behind a
  question that a student might answer with 25 papers. Absolute recall is low by construction, and some of the gold is
  not what a student wants to read. Only differences between runs on the same questions are evidence.
- **Questions for SYNERGY and CLEF were written by Claude from the review titles.** They read like a student's
  question, but they are not logged questions. The gold is not model-chosen.
- **Included studies are not a ranking of "the papers that matter"**: a relevant, excellent paper that the review did
  not include counts as a miss. Cochrane DTA reviews also reflect a specific screening step.
- **Mapping losses (counted).** SYNERGY: of 1,858 included records in the 47 kept reviews, 199 (10.7%) have no OpenAlex id,
  DOI or PubMed id in the dataset and cannot be mapped, 4 more were duplicates or unknown to OpenAlex, leaving 1,655 gold
  papers. Five further reviews (Chakraborty 2023, Deckers 2022, Radjenovic 2013, Zakeri-Nasrabadi 2023, Hanlon 2022) had
  no mappable record at all and were dropped. 53 of the 1,655 have no DOI and 15 of them no title (known to the dataset by
  DOI only); they match by OpenAlex id, title or DOI as available. CLEF: 795 of 795 PubMed ids found in OpenAlex; 63 of them
  have no DOI (old or non-journal items) and match by OpenAlex id or title. LitSearch: 30 of 30 corpus ids found in
  Semantic Scholar; a paper with no DOI there gets its arXiv DOI (`10.48550/arxiv.<id>`). Recall denominators use the mapped
  papers, so they are smaller than the review's own included set.
- **Coverage tilts to health.** 49 of 113 questions are health, 36 computer science (30 of them LitSearch with one gold
  paper each, so recall there is 0 or 1), 22 social science, business and education, 6 environment and other. Business
  has only two questions. There is no humanities or law question beyond one legal NLP review. Per-group intervals are wide.
- **Matching by title can miss a version** (a preprint and its journal version with different titles) and **the
  database answers change over time.** The cache freezes them for fair comparisons; a fresh fetch later is a different
  experiment.
- **Dev is used to choose; the holdout is for one confirmation.** The dev intervals ignore the number of variants tried.

## Limits on requests (read 2026-11-18)
All requests pass through `http.js`, which caches, paces and counts them.
- **OpenAlex** bills a daily dollar allowance shared with the owner's own use of Lectern: with the owner's free key about
  1,000 searches a day (a search is 1/1000 of a dollar, a list with filters only a tenth of that, a single-entity
  lookup is free; `rerank=true` counts double; source: agent B's reading of developers.openalex.org, 2026-11-18). The
  counter file `data/requests.json` is **team-wide**: every run adds its uncached OpenAlex search calls, and **all runs
  stop at 750 per UTC day** (no request is sent past it). The count appears in each run's summary. A run that hits the
  stop writes nothing; run it again tomorrow and it continues from the cache. The response header
  `x-ratelimit-remaining` (credits; $1 = 10,000 credits) is kept in memory as a check on the counter.
- **Semantic Scholar** with a key: 1 request per second on all endpoints. The wrapper sends one at a time, at least 1.1 s apart.
  Even so it answers 429 now and then (3 of 6 probe requests, 2026-11-18), so the wrapper retries a 429 or 503 up to
  three attempts in all (pauses 3 s and 8 s) inside the same lock; every attempt is counted. Answers other than 200 and 404
  are never cached.
- **Crossref** public pool: list requests are limited to 1 per second and 1 at a time since 2025-12-01
  (crossref.org/blog/announcing-changes-to-rest-api-rate-limits/). The wrapper sends one at a time, 1.1 s apart.
- **Europe PMC**: no hard figure published; one at a time, 0.25 s apart.
- **Several processes at once are safe.** Each host has a lock directory (with the owner's pid; taken over when that process
  is dead or the lock is over two minutes old) and a stamp file with the time the last request finished, both under
  `data/locks/`. A process takes the lock, waits out the gap since the last request of any process, sends one request,
  reads the whole answer, stamps and releases. Two processes therefore never talk to one host at the same time or closer
  than its gap (tested offline with two simulated processes). If another process fetched the same URL meanwhile, the answer
  is read from the cache instead of being fetched again.
- The cache key is the request URL without `api_key`, `mailto`, `email` and `key`; request headers are never stored.
  No key is printed, logged or written. `--use-saved-keys` reads the owner's settings through `Config` in memory only.
  No email is sent. Because the cache ignores keys, a run recorded with keys replays offline for anyone.

## Files
`http.js` cache, pacing, counters; `metrics.js` the metrics and bootstrap (tested in `test/searchbench.test.js`);
`run.js` the runner; `compare.js` paired comparison; `report.js` markdown summary; `settings.js` the settings object;
`fetch.js`, `reviews.js`, `build.js` data download and question set; `data/manifest.json`, `data/splits.json`,
`data/synergy-questions.json` and `data/clef-questions.json` (the hand-written questions, kept in git); `data/plans/` is a suggested place for plan files.
