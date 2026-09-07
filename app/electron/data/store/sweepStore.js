/* Finished parameter sweeps on disk — an index plus one file per sweep.
 *
 * The same shape as runStore, and deliberately not the same shelf. A run is one account
 * with its trades and its equity curve; a sweep is a few thousand rows of summary
 * statistics and no account at all. Filing them together would mean every list of runs
 * had to explain which of its rows could be opened as an account, and the run library
 * exists precisely so two accounts can be compared.
 *
 * What a sweep does share is the reason for storing it: the settings that produced a
 * result are the result. A ranking without its ranges says which number won and nothing
 * about what was tried.
 *
 * Size is the one thing to watch
 * ------------------------------
 * A sweep can legitimately be a hundred thousand combinations. At roughly 200 bytes of
 * summary each, storing every one is a twenty-megabyte file that nobody scrolls to the
 * bottom of. So the ranked surface is kept whole up to {@link MAX_STORED_RESULTS} and
 * trimmed from the middle beyond that — both ends survive, because the spread between
 * them is the finding, and the file says it was trimmed rather than pretending it holds
 * everything.
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Guards against a runaway loop filling the disk. */
const MAX_SWEEPS = 500;

/** How many combinations one stored sweep keeps. Both ends of the ranking, never the
 *  middle: the best and the worst are what say whether a parameter matters at all. */
export const MAX_STORED_RESULTS = 5000;

const SAFE_ID = /^s[0-9a-z]{6,32}$/;
const INDEX_FILE = 'index.json';

function sweepFile(dir, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid sweep id: ${JSON.stringify(id)}`);
  }
  return path.join(dir, `${id}.json`);
}

function newId() {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

/** Writes through a temporary file so a crash mid-write cannot truncate data. */
async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * Trims a ranked surface to what a file should hold, from the middle outwards.
 *
 * The middle of a ranking is where the combinations that are neither instructive nor
 * cautionary sit. Dropping from there keeps the shape of both tails, which is what gets
 * read back.
 */
export function trimResults(results, limit = MAX_STORED_RESULTS) {
  if (!Array.isArray(results) || results.length <= limit) {
    return { results: results ?? [], truncated: false };
  }
  const half = Math.floor(limit / 2);
  return {
    results: [...results.slice(0, half), ...results.slice(-(limit - half))],
    truncated: true,
  };
}

/** The fields the list view needs, so it never has to open a sweep file. */
function summarize(sweep) {
  const top = sweep.best?.[0] ?? null;
  return {
    id: sweep.id,
    createdAt: sweep.createdAt,
    strategy: sweep.strategy,
    strategyName: sweep.strategyName,
    symbol: sweep.symbol,
    timeframe: sweep.timeframe,
    from: sweep.from,
    to: sweep.to,
    metric: sweep.metric,
    minTrades: sweep.minTrades,
    combinationCount: sweep.combinationCount,
    rankedCount: sweep.rankedCount,
    /** The parameters that swept, so a list row says what was actually varied. */
    sweptKeys: Object.keys(sweep.ranges ?? {}),
    /** The winner's figures — what the row is read for. Null when nothing qualified. */
    best: top ? { params: top.params, stats: top.stats, outOfSample: top.outOfSample ?? null } : null,
    cancelled: sweep.cancelled === true,
    note: sweep.note ?? '',
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

/** Rebuilds the index by reading every sweep file — the slow path, taken when the index
 *  is missing or unreadable. It is what makes the index disposable. */
async function rebuildIndex(dir) {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir);
  const summaries = [];

  for (const name of entries) {
    if (!name.endsWith('.json') || name === INDEX_FILE) continue;
    try {
      const sweep = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (sweep?.id && sweep?.ranges) summaries.push(summarize(sweep));
    } catch {
      // One unreadable sweep costs its own entry, not the whole listing.
    }
  }

  summaries.sort((a, b) => b.createdAt - a.createdAt);
  await writeAtomic(path.join(dir, INDEX_FILE), summaries).catch(() => {});
  return summaries;
}

/**
 * Every stored sweep, newest first, as summaries.
 *
 * An index whose entries predate the current summary shape is thrown away and rebuilt
 * rather than displayed. That is what "derived, never authoritative" is for: a row missing
 * the winner it is read for is worse than one directory scan, and the scan happens once —
 * the rebuild writes the current shape back.
 */
export async function listSweeps(dir) {
  const index = await readIndex(dir);
  if (index && index.every((entry) => entry && 'best' in entry)) return index;
  return rebuildIndex(dir);
}

/** One sweep in full, with its whole ranked surface. */
export async function loadSweep(dir, id) {
  const file = sweepFile(dir, id);
  if (!existsSync(file)) throw new Error(`No such sweep: ${id}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Stores a finished sweep and returns its summary. */
export async function saveSweep(dir, sweep) {
  if (!sweep || typeof sweep !== 'object') throw new Error('saveSweep: a sweep object is required');
  if (!sweep.ranges || Object.keys(sweep.ranges).length === 0) {
    throw new Error('saveSweep: the sweep has no ranges');
  }
  if (!Array.isArray(sweep.results) || sweep.results.length === 0) {
    throw new Error('saveSweep: the sweep produced no results');
  }

  const trimmed = trimResults(sweep.results);
  const stored = {
    ...sweep,
    id: newId(),
    createdAt: Date.now(),
    results: trimmed.results,
    resultsTruncated: trimmed.truncated,
  };

  await writeAtomic(sweepFile(dir, stored.id), stored);

  const index = (await listSweeps(dir)).filter((s) => s.id !== stored.id);
  index.unshift(summarize(stored));

  /* Oldest first out of the cap, and their files with them — an index that forgot a
   * sweep while the file stayed would resurrect it on the next rebuild. */
  const dropped = index.splice(MAX_SWEEPS);
  for (const old of dropped) {
    await unlink(sweepFile(dir, old.id)).catch(() => {});
  }

  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return summarize(stored);
}

/** Removes one sweep and its index entry. Deleting what is not there is not an error. */
export async function deleteSweep(dir, id) {
  const file = sweepFile(dir, id);
  if (existsSync(file)) await unlink(file);

  const index = (await listSweeps(dir)).filter((s) => s.id !== id);
  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return true;
}

/** Attaches or replaces the free-text note on a sweep. */
export async function annotateSweep(dir, id, note) {
  const sweep = await loadSweep(dir, id);
  sweep.note = typeof note === 'string' ? note.slice(0, 2000) : '';
  await writeAtomic(sweepFile(dir, id), sweep);

  const index = (await listSweeps(dir)).map((s) => (s.id === id ? { ...s, note: sweep.note } : s));
  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return sweep.note;
}
