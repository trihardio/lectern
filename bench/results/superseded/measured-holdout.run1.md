# Measured index (style-only) on the holdout split

Run 2026-11-15T09:07:26.272Z. Pre-registration version 1. Threshold 28.00 frozen on dev at 2026-11-15T09:07:19.636Z. Scoring files unchanged since then.
Decision rule: flag when the measured index >= 28.00. Documents: 3650 (886 human, 2673 AI, 91 AI-edited human).

| Measure | Value (95% CI) |
|---|---|
| False positive rate (human texts flagged) | 7.8% (6.2–9.7) |
| Detection rate (AI texts flagged) | 31.5% (29.8–33.3) |
| Abstained or failed | 0.0% (0.0–0.1) |
| AI-edited human texts flagged | 65.9% (55.7–74.8) |
| AUROC (continuous score, human vs AI) | 0.658 (0.637–0.676) |
| Balanced accuracy | 61.9% |
| Precision if 5% / 10% / 20% / 50% of texts were AI | 18% / 31% / 50% / 80% |

Confusion (human/AI only): TP 842, FN 1831, FP 69, TN 817.

## By source

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| RAID | 322 | 6.5% (4.3–9.8) | 1849 | 31.6% (29.5–33.7) | 0 | – |
| Liang2023 | 305 | 14.1% (10.6–18.5) | 348 | 58.0% (52.8–63.1) | 91 | 65.9% (55.7–74.8) |
| HC3 | 259 | 1.9% (0.8–4.4) | 476 | 11.8% (9.2–15.0) | 0 | – |

## By writer group

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| unspecified | 581 | 4.5% (3.1–6.5) | 2325 | 27.5% (25.7–29.4) | 0 | – |
| student, unspecified | 215 | 18.6% (14.0–24.3) | 348 | 58.0% (52.8–63.1) | 0 | – |
| non-native (TOEFL) | 90 | 3.3% (1.1–9.3) | 0 | – | 91 | 65.9% (55.7–74.8) |

## By domain

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| RAID: abstracts | 112 | 7.1% (3.7–13.5) | 709 | 32.7% (29.4–36.3) | 0 | – |
| RAID: books | 94 | 6.4% (3.0–13.2) | 726 | 30.9% (27.6–34.3) | 0 | – |
| RAID: news | 116 | 6.0% (3.0–11.9) | 414 | 30.9% (26.7–35.5) | 0 | – |
| HC3: reddit_eli5 | 169 | 1.8% (0.6–5.1) | 312 | 10.3% (7.4–14.1) | 0 | – |
| HC3: finance | 70 | 2.9% (0.8–9.8) | 93 | 11.8% (6.7–19.9) | 0 | – |
| Liang2023: CS224N_real | 145 | 24.1% (17.9–31.7) | 0 | – | 0 | – |
| Liang2023: CS224N_gpt3PromptEng | 0 | – | 145 | 67.6% (59.6–74.7) | 0 | – |
| Liang2023: CS224N_gpt3 | 0 | – | 141 | 39.0% (31.3–47.2) | 0 | – |
| HC3: medicine | 20 | 0.0% (0.0–16.1) | 71 | 18.3% (11.0–28.8) | 0 | – |
| Liang2023: TOEFL_gpt4polished | 0 | – | 0 | – | 91 | 65.9% (55.7–74.8) |
| Liang2023: TOEFL_real | 90 | 3.3% (1.1–9.3) | 0 | – | 0 | – |
| Liang2023: CollegeEssay_real | 70 | 7.1% (3.1–15.7) | 0 | – | 0 | – |
| Liang2023: CollegeEssay_gpt3 | 0 | – | 31 | 64.5% (46.9–78.9) | 0 | – |
| Liang2023: CollegeEssay_gpt3PromptEng | 0 | – | 31 | 93.5% (79.3–98.2) | 0 | – |

## By generator

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| human | 886 | 7.8% (6.2–9.7) | 0 | – | 0 | – |
| ChatGPT (2022-23) | 0 | – | 476 | 11.8% (9.2–15.0) | 0 | – |
| mistral-chat | 0 | – | 350 | 38.0% (33.1–43.2) | 0 | – |
| mpt-chat | 0 | – | 308 | 25.0% (20.5–30.1) | 0 | – |
| mpt | 0 | – | 258 | 7.8% (5.1–11.7) | 0 | – |
| chatgpt | 0 | – | 256 | 68.0% (62.0–73.4) | 0 | – |
| GPT4 | 0 | – | 145 | 67.6% (59.6–74.7) | 91 | 65.9% (55.7–74.8) |
| llama-chat | 0 | – | 223 | 59.6% (53.1–65.9) | 0 | – |
| GPT3 | 0 | – | 203 | 51.2% (44.4–58.0) | 0 | – |
| gpt3 | 0 | – | 119 | 9.2% (5.2–15.8) | 0 | – |
| mistral | 0 | – | 118 | 14.4% (9.2–21.9) | 0 | – |
| cohere | 0 | – | 112 | 10.7% (6.2–17.8) | 0 | – |
| gpt2 | 0 | – | 105 | 6.7% (3.3–13.1) | 0 | – |

## By attack or edit

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| none | 886 | 7.8% (6.2–9.7) | 824 | 31.3% (28.2–34.6) | 0 | – |
| alternative_spelling | 0 | – | 264 | 38.3% (32.6–44.2) | 0 | – |
| paraphrase | 0 | – | 254 | 7.9% (5.2–11.8) | 0 | – |
| whitespace | 0 | – | 185 | 44.9% (37.9–52.1) | 0 | – |
| article_deletion | 0 | – | 180 | 36.7% (30.0–43.9) | 0 | – |
| zero_width_space | 0 | – | 170 | 0.0% (0.0–2.2) | 0 | – |
| number | 0 | – | 165 | 35.8% (28.8–43.3) | 0 | – |
| upper_lower | 0 | – | 164 | 39.6% (32.5–47.3) | 0 | – |
| perplexity_misspelling | 0 | – | 124 | 66.9% (58.3–74.6) | 0 | – |
| synonym | 0 | – | 115 | 40.0% (31.5–49.1) | 0 | – |
| homoglyph | 0 | – | 115 | 33.0% (25.1–42.1) | 0 | – |
| insert_paragraphs | 0 | – | 113 | 20.4% (14.0–28.7) | 0 | – |
| human text polished by GPT-4 | 0 | – | 0 | – | 91 | 65.9% (55.7–74.8) |

## By length

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| 150-299 words | 337 | 11.6% (8.6–15.4) | 1120 | 35.6% (32.9–38.5) | 0 | – |
| under 150 words | 316 | 4.7% (2.9–7.7) | 868 | 30.1% (27.1–33.2) | 91 | 65.9% (55.7–74.8) |
| 300-599 words | 146 | 8.2% (4.8–13.8) | 558 | 32.6% (28.9–36.6) | 0 | – |
| 600+ words | 87 | 3.4% (1.2–9.7) | 127 | 0.0% (0.0–2.9) | 0 | – |

## Claim check (pre-registered)

NOT MET: fail - overall false positive rate upper bound <= 5%; fail - non-native false positive rate upper bound <= 5%; fail - detection rate lower bound on unattacked AI >= 80%; pass - abstention <= 10%. Strong authorship or accuracy claims stay disabled.

Small groups have wide intervals; a point estimate on a few dozen documents is not a reliable rate.
