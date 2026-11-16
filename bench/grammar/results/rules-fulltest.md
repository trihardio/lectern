# Proofreader `rules` on CWEB fulltest (6845 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 87.9% (58 of 66 edits) | 79.1% to 95.6% |
| Correction recall | 4.3% (58 of 1350 gold edits) | 3.2% to 5.4% |
| Correction F0.5 | 18.0% | 13.9% to 21.9% |
| Detection precision / recall / F0.5 | 89.4% / 4.4% / 18.3% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 2 of 4335 (0.1%) | 0.0% to 0.2% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
58	8	1292	0.8788	0.043	0.1797
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            0        0        32       1.0      0.0      0.0
ADJ:FORM       0        0        3        1.0      0.0      0.0
ADV            0        0        27       1.0      0.0      0.0
CONJ           0        0        10       1.0      0.0      0.0
DET            11       1        100      0.9167   0.0991   0.3459
MORPH          0        0        19       1.0      0.0      0.0
NOUN           2        0        181      1.0      0.0109   0.0524
NOUN:NUM       1        0        19       1.0      0.05     0.2083
NOUN:POSS      0        1        0        0.0      1.0      0.0
ORTH           37       4        139      0.9024   0.2102   0.5441
OTHER          0        0        403      1.0      0.0      0.0
PART           0        0        2        1.0      0.0      0.0
PREP           1        1        77       0.5      0.0128   0.0581
PRON           0        0        17       1.0      0.0      0.0
PUNCT          0        1        69       0.0      0.0      0.0
SPELL          6        0        55       1.0      0.0984   0.3529
VERB           0        0        52       1.0      0.0      0.0
VERB:FORM      0        0        26       1.0      0.0      0.0
VERB:SVA       0        0        21       1.0      0.0      0.0
VERB:TENSE     0        0        29       1.0      0.0      0.0
WO             0        0        11       1.0      0.0      0.0

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
58	8	1292	0.8788	0.043	0.1797
==============================================
```
