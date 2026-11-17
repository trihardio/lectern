'use strict';
// Settings live in one JSON file in the app's data folder, readable only by you (mode 600).
// API keys never leave this machine except in requests to the service they belong to.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Profile = require('./profile');

const ENGINES = ['claude-code', 'codex'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULTS = {
  engine: '', // '' = pick the first engine that is ready
  models: {
    'claude-code': 'claude-opus-5-5',
    codex: '', // '' = whatever model Codex itself is set to use
  },
  // A small, fast model plans the search and reads each abstract; the main model writes the answer.
  helperModels: {
    'claude-code': 'claude-haiku-5-5',
    codex: '',
  },
  effort: 'medium',
  web: false,
  maxPapers: 16,
  insights: true,
  figures: true, // show figures from open-access papers (server/sources/figures.js)
  citeStyle: 'apa',
  citeMarks: 'author', // how a citation reads inside an answer: 'author' (Rahman 2019) or 'number' (3)
  sources: { openalex: true, semanticscholar: true, crossref: true, europepmc: false },
  keys: { openalex: '', semanticscholar: '' }, // paper databases only; models use your saved sign-in
  email: '',
  bins: { claude: '', codex: '' },
  // Who the answers are written for (level of study and field). See server/profile.js.
  profile: { ...Profile.EMPTY },
};

const ENV_KEYS = {
  openalex: ['OPENALEX_API_KEY'],
  semanticscholar: ['S2_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY'],
};

function defaultDataDir() {
  if (process.env.LECTERN_DATA_DIR) return process.env.LECTERN_DATA_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Lectern');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Lectern');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lectern');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const BINS = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Check a settings change that came from the window, before it is saved. Throws an Error with status 400 and a
 * message to show. A program location ("bins") must be the full path to an existing program named claude or codex
 * (claude.exe, .cmd or .bat on Windows); an empty value means "find it automatically", and a location that is
 * already saved is accepted as it is. This stops the settings being used to make Lectern start any other program.
 */
function checkPatch(patch, current = {}) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!isObj(patch)) return;
  if (typeof patch.email === 'string' && patch.email.trim() && !EMAIL.test(patch.email.trim())) {
    fail('Your email does not look like an address (name@example.org). Correct it, or leave the field empty.');
  }
  if (!isObj(patch.bins)) return;
  const saved = isObj(current.bins) ? current.bins : {};
  const win = process.platform === 'win32';
  for (const [key, label] of Object.entries(BINS)) {
    if (typeof patch.bins[key] !== 'string') continue;
    const where = patch.bins[key].trim();
    if (!where || where === String(saved[key] || '').trim()) continue;
    const names = win ? [`${key}.exe`, `${key}.cmd`, `${key}.bat`] : [key];
    const base = path.basename(where);
    if (!path.isAbsolute(where)) fail(`${label}: enter the full path to the ${key} program (for example ${win ? `C:\\Users\\you\\.local\\bin\\${key}.exe` : `/Users/you/.local/bin/${key}`}), or leave the field empty so Lectern finds it.`);
    if (!names.includes(win || process.platform === 'darwin' ? base.toLowerCase() : base)) {
      fail(`${label}: Lectern only starts a program named ${names.join(', ')} here, and ${base} has another name. Enter the path to ${label}'s ${names[0]} program, or leave the field empty.`);
    }
    let info;
    try { info = fs.statSync(where); } catch { fail(`${label}: nothing was found at ${where}. Check the path, or leave the field empty so Lectern finds ${label} itself.`); }
    if (!info.isFile()) fail(`${label}: ${where} is a folder. Enter the path to the ${names[0]} program inside it.`);
    if (!win) { try { fs.accessSync(where, fs.constants.X_OK); } catch { fail(`${label}: ${where} is not a program this computer can run. Check the path, or leave the field empty.`); } }
  }
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (!(k in base)) continue; // ignore unknown keys
    if (isObj(base[k])) out[k] = merge(base[k], isObj(v) ? v : {});
    else if (typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

class Config {
  constructor(dataDir) {
    this.dataDir = dataDir || defaultDataDir();
    this.file = path.join(this.dataDir, 'settings.json');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.settings = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isObj(data)) throw new Error('The settings file does not hold a settings object.');
      return this._sanitize(merge(DEFAULTS, data));
    } catch (e) {
      if (e.code === 'ENOENT') return this._sanitize(merge(DEFAULTS, {}));
      throw new Error(`Lectern could not read its settings file, ${this.file}. The file was left as it is. Fix it, or move it out of that folder (Lectern then starts with default settings), and open Lectern again.`);
    }
  }

  _sanitize(s) {
    if (s.engine && !ENGINES.includes(s.engine)) s.engine = '';
    if (!EFFORTS.includes(s.effort)) s.effort = 'medium';
    s.maxPapers = Math.max(6, Math.min(30, Math.round(Number(s.maxPapers) || 16)));
    for (const k of Object.keys(s.keys)) s.keys[k] = String(s.keys[k] || '').trim();
    s.email = String(s.email || '').trim();
    if (s.email && !EMAIL.test(s.email)) s.email = ''; // only a real-looking address is sent with database requests
    for (const k of Object.keys(s.bins)) s.bins[k] = String(s.bins[k] || '').trim();
    s.profile = Profile.sanitize(s.profile);
    if (s.citeMarks !== 'number') s.citeMarks = 'author';
    return s;
  }

  /** Full settings including secrets. Server-side use only. */
  get() {
    const s = JSON.parse(JSON.stringify(this.settings));
    for (const [name, envs] of Object.entries(ENV_KEYS)) {
      if (!s.keys[name]) {
        for (const e of envs) if (process.env[e]) { s.keys[name] = process.env[e].trim(); break; }
      }
    }
    return s;
  }

  /** Settings that are safe to send to the window: keys are reduced to "set / last 4". */
  getPublic() {
    const s = this.get();
    const keys = {};
    for (const [name, value] of Object.entries(s.keys)) {
      keys[name] = {
        set: !!value,
        hint: value ? `…${value.slice(-4)}` : '',
        fromEnv: !!value && !this.settings.keys[name],
      };
    }
    return { ...s, keys };
  }

  /**
   * Apply a partial update. For keys: a string sets the key, '' clears it,
   * anything else (undefined/null/object) leaves it untouched.
   */
  update(patch) {
    const next = JSON.parse(JSON.stringify(this.settings));
    const p = patch || {};
    const incomingKeys = isObj(p.keys) ? p.keys : {};
    const rest = { ...p };
    delete rest.keys;
    const merged = merge(next, rest);
    for (const name of Object.keys(DEFAULTS.keys)) {
      if (typeof incomingKeys[name] === 'string') merged.keys[name] = incomingKeys[name].trim();
    }
    this.settings = this._sanitize(merged);
    writeAtomic(this.file, JSON.stringify(this.settings, null, 2));
    return this.getPublic();
  }
}

module.exports = { Config, DEFAULTS, ENGINES, EFFORTS, defaultDataDir, writeAtomic, checkPatch };
