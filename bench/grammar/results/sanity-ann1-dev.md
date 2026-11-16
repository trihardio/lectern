# Proofreader `sanity-ann1` on CWEB dev (300 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 100.0% (133 of 133 edits) | 100.0% to 100.0% |
| Correction recall | 100.0% (133 of 133 gold edits) | 100.0% to 100.0% |
| Correction F0.5 | 100.0% | 100.0% to 100.0% |
| Detection precision / recall / F0.5 | 100.0% / 100.0% / 100.0% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 0 of 192 (0.0%) | 0.0% to 2.0% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
133	0	0	1.0	1.0	1.0
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            2        0        0        1.0      1.0      1.0
ADV            8        0        0        1.0      1.0      1.0
CONJ           1        0        0        1.0      1.0      1.0
DET            18       0        0        1.0      1.0      1.0
MORPH          2        0        0        1.0      1.0      1.0
NOUN           14       0        0        1.0      1.0      1.0
NOUN:NUM       4        0        0        1.0      1.0      1.0
ORTH           10       0        0        1.0      1.0      1.0
OTHER          30       0        0        1.0      1.0      1.0
PART           3        0        0        1.0      1.0      1.0
PREP           12       0        0        1.0      1.0      1.0
PRON           1        0        0        1.0      1.0      1.0
PUNCT          5        0        0        1.0      1.0      1.0
SPELL          2        0        0        1.0      1.0      1.0
VERB           3        0        0        1.0      1.0      1.0
VERB:FORM      2        0        0        1.0      1.0      1.0
VERB:SVA       2        0        0        1.0      1.0      1.0
VERB:TENSE     12       0        0        1.0      1.0      1.0
WO             2        0        0        1.0      1.0      1.0

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
133	0	0	1.0	1.0	1.0
==============================================
```
