/* IPC surface — the only bridge between the renderer and the data layer.
 *
 * Every handler is a thin adapter: validate, delegate, let errors propagate.
 * Electron serializes a thrown Error back to the caller as a rejected promise,
 * so a failed download surfaces in the UI instead of vanishing into a log.
 *
 * Scope so far: market data (downloaded, imported from a file, or fetched on demand
 * for a backtest), replay and backtest persistence, the run library, the sweep shelf,
 * the app theme and the custom title bar's window controls. Drawings come back once
 * their own module is ported.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  capitalAccount, capitalActivities, capitalAmendOrder, capitalAmendPosition, capitalCancelOrder, capitalClosePosition, capitalConfigured,
  capitalCreateOrder, capitalEnvironment, capitalMarketInfo, capitalMarkets, capitalOpenPosition, capitalPositions,
  capitalPrices, capitalProbe, capitalSubscribe, capitalSubscribeQuotes, capitalTransactions, capitalWorkingOrders,
  configureCapital,
} from './data/capital.js';
import {
  configureProjectX, projectXAccounts, projectXBars, projectXConfigured, projectXContracts,
  projectXEnvironment, projectXProbe, projectXSubscribe, projectXSubscribeQuotes,
} from './data/projectx.js';
import {
  binanceSpotAccount, binanceSpotCancelAll, binanceSpotCancelOrder, binanceSpotClose,
  binanceSpotEnvironment, binanceSpotOpenOrders, binanceSpotPlaceOrder, binanceSpotProbe,
  binanceSpotReplaceProtection, binanceSpotSymbolInfo, binanceSpotTrades, configureBinanceSpot,
} from './data/binanceSpot.js';
import {
  bybitCancelAll, bybitCancelOrder, bybitCategory, bybitClose, bybitEnvironment, bybitExecutions,
  bybitInstrument, bybitKlines, bybitOpenOrders, bybitPlaceOrder, bybitPositions, bybitProbe,
  bybitSetProtection, bybitWallet, configureBybit,
} from './data/bybit.js';
import { clearCredentials, encryptionAvailable, readPublic, readSecret, saveCredentials } from './data/store/credentialStore.js';
import { CSV_TIME_ZONES, dominantInterval, missingFields, parseMarketCsv, sniffCsv } from './data/csv.js';
import { DEFAULT_SOURCE, listSources, sourceOf } from './data/providers/index.js';
import { deleteDataset, describeMs, listDatasets, mergeBars, parseTimeframe, readBars, readMeta } from './data/store/barStore.js';
import { annotateSweep, deleteSweep, listSweeps, loadSweep, saveSweep } from './data/store/sweepStore.js';
import { clearStrategySettings, loadStrategySettings, saveStrategySettings } from './data/store/strategyStore.js';
import { annotateRun, condenseEquity, deleteRun, listRuns, loadRun, saveRun } from './data/store/runStore.js';
import { clearAccount, loadAccount, saveAccount } from './data/store/paperStore.js';
import { appendLiveTrade, clearLiveTrades, loadLiveTrades, settleLiveTrade } from './data/store/liveTradeStore.js';
import { deleteSession, listSessions, loadSession, saveSession } from './data/store/sessionStore.js';
import { loadAlerts, saveAlerts } from './data/store/alertStore.js';
import { loadBots, saveBots } from './data/store/botStore.js';
import { clearBotAccount, listBotAccounts, loadBotAccount, saveBotAccount } from './data/store/botAccountStore.js';
import { applyTitleBarTheme } from './titlebar.js';
import { approveWindowClose } from './windowCloseGuard.js';

/** Datasets live outside the app bundle so an update never touches them. */
export function dataDir() {
  return path.join(app.getPath('userData'), 'market-data');
}

/** Results outlive the data they were computed from, so they live apart too. */
export function runsDir() {
  return path.join(app.getPath('userData'), 'backtests');
}

/**
 * Parameter sweeps.
 *
 * Their own folder rather than the run library, for the reason sweepStore gives: a run
 * is one account that can be opened and read trade by trade, a sweep is a few thousand
 * rows of summary with no account behind any of them.
 */
export function sweepsDir() {
  return path.join(app.getPath('userData'), 'sweeps');
}

/**
 * What each strategy is set to.
 *
 * Configuration, not results: it belongs to the strategy rather than to any one run, which
 * is why it sits beside the run library instead of in it. A backtest starts from these and
 * stores what it actually ran with.
 */
