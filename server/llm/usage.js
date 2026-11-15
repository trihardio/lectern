'use strict';
// Account limits, not per-answer token counts. These reads never start a model turn.
// Credentials stay here; only normalized percentages and reset times reach the window.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { findBin, runQuick, shellPath, scratchDir, launch } = require('./cli');
const APP_VERSION = require('../../package.json').version;

const CACHE_MS = 110 * 1000; // leave headroom for the window's two-minute refresh timer
const unavailable = (detail) => ({ weekly: null, fiveHour: null, checkedAt: null, stale: false, detail });
const iso = (value) => {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};
function windowUsage(percent, reset) {
  // Missing is NOT zero. Some plans expose only one of the two windows.
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return { usedPercent: Math.min(100, Math.max(0, percent)), resetsAt: iso(reset) };
}
function claudeWindows(data) {
  return {
    weekly: windowUsage(data?.seven_day?.utilization, data?.seven_day?.resets_at),
    fiveHour: windowUsage(data?.five_hour?.utilization, data?.five_hour?.resets_at),
  };
}
function codexWindows(data) {
  // Prefer the account-wide Codex bucket; never substitute a model-specific allowance.
  const limits = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  const windows = [limits?.primary, limits?.secondary].filter(Boolean);
  const read = (minutes) => {
    const w = windows.find((w) => w.windowDurationMins === minutes);
    return windowUsage(w?.usedPercent, w?.resetsAt);
  };
  return { weekly: read(10080), fiveHour: read(300) };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function readClaudeUsage() {
  const customDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = customDir || path.join(os.homedir(), '.claude');
  const config = await readJson(customDir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'));
  const cache = config?.cachedUsageUtilization;
  const cachedWindows = claudeWindows(cache?.utilization);
  const hasCache = (cachedWindows.weekly || cachedWindows.fiveHour) && Number.isFinite(cache?.fetchedAtMs);
  const cached = hasCache ? { ...cachedWindows, checkedAt: new Date(cache.fetchedAtMs).toISOString(), stale: true,
    detail: 'Last reading from Claude Code. Open Claude Code to refresh its sign-in if needed.' } : null;
  if (cached && Date.now() - cache.fetchedAtMs < CACHE_MS) return { ...cached, stale: false, detail: '' };

  // Claude Code uses a local credential file or macOS Keychain. Never change/refresh its tokens.
  let credentials = await readJson(path.join(dir, '.credentials.json'));
  if (!credentials?.claudeAiOauth?.accessToken && process.platform === 'darwin' && !customDir) {
    const keychain = await runQuick('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    try { credentials = JSON.parse(keychain.stdout); } catch { /* locked or not present */ }
  }
  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token) return cached || unavailable('Sign in to Claude Code to see your plan usage.');
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!res.ok) return cached || unavailable(res.status === 401 || res.status === 403
      ? 'Open Claude Code and sign in again to read usage.' : 'Claude usage is temporarily unavailable.');
    const windows = claudeWindows(await res.json());
    return { ...windows, checkedAt: new Date().toISOString(), stale: false,
      detail: windows.weekly || windows.fiveHour ? '' : 'Claude did not report these usage windows for this plan.' };
  } catch { return cached || unavailable('Could not refresh Claude usage. Check your connection.'); }
}

/** Codex owns authentication. Its documented app-server RPC reads limits without inference. */
async function readCodexUsage(bin, { timeout = 12000 } = {}) {
  const env = { ...process.env, PATH: await shellPath() };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const how = await launch(bin, ['app-server']); // a .cmd from npm on Windows runs through node
  return new Promise((resolve, reject) => {
    const child = spawn(how.file, how.args, { cwd: scratchDir(), env, stdio: ['pipe', 'pipe', 'ignore'], shell: how.shell, windowsHide: true });
    const lines = readline.createInterface({ input: child.stdout });
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
      if (err) reject(new Error('Codex usage is unavailable. Check your Codex sign-in and connection.'));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(true), timeout);
    const send = (message) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n'); };
    child.on('error', () => finish(true));
    child.on('exit', () => finish(true));
    child.stdin.on('error', () => finish(true));
    lines.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 1 && msg.id !== 2) return;
      if (msg.error) return finish(true);
      if (msg.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else {
        const windows = codexWindows(msg.result);
        finish(false, { ...windows, checkedAt: new Date().toISOString(), stale: false,
          detail: windows.weekly || windows.fiveHour ? '' : 'Codex did not report five-hour or weekly limits for this plan.' });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lectern', title: 'Lectern', version: APP_VERSION } } });
  });
}

function createUsageMonitor({ readers = { 'claude-code': readClaudeUsage, codex: readCodexUsage }, find = findBin, now = Date.now } = {}) {
  const cache = new Map();
  async function read(id, explicit) {
    const key = `${id}:${explicit || ''}`;
    const previous = cache.get(key);
    if (previous && (previous.pending || now() - previous.at < CACHE_MS)) return previous.pending || previous.value;
    const entry = { at: now() };
    entry.pending = (async () => {
      try {
        const bin = await find(id === 'codex' ? 'codex' : 'claude', explicit);
        entry.value = bin ? await readers[id](bin) : unavailable(`Connect ${id === 'codex' ? 'Codex' : 'Claude Code'} to see usage.`);
      } catch {
        // Do not forward provider errors: they can include account details or credentials.
        entry.value = unavailable(`${id === 'codex' ? 'Codex' : 'Claude'} usage is unavailable. Check your sign-in and connection.`);
      }
      entry.at = now();
      entry.pending = null;
      return entry.value;
    })();
    cache.set(key, entry);
    return entry.pending;
  }
  return async (settings) => {
    const [claude, codex] = await Promise.all([read('claude-code', settings.bins.claude), read('codex', settings.bins.codex)]);
    return { providers: { 'claude-code': claude, codex } };
  };
}

module.exports = { createUsageMonitor, claudeWindows, codexWindows, readCodexUsage };
