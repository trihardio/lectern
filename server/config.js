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
      if (!isObj(data)) throw new Error('Invalid settings format');
      return this._sanitize(merge(DEFAULTS, data));
    } catch (e) {
      if (e.code === 'ENOENT') return this._sanitize(merge(DEFAULTS, {}));
      throw new Error('Settings could not be read. The settings file was left untouched.');
    }
  }

  _sanitize(s) {
    if (s.engine && !ENGINES.includes(s.engine)) s.engine = '';
    if (!EFFORTS.includes(s.effort)) s.effort = 'medium';
    s.maxPapers = Math.max(6, Math.min(30, Math.round(Number(s.maxPapers) || 16)));
    for (const k of Object.keys(s.keys)) s.keys[k] = String(s.keys[k] || '').trim();
    s.email = String(s.email || '').trim();
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

module.exports = { Config, DEFAULTS, ENGINES, EFFORTS, defaultDataDir, writeAtomic };
