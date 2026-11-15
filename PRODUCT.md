# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(The interface is HTML/CSS/JS rendered in an Electron window on macOS and Windows, and also usable
in a browser via `npm run web`. Native-feeling desktop behaviour matters, but the design language is web.)

## Users

Four audiences, confirmed by the owner (2026-11-15), all doing the same core job: finding out what
the research literature says about a question, with sources they can open and cite.
- University students (undergraduate and postgraduate) writing assignments, essays and theses.
- Academics and researchers scanning a literature, checking claims, snowballing citations.
- Professionals (analysts, clinicians, consultants) who need an evidence answer for a decision.
- The curious public who want to know what the research actually says.

The reader's level and field can be set (`server/profile.js`); answers change framing, not facts.

## Product Purpose

Lectern is a local desktop app. You ask a research question in plain words; it plans searches,
queries four paper databases (OpenAlex, Semantic Scholar, Crossref, Europe PMC), has a model read
the abstracts, and writes an answer in which every citation links to a real paper. Success: the
reader trusts the answer because every claim is one click from the paper behind it.

## Positioning

- Runs on the user's own computer and uses the Claude or ChatGPT plan they already have (through
  the Claude Code or Codex sign-in). No account, no API key, no server of ours.
- Papers, DOIs, links, figures and licences come only from the databases, never from the model.
  The model cites by number; any number not in the list is dropped.
- Shows the evidence, not just the prose: study comparison, direction and design charts, a coverage
  map and real figures from open-access papers, each shown only when the data supports it.

## Operating Context

Long reading sessions at a desk, often beside a word processor and a reference manager (Zotero,
Mendeley, EndNote). Tools beyond a normal answer: literature review, citation snowballing, reverse
citation search, citation verification. Answers stream live; conversations are trees (edit, retry,
branch). Library of saved papers; six citation styles (APA, Harvard, MLA, AGLC4, BibTeX, RIS).

## Capabilities and Constraints

- No runtime dependencies; plain DOM UI, no framework, no build step. Electron is the only dev dependency.
- Everything shown is escaped (`ui/render.js`, `h()` in `ui/app.js`); no unescaped `innerHTML`.
- CSP: images only from `self`, `data:` and the PMC open-data bucket; no external fonts or scripts
  at runtime, so any typeface must ship inside the app.
- Light and dark themes; reduce-motion respected. The 0.1.0 motion system (`Motion` in `ui/app.js`)
  was requested by the owner and stays.
- Reads abstracts, not full papers; says so.

## Brand Commitments

- Name: Lectern. The interface is Lectern's own design: do not copy another product's layout,
  branding or assets (CLAUDE.md rule).
- Voice: plain words, honest about limits ("Check what you cite").

## Evidence on Hand

Real data comes from live databases at run time. Offline sample data lives in `test/fixtures.js`
(labelled sample records). No testimonials, user counts or endorsements exist; never invent them.

## Product Principles

1. Every claim is checkable: the path from sentence to paper is always one click.
2. Show only what the evidence supports; an empty chart is worse than none.
3. Honest about limits, in plain words.
4. The user's computer, the user's plan, the user's data.

## Accessibility & Inclusion

Long-form reading must be comfortable in both themes; contrast meets WCAG AA; full keyboard use;
reduce-motion honoured; colour never the only carrier of meaning (stance and direction tags carry words).
