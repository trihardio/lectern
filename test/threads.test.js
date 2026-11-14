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
