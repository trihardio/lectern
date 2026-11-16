'use strict';
// Conversations ("threads") and saved papers ("library"), kept as plain JSON files
// in the data folder so they are easy to back up or inspect.
//
// A thread is a tree of turns, like a chat where you can edit an earlier question:
// each turn names its `parent` (the turn it follows, or null for the first question),
// so editing or retrying a question adds a sibling instead of overwriting it.
// `leaf` is the last turn of the branch on screen; the conversation shown is the path
// from the first question down to that leaf.

const fs = require('fs');
const path = require('path');
const { uid, clip } = require('./util');
const { writeAtomic } = require('./config');

const ID = /^[a-f0-9]{8,32}$/;

/** Threads saved before branching existed are a plain list: chain each turn to the one before. */
function normalize(thread) {
  const turns = thread.turns || (thread.turns = []);
  turns.forEach((t, i) => { if (!('parent' in t)) t.parent = i ? turns[i - 1].id : null; });
  if (!turns.some((t) => t.id === thread.leaf)) thread.leaf = turns.length ? turns[turns.length - 1].id : null;
  return thread;
}

/** Turns from the first question down to `id` (inclusive). [] for null or an unknown id. */
function pathTo(thread, id) {
  const byId = new Map(thread.turns.map((t) => [t.id, t]));
  const out = [];
  for (let t = byId.get(id); t && out.length <= byId.size; t = byId.get(t.parent)) out.unshift(t);
  return out;
}

