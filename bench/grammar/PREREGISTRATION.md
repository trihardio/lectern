# Pre-registration: proofreader accuracy on CWEB

Written 2026-11-17, before any model output on these samples was seen. Changes after this point go in the
deviation log at the end, with the reason.

## System under test
`runProofread` in `server/checks/proofread.js`, version 1, exactly as the app runs it: prompt `PROOFREAD_SYSTEM`
(server/prompts.js), 25 sentences or 4,000 characters per request, effort `low`, spelling variant `auto`, engine
Claude Code (the owner's plan), model `claude-opus-5-5` requested with strict model checking, sentence cache off.
The scored output is the original text with every suggestion the app would show applied (`applySuggestions`), so
the guards (quotations, citations, links, headings, misaligned replies) are part of what is measured.

## Data
CWEB (Flachs et al. 2020), raw untokenised files at commit `08d1da0` (CC BY-NC-SA 4.0, used locally, not
redistributed). Lines of 5 to 120 words. Seed 20261117.
- **dev**: 150 lines from CWEB-G.dev and 150 from CWEB-S.dev. Used to find problems and choose between at most two
  configurations.
- **holdout**: 150 lines from CWEB-G.test and 150 from CWEB-S.test. Run once, with the frozen configuration.
Each line is sent as its own paragraph, in the sampled order.

## Metrics
ERRANT 3.0.0 (spaCy 3.8.7, en_core_web_sm 3.8.0). Gold edits are rebuilt from both annotators' raw corrections with
`errant_parallel`, so gold and output are tokenised the same way (the M2 files shipped with CWEB used spaCy 1.9).
- Primary: span-based correction precision, recall and F0.5 (`errant_compare` default), with a 95% bootstrap
  interval over sentences (2,000 draws).
- Secondary: span-based detection precision/recall/F0.5; the false-alarm rate (sentences neither annotator changed
  that the proofreader changed), with a Wilson 95% interval; the per-type table.
- Precision counts a valid correction that neither annotator made as wrong, so it is a lower bound.

## Decision rules
1. Smoke test: one request on the first 10 dev lines, to check the live path (not scored).
2. Dev run of version 1.
3. If dev correction precision is below 60% or the false-alarm rate is above 10%, read every false positive, make
   one revision (prompt or guards, version 2) and run dev once more. The version with the higher dev F0.5 is
   frozen. Otherwise version 1 is frozen.
4. Holdout run once with the frozen version. Its numbers are reported as they are, whatever they are.
5. Budget: at most 40 model requests in total, as approved by the owner (each run is 13 requests).

## What will be said
The README and the app's limits line report the holdout correction precision and the false-alarm rate with
their intervals, the dataset and the model, and that the numbers describe web text, not every kind of writing.
No statement of "100% accurate" or "no mistakes" will be made.

## Instant rules (shared/proofrules.js)
The offline rules are developed on the full CWEB dev files (6,729 lines) and measured once on the full CWEB test
files (6,845 lines) with the same scorer, with no model requests. Their result is reported the same way.

## Deviation log
- 2026-11-17: after the dev run, `kindOf` in proofread.js was changed so that an apostrophe-only change labelled
  CONTR or NOUN:POSS is shown as grammar rather than punctuation. This changes only the label shown in the window,
  not any edit, so it does not affect any score. The holdout ran with it.

## Results (2026-11-17)
Requests used: 1 (smoke) + 13 (dev) + 13 (holdout) = 27 of the 40 approved. Model reported by Claude Code on every
request: `claude-opus-5-5`. Mean time per request: 7.4 s (dev), 7.7 s (holdout).

| Run | Correction P | Correction R | Correction F0.5 | Detection P / R / F0.5 | False alarms |
|---|---|---|---|---|---|
| dev v1 | 60.4% (29/48), 95% 46.2-75.6 | 43.9%, 33.3-56.1 | 56.2%, 44.0-68.3 | 68.8 / 48.5 / 63.5 | 10/192 = 5.2% (2.9-9.3) |
| **holdout v1** | **63.3% (31/49), 95% 49.0-76.1** | **41.3%, 29.6-54.1** | **57.2%, 45.7-67.9** | 67.4 / 41.3 / 59.8 | **5/181 = 2.8% (1.2-6.3)** |

Decision: dev precision (60.4%) was not below 60% and the false-alarm rate (5.2%) was not above 10%, so version 1
was frozen without revision, as rule 3 says. The holdout was run once.

Reading of the dev disagreements (not a measurement): of the 19 dev edits that matched neither annotator, Claude's
own reading judged 17 defensible (most are commas after an introductory phrase, which the CWEB annotators usually
did not add; others include "That guys" -> "Those guys" and "reservations are recurred" -> "required") and 2
doubtful ("return" -> "returned", "provides" -> "provide"). This was not checked by an independent person, so the
ERRANT numbers above stay the reported ones.

### Instant rules
Developed on all of CWEB dev (6,729 lines). First dev run: precision 81.3% (39/48), no clean sentence changed. Of the
9 edits no annotator made, two were real mistakes and were fixed before the test run: "Kit Holliday" (a name) was
"corrected" by the misspelling list, so capitalised words in mid-sentence are now left alone; ".." used as an informal
ellipsis was turned into ".", so two full stops are no longer flagged. Second dev run: 84.4% (38/45).
Test run, once, on all of CWEB test (6,845 lines): **precision 87.9% (58/66), 95% 79.1-95.6; recall 4.3%; 2 of 4,335
clean sentences changed (0.05%, 95% 0.01-0.17)**.
