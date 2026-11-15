'use strict';
// Shared plumbing for engines that run a command-line tool you are already signed in to
// (Claude Code, Codex) instead of calling an API with a key.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

let cachedPath = null;
let isWin = process.platform === 'win32';
const SEP = () => (isWin ? ';' : ':'); // PATH separator; a Windows path itself contains ':' (C:\…)

/** Places the Windows installers put the tools (native installer, npm, winget, scoop, Volta). */
function windowsExtras(home) {
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.local', 'bin'), path.join(appData, 'npm'), path.join(local, 'Microsoft', 'WinGet', 'Links'),
    path.join(home, 'scoop', 'shims'), path.join(local, 'Volta', 'bin'), path.join(home, '.bun', 'bin'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
  ];
}

/**
 * Apps launched from Finder get a bare PATH (/usr/bin:/bin…), so tools installed by
 * Homebrew, npm or nvm are invisible. Ask the user's login shell for its PATH once.
 * On Windows the app inherits the user's PATH, plus the usual install folders.
 */
function shellPath() {
  if (cachedPath) return Promise.resolve(cachedPath);
  const home = os.homedir();
  const extras = isWin ? windowsExtras(home) : [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.claude', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'), path.join(home, 'Library', 'pnpm'), path.join(home, '.codex', 'bin'),
  ];
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm).sort().reverse()) extras.push(path.join(nvm, v, 'bin'));
  } catch { /* nvm not installed */ }

  const finish = (fromShell) => {
    const parts = [...(fromShell || '').split(SEP()), ...(process.env.PATH || process.env.Path || '').split(SEP()), ...extras];
    cachedPath = [...new Set(parts.filter(Boolean))].join(SEP());
    return cachedPath;
  };

  if (isWin) return Promise.resolve(finish(''));
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__LP__%s__LP__" "$PATH"'], { timeout: 5000, env: process.env }, (err, stdout) => {
      const m = /__LP__(.*?)__LP__/s.exec(stdout || '');
      resolve(finish(m ? m[1] : ''));
    });
  });
}

const isExec = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };

/** "2.1.325" > "2.1.99": compare dotted version folder names number by number. */
function byVersionDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Copies of the CLIs that ship inside the desktop apps, so someone who only installed the
 * Claude or ChatGPT app (and signed in there) needs nothing else.
 *   ChatGPT.app carries Codex at Contents/Resources/codex-cli/bin/codex.
 *   Claude.app keeps Claude Code in ~/Library/Application Support/Claude/claude-code/<version>/<build>/.
 */
function bundledBins(name) {
  const home = os.homedir();
  if (name === 'codex') {
    return ['/Applications', path.join(home, 'Applications')]
      .map((dir) => path.join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'));
  }
  if (name === 'claude') {
    const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    const out = [];
    try {
      for (const v of fs.readdirSync(root).filter((d) => /^\d+(\.\d+)*$/.test(d)).sort(byVersionDesc)) {
        for (const build of fs.readdirSync(path.join(root, v))) {
          out.push(path.join(root, v, build, 'claude.app', 'Contents', 'MacOS', 'claude'));
        }
      }
    } catch { /* the Claude app is not installed */ }
    return out;
  }
  return [];
}

/**
 * Find an executable: an explicit path from Settings if given (and only that), otherwise
 * the user's PATH, otherwise the copy inside the desktop app.
 */
async function findBin(name, explicit) {
  if (explicit) return isExec(explicit) ? explicit : null;
  // Windows: the native installer gives claude.exe; npm gives claude.cmd (a small script that runs node).
  const names = isWin ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of (await shellPath()).split(SEP())) {
    for (const n of names) {
      const full = path.join(dir, n);
      if (isExec(full)) return full;
    }
  }
  return bundledBins(name).find(isExec) || null;
}

/**
 * How to start a tool. Usually just the file. On Windows, npm installs a tool as a .cmd script,
 * which Node will only start through cmd.exe, and cmd.exe would mangle a long prompt passed as an
 * argument. So read the script for the JavaScript file it runs and start that with node directly.
 */
