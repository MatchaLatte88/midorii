import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStoredCapitalCredentials, registerIpc } from './ipc.js';
import { loadEnvLocal } from './loadEnv.js';
import { TITLEBAR } from './titlebar.js';

// TODO Phase 4: remove. Keeps userData pointed at the data already downloaded
// under the old "project-midori" name, so the walking skeleton shows real
// local bars instead of an empty library on the first run.
app.setName('project-midori');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = 'http://localhost:5301';
const isDev = !app.isPackaged;

// Project-root .env.local — CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_PASSWORD /
// CAPITAL_ENV (see .env.example). Loaded before anything reads process.env.
loadEnvLocal(path.join(__dirname, '..', '..'));
/* Credentials stored through the app take effect over the file. Awaited nowhere: the read
 * is a few milliseconds and everything that needs them is behind a user action, so the
 * window is not held up for it. */
void applyStoredCapitalCredentials();

let win = null;

function createWindow() {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: TITLEBAR[theme],
    // No native overlay: the app draws its own title bar (app-topbar) with its own
    // minimize/maximize/close, so the window is fully frameless on Windows/Linux.
    // macOS still paints its traffic lights over 'hidden' regardless — the topbar
    // leaves them room instead of drawing its own there.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Price alerts watch the live feed in the renderer and must keep checking while
      // the window is minimized — the default throttles timers or animation frames
      // once the page is not visible, which a minimized-but-still-watching alert must
      // not be subject to.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // The custom maximize/restore glyph has no other way to learn about a state
  // change Windows itself makes (Aero Snap, a double-click on the drag region).
  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));

  // A renderer error that only appears in DevTools is an error nobody sees when
  // the app is started from a script. Mirror warnings and errors to the terminal.
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
      console.error(`[renderer:${details.level}] ${details.message}${where}`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
  win.webContents.on('render-process-gone', (_e, gone) => {
    console.error(`[renderer] process gone: ${gone.reason} (exit ${gone.exitCode})`);
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
