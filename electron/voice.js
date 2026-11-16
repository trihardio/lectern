'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// One microphone session per window. The helper only accepts paths generated here;
// caller-provided IDs never become file paths. Transcripts are temporary, audio is not saved.
function createVoice({ getBundle, launch = spawn }) {
  let current = null;
  const terminal = (s) => ['stopped', 'error'].includes(s.state);
  function stop(id) {
    if (!current || (id && current.id !== id)) return { ok: true };
    const s = current;
    if (fs.existsSync(s.dir)) fs.writeFileSync(path.join(s.dir, 'stop'), '');
    s.state = 'stopped';
    dispose(s);
    return { ok: true };
  }
  function dispose(s) {
    if (!s) return;
    clearTimeout(s.timeout);
    if (s.cleanup) return;
    if (fs.existsSync(s.dir)) fs.writeFileSync(path.join(s.dir, 'stop'), '');
    // Allow the helper's stop timer to release the input device before removing files.
    s.cleanup = setTimeout(() => fs.rmSync(s.dir, { recursive: true, force: true }), 2000);
    s.cleanup.unref();
  }
  function status(id) {
    const s = current;
    if (!s || id !== s.id) return { ok: false, error: 'This voice session has ended.' };
    if (!terminal(s)) {
      fs.writeFileSync(path.join(s.dir, 'heartbeat'), '');
      try {
        const result = JSON.parse(fs.readFileSync(path.join(s.dir, 'status.json'), 'utf8'));
        if (['starting', 'listening', 'stopped', 'error'].includes(result.state)) s.state = result.state;
        s.text = typeof result.text === 'string' ? result.text.slice(0, 50000) : s.text;
        s.error = typeof result.error === 'string' ? result.error : '';
      } catch { /* The helper is still launching; its writes are atomic. */ }
    }
    if (terminal(s)) dispose(s);
    return { ok: true, id: s.id, state: s.state, text: s.text, error: s.error };
  }
  function start(language) {
    if (current && !terminal(current)) status(current.id);
    if (current && !terminal(current)) throw new Error('Voice input is already starting or listening. Stop it before trying again.');
    dispose(current);
    const s = current = { id: crypto.randomUUID(), dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-voice-')), state: 'starting', text: '', error: '' };
    fs.chmodSync(s.dir, 0o700);
    fs.writeFileSync(path.join(s.dir, 'heartbeat'), '');
    const fail = (message) => { if (!terminal(s)) { s.state = 'error'; s.error = message; dispose(s); } };
    s.timeout = setTimeout(() => fail('Voice input timed out. Click the mic to try again.'), 150000);
    s.timeout.unref();
    // Return the session ID immediately so cancellation works during compilation and permissions.
    Promise.resolve().then(getBundle).then((bundle) => {
      if (terminal(s) || current !== s) return;
      const lang = typeof language === 'string' && /^[a-zA-Z0-9_-]{2,40}$/.test(language) ? language : 'en-US';
      const child = launch('/usr/bin/open', ['-n', '-g', '-W', bundle, '--args', s.dir, lang, String(process.pid)], { stdio: 'ignore' });
      child.on('error', (e) => fail('Voice input could not start: ' + e.message));
      child.on('exit', (code) => {
        if (current === s && !terminal(s)) {
          status(s.id);
          if (!terminal(s)) fail(`Voice input closed unexpectedly${code ? ` (${code})` : ''}. Try again.`);
        }
      });
    }).catch((e) => fail(e.message));
    return status(s.id);
  }
  return { start, status, stop, close() {
    stop();
    if (current) {
      clearTimeout(current.cleanup);
      fs.rmSync(current.dir, { recursive: true, force: true });
    }
    current = null;
  } };
}
module.exports = { createVoice };
