# Benchmark for the AI-writing review

This folder measures how Lectern's AI-writing tools behave on labelled human, AI and AI-edited writing.
It exists so that no accuracy or authorship claim is made without evidence. Read `PREREGISTRATION.md` first:
it fixes the decision rules, the split and the claim rule before any result was seen.

## Run it

```
node bench/fetch.js     # download the sample (public datasets, no account; cached in bench/data/cache)
node bench/split.js     # development / holdout split by group
node bench/run.js --system measured --split dev       # free; freezes the threshold
node bench/run.js --system measured --split holdout   # free; run once
node bench/run.js --system review --split holdout --fake --limit 24   # pipeline check, no credits, numbers mean nothing
node bench/run.js --system review --split holdout --engine claude-code --model <id> --limit 60 --yes-spend
#   ^ USES MODEL CREDITS on your plan: at least one request per document (60 documents = 60+ requests)
```

Results go to `bench/results/<system>-<split>.md` (readable) and `.json` (every document's id, label, group, score
and decision, without the text). `bench/results/superseded/` keeps earlier runs, with the reason in the
pre-registration's deviation log.

## Data and provenance
`bench/data/manifest.json` lists every document (source row, label, group, length, text hash) and the sources,
licences and citations: HC3 (CC-BY-SA-4.0), RAID (MIT) and Liang et al. 2023 (MIT). Texts themselves are kept in
`bench/data/items.jsonl`, which is not committed. Labels are the datasets' claims; Lectern did not verify who wrote
anything. The audit's own sample (HC3 rows 0-99) is excluded.

## What the results can and cannot say
They describe these datasets: older generators (2019-2024), mostly non-student genres, English only, data that
may be in model training sets, and one kind of AI editing. They say nothing about span (sentence-level)
accuracy. A pass on the claim rule would be necessary, not sufficient: repeatability, a fresh temporal holdout
with current models and consented student writing would still be needed. Until then the app labels its
result "Not validated" (`DETECTOR_VALIDATED = false` in `server/checks/aiscore.js`).

## Live review benchmark (version 4 of the pre-registration)
`bench/review/` measures the model review itself on human, AI and AI-then-human-edited academic and student writing
(150–700 words, one review request per document). Read the version 4 section of `PREREGISTRATION.md` first.

```
node bench/review/fetch-beemo.js       # once; the other sources are described in bench/review/manifest.json
node bench/review/build.js             # dev (36) and holdout (54) texts in bench/data/review (git-ignored), manifest without texts
node bench/review/run.js --system S0 --split dev --fake --code-dir <git HEAD copy>      # free pipeline check
node bench/review/run.js --system S0 --split dev --code-dir <git HEAD copy> --yes-spend --team <folder with calls.jsonl>
node bench/review/analyze.js dev       # free: S0 and the candidate scores; --freeze writes the choice before the holdout
```
Every paid call is added to `<team>/calls.jsonl` and the run stops before the allocation is exceeded; replies are cached by code
version, model, prompt and text (`bench/data/review/reply-cache`), so nothing is paid twice. The run uses Claude Code only, points
Codex at a missing program, and stops if the provider reports another model than the one asked for.