export function strategiesDir() {
  return path.join(app.getPath('userData'), 'strategies');
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

/**
 * Trading bots.
 *
 * Configuration, like the strategy settings above and for the same reason — a bot is which
 * strategy on which market with what permissions, not a result. What a bot has DONE goes
 * where every other traded account's history goes: the paper account, or the live journal.
 */
export function botsDir() {
  return path.join(app.getPath('userData'), 'bots');
}

/**
 * The durable state the bots are running.
 *
 * Apart from the definitions above, for the reason sessionStore is apart from the runs: one
 * is what a bot IS and is edited by hand, the other is working state rewritten a few times a
 * minute for weeks. Paper accounts, daily guards, and live venue ownership live here. A
 * FINISHED paper account goes onto the run shelf beside the backtest of the same strategy.
 */
export function botAccountsDir() {
  return path.join(app.getPath('userData'), 'bot-accounts');
}

/**
 * The paper account.
 *
 * Its own folder rather than a file among the sessions: a session is one
 * afternoon and there are many, this is one account that runs for months. It
 * also outlives the market data it traded on, which is why nothing here lives
 * under `market-data`.
 */
export function paperDir() {
  return path.join(app.getPath('userData'), 'paper-account');
}

/**
 * The live trading journal.
 *
 * Apart from the paper account and from the run library both: this is not one account that
 * can be reset, and not a shelf of finished experiments — it is the record of money that
 * actually moved, and the one thing here that cannot be reproduced by running something
 * again.
 */
export function liveTradesDir() {
  return path.join(app.getPath('userData'), 'live-trading');
}

/**
 * Broker credentials, encrypted by the OS.
 *
 * Its own folder, and nothing else goes in it: these are the keys to an account that holds
 * money, and a directory that holds only them is one whose permissions and backups can be
 * reasoned about on their own.
 */
export function credentialsDir() {
  return path.join(app.getPath('userData'), 'credentials');
}

/**
 * Put the stored Capital.com credentials into effect, falling back to the environment.
 *
 * What somebody typed into the app wins over `.env.local`: the file is a developer's way in
 * and the screen is everybody else's, and a stale variable silently overriding what the
 * settings page plainly shows would be the wrong way round. Called at startup and again
 * whenever the credentials change.
 */
export async function applyStoredCapitalCredentials() {
  const stored = await readSecret(credentialsDir(), 'capital').catch(() => null);
  if (stored?.apiKey && stored?.identifier && stored?.password) {
    configureCapital(stored);
    return { source: 'stored', env: stored.env };
  }
  configureCapital({
    apiKey: process.env.CAPITAL_API_KEY,
    identifier: process.env.CAPITAL_IDENTIFIER,
    password: process.env.CAPITAL_PASSWORD,
    env: process.env.CAPITAL_ENV,
  });
  return {
    source: process.env.CAPITAL_API_KEY ? 'env' : 'none',
    env: process.env.CAPITAL_ENV === 'live' ? 'live' : 'demo',
  };
}

/** Apply a stored Binance key, or the demo-only environment fallback. */
export async function applyStoredBinanceSpotCredentials() {
  const stored = await readSecret(credentialsDir(), 'binance-spot').catch(() => null);
  if (stored?.apiKey && stored?.secretKey) {
    configureBinanceSpot(stored);
    return { source: 'stored', env: 'demo' };
  }
  configureBinanceSpot({
    apiKey: process.env.BINANCE_DEMO_API_KEY,
    secretKey: process.env.BINANCE_DEMO_SECRET_KEY,
  });
  return {
    source: process.env.BINANCE_DEMO_API_KEY && process.env.BINANCE_DEMO_SECRET_KEY ? 'env' : 'none',
    env: 'demo',
  };
}

/**
 * Apply a stored Bybit key, or the one the environment supplies.
 *
 * The environment it belongs to is stored WITH it and never guessed. A demo key is issued by
 * a separate Bybit account and only works against the demo host, so a mismatch is not a
 * degraded connection — it is a refusal at the first call, which is the honest outcome.
 */
export async function applyStoredBybitCredentials() {
  const stored = await readSecret(credentialsDir(), 'bybit').catch(() => null);
  if (stored?.apiKey && stored?.secretKey) {
    configureBybit(stored);
    return { source: 'stored', env: stored.env === 'live' ? 'live' : 'demo' };
  }
  configureBybit({
    apiKey: process.env.BYBIT_API_KEY,
    secretKey: process.env.BYBIT_SECRET_KEY,
    env: process.env.BYBIT_ENV,
  });
  return {
    source: process.env.BYBIT_API_KEY && process.env.BYBIT_SECRET_KEY ? 'env' : 'none',
    env: process.env.BYBIT_ENV === 'live' ? 'live' : 'demo',
  };
}

/**
 * Apply a stored ProjectX key, or the one the environment supplies.
 *
 * `live` is stored with the key rather than derived, and defaults to false. It is not a data
 * setting: the gateway refuses the live side outright to an account that only has simulated
 * ones — contracts come back empty and bars answer errorCode 1 — so a wrong guess here does
 * not degrade the connection, it empties the chart. The `base` travels with it because
 * ProjectX is a gateway several firms sit behind, and a key issued by one is not recognised
 * by another's host.
 */
export async function applyStoredProjectXCredentials() {
  const stored = await readSecret(credentialsDir(), 'projectx').catch(() => null);
  if (stored?.userName && stored?.apiKey) {
    configureProjectX(stored);
    return { source: 'stored', live: stored.live === true };
  }
  configureProjectX({
    userName: process.env.PROJECTX_USERNAME,
    apiKey: process.env.PROJECTX_API_KEY,
    base: process.env.PROJECTX_BASE,
    hub: process.env.PROJECTX_HUB,
    live: process.env.PROJECTX_LIVE === 'true',
  });
  return {
    source: process.env.PROJECTX_USERNAME && process.env.PROJECTX_API_KEY ? 'env' : 'none',
    live: process.env.PROJECTX_LIVE === 'true',
  };
}

/**
 * Price alerts — set from the chart, checked against the live feed regardless of which
 * symbol is on screen, so they need somewhere durable of their own rather than riding
 * the workspace document (which is per-chart and does not persist across a symbol switch).
 */
export function alertsDir() {
  return path.join(app.getPath('userData'), 'alerts');
}

/**
 * The ways a person can trade a run by hand, and what the library calls each.
 *
 * Both go through `replay:save` because both end up on the same shelf as a backtest —
 * that is what makes the three comparable — but they are not the same thing and the
 * stored run has to say which it was.
 */
const HAND_TRADED = {
  replay: { strategy: 'replay', strategyName: 'Manual replay' },
  paper: { strategy: 'paper', strategyName: 'Paper trading' },
};

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

/**
 * A symbol that is safe to build a file name out of.
 *
 * An imported symbol is typed by hand, and the bar store spells its files
 * `<symbol>-1m.bin` — a name carrying a slash or a pair of dots would write outside the
 * data folder. Refused rather than sanitised: a dataset silently renamed is a dataset
 * nobody can find again.
 */
function requireSymbol(value) {
  const symbol = requireString(value, 'symbol').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
    throw new Error(
      `"${symbol}" cannot be a dataset name. Use letters, digits, dot, dash or underscore `
      + `— up to 32 characters, starting with a letter or a digit.`,
    );
  }
  return symbol;
}

/**
 * Fetches a range from a venue and merges it into the store.
 *
 * Shared by the explicit download and by the backtest's fetch-on-demand, so both refuse
 * the same way and both report progress on the same channel.
 *
 * A dataset belongs to the venue that created it: BTCUSDT on one venue and BTCUSDT on
 * another are different markets with different prints, and merging them would produce a
 * chart of a market that does not exist. The refusal is loud rather than clever — the
 * user picks a different source, or deletes the dataset first.
 */
async function downloadInto(event, venue, symbol, fromDate, toDate) {
  const existing = await readMeta(dataDir(), symbol);
  if (existing?.source && existing.source !== venue.id) {
    throw new Error(
      `${symbol} was downloaded from ${existing.source}. Two venues' prints are two `
      + `different markets and must not be merged — download it under a different `
      + `name, or remove the existing dataset first.`,
    );
  }

  const sender = BrowserWindow.fromWebContents(event.sender);
  const progress = (p) => sender?.webContents.send('data:download-progress', {
    symbol, source: venue.id, ...p,
  });

  const { bars, missing } = await venue.module.downloadRange(symbol, fromDate, toDate, '1m', progress);
  if (bars.length === 0) {
    throw new Error(
      `${venue.label} returned no bars for ${symbol} between ${fromDate.toISOString().slice(0, 10)} `
      + `and ${toDate.toISOString().slice(0, 10)}. Check the spelling — ${venue.label} writes `
      + `this market as e.g. ${venue.example}.`,
    );
  }

  const result = await mergeBars(dataDir(), symbol, bars, { source: venue.id });
  return { ...result, missing, source: venue.id };
}

/** How much of a file the picker reads to work out its shape. Enough for the header and
 *  a few dozen rows; a market CSV can be sixty megabytes and none of that is needed to
 *  decide which column is the close. */
const CSV_HEAD_BYTES = 64 * 1024;

/**
 * What the import dialog needs to show a file: its size, everything the sniffer believes
 * about it, and the first few rows parsed under exactly the settings the import will use.
 *
 * That last part is what makes the dialog worth having. A date style or a time zone is
 * impossible to check by reading a column of `12/26/2022 18:01` — it is only visible in
 * what those characters turn INTO, so the preview is produced by the same parser the
 * import runs, rather than by a second, friendlier one that could disagree with it.
 *
 * Only the head is read. Its last line is usually cut in half, so it is dropped rather
 * than shown as a row with three columns — a truncated sample would make the delimiter
 * look wrong on a file that is fine.
 */