/** From `id`, keep following the newest child to the end of that branch. */
function newestLeaf(thread, id) {
  let cur = id;
  for (;;) {
    const kids = thread.turns.filter((t) => t.parent === cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}

/** The first plain paragraph of an answer, for a list: no headings, no citation marks or markdown. */
function leadOf(answer) {
  const paras = String(answer || '').split(/\n\s*\n/).map((p) => p.replace(/\[[^\]]{1,40}\]/g, '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim()).filter(Boolean);
  return clip(paras.find((p) => p.length > 40) || paras[0] || '', 220);
}

class Store {
  constructor(dataDir) {
    this.threadsDir = path.join(dataDir, 'threads');
    this.libraryFile = path.join(dataDir, 'library.json');
    fs.mkdirSync(this.threadsDir, { recursive: true });
  }

  // ---- threads ----
  _threadFile(id) {
    if (!ID.test(String(id))) throw new Error('Bad thread id');
    return path.join(this.threadsDir, `${id}.json`);
  }

  _write(thread, touch = true) {
    if (touch) thread.updatedAt = new Date().toISOString(); // saving to the library does not make a chat "recent" again
    writeAtomic(this._threadFile(thread.id), JSON.stringify(thread));
    return thread;
  }

  listThreads() {
    const out = [];
    for (const f of fs.readdirSync(this.threadsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.threadsDir, f), 'utf8'));
        out.push({
          id: t.id, title: t.title, updatedAt: t.updatedAt, createdAt: t.createdAt, turns: (t.turns || []).length,
          saved: !!t.saved, savedAt: t.saved ? (t.savedAt || null) : null,
          // single questions kept in the library, with the opening of their answer for the list
          prompts: (t.turns || []).filter((x) => x.saved).map((x) => ({ id: x.id, question: clip(String(x.question || ''), 400), savedAt: x.savedAt || null, preview: leadOf(x.answer) })),
        });
      } catch { /* skip unreadable file */ }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getThread(id) {
    try { return normalize(JSON.parse(fs.readFileSync(this._threadFile(id), 'utf8'))); } catch { return null; }
  }

  /**
   * Add a turn. `parentId` undefined = continue the branch on screen; null = a new first
   * question (editing the opening question); otherwise the turn it follows.
   */
  saveTurn(threadId, turn, parentId) {
    const now = new Date().toISOString();
    let thread = threadId ? this.getThread(threadId) : null;
    if (threadId && !thread) throw new Error('That conversation no longer exists. The answer was not saved.');
    if (!thread) {
      thread = { id: uid(8), title: clip(turn.question, 80), createdAt: now, updatedAt: now, turns: [], leaf: null };
    }
    const parent = parentId === undefined ? thread.leaf : parentId;
    if (parent !== null && !thread.turns.some((t) => t.id === parent)) throw new Error('That earlier question no longer exists.');
    const saved = { id: uid(6), createdAt: now, ...turn, parent };
    thread.turns.push(saved);
    thread.leaf = saved.id;
    return this._write(thread);
  }

  /**
   * Rename, show another branch (`leaf` must be a turn in the thread), and/or keep the conversation in the
   * library (`saved`). Saving changes nothing else about the conversation, not even its place in the recent list.
   */
  updateThread(id, { title, leaf, saved } = {}) {
    const t = this.getThread(id);
    if (!t) return null;
    if (typeof saved === 'boolean') {
      if (saved && !t.saved) { t.saved = true; t.savedAt = new Date().toISOString(); }
      if (!saved) { delete t.saved; delete t.savedAt; }
      if (title == null && leaf == null) return this._write(t, false);
    }
    if (title != null) t.title = clip(String(title).trim() || t.title, 120);
    if (leaf != null) {
      if (!t.turns.some((x) => x.id === leaf)) throw Object.assign(new Error('That version no longer exists.'), { status: 404 });
      t.leaf = leaf;
    }
    return this._write(t);
  }

  renameThread(id, title) { return this.updateThread(id, { title }); }

  /** Keep one question (with its answer) in the library, or take it out. Changes nothing else, not even the recent order. */
  updateTurn(threadId, turnId, { saved } = {}) {
    const t = this.getThread(threadId);
    if (!t) return null;
    const turn = t.turns.find((x) => x.id === turnId);
    if (!turn) throw Object.assign(new Error('That question no longer exists.'), { status: 404 });
    if (saved === true && !turn.saved) { turn.saved = true; turn.savedAt = new Date().toISOString(); }
    if (saved === false) { delete turn.saved; delete turn.savedAt; }
    this._write(t, false);
    return { id: turn.id, saved: !!turn.saved, savedAt: turn.saved ? turn.savedAt : null };
  }

  /**
   * Delete a turn and every turn that followed it. If the thread is left empty, the
   * whole thread goes and this returns null.
   */
  deleteTurn(threadId, turnId) {
    const t = this.getThread(threadId);
    if (!t) throw Object.assign(new Error('That conversation no longer exists.'), { status: 404 });
    const target = t.turns.find((x) => x.id === turnId);
    if (!target) throw Object.assign(new Error('That question no longer exists.'), { status: 404 });

    const gone = new Set([turnId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of t.turns) if (!gone.has(x.id) && gone.has(x.parent)) { gone.add(x.id); grew = true; }
    }
    t.turns = t.turns.filter((x) => !gone.has(x.id));
    if (!t.turns.length) { this.deleteThread(threadId); return null; }

    if (gone.has(t.leaf)) {
      // Show the next version of the deleted question if there is one, else the turn before it.
      const sibs = t.turns.filter((x) => x.parent === target.parent);
      t.leaf = sibs.length ? newestLeaf(t, sibs[sibs.length - 1].id) : target.parent;
      if (t.leaf === null) t.leaf = newestLeaf(t, null);
    }
    return this._write(t);
  }

  /** A new thread holding the conversation from the first question down to `turnId`. */
  branchThread(threadId, turnId) {
    const t = this.getThread(threadId);
    if (!t) throw Object.assign(new Error('That conversation no longer exists.'), { status: 404 });
    const turns = pathTo(t, turnId || t.leaf);
    if (!turns.length) throw Object.assign(new Error('That question no longer exists.'), { status: 404 });
    const now = new Date().toISOString();
    const copy = {
      id: uid(8), title: clip(`${t.title} (copy)`, 120), createdAt: now, updatedAt: now,
      turns: JSON.parse(JSON.stringify(turns)), leaf: turns[turns.length - 1].id,
    };
    for (const x of copy.turns) { delete x.saved; delete x.savedAt; } // a copy starts with nothing kept in the library
    return this._write(copy);
  }

  deleteThread(id) {
    try { fs.unlinkSync(this._threadFile(id)); return true; } catch { return false; }
  }

  // ---- library ----
  getLibrary() {
    try {
      const data = JSON.parse(fs.readFileSync(this.libraryFile, 'utf8'));
      if (!data || !Array.isArray(data.papers)) throw new Error('Invalid library format');
      return data.papers;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new Error('The library could not be read. Its file was left untouched.');
    }
  }

  _saveLibrary(papers) { writeAtomic(this.libraryFile, JSON.stringify({ papers })); }

  addToLibrary(paper) {
    if (!paper || !paper.id || !paper.title) throw new Error('Not a paper');
    const papers = this.getLibrary().filter((p) => p.id !== paper.id);
    const { n, score, ...keep } = paper; // drop per-answer fields
    papers.unshift({ ...keep, savedAt: new Date().toISOString() });
    this._saveLibrary(papers);
    return papers;
  }

  removeFromLibrary(id) {
    const papers = this.getLibrary().filter((p) => p.id !== id);
    this._saveLibrary(papers);
    return papers;
  }
}

module.exports = { Store, normalize, pathTo, newestLeaf };
