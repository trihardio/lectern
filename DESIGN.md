# Design

Lectern's visual world: **the herbarium and the margin** (chosen 2026-11-15, owner fused the
"Herbarium" and "Margins" directions). Every paper is a specimen, mounted on a bright sheet, labelled
and filed in a cabinet-green rail. Every claim is marked up: violet accession stamps are the
citations, and pointing at one sweeps a highlighter over the claim it supports.

Tokens live in `ui/styles.css` (`:root`, light and dark). The specimen components live in
`ui/world.css`, loaded after `styles.css` and `evidence.css`.

## Colour

### Base palette (2026-11-19)

Every colour in the window is a step of one of eight families, defined once at the top of `:root` in `ui/styles.css`
with a light and a dark value. The role tokens in the next table only point at steps (`--sheet: var(--sage-0)`), and
the dark block changes step values, never roles, so a family keeps its hue in both themes. Steps are named by job:
`-ink` is the strong value for text, marks and outlines on the sheet, `-soft` a pale fill behind ink, `-wash` a
see-through highlighter over text. A new colour starts as a step of a family, with both values. When the palette was
introduced, all 70 existing tokens were measured in headless Chrome and resolved to identical colours in both themes.

| Family | Steps | Light | Dark | Used for |
|---|---|---|---|---|
| Sage (paper and ink) | `--sage-0` … `--sage-8` | `#FCFDFB` sheet, `#EBEFEA` desk, `#E4E9E4`, `#E2E8E3`, `#D3DAD4` hairline, `#9AA79F` rule, `#636D67`, `#47514B`, `#18201C` ink | `#131D19`, `#0D1512`, `#1E2B26`, `#22302A`, `#283731`, `#52665D`, `#8B9A92`, `#B2C0B8`, `#E5EDE8` | sheet, desk, lines, rule, the three inks; step 0 is always the sheet |
| Cabinet | `--cabinet-1` `-2` `-3` `-line` `-ink` `-ink-2` `-sel`, `--cabinet-rail-*` | `#1F3A33` `#284A40` `#36594E` `#3B5D53` `#EAF1EC` `#A8C1B7` `#4E7266` | `#0A110F` `#15211D` `#1F2F29` `#21302A` `#DDE8E2` `#8FA79C` `#7FA394` | the rail, primary buttons, the soft green of a selected thing (`--sel`) |
| Green | `--green-ink` `-soft` `-wash` | `#2B6A37` `#DDF2D6` green 62% | `#8AD596` `#1C3523` green 26% | finds higher, supports; few writing patterns |
| Yellow | `--yellow-mark` `-pale` `-ink` `-soft` `-wash` | `#F7E64A` `#FBF3B4` `#805B00` `#FAF0BC` yellow 66% | `#F2DE4C` `#3D3818` `#E5C15A` `#3A3218` yellow 24% | the highlighter; depends, mixed; some writing patterns |
| Red | `--red-ink` `-soft` `-wash` | `#A3324D` `#FADDE7` pink 58% | `#F29DBB` `#3E2230` pink 26% | finds lower, against, errors; strong writing patterns |
| Violet | `--violet-ink` `-soft` `-on` | `#5B3FA8` `#EEE8FB` `#FFFFFF` | `#B9A6F5` `#2A2247` `#160F2E` | **citations only** |
| Blue | `--blue-ink` | `#1F6FB2` | `#7DB7F0` | keyboard focus |
| Folders | `--f-meta` … `--f-other` | red-brown, ochre, blue, green, plum, grey | lighter | one per kind of study, always with a word |

Not yet folded in: the source-match colours `--t1` … `--t8` and the print copies' light values in `ui/checks.css`, the
proofreader's mark colours in `ui/proofread.css`, and a few one-off values (shadows, `#fff`) in component rules.

### Roles

| Role | Token | Light | Dark | Rule |
|---|---|---|---|---|
| Desk (surround) | `--desk` | `#EBEFEA` | `#0D1512` | |
| Sheet (cards, panels) | `--sheet` | `#FCFDFB` | `#131D19` | never cream |
| Ink | `--ink` / `-2` / `-3` | `#18201C` `#47514B` `#636D67` | `#E5EDE8` `#B2C0B8` `#8B9A92` | `-3` is the lightest text allowed on the sheet (AA) |
| Cabinet (rail, primary buttons, send) | `--cab` `--cab-2` `--cab-3` | `#1F3A33` `#284A40` `#36594E` | `#0A110F` `#15211D` `#1F2F29` | the rail re-maps `--ink*`/`--line*` to cabinet tokens |
| Rail layers (field, hovered row, open row, hairlines) | `--rail-bg` `--rail-2` `--rail-3` `--rail-line` | `--cab` `--cab-2` `--cab-3` `--cab-line` | `--cab-2` `#22332C` `#2A3E35` `#2E4038` | dark lifts the rail a step off the desk and adds a 1px right edge in `--rail-line` |
| Accession stamp | `--stamp` | `#5B3FA8` | `#B9A6F5` | **citations only**. Nothing else is violet |
| Highlighter (mixed, wordmark, display rule) | `--mark` | `#F7E64A` | `#F2DE4C` | |
| Findings | `--spruce` / `--brick` / `--amber` | higher / lower / depends | | always with a word, never colour alone |
| Highlighter washes | `--hl-supports` `--hl-against` `--hl-mixed` | green / pink / yellow at ~60% | ~25% | only on a `.claim.lit` |
| Folders (kind of study) | `--f-meta` `--f-trial` `--f-cohort` `--f-cross` `--f-qual` `--f-other` | red-brown, ochre, blue, green, plum, grey | lighter | a 4px tab on the top edge of a label, never a side border |
| Focus | `--focus` | `#1F6FB2` | `#7DB7F0` | |

