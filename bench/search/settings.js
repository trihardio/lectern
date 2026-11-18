'use strict';
// The settings object the real search code is given (server/sources/index.js reads settings.sources and settings.keys).
// Saved keys are read through Config in memory only when asked for; they are never printed, stored or put in a cache key.

const DEFAULT_SOURCES = ['openalex', 'semanticscholar', 'crossref']; // the owner's saved setting (Europe PMC is off)
const ALL_SOURCES = ['openalex', 'semanticscholar', 'crossref', 'europepmc'];

/**
 * useSavedKeys   read the owner's keys from the settings file (or LECTERN_* environment) into memory
 * assumeKeys     offline replay of a run that was recorded with keys: pass a placeholder so the code takes the same
 *                path as with keys (without a key, OpenAlex is asked one query only and Semantic Scholar is paced).
 *                The placeholder is never sent anywhere: offline mode has no network.
 * sources        names of the databases to switch on
 */
function makeSettings({ sources = DEFAULT_SOURCES, useSavedKeys = false, assumeKeys = false } = {}) {
  for (const s of sources) if (!ALL_SOURCES.includes(s)) throw new Error(`Unknown source "${s}". Choose from ${ALL_SOURCES.join(', ')}.`);
  const settings = { sources: Object.fromEntries(ALL_SOURCES.map((s) => [s, sources.includes(s)])), keys: { openalex: '', semanticscholar: '' }, email: '' };
  if (useSavedKeys) {
    const { Config } = require('../../server/config');
    const saved = new Config().get();
    settings.keys = { openalex: saved.keys.openalex || '', semanticscholar: saved.keys.semanticscholar || '' };
  } else if (assumeKeys) {
    settings.keys = { openalex: 'offline-placeholder', semanticscholar: 'offline-placeholder' };
  }
  return settings;
}

/** What the run summary may say about keys: which are present, never their values. */
function keyStatus(settings) {
  return { openalex: !!settings.keys.openalex, semanticscholar: !!settings.keys.semanticscholar };
}

module.exports = { makeSettings, keyStatus, DEFAULT_SOURCES, ALL_SOURCES };