async function inspectCsv(file, settings = {}) {
  const info = await stat(file);
  const handle = await open(file, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(Math.min(CSV_HEAD_BYTES, Math.max(info.size, 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead < info.size) {
      const cut = head.lastIndexOf('\n');
      if (cut > 0) head = head.slice(0, cut + 1);
    }
  } finally {
    await handle.close();
  }

  const sniffed = sniffCsv(head, { delimiter: settings.delimiter, hasHeader: settings.hasHeader });
  const mapping = settings.mapping ?? sniffed.mapping;
  const dateStyle = settings.dateStyle ?? sniffed.dateStyle;
  const timeZone = settings.timeZone ?? 'UTC';

  /* A preview that cannot be produced is not a failure of the file — it is what the
   * dialog exists to show. The message goes back beside the empty preview so the reason
   * is on screen instead of in a rejected promise. */
  let preview = [];
  let previewError = null;
  try {
    const parsed = parseMarketCsv(head, {
      delimiter: sniffed.delimiter, hasHeader: sniffed.hasHeader, mapping, dateStyle, timeZone,
    });
    preview = parsed.bars.slice(0, 5);
  } catch (err) {
    previewError = err instanceof Error ? err.message : String(err);
  }

  return {
    file,
    name: path.basename(file),
    bytes: info.size,
    /** The clocks a written-out timestamp can be on. Sent with the file so the dialog
     *  has one round trip, not two. */
    timeZones: CSV_TIME_ZONES,
    ...sniffed,
    mapping,
    dateStyle,
    timeZone,
    missing: missingFields(mapping),
    preview,
    previewError,
  };
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

    return downloadInto(event, venue, sym, fromDate, toDate);
  });

  /* Everything a backtest needs for one range, fetched only where the archive does not
   * already have it.
   *
   * The other half of "run this strategy on Binance data": the tab asks for a market and
   * a stretch of history, and whatever is missing at either end is downloaded before the
   * run starts. Downloading rather than streaming past the engine on purpose — the bars
   * are worth keeping. A second run over the same range costs nothing, the chart can be
   * pointed at exactly what was tested, and the run stays reproducible after the venue
   * has rewritten its own history.
   *
   * Only the ends are filled. A hole in the middle of a stored range cannot be seen from
   * the metadata (which carries the first and last bar, not the gaps), and probing for
   * one would mean reading the whole dataset on every run. A venue that was missing a
   * month reports it under `missing` when the range is first fetched.
   */
  ipcMain.handle('data:ensure', async (event, request) => {
    const { symbol, from, to, source = DEFAULT_SOURCE } = request ?? {};
    const sym = requireString(symbol, 'symbol').toUpperCase();
    const venue = sourceOf(requireString(source, 'source'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('from and to must be timestamps in milliseconds');
    }
    if (from >= to) throw new Error('The range has to end after it starts');

    const before = await readMeta(dataDir(), sym);
    const gaps = [];
    if (!before || before.first == null || before.last == null) {
      gaps.push([from, to]);
    } else {
      if (from < before.first) gaps.push([from, Math.min(to, before.first)]);
      if (to > before.last) gaps.push([Math.max(from, before.last), to]);
    }

    const missing = [];
    let added = 0;
    for (const [gapFrom, gapTo] of gaps) {
      const result = await downloadInto(event, venue, sym, new Date(gapFrom), new Date(gapTo));
      added += result.added;
      missing.push(...result.missing);
    }

    const meta = await readMeta(dataDir(), sym);
    return {
      symbol: sym,
      source: venue.id,
      /** How many bars this call had to fetch — zero when the archive already had it. */
      added,
      total: meta?.count ?? 0,
      first: meta?.first ?? null,
      last: meta?.last ?? null,
      missing,
    };
  });

  /* ─── Importing a CSV ────────────────────────────────────────────────── *
   *
   * The other way bars get in. A file from a data vendor or a broker knows nothing about
   * this app, so it arrives in two steps: the picker reads its head and reports what it
   * believes about it, and the import runs under whatever the dialog came back with.
   *
   * Splitting it is the whole point. A day-first file read as month-first produces a
   * dataset that looks entirely normal and is wrong about every date after the twelfth
   * of a month — so the reading is shown and confirmed before a million rows are parsed
   * under it, rather than discovered later on a chart that makes no sense.
   */

  /* Several files at once, because a large export usually arrives as one. The NQ set
   * this was built against is eleven parts of a single series, each with its own header
   * row — importing those one at a time is eleven passes through the same dialog to
   * answer the same questions. The first file is the one inspected; the rest are read
   * under whatever it settles on, and any row that disagrees is counted as skipped
   * rather than guessed at. */
  ipcMain.handle('data:pick-csv', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import market data',
      buttonLabel: 'Read',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Market data', extensions: ['csv', 'txt', 'tsv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled || filePaths.length === 0) return null;

    // Sorted, so `part_002` follows `part_001` however the picker handed them over.
    const files = [...filePaths].sort((a, b) => a.localeCompare(b));
    return { ...await inspectCsv(files[0]), files };
  });

  /** Re-reads a file the picker already returned, under whatever the dialog has
   *  corrected so far — the delimiter, the columns, the date style, the clock. */
  ipcMain.handle('data:inspect-csv', (_e, request) => {
    const { file, ...settings } = request ?? {};
    return inspectCsv(requireString(file, 'file'), settings);
  });

  ipcMain.handle('data:import-csv', async (_e, request) => {
    const {
      file, files, symbol, delimiter, hasHeader, mapping, dateStyle, timeZone = 'UTC',
    } = request ?? {};

    const sources = (Array.isArray(files) && files.length > 0 ? files : [file])
      .map((f) => requireString(f, 'file'));
    const sym = requireSymbol(symbol);
    if (!mapping || typeof mapping !== 'object') throw new Error('The columns are not mapped');

    /* Every part read under the same settings, then treated as one series. The bar length
     * is decided over the whole thing rather than per file: a part that happens to start
     * after a weekend would otherwise report a three-day bar. */
    const bars = [];
    let skipped = 0;
    let rows = 0;
    let firstError = null;

    for (const source of sources) {
      const text = await readFile(source, 'utf8');
      const part = parseMarketCsv(text, { delimiter, hasHeader, mapping, dateStyle, timeZone });
      bars.push(...part.bars);
      skipped += part.skipped;
      rows += part.rows;
      firstError ??= part.firstError;
    }

    bars.sort((a, b) => a.time - b.time);
    const parsed = { bars, skipped, rows, firstError, intervalMs: dominantInterval(bars) };

    if (!parsed.intervalMs) {
      throw new Error(
        'The timestamps in this file do not settle on one bar length. The store buckets '
        + 'every timeframe up from a fixed base bar, which an irregular series has none of.',
      );
    }

    /* A dataset is one market recorded one way. Adding a file to something downloaded
     * from a venue, or to an import with a different bar length, produces a series whose
     * bars mean two different things — refused rather than merged. */
    const existing = await readMeta(dataDir(), sym);
    if (existing) {
      if (existing.source && existing.source !== 'csv') {
        throw new Error(
          `${sym} already holds data downloaded from ${existing.source}. Import this file `
          + `under a different name, or remove that dataset first.`,
        );
      }
      const existingBase = Number.isFinite(existing.baseMs) ? existing.baseMs : 60_000;
      if (existingBase !== parsed.intervalMs) {
        throw new Error(
          `${sym} is stored as ${describeMs(existingBase)} bars and this file holds `
          + `${describeMs(parsed.intervalMs)} bars. Import it under a different name.`,
        );
      }
    }

    const merged = await mergeBars(dataDir(), sym, parsed.bars, {
      source: 'csv',
      baseMs: parsed.intervalMs,
      /* What one stored bar actually is. Everything downloaded is a minute and says so;
       * an import says what the file carried, so the library never claims an hourly
       * dataset is minute data. */
      timeframe: describeMs(parsed.intervalMs),
      importedFrom: sources.length === 1
        ? path.basename(sources[0])
        : `${path.basename(sources[0])} + ${sources.length - 1} more`,
      importedAt: new Date().toISOString(),
    });

    return {
      ...merged,
      symbol: sym,
      timeframe: describeMs(parsed.intervalMs),
      intervalMs: parsed.intervalMs,
      /** Rows that could not be read as a bar. A handful is a footer or a blank price;
       *  half the file is the wrong delimiter, and the caller has to be able to tell. */
      skipped: parsed.skipped,
      rows: parsed.rows,
      firstError: parsed.firstError,
      files: sources.length,
    };
  });

  /* What every "remove that dataset first" refusal in here points at. Deliberately
   * unguarded by a confirmation of its own: the renderer arms its own button, and a
   * handler that asked again would be a second dialog nobody can see the first of. */
  ipcMain.handle('data:delete', (_e, symbol) => (
    deleteDataset(dataDir(), requireSymbol(symbol))
  ));

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
    const { symbol, timeframe, note = '', source = 'replay', ...result } = request ?? {};

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

    /* What actually traded it. The library is read to compare one way of trading
     * against another, so a run that says how it was produced is the whole point of
     * having a label — and a paper account filed as "Manual replay" would be the one
     * row in it nobody could trust. A fixed vocabulary rather than a free string: the
     * label goes into the index every list reads. */
    const hand = HAND_TRADED[source];
    if (!hand) throw new Error(`replay:save: unknown source "${source}"`);

    return saveRun(runsDir(), {
      ...result,
      ...hand,
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

  /* A backtest is run in the renderer, not here.
   *
   * Not for the reason a replay is — nobody is clicking — but because the detectors a
   * strategy is built on live in the chart core, in TypeScript, and this process runs
   * plain JavaScript straight off disk. Importing them here is not possible without a
   * build step for the main process, and duplicating them is how the chart and the
   * backtest end up disagreeing about the same market.
   *
   * So the renderer already has the bars it fetched through `data:bars`, runs the loop
   * on them, and sends the finished result here for the same shelf a replay lands on.
   */
  ipcMain.handle('backtest:save', async (_e, request) => {
    const {
      strategy, strategyName, params = {}, symbol, timeframe, note = '', ...result
    } = request ?? {};

    requireString(strategy, 'strategy');
    requireString(strategyName, 'strategyName');
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);

    /* The hand-traded labels are a fixed vocabulary and belong to `replay:save`. A
     * backtest filed as "Manual replay" would be the one row in the library nobody
     * could trust. */
    if (HAND_TRADED[strategy]) {
      throw new Error(`backtest:save: "${strategy}" is reserved for hand-traded runs`);
    }
    if (!result.stats || !Array.isArray(result.trades)) {
      throw new Error('backtest:save: the run has no result to store');
    }
    if (!Number.isFinite(result.from) || !Number.isFinite(result.to)) {
      throw new Error('backtest:save: the run has no range');
    }

    return saveRun(runsDir(), {
      ...result,
      strategy,
      strategyName,
      /* The resolved settings, not the ones the form held: a stored run has to say what
       * it actually ran with, including every default that was filled in. */
      params,
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

  /* The run library — one shelf for everything that finished, whoever traded
   * it. `replay:save` above puts sessions on it; a backtest will put its runs
   * on the same one. Reading is separate from writing because the reader is a
   * different screen and outlives any one session.
   *
   * The list is summaries only (that is what the index holds); the full run,
   * with its trades and equity curve, is fetched for the one being looked at.
   */
  ipcMain.handle('runs:list', () => listRuns(runsDir()));

  ipcMain.handle('runs:load', (_e, id) => loadRun(runsDir(), requireString(id, 'id')));

  ipcMain.handle('runs:delete', (_e, id) => deleteRun(runsDir(), requireString(id, 'id')));

  ipcMain.handle('runs:annotate', (_e, id, note) => (
    annotateRun(runsDir(), requireString(id, 'id'), typeof note === 'string' ? note : '')
  ));

  /* ─── Strategy settings ─────────────────────────────────────────────── *
   *
   * The values live here; what they MEAN lives in the renderer, where the schema is. So
   * nothing is validated on the way in beyond its shape — a build that renames a parameter
   * would otherwise be met with a file it refuses to read, and the renderer resolves what
   * it reads against the current schema anyway.
   */
  ipcMain.handle('strategies:load', () => loadStrategySettings(strategiesDir()));

  ipcMain.handle('strategies:save', (_e, id, params) => (
    saveStrategySettings(strategiesDir(), requireString(id, 'id'), params)
  ));

  ipcMain.handle('strategies:reset', (_e, id) => (
    clearStrategySettings(strategiesDir(), requireString(id, 'id'))
  ));

  /* ─── Parameter sweeps ──────────────────────────────────────────────── *
   *
   * Their own shelf, next to the runs rather than on them. A sweep is a ranking of a few
   * thousand settings, none of which has an account behind it; a run is one account with
   * its trades. Both are read to answer "did this way of trading work", which is why
   * they sit side by side on the Analysis screen — and why they are not the same list.
   *
   * Like a backtest, a sweep is computed in the renderer, where the detectors live. Only
   * the finished ranking crosses the bridge.
   */
  ipcMain.handle('sweep:save', async (_e, request) => {
    const { strategy, strategyName, symbol, timeframe, note = '', ...sweep } = request ?? {};

    requireString(strategy, 'strategy');
    requireString(strategyName, 'strategyName');
    requireString(symbol, 'symbol');
    requireTimeframe(timeframe);
    if (!Number.isFinite(sweep.from) || !Number.isFinite(sweep.to)) {
      throw new Error('sweep:save: the sweep has no range');
    }

    return saveSweep(sweepsDir(), {
      ...sweep,
      strategy,
      strategyName,
      symbol,
      timeframe,
      note: typeof note === 'string' ? note.slice(0, 2000) : '',
    });
  });

  ipcMain.handle('sweep:list', () => listSweeps(sweepsDir()));

  ipcMain.handle('sweep:load', (_e, id) => loadSweep(sweepsDir(), requireString(id, 'id')));

  ipcMain.handle('sweep:delete', (_e, id) => deleteSweep(sweepsDir(), requireString(id, 'id')));

  ipcMain.handle('sweep:annotate', (_e, id, note) => (
    annotateSweep(sweepsDir(), requireString(id, 'id'), typeof note === 'string' ? note : '')
  ));

  /* ─── The paper account ─────────────────────────────────────────────── *
   *
   * One record, read once when the mode is switched on and written whenever
   * the account moves — a few times a minute for as long as it runs. It is a
   * working account rather than a result, so it stays out of the run library
   * until it is finished; `replay:save` above is where a finished one goes,
   * which is how starting over does not mean throwing weeks away.
   */
  ipcMain.handle('paper:load', () => loadAccount(paperDir()));

  ipcMain.handle('paper:save', (_e, account) => {
    const { symbol, session } = account ?? {};
    requireString(symbol, 'symbol');
    if (!session || !session.broker) {
      throw new Error('paper:save: this is not an account snapshot');
    }
    return saveAccount(paperDir(), { symbol, session });
  });

  ipcMain.handle('paper:clear', () => clearAccount(paperDir()));

  /* ─── Price alerts ───────────────────────────────────────────────────── *
   *
   * One flat list, read once at startup and rewritten whenever it changes — an alert
   * is either pending or fired-and-done, there is no history to browse, so the whole
   * list round-trips instead of a per-alert CRUD surface.
   */
  ipcMain.handle('alerts:load', () => loadAlerts(alertsDir()));

  ipcMain.handle('alerts:save', (_e, alerts) => {
    if (!Array.isArray(alerts)) throw new Error('alerts:save: expected an array');
    return saveAlerts(alertsDir(), alerts);
  });

  /* ─── Trading bots ───────────────────────────────────────────────────── *
   *
   * The definitions only, round-tripped whole like the alerts above: a handful of small
   * records, edited on one screen, with no history to browse. A bot's live state is not
   * here on purpose — see app/electron/data/store/botStore.js.
   *
   * Nothing is validated beyond an id and a strategy name. What the settings MEAN lives in
   * the renderer, where the schema is, and the renderer resolves what it reads against the
   * current one — the same rule the strategy settings follow.
   */
  ipcMain.handle('bots:load', () => loadBots(botsDir()));

  ipcMain.handle('bots:save', (_e, bots) => {
    if (!Array.isArray(bots)) throw new Error('bots:save: expected an array');
    return saveBots(botsDir(), bots);
  });

  /* A bot's own durable runtime, keyed by the bot it belongs to. Paper accounts, daily
   * guards, and live venue ownership are written here whenever they move. */
  ipcMain.handle('botAccount:load', (_e, id) => loadBotAccount(botAccountsDir(), requireString(id, 'id')));

  ipcMain.handle('botAccount:save', (_e, id, account) => (
    saveBotAccount(botAccountsDir(), requireString(id, 'id'), account ?? {})
  ));

  ipcMain.handle('botAccount:clear', (_e, id) => clearBotAccount(botAccountsDir(), requireString(id, 'id')));

  /* Accounts whose bot is gone. Deleting a bot takes its account with it, so this only ever
   * finds one left behind by a crash between the two writes — but left alone it would sit
   * there for good, and it carries an account's worth of trades. */
  ipcMain.handle('botAccount:sweep', async (_e, keep) => {
    if (!Array.isArray(keep)) throw new Error('botAccount:sweep: expected the list of bot ids to keep');
    const alive = new Set(keep.filter((id) => typeof id === 'string'));
    const stored = await listBotAccounts(botAccountsDir());
    let removed = 0;
    for (const id of stored) {
      if (alive.has(id)) continue;
      await clearBotAccount(botAccountsDir(), id);
      removed += 1;
    }
    return { removed };
  });

  /* ─── App theme + the custom title bar ─────────────────────────────── */

  /* Purely cosmetic: the renderer already re-themes itself (chart, chrome,
   * dialogs) on its own. This just keeps the OS window's paint colour from
   * flashing the old theme's colour on the next resize. */
  ipcMain.handle('ui:set-theme', (event, theme, background) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error(`Unknown theme "${theme}"`);
    return applyTitleBarTheme(BrowserWindow.fromWebContents(event.sender), theme, background);
  });

  /* The title bar is drawn by the renderer (app-topbar) — these are what its
   * own minimize/maximize/close buttons call, since a renderer cannot touch
   * a BrowserWindow directly. */
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.on('window:close-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    approveWindowClose(win);
  });

  /* A triggered price alert calls this from its notification's click handler — the
   * window may be minimized (or merely behind others), and a renderer cannot restore
   * or focus its own BrowserWindow directly. */
  ipcMain.on('window:restore', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  ipcMain.handle('window:is-maximized', (event) => (
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  ));

  /* ─── Capital.com (forex/CFD live data) ─────────────────────────────── */

  /* The session itself (login, keepalive, the WebSocket) lives in
   * data/capital.js, entirely in this process — see that file for why. This is
   * just the thin bridge CapitalProvider (app/renderer/providers) calls through.
   */
  ipcMain.handle('capital:configured', () => capitalConfigured());

  ipcMain.handle('capital:environment', () => capitalEnvironment());

  ipcMain.handle('capital:markets', (_e, searchTerm) => capitalMarkets(searchTerm || undefined));

  ipcMain.handle('capital:market-info', (_e, epic) => capitalMarketInfo(requireString(epic, 'epic')));

  ipcMain.handle('capital:prices', (_e, { epic, resolution, from, to, limit } = {}) => (
    capitalPrices(requireString(epic, 'epic'), requireString(resolution, 'resolution'), { from, to, limit })
  ));

  /* One subscription per call, keyed by an opaque id the renderer hands back to
   * unsubscribe — capitalSubscribe itself shares the underlying WS slot when the
   * same epic/resolution is already subscribed elsewhere. */
  const capitalSubs = new Map();

  /**
   * Hold a subscription until the renderer drops it — or until its window does.
   *
   * A window that goes without unsubscribing (closed, reloaded, crashed) would hold its
   * slot for the life of the process, and the venue allows forty of them. So the release is
   * registered against the window as well, and is written to be safe to run twice: whichever
   * of the two gets there first takes the id out of the registry, and the other finds it
   * gone and does nothing.
   */
  function holdSubscription(registry, sender, id, unsubscribe) {
    const release = () => {
      if (!registry.delete(id)) return;
      sender.off('destroyed', release);
      unsubscribe();
    };
    registry.set(id, release);
    sender.once('destroyed', release);
  }

  ipcMain.handle('capital:subscribe', async (event, { epic, resolution } = {}) => {
    const id = randomUUID();
    const sender = event.sender;
    const unsubscribe = await capitalSubscribe(requireString(epic, 'epic'), requireString(resolution, 'resolution'), (bar) => {
      if (!sender.isDestroyed()) sender.send('capital:ohlc', { subscriptionId: id, bar });
    });
    // The window can have gone while the venue was answering, and a 'destroyed' that has
    // already fired will not fire again — so nothing would ever release this one.
    if (sender.isDestroyed()) unsubscribe();
    else holdSubscription(capitalSubs, sender, id, unsubscribe);
    return id;
  });

  ipcMain.handle('capital:unsubscribe', (_e, id) => { capitalSubs.get(id)?.(); });

  /* The tick stream, on the same shape as the candle one above. */
  const capitalQuoteSubs = new Map();

  ipcMain.handle('capital:subscribe-quotes', async (event, { epic } = {}) => {
    const id = randomUUID();
    const sender = event.sender;
    const unsubscribe = await capitalSubscribeQuotes(requireString(epic, 'epic'), (quote) => {
      if (!sender.isDestroyed()) sender.send('capital:quote', { subscriptionId: id, quote });
    });
    if (sender.isDestroyed()) unsubscribe();
    else holdSubscription(capitalQuoteSubs, sender, id, unsubscribe);
    return id;
  });

  ipcMain.handle('capital:unsubscribe-quotes', (_e, id) => { capitalQuoteSubs.get(id)?.(); });

  /* ─── ProjectX (futures live data) ──────────────────────────────────── */

  /* The session, the SignalR socket and the tick-to-bar aggregation live in
   * data/projectx.js, in this process — see that file for why the forming bar is
   * built here rather than read off the wire. This is the bridge ProjectXProvider
   * calls through.
   */
  ipcMain.handle('projectx:configured', () => projectXConfigured());

  ipcMain.handle('projectx:environment', () => projectXEnvironment());

  ipcMain.handle('projectx:accounts', (_e, onlyActive) => projectXAccounts(onlyActive !== false));

  ipcMain.handle('projectx:contracts', (_e, searchText) => projectXContracts(requireString(searchText, 'searchText')));

  ipcMain.handle('projectx:bars', (_e, { contractId, timeframe, from, to, limit } = {}) => (
    projectXBars(requireString(contractId, 'contractId'), requireString(timeframe, 'timeframe'), { from, to, limit })
  ));

  /* Same shape as the Capital.com feeds above: one subscription per call, keyed by an
   * opaque id, with the underlying hub subscription shared when two panes want the same
   * contract. */
  const projectXSubs = new Map();

  ipcMain.handle('projectx:subscribe', async (event, { contractId, timeframe } = {}) => {
    const id = randomUUID();
    const sender = event.sender;
    const unsubscribe = await projectXSubscribe(
      requireString(contractId, 'contractId'),
      requireString(timeframe, 'timeframe'),
      (bar) => { if (!sender.isDestroyed()) sender.send('projectx:bar', { subscriptionId: id, bar }); },
    );
    // The window can have gone while the seed was fetching, and a 'destroyed' that has
    // already fired will not fire again — so nothing would ever release this one.
    if (sender.isDestroyed()) unsubscribe();
    else holdSubscription(projectXSubs, sender, id, unsubscribe);
    return id;
  });

  ipcMain.handle('projectx:unsubscribe', (_e, id) => { projectXSubs.get(id)?.(); });

  const projectXQuoteSubs = new Map();

  ipcMain.handle('projectx:subscribe-quotes', async (event, { contractId } = {}) => {
    const id = randomUUID();
    const sender = event.sender;
    const unsubscribe = await projectXSubscribeQuotes(
      requireString(contractId, 'contractId'),
      (quote) => { if (!sender.isDestroyed()) sender.send('projectx:quote', { subscriptionId: id, quote }); },
    );
    if (sender.isDestroyed()) unsubscribe();
    else holdSubscription(projectXQuoteSubs, sender, id, unsubscribe);
    return id;
  });

  ipcMain.handle('projectx:unsubscribe-quotes', (_e, id) => { projectXQuoteSubs.get(id)?.(); });

  /* ─── Capital.com trading ────────────────────────────────────────────
   *
   * The channels that move money. Everything crossing here is checked rather
   * than forwarded: the renderer builds these payloads from a form, and a field
   * that arrives as a string, a NaN or an unbounded number must be refused at
   * this boundary and not by the venue — the venue's refusal costs a round trip
   * and arrives as a code nobody asked for.
   */

  ipcMain.handle('capital:account', () => capitalAccount());

  ipcMain.handle('capital:positions', () => capitalPositions());

  ipcMain.handle('capital:open-position', (_e, spec = {}) => capitalOpenPosition({
    epic: requireString(spec.epic, 'epic'),
    direction: requireDirection(spec.direction),
    size: requireSize(spec.size),
    ...optionalLevels(spec),
  }));

  ipcMain.handle('capital:amend-position', (_e, { dealId, ...levels } = {}) => capitalAmendPosition(
    requireString(dealId, 'dealId'),
    /* A level given as null is an instruction to REMOVE it, so it has to survive the
     * filter that drops the fields nobody mentioned — see `optionalLevels`. */
    optionalLevels(levels, { keepNull: true }),
  ));

  ipcMain.handle('capital:close-position', (_e, dealId) => capitalClosePosition(requireString(dealId, 'dealId')));

  ipcMain.handle('capital:working-orders', () => capitalWorkingOrders());

  ipcMain.handle('capital:create-order', (_e, spec = {}) => capitalCreateOrder({
    epic: requireString(spec.epic, 'epic'),
    direction: requireDirection(spec.direction),
    size: requireSize(spec.size),
    type: requireOrderType(spec.type),
    level: requireLevel(spec.level, 'level'),
    ...optionalLevels(spec),
  }));

  ipcMain.handle('capital:amend-order', (_e, { dealId, level, ...levels } = {}) => capitalAmendOrder(
    requireString(dealId, 'dealId'),
    {
      ...(level == null ? {} : { level: requireLevel(level, 'level') }),
      ...optionalLevels(levels, { keepNull: true }),
    },
  ));

  ipcMain.handle('capital:cancel-order', (_e, dealId) => capitalCancelOrder(requireString(dealId, 'dealId')));

  /* ─── Binance Spot Demo trading ──────────────────────────────────────
   *
   * No handler accepts an endpoint or environment. The client beneath these channels is
   * fixed to the demo host, so a renderer payload cannot turn a demo instruction into a
   * production one.
   */
  const spotSymbol = (value) => {
    const symbol = requireString(value, 'symbol').toUpperCase();
    if (!/^[A-Z0-9]{5,30}$/.test(symbol) || symbol.endsWith('.P')) {
      throw new Error('A Binance Spot symbol such as BTCUSDT is required.');
    }
    return symbol;
  };
  const spotSide = (value) => {
    const side = requireString(value, 'side').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') throw new Error('side must be BUY or SELL');
    return side;
  };
  const spotType = (value) => {
    const type = requireString(value ?? 'MARKET', 'type').toUpperCase();
    if (!['MARKET', 'LIMIT', 'STOP_LOSS'].includes(type)) throw new Error('Unsupported Spot order type');
    return type;
  };
  const spotLevels = (value = {}) => ({
    ...(value.stopLoss == null ? {} : { stopLoss: requireLevel(value.stopLoss, 'stopLoss') }),
    ...(value.takeProfit == null ? {} : { takeProfit: requireLevel(value.takeProfit, 'takeProfit') }),
  });

  ipcMain.handle('binance-spot:environment', () => binanceSpotEnvironment());
  ipcMain.handle('binance-spot:symbol-info', (_e, symbol) => binanceSpotSymbolInfo(spotSymbol(symbol)));
  ipcMain.handle('binance-spot:account', () => binanceSpotAccount());
  ipcMain.handle('binance-spot:open-orders', (_e, symbol) => binanceSpotOpenOrders(spotSymbol(symbol)));
  ipcMain.handle('binance-spot:trades', (_e, symbol) => binanceSpotTrades(spotSymbol(symbol)));
  ipcMain.handle('binance-spot:place-order', (_e, spec = {}) => binanceSpotPlaceOrder({
    symbol: spotSymbol(spec.symbol),
    side: spotSide(spec.side),
    type: spotType(spec.type),
    quantity: requireSize(spec.quantity),
    ...(spec.price == null ? {} : { price: requireLevel(spec.price, 'price') }),
    ...(spec.stopPrice == null ? {} : { stopPrice: requireLevel(spec.stopPrice, 'stopPrice') }),
    ...(spec.bracket == null ? {} : { bracket: spotLevels(spec.bracket) }),
  }));
  ipcMain.handle('binance-spot:cancel-order', (_e, { symbol, orderId } = {}) => binanceSpotCancelOrder(
    spotSymbol(symbol), requireSize(orderId),
  ));
  ipcMain.handle('binance-spot:cancel-all', (_e, symbol) => binanceSpotCancelAll(spotSymbol(symbol)));
  ipcMain.handle('binance-spot:replace-protection', (_e, spec = {}) => binanceSpotReplaceProtection({
    symbol: spotSymbol(spec.symbol),
    quantity: requireSize(spec.quantity),
    orders: Array.isArray(spec.orders) ? spec.orders.map((row) => ({
      orderId: requireSize(row?.orderId),
      orderListId: Number.isFinite(Number(row?.orderListId)) ? Number(row.orderListId) : -1,
    })) : [],
    ...spotLevels(spec),
  }));
  ipcMain.handle('binance-spot:close', (_e, symbol) => binanceSpotClose(spotSymbol(symbol)));

  /* ─── Bybit trading ──────────────────────────────────────────────────
   *
   * Spot and USDT perpetuals through one set of channels, because the venue is one API and
   * the category is a parameter of it. No handler accepts a host: which one the credentials
   * reach is stored with them, so a renderer payload cannot turn a demo instruction into a
   * live one.
   */
  const bybitSymbol = (value) => {
    const symbol = requireString(value, 'symbol').toUpperCase();
    if (!/^[A-Z0-9]{5,30}$/.test(symbol)) throw new Error('A Bybit symbol such as BTCUSDT is required.');
    return symbol;
  };
  const bybitSide = (value) => {
    const side = requireString(value, 'side').toLowerCase();
    if (side !== 'buy' && side !== 'sell') throw new Error('side must be Buy or Sell');
    return side === 'buy' ? 'Buy' : 'Sell';
  };
  const bybitType = (value) => {
    const type = requireString(value ?? 'Market', 'type').toLowerCase();
    if (type !== 'market' && type !== 'limit') throw new Error('Bybit takes Market and Limit orders only.');
    return type === 'limit' ? 'Limit' : 'Market';
  };
  const bybitLevels = (value = {}) => ({
    ...(value.stopLoss == null ? {} : { stopLoss: requireLevel(value.stopLoss, 'stopLoss') }),
    ...(value.takeProfit == null ? {} : { takeProfit: requireLevel(value.takeProfit, 'takeProfit') }),
  });

  ipcMain.handle('bybit:environment', () => bybitEnvironment());
  ipcMain.handle('bybit:instrument', (_e, { category, symbol } = {}) => (
    bybitInstrument(bybitCategory(category), bybitSymbol(symbol))
  ));
  /* Public candles, for the chart provider. Unsigned and served from the live host whichever
   * account is connected — Bybit's demo module has no price history of its own. */
  ipcMain.handle('bybit:klines', (_e, { category, symbol, interval, start, end, limit } = {}) => bybitKlines({
    category: bybitCategory(category),
    symbol: bybitSymbol(symbol),
    interval: requireString(interval, 'interval'),
    ...(start == null ? {} : { start }),
    ...(end == null ? {} : { end }),
    ...(limit == null ? {} : { limit }),
  }));
  ipcMain.handle('bybit:wallet', () => bybitWallet());
  ipcMain.handle('bybit:positions', (_e, symbol) => bybitPositions(bybitSymbol(symbol)));
  ipcMain.handle('bybit:open-orders', (_e, { category, symbol } = {}) => (
    bybitOpenOrders(bybitCategory(category), bybitSymbol(symbol))
  ));
  ipcMain.handle('bybit:executions', (_e, { category, symbol } = {}) => (
    bybitExecutions(bybitCategory(category), bybitSymbol(symbol))
  ));
  ipcMain.handle('bybit:place-order', (_e, spec = {}) => bybitPlaceOrder({
    category: bybitCategory(spec.category),
    symbol: bybitSymbol(spec.symbol),
    side: bybitSide(spec.side),
    type: bybitType(spec.type),
    qty: requireSize(spec.qty),
    ...(spec.price == null ? {} : { price: requireLevel(spec.price, 'price') }),
    ...(spec.triggerPrice == null ? {} : { triggerPrice: requireLevel(spec.triggerPrice, 'triggerPrice') }),
    ...(spec.reference == null ? {} : { reference: requireLevel(spec.reference, 'reference') }),
    ...(spec.reduceOnly === true ? { reduceOnly: true } : {}),
    ...(spec.bracket == null ? {} : { bracket: bybitLevels(spec.bracket) }),
  }));
  ipcMain.handle('bybit:cancel-order', (_e, { category, symbol, orderId, orderFilter } = {}) => bybitCancelOrder({
    category: bybitCategory(category),
    symbol: bybitSymbol(symbol),
    orderId: requireString(orderId, 'orderId'),
    ...(orderFilter == null ? {} : { orderFilter: requireString(orderFilter, 'orderFilter') }),
  }));
  ipcMain.handle('bybit:cancel-all', (_e, { category, symbol } = {}) => (
    bybitCancelAll(bybitCategory(category), bybitSymbol(symbol))
  ));
  ipcMain.handle('bybit:set-protection', (_e, spec = {}) => bybitSetProtection({
    category: bybitCategory(spec.category),
    symbol: bybitSymbol(spec.symbol),
    ...(spec.quantity == null ? {} : { quantity: requireSize(spec.quantity) }),
    orders: Array.isArray(spec.orders) ? spec.orders.map((id) => requireString(id, 'orderId')) : [],
    ...bybitLevels(spec),
  }));
  ipcMain.handle('bybit:close', (_e, { category, symbol } = {}) => (
    bybitClose(bybitCategory(category), bybitSymbol(symbol))
  ));

  /* ─── Broker credentials ─────────────────────────────────────────────
   *
   * The secret goes IN and never comes back out: `status` says whether one is
   * stored and which account it names, and there is no channel that returns the
   * key or the password. A screen that edits credentials does not need to read
   * them, so nothing here can put them on a screen or in a log.
   */

  ipcMain.handle('capital:credentials-status', async () => {
    const stored = await readPublic(credentialsDir(), 'capital');
    return {
      ...stored,
      encryptionAvailable: encryptionAvailable(),
      /* Whether a .env.local is currently supplying credentials — worth showing, because
       * it explains a connection that works with nothing stored. */
      envPresent: !!(process.env.CAPITAL_API_KEY && process.env.CAPITAL_IDENTIFIER && process.env.CAPITAL_PASSWORD),
    };
  });

  /** Try credentials WITHOUT storing them, and answer with the accounts they reach. */
  ipcMain.handle('capital:credentials-test', (_e, { apiKey, identifier, password, env } = {}) => capitalProbe({
    apiKey: requireString(apiKey, 'apiKey'),
    identifier: requireString(identifier, 'identifier'),
    password: requireString(password, 'password'),
    env: env === 'live' ? 'live' : 'demo',
  }));

  /**
   * Store credentials and put them into effect.
   *
   * Tried before they are written: a key that does not work should be refused where somebody
   * typed it, rather than found later by a chart that will not load. The accounts it reached
   * come back so the screen can show what was actually connected to.
   */
  ipcMain.handle('capital:credentials-save', async (_e, { apiKey, identifier, password, env } = {}) => {
    const creds = {
      apiKey: requireString(apiKey, 'apiKey'),
      identifier: requireString(identifier, 'identifier'),
      password: requireString(password, 'password'),
      env: env === 'live' ? 'live' : 'demo',
    };
    const accounts = await capitalProbe(creds);
    await saveCredentials(credentialsDir(), 'capital', creds);
    await applyStoredCapitalCredentials();
    return { accounts, env: creds.env };
  });

  ipcMain.handle('capital:credentials-clear', async () => {
    await clearCredentials(credentialsDir(), 'capital');
    // Back to whatever the environment says, which may be nothing at all.
    return applyStoredCapitalCredentials();
  });

  ipcMain.handle('projectx:credentials-status', async () => {
    const stored = await readPublic(credentialsDir(), 'projectx');
    return {
      ...stored,
      encryptionAvailable: encryptionAvailable(),
      envPresent: !!(process.env.PROJECTX_USERNAME && process.env.PROJECTX_API_KEY),
    };
  });

  /** Try credentials WITHOUT storing them, and answer with the accounts they reach. */
  ipcMain.handle('projectx:credentials-test', (_e, { userName, apiKey, base, live } = {}) => projectXProbe({
    userName: requireString(userName, 'userName'),
    apiKey: requireString(apiKey, 'apiKey'),
    base: typeof base === 'string' && base.trim() ? base.trim() : undefined,
    live: live === true,
  }));

  ipcMain.handle('projectx:credentials-save', async (_e, { userName, apiKey, base, hub, live } = {}) => {
    const creds = {
      userName: requireString(userName, 'userName'),
      apiKey: requireString(apiKey, 'apiKey'),
      /* Kept only when given: an empty host stored as an empty string would override the
       * module's own default rather than fall through to it. */
      ...(typeof base === 'string' && base.trim() ? { base: base.trim() } : {}),
      ...(typeof hub === 'string' && hub.trim() ? { hub: hub.trim() } : {}),
      live: live === true,
    };
    const accounts = await projectXProbe(creds);
    await saveCredentials(credentialsDir(), 'projectx', creds);
    await applyStoredProjectXCredentials();
    return { accounts, live: creds.live };
  });

  ipcMain.handle('projectx:credentials-clear', async () => {
    await clearCredentials(credentialsDir(), 'projectx');
    return applyStoredProjectXCredentials();
  });

  ipcMain.handle('binance-spot:credentials-status', async () => {
    const stored = await readPublic(credentialsDir(), 'binance-spot');
    return {
      ...stored,
      env: 'demo',
      encryptionAvailable: encryptionAvailable(),
      envPresent: !!(process.env.BINANCE_DEMO_API_KEY && process.env.BINANCE_DEMO_SECRET_KEY),
    };
  });

  ipcMain.handle('binance-spot:credentials-test', (_e, { apiKey, secretKey } = {}) => binanceSpotProbe({
    apiKey: requireString(apiKey, 'apiKey'),
    secretKey: requireString(secretKey, 'secretKey'),
  }));

  ipcMain.handle('binance-spot:credentials-save', async (_e, { apiKey, secretKey } = {}) => {
    const creds = {
      apiKey: requireString(apiKey, 'apiKey'),
      secretKey: requireString(secretKey, 'secretKey'),
      env: 'demo',
    };
    const account = await binanceSpotProbe(creds);
    await saveCredentials(credentialsDir(), 'binance-spot', creds);
    await applyStoredBinanceSpotCredentials();
    return { account, env: 'demo' };
  });

  ipcMain.handle('binance-spot:credentials-clear', async () => {
    await clearCredentials(credentialsDir(), 'binance-spot');
    return applyStoredBinanceSpotCredentials();
  });

  ipcMain.handle('bybit:credentials-status', async () => {
    const stored = await readPublic(credentialsDir(), 'bybit');
    return {
      ...stored,
      encryptionAvailable: encryptionAvailable(),
      envPresent: !!(process.env.BYBIT_API_KEY && process.env.BYBIT_SECRET_KEY),
    };
  });

  /** Try credentials WITHOUT storing them, and answer with what the key reaches. */
  ipcMain.handle('bybit:credentials-test', (_e, { apiKey, secretKey, env } = {}) => bybitProbe({
    apiKey: requireString(apiKey, 'apiKey'),
    secretKey: requireString(secretKey, 'secretKey'),
    env: env === 'live' ? 'live' : 'demo',
  }));

  ipcMain.handle('bybit:credentials-save', async (_e, { apiKey, secretKey, env } = {}) => {
    const creds = {
      apiKey: requireString(apiKey, 'apiKey'),
      secretKey: requireString(secretKey, 'secretKey'),
      env: env === 'live' ? 'live' : 'demo',
    };
    /* Tried before it is written, for the reason the Capital.com save gives — and for one
     * more here: a demo key typed into the live form connects to nothing, and finding that
     * out from a refused order is finding it out too late. */
    const account = await bybitProbe(creds);
    await saveCredentials(credentialsDir(), 'bybit', creds);
    await applyStoredBybitCredentials();
    return { account, env: creds.env };
  });

  ipcMain.handle('bybit:credentials-clear', async () => {
    await clearCredentials(credentialsDir(), 'bybit');
    return applyStoredBybitCredentials();
  });

  /** The two ledgers a finished trade's real cost has to be joined from. */
  ipcMain.handle('capital:history', async (_e, { from, to } = {}) => {
    const fromMs = Number(from);
    const toMs = Number(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(toMs > fromMs)) {
      throw new Error('history needs a from/to window in epoch milliseconds');
    }
    const [transactions, activities] = await Promise.all([
      capitalTransactions(fromMs, toMs),
      capitalActivities(fromMs, toMs),
    ]);
    return { transactions, activities };
  });

  /* ─── The live trading journal ───────────────────────────────────────── */

  ipcMain.handle('live:trades', () => loadLiveTrades(liveTradesDir()));

  ipcMain.handle('live:append', (_e, trade) => appendLiveTrade(liveTradesDir(), requireLiveTrade(trade)));

  ipcMain.handle('live:settle', (_e, { id, ...actual } = {}) => settleLiveTrade(
    liveTradesDir(),
    requireString(id, 'id'),
    actual,
  ));

  ipcMain.handle('live:clear', () => clearLiveTrades(liveTradesDir()));
}

/**
 * A journal entry that can be believed later.
 *
 * Checked here rather than trusted, because this is the record money is judged by: a NaN
 * price or a missing side would sit in the file for months and turn up as a nonsense total
 * in the analysis long after anyone could work out where it came from.
 */
function requireLiveTrade(trade) {
  const t = trade ?? {};
  const number = (value, name) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };
  if (t.side !== 'long' && t.side !== 'short') throw new Error('side must be long or short');
  return {
    id: requireString(t.id, 'id'),
    symbol: requireString(t.symbol, 'symbol'),
    side: t.side,
    size: number(t.size, 'size'),
    entryPrice: number(t.entryPrice, 'entryPrice'),
    exitPrice: number(t.exitPrice, 'exitPrice'),
    openedAt: number(t.openedAt, 'openedAt'),
    closedAt: number(t.closedAt, 'closedAt'),
    netPnl: number(t.netPnl, 'netPnl'),
    fees: number(t.fees ?? 0, 'fees'),
    /** Whether the exit figures are the venue's own or this app's best guess. */
    estimated: t.estimated === true,
    /** Which account it was taken on, so a demo run never mixes into a live total. */
    live: t.live === true,
    exitTag: typeof t.exitTag === 'string' ? t.exitTag : null,
    /* What the result is denominated in. Kept with the number rather than assumed: a CFD
     * account holds one currency and its instruments quote in others, and a total added up
     * across two kinds of money is wrong in a way nobody can see. */
    currency: typeof t.currency === 'string' && t.currency.trim() !== '' ? t.currency.trim().toUpperCase() : null,
  };
}

/** `LIMIT` or `STOP` — which of the two a level means follows from the direction, and
 *  that decision is the caller's; this only checks it named one of them. */
function requireOrderType(value) {
  const type = requireString(value, 'type').toUpperCase();
  if (type !== 'LIMIT' && type !== 'STOP') throw new Error(`type must be LIMIT or STOP, not "${type}"`);
  return type;
}

/** A required price level — where a resting order waits. */
function requireLevel(value, name) {
  const level = optionalLevel(value, name);
  if (level === undefined) throw new Error(`${name} is required`);
  return level;
}

/** `BUY` or `SELL` — the venue has no third answer, and no notion of a negative size. */
function requireDirection(value) {
  const direction = requireString(value, 'direction').toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') throw new Error(`direction must be BUY or SELL, not "${direction}"`);
  return direction;
}

/** A deal size the venue could act on: positive, finite, and not absurd. */
function requireSize(value) {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size) || size <= 0) throw new Error('size must be a positive number');
  // A ceiling only against a runaway caller — the venue's own maxDealSize is the real
  // limit and it refuses anything over it per instrument.
  if (size > 1e9) throw new Error('size is implausibly large');
  return size;
}

/** A price level, or undefined when the caller did not name one. */
function optionalLevel(value, name) {
  if (value == null) return undefined;
  const level = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(level) || level <= 0) throw new Error(`${name} must be a positive price`);
  return level;
}

/**
 * The protection fields, checked and with the ones nobody mentioned left out.
 *
 * `keepNull` is for an amendment, where the difference between "leave the stop alone" and
 * "take the stop off" is the difference between an absent field and an explicit null — and
 * losing it would silently keep a stop somebody asked to remove.
 */
function optionalLevels(spec, { keepNull = false } = {}) {
  const out = {};
  for (const name of ['stopLevel', 'profitLevel']) {
    if (spec[name] === null && keepNull) out[name] = null;
    else {
      const level = optionalLevel(spec[name], name);
      if (level !== undefined) out[name] = level;
    }
  }
  if (typeof spec.guaranteedStop === 'boolean') out.guaranteedStop = spec.guaranteedStop;
  if (typeof spec.trailingStop === 'boolean') out.trailingStop = spec.trailingStop;
  return out;
}
