# Lectern

Ask a research question in plain words. Lectern searches academic paper databases, reads the
abstracts, and writes an answer where every citation links to a real paper you can open and check.

It runs on your Mac. Your conversations and saved papers stay on your Mac.

## What you need

- A Mac with Apple Silicon (M1 or newer) running macOS 13 Ventura or later.
- A **Claude** or **ChatGPT** plan, signed in on this Mac through **Claude Code** or **Codex**
  (either on its own, or inside the Claude or ChatGPT desktop app). Lectern uses that sign-in,
  so there is no API key to buy or paste. Questions count against that plan.

## Install

1. Open the [latest release](../../releases/latest) and download **Lectern-0.1.0.dmg**.
2. Open the downloaded file and drag **Lectern** into **Applications**.
3. Open Lectern from Applications. The first time, macOS says it cannot check the app for
   malicious software. Click **Done**, then open **System Settings > Privacy & Security**, scroll
   down, and click **Open Anyway** next to Lectern. You only do this once.

   This happens because Lectern is a free app that is not registered with Apple. You can read
   all of its code in this repository.

## First run

1. Lectern asks what you study (level and field). Pick both, or skip. Answers are pitched to match.
2. Lectern finds Claude Code or Codex by itself. If it says **Not signed in**, open Terminal, run
   `claude` (or `codex login`), sign in, then click **I have signed in** in Lectern.
3. Optional but recommended: get a free key from [OpenAlex](https://openalex.org/settings/api),
   the largest paper database, and paste it into **Settings > Paper databases**.

Then type a question, for example *Does remote work improve employee productivity?*, and press Enter.

## Good to know

- Lectern reads **abstracts, not full papers**. Open the papers you plan to cite.
- Reference details come from the databases, which contain mistakes. Check author names and page
  numbers before you submit.
- **Cite** on any paper gives APA 7, Harvard, MLA 9, AGLC4, BibTeX or RIS. **Library** keeps the
  papers you save; export them to Zotero, Mendeley or EndNote.
- Follow your course's rules on using AI tools.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Lectern cannot be opened" or "not verified" | Install step 3 |
| "Lectern is damaged" | Run `xattr -dr com.apple.quarantine /Applications/Lectern.app` in Terminal, then open it again. Only do this for a copy you downloaded from this page |
| "Not installed" in Settings | Install Claude Code or Codex, or the Claude or ChatGPT desktop app |
| "Not signed in" | Run `claude` or `codex login` in Terminal and sign in |
| OpenAlex "needs a free API key" | First run step 3 |
| Semantic Scholar "is busy" | Normal without a key; the other databases still answer |

To reset Lectern, delete the folder `~/Library/Application Support/Lectern`.

## For developers

Needs Node.js 20 or newer.

```
npm install
npm start          # run the desktop app
npm run web        # or run it in your browser at http://127.0.0.1:4319
npm test           # offline tests
npm run make-app   # build dist/Lectern-darwin-arm64/Lectern.app
```

No runtime dependencies: the server uses Node built-ins only, and the window is plain HTML,
CSS and JavaScript with no build step. `CLAUDE.md` explains how the code fits together.
