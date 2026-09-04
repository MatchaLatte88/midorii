/* Backtest runs on disk — an index plus one file per run.
 *
 * Kept beside the market data but in its own folder, for the reason
 * drawingStore gives: a redownload replaces candles and must never take
 * anything else with it.
 *
 * Why files and not a database
 * ----------------------------
 * The thing that decides this is not the number of runs, it is the size of one.
 * The engine's equity curve carries a point per bar — over a year of 5m that is
 * 105,000 points, several megabytes per run, in any storage format at all.
 *
 * So the fix is not the container, it is condensing the curve before it is
 * stored, and that is done here. Once a run weighs a couple of hundred
 * kilobytes, a JSON file per run and one small index is enough for hundreds of
 * them, and reading the index costs a single file read. SQLite would add a
 * native dependency that has to be recompiled against every Electron release,
 * in exchange for queries that a few hundred objects in memory answer faster
 * than the round trip.
 *
 * Everything here goes through the four functions below, so if that judgement
 * ever stops holding, the replacement has one seam to fit.
 *
 * The index is derived, never authoritative
 * -----------------------------------------
 * It holds a summary of each run so the list renders without opening every
 * file. If it disagrees with the files it can be thrown away and rebuilt —
 * which is what happens when it is missing or unreadable, rather than
 * presenting an empty library over a folder full of results.
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Guards against a runaway loop filling the disk. */
const MAX_RUNS = 2000;

/* Run ids are generated here and never come from the renderer, but they still
 * shape a filename, so they are checked on the way in and out regardless. */
const SAFE_ID = /^r[0-9a-z]{6,32}$/;

const INDEX_FILE = 'index.json';

function runFile(dir, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}`);
  }
  return path.join(dir, `${id}.json`);
}

function newId() {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

/** Writes through a temporary file so a crash mid-write cannot truncate data. */
async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * Reduces a per-bar equity curve to the points where something actually
 * happened.
 *
 * Between two trades the realised balance does not move; only unrealised
 * profit on an open position does, and the figures that care about that —
 * peak equity, maximum drawdown — have already been computed by the engine
 * over the full curve before it gets here. What a stored run needs is the
 * shape of the account over time, and that is fully described by the first
 * point, the last, and every point where the balance changed.
 *
 * On a month of BTC 5m this turns 8,928 points into about 55 without changing
 * a single number the summary reports.
 */
export function condenseEquity(curve) {
  if (!Array.isArray(curve) || curve.length === 0) return [];

  const out = [curve[0]];
  let lastBalance = curve[0].balance;

  for (let i = 1; i < curve.length; i++) {
    const point = curve[i];
    if (point.balance === lastBalance) continue;
    out.push(point);
    lastBalance = point.balance;
  }

  // The last bar always belongs: it is where the run ended, trade or not.
  const last = curve[curve.length - 1];
  if (out[out.length - 1] !== last) out.push(last);

  return out;
}

/** The fields the list view needs, so it never has to open a run file. */
function summarize(run) {
  return {
    id: run.id,
    createdAt: run.createdAt,
    strategy: run.strategy,
    strategyName: run.strategyName,
    symbol: run.symbol,
    timeframe: run.timeframe,
    from: run.from,
    to: run.to,
    initialBalance: run.initialBalance,
    resolution: run.resolution,
    note: run.note ?? '',
    stats: {
      netPnl: run.stats.netPnl,
      returnPct: run.stats.returnPct,
      winRate: run.stats.winRate,
      tradeCount: run.stats.tradeCount,
      maxDrawdownPct: run.stats.maxDrawdownPct,
      profitFactor: run.stats.profitFactor,
      expectancy: run.stats.expectancy,
      feesPaid: run.stats.feesPaid,
    },
  };
}

async function readIndex(dir) {
  const file = path.join(dir, INDEX_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Corrupt index: rebuildable from the files, so it is not worth failing on.
    return null;
  }
}

/**
 * Rebuilds the index by reading every run file.
 *
 * The slow path, taken when the index is missing or unreadable. It is what
 * makes the index disposable: losing it costs one directory scan, not the
 * library.
 */
async function rebuildIndex(dir) {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir);
  const summaries = [];

  for (const name of entries) {
    if (!name.endsWith('.json') || name === INDEX_FILE) continue;
    try {
      const run = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (run?.id && run?.stats) summaries.push(summarize(run));
    } catch {
      // One unreadable run costs its own entry, not the whole listing.
    }
  }

  summaries.sort((a, b) => b.createdAt - a.createdAt);
  await writeAtomic(path.join(dir, INDEX_FILE), summaries).catch(() => {});
  return summaries;
}

/** Every stored run, newest first, as summaries. */
export async function listRuns(dir) {
  const index = await readIndex(dir);
  return index ?? rebuildIndex(dir);
}

/** One run in full, including trades and the condensed equity curve. */
export async function loadRun(dir, id) {
  const file = runFile(dir, id);
  if (!existsSync(file)) throw new Error(`No such backtest run: ${id}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Stores a finished run and returns its summary.
 *
 * The result of runBacktest goes in whole except for the equity curve, which
 * is condensed, and the order and fill logs, which are dropped: they are
 * several times the size of the trades and describe the same events at a level
 * nothing in the UI reads. A run that needs them can be re-run — the inputs
 * are all stored.
 */
export async function saveRun(dir, run) {
  if (!run || typeof run !== 'object') throw new Error('saveRun: a run object is required');
  if (!run.stats) throw new Error('saveRun: the run has no stats');

  const stored = {
    ...run,
    id: newId(),
    createdAt: Date.now(),
    equityCurve: condenseEquity(run.equityCurve ?? []),
    /* Says what the curve is, so nothing later mistakes its length for the
     * number of bars the run covered. */
    equityCondensed: true,
  };
  delete stored.orders;
  delete stored.fills;

  await writeAtomic(runFile(dir, stored.id), stored);

  const index = (await listRuns(dir)).filter((r) => r.id !== stored.id);
  index.unshift(summarize(stored));

  /* Oldest first out of the cap, and their files with them — an index that
   * forgot a run while the file stayed would resurrect it on the next
   * rebuild. */
  const dropped = index.splice(MAX_RUNS);
  for (const old of dropped) {
    await unlink(runFile(dir, old.id)).catch(() => {});
  }

  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return summarize(stored);
}

/** Removes one run and its index entry. Deleting what is not there is not an error. */
export async function deleteRun(dir, id) {
  const file = runFile(dir, id);
  if (existsSync(file)) await unlink(file);

  const index = (await listRuns(dir)).filter((r) => r.id !== id);
  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return true;
}

/** Attaches or replaces the free-text note on a run. */
export async function annotateRun(dir, id, note) {
  const run = await loadRun(dir, id);
  run.note = typeof note === 'string' ? note.slice(0, 2000) : '';
  await writeAtomic(runFile(dir, id), run);

  const index = (await listRuns(dir)).map((r) => (r.id === id ? { ...r, note: run.note } : r));
  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return run.note;
}
