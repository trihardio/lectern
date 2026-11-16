'use strict';
// The desktop shell. It starts the local server (server/index.js) on a free port and
// shows it in a window. All real work happens in the server; this file only owns the window.

const { app, BrowserWindow, shell, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createVoice } = require('./voice');
const { buildVoice } = require('./build-voice');
const { createApp } = require('../server');

let lectern = null;
let baseUrl = '';
let win = null;
let voice = null;

const isWeb = (u) => /^https?:\/\//i.test(u);

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
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    if (isWeb(url)) shell.openExternal(url);
  });
  win.on('closed', () => { voice?.stop(); win = null; });
  win.webContents.on('render-process-gone', () => voice?.stop());
  win.webContents.on('did-start-loading', () => voice?.stop());

  await win.loadURL(baseUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
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
    lectern = createApp({ voice, pdf });
    baseUrl = await lectern.listen(0);
    await createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => voice?.close());
}
