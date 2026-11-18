# Live review benchmark, version 4: result summary

Run 2026-11-18. Rules: `bench/PREREGISTRATION.md`, version 4 (including its deviation log). Data: `bench/review/manifest.json` (no texts here or in git).
Per-document scores without text: `bench/results/review-*.json`. Every interval is a 95% interval (Wilson for rates, percentile bootstrap for AUROC).
Model: `claude-sonnet-5-5` through Claude Code, one run per document and system (the provider reported that model on every reply). Documents: 150 to 700 words, one request each.

## What was compared
- **S0**: the shipped review (git HEAD f41450c). Flag when the headline (share of reviewed words in sentences rated 65 or more) is 20% or more.
- **Selected system, S2/meanRating**: the new prompt (agent C) with the word-weighted mean sentence rating as the document score, flagged at 53.8 or more.
  It was chosen on the development split by the pre-registered rule (highest detection of AI plus AI-edited with 0 of 14 development humans flagged; candidates S0, S1, S1b and S2 with
  every score) and frozen in `bench/results/review-frozen.json` before any holdout run. On development: detection 17 of 22 (77%, 57-90%), AI 11 of 11, AI-edited 6 of 11 (55%, 28-79%), AUROC 0.851.
- Development was small (14 human, 11 AI, 11 AI-edited), so the choice was noisy; the holdout is the test.

## Holdout, all documents (primary): 22 human, 16 AI, 16 AI-edited
| Measure | S0 | S2 / meanRating |
|---|---|---|
| False positives, human | 3 of 22 = 14% (5-33%) | 2 of 22 = 9% (3-28%) |
| Non-native (ELL) human flagged | 1 of 8 = 13% (2-47%) | 0 of 8 = 0% (0-32%) |
| Student human flagged | 1 of 7 (3-51%) | 1 of 7 (3-51%) |
| Detection, AI plus AI-edited | 13 of 32 = 41% (26-58%) | 18 of 32 = 56% (39-72%) |
| Detection, AI | 10 of 16 = 63% (39-82%) | 10 of 16 = 63% (39-82%) |
| Detection, AI-edited | 3 of 16 = 19% (7-43%) | 8 of 16 = 50% (28-72%) |
| AUROC, human against AI plus AI-edited | 0.708 (0.583-0.822) | 0.866 (0.759-0.949) |
| AUROC, human against AI only / AI-edited only | 0.892 / 0.524 | 0.923 / 0.810 |
| Documents without a score (counted as not flagged) | 4 | 1 |

Paired AUROC difference (selected minus S0), stratified bootstrap of 2,000 resamples: **+0.158 (0.064 to 0.257)**. Discordant documents: humans flagged by S0 only 2, by the selected system only 1;
AI or AI-edited flagged by S0 only 1, by the selected system only 6.
By the pre-registered interpretation rule (the AUROC difference interval excludes 0 and the false positive rate is not higher than S0's) the selected system is better on this holdout.

## Holdout without the documents that contain Markdown marks (sensitivity): 22 human, 12 AI, 14 AI-edited
Marks were in 0 human, 4 AI and 2 AI-edited holdout documents. The texts were not changed; the cached replies saw them.
| Measure | S0 | S2 / meanRating |
|---|---|---|
| False positives | 3 of 22 = 14% (5-33%) | 2 of 22 = 9% (3-28%) |
| Detection, AI plus AI-edited | 11 of 26 = 42% (26-61%) | 14 of 26 = 54% (35-71%) |
| Detection, AI / AI-edited | 8 of 12 = 67% (39-86%) / 3 of 14 = 21% (8-48%) | 8 of 12 = 67% (39-86%) / 6 of 14 = 43% (21-67%) |
| AUROC, human against AI plus AI-edited | 0.710 (0.576-0.842) | 0.850 (0.731-0.950) |
Paired AUROC difference: +0.140 (0.049 to 0.233). The conclusion does not depend on the Markdown marks.

## Length reference
AUROC of word count alone (longer = positive), human against AI plus AI-edited: 0.327 (so shorter texts rank as AI-like, equivalent to 0.673); against AI only 0.452; against AI-edited only 0.202
(equivalent to 0.798). The AI-edited documents are much shorter than the human ones, and the selected system's AUROC on them (0.810) is about what length alone gives. Whether the gain on edited text
is more than a length effect is not settled by this benchmark.

## Opus direction check (8 holdout documents without Markdown, 16 Opus calls, direction only)
3 human, 3 AI-edited, 2 AI. On Opus the selected system's mean ratings were: human 9.8, 12.3 and 18.5; AI 73.9 and 69.4; AI-edited 13.9, 21.1 and 39.0; the frozen threshold 53.8 flags both AI documents and no human or
edited document. S0 on Opus gave headlines of 0 for all three humans and all three edited documents and 32 and 57 for the two AI documents. So on Opus, as on Sonnet, the new score keeps humans low and AI high and
ranks edited text a little above human text, but at the frozen threshold it does not flag these three edited documents. Eight documents: no claim.

## What this does not show
- The claim rule is not met and `DETECTOR_VALIDATED` stays false: with 22 human holdout documents the upper bound of the false positive rate cannot be below 5% (0 of 22 gives 14.9%).
- Intervals are wide (22 human, 16 AI, 16 AI-edited, 8 non-native). The two flagged humans of the selected system and the three of S0 are too few to say the false positive rates differ.
- The AI-edited class is mostly Beemo expert edits of 2023-24 open-source models in general (not academic) writing; the AI texts are from 2023-24 models; neither is the owner's kind of text, which was not used for any choice.
- Not tested: repeat runs of the same document, other models than Sonnet (apart from the 8-document Opus check), documents over 700 words, consented real student work, sentence-level accuracy, adversarial rewriting.
- Both systems read the same documents once. The model's run-to-run variation is not measured; the same edited document got a mean rating of 45.5 from Sonnet and 21.1 from Opus under the same prompt, so model-to-model and run-to-run differences can be large.
