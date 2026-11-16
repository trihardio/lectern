# Benchmark for the proofreader

This folder measures how often the Writing desk's proofreader is right, on public data, with the standard scorer for
grammatical error correction. Read `PREREGISTRATION.md` first: it fixed the samples, metrics and decision rules before
any result was seen, and it holds the results.

## What is measured
- **The model proofreader** (`server/checks/proofread.js`), exactly as the app runs it: the same prompt, batches, guards
  and edits. The scored text is the original with every suggestion the app would show applied.
- **The instant rules** (`shared/proofrules.js`), which run on the writer's computer without a model.

Data: CWEB (Flachs et al. 2020), web text corrected by two annotators, licence CC BY-NC-SA 4.0. It is downloaded at a
pinned commit, used here for non-commercial evaluation, and not redistributed (`data/` is git-ignored apart from the
manifest and the split ids). Scorer: ERRANT 3.0.0 with spaCy 3.8.7 and en_core_web_sm 3.8.0, span-based correction
precision, recall and F0.5, with gold edits rebuilt from both annotators so gold and output are tokenised alike.

## Results (2026-11-17, details in PREREGISTRATION.md)
| System | Data | Precision | Recall | F0.5 | Changed sentences no editor changed |
|---|---|---|---|---|---|
| Model (Claude Opus 5.5), held out | 300 CWEB test lines | 63.3% (49.0-76.1) | 41.3% (29.6-54.1) | 57.2% (45.7-67.9) | 5 of 181 (2.8%) |
| Instant rules, held out | all 6,845 CWEB test lines | 87.9% (79.1-95.6) | 4.3% | | 2 of 4,335 (0.05%) |

Precision counts a correction that neither annotator made as wrong, so it is a lower bound. The numbers describe web
text and one model; other writing, other models and other languages were not measured.

## Run it
```
python3 -m venv bench/grammar/.venv
bench/grammar/.venv/bin/pip install --only-binary=:all: "spacy==3.8.7" && bench/grammar/.venv/bin/pip install "errant==3.0.0"
bench/grammar/.venv/bin/python -m spacy download en_core_web_sm
node bench/grammar/fetch.js                       # CWEB at the pinned commit, with hashes in data/manifest.json
node bench/grammar/sample.js                      # the seeded dev and holdout samples
node bench/grammar/run.js --split dev --dry       # how many model requests a run would send (13)
node bench/grammar/run.js --split dev --label v1 --yes-spend    # USES PLAN CREDITS: 13 requests
bench/grammar/.venv/bin/python bench/grammar/score.py --split dev --label v1
node bench/grammar/rules.js --split dev           # the instant rules: free, no model
bench/grammar/.venv/bin/python bench/grammar/score.py --split fulldev --label rules
```
`results/` keeps the scores (no text). The holdout is for one final run per version; a new version of the prompt or the
rules gets a new label and a new entry in the pre-registration before it is run.
