/* IPC surface — the only bridge between the renderer and the data layer.
 *
 * Every handler is a thin adapter: validate, delegate, let errors propagate.
 * Electron serializes a thrown Error back to the caller as a rejected promise,
 * so a failed download surfaces in the UI instead of vanishing into a log.
 *
 * Walking-skeleton scope: only the `data:*` handlers Phase 1 needs. Drawings,
 * backtest, replay, sweep, and ui:set-theme come back in later phases, once
 * their own data/engine modules are ported (see the migration plan).
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';

import { listSymbols } from './data/providers/binance.js';
import { listDatasets, readBars, readMeta, TIMEFRAMES } from './data/store/barStore.js';

/** Datasets live outside the app bundle so an update never touches them. */
export function dataDir() {
  return path.join(app.getPath('userData'), 'market-data');
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requireTimeframe(tf) {
  if (!TIMEFRAMES[tf]) {
    throw new Error(`Unknown timeframe "${tf}". Known: ${Object.keys(TIMEFRAMES).join(', ')}`);
  }
  return tf;
}

export function registerIpc() {
  ipcMain.handle('data:datasets', () => listDatasets(dataDir()));

  ipcMain.handle('data:meta', (_e, symbol) => readMeta(dataDir(), requireString(symbol, 'symbol')));

  ipcMain.handle('data:symbols', () => listSymbols());

  ipcMain.handle('data:bars', async (_e, { symbol, timeframe, from, to, dropIncomplete = false }) => {
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    return readBars(dataDir(), symbol, timeframe, from, to, dropIncomplete);
  });
}
