# Lectern

A local Mac app for research questions: it searches paper databases, has a model read the
abstracts, and writes an answer in which every citation links to a real paper.

## Commands

- `npm start` — run the desktop app (Electron)
- `npm run web` — run without Electron and use it in a browser (http://127.0.0.1:4319)
- `npm test` — run the tests (offline; they use canned responses in `test/`)
- `npm run make-app` — build `dist/…/Lectern.app`
- `node -r ./test/mock-fetch.js server/start.js` — click through the UI offline with sample data

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
shared/cite.js        reference formats (APA, Harvard, MLA, AGLC4, BibTeX, RIS); used by UI and tests
ui/app.js             all window logic, plain DOM; ui/render.js = markdown + citation marks
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

## Second brain (Obsidian vault)

`Lectern/` (this folder's subfolder) is an Obsidian vault that serves as Claude's long-term notes
for this project. It is not app code and is excluded from the app build.

**Before work:** read `Lectern/Home.md` and `Lectern/People/Owner.md` (working preferences), then
only the notes Home links that touch the task. Check `Issues/` before debugging and `Playbooks/`
before a recurring job (new database, new engine, model names, build).

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
