# AI-writing review, benchmark version 5: fresh Claude-written texts (2026-11-19)

Later the same day, version 6 (`bench/PREREGISTRATION.md`, Version 6) replaced the review prompt and the style model. The
results below describe the version 5 prompt and the version 3 style model; the app section describes the code as it stood
after version 5.

Rules: `bench/PREREGISTRATION.md`, version 5 and its deviation log (written before any text existed). Code: `bench/review5/`.
Candidate search by the analyst agent: `bench/results/review5-candidates.md`. Texts and model replies stay local in
`bench/data/review5/` (git-ignored); the files in `bench/results/` hold scores only.

## What was tested
The owner asked whether Lectern's AI-writing review recognises text that AI models write, with a target of at least 95%
correct. Two Claude Code agents wrote 78 texts to fixed requests: 30 by claude-haiku-5-5 and 48 by claude-sonnet-5-5, in six
genres (essay, lab report discussion, literature review, abstract, reflective essay, blog post) and five request styles
(plain, "as a second-year student", "read naturally", "as a B2-level non-native student", "concise"). 18 of the Sonnet texts
were drafts that the agent then revised like a student would; a median of 13.6% of their words were new (6.2% to 21.1%), so
they are lightly edited. 40 human texts were drawn with a fixed seed from sources written before 2023 (Liang et al. 2023:
7 CS224N reports, 7 college essays, 8 TOEFL essays by non-native writers; RAID: 6 abstracts, 6 news, 3 books; HC3: 3 Reddit
answers). Every review used claude-sonnet-5-5 through Claude Code, one run per text.

## Results
| System | All texts correct | Human texts flagged | AI and edited caught | AUROC |
|---|---|---|---|---|
| Shipped review (pattern score at 54), all 118 | 41 of 118 = 34.7% | 0 of 40 | 1 of 78 | 0.544 |
| Style reading (local style model, no model call), all 118 | 96 of 118 = 81.4% | 3 of 40 (2 of 8 TOEFL) | 59 of 78 | 0.893 |
| Frozen candidate P3 plus style, test split only (57) | 51 of 57 = 89.5% | 2 of 18 | 35 of 39 | 0.950 |
| Open-source RoBERTa detector (GPT-2 era), all 118, at 0.5 | 39 of 118 = 33.1% | 1 of 40 | 0 of 78 | 0.270 |

- **The shipped review misses almost all text from current Claude models.** Its sentence ratings barely differ between
  human texts (mean 21.4), unedited AI texts (24.0) and edited AI texts (18.9). The model's own reasons show why: the prompt treats concrete detail as a
  human sign, and the AI texts are full of invented but concrete details (marks, measurements, names, citations).
- **The style reading does much better on these texts**, but it also flagged 3 human texts, 2 of them TOEFL essays; its
  earlier fairness test flagged 13.3% of 90 TOEFL essays. Its numbers here include the test split and were seen before the
  candidates were chosen (deviation 2).
- **The best candidate does not hold up.** P3 asks the model to rewrite the text more concisely and measures how many
  words it leaves unchanged (after RAIDAR, Mao et al., ICLR 2024), combined with the style reading. It was chosen on the
  development split by the pre-registered rule and scored 89.5% once on the test split. Two checks afterwards (deviation 3)
  showed that its main input is unstable: on claude-opus-5-5 the unchanged share was 11.52 points higher on average, and at the line
  calibrated on Sonnet the Opus rewrites flagged 4 of 6 human texts (Sonnet's own rewrites: 2 of the same 6); a second claude-sonnet-5-5 run of 5 texts moved the unchanged share by 12.8 to 41.7
  points on every one. It was not put into the app.
- **Target not met.** No system reached 95% correct with at most 5% of human texts flagged. With 18 human test texts, even
  0 flagged would only show a rate below 17.6%.

## Comparison with published results for online detectors (each read at its source on 2026-11-19)
| Source | Detectors | Human texts flagged | AI texts caught |
|---|---|---|---|
| Epoch AI, J. Lee, 15 July 2026, 495 pre-ChatGPT human passages, 297 AI passages per condition from Claude Opus 4.8, GPT-5.5 and Gemini 3.1 Pro ([page](https://epoch.ai/data-insights/ai-text-detection-challenges)) | Pangram / GPTZero / Originality.ai | 0 of 495 / 0 of 495 / 19 of 495 (3.84%) | direct prompt: 297 / 295 / 296 of 297; imitating a real author: 89.9% / 89.2% / 82.2% |
| RAID, Dugan et al., ACL 2024, 2023-era generators, each detector set to about 5% false positives ([paper](https://arxiv.org/abs/2405.07940)) | Originality / Binoculars / GPTZero / RoBERTa-large (GPT-2) | about 5% by design | 85.0% / 79.6% / 66.5% / 56.7% with no attack |
| Liang et al., Patterns 2023, 91 TOEFL essays by non-native writers ([arXiv v3](https://arxiv.org/html/2304.02819v3)) | 7 detectors, not named in the text | 61.22% on average; 89 of 91 flagged by at least one | not the subject |
| Turnitin's own claim, 2023 (vendor claim) ([blog](https://www.turnitin.ca/blog/ai-writing-detection-update-from-turnitins-chief-product-officer)) | Turnitin | under 1% of documents when over 20% is marked AI; about 4% of highlighted sentences | not stated |

No text was sent to any website: every online detector found needs an account or an API key, and their terms for
automated use could not be read. The comparison is therefore with published results on other texts, not a side-by-side
run. On their own published tests, current commercial detectors flag few human texts and catch nearly all plainly
prompted AI text; Lectern's review does not come close on the texts tested here.

## What changed in the app (uncommitted, waiting for "release")
1. `server/checks/text.js`, `blocks()`: text wrapped at a fixed width (copied from a PDF) was cut into fragments because every
   short wrapped line was taken for a heading. Fixed and tested (deviation 1). No version 4 text is split differently.
2. `server/checks/aiscore.js`: the limits list now states this result (`CURRENT_MODELS_TEST`). Nothing that rates or
   scores changed.
3. `ui/checks.js`, `ui/checks.css`: when the pattern score and the style reading disagree, the report shows "The two
   readings disagree", both numbers, the test result and the warning that the style model also flags human writing, most
   often by non-native writers. Neither reading is presented as the better judge. Chosen from six drawn layouts in three
   rounds; checked in light, dark, 390 px, Reduce motion and print emulation; no page errors.

## Not done or not tested
- Model families other than Claude (no ChatGPT use by the owner's rule; Gemini has no key here); real human edits of AI
  text; consented student work; texts over 700 words; the pattern review on Opus for these texts; run-to-run variation of
  the pattern review; the packaged app; Windows.
- A style model retrained with current-model text, which is the most promising next step, needs fresh held-back texts that
  were not used here.

## Calls
270 of 270 claude-sonnet-5-5 review calls (118 shipped, 90 candidate development, 57 candidate test, 5 repeat) and 12 of
12 claude-opus-5-5. No Codex or other engine. The agents' own work (two writers on Haiku and Sonnet, one researcher and one
analyst on Sonnet, one short auditor on Opus) is not counted in these numbers.
