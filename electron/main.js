'use strict';
// The desktop shell. It starts the local server (server/index.js) and shows it in a window.
// All real work happens in the server; this file only owns the window.

const { app, BrowserWindow, shell, nativeTheme, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { createVoice } = require('./voice');
const { buildVoice } = require('./build-voice');
const { createApp } = require('../server');
const { defaultDataDir } = require('../server/config');
const { stopAll } = require('../server/llm/cli');

// The same port every launch keeps the window's address the same, and with it what the window remembers
// (saved filters, chosen models, spelling variant): a browser keeps that per address. `npm run web` uses 4319.
// If another program holds this port, any free port is used for this launch.
const PORT = 47319;

let lectern = null;
let baseUrl = '';
let win = null;
let voice = null;

const isWeb = (u) => /^https?:\/\//i.test(u);
const isLectern = (u) => { try { return !!baseUrl && new URL(u).origin === new URL(baseUrl).origin; } catch { return false; } };

// The only web permission the window uses: writing to the clipboard (Copy buttons). Voice input runs in the
// native helper (electron/voice.js), not through the page, so the microphone, camera, notifications and the
// rest are refused.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

// Save what the window shows as a PDF. The page has already swapped in its print-only report
// (print styles in ui/checks.css), so this prints the window and asks where to put the file.
const pdf = {
  async save({ name }) {
    if (!win) return { ok: false, error: 'The window is closed.' };
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export PDF', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(filePath, data);
    return { ok: true, path: filePath };
  },
};

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    title: 'Lectern',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0D1512' : '#EBEFEA',
    // macOS: the traffic lights sit on the green rail. Windows keeps its normal title bar and controls.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } } : { autoHideMenuBar: true }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });

  // Paper links, DOIs and Google Scholar open in your normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Only Lectern's own address loads in the window (compared by origin: a lookalike such as
  // http://127.0.0.1:47319.example.org would pass a plain text prefix test).
  win.webContents.on('will-navigate', (event, url) => {
    if (isLectern(url)) return;
    event.preventDefault();
    if (isWeb(url)) shell.openExternal(url);
  });
  win.on('closed', () => { voice?.stop(); win = null; });
  win.webContents.on('render-process-gone', () => voice?.stop());
  win.webContents.on('did-start-loading', () => voice?.stop());

  await win.loadURL(baseUrl);
}

/** Lectern could not start (for example its settings file is damaged): say what happened and where the data is. */
function startupFailed(e) {
  let folder = '';
  try { folder = lectern ? lectern.config.dataDir : defaultDataDir(); } catch { /* the message alone will do */ }
  const message = (e && e.message) || String(e);
  dialog.showErrorBox('Lectern could not start', `${message}${folder ? `\n\nLectern keeps its settings, chats and library in:\n${folder}` : ''}`);
  if (!win) app.quit();
}

async function start() {
  if (process.platform === 'darwin') voice = createVoice({ getBundle: async () => {
    // In a built app the helper sits beside app.asar, in app.asar.unpacked (scripts/make-app.sh unpacks
    // native/): macOS `open` is a separate program and cannot see inside the archive.
    const bundled = path.join(__dirname, '..', 'native', 'Lectern Voice.app')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (app.isPackaged) {
      if (fs.existsSync(bundled)) return bundled;
      throw new Error('This Lectern build is missing voice input. Rebuild or reinstall the app.');
    }
    return buildVoice(path.join(app.getPath('userData'), 'voice'));
  } });
  const permitted = (permission, url) => ALLOWED_PERMISSIONS.has(permission) && isLectern(url);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permitted(permission, details && details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permitted(permission, origin));

  lectern = createApp({ voice, pdf });
  try {
    baseUrl = await lectern.listen(PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    baseUrl = await lectern.listen(0); // another program has the usual port: use any free one this time
  }
  await createWindow();
  app.on('activate', () => { if (!win) createWindow().catch(startupFailed); });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(start).catch(startupFailed);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Quitting stops a model that is still writing: its command-line tool would otherwise go on using the plan.
  app.on('before-quit', () => { voice?.close(); stopAll(); });
}