async function launch(bin, args) {
  if (!isWin || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, shell: false };
  let script = null;
  try {
    const text = fs.readFileSync(bin, 'utf8');
    const m = /"%~?dp0%?\\?([^"%]+?\.[cm]?js)"/i.exec(text);
    if (m) script = path.join(path.dirname(bin), ...m[1].split(/[\\/]+/).filter(Boolean));
  } catch { /* unreadable: handled below */ }
  if (script && fs.existsSync(script)) {
    const beside = path.join(path.dirname(bin), 'node.exe');
    const node = isExec(beside) ? beside : await findBin('node');
    if (node) return { file: node, args: [script, ...args], shell: false };
  }
  // Last resort: through cmd.exe, but only for short, plain arguments.
  if (args.every((a) => /^[\w.,=:/\\@+-]*$/.test(a))) return { file: bin, args, shell: true };
  throw new Error(`Could not start ${path.basename(bin)}. Reinstall it with its official Windows installer, or set its full path in Settings.`);
}

/** Run a short command (such as a login check) and resolve { code, stdout, output }. Never rejects.
 *  `output` is stdout and stderr together: some tools (Codex) print their status on stderr. */
async function runQuick(bin, args, { dropEnv = [], timeout = 8000 } = {}) {
  const env = { ...process.env, PATH: await shellPath() };
  for (const k of dropEnv) delete env[k];
  let how;
  try { how = await launch(bin, args); } catch (e) { return { code: 1, stdout: '', output: e.message }; }
  return new Promise((resolve) => {
    const child = execFile(how.file, how.args, { cwd: scratchDir(), env, timeout, shell: how.shell, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: out, output: `${out}\n${stderr || ''}` });
    });
    if (child.stdin) child.stdin.end();
  });
}

/**
 * Remember an engine's status for a while: checking a login spawns a process, and the
 * status is read on every question. A signed-out result is kept only briefly so that
 * signing in shows up almost at once.
 */
function statusCache() {
  const memo = new Map();
  return async (key, compute) => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < (hit.value.ready ? 60000 : 4000)) return hit.value;
    const value = await compute();
    memo.set(key, { at: Date.now(), value });
    return value;
  };
}

/** An empty folder to run tools in, so they don't pick up or touch any project files. */
function scratchDir() {
  const dir = path.join(os.tmpdir(), 'lectern-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run a CLI, feed it `input` on stdin, and call onLine for each stdout line.
 * Resolves { code, stderr }. Killing is wired to the AbortSignal.
 */
async function runCli({ bin, args, input, env = {}, dropEnv = [], signal, onLine, timeout = 20 * 60 * 1000 }) {
  const childEnv = { ...process.env, ...env, PATH: await shellPath() };
  for (const k of dropEnv) delete childEnv[k];
  const how = await launch(bin, args);

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Stopped'));
    const child = spawn(how.file, how.args, { cwd: scratchDir(), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: how.shell, windowsHide: true });
    let stderr = '';
    let buf = '';
    let done = false;

    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); } };
    const onAbort = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); finish(reject, new Error('Stopped')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error('The command-line tool took too long and was stopped.')); }, timeout);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { onLine(line); } catch (e) { child.kill('SIGTERM'); finish(reject, e); } }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (e) => finish(reject, new Error(`Could not start ${path.basename(bin)}: ${e.message}`)));
    child.on('close', (code) => {
      if (buf.trim()) { try { onLine(buf.trim()); } catch (e) { return finish(reject, e); } }
      finish(resolve, { code, stderr });
    });
    child.stdin.on('error', () => { /* tool exited before reading stdin */ });
    child.stdin.end(input || '');
  });
}

/** If stderr complains about an option this version doesn't know, name it so the caller can retry without it. */
function unknownFlag(stderr) {
  const m = /(?:unknown|unrecognized|unexpected) (?:option|argument|flag)\s*[:']*\s*'?(--?[\w-]+)/i.exec(stderr || '');
  return m ? m[1] : null;
}

/** Remove a flag (and its value, if it takes one) from an argv array. */
function withoutFlag(args, flag, takesValue) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { if (takesValue) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

module.exports = {
  shellPath, findBin, bundledBins, launch, runQuick, statusCache, scratchDir, runCli, unknownFlag, withoutFlag,
  _resetPathCache: () => { cachedPath = null; },
  _setPlatformForTest: (win) => { isWin = win; cachedPath = null; },
};
