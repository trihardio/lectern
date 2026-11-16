# Measured index (style-only) on the dev split

Run 2026-11-15T09:07:47.773Z. Pre-registration version 1. Threshold 28.00 chosen on this split and frozen for the holdout.
Decision rule: flag when the measured index >= 28.00. Documents: 2036 (434 human, 1602 AI, 0 AI-edited human).

| Measure | Value (95% CI) |
|---|---|
| False positive rate (human texts flagged) | 4.8% (3.2–7.3) |
| Detection rate (AI texts flagged) | 29.9% (27.7–32.2) |
| Abstained or failed | 0.0% (0.0–0.2) |
| AI-edited human texts flagged | – |
| AUROC (continuous score, human vs AI) | 0.690 (0.665–0.714) |
| Balanced accuracy | 62.5% |
| Precision if 5% / 10% / 20% / 50% of texts were AI | 25% / 41% / 61% / 86% |

Confusion (human/AI only): TP 479, FN 1123, FP 21, TN 413.

## By source

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| RAID | 252 | 8.3% (5.5–12.4) | 1293 | 34.5% (32.0–37.1) | 0 | – |
| HC3 | 182 | 0.0% (0.0–2.1) | 309 | 10.7% (7.7–14.6) | 0 | – |

## By writer group

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| unspecified | 434 | 4.8% (3.2–7.3) | 1602 | 29.9% (27.7–32.2) | 0 | – |

## By domain

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| RAID: books | 81 | 2.5% (0.7–8.6) | 527 | 30.6% (26.8–34.6) | 0 | – |
| RAID: abstracts | 88 | 11.4% (6.3–19.7) | 448 | 39.5% (35.1–44.1) | 0 | – |
| RAID: news | 83 | 10.8% (5.8–19.3) | 318 | 34.0% (29.0–39.3) | 0 | – |
| HC3: reddit_eli5 | 94 | 0.0% (0.0–3.9) | 178 | 10.7% (6.9–16.1) | 0 | – |
| HC3: finance | 57 | 0.0% (0.0–6.3) | 77 | 11.7% (6.3–20.7) | 0 | – |
| HC3: medicine | 31 | 0.0% (0.0–11.0) | 54 | 9.3% (4.0–19.9) | 0 | – |

## By generator

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| human | 434 | 4.8% (3.2–7.3) | 0 | – | 0 | – |
| ChatGPT (2022-23) | 0 | – | 309 | 10.7% (7.7–14.6) | 0 | – |
| mistral-chat | 0 | – | 228 | 43.4% (37.1–49.9) | 0 | – |
| mpt-chat | 0 | – | 206 | 36.4% (30.1–43.2) | 0 | – |
| mpt | 0 | – | 197 | 8.6% (5.5–13.4) | 0 | – |
| chatgpt | 0 | – | 178 | 64.0% (56.8–70.7) | 0 | – |
| llama-chat | 0 | – | 177 | 63.3% (56.0–70.0) | 0 | – |
| gpt3 | 0 | – | 89 | 12.4% (7.0–20.8) | 0 | – |
| mistral | 0 | – | 79 | 11.4% (6.1–20.3) | 0 | – |
| cohere | 0 | – | 74 | 9.5% (4.7–18.3) | 0 | – |
| gpt2 | 0 | – | 65 | 3.1% (0.8–10.5) | 0 | – |

## By attack or edit

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| none | 434 | 4.8% (3.2–7.3) | 309 | 10.7% (7.7–14.6) | 0 | – |
| alternative_spelling | 0 | – | 199 | 43.2% (36.5–50.2) | 0 | – |
| paraphrase | 0 | – | 188 | 5.9% (3.3–10.2) | 0 | – |
| zero_width_space | 0 | – | 121 | 37.2% (29.1–46.1) | 0 | – |
| article_deletion | 0 | – | 119 | 38.7% (30.4–47.6) | 0 | – |
| number | 0 | – | 117 | 40.2% (31.7–49.2) | 0 | – |
| upper_lower | 0 | – | 117 | 29.9% (22.4–38.7) | 0 | – |
| whitespace | 0 | – | 110 | 41.8% (33.0–51.2) | 0 | – |
| homoglyph | 0 | – | 85 | 34.1% (24.9–44.7) | 0 | – |
| synonym | 0 | – | 84 | 40.5% (30.6–51.2) | 0 | – |
| insert_paragraphs | 0 | – | 79 | 22.8% (14.9–33.2) | 0 | – |
| perplexity_misspelling | 0 | – | 74 | 66.2% (54.9–76.0) | 0 | – |

## By length

| Group | Human n | False positive rate | AI n | Detection rate | AI-edited n | Flagged |
|---|---|---|---|---|---|---|
| 150-299 words | 179 | 8.9% (5.6–14.0) | 767 | 33.2% (30.0–36.7) | 0 | – |
| under 150 words | 127 | 0.8% (0.1–4.3) | 356 | 17.7% (14.1–22.0) | 0 | – |
| 300-599 words | 92 | 4.3% (1.7–10.7) | 391 | 30.9% (26.6–35.7) | 0 | – |
| 600+ words | 36 | 0.0% (0.0–9.6) | 88 | 45.5% (35.5–55.8) | 0 | – |

## Claim check (pre-registered)

Not checked on the development split.

Small groups have wide intervals; a point estimate on a few dozen documents is not a reliable rate.
