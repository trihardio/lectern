# Version 5: candidate search for the AI-writing review

Written 2026-11-19. Pre-registration: `bench/PREREGISTRATION.md`, "Version 5" and its deviation log. Every candidate was designed and chosen on the development split only. The test split was read once, after `bench/results/review5-frozen.json` was written. The owner's target is 95% correct with at most 5% of human texts flagged.

## Result in one paragraph

The shipped review does not separate the texts at all on this corpus (development subset AUROC 0.640, test AUROC 0.467, 0 of 39 AI and edited test texts flagged). The chosen system, called P3+style, flags 35 of 39 AI and edited test texts and 2 of 18 human test texts: 51 of 57 correct (89.5%). That falls short of the target on both counts: accuracy is 89.5% instead of 95%, and 11.1% of human texts are flagged instead of at most 5% (the 95% interval for 2 of 18 is 3.1% to 32.8%, so the test cannot show that the rate is below 5%, and it cannot show that it is above it either).

## Round 1 (free): candidates from existing data, development split (61 texts: 22 human, 30 AI, 9 edited)

The rule for choosing a threshold in rounds 1 to 4 was set by me before looking at the numbers: the highest threshold with the best balanced accuracy, subject to a cap on human texts flagged. The style reading is used at its frozen threshold 0.772211. The z-mix is the mean of the z-score of the mean rating and the z-score of the logit of the style probability, with means and standard deviations taken on development (mean rating 22.490, sd 10.217; style logit 1.153, sd 2.019).

| Candidate | Threshold | Balanced accuracy | Correct | Human flagged | AI caught | Edited caught | AUROC |
|---|---|---|---|---|---|---|---|
| Shipped mean rating | 53.8 | 51.3% | 23/61 | 0/22 | 1/30 | 0/9 | 0.611 |
| (a) mean rating, threshold re-chosen (same result with at most 0 or 1 human flagged) | 42.9 | 55.1% | 26/61 | 0/22 | 4/30 | 0/9 | 0.611 |
| (b) style reading alone | 0.772211 | 86.2% | 51/61 | 1/22 | 24/30 | 6/9 | 0.923 |
| (c) shipped flag OR style flag | flag | 86.2% | 51/61 | 1/22 | 24/30 | 6/9 | 0.862 |
| (d) z-mix of mean rating and style (same result at 0 or 1 human) | z 0.5338 | 71.8% | 39/61 | 0/22 | 15/30 | 2/9 | 0.837 |
| Open-source RoBERTa-large detector (comparison only) | 0.5 | 50.0% | 22/61 | 0/22 | 0/30 | 0/9 | 0.196 |

Reading: the shipped rating carries almost no signal on these texts, and re-choosing its threshold only moves it from 1 to 4 caught. The style reading is the strong free candidate. (c) flags the same texts as (b) on development, so it adds nothing. Mixing the weak rating into the style reading made it worse. The RoBERTa detector (trained on GPT-2 output) scores Claude text as more human than the human texts (AUROC well below 0.5), so it is no use here.

## Fixed development subset (`bench/review5/dev-subset.json`, seed 5, written before any variant ran)

30 texts: 10 human, 15 AI, 5 edited (ids in the file). On these texts: shipped review 50.0% balanced accuracy (0/10 human, 0/15 AI, 0/5 edited, AUROC 0.640); style reading alone 87.5% (0/10 human, 12/15 AI, 3/5 edited, AUROC 0.955).

## Rounds 2 to 4 (paid): three variants on the subset, 30 calls each

P1 changed only `AI_REVIEW_SYSTEM`, in a copy of the code (`variants/P1` in the scratchpad). It dropped the idea that concrete specifics lower the rating (the model cannot check them), added cues for polish without friction, balanced concession then rebuttal, generic-in-role specifics and evenly sized paragraphs, and changed the 0-20 band to "individual and uneven voice, not merely specific". The sentence "Never use these as evidence in either direction: grammar or spelling mistakes, fluency or language proficiency, non-native English or unusual phrasing, formality, correctness, simple or technical vocabulary, the topic, or citations." is unchanged word for word (checked by string match), and "You do NOT decide who wrote the text" is unchanged.

