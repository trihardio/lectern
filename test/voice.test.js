'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createVoice } = require('../electron/voice');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(getBundle = async () => '/test/Lectern Voice.app') {
  const launches = [];
  const voice = createVoice({ getBundle, launch(command, args) {
    const child = new EventEmitter();
    launches.push({ command, args, child, dir: args[args.indexOf('--args') + 1] });
    return child;
  } });
  const publish = (value) => fs.writeFileSync(path.join(launches.at(-1).dir, 'status.json'), JSON.stringify(value));
  return { voice, launches, publish };
}

test('native voice reports actual startup, transcripts, errors and a fresh repeat session', async () => {
  const { voice, launches, publish } = setup();
  try {
    const first = voice.start('en-GB');
    assert.equal(first.state, 'starting');
    assert.throws(() => voice.start('en-US'), /already/);
    await tick();
    assert.equal(launches.length, 1);
    assert.ok(launches[0].args.includes('en-GB'));
    assert.equal(fs.statSync(launches[0].dir).mode & 0o777, 0o700);
    publish({ state: 'listening', text: 'Test question' });
    assert.equal(voice.status(first.id).text, 'Test question');
    assert.equal(voice.status('../other').ok, false);
    voice.stop('unrelated');
    assert.equal(voice.status(first.id).state, 'listening');
    publish({ state: 'error', text: 'Test question', error: 'Microphone denied' });
    assert.equal(voice.status(first.id).error, 'Microphone denied');
    const next = voice.start('en-US');
    assert.notEqual(next.id, first.id);
    assert.equal(next.text, '');
    await tick();
    voice.stop(next.id);
    assert.ok(fs.existsSync(path.join(launches[1].dir, 'stop')));
    publish({ state: 'listening', text: 'Late callback' });
    assert.equal(voice.status(next.id).state, 'stopped');
    assert.equal(voice.status(next.id).text, '');
  } finally { voice.close(); }
});

test('cancellation during native build prevents microphone launch', async () => {
  let resolveBuild;
  const { voice, launches } = setup(() => new Promise((resolve) => { resolveBuild = resolve; }));
  try {
    const session = voice.start('en-US');
    await tick();
    voice.stop(session.id);
    resolveBuild('/test/voice.app');
    await tick();
    assert.equal(launches.length, 0);
    assert.equal(voice.status(session.id).state, 'stopped');
  } finally { voice.close(); }
});

test('native build and process failures are visible instead of pretending to record', async () => {
  const failed = setup(async () => { throw new Error('Compiler missing'); });
  try {
    const s = failed.voice.start('en-US');
    await tick();
    assert.equal(failed.voice.status(s.id).state, 'error');
    assert.match(failed.voice.status(s.id).error, /Compiler missing/);
  } finally { failed.voice.close(); }
  const { voice, launches } = setup();
  try {
    const s = voice.start('bad locale / path');
    await tick();
    assert.ok(launches[0].args.includes('en-US'));
    launches[0].child.emit('exit', 1);
    assert.equal(voice.status(s.id).state, 'error');
    assert.match(voice.status(s.id).error, /closed unexpectedly/);
  } finally { voice.close(); }
});
