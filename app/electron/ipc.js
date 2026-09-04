/* IPC surface — the only bridge between the renderer and the data layer.
 *
 * Every handler is a thin adapter: validate, delegate, let errors propagate.
 * Electron serializes a thrown Error back to the caller as a rejected promise,
 * so a failed download surfaces in the UI instead of vanishing into a log.
 *
 * Scope so far: market data and replay persistence. Drawings, backtest, sweep
 * and ui:set-theme come back once their own modules are ported.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { DEFAULT_SOURCE, listSources, sourceOf } from './data/providers/index.js';
import { listDatasets, mergeBars, parseTimeframe, readBars, readMeta } from './data/store/barStore.js';
import { condenseEquity, saveRun } from './data/store/runStore.js';
import { deleteSession, listSessions, loadSession, saveSession } from './data/store/sessionStore.js';

/** Datasets live outside the app bundle so an update never touches them. */
export function dataDir() {
  return path.join(app.getPath('userData'), 'market-data');
}

/** Results outlive the data they were computed from, so they live apart too. */
export function runsDir() {
  return path.join(app.getPath('userData'), 'backtests');
}

/**
 * Sessions that are not finished yet.
 *
 * Apart from the runs on purpose: these are working state, they are removed
 * when they are picked up again, and a library of results should not have
 * half-played accounts sitting in it.
 */
export function sessionsDir() {
  return path.join(app.getPath('userData'), 'replay-sessions');
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

/* Anything the store can bucket exactly, in either dialect — Vela's canonical
 * bare minutes (`60`, `240`) as well as Midorii's aliases (`1h`, `4h`). The
 * store owns the grammar and throws its own message; this is the one place
 * that decides a timeframe is acceptable at all. */
function requireTimeframe(tf) {
  parseTimeframe(tf);
  return tf;
}

export function registerIpc() {
  ipcMain.handle('data:datasets', () => listDatasets(dataDir()));

  ipcMain.handle('data:meta', (_e, symbol) => readMeta(dataDir(), requireString(symbol, 'symbol')));

  ipcMain.handle('data:sources', () => listSources());

  ipcMain.handle('data:symbols', (_e, source = DEFAULT_SOURCE) => (
    sourceOf(requireString(source, 'source')).module.listSymbols()
  ));

  /* Downloads land in ONE file per symbol, at the base timeframe, whichever
   * venue they came from — that is what lets the store aggregate every other
   * timeframe from a single source of truth.
   *
   * Which is also why a dataset belongs to the venue that created it: BTCUSDT
   * on one venue and BTCUSDT on another are different markets with different
   * prints, and merging them would produce a chart of a market that does not
   * exist. The refusal is loud rather than clever — the user picks a different
   * source, or deletes the dataset first.
   */
  ipcMain.handle('data:download', async (event, request) => {
    const { symbol, from, to, source = DEFAULT_SOURCE } = request ?? {};
    const sym = requireString(symbol, 'symbol').toUpperCase();
    const venue = sourceOf(requireString(source, 'source'));

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('from and to must be valid dates');
    }
    if (fromDate >= toDate) throw new Error('The start date must be before the end date');

    const existing = await readMeta(dataDir(), sym);
    if (existing?.source && existing.source !== venue.id) {
      throw new Error(
        `${sym} was downloaded from ${existing.source}. Two venues' prints are two `
        + `different markets and must not be merged — download it under a different `
        + `name, or remove the existing dataset first.`,
      );
    }

    const sender = BrowserWindow.fromWebContents(event.sender);
    const progress = (p) => sender?.webContents.send('data:download-progress', {
      symbol: sym, source: venue.id, ...p,
    });

    const { bars, missing } = await venue.module.downloadRange(sym, fromDate, toDate, '1m', progress);
    const result = await mergeBars(dataDir(), sym, bars, { source: venue.id });
    return { ...result, missing, source: venue.id };
  });

  ipcMain.handle('data:bars', async (_e, { symbol, timeframe, from, to, dropIncomplete = false }) => {
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    return readBars(dataDir(), symbol, timeframe, from, to, dropIncomplete);
  });

  /* ─── Replay ────────────────────────────────────────────────────────── */

  /* A replay is played out in the renderer — a click has to become an order
   * and a redrawn chart in the same frame, which a round trip through here
   * cannot do. The engine it runs on is the same one; see
   * shared/engine/replaySession.js for why that class lives in shared/.
   *
   * So only the finished session crosses the bridge, and it goes into the same
   * store a backtest does. That is the whole point of storing it: a run traded
   * by hand and a run produced by a strategy end up in one library, on one
   * results page, comparable against each other.
   */
  ipcMain.handle('replay:save', async (_e, request) => {
    const { symbol, timeframe, note = '', ...result } = request ?? {};

    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!result.stats || !Array.isArray(result.trades)) {
      throw new Error('replay:save: the session has no result to store');
    }
    if (result.trades.length === 0) {
      throw new Error('replay:save: the session took no trades');
    }
    if (!Number.isFinite(result.from) || !Number.isFinite(result.to)) {
      throw new Error('replay:save: the session has no range');
    }

    return saveRun(runsDir(), {
      ...result,
      strategy: 'replay',
      strategyName: 'Manual replay',
      /* Deliberately empty. A replay has no settings that held for the whole
       * session — the risk on each trade was decided at the moment it was
       * taken — and storing one of them would be a claim the session cannot
       * support. The trades carry what actually happened. */
      params: {},
      symbol,
      timeframe,
      note: typeof note === 'string' ? note.slice(0, 2000) : '',
    });
  });

  /* A session that is not over yet is a different thing from a finished run,
   * and goes somewhere else. What crosses the bridge is the account and the
   * clock — never the bars, which are already in the data store and are the
   * same bars tomorrow. See ReplaySession.snapshot.
   */
  ipcMain.handle('replay:saveSession', async (_e, request) => {
    const { id = null, name = '', symbol, timeframe, session, stats = {} } = request ?? {};

    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!session || session.version !== 1 || !session.broker) {
      throw new Error('replay:saveSession: this is not a session snapshot');
    }
    if (!Number.isFinite(session.clock) || !Number.isFinite(session.startTime)) {
      throw new Error('replay:saveSession: the session has no clock');
    }

    return saveSession(sessionsDir(), {
      id,
      name: typeof name === 'string' ? name.slice(0, 120) : '',
      symbol,
      timeframe,
      startTime: session.startTime,
      clock: session.clock,
      stats,
      session: {
        ...session,
        /* The same condensing a stored run gets, and for the same reason: the
         * curve carries a point per bar, and the figures that need every point
         * — the peak, the worst drawdown — were computed over the full curve
         * before it got here and are stored beside it. */
        equityCurve: condenseEquity(session.equityCurve ?? []),
      },
    });
  });

  ipcMain.handle('replay:sessions', () => listSessions(sessionsDir()));

  ipcMain.handle('replay:loadSession', (_e, id) => (
    loadSession(sessionsDir(), requireString(id, 'id'))
  ));

  ipcMain.handle('replay:deleteSession', (_e, id) => (
    deleteSession(sessionsDir(), requireString(id, 'id'))
  ));
}
