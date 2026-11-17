# Style model, versions 2 and 3 (2026-11-17)

Pre-registered in `PREREGISTRATION.md` (versions 2 and 3) before each holdout was scored. Full per-group output:
`style-v2-output.txt`, `style-v3-output.txt`.

| System | Test set (fresh) | AUROC | False positives (95% CI) | Detection (95% CI) | Outcome |
|---|---|---|---|---|---|
| v1 measured index | MAGE, 2,777 docs | 0.563 | 6.8% (4.9-9.3) | 8.9% (7.8-10.2) | baseline |
| v2 style model (trained on HC3 + RAID) | MAGE, 2,777 docs | 0.541 | 28.8% (25.1-32.9) | 33.4% (31.4-35.3) | rejected: learned its two training sets |
| v2 style model (same) | v1 holdout, 3,650 docs (same sources it trained on) | 0.927 | 11.6% (9.7-13.9) | 82.6% (81.1-84.0) | in-domain only, not a fair test: shows the gap to MAGE |
| v1 measured index | DACTYL, 1,095 docs | 0.798 | 8.5% (5.4-13.2) | 50.9% (47.7-54.2) | baseline |
| v3 style model (HC3 + RAID + MAGE + DACTYL train) | DACTYL, 1,095 docs | 0.883 | 4.5% (2.4-8.3) | 70.1% (67.0-73.0) | used as a second reading |

Non-native writers (Liang et al. TOEFL essays, 90, never trained on): v1 flags 3.3%, v3 flags 13.3%. Native student
essays (215): v1 18.6%, v3 6.5%. Student essays in DACTYL: v3 AUROC 0.597. These are shown in the app.
