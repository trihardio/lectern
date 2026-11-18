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

## Version 4: live review of AI, AI-then-human-edited and human academic and student writing (written 2026-11-18, before any live review number)

**Why.** The model review (`runAiCheck`) had never been measured live, and the owner reported a text written by AI and then edited by hand that
scored 0% in it. Version 4 measures the review itself, on three classes, and compares the shipped review with a candidate that is chosen on a
development split by a fixed rule and then run once on a holdout. The owner's sample is not part of any split and is never used to choose anything.
The goal is to catch more AI-written and AI-then-edited writing without flagging more human writing. It is not to agree with any website.

**Data** (`bench/review/build.js`, `bench/review/manifest.json`; texts only in the git-ignored `bench/data/review`).
- Classes: *human*, *AI* (generated by a model), *AI-edited* (machine text edited by humans). Model-edited text (an AI polishing human text, or an AI
  "humanising" AI text) is a different class and is not used here.
- Sources, with licences and revisions in the manifest: DACTYL validation split (student essays and abstracts; MIT card; 11 prompted models of 2024;
  the human essays include ELLIPSE essays by English language learners, tagged ELL, used as the non-native group), Beemo (expert edits of machine
  output, the human reference and the machine output for the same prompts; MIT card with noncommercial and model-licence notes), MixSet (human-adapted
  machine text; **no licence stated**, so local use only), and Liang et al. native student essays and GPT-3/4 essays (MIT).
- Limits for every class: 150 to 700 words, exactly one review request (`aiscore.batches` returns one batch; `SCORING.batchChars` 12,000 and `batchUnits` 60),
  at least 120 eligible prose words and 80% of the words eligible, no chat preamble ("Sure, here is..."), no duplicate texts.
- Development 36 documents (14 human, 11 AI, 11 AI-edited), holdout 54 (22 human, 16 AI, 16 AI-edited), seeded random choice inside fixed cells,
  one document per source group (an ELL essay topic, a Beemo prompt, a MixSet source text, a Liang essay, a DACTYL document), a group in one split only.
  The cell counts are in the manifest and were fixed before any review was run. Sizes are smaller than first suggested because the call budget for the
  whole task (200 Sonnet calls) has to pay for four runs (S0 and S2 on both splits).
- Known limits: the edited class is mostly Beemo (general writing, expert edits, shorter texts than the human class: median 228 words in dev and 196 in holdout
  against 300 and 359 for human); the AI texts come from 2023-24 models; DACTYL's human texts include scraped web essays whose authorship was not verified by
  Lectern; the 8 non-native holdout essays and 14 development humans give wide intervals. No Liang TOEFL essay reaches 150 words, so those essays are not used. Formatting differs by class: markdown marks (bold, headings, list numbers) appear in 6 of the 27 AI and 5 of the 27 AI-edited documents of both splits and in none of the 36 human ones, and blank-line paragraphs are common in AI and edited texts (about 80%) but rare in human ones (about 14%). The review is given numbered sentences only (no paragraph breaks), so the paragraph cue is hidden, but a mark inside a sentence is visible to the model. Texts are not cleaned, so the review sees what the app would see.

**Systems.**
- **S0**: the shipped review, git HEAD f41450c (release 0.2.1), run from an extracted copy of `server/` (`git archive HEAD server shared package.json`),
  with its own prompt and parser. Decision: headline (share of reviewed words in sentences rated 65 or more) at or above 20%, the rule fixed in version 1.
- **S1**: the same S0 replies, scored with the candidate document scores of `documentScores()` in `server/checks/aiscore.js` (agent A): `strongShare` (the
  headline), `someShare` (words in sentences rated 40 or more), `meanRating` (word-weighted mean rating), `topQuartileMean` (word-weighted mean of the top
  quarter of reviewed words). No extra calls. The ratings are those read by the HEAD parser.