## Type (shipped in `ui/fonts`, SIL Open Font License; served by `server/index.js` at `/fonts/*.woff2`)
- **Literata** (`--serif`): answers, headings, the question, paper titles, the display line.
- **Atkinson Hyperlegible Next** (`--sans`): controls, labels, names.
- **Atkinson Hyperlegible Mono** (`--mono`): only label data: stamps, label numbers, years, samples, table
  headers, small uppercase section labels. Never words or sentences (tags, badges and the run line are sans).

## Signature pieces (`ui/world.css`)
- **Accession stamp** `.cite`: 1.25px violet outline, mono 11px, filled violet when pointed at or `.hot`.
- **Claim highlighter** `.claim` (wrapped by `markClaims()` in `ui/app.js`): the words a citation group
  supports, back to the previous sentence end. `highlightPaper()` adds `.lit` and `data-tone` (the
  paper's stance); the wash sweeps in with `background-size`, 0.55s `--ease`.
- **Margin labels** `.margin-note > .specimen` (built by `addMargin()`): one label per paper the first
  time a paragraph cites it, on the answer's own grid so it sits level with the paragraph. Shown when
  the page container is at least 960px wide (`@container page`), hidden below. The sample line and the
  "+N more" line are sans; only their numbers (`.sp-num`) are mono.
- **Determination slip** `.answer-summary`: 1px ink border, a dashed rule under a mono header.
- **Folder tab** `[data-folder]` + `::before`: on margin labels, home examples (cabinet colour; `--cab-ink-2` in
  dark mode, where the cabinet colour would vanish) and reference rows. `folderOf()` in `ui/app.js` maps design
  text to a folder.
- **Mounted figures**: white mat with two strips of linen tape (`.pf-image::before/::after`). When an image cannot be loaded, the
  mat gives way to one muted line, "The image could not be loaded." (`.pf-missing`, `--ink-2`, 13 px), the same height as
  the empty mat, so nothing below moves; the caption, source and link stay.

## Rules
- Hairline seams (1px) between panels; shadows only on floating things (composer, dialogs, cite card).
- Radii: labels and cards 3–4px, buttons 7px, composer 12px.
- Motion follows the 0.1.0 Motion system (`Motion` in `ui/app.js`, Reduce motion honoured). The only new
  motion is the highlighter sweep, and the AI-writing hover label's 0.12s fade (none under Reduce motion).
- The hatched "mixed" fill (`.tab.mixed`, `.bar-fill.mixed`) is data texture for colour-blind reading, not decoration.
- An empty coverage-map cell is blank but for a faint dash; the caption under the map says what an empty cell means.
- Switches that are on use `--sel`, like every other selected thing; the stronger study kinds (`.badge.strong`) are bold
  on the same pale tint as other badges, never a near-black fill.
- A fold arrow stays on the line of its heading's last word (`.fold-tail` is `nowrap`).

## Writing check workspace

The Writing desk page (formerly "AI score") contains independent proofreading, AI-writing, rewrite and plagiarism/similarity workspaces, each with
its own draft, run state and report. `ui/checks.js` builds text-only DOM nodes and `ui/checks.css`
provides document highlights, a report sidebar, sentence evidence, writing suggestions and source
excerpts. Source matches have numbered colours with dark-theme equivalents. Mobile places the report summary above
the manuscript.

**AI-writing report (2026-11-19).** Every reviewed sentence sits in a hatched box in its band colour, from the base
palette: green few patterns (under 40), yellow some (40–64), red strong (65+). The box is a pale `-soft` fill, diagonal
strokes in the band's ink (closer for stronger bands: 10, 7 and 5 px, so the bands differ without colour) and a thin
outline, with slightly uneven corners, after the owner's sketch of a hand-ruled hatched box. Not reviewed is grey strokes
the other way with no outline. The same hatched swatch is used in the key, the band bar, the list dots and the labels.
Pointing at a sentence (or focusing it with the keyboard) shows a floating label (`.chk-tip`, in `<body>`, fixed, so the
text never moves) with a 4px band-colour tab on its top edge: red and yellow say "88% AI-like" (the model's rating),
green "82% human-like" (100 minus the rating), the band in words, and "Writing patterns, not proof of who wrote it."
Clicking a sentence opens its reason: in a wide window it takes the side panel's place (the number in the score card's
serif, the sentence, the model's reason, what was measured, a bordered Close; Escape also closes, and the summary returns
at its scroll position); in a narrow window it opens under the sentence's paragraph. Both copies are built and a
container query shows one. A click in the text never scrolls the page; picking from the Patterns list scrolls the
sentence into view. The key sits under the text, pinned to the bottom of the window in wide windows, in two rows.

**Disagreeing readings note (2026-11-19).** When the pattern score and the style model point different ways, the score card
shows `.chk-differ` right under the big number: an `--amber-soft` wash (no outline), the bold sans lead "The two readings
disagree.", one line with both numbers in mono ("Sentence review 18, under its line", "Style model 93, at or over its line"),
and three plain sentences in `--ink-2`: the test result on text from current Claude models, that the style model also flags
human writing (most often by non-native writers), and "Neither reading is proof." The words carry the meaning; the wash only
draws the eye. Chosen over an inline sentence, a header tag (it wrapped both header labels at 352 px), a two-row comparison
box above the number (it repeated the number and pushed it down) and the same note above the number (no gap left).
Scores describe experimental writing patterns or measured source similarity, never proven authorship
or a plagiarism verdict. Unavailable similarity coverage displays a dash rather than zero percent.

**Test bench (2026-11-19).** A list of labelled text cards (number in mono, a picker for what the text is, word count, the
outcome as a word on its own tint: Caught on `--spruce-soft`, Missed on `--amber-soft`, Wrongly flagged on `--brick-soft`), and above
them a results table with 95% intervals in mono. No new colours.

The AI-writing input offers a review-model picker above the manuscript, with connection state and a
remembered independent choice. This uses the shared picker and does not change the main composer.

Rewrite adds a Style picker beside its button (General, Academic, Blog, Casual, Email, Professional, Scientific,
Technical; no locked or paid tiers). It is the same shared picker with a fixed minimum width, so the Rewrite button never
moves between styles. A picker low on the page or in a dialog opens its menu upward when it would not fit below.

## Voice input states

The existing composer mic has separate starting and listening states. Starting exposes aria-busy
and a cancellable label; the red sound bars appear only after native audio startup or the browser's
onstart event. Escape, editing, navigation and the stop button cancel the session. Both home and
docked composers use the same session controller.

## Sidebar action alignment

New question, Library and Writing desk share 44px minimum row heights, 12px horizontal padding,
1px border space and 4px gaps. Labels and shortcut badges stay in common columns through hover
and selection. Shortcut badges remain hidden on narrow screens.

## Recent conversations and sliding highlights

A conversation title in the rail uses the whole row. Save, rename, duplicate and delete appear over the
right end of the row on hover or keyboard focus, on a fade of the row's own colour (`.history-acts` in
`ui/world.css`); below 760px they stay in the row's flow and are always shown.

