'use strict';
// Editing, retrying, deleting and branching questions in a conversation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-fetch');
const { Store, normalize, pathTo } = require('../server/store');
const { createApp } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-threads-'));
const turn = (question) => ({ question, answer: `answer to ${question}`, papers: [] });
const questions = (thread) => pathTo(thread, thread.leaf).map((t) => t.question);

test('store: an edited question becomes a second version; each keeps its own follow-ups', () => {
  const store = new Store(tmp());
  let t = store.saveTurn(null, turn('Q1'));
  const q1 = t.turns[0];
  t = store.saveTurn(t.id, turn('Q2'));
  const q2 = t.leaf;
  t = store.saveTurn(t.id, turn('Q2 edited'), q1.id); // edit Q2: same parent as Q2
  assert.deepEqual(questions(t), ['Q1', 'Q2 edited']);
  t = store.saveTurn(t.id, turn('Q3'));
  assert.deepEqual(questions(t), ['Q1', 'Q2 edited', 'Q3']);

  // Switching back to the first version shows its own branch again.
  t = store.updateThread(t.id, { leaf: q2 });
  assert.deepEqual(questions(store.getThread(t.id)), ['Q1', 'Q2']);

  // Editing the first question makes a new root.
  t = store.saveTurn(t.id, turn('Q1 edited'), null);
  assert.deepEqual(questions(t), ['Q1 edited']);
  assert.equal(t.turns.filter((x) => x.parent === null).length, 2);
});

test('store: delete removes a question and what followed it, then shows a sibling or the parent', () => {
  const store = new Store(tmp());
  let t = store.saveTurn(null, turn('Q1'));
  const q1 = t.leaf;
  t = store.saveTurn(t.id, turn('Q2'));
  const q2 = t.leaf;
  t = store.saveTurn(t.id, turn('Q3'));
  t = store.saveTurn(t.id, turn('Q2b'), q1);

  t = store.deleteTurn(t.id, t.leaf); // delete Q2b → back to the other version's branch
  assert.deepEqual(questions(t), ['Q1', 'Q2', 'Q3']);
  t = store.deleteTurn(t.id, q2); // Q2 and Q3 go → Q1 is the end
  assert.deepEqual(questions(t), ['Q1']);
  assert.equal(t.turns.length, 1);
  assert.equal(store.deleteTurn(t.id, q1), null, 'deleting the last question deletes the conversation');
  assert.equal(store.listThreads().length, 0);
});

test('store: branch copies the conversation up to a question; old threads still load', () => {
  const dir = tmp();
  const store = new Store(dir);
  let t = store.saveTurn(null, turn('Q1'));
  const q1 = t.leaf;
  t = store.saveTurn(t.id, turn('Q2'));
  const copy = store.branchThread(t.id, q1);
  assert.notEqual(copy.id, t.id);
  assert.deepEqual(questions(copy), ['Q1']);
  assert.match(copy.title, /\(copy\)$/);
  assert.equal(store.getThread(t.id).turns.length, 2, 'the original is untouched');

  // A thread saved before versions existed: plain list, no parent, no leaf.
  const legacy = normalize({ id: 'aaaaaaaa', title: 'old', turns: [{ id: 'a1', question: 'A' }, { id: 'b2', question: 'B' }] });
  assert.equal(legacy.turns[1].parent, 'a1');
  assert.equal(legacy.leaf, 'b2');
  assert.deepEqual(questions(legacy), ['A', 'B']);
});

test('store: keeping a conversation in the library is a flag that changes nothing else', () => {
  const store = new Store(tmp());
  const a = store.saveTurn(null, turn('Q1'));
  const b = store.saveTurn(null, turn('Q2'));
  const before = store.getThread(a.id).updatedAt;
  const saved = store.updateThread(a.id, { saved: true });
  assert.equal(saved.saved, true);
  assert.ok(saved.savedAt);
  assert.equal(saved.updatedAt, before, 'saving does not make it "recent" again');
  const list = Object.fromEntries(store.listThreads().map((t) => [t.id, t]));
  assert.equal(list[a.id].saved, true);
  assert.ok(list[a.id].savedAt);
  assert.equal(list[b.id].saved, false);
  assert.equal(list[b.id].savedAt, null);
  assert.equal(store.renameThread(a.id, 'Renamed').saved, true, 'renaming keeps it saved');
  assert.ok(!store.getThread(store.branchThread(a.id).id).saved, 'a copy is not saved');
  store.updateThread(a.id, { saved: 'yes' });
  assert.equal(store.getThread(a.id).saved, true, 'only a real true or false changes it');
  const gone = store.updateThread(a.id, { saved: false });
  assert.ok(!gone.saved && !gone.savedAt);
});