- **S2**: the new prompt (`AI_REVIEW_SYSTEM` and `aiReviewPrompt` of the working tree, agent C), with the same four scores and, when the reply carries one for
  every document, `overall` (the model's whole-text rating). A system's scores are null when the review withholds its score (fewer than 80 reviewed words or less
  than 60% coverage).
- Model: `claude-sonnet-5-5` through Claude Code (effort low, as in the app), one run per document and system. The provider-reported model must equal the model
  requested or the run stops. Codex is never used. Replies are cached by code version, model, effort, prompt and text, so no call is paid twice.

**Selection on development (rule fixed now).** For every available (system, score) pair of S1, S1b and S2: the threshold is `thresholdForFpr(dev human scores, 0.05)`
(just above the highest human score when 14 humans allow no flagged human); a document is flagged when its score is at or above the threshold; a document with no
score counts as not flagged and scores -1 in rankings. Choose the pair with the highest dev detection of AI plus AI-edited documents together; ties go to the higher dev
AUROC (human against AI plus AI-edited), then to S1 before S1b before S2, then to the order `strongShare, someShare, meanRating, topQuartileMean, overall`. The choice, the threshold and the
file hashes are written to `bench/results/review-frozen.json` before the holdout is run. Non-native and student human documents are reported separately in the dev table.
All pairs are reported, not only the chosen one. With 36 documents the choice is noisy by construction; the holdout is where it is tested.

**Holdout (run once).** S0 and the selected system on the same 54 documents. Reported, each with a 95% interval:
1. False positive rate on human documents (Wilson), overall and for non-native, student, academic and Beemo-reference humans separately.
2. Detection rate on AI and AI-edited documents together, and on each class separately (Wilson), so the AI-edited result is never hidden in the total.
3. AUROC of the continuous score, human against AI plus AI-edited (and against each class alone), with a **paired** bootstrap of the difference (selected minus S0):
   2,000 resamples of documents within class, seed 20261119, 95% percentile interval. A document with no score scores -1.
4. Documents with no score (abstentions or failures), counted as not flagged, and listed.
S0's decision rule is headline >= 20; the selected system uses its frozen threshold. No threshold, prompt, weight or score is changed after the holdout is seen.
Interpretation rule: "better" requires the paired AUROC difference interval to exclude 0 **and** the false positive rate not higher than S0's; anything else is reported as no
demonstrated difference. A point estimate that moves is not evidence of improvement.

**Opus direction check.** 8 holdout documents (3 human, 2 AI, 3 AI-edited; the first by `sha256("opus|" + id)` within each class) run with `claude-opus-5-5` on S0 and
on the selected system: at most 16 calls (8 if the selected system is S1, which reuses the S0 replies). Direction only, no inference; the owner's own use is Opus.

**Claim rule.** Unchanged from version 1 and version 2. `DETECTOR_VALIDATED` stays `false` and the "Not validated" badge stays; with 22 holdout humans the upper 95% bound of the false positive rate is about 14.9% even if no human is flagged (0 of 22), so the rule cannot be met on this holdout, and 16 of 16 AI documents flagged would only just reach a lower bound of 80%.

**Not tested in version 4.** Repeat runs of the same document (the model's own run-to-run variation), other models than Sonnet and the 8-document Opus check, documents over
700 words, text the owner's classes wrote with other tools, consented real student work, sentence-level (span) accuracy, and any adversarial rewriting. No detector evasion is
built or tuned in this work.

### Version 4 deviation log
1. (2026-11-18, before any review number) The 150-word floor excludes all Liang TOEFL essays (longest 148 words), so the non-native group comes from DACTYL's ELL essays. Split sizes
   are 36 and 54 instead of about 40 and 60 for the call budget.
2. (2026-11-18, after the S0 development run, before any holdout run and before the choice was frozen) **S1b added.** S0's 36 development documents gave 4 without a
   score (11%). The cause is the parser: the model rated spans of sentences that the HEAD parser rejects whole (a span wider than 8 sentences in one document; spans that include a number the model was never shown, such as a heading or list stub, or that run outside the part, in three), so most of the text became "not reviewed" (coverage 19% to 54% against the 60% needed). Agent A's working-tree `parseReview` accepts spans that cross an unshown number, which recovers 2 of the 4 documents (the other 2 stay partial). S1b is
   the same S0 replies, read again from the cache with the working tree's `parseReview` and `documentScores` (`bench/review/replay.js`), for free. It is a third system next to S1 (HEAD
   parser) and S2, and its pairs join the selection (S1, S1b, S2 in that tie order). The dev result of S1b was seen before this entry, so S1b's dev numbers are a second look at the same
   replies, not independent; the holdout is untouched. S0 as shipped keeps its HEAD parser and is the comparison baseline on the holdout.

### Version 4 development result, S0 (recorded 2026-11-18; 36 calls of claude-sonnet-5-5, provider-reported model confirmed on every reply)
S0 as shipped (headline at or above 20): false positives 0 of 14 (0-22%); detection of AI plus AI-edited 9 of 22 (41%, 23-61%), AI 8 of 11 (73%, 43-90%), AI-edited
1 of 11 (9%, 2-38%); AUROC (human against AI plus AI-edited) 0.763; 4 of 36 documents without a score (see deviation 2). Non-native (ELL) humans 0 of 4 flagged, student 0 of 5.
Read the AI-edited number as: the shipped review almost never reaches the 65-point band for expert-edited machine text. Development numbers choose a rule and nothing more; the
holdout decides. Candidate scores on development are printed by `node bench/review/analyze.js dev`; the choice is frozen only after S2 has also been run on development.
3. (2026-11-18, after the S0 development run, before any S2 call and before any holdout run) **Markdown sensitivity analysis.** Markdown marks (the pattern `\*\*`, or a line starting with `#`, `- ` or a list number) occur only in AI and AI-edited documents of this benchmark (11 of 54 AI and edited, 0 of 36 human), so a model could use them as a label cue. On the holdout every primary number is reported twice: on all documents (this stays the pre-registered primary result) and with the documents that contain such marks excluded (the sensitivity check). The marks are not stripped from the texts: the cached replies saw them, and the same cache key must stay valid.
4. (same time) **Length is a known confound.** AI-edited documents are shorter (median 228 words in dev, 196 in holdout) than human ones (300 and 359). As a reference line the AUROC of word count alone (longer = positive) is reported on the holdout, human against AI plus AI-edited and against each class, so a score's AUROC can be read against what length alone would give. Values below 0.5 mean shorter texts rank as more AI-like.
5. (same time) **Opus check selection, fixed now.** From the holdout only, documents without Markdown marks, seed 20261118 (`bench/review/analyze.js opus-ids`): 3 human (at least 1 non-native), 3 AI-edited and 2 AI, drawn by a seeded shuffle of the documents ordered by id. S0 and the selected system are run on them with `claude-opus-5-5` (at most 16 calls; 8 if the selected system is S1 or S1b). Direction check only: no interval, no claim.
6. (same time) **Candidates and ties, as instructed by the lead.** S0 itself (headline, flag at 20) joins the candidates, with the same 5% human constraint on development; ties on development detection are broken as already registered (higher development AUROC first); a remaining tie goes to the system with fewer changes from S0 (S0, then S1, S1b, S2, then the score order). If S0 is chosen the holdout reports S0 against itself and the result is "no change".

### Version 4 holdout result (recorded 2026-11-18; full tables in `bench/results/review-v4.md`)
Frozen choice (development, 36 documents): S2 (agent C's prompt) with `meanRating` flagged at 53.8 or more, in `bench/results/review-frozen.json`. Holdout, run once (22 human, 16 AI, 16 AI-edited): false
positives S0 3 of 22 (14%, 5-33%), selected 2 of 22 (9%, 3-28%); detection of AI plus AI-edited S0 13 of 32 (41%, 26-58%), selected 18 of 32 (56%, 39-72%); AI-edited alone S0 3 of 16 (19%), selected 8 of 16 (50%, 28-72%);
AUROC S0 0.708, selected 0.866; paired difference +0.158 (0.064 to 0.257). Without Markdown documents the picture is the same (+0.140, 0.049 to 0.233). Word count alone gives AUROC 0.327 (0.673 reversed), 0.798 reversed
against AI-edited text, the same size as the selected system's 0.810 there. The claim rule is not met. No rule, prompt or threshold was changed after the holdout was seen.
7. (2026-11-18, after the holdout) `server/checks/aiscore.js` was changed by agent A only to ship the frozen choice as the app's headline (`score` is now the rounded mean rating, `flagged` is true at 53.8 or more, `SCORING.version` 3); `server/prompts.js` is unchanged (its sha256 still equals the one in `bench/results/review-frozen.json`). Replay check, free, from the reply cache only (`node bench/review/replay-check.js`): the cached S2 replies were read again through the current `runAiCheck`. Development: 36 of 36 documents have identical sentence ratings, identical mean rating and identical decisions at 53.8 (35 scored, 1 without a score). Holdout: 54 of 54 identical on all three (53 scored, 1 without a score). The new `aiscore.js` sha256 is d8d262c48138afed828aa92139e9f9c25899e970457c8ae8610349e962c15053. The benchmark code now computes every score from stored per-sentence ratings with `documentScores()` and no longer reads a code's own `score` field. A replay lookup that confused Sonnet and Opus replies for the same text (same code version) was fixed in `bench/review/replay.js` by also matching the model; no reported result used the affected lookup (S1b was not selected and its holdout was never read).
8. (2026-11-19, after the holdout) One message in `server/checks/aiscore.js` was reworded: when no model is connected, the review now also says that a Gemini API key can be added in Settings (the Gemini engine was added that day by lectern-dd). That message appears only when no review runs, and nothing that rates or scores was touched. Replay check from the reply cache, free (`node bench/review/replay-check.js`): development 36 of 36 and holdout 54 of 54 documents had identical sentence ratings, identical mean ratings and identical decisions at 53.8. The new `aiscore.js` sha256 is 874ebf9c107381e82c9cdea862ee4419540e9c989795f3868239ef4a9b29f712. The review was not run or checked on Gemini.

## Version 5: fresh Claude-written texts, AI-then-edited drafts and unseen human texts (written 2026-11-19, before any text was written or reviewed)

**Question.** How often does the shipped AI-writing review (prompt `AI_REVIEW_SYSTEM`, scoring version 3: the word-weighted mean sentence rating, flagged at 53.8) give the right answer on new text that current Claude models were asked to write, on drafts of such text revised the way a student might revise them, and on human texts the review has never read? The owner asked for at least 95% correct. Code: `bench/review5/` (plan, build, run, analyze). The working tree's `server/checks/aiscore.js` sha256 at writing starts with 874ebf9c and `server/prompts.js` with e6ec3872 (the same prompt that was frozen for version 4); both are recorded again in the freeze file if any candidate is chosen.

**Data (fixed in `bench/review5/plan.js` and `bench/review5/build.js` before any text existed).**
- 60 AI texts written by two Claude Code agents to fixed requests: 30 by claude-haiku-5-5 and 30 by claude-sonnet-5-5, each writer covering six genres (argumentative essay, lab report discussion, literature review, abstract, reflective essay, blog post) in five request styles (plain; "as a second-year student, with a personal example"; "read naturally, vary sentence length, avoid stock phrases"; "as a B2-level non-native student"; "concise"). Every request asks for plain paragraphs, so Markdown cannot give the answer away.
- 18 AI-then-edited texts: claude-sonnet-5-5 writes a draft and then revises it to a fixed instruction (rewrite about a third of the sentences in plainer words, cut one or two, add one concrete detail, split or join a few, leave the rest). The editor is a model imitating a student, not a person; the share of new words is measured against the draft (`editShare`).
- 40 human texts drawn with a fixed seed from the measured-index holdout (`bench/data/holdout.jsonl`, all written before 2023): Liang et al. CS224N 7, college essays 7, TOEFL 8 (non-native); RAID abstracts 6, news 6, books 3; HC3 Reddit ELI5 3. Length 150 to 700 words, except TOEFL, where every essay is under 150 words, so 90 to 148. None was read by the model review before or used to tune it.
- Split: development 15 Haiku, 15 Sonnet, 9 edited, 22 human; test 15, 15, 9, 18. Every style is in both splits for both writers.

**Systems.** The shipped review on claude-sonnet-5-5 (the model of the version 4 benchmark), one run per text, on all 118 texts. An Opus spot check of at most 12 test texts on claude-opus-5-5, the app's default main model (direction only). Only if the shipped review is below the target: scoring candidates computed from the same sentence ratings (free), and at most three prompt variants, each run on at most 30 development texts and only from a copy of the code. A prompt variant must keep word for word the rules that errors, proficiency, non-native phrasing, formality, topic and citations are never evidence.

**Budget.** At most 270 claude-sonnet-5-5 and 12 claude-opus-5-5 review calls, enforced by `bench/review5/run.js` and logged in `bench/data/review5/calls.jsonl`. Claude Code only; Codex is never used.

**Measures** (`bench/review5/analyze.js`). Accuracy over all texts (a text without a score counts as not flagged), balanced accuracy, human texts flagged, AI and edited texts caught, AUROC with a 2,000-sample bootstrap interval, Wilson 95% intervals, and breakdowns by writer, style, genre and human source.

**Selection rule (development split only).** Among the shipped system and the candidates, choose the highest development balanced accuracy among those that flag no more development human texts than the shipped system and at most 1 of 22; a tie keeps the shipped system. The choice and the file hashes are written to `bench/results/review5-frozen.json` before any candidate is run on the test split, and the test split is run once.

**Target.** "At least 95% correct" is met only if test accuracy is at least 95% and at most 5% of test human texts are flagged (point estimates), reported with their intervals. With 18 human test texts no rate can be shown to be below 5% (0 of 18 has an upper bound of 17.6%), so `DETECTOR_VALIDATED` stays false whatever the result.

**Comparison with other detectors.** Published independent results, each with its source, and where possible an open-source detector run locally on the same corpus. No text is sent to a website unless it offers a documented public interface whose terms allow it; no login, no imitation of a browser.

**Known limits, stated before any result.** All AI texts come from one model family, which is also the reviewer's family, so this tests the case most favourable to the review. The edited texts are model-edited. The human genres differ from the AI genres (there are no human lab reports or blog posts), which may make the task easier. The numbers are small.

### Version 5 deviation log
1. (2026-11-19, before any real review result) A free pipeline check (`--fake`, invented ratings) on the 22 development human texts showed that a 211-word RAID abstract had only 56 reviewable words. The abstract is wrapped at a fixed width, as text copied from a PDF is, and `blocks()` in `server/checks/text.js` took every wrapped line of 12 words or fewer without end punctuation for a heading, so its sentences were cut into fragments. Fixed before the run: a line is no longer a heading when it starts in lower case, when the next line starts in lower case, or when the line before it stopped mid-sentence (test: "text wrapped at a fixed width" in `test/aiscore.test.js`). `text.js` sha256 changed from 48dfae62 (git HEAD) to 31e7dbf2. The "shipped" system of version 5 is therefore the working tree with this fix. Checked by comparing the old and new sentence splits: none of the 36 development and 54 holdout texts of version 4 is split differently, so the version 4 results stand; among the version 5 human texts, exactly the 6 RAID abstracts are (for example 31 pieces became 11 sentences).
2. (2026-11-19, after the shipped review's result on all 118 texts) Result of the shipped review on claude-sonnet-5-5 (118 calls, provider-reported model confirmed on every reply, 0 errors, 110 complete and 8 partial): 1 of 78 AI and edited texts flagged (1 of 60 AI, 0 of 18 edited), 0 of 40 human texts flagged, accuracy 41 of 118 (34.7%), AUROC 0.544 (0.430 to 0.659). The mean sentence ratings hardly differ (human 21.4, AI 24.0, edited 18.9); the model's reasons show that the invented concrete details in the AI texts (marks, measurements, names) lowered their ratings. Before the selection rule was applied, the app's existing style reading (style model version 3, frozen since 2026-11-16, no model call) was also computed on all 118 texts and seen: AUROC 0.893; flagged 48 of 60 AI, 11 of 18 edited and 3 of 40 human texts (2 TOEFL essays, 1 RAID abstract). Because those numbers include the test split, any candidate that uses the style reading is reported with this caveat: its parameters and its threshold were not changed, but the decision to consider it was made after seeing them. The style model was trained on the version 1 development split (HC3, RAID), MAGE and DACTYL; the version 5 human texts come from the version 1 holdout split, which shares no group with that training data, and the Liang et al. texts were never in its training data. Candidates are now chosen on the development split only, as pre-registered.
3. (2026-11-19, after the test result) Two checks that the plan named only loosely ("an Opus spot check of at most 12 test texts") were run after the frozen candidate's single test run, and both are reported as checks, not as part of the test. (a) Opus: the frozen concise-rewrite request on 12 test texts picked by a fixed hash rule (6 human, 4 AI, 2 edited), claude-opus-5-5, 12 calls (`bench/review5/opus-check.js`, `bench/results/review5-opus-check.json`). Opus left on average 11.52 points more of the words unchanged than Sonnet had, and at the Sonnet-calibrated line it flagged 4 of the 6 human texts (Sonnet had flagged 2 of the same 6). (b) Repeat: the same request sent a second time to claude-sonnet-5-5 for the first 5 of those texts (5 calls, the last of the Sonnet budget; `bench/review5/repeat-check.js`, `bench/results/review5-repeat-check.json`). The share of unchanged words rose by 12.8 to 41.7 points on all 5, because the second rewrites were barely shorter than the originals (for example 240 words in and 240 out, where the first run gave 181). That run-to-run swing is larger than the scale of the score (one standard deviation of the unchanged share on development was 12.7 points), so a single rewrite call cannot give a stable reading. **Decision:** the frozen candidate (P3 plus the style reading) is not put into the app, although it was chosen by the rule and scored 51 of 57 on the test split, because its main input moves between runs and between models more than the effect it measures. The app keeps the pattern score as its headline. Instead: (1) the limits list states the version 5 result; (2) when the pattern score and the style reading disagree, the report shows a note that names both readings and says that neither is proof and that the style model also flags human writing, most often by non-native writers (layout chosen from six drawn variants in three rounds, checked in light, dark, 390 px, Reduce motion and print). Files changed after the freeze: `server/checks/aiscore.js` (LIMITS and the CURRENT_MODELS_TEST numbers only; nothing that rates or scores; sha256 now starts with c49c57bd), `ui/checks.js`, `ui/checks.css` and `test/aiscore.test.js`.

### Version 5 result (recorded 2026-11-19; details in `bench/results/review5.md` and `bench/results/review5-candidates.md`)
- Shipped review, all 118 texts (claude-sonnet-5-5): 1 of 78 AI and edited texts flagged, 0 of 40 human, accuracy 34.7%, AUROC 0.544. The owner's target (95% correct, at most 5% of human texts flagged) is far from met.
- Style reading (no model call), all 118: 59 of 78 flagged, 3 of 40 human (2 of 8 TOEFL), AUROC 0.893 (seen before selection; deviation 2).
- Frozen candidate P3 plus style, test split once: 51 of 57 correct (89.5%, 78.9 to 95.1), 2 of 18 human flagged (11.1%, 3.1 to 32.8), 35 of 39 AI and edited caught, AUROC 0.950. Not met, and not stable (deviation 3).
- Open-source comparison (openai-community/roberta-large-openai-detector, local): AUROC 0.270 on all 118, 0 of 78 caught at 0.5.
- Calls: 270 of 270 claude-sonnet-5-5 and 12 of 12 claude-opus-5-5 review calls; no Codex.

## Version 6 (2026-11-19)

Written by the audit agent between 2026-11-18T19:58Z and 20:01Z (2026-11-19 local time), before any version 6 text was read or scored and before any tuning. At 19:58:43Z `bench/data/v6/plan.json` held the 116 planned requests and `bench/data/v6/texts/` was empty; agent A began writing the AI texts while this section was being written (73 files at 20:01:44Z). The author of this section read none of them, and nothing below depends on them.

**Why.** The owner pasted five texts written by AI into the AI-writing check: three from Claude (claude.ai) scored 12, 24 and 20 and were not flagged, and two from ChatGPT scored 59 and 58 and were flagged. Version 5 showed the cause: the review prompt treats concrete detail as a human sign, and current models fill their texts with concrete detail (1 of 78 Claude texts flagged). Version 6 tests a retrained style model, a revised review prompt and a combined headline against the shipped check. The goal is to flag more text from current models, above all Claude, while human writing stays rarely flagged. It is not to score the owner's five texts high, to match any website, or to help any text avoid detection.

**Systems.** Every score is on a 0 to 100 scale. A text without a score counts as not flagged and ranks lowest.
- **S0, shipped (the baseline):** the current review and scoring, run from a copy of the code whose files have these sha256 values: `server/prompts.js` e6ec3872eabb3519f70ecd69d06c8fd247afb8016c760a05fdc5fb6355bdb553, `server/checks/aiscore.js` c49c57bd56298aa6c7a53ecc43a8cc266f97825be774f3934b62c952c68ca8e9, `server/checks/text.js` 31e7dbf2257196d334993aec7eda1308cb49fd49372a7deb1edd2bd595027ae5. The score is the word-weighted mean sentence rating (`documentScores().meanRating`), flagged at 53.8 or more. Its line is never refit. Its development numbers come from the cached version 5 replies only.
- **S1, style model version 4 alone (agent B):** the probability of `server/checks/style.js` with the version 4 model, times 100. It needs no model call and is deterministic. Version 3 (`style.js` 3e35db8b, `style-model.json` 085b941d) is reported beside it for reference only.
- **S2, review prompt version 6 (agent C):** the same pattern score from the new `AI_REVIEW_SYSTEM` and `aiReviewPrompt`. A prompt that changes any word of the rules that errors, proficiency, non-native phrasing, formality, topic and citations are never evidence cannot be selected.
- **S3, combined headline (agent C):** S2's mean rating combined with S1's probability, optionally with S2's whole-text `overall` rating. At most two forms are tried and both are reported: a weighted mean with weights in steps of 0.1, and a logistic regression on at most three inputs without interactions. The form, the weights and the line are fitted on development texts only.
- **Comparison only:** the local open-source detectors run by agent A, each at its published default line and at a line set on development by the rule below. They are reported and can never be selected.

**Data and splits** (agent A, `bench/v6/data-*.js`; texts only in the git-ignored `bench/data/v6/`).
- Version 5's 118 texts may be used for training and development only, because the style model's and a candidate's scores were seen on all of them. They never enter the holdout and keep their version 5 groups.
- New AI texts: the 116 requests of `bench/data/v6/plan.json` (claude-haiku-5-5 50, claude-sonnet-5-5 60, claude-opus-5-5 6), 80 to 400 words, encyclopedic, short-answer, essay, report, email and blog texts, some asking for a plain human tone. The owner's topics (Star Wars, Jabba, Jedi, Crocs, Beast Boy, Star Trek) are left out. Non-Claude AI text comes only from public datasets already on disk and is never generated.
- New human texts: Wikipedia introductions from revisions before 2022-11-30 on the same topics as the encyclopedic AI texts (CC BY-SA 4.0), and student essays, non-native essays and human answers already on disk; the target is at least 120 human texts, at least 30 of them by non-native writers. A text counts as new only if its text hash is in no earlier Lectern training set, fairness set or benchmark (versions 1 to 5, including the 90 TOEFL essays of the style model's fairness test). Agent A records this check and each source's licence and revision.
- Classes: *AI* is any text whose words a model wrote (version 5's model-edited drafts included); *Claude* is the part of it written by a Claude model; *human* is text written by people before 2022-11-30 or taken from a dataset of human writing; *non-native* is a human text whose source labels its writer as an English learner or non-native writer.
- Splits of the new texts: training 50% (style model only), development 25% (every choice) and holdout 25% (one final run), with a fixed seed and grouped so that no topic or request is in two splits; an AI text and the Wikipedia introduction on its topic share a group.
- The holdout texts are written to disk and their ids and sha256 values to `bench/data/v6/holdout.sha256` before any tuning. Nobody reads or scores them before the single final run, which first checks those hashes.
- The **holdout review set** (the texts that S0, S2 and S3 are run on) is fixed in the same file at split time: 18 AI texts (at least 14 written by Claude) and 18 human texts (at least 6 non-native), taken in order of sha256("v6-review|" + id) within each cell, or every text of a cell that is smaller. S1 and the open-source detectors are scored on the whole holdout.
- The owner's five texts are in no split, are never used for any choice, are scored by no version 6 system before the freeze, and are reported separately at the end.

**Primary measures (holdout).** For every system: the share of AI texts flagged, overall and for Claude-written texts only; the share of human texts flagged, overall and for non-native writers; and AUROC (human against AI). Every share is reported as a count of n with a Wilson 95% interval, and AUROC with a 2,000-sample bootstrap interval. Differences against S0 in AI flagged, human flagged and AUROC use a paired bootstrap on the holdout review set: 2,000 resamples of groups within class, seed 20261119, 95% percentile interval. "Better than S0" needs the interval for AI flagged to exclude 0 and no more human texts flagged than S0. Secondary results, never used for a claim: by writer model, genre, request style, human source and length (80 to 150 and 151 to 400 words), the AUROC of word count alone as a reference, and every text without a score.

**Selection (development only, rule fixed now).**
1. Line: each candidate's line is the lowest value, rounded up to one decimal, at which at most 5% of development human texts and at most 5% of development non-native texts are flagged (a text is flagged at or above the line). S1's line uses all development texts; S2's and S3's lines use the development review set: every development text if C's budget allows after the reserves below, otherwise at least 30 development texts (at least 12 human, at least 4 of them non-native), taken in order of sha256("v6-dev|" + id) within each cell and fixed before the first S2 development call.
2. Stability gate (S2 and S3): the final S2 prompt is run a second time on at least 15 texts of the development review set (at least 6 human, at least 2 of them non-native, and at least 6 written by Claude), taken in order of sha256("v6-repeat|" + id) within each cell and fixed before the first run. A system cannot be selected if the median absolute change of its document score between the two runs is more than 8 points, or if more than 10% of those texts (more than 1 of 15 to 19) change decision at its line.
3. Model gate (S2 and S3): one claude-opus-5-5 run of the final S2 prompt on 9 development texts (5 human, at least 2 of them non-native, and 4 written by Claude), taken in order of sha256("v6-opus|" + id) within each cell. A system cannot be selected if, at its line, it flags 2 or more of those 5 human texts on Opus. This replaces the after-the-fact Opus check of version 5.
4. Choice: among S1, S2 and S3, those that pass the gates, the one that flags the most AI texts of the development review set at its own line is chosen. A lead of one text or less counts as a tie, and ties go to the simpler system, in the order S1 (no model call, deterministic), S2 (one call), S3 (one call and fitted weights). If no candidate passes, S0 stays.
5. Freeze: the choice, its line, any weights, and the sha256 of `server/prompts.js`, `server/checks/aiscore.js`, `server/checks/text.js`, `server/checks/style.js`, `server/checks/style-model.json` and `bench/data/v6/holdout.sha256` are written to `bench/results/review6-frozen.json` before the holdout run. Then every system, not only the chosen one, is run once on the holdout, and the development table of all systems is reported. Nothing that rates or scores is changed after the holdout is seen; a later change needs a new version with new texts.

**Calls and budget.** The owner approved the "Standard" budget: at most 250 claude-haiku-5-5 or claude-sonnet-5-5 calls and 20 claude-opus-5-5 calls in total. Agent A has 120 and 6 Opus (writing texts), agent C 130 claude-sonnet-5-5 and 9 Opus (reviews), agents B and D none, and the lead 5 Opus (the owner's five texts in the real app, after the holdout run). Agent C's Sonnet calls are reserved first for the holdout (S0 and S2 on the 36 texts of the holdout review set, 72 calls) and the stability run (at least 15 calls); prompt development and the development review set use the rest. Every paid call is logged in the team's `calls.jsonl`, and the scripts refuse to start a call past their share. Claude Code only: the engine is forced to claude-code, the codex program is blocked, and a reply whose provider-reported model differs from the one requested stops the run. No repeat runs: every reply is cached by model, prompt hash and text hash, so nothing is paid twice; the stability run is the only planned second call on a text and carries a run number in its cache key; a failed or partial reply counts as no score and is not asked again, except that a call that returned no reply at all may be sent once more and is logged.

**Claim rule ("Validated").** The app may show "Validated" only if the frozen system meets all of these on its single holdout run: (a) at least 60 human holdout texts were scored, at least 20 of them by non-native writers; (b) the lower Wilson 95% bound of AI texts flagged is at least 80%, overall and for Claude-written texts separately (for example 29 of 30 or 55 of 60); (c) the upper Wilson 95% bound of human texts flagged is at most 10% overall (at most 1 of 60) and at most 20% for non-native writers (0 of 20, or at most 1 of 30); (d) it passed the gates above. Because the holdout review set has 18 human texts, S2 and S3 cannot meet (a) in version 6; only S1 can, and only if the holdout holds enough human texts (inferred: at the planned sizes it may not). If the rule is not met, `DETECTOR_VALIDATED` stays false and the app keeps "Not validated". A met rule covers only the text types, lengths and models tested.

**What the app says.** Either way, the limits list in `server/checks/aiscore.js` and `report.benchmark` give the version 6 holdout numbers of the shipped headline as counts with n and 95% intervals, the models and text types tested, and the date. They never say "100%", never say that the check detects Claude or any model in general, and never say that a low score clears a text. If the rule is met, the badge may read "Validated" next to those counts, with the words "not proof of who wrote it". If it is not met, the badge stays "Not validated", and the text states how many AI texts were caught, how many human texts were flagged (with the non-native rate), and that a score is a reading, not proof. If no candidate passes the selection, the app keeps S0 and says that the version 6 test found no better system. The owner's five texts are reported separately and are never quoted as validation.

**Known limits, stated before any result.** The writers and the reviewer are the same model family. The requests were written by an agent, not by students. Wikipedia introductions are edited by many people and may be in the models' training data; they are the hard case for false positives on purpose. Non-Claude AI text comes only from older public datasets, so the result says little about current ChatGPT or Gemini text. The review runs on claude-sonnet-5-5 while the owner uses claude-opus-5-5, which is checked on only 9 development texts. The edits in version 5's edited texts are light model edits, and no new edited text is made. No adversarial rewriting is tested. All counts are small.

### Version 6 deviation log
(Any step not done as written above is entered here, with its date and whether it was before or after the holdout run.)

Entered by lectern-2a from agent A's report, 2026-11-18T20:16Z, before any version 6 system was scored on development or holdout
texts (only agent A's comparison detectors had scored them, and their holdout numbers were written to a file nobody has
opened).
1. The new-text hash rule counts `bench/data/holdout.jsonl` (the version 4 and 5 benchmark) as an earlier set, so no HC3,
   RAID or Liang text is new, and the 90 TOEFL fairness essays are not used. New human texts are Wikipedia introductions
   (72, revisions before 2022-11-30, CC BY-SA 4.0) and DACTYL texts (ELLIPSE learners as the non-native writers, Ivy
   Panda essays, abstracts, news; MIT card). 13 DACTYL texts that matched an earlier set were dropped. Consequence: the
   non-native writers are US school learners (ELLIPSE), not exam essays.
2. 4 of the 116 AI texts written for version 6 fell outside 80 to 400 words and were left out (112 kept). Their replies
   stay cached; none was written again.
3. The human quotas for Ivy Panda essays, abstracts and news were raised before any score existed, so that the holdout
   holds 61 human texts (22 non-native), enough for the claim rule's 60.
4. The 50/25/25 split holds for the whole corpus (train 201, dev 105, holdout 98), but the new texts alone fall about
   50/14/36, because the 118 version 5 texts may go to train and dev only.

5. (2026-11-19, agent C, before the first development call) Review sets fixed in `bench/v6/review-sets.js` (ids in the git-ignored `bench/data/v6/review-sets.json`). Budget: 130 Sonnet calls less 72 for the holdout less 15 for the stability run leaves 43, so the development review set is 40 of the 105 development texts (22 human, 8 of them non-native, 18 AI), taken in order of sha256("v6-dev|" + id) within three cells (human non-native, human native, AI); 3 calls stay spare for a call that returns no reply. The stability set (15: 6 human with 2 non-native, 9 AI, all Claude) and the Opus set (9: 5 human with 2 non-native, 4 AI) are drawn by sha256("v6-repeat|" + id) and sha256("v6-opus|" + id) from inside the review set, so the same texts have Sonnet ratings to compare with. With 22 human and 8 non-native review texts, the 5% rule allows 1 human and 0 non-native texts flagged at the line.
6. (same time) S0's development numbers come from the cached version 5 replies of the 61 development texts that are version 5 texts (matched by text hash); S0 was not run on the 44 new development texts. S3's two forms are fitted on the 40 review texts, the same texts the line is set on, so its development numbers are optimistic (inferred); S3's logistic form uses the two inputs S2 mean rating and the style probability (not `overall`).
7. (2026-11-18T20:30Z, lectern-2a, before any holdout run; no holdout text or score seen.) Two constraints are added to S1's selection,
   because development holds only Claude-written AI text and only 14 non-native writers, so the dev rule alone could not see
   them. Agent B's first version 4 (the "core" feature set) flagged 22 of 56 Claude dev texts but fell from AUROC 0.889
   (version 3) to 0.652 on the DACTYL test sample of older generators, and a looser set that flagged more Claude text
   flagged 42-44% of the old TOEFL essays. S1 must now also (b) flag no more of the old TOEFL essays (11 of 86) and native
   student essays (14 of 209) than version 3, and (c) keep DACTYL test-sample AUROC at least 0.85, with at least half of
   version 3's AI flagged there. Among those that pass, the most Claude dev AI flagged wins, as before. These sets were
   used before (they are not fresh), so they serve as safety limits only, never as evidence for a claim.
8. (2026-11-18T20:50Z, lectern-2a, before any holdout run; no holdout text or score seen.) Under deviation 7 no single style model
   passed both limits with useful Claude detection. Agent B tried 576 configurations: the best single model passing (b) and
   (c) flagged 7 of 56 Claude dev texts. S1 is therefore defined as **either of two models**: version 3 (older generators)
   at its line 0.94, OR the version 4 core model (current Claude text; no paragraph, sentence-length, word-length,
   vocabulary-size or entity features) at its line 0.77. The shown score lifts each model so that its line is 0.5, and takes
   the higher. The two lines were chosen on dev (a grid of 40 by 111 pairs; optimistic) as the pair that flags the most
   Claude dev texts while **every** human set stays at or under 5%: dev human 0 of 49, dev non-native 0 of 14, TOEFL 2 of
   86, native student essays 3 of 209, DACTYL human 2 of 200. Result: Claude dev 21 of 56 (37.5%, 25.9-50.8%); DACTYL test
   sample AUROC 0.887 and 467 of 895 AI flagged. A looser pair (TOEFL limit "no worse than version 3", 11 of 86) would
   have flagged 37 of 56 Claude dev texts; it was not taken, because 12.8% of non-native exam essays is not acceptable for
   a tool used on students' work. The app's `styleReading` reproduces these counts exactly (parity check, lectern-2a).
   Files: `server/checks/style.js` (kind "either"), `server/checks/style-model.json`; round 2's single model is kept at
   `bench/data/style/model-v4-round2.json`, and the core model at `bench/data/style/model-v4-core.json`.

9. (2026-11-19, agent C, after the development analysis with style version 4 "either", before any holdout call and before the freeze file was written.) Development result and what was done (full numbers in `bench/results/review6-dev.json`, the choice in `bench/results/review6-frozen.json`): the rule picked **S3 weighted**, a fixed weighted mean 0.3 x (S2 mean rating) + 0.7 x (S1 score), flagged at 41.1 (development review set: 16 of 18 AI, 1 of 22 human, 0 of 8 non-native; S1 alone 7 of 18, S2 alone 7 of 18 at its line 52.1). S3 logistic (the other form) failed the stability gate (2 of 15 decisions changed) and could not be selected. S1's score for S3 is the lifted probability x 100, kept on the same side of 50 as the app's own flag (a rounded 0.500 for a text just under its line would otherwise be flagged); the S1 line is 50 as fixed by deviation 8. Because S3 is fitted on the same 40 texts it is selected on, its development numbers are optimistic (inferred). Two changes were made before the freeze so that the holdout runs on the code that ships: the version 6 prompt was put into `server/prompts.js` (identical to `S2_SYSTEM`, checked by a test), and `server/checks/aiscore.js` now computes the S3 headline (scoring version 4) from the pattern score and `styleReading`; the S0 prompt is kept as `bench/v6/review-prompt-s0.txt` (sha256 of its text 03c63305...; the file `server/prompts.js` it came from had sha256 e6ec3872...). After the holdout only the text of `BENCHMARK` and `LIMITS` in `aiscore.js` and the tests are changed.
10. (2026-11-19, agent C, after the holdout run) Only `server/checks/aiscore.js` (sha256 now 88e062a2...) and tests changed after the freeze: the text of `BENCHMARK` and `LIMITS` was replaced with the holdout numbers, the file comment was rewritten, and one display detail was added, `scoreExact = Math.floor(raw * 10 + 1e-9) / 10` (the epsilon only stops a headline of exactly 41.1 from being shown as 41.0 through floating-point error). `flagged` and `score` are computed from the unrounded headline as before; the parity check on the 36 holdout review texts (the report's own `flagged` against the frozen formula, `bench/results/review6-holdout.json`, `parity`) found 0 differences before these edits. `server/prompts.js` is unchanged since the freeze (sha256 2b38b15c...). `test/checks.test.js` had one assertion that assumed the version 3 headline; it now asserts the pattern score and the new line.
11. (2026-11-19, **AFTER the holdout run**, decided by lectern-2a as lead because the owner was asleep and had asked for the recommended option; entered by agent C.) The headline that ships is **S2**, not the frozen choice S3. Reason: on the single holdout run the frozen S3 (0.3 x S2 mean rating + 0.7 x S1 style score, line 41.1) flagged 14 of 18 Claude-written texts (77.8%, 54.8-91.0) but also 3 of 18 human texts (16.7%, 5.8-39.2; 2 of 6 Wikipedia introductions and 1 of 2 Ivy Panda essays, all through the style score), against 1 of 18 for S0, and 0 of 6 non-native. S3's paired gain over S0 was +55.6 points of AI flagged (33.3 to 77.8) with 2 more human texts flagged (0 to 5), so it did not meet the rule for "better than S0" (no more human texts flagged than S0). S2 alone (the version 6 prompt, line 52.1, frozen on development before the holdout in `bench/results/review6-frozen.json`) flagged 10 of 18 Claude texts (55.6%, 33.7-75.4) and 1 of 18 human texts (5.6%, 1.0-25.8), 0 of 6 non-native, AUROC 0.861 (0.709-0.974); against S0 (4 of 18 AI; 1 of 18 human; AUROC 0.767) its paired gain is +33.3 points (11.1 to 55.6), human flagged +0 (0 to 0), AUROC +0.094 (0 to 0.205). S2 is the only candidate that meets the registered "better than S0" rule. S1 alone (style model, line 50) on the whole holdout: 19 of 37 AI (51.4%), 6 of 61 human (9.8%, 4.6-19.8), 1 of 22 non-native, AUROC 0.852. **What this means for the numbers:** the shipped system was chosen after the holdout was seen, among the three registered candidates (S1, S2, S3), on the ground that the frozen choice flagged too many human texts; its holdout numbers are therefore slightly optimistic and are not a clean single-shot test (inferred: the direction of the bias is optimistic, its size is not known). No prompt, weight or line was changed: S2's prompt and line 52.1 are exactly those frozen before the holdout, and no new model call was made. The claim rule is still not met (S2 was scored on 18 human texts, 6 non-native, not 60 and 20), `DETECTOR_VALIDATED` stays false, and the app says all of this in its limits list. Code: `server/checks/aiscore.js` (sha256 now 739cf9a87b9b06ae1373d0a7f230c321de721226d8633b1ffcb605091dac0fcc) has the headline equal to the word-weighted mean rating, flagged at 52.1 (whole-number line 53), SCORING.version 4; the S3 helpers and numbers stay in `bench/v6/review-s3.js`, `review-holdout.js` and `bench/results/review6-holdout.json` for the record. The style reading stays a separate second reading (`report.style`) and is not part of the score. `server/prompts.js` is unchanged since the freeze (sha256 2b38b15c5d56bf5bdb79ed9afdf4ca86caa1970bfef19334e846edcf4d133fa1).
12. (2026-11-18T21:04Z, lectern-2a, AFTER the holdout.) `server/checks/style-model.json` changed only in its description: `tested.holdout`
   now holds S1's single holdout run (19 of 37 Claude texts, 6 of 61 human, 1 of 22 non-native, AUROC 0.852), and the first
   weak spot quotes it. No weight, line or feature changed: the parity check gives the same dev and diagnostic counts as
   before (Claude dev 21 of 56, human 0 of 49, non-native 0 of 14, TOEFL 2 of 86, native 3 of 209, DACTYL 467 and 2). The
   window's style-model text and the "two readings disagree" note now quote these held-back numbers. "Most often by
   non-native writers", true of version 3, was removed: version 4 flagged 1 of 22 non-native and 5 of 39 native human texts.

13. (2026-11-19, agent D, final audit, after the holdout run.) (a) This is an independent check of deviation 12. The sha256 of `server/checks/style-model.json` changed from 0b0ca04e8adbdf6a... in the freeze file to 0d377a856fbc... (modified 21:04:17Z). The audit scored the 98 holdout texts again with the current file and the app's `styleReading`. All 98 decisions and all 98 scores (within 0.15 points) matched `bench/results/review6-holdout.json`. The development, TOEFL, native and DACTYL counts were also reproduced (`parity.js`). The audit did not compare the file line by line, because the frozen copy was not available. (b) S0 was not run on the holdout from a copy of the code pinned to the three hashes above. `bench/v6/review-run.js` ran the working tree with S0's system prompt swapped in, and its run file records scoring version 4 and line 41.1, although S0 is judged at 53.8. The audit checked the following against a copy of `server/prompts.js` e6ec3872: the system prompt is the same (text sha256 03c63305...), and `aiReviewPrompt`, `parseReview`, `documentScores`, `batches`, `unitsOf` and `measure` have the same source code in the working tree, while `text.js` is the pinned 31e7dbf2. S0's holdout ratings are therefore the registered ones, as far as these functions decide them. (c) Correction: deviation 8's interval for 21 of 56 ("25.9-50.8%") is not the Wilson interval. The Wilson interval is 26.0 to 50.6%, as in `bench/results/review6-dev.json`.
14. (2026-11-18T21:11Z, lectern-2a, AFTER the holdout; wording only, from agent D's audit.) In `server/checks/aiscore.js` LIMITS (sha256
   now 2a2be78f...):
   (a) "the score reached 53 or more on 10 of 18" became "the review flagged (an exact mean of 52.1 or more, shown as 53 or
   more) 10 of 18", because one flagged text had a mean of 52.4;
   (b) "slightly optimistic" became "may therefore be optimistic; by how much is not known";
   (c) the 18 human texts are named in full (Wikipedia 6, ELLIPSE learners 6, Ivy Panda 2, abstracts 2, news 2);
   (d) the style line adds that it flagged 4 of the 25 Wikipedia introductions in the holdout (recounted from
   `bench/results/review6-holdout.json`).
   Correction to deviation 11: "all through the style score" holds for 2 of S3's 3 human flags (the two Wikipedia
   introductions; S2 30.9 and 32.9). The Ivy Panda essay (hu-ivy-4, S2 56.3) is also flagged by S2 alone, and it is S2's one
   human flag. No number, line or decision changed.

## Version 7 (2026-11-19): AI text made to look human, and text passed through Rewrite

Written by lectern-2a at 2026-11-18T22:04Z, before any version 7 text exists.

**Why.** The owner found that text passed through Lectern's Rewrite tool, and AI text written to sound human, is the
case they care about. They asked for a rewriter that gets past detectors; that was declined (it would hide authorship).
They chose instead to harden the check: find what the shipped check misses in such text and improve the check, without
flagging more human writing. Agents: Haiku 5.5 (writer) and Sonnet 5.5 (check), no Opus. Budget about 60
claude-haiku-5-5 and 80 claude-sonnet-5-5 calls, each run once, every call logged; Claude Code only, Codex blocked.

**Data.**
- About 45 new AI texts by claude-haiku-5-5, on topics not used in versions 5 and 6 and not the owner's:
  - about 30 written to requests asking for a natural, human, student-like or casual voice;
  - about 15 passed through Lectern's own Rewrite tool (`runRewrite` in `server/checks/rewrite.js`, model
    claude-haiku-5-5, styles General, Casual, Blog and Academic).
- At least 60 new human texts never used before (hash-checked against every earlier set): Wikipedia introductions from
  revisions before 2022-11-30 on new topics, and unused DACTYL human texts, with at least 15 non-native.
- Splits grouped by topic: train about 45% (the style model only), dev about 25%, holdout about 30%. The holdout is
  hashed before any score.
- The review (model) runs only on fixed review subsets chosen by sha256("v7-review|"+id): dev 10 AI + 10 human, holdout
  10 AI + 10 human. The style reading (free) runs on every text.

**Systems.**
- B0: the shipped version 6 check (review prompt v6 headline at 52.1; style model version 4 as the second reading).
- R1: one revised review prompt (version 7) for the headline.
- T1: style model version 5, retrained with the version 7 train split.
- At most one revision of each, made from dev only. No second round.

**Rule.**
- A revision ships only if, on dev:
  - it flags more of the version 7 AI texts than B0;
  - it flags no more human texts than B0;
  - for T1, human false positives on dev are at most 5% overall and at most 5% for non-native writers;
  - for T1, the version 4 limits are kept: TOEFL at most 2 of 86, native student essays at most 3 of 209, version 6
    dev Claude detection not lower.
- All fairness bans in the prompt stay word for word.
- Then one holdout run: B0 and the chosen revision on the holdout review subset, and the style models on the whole
  holdout. Reported with n and Wilson intervals, paired against B0.
- If the holdout shows more human texts flagged than B0, the revision is not shipped.
- "Not validated" stays.
- The owner's texts are never used.

### Version 7 deviation log
(Any step not done as written above is entered here, with its date and whether it was before or after the holdout run.)

1. (2026-11-19, agent S, before any score.) Data. The human controls are 79 texts: 41 Wikipedia introductions (CC BY-SA 4.0; 11 of the 53 requested titles failed after retries or were too short, and were not repeated), 20 DACTYL-ELLIPSE essays by English language learners, 8 DACTYL Ivy Panda student essays, 6 DACTYL abstracts and 4 DACTYL news texts, all hash-checked against every earlier set (115 DACTYL candidates were refused as already used). There are no casual human texts (blogs, emails, reflections) among them, because every such text on disk was used in an earlier version; the false-positive rate of the new prompt on casual human writing is therefore not measured. The AI side is agent H's 43 texts (30 written to a human-voice request, 13 Rewrite outputs); the 2 lost rewrites that lectern-2a recovered later (rw07, rw09) were not added, because the splits and the holdout hash were already written. A first version of `bench/v7/data-human.js` looked for native essays with category info, found none, and was changed to the Ivy Panda essays before the split was built.
2. (2026-11-19, agent S, before any score.) Splits (`bench/v7/split.js`, seed v7-split-2026-11-19, by group): train 20 AI + 36 human, dev 10 AI + 20 human, holdout 13 AI + 23 human; the holdout is hashed in `bench/data/v7/holdout.sha256` before any model call. Because dev holds only 10 AI texts, the dev review subset (10 AI + 10 human by sha256("v7-review|"+id)) holds all of them. The holdout review subset is 10 of 13 AI and 10 of 23 human texts. A rewrite is grouped with the id of the earlier text it was made from.
3. (2026-11-19, agent S, before the holdout.) B0 is the working-tree prompt, copied unchanged to `bench/v7/review-b0.txt` (sha256 130f3eed...; equal to `S2_SYSTEM` of version 6) and the working-tree style model (copy in `bench/v7/style-model-b0.json`). The runner swaps the system prompt in at call time as in version 6, so `server/prompts.js` stayed unchanged until after the holdout.
4. (2026-11-19, agent S, before the holdout.) R1 (`bench/v7/review-r1.txt`) adds pattern 9 "staged human voice", a line that casual or student-like wording is no evidence either way, a line that a regular long-short alternation is rhythm, and matching scale lines. Every ban and the taught-frame guard are word for word (checked by test). Its length is 7,885 characters, so the prompt length limit in `test/prompts.test.js` rose from 7,000 to 8,200. It was run once on the dev review subset: flagged 3 of 10 AI texts (B0 2 of 10) and 0 of 10 human texts (B0 0 of 10); it met the rule on dev and was frozen. Its dev gain is one text (it flagged hv29 and hv17 that B0 missed, and lost rw12 at 51.4 against the line 52.1).
5. (2026-11-19, agent S, before the holdout.) T1 (style model version 5: the version 4 core model retrained with the 56 version 7 train texts, version 7 texts weighted as version 6 cells; code in `bench/v7/style-train.js`, which first reproduces the shipped version 4 core model exactly) was built with the line chosen on v6 + v7 dev under the version 4 limits (core line 0.786; version 3 part at 0.94 unchanged). It flagged 3 of 10 v7 dev AI texts (B0 3) and 20 of 56 v6 dev Claude texts (B0 21), so it failed the rule and was not shipped; B0's style model stays. T1 was not run on the holdout. Numbers: `bench/results/style7-dev.json`.
6. (2026-11-19, agent S, before the holdout.) `bench/results/review7-frozen.json` was written before any holdout call. Its hash of `server/prompts.js` is the B0 file; R1 is frozen as `bench/v7/review-r1.txt`. The holdout ran B0 and R1 on the 20-text holdout review subset (40 calls) and the B0 style model on all 36 holdout texts. Calls: 80 of 80 claude-sonnet-5-5 (20 B0 dev, 20 R1 dev, 20 B0 holdout, 20 R1 holdout), no repeat, no error; every reply reported claude-sonnet-5-5; no Opus; no Codex.
7. (2026-11-19, agent S, after the holdout.) Holdout: R1 flagged 1 of 10 AI texts and 0 of 10 human texts; B0 flagged 0 of 10 and 0 of 10. R1 did not flag more human texts than B0, so the rule allowed shipping it. After the holdout `server/prompts.js` was changed to the R1 text (its hash therefore differs from the freeze; the new text equals the frozen `bench/v7/review-r1.txt`, checked by `test/prompts.test.js`), `SCORING.version` became 5 (the line 52.1 is unchanged), `BENCHMARK.v7` and two limits were added in `server/checks/aiscore.js`, and the tests were updated. The version 6 numbers in `BENCHMARK` (10 of 18 and so on) were measured with the version 6 prompt; the limits now say so. R1 was not re-run on the version 6 holdout, so the version 6 numbers are not numbers of the shipped prompt.
8. (2026-11-19, agent S, after the holdout.) Not done: a run-to-run spread check; any test on casual human writing; any writer of test AI other than Haiku; any Rewrite change. Descriptive only (not a registered system): on the holdout review subset, review R1 or style flagged 5 of 10 AI and 0 of 10 human texts.
9. (2026-11-18T22:29Z, lectern-2a, AFTER the holdout.) R1 passed the registered rule (dev: 3 of 10 AI against 2, 0 of 10 human
   against 0; holdout: 1 of 10 AI against 0, 0 of 10 human against 0) but is NOT shipped; the version 6 prompt is
   restored in `server/prompts.js` (its AI_REVIEW_SYSTEM sha256 130f3eed..., the audited version 6 text, identical to
   `bench/v7/review-b0.txt`), and `SCORING.version` is back to 4. Reasons:
   (a) the gain is one text in ten on each split, which cannot be told from chance;
   (b) R1's new cues (self-doubt, wry asides, quiet endings, quirky small objects) are what real people use in blogs, emails
   and reflections, and no such human text was available to test (every one on disk had been used before), so its false
   positives on casual human writing are unknown;
   (c) R1 was never run on the version 6 test texts, so the measured headline numbers would no longer describe the shipped
   prompt.
   The version 7 results stay in `report.benchmark.v7` and in LIMITS, worded as what the shipped review does on text written
   to sound human (0 of 10 AI flagged, 0 of 10 human), with R1's numbers as "tested, not used". This is the more cautious
   choice; it does not raise any claim. Files: `server/prompts.js` (prompt and comment), `server/checks/aiscore.js` (version,
   limits, comment), `test/prompts.test.js`, `test/aiscore.test.js`; `npm test` 305 of 305.

