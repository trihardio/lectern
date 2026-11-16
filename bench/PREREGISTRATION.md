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

## Version 2: trained style model (frozen 2026-11-16T17:42:48Z, before any holdout score was computed)

**System under test.** A logistic-regression model over 30 interpretable style features (sentence length and its
variation, word length, vocabulary richness, punctuation rates, pronouns, contractions, digits and names, the
Kobak et al. excess-word rates, stock phrases, signposts, paragraph variation, -ly and -tion rates, repeated
three-word sequences, sentence-start variety, lower-case sentence starts). Text is normalised as in the app, and
tokenizer spacing artefacts ("word ." and "do n't") are undone first so the model learns writing, not corpus
formatting. Trained on the v1 development split only (HC3 + RAID; class-balanced weights; L2 = 1, chosen by 5-fold
cross-validation by group, AUROC 0.939 on the folds). Frozen files and SHA-256: model-v2.json and style.js
b8f66c57c68845068fc7664ed1e781fde7825a3854d0e6b5aa11f194025de397 f41137d0d58e6805edf5e7f2a2878566ee29f49eb41dd53793f21fef407506bd 

**Decision rule.** Flag when the model's probability is at or above 0.6834: the lowest value that flags at most 5% of
development human texts. Not tuned on any holdout.

**Holdouts.**
1. *Primary, never used by any Lectern system:* MAGE (yaful/MAGE, Apache-2.0), test split. Seeded page sample across
   the whole split, 80-1,200 words, at most 60 documents per source name, label 1 = human, 0 = machine (checked
   against the source names). Exact duplicates of any development text are removed.
2. *Secondary:* the v1 holdout (HC3, RAID, Liang et al.). It has been looked at twice for the v1 measured index, so
   it is not pristine, but no v2 decision was made on it. Reported separately, with the non-native (TOEFL) writer
   group and the GPT-4-polished essays shown apart.

**Claim rule.** Unchanged from version 1. In addition, the v2 model can replace the v1 measured index inside the
app only if, on MAGE, its AUROC is higher than v1's measured index and its false positive rate's upper 95% bound
is at most 10%. Neither outcome changes DETECTOR_VALIDATED unless the full claim rule passes.

**Known limits.** MAGE generators are 2022-2023 models (GPT-3/3.5 family, LLaMA, OPT, GLM, FLAN-T5, BLOOM and
others); today's models may differ. MAGE mixes domains (news, Reddit, stories, reviews, science, QA); it is not
student coursework.

### Version 2 result (recorded 2026-11-16T17:46:37Z)
MAGE (primary): v2 AUROC 0.541, false positives 28.8% (25.1-32.9), detection 33.4%; v1 AUROC 0.563, false positives
6.8%, detection 8.9%. The v1 holdout (secondary): v2 AUROC 0.927 against v1 0.677. **The replacement rule fails**: a
model trained on HC3 + RAID learned those datasets, not AI writing in general. v2 is not used in the app.

## Version 3: same features, more varied training data (frozen 2026-11-16T17:46:37Z, before any DACTYL test score)
**Training data:** v1 development split (HC3, RAID) + the v2 MAGE sample (now seen, so it moves to training) +
a seeded sample of DACTYL's *train* split (ShantanuT01/DACTYL, MIT; 2024-25 generators including GPT-4o, GPT-4o-mini,
Claude 3.5 Haiku and Sonnet, Llama 3, Gemini, DeepSeek). Same features, class-balanced, each source weighted equally, L2
chosen by 5-fold cross-validation by group. Threshold: the lowest value that flags at most 5% of training human texts.
**Holdout (primary, fresh):** a seeded sample of DACTYL's *test* split, 80-1,200 words, at most 40 per domain and
generator, exact duplicates of any training text removed. Nothing else is scored on it before the result is written.
**Rule:** the v3 model may replace the v1 index in the app only if, on the DACTYL test sample, its AUROC is above v1's
and its false positive rate's upper 95% bound is at most 10%. DETECTOR_VALIDATED stays false unless the full
v1 claim rule also passes.

### Version 3 result (recorded 2026-11-17)
DACTYL test sample (1,095 documents: 200 human, 895 AI from 12 generators): v3 AUROC 0.883, false positives 4.5%
(2.4-8.3), detection 70.1% (67.0-73.0); v1 AUROC 0.798, false positives 8.5%, detection 50.9%. **The replacement rule
passes.** The full claim rule does not (detection's lower bound is below 80%), so DETECTOR_VALIDATED stays false.
Weak spots measured before use: student essays (AUROC 0.597), reviews, small fine-tuned Llama models; and on the
Liang et al. essays (never used in training) v3 flags 13.3% (7.8-21.9) of non-native writers' TOEFL essays against
3.3% for v1, while it flags fewer native student essays (6.5% against 18.6%). Decision: v3 is shown in the app as a
separate "style model" reading with these numbers next to it, and it is not part of the headline score.
Scripts: bench/style/ (fetch-mage, fetch-dactyl, train-v2, eval-v2, train-v3, eval-v3, fair-v3); data in
bench/data/style (not committed); the shipped weights are server/checks/style-model.json.
