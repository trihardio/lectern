# Proofreader `v1` on CWEB holdout (300 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 63.3% (31 of 49 edits) | 49.0% to 76.1% |
| Correction recall | 41.3% (31 of 75 gold edits) | 29.6% to 54.1% |
| Correction F0.5 | 57.2% | 45.6% to 67.9% |
| Detection precision / recall / F0.5 | 67.3% / 41.2% / 59.8% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 5 of 181 (2.8%) | 1.2% to 6.3% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
31	18	44	0.6327	0.4133	0.572
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            0        0        2        1.0      0.0      0.0
ADV            0        0        1        1.0      0.0      0.0
CONJ           0        0        2        1.0      0.0      0.0
DET            7        0        1        1.0      0.875    0.9722
NOUN           2        6        1        0.25     0.6667   0.2857
NOUN:NUM       1        0        0        1.0      1.0      1.0
ORTH           9        2        2        0.8182   0.8182   0.8182
OTHER          2        4        16       0.3333   0.1111   0.2381
PREP           4        5        5        0.4444   0.4444   0.4444
PRON           0        1        2        0.0      0.0      0.0
PUNCT          0        0        3        1.0      0.0      0.0
SPELL          3        0        2        1.0      0.6      0.8824
VERB           0        0        5        1.0      0.0      0.0
VERB:FORM      2        0        0        1.0      1.0      1.0
VERB:SVA       1        0        0        1.0      1.0      1.0
VERB:TENSE     0        0        2        1.0      0.0      0.0

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
31	18	44	0.6327	0.4133	0.572
==============================================
```
