# Pre-registration: Lectern writing-pattern review, evaluation version 1

Written and frozen on 2026-11-15, **before** any score was computed on the development or holdout split.
The decision rules are also fixed in code (`PREREG` in `bench/run.js`). Changing a rule means a new version
number and fresh holdout data, because once a holdout has been looked at it is no longer independent.

## Question
How often does each Lectern AI-writing system flag human writing (false positives) and AI writing (detection),
how often does it give no answer, and how does that differ by source, writer group, generator, edit or attack,
and length? The goal is to know whether any authorship claim is supported. It is not to tune the tool to this data.

## Systems under test
1. **Measured index** (`measure(text).readings.docSignal`, 0–100): a fixed, hand-weighted mix of word, phrase,
   signpost and rhythm signals. Deterministic, no model, no cost.
   *Decision:* flag when the index is at or above a threshold **chosen on the development split only**: the
   lowest value that flags at most 5% of development human texts. The threshold is written to
   `bench/results/frozen-measured.json` with file hashes before the holdout is scored.
2. **Model writing-pattern review** (`runAiCheck`, the in-app review): the headline share of reviewed words in
   sentences the model rated 65 or more.
   *Decision:* flag when the headline is 20% or more (fixed in advance, not tuned). No score (too short,
   too little coverage, failure) counts as **abstained**. Runs on a seeded, stratified holdout subset only,
   and only when the owner approves the model credits (`--yes-spend`).

## Data (`bench/fetch.js`, `bench/data/manifest.json`)
- **HC3** (Hello-SimpleAI/HC3, CC-BY-SA-4.0): human and ChatGPT (Dec 2022–Jan 2023) answers to the same
  questions. Rows 0–99 of `all/train` are excluded, because the 2026-11-15 audit inspected them.
- **RAID** (liamdugan/raid, MIT): human text and generations from 11 models in 6 English prose domains, with
  adversarial attacks (paraphrase, misspellings, homoglyphs and others) recorded per text.
- **Liang et al. 2023** (WxWx/ChatGPT-Detector-Bias, MIT): 91 TOEFL essays by non-native writers, the same
  essays polished by GPT-4 (labelled **mixed**: human writing edited by AI), native student essays and GPT-3
  essays. **Holdout only**, as an independent, out-of-domain set.
- Texts of 80–1,200 words (Liang: 40 or more). Labels are the datasets' own; Lectern did not verify authorship.

## Split (`bench/split.js`)
By group, never by document (an HC3 question, a RAID source title, a Liang essay), about 40% of HC3 and RAID
groups to development by a salted hash of the group name, the rest plus all of Liang to the holdout. Exact
duplicates (after case and space folding) are removed; a text in the holdout is dropped from development.

## Measures (`bench/metrics.js`)
False positive rate on human texts and detection rate on AI texts, each with a 95% Wilson interval; abstention
and failure rate; flag rate on mixed texts (reported apart: there is no "right" answer for edited text);
AUROC of the continuous score with a 500-sample bootstrap interval; balanced accuracy; precision at assumed
base rates of 5, 10, 20 and 50% AI texts. All of these by source, writer group (non-native TOEFL vs other),
domain, generator, attack or edit, and length (under 150, 150–299, 300–599, 600+ words).

## Claim rule
A stronger claim (anything beyond "an unvalidated writing-pattern review") may be considered **only if all**
hold on the holdout: the upper 95% bound of the false positive rate is at most 5% overall **and** for
non-native writers; the lower 95% bound of the detection rate on unattacked AI text is at least 80%; and
abstention is at most 10%. Even then, repeatability across runs, a fresh temporal holdout with current models
and consented student writing are needed first. Until then `DETECTOR_VALIDATED` in `server/checks/aiscore.js`
stays `false`.

## Known limits (stated before results)
- The generators are 2019–2024 models (GPT-2, GPT-3, ChatGPT 2022–23, GPT-4, Llama 2, Mistral, MPT, Cohere),
  not today's. The texts are mostly answers, abstracts, news, reviews, Reddit posts, Wikipedia and short
  essays, not current student assignments. English only.
- Public datasets may be in model training data, which can inflate a model reviewer's results.
- "Mixed" covers one kind of edit only (GPT-4 polishing of a whole essay), not partial or sentence-level mixing.
- Span (sentence-level) accuracy is not measured: no dataset here marks which sentences an AI wrote.

## Deviation log
1. **2026-11-15, harness fix after the first holdout look.** The first run scored raw dataset text, while the app
   normalises text before measuring (it removes zero-width characters, for one). That made RAID's zero-width-space
   attack read as 0% detected for a reason the app does not have. `bench/run.js` now applies the app's own
   `normalizeText` and word cap. The decision rule, threshold method and data are unchanged; the threshold was
   re-derived on the development split with the corrected harness. The first run is kept in
   `bench/results/superseded/` and both are reported. Because the holdout had been seen once, the corrected
   holdout figures are a second look, not a pristine test: the claim rule cannot be passed on them alone.
