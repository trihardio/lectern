# Proofreader `sanity-source` on CWEB dev (300 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 100.0% (0 of 0 edits) | 100.0% to 100.0% |
| Correction recall | 0.0% (0 of 45 gold edits) | 0.0% to 0.0% |
| Correction F0.5 | 0.0% | 0.0% to 0.0% |
| Detection precision / recall / F0.5 | 100.0% / 0.0% / 0.0% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 0 of 192 (0.0%) | 0.0% to 2.0% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
0	0	45	1.0	0.0	0.0
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            0        0        1        1.0      0.0      0.0
ADV            0        0        3        1.0      0.0      0.0
CONJ           0        0        1        1.0      0.0      0.0
DET            0        0        4        1.0      0.0      0.0
MORPH          0        0        1        1.0      0.0      0.0
NOUN           0        0        3        1.0      0.0      0.0
NOUN:NUM       0        0        1        1.0      0.0      0.0
ORTH           0        0        5        1.0      0.0      0.0
OTHER          0        0        17       1.0      0.0      0.0
PREP           0        0        2        1.0      0.0      0.0
PUNCT          0        0        3        1.0      0.0      0.0
SPELL          0        0        2        1.0      0.0      0.0
VERB:TENSE     0        0        1        1.0      0.0      0.0
WO             0        0        1        1.0      0.0      0.0

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
0	0	45	1.0	0.0	0.0
==============================================
```
