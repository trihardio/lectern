# Lectern

A local Mac app for research questions: it searches paper databases, has a model read the
abstracts, and writes an answer in which every citation links to a real paper.

## Commands

- `npm start` — run the desktop app (Electron)
- `npm run web` — run without Electron and use it in a browser (http://127.0.0.1:4319)
- `npm test` — run the tests (offline; they use canned responses in `test/`)
- `npm run make-app` — build `dist/…/Lectern.app`
- `node -r ./test/mock-fetch.js server/start.js` — click through the UI offline with sample data
- `node scripts/ui-check.js --steps <file> --mock` — look at the window in headless Chrome: measure elements, record state changes, take pictures (see `Lectern/Playbooks/Check the UI in a browser.md`)
- `bash scripts/make-release.sh` — build the Mac DMG, the Windows zip and checksums (publishing needs the owner's OK)

## How it fits together

```
electron/main.js      window only: starts the server on a free port and shows it
server/index.js       local HTTP server (127.0.0.1), JSON API, streams answers as SSE
server/pipeline.js    one question end to end: plan -> search -> write (+ read each paper)
server/prompts.js     every instruction given to a model
server/profile.js     reader's level and field of study: the lists, and the prompt text for each level
server/sources/*      one file per paper database -> common paper shape (sources/common.js)
server/sources/figures.js  figures from open-access papers (Europe PMC lookup + PMC bucket on AWS)
server/sources/index.js   fan-out, de-duplication, ranking
server/llm/*          claudecode + codex only (the saved sign-in / user's plan)
server/config.js      settings file (keys stay server-side), store.js = threads + library
scripts/               make-app.sh, make-release.sh (DMG + Windows zip), dmg-*.js/py, ui-check.js (look at the window)
PRODUCT.md, DESIGN.md  product truth and the visual world (read by the design skill; keep DESIGN.md current)
shared/cite.js        reference formats (APA, Harvard, MLA, AGLC4, BibTeX, RIS); used by UI and tests
ui/app.js             all window logic, plain DOM; ui/render.js = markdown + citation marks
ui/world.css          the look (herbarium and margin): specimen pieces, picker, fonts; tokens are in ui/styles.css; ui/fonts ships the typefaces (OFL)
server/checks/*       Writing desk tools: proofread.js (proofreader), aiscore.js, similarity.js, rewrite.js, citefix.js, extract.js
shared/proofrules.js  instant proofreading rules (no model); shared/misspellings.js = filtered Wikipedia list (CC BY-SA)
ui/checks.js          the Writing desk page (Cmd/Ctrl+K); ui/proofread.js = the proofreader's editor and suggestion rail
build/icon.svg        the app icon; scripts/make-icon.js makes build/icon.icns, build/icon.ico and ui/icon.svg
bench/, bench/grammar/  AI-writing benchmark, and the proofreader benchmark (CWEB + ERRANT; read PREREGISTRATION.md first)
```

## Rules for changes

- No runtime dependencies. The server uses only Node built-ins and `fetch`; the UI has no
  framework and no build step. Electron is the only dev dependency.
- Papers, DOIs and links come from the databases, never from model output. The model only
  cites by number; `ui/render.js` drops any number that is not in the list.
- Everything shown in the window is escaped in `ui/render.js` / built with `h()` in `ui/app.js`.
  Do not add `innerHTML` with unescaped text.
- API keys are never sent to the window (`Config.getPublic()` masks them).
- New database: add `server/sources/<name>.js` exporting `{ name, label, search, parse, buildUrl }`,
  register it in `server/sources/index.js`, add a default in `server/config.js`, add a fixture and test.
- New engine: add `server/llm/<name>.js` exporting `complete()` that emits
  `delta | thinking | status | websource | notice` events, then register it in `server/llm/index.js`.
- Keep `npm test` passing. Model and effort names change often: check the provider's current
  docs before editing defaults in `server/config.js` and `server/llm/index.js`.
- The interface is Lectern's own design. Do not copy another product's layout, branding or assets.

## Working rules (learned from the owner; details in the vault)

- **Verify before saying "fixed".** For a visual bug, reproduce it with `scripts/ui-check.js`, measure the exact
  element in the owner's screenshot *and every variant of it*, fix the cause, measure again, and look at the
  picture. Check dark mode, 390 px wide and Reduce motion. Say what was tested and what could not be (real
  microphone, real Windows PC, packaged app). `npm test` does not cover the window.
- **Ask before anything public.** Commit, push and release only when asked; one approval does not carry over.
  Checklist: `Lectern/Playbooks/Release a version.md`.
- **UI rules** (full list in `Lectern/Playbooks/Change the UI.md`): no near-black outlines (selected = soft green
  `--sel`); violet only for citations; words are sans, mono only for numbers, stamps and tiny caps; never a system
  `<select>`, `confirm()`, `alert()` or `prompt()` (use `picker()` and `confirmDialog()`); give chart parts their
  own class names; nothing may scroll or move the page by itself (no scroll anchoring); anything that only exists
  to animate is hidden under Reduce motion; every new colour has a dark value; fonts ship in `ui/fonts`.
- **Keep `DESIGN.md` and `Lectern/Map/UI.md` in step** when tokens or UI pieces change.
- Do not use subagents for this project's UI skills: a plugin hook rewrites every Agent call and auto mode
  refuses it. Do the work in the main thread and say so.
- Replies are short; anything saved or shared (notes, comments, commits, README, release notes) is plain full sentences.

## Second brain (Obsidian vault)

`Lectern/` (this folder's subfolder) is an Obsidian vault that serves as Claude's long-term notes
for this project. It is not app code and is excluded from the app build.

**Before work:** read `Lectern/Home.md` and `Lectern/People/Owner.md` (working preferences), then
only the notes Home links that touch the task. Check `Issues/` before debugging and `Playbooks/`
before a recurring job (UI change, browser check, release, new database, new engine, model names, build).

**After work** (any task that changed code or taught something):
1. Add or update today's `Sessions/YYYY-MM-DD.md`: Done, Found, Next.
2. A choice with a reason → `Decisions/`. A bug or failing test → `Issues/` (close with `status: done`).
3. A surprise worth one line → `Lessons learned.md`. A new idea → `Ideas/Backlog.md`.
4. Code behaviour changed → update the matching `Map/` or `Playbooks/` note.
5. Refresh "Current state" and links in `Home.md`.

Folders: `Map/` (how it works), `Playbooks/` (how to do X), `Decisions/`, `Issues/`, `Ideas/`,
`Sessions/`, `People/`, `Templates/`. One topic per note, plain-word file names, link with
`[[Note name]]`, frontmatter `date`, `tags`, and `status` where it applies. Point at files and
function names, not line numbers. Mark anything guessed as inferred. Update a note rather than
duplicate it. Do not edit `Lectern/.obsidian/`.
