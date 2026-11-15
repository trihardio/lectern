# Design

Lectern's visual world: **the herbarium and the margin** (chosen 2026-11-15, owner fused the
"Herbarium" and "Margins" directions). Every paper is a specimen, mounted on a bright sheet, labelled
and filed in a cabinet-green rail. Every claim is marked up: violet accession stamps are the
citations, and pointing at one sweeps a highlighter over the claim it supports.

Tokens live in `ui/styles.css` (`:root`, light and dark). The specimen components live in
`ui/world.css`, loaded after `styles.css` and `evidence.css`.

## Colour

| Role | Token | Light | Dark | Rule |
|---|---|---|---|---|
| Desk (surround) | `--desk` | `#EBEFEA` | `#0D1512` | |
| Sheet (cards, panels) | `--sheet` | `#FCFDFB` | `#131D19` | never cream |
| Ink | `--ink` / `-2` / `-3` | `#18201C` `#47514B` `#636D67` | `#E5EDE8` `#B2C0B8` `#8B9A92` | `-3` is the lightest text allowed on the sheet (AA) |
| Cabinet (rail, primary buttons, send) | `--cab` `--cab-2` `--cab-3` | `#1F3A33` `#284A40` `#36594E` | `#0A110F` `#15211D` `#1F2F29` | the rail re-maps `--ink*`/`--line*` to cabinet tokens |
| Accession stamp | `--stamp` | `#5B3FA8` | `#B9A6F5` | **citations only**. Nothing else is violet |
| Highlighter (mixed, wordmark, display rule) | `--mark` | `#F7E64A` | `#F2DE4C` | |
| Findings | `--spruce` / `--brick` / `--amber` | higher / lower / depends | | always with a word, never colour alone |
| Highlighter washes | `--hl-supports` `--hl-against` `--hl-mixed` | green / pink / yellow at ~60% | ~25% | only on a `.claim.lit` |
| Folders (kind of study) | `--f-meta` `--f-trial` `--f-cohort` `--f-cross` `--f-qual` `--f-other` | red-brown, ochre, blue, green, plum, grey | lighter | a 4px tab on the top edge of a label, never a side border |
| Focus | `--focus` | `#1F6FB2` | `#7DB7F0` | |

## Type (shipped in `ui/fonts`, SIL Open Font License; served by `server/index.js` at `/fonts/*.woff2`)
- **Literata** (`--serif`): answers, headings, the question, paper titles, the display line.
- **Atkinson Hyperlegible Next** (`--sans`): controls, labels, names.
- **Courier Prime** (`--mono`): only label data: stamps, label numbers, years, samples, table
  headers, the run line, small uppercase section labels. Never prose.

## Signature pieces (`ui/world.css`)
- **Accession stamp** `.cite`: 1.25px violet outline, mono 11px, filled violet when pointed at or `.hot`.
- **Claim highlighter** `.claim` (wrapped by `markClaims()` in `ui/app.js`): the words a citation group
  supports, back to the previous sentence end. `highlightPaper()` adds `.lit` and `data-tone` (the
  paper's stance); the wash sweeps in with `background-size`, 0.55s `--ease`.
- **Margin labels** `.margin-note > .specimen` (built by `addMargin()`): one label per paper the first
  time a paragraph cites it, on the answer's own grid so it sits level with the paragraph. Shown when
  the page container is at least 960px wide (`@container page`), hidden below.
- **Determination slip** `.answer-summary`: 1px ink border, a dashed rule under a mono header.
- **Folder tab** `[data-folder]` + `::before`: on margin labels, home examples (cabinet colour) and
  reference rows. `folderOf()` in `ui/app.js` maps design text to a folder.
- **Mounted figures**: white mat with two strips of linen tape (`.pf-image::before/::after`).

## Rules
- Hairline seams (1px) between panels; shadows only on floating things (composer, dialogs, cite card).
- Radii: labels and cards 3–4px, buttons 7px, composer 12px.
- Motion follows the 0.1.0 Motion system (`Motion` in `ui/app.js`, Reduce motion honoured). The only new
  motion is the highlighter sweep.
- The hatched "mixed" fill (`.tab.mixed`, `.bar-fill.mixed`) is data texture for colour-blind reading, not decoration.
