# Proofreader `v1` on CWEB dev (300 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 60.4% (29 of 48 edits) | 46.2% to 75.6% |
| Correction recall | 43.9% (29 of 66 gold edits) | 33.3% to 56.1% |
| Correction F0.5 | 56.2% | 44.0% to 68.3% |
| Detection precision / recall / F0.5 | 68.8% / 48.5% / 63.5% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 10 of 192 (5.2%) | 2.9% to 9.3% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
29	19	37	0.6042	0.4394	0.562
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            0        2        1        0.0      0.0      0.0
ADV            2        0        2        1.0      0.5      0.8333
CONJ           0        0        1        1.0      0.0      0.0
DET            4        1        2        0.8      0.6667   0.7692
MORPH          0        0        1        1.0      0.0      0.0
NOUN           5        5        1        0.5      0.8333   0.5435
NOUN:NUM       2        0        0        1.0      1.0      1.0
ORTH           3        1        4        0.75     0.4286   0.6522
OTHER          7        8        15       0.4667   0.3182   0.4268
PREP           3        0        3        1.0      0.5      0.8333
PUNCT          0        0        3        1.0      0.0      0.0
SPELL          1        0        2        1.0      0.3333   0.7143
VERB:SVA       1        1        0        0.5      1.0      0.5556
VERB:TENSE     0        1        1        0.0      0.0      0.0
WO             1        0        1        1.0      0.5      0.8333

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
29	19	37	0.6042	0.4394	0.562
==============================================
```
