# Proofreader `rules` on CWEB fulldev (6729 sentences)

Scorer: ERRANT 3.0.0 errant_compare, span-based correction (default) and detection; spaCy 3.8.7, en_core_web_sm 3.8.0. Gold: both CWEB annotators.

| Measure | Value | 95% interval |
|---|---|---|
| Correction precision | 84.4% (38 of 45 edits) | 73.5% to 94.4% |
| Correction recall | 3.1% (38 of 1221 gold edits) | 2.1% to 4.2% |
| Correction F0.5 | 13.6% | 9.6% to 17.7% |
| Detection precision / recall / F0.5 | 93.3% / 3.4% / 14.9% | |
| False alarms (sentences neither annotator changed, but the proofreader did) | 0 of 4359 (0.0%) | 0.0% to 0.1% |

The interval resamples sentences (2,000 draws) and keeps errant_compare's choice of annotator per sentence.
An edit that neither annotator made counts against precision even when it is a valid correction, so precision is a lower bound.

## errant_compare

```
=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
38	7	1183	0.8444	0.0311	0.1356
==============================================
```

## By error type (errant_compare -cat 2)

```
===================== Span-Based Correction ======================
Category       TP       FP       FN       P        R        F0.5
ADJ            0        0        24       1.0      0.0      0.0
ADV            1        0        16       1.0      0.0588   0.2381
CONJ           0        0        14       1.0      0.0      0.0
DET            6        0        121      1.0      0.0472   0.1987
MORPH          0        0        18       1.0      0.0      0.0
NOUN           0        0        150      1.0      0.0      0.0
NOUN:NUM       0        0        51       1.0      0.0      0.0
ORTH           20       6        143      0.7692   0.1227   0.3745
OTHER          0        0        321      1.0      0.0      0.0
PART           0        0        3        1.0      0.0      0.0
PREP           3        1        62       0.75     0.0462   0.1852
PRON           0        0        19       1.0      0.0      0.0
PUNCT          0        0        61       1.0      0.0      0.0
SPELL          7        0        50       1.0      0.1228   0.4118
VERB           1        0        61       1.0      0.0161   0.0758
VERB:FORM      0        0        16       1.0      0.0      0.0
VERB:SVA       0        0        17       1.0      0.0      0.0
VERB:TENSE     0        0        29       1.0      0.0      0.0
WO             0        0        7        1.0      0.0      0.0

=========== Span-Based Correction ============
TP	FP	FN	Prec	Rec	F0.5
38	7	1183	0.8444	0.0311	0.1356
==============================================
```