P2 is rewrite distance (RAIDAR): one call per text asks claude-sonnet-5-5 to "Revise this text", and the score U is 100 times the share of words left unchanged (word edit distance divided by the original's word count, so unchanged text scores 100). A smaller change is more AI-like. P3 is the same with the request "Rewrite this text more concisely". I chose P3 as the third variant because P2's remaining errors were professionally edited human texts (news, an abstract) that the model also leaves alone, and a request to shorten is the one most likely to treat padded model text and tight human text differently. Neither prompt asks who wrote the text.

| System (30 subset texts) | Threshold | Balanced accuracy | Human flagged | AI caught | Edited caught | AUROC |
|---|---|---|---|---|---|---|
| Shipped review | 53.8 | 50.0% | 0/10 | 0/15 | 0/5 | 0.640 |
| Style reading alone | 0.772211 | 87.5% | 0/10 | 12/15 | 3/5 | 0.955 |
| P1 review prompt (shipped line 53.8) | 53.8 | 50.0% | 0/10 | 0/15 | 0/5 | 0.790 |
| P1, threshold re-chosen | 43.7 | 60.0% | 0/10 | 4/15 | 0/5 | 0.790 |
| P1 + style z-mix | z 0.2001 | 87.5% | 0/10 | 12/15 | 3/5 | 0.930 |
| P2 rewrite distance alone | U 89.97 | 82.5% | 0/10 | 11/15 | 2/5 | 0.915 |
| P2 + style z-mix | z 0.0793 | 92.5% | 0/10 | 13/15 | 4/5 | 0.970 |
| P3 concise rewrite alone (at most 0 human) | U 72.92 | 65.0% | 0/10 | 5/15 | 1/5 | 0.915 |
| P3 alone (at most 1 human) | U 63.74 | 90.0% | 1/10 | 13/15 | 5/5 | 0.915 |
| P3 + style z-mix | z -0.3200 | 97.5% | 0/10 | 14/15 | 5/5 | 0.995 |

Mean scores by label on the subset: P1 mean rating human 21.2, AI 32.9, edited 26.2 (shipped: 15.6, 20.9, 14.6). P2 unchanged share human 75.0, AI 91.4, edited 89.9. P3 human 50.3, AI 70.0, edited 71.0. Rewrite distance and style are complementary: style misses short abstracts that rewrite distance catches, and rewrite distance wrongly scores polished human news and an abstract like AI text, which style gets right.

The z-mix parameters and thresholds were fitted on the same 30 texts they are scored on, so 97.5% is in-sample. A leave-one-out check (`bench/review5/loo.js`, refitting on 29 texts each time) gives for P3 + style: 1 of 10 human flagged, 18 of 20 AI and edited caught, balanced accuracy 90.0%; for P2 + style: 1 of 10, 16 of 20, 85.0%. The margin between the highest human z-score (-0.359) and the threshold (-0.320) is thin.

## Round 5: choice and freeze

Selection rule: the highest development balanced accuracy among systems that flag at most 1 of the development human texts (I read the "no more than shipped (0 of 22) and at most 1 of 22" wording as a cap of 1; P3 + style flags 0 of 10, so it also passes the stricter reading), compared on the same subset. P3 + style has the highest value (97.5%) and beats the shipped system (50.0%) and the best free candidate, the style reading alone (87.5% on the subset, 86.2% on all development). Chosen: P3 + style. `bench/results/review5-frozen.json` holds the formula, the parameters (mA 63.5967, sA 12.6532, mS 1.1638, sS 2.1400), the threshold -0.32004626882077625, the development numbers, both rewrite prompts' text and the sha256 of 15 files. `final.js test` re-checks the hashes before it reads any test score.

## Test split, once (57 texts: 18 human, 30 AI, 9 edited)

| System | Threshold | Correct | Balanced accuracy | Human flagged | AI caught | Edited caught | AUROC |
|---|---|---|---|---|---|---|---|
| Chosen: P3 + style | z -0.3200 | 51/57 (89.5%, 95% interval 78.9 to 95.1) | 89.3% | 2/18 | 28/30 | 7/9 | 0.950 (interval 0.883 to 0.997) |
| Shipped review | 53.8 | 18/57 (31.6%) | 50.0% | 0/18 | 0/30 | 0/9 | 0.467 |
| Style reading alone (comparison) | 0.772211 | 45/57 (78.9%) | 81.6% | 2/18 | 24/30 | 5/9 | 0.858 |
| P3 rewrite distance alone (AUROC only) | none | not scored | not scored | not scored | not scored | not scored | 0.883 |
| Open-source RoBERTa-large (comparison only) | 0.5 | 17/57 (29.8%) | 47.2% | 1/18 | 0/30 | 0/9 | 0.221 |

Chosen system's six errors: AI texts missed `sn-labreport-student` and `sn-abstract-esl`; edited texts missed `ed-blog-1` and `ed-abstract-1`; human texts flagged `hu-news-2` and `hu-abstracts-2` (one news text and one abstract, the kinds of polished human prose that both parts read as model-like). By writer: Haiku 15 of 15 caught, Sonnet 20 of 24 (AI and edited). By request style (AI only): concise 6/6, humanlike 6/6, plain 6/6, student 5/6, esl 5/6. By genre: essay 6/6, literature review 6/6, reflection 6/6, blog 6/7, lab report 6/7, abstract 5/7. Human flagged by source: abstracts 1/3, news 1/3, the other five sources 0 of 12.

## Against the target

Not met. Accuracy 89.5% against 95%, human texts flagged 11.1% (2 of 18) against at most 5%. Even 0 flagged of 18 would only have shown a rate below 17.6% (upper end of the 95% interval). The chosen system roughly doubles the human false-positive rate of what the target allows, and the shipped review is far below the target (31.6% correct on test, no AI text caught).

## Calls used

Paid claude-sonnet-5-5 calls this analysis: 147 (P1 30, P2 30, P3 30 on the subset: 90 development calls, under 95; 57 for the one test run, equal to the 57 allowed). Total used with the earlier 118: 265 of 270. No Opus, Codex or other engine call. A first attempt to start the P3 run without `--ids` (which would have sent all 61 development texts) was refused by the permission system before anything ran; no call was spent on it.

## Limits and what was not done

- The decision to look at the style reading came after the all-text style numbers were seen (deviation 2). Its parameters and threshold are the frozen ones, and the combination, the rewrite variants, the z-mix parameters and the threshold were all chosen on development only. The caveat stays.
- Selection rests on 30 development texts (10 human). The threshold margin is thin and leave-one-out estimates 90.0% with 1 of 10 human flagged; the test result (89.5%, 2 of 18) agrees with that estimate, not with the in-sample 97.5%.
- All AI and edited texts in this corpus were written by two Claude models, and the rewriting model is also a Claude model. Rewrite distance probably benefits from that (a model leaves its own kind of text alone). Nothing here shows it works on text from other models, from a human copying model text, or from a different rewriting model. The Haiku texts (15 of 15) were caught more often than the Sonnet texts (20 of 24).
- The corpus has 18 human test texts from seven sources, mostly short; rates for single sources (3 texts each) mean little.
- Rewrite distance is a different tool from the review: the app today shows a sentence-by-sentence pattern review and never an authorship verdict, and a score like P3 + style would be a document-level detector number. Making it a product feature, its wording, and how a flagged human writer could answer it were not designed. It adds one model call per check that returns about as many words as the text. A text with real mistakes changes more under rewriting, which lowers its score (the cautious direction for non-native writers), but short texts under 50 words are not scored and polished, formal human prose is read as model-like.
- P1 (prompt only) improved AUROC on the subset from 0.640 to 0.790 but never reached a usable operating point, and was not tested on the test split. The 2025-26 cue list was not tried in a second form, and no Opus run was done. P1 alone at 53.8 still flagged nothing.
- Not tested: the real app window, a packaged build, texts of other lengths or in other fields, multiple runs per text (one run per text throughout; model output varies).
- Nothing was committed or pushed. The project's `server/`, `shared/`, `ui/` and `test/` were not edited; the P1 copy lives only in the scratchpad.

## Files created

`bench/review5/`: `cand-lib.js`, `round1.js`, `dev-subset.js`, `dev-subset.json`, `round-var.js`, `rewrite-dist.js`, `loo.js`, `final.js`. `bench/results/`: `review5-candidates.md`, `review5-round1.json`, `review5-P1-dev-claude-sonnet-5-5-subset.json`, `review5-P2-dev-claude-sonnet-5-5-subset.json`, `review5-P3-dev-claude-sonnet-5-5-subset.json`, `review5-P3-test-claude-sonnet-5-5.json`, `review5-frozen.json`, `review5-test-result.json`. Rewrite texts and review reasons are in `bench/data/review5/runs/` (git-ignored), and the call log is `bench/data/review5/calls.jsonl`.
