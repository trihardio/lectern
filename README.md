# Lectern

Ask a research question in plain words. Lectern searches academic paper databases, reads the
abstracts, and writes an answer where every citation links to a real paper you can open and check.

It runs on your Mac or Windows PC. Your conversations and saved papers stay on your computer.

## What you need

- A Mac with Apple Silicon (M1 or newer) running macOS 13 Ventura or later, **or** a Windows 10/11 PC (64-bit).
- A **Claude** or **ChatGPT** plan, signed in on this computer through **Claude Code** or **Codex**
  (either on its own, or inside the Claude or ChatGPT desktop app). Lectern uses that sign-in,
  so there is no API key to buy or paste. Questions count against that plan.

## Install on a Mac

1. Open the [latest release](../../releases/latest) and download **Lectern-0.1.1.dmg**.
2. Open the downloaded file and drag **Lectern** onto **Applications**.
3. Open Lectern from Applications. The first time, macOS says it cannot check the app for
   malicious software. Click **Done**, then open **System Settings > Privacy & Security**, scroll
   down, and click **Open Anyway** next to Lectern. You only do this once.

   This happens because Lectern is a free app that is not registered with Apple. You can read
   all of its code in this repository.

## Install on Windows

1. From the [latest release](../../releases/latest), download **Lectern-0.1.1-windows-x64.zip**.
2. Right-click the file, choose **Extract All**, and put the **Lectern** folder somewhere that suits you
   (for example your Documents folder).
3. Open the folder and double-click **Lectern.exe**. The first time, Windows SmartScreen may say it
   protected your PC: click **More info**, then **Run anyway**. You only do this once.

   This happens because Lectern is a free app without a paid code-signing certificate. The Windows build
   is new in 0.1.1 and was built on a Mac; please report anything that does not work.
4. Install **Claude Code** (`irm https://claude.ai/install.ps1 | iex` in PowerShell, then run `claude` once to
   sign in) or **Codex** (`npm install -g @openai/codex`, then `codex login`).
5. For voice input on Windows, click in the question box and press **Windows key + H**.

## First run

1. Lectern asks what you study (level and field). Pick both, or skip. Answers are pitched to match.
2. Lectern finds Claude Code or Codex by itself. If it says **Not signed in**, open Terminal, run
   `claude` (or `codex login`), sign in, then click **I have signed in** in Lectern.
3. Optional but recommended: get a free key from [OpenAlex](https://openalex.org/settings/api),
   the largest paper database, and paste it into **Settings > Paper databases**.

Then type a question, for example *Does remote work improve employee productivity?*, and press Enter.

## Good to know

- The two rings beside the model name show **Claude** and **GPT / Codex** plan usage. The larger
  arc is weekly usage; the smaller arc is five-hour usage. Empty means 0% used, full means 100%.
  Click a ring for percentages and reset times. Readings refresh every two minutes while the
  window is visible; dashed arcs mean a reading is unavailable. To show the Claude ring, Lectern reads
  Claude Code's saved sign-in on this computer and asks Anthropic for your plan usage; the sign-in is
  sent only to Anthropic. The GPT ring asks the Codex tool itself.
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

To reset Lectern, delete the folder `~/Library/Application Support/Lectern` (Mac) or `%APPDATA%\Lectern` (Windows).

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
