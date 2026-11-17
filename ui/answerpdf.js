// Download one answer as a PDF: the question, the answer with its citation marks, figures, every paper's findings,
// the reference list and each paper's abstract. Everything comes from what the answer already holds: database
// records for papers and abstracts, validated readings for findings (their quotes were checked against the
// abstract), open-access records for figures. Nothing is written by a model at export time.
// Built with h() and the escaped HTML from ui/render.js only; no other innerHTML.
(function () {
  'use strict';

  const STANCE = { supports: 'Supports', conditional: 'Depends on conditions', mixed: 'Mixed', against: 'Challenges', na: '' };
  const FACT_LABEL = { population: 'Population', setting: 'Setting', measure: 'Measured', design: 'Design', sample: 'Sample', result: 'Result' };

  /** "Maria van der Berg" style list from database author records. */
  function authorLine(p) {
    const names = (p.authors || []).map((a) => (typeof a === 'string' ? a : [a.given, a.family].filter(Boolean).join(' '))).filter(Boolean);
    if (!names.length) return '';
    return names.length > 6 ? `${names.slice(0, 6).join(', ')} et al.` : names.join(', ');
  }

  function build({ turn, deps }) {
    const { h, Cite, Render, state, answerParts, insightFor, citeLabels, prettyModel, engineInfo } = deps;
    const papers = (turn.papers || []).slice().sort((a, b) => a.n - b.n);
    const labels = citeLabels(turn);
    const label = (n) => (labels && labels.get(n)) || `Paper ${n}`;
    const parts = answerParts(turn); // also fills turn.cited
    const follow = Render.splitFollowUps(turn.answer || '').followUps || [];
    const style = state.app.settings.citeStyle;
    const when = new Date(turn.createdAt || Date.now());
    const info = turn.engine ? engineInfo(turn.engine) : null;
    const meta = [
      when.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }),
      `${papers.length} paper${papers.length === 1 ? '' : 's'}`,
      info ? (() => { const m = prettyModel(turn.model, turn.engine); return m.startsWith(info.short) ? m : `${info.short}, ${m}`; })() : '',
      turn.web ? 'web search on' : '',
    ].filter(Boolean).join(' · ');
    const section = (title, ...kids) => h('section', { class: 'apdf-sec' }, h('h2', null, title), kids);

    const figures = (turn.figures || []).filter((f) => f && /^https?:\/\//i.test(f.img || '')); // images only from web addresses
    const findings = papers.map((p) => {
      const r = insightFor(turn, p.n) || {};
      const facts = Object.entries(r.facts || {}).filter(([k]) => FACT_LABEL[k]);
      const stance = STANCE[r.stance] || '';
      return h('article', { class: 'apdf-paper' },
        h('header', null,
          h('span', { class: 'apdf-num' }, String(p.n)),
          h('div', null,
            h('p', { class: 'apdf-title' }, p.title || 'Untitled'),
            h('p', { class: 'apdf-meta' }, [label(p.n), p.venue, p.year, p.kind, p.citations != null ? `cited ${p.citations} times` : ''].filter(Boolean).join(' · ')),
            p.retracted && h('p', { class: 'apdf-warn' }, 'Retracted according to the database.'))),
        h('div', { class: 'apdf-tags' },
          turn.cited && turn.cited.has(p.n) && h('span', { class: 'apdf-tag cited' }, 'Cited in the answer'),
          stance && h('span', { class: `apdf-tag stance ${r.stance}` }, stance),
          r.design && h('span', { class: 'apdf-tag' }, r.design),
          (r.sample || p.sample) && h('span', { class: 'apdf-tag' }, r.sample || p.sample)),
        r.finding ? h('p', { class: 'apdf-finding' }, h('b', null, 'Finding: '), r.finding) : h('p', { class: 'apdf-note' }, 'No reading was recorded for this paper.'),
        facts.length > 0 && h('dl', { class: 'apdf-facts' }, facts.map(([k, f]) => [
          h('dt', null, FACT_LABEL[k]),
          h('dd', null, f.value, h('span', { class: 'apdf-quote' }, ` “${f.quote}”`))])));
    });

    const references = papers.map((p) => {
      const ref = Cite.format(p, style);
      return h('li', null, h('span', { class: 'apdf-num' }, String(p.n)), h('div', { html: ref.html }));
    });

    // One wording for a missing abstract, with or without the database's short summary after it.
    const NO_ABSTRACT = 'The databases have no abstract for this paper.';
    const webOnly = (u) => (/^https?:\/\//i.test(u || '') ? u : ''); // links only ever point at web addresses
    const abstracts = papers.map((p) => {
      const link = webOnly(Cite.doiUrl(p)); // the DOI link, else the record's own link; it takes the paper, not the DOI
      return h('article', { class: 'apdf-abstract' },
        h('p', { class: 'apdf-title' }, h('span', { class: 'apdf-num' }, String(p.n)), p.title || 'Untitled'),
        h('p', { class: 'apdf-meta' }, [authorLine(p), p.venue, p.year].filter(Boolean).join(' · ')),
        p.abstract ? h('p', { class: 'apdf-abstract-text' }, p.abstract)
          : p.tldr ? h('p', { class: 'apdf-abstract-text' }, h('i', null, `${NO_ABSTRACT} Short summary: `), p.tldr)
            : h('p', { class: 'apdf-note' }, NO_ABSTRACT),
        link && h('p', { class: 'apdf-link' }, h('a', { href: link }, link)));
    });

    const web = turn.webSources || [];
    return h('div', { class: 'apdf-print', 'aria-hidden': 'true' },
      h('header', { class: 'apdf-head' },
        h('div', { class: 'apdf-brand' }, 'Lectern'),
        h('h1', null, turn.question || 'Question'),
        h('p', { class: 'apdf-headmeta' }, meta)),
      section('Answer',
        parts.hasLead && h('div', { class: 'apdf-brief' }, h('p', { class: 'apdf-label' }, 'Answer in brief'), h('div', { class: 'answer', html: parts.lead.html })),
        h('div', { class: 'answer', html: parts.body.html }),
        follow.length > 0 && h('div', { class: 'apdf-follow' }, h('p', { class: 'apdf-label' }, 'Worth following up'), h('ul', null, follow.map((q) => h('li', null, q))))),
      figures.length > 0 && h('section', { class: 'apdf-sec apdf-figures' }, h('h2', null, 'Figures from the papers'), figures.map((f) => h('figure', { class: 'apdf-figure' },
        h('img', { src: f.img, alt: `${f.label}${f.title ? `: ${f.title}` : ''}`, referrerpolicy: 'no-referrer' }),
        h('figcaption', null,
          h('p', null, h('b', null, `${label(f.n)} · ${f.label}`), f.title ? ` ${f.title}` : ''),
          f.read && h('p', null, h('b', null, 'How to read: '), f.read),
          f.caption && h('p', { class: 'apdf-caption' }, f.caption),
          h('p', { class: 'apdf-note' }, [f.license, f.page].filter(Boolean).join(' · ')))))),
      section(`Findings by paper (${papers.length})`,
        h('p', { class: 'apdf-note' }, 'Findings are the model’s reading of each abstract. Quoted words were checked against the abstract; anything without a quote is the model’s summary. Check the paper before you rely on it.'),
        findings),
      section(`References (${Cite.STYLES[style] ? Cite.STYLES[style].label : style})`,
        h('ol', { class: 'apdf-refs' }, references)),
      web.length > 0 && section('Web pages used', h('ol', { class: 'apdf-refs' }, web.map((w, i) => h('li', null,
        h('span', { class: 'apdf-num' }, `W${i + 1}`), h('div', null, w.title || '', ' ', webOnly(w.url) ? h('a', { href: w.url }, w.url) : ''))))),
      section('Abstracts', h('p', { class: 'apdf-note' }, 'As published in the paper databases. Lectern reads abstracts, not full papers.'), abstracts),
      h('footer', { class: 'apdf-foot' }, 'Made with Lectern. Papers, abstracts and links come from the paper databases; the answer and findings are a model’s reading of the abstracts. Check what you cite.'));
  }

  /** Wait until every image in the sheet has loaded or failed (an image that fails is removed), at most 15 s. */
  function imagesReady(sheet) {
    const imgs = [...sheet.querySelectorAll('img')];
    return Promise.race([
      Promise.all(imgs.map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', () => { const fig = img.closest('figure'); if (fig) fig.remove(); done(); }, { once: true });
      })))),
      new Promise((done) => setTimeout(done, 15000)),
    ]).then(() => {
      // every figure failed to load (offline, or the archive moved): leave out the empty section
      const figs = sheet.querySelector('.apdf-figures');
      if (figs && !figs.querySelector('figure')) figs.remove();
    });
  }

  async function exportPdf({ turn, button, deps }) {
    const { api, toast, state } = deps;
    if (!turn || !turn.answer) return;
    const name = `${String(turn.question || 'Lectern answer').replace(/\s+/g, ' ').trim().slice(0, 80)} - Lectern.pdf`;
    document.querySelectorAll('.apdf-print').forEach((e) => e.remove());
    const sheet = build({ turn, deps });
    document.body.append(sheet);
    document.documentElement.classList.add('apdf-printing');
    if (button) button.disabled = true;
    try {
      await imagesReady(sheet);
      if (state.app && state.app.pdfExport) {
        const out = await api('POST', '/api/checks/pdf', { name });
        if (out.ok) toast('PDF saved');
        else if (!out.canceled) toast(out.error || 'Could not save the PDF');
      } else {
        window.print(); // a browser: its print dialog offers "Save as PDF"
      }
    } catch (e) {
      toast(e.message || 'Could not save the PDF');
    } finally {
      sheet.remove();
      document.documentElement.classList.remove('apdf-printing');
      if (button) button.disabled = false;
    }
  }

  window.LecternAnswerPdf = { export: exportPdf, build };
})();
