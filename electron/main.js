'use strict';
// The desktop shell. It starts the local server (server/index.js) on a free port and
// shows it in a window. All real work happens in the server; this file only owns the window.

const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');
const { createApp } = require('../server');

let lectern = null;
let baseUrl = '';
let win = null;

const isWeb = (u) => /^https?:\/\//i.test(u);

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
  win.on('closed', () => { win = null; });

  await win.loadURL(baseUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    lectern = createApp({
      // The microphone button: hand over to macOS Dictation, in whatever text box has the cursor.
      // (The browser engine inside Electron has no speech recognition service of its own.)
      // Windows has no such hand-over; the window points people to Windows voice typing instead.
      onDictate: process.platform !== 'darwin' ? undefined : () => {
        if (!win) return false;
        win.focus();
        win.webContents.focus();
        Menu.sendActionToFirstResponder('startDictation:');
        return true;
      },
    });
    baseUrl = await lectern.listen(0);
    await createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