A sliding highlight box (`Motion.slide` in `ui/app.js`) must stay visible above its choices when they are
opaque. The default model card in Settings is opaque, so its outline box paints above the cards and the
DEFAULT tab above the box. The chosen reference style in the cite dialog has the same light tint (`--slate-soft`) and soft green outline (`--sel`) as every other picked choice, with and without motion; a dark box made the labels it slid under vanish. Choices that the box passes behind are see-through while the box is drawn (the profile cards and the reference-style chips are filled with the dialog's own colour, so they look the same at rest).

## Proofreader (Writing desk, `ui/proofread.js`, `ui/proofread.css`)

The writer's text sits in a sheet as a real `<textarea>` laid over a mirror of the same text (`.pf-back`); the mirror
draws the marks, so caret, selection and undo stay native and nothing moves while typing. Marks are told apart by
colour **and** line style: wavy `--pf-word` (spelling, word choice), solid `--pf-gram` (grammar), dotted `--pf-mech`
(punctuation, capitals, spacing); each token has a dark value. Pointing at a suggestion, or putting the caret in its
words, sweeps the highlighter (`--pf-wash`) over them, as a citation stamp does on the answer page. Suggestions are
cards in a sticky rail: a 4px folder tab in the category colour, the category in mono tiny caps, the source
(INSTANT or MODEL), the change (struck original, replacement on the highlighter; a space or single mark is shown
between the words around it), a short reason, an outlined Accept (filled when the card is active) and a quiet Dismiss.
The rail ends with plain writing statistics. Below 900px the rail follows the sheet. The four-tool switch wraps whole
buttons on narrow windows.

## App icon (`build/icon.svg`, `build/icon-small.svg`)

An open book on an oak lectern, one line swept with the highlighter, a red-brown ribbon, on a cabinet-green tile:
`--cab`/`--cab-2` tile, `--f-trial` ochre stand, `--sheet` pages, `--mark` highlight, `--f-meta` ribbon. Violet is not
used (it stays reserved for citations). The macOS tile is an 824px rounded square in the 1024 canvas; the Windows icon
and the window's favicon use the same drawing cropped to the tile. Sizes of 32px and below use the simplified drawing.
`scripts/make-icon.js` renders every size from the vector source in headless Chrome.