test('store: a single question can be kept in the library, and a copy of the chat does not carry that over', () => {
  const store = new Store(tmp());
  let t = store.saveTurn(null, { question: 'Does sleep help memory?', answer: '## Short answer\n\nSleep helps memory in most adult studies [1], especially for facts learned the same day.\n\nMore detail follows.', papers: [] });
  const q1 = t.turns[0].id;
  t = store.saveTurn(t.id, turn('Second question'));
  const before = store.getThread(t.id).updatedAt;
  const kept = store.updateTurn(t.id, q1, { saved: true });
  assert.equal(kept.saved, true);
  assert.ok(kept.savedAt);
  assert.equal(store.getThread(t.id).updatedAt, before, 'does not change the recent order');
  const row = store.listThreads().find((x) => x.id === t.id);
  assert.equal(row.prompts.length, 1);
  assert.equal(row.prompts[0].id, q1);
  assert.equal(row.prompts[0].question, 'Does sleep help memory?');
  assert.match(row.prompts[0].preview, /^Sleep helps memory in most adult studies/, 'the list shows the opening of the answer, without marks');
  assert.ok(!/\[1\]|#/.test(row.prompts[0].preview));
  assert.match(row.prompts[0].preview, /studies, especially/, 'no stray space where a citation mark was');
  assert.equal(row.saved, false, 'a saved question does not make the whole chat saved');
  assert.deepEqual(store.getThread(store.branchThread(t.id).id).turns.map((x) => !!x.saved), [false, false], 'a copy keeps nothing in the library');
  assert.throws(() => store.updateTurn(t.id, 'nope', { saved: true }), /no longer exists/);
  assert.equal(store.updateTurn('abcdef12', q1, { saved: true }), null, 'a conversation that is gone');
  assert.equal(store.updateTurn(t.id, q1, { saved: false }).saved, false);
  assert.equal(store.listThreads().find((x) => x.id === t.id).prompts.length, 0);
});

test('API: edit and retry add versions; switch, branch and delete routes work', async () => {
  mock.reset();
  const app = createApp({ dataDir: tmp() });
  const base = await app.listen(0);
  const call = async (method, p, body) => {
    const res = await mock.realFetch(base + p.replace(/^\//, ''), {
      method, headers: { 'x-lectern-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ask = async (body) => {
    const text = await (await mock.realFetch(`${base}api/ask`, {
      method: 'POST', headers: { 'x-lectern-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).text();
    const done = text.split('\n\n').find((b) => b.startsWith('event: done'));
    assert.ok(done, text.slice(0, 400));
    return JSON.parse(done.split('\n')[1].slice(6));
  };
  try {
    await call('PUT', '/api/settings', { engine: 'claude-code', bins: { claude: path.join(__dirname, 'fakes', 'claude'), codex: '/nonexistent/bin' } });
    const a = await ask({ question: 'First question about sleep?' });
    const b = await ask({ question: 'Second question about naps?', threadId: a.threadId });
    assert.equal(b.parent, a.turnId);

    // Edit the second question: it follows the first, as a sibling of the old version.
    const b2 = await ask({ question: 'Second question, reworded?', threadId: a.threadId, parentId: a.turnId });
    assert.equal(b2.parent, a.turnId);
    let t = (await call('GET', `/api/thread?id=${a.threadId}`)).json;
    assert.equal(t.leaf, b2.turnId);
    assert.equal(t.turns.filter((x) => x.parent === a.turnId).length, 2);

    // Retry the first question (parent null): a new root version.
    const a2 = await ask({ question: 'First question about sleep?', threadId: a.threadId, parentId: null });
    assert.equal(a2.parent, null);

    // Switch the view back, then branch and delete.
    t = (await call('PUT', '/api/thread', { id: a.threadId, leaf: b.turnId })).json.thread;
    assert.equal(t.leaf, b.turnId);
    assert.equal((await call('PUT', '/api/thread', { id: a.threadId, leaf: 'ffffffffffff' })).status, 404);
    const copy = (await call('POST', '/api/thread/branch', { id: a.threadId, turnId: a.turnId })).json.thread;
    assert.equal(copy.turns.length, 1);
    assert.equal((await call('PUT', '/api/thread', { id: a.threadId, saved: true })).json.thread.saved, true);
    assert.equal((await call('GET', '/api/threads')).json.threads.filter((x) => x.saved).length, 1, 'only the saved one is listed as saved');
    assert.equal((await call('PUT', '/api/thread', { id: a.threadId, saved: 'yes' })).json.thread.saved, true, 'a non-boolean is ignored');
    assert.equal((await call('PUT', '/api/turn', { thread: a.threadId, id: a.turnId, saved: true })).json.turn.saved, true);
    assert.equal((await call('GET', '/api/threads')).json.threads.find((x) => x.id === a.threadId).prompts.length, 1);
    assert.equal((await call('PUT', '/api/turn', { thread: a.threadId, id: 'ffffffffffff', saved: true })).status, 404);
    await call('PUT', '/api/turn', { thread: a.threadId, id: a.turnId, saved: false });
    t = (await call('DELETE', `/api/turn?thread=${a.threadId}&id=${a.turnId}`)).json.thread;
    assert.deepEqual(t.turns.map((x) => x.id), [a2.turnId], 'the first version and everything under it are gone');
    assert.equal((await call('GET', '/api/threads')).json.threads.length, 2);
  } finally { await app.close(); mock.reset(); }
});

test('store does not recreate a deleted conversation when a running answer finishes', () => {
  const store = new Store(tmp());
  const thread = store.saveTurn(null, turn('Original'));
  assert.equal(store.deleteThread(thread.id), true);
  assert.throws(() => store.saveTurn(thread.id, turn('Late answer')), /no longer exists/);
  assert.equal(store.listThreads().length, 0);
});

test('an unreadable library is not silently overwritten on add or remove', () => {
  const dir = tmp();
  const store = new Store(dir);
  const file = path.join(dir, 'library.json');
  const original = '{not valid json';
  fs.writeFileSync(file, original);
  assert.throws(() => store.addToLibrary({ id: 'a', title: 'A' }), /left untouched/);
  assert.throws(() => store.removeFromLibrary('a'), /left untouched/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('unreadable settings do not get replaced with defaults', () => {
  const { Config } = require('../server/config');
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Config(dir), /left untouched/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, 'null');
  assert.throws(() => new Config(dir), /left untouched/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'null');
});
