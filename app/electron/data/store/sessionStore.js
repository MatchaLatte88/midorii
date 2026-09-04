/* Replay sessions that are not finished yet — an index plus one file each.
 *
 * A finished session goes to runStore, where it sits beside the backtests and
 * is compared against them. This is the other thing a session can be: an
 * afternoon that is not over. The account has traded eighty bars, three
 * positions are open, and the person has to stop. Without somewhere to put
 * that, the only options are to leave the app running or to throw the session
 * away, and both of those decide the session's length by something other than
 * the market.
 *
 * Kept apart from the runs for the same reason the runs are kept apart from
 * the candles: these are working state, not results, and a library that is
 * read to compare strategies should not have half-played accounts in it.
 * Picking one up leaves it where it is and saving again replaces it, so
 * closing the app without saving costs the sitting rather than the session.
 *
 * What is stored is the account and the clock — never the bars. The bars are
 * in the market data store, they are the same bars tomorrow, and the clock is
 * an instant rather than an index, so the window can be fetched again at a
 * different size without moving anything. See ReplaySession.snapshot.
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Guards against a runaway loop filling the disk. */
const MAX_SESSIONS = 200;

/* Ids are generated here and never come from the renderer, but they still
 * shape a filename, so they are checked on the way in and out regardless. */
const SAFE_ID = /^s[0-9a-z]{6,32}$/;

const INDEX_FILE = 'index.json';

function sessionFile(dir, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
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
 * What the list needs, without opening every file.
 *
 * The same derived-not-authoritative index runStore keeps, for the same
 * reason and with the same fallback: if it disagrees with the files it is
 * thrown away and rebuilt, rather than presenting an empty library over a
 * folder that has sessions in it.
 */
function summarize(session) {
  const stats = session.stats ?? {};
  return {
    id: session.id,
    name: session.name,
    symbol: session.symbol,
    timeframe: session.timeframe,
    savedAt: session.savedAt,
    startTime: session.startTime,
    clock: session.clock,
    bars: stats.bars ?? 0,
    trades: stats.trades ?? 0,
    openPositions: stats.openPositions ?? 0,
    equity: stats.equity ?? null,
    initialBalance: stats.initialBalance ?? null,
  };
}

async function readIndex(dir) {
  try {
    const raw = await readFile(path.join(dir, INDEX_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

/** Rebuilds the index from the files, newest first. */
async function rebuildIndex(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    if (name === INDEX_FILE || !name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (session?.id) out.push(summarize(session));
    } catch {
      // A file that cannot be read is skipped, not fatal to the whole list.
    }
  }

  out.sort((a, b) => b.savedAt - a.savedAt);
  await writeAtomic(path.join(dir, INDEX_FILE), out);
  return out;
}

/** Every stored session, newest first. */
export async function listSessions(dir) {
  const index = await readIndex(dir);
  return index ?? rebuildIndex(dir);
}

/**
 * Stores a session, replacing the one it was picked up from.
 *
 * `id` is carried through where the session came out of the store: putting the
 * same afternoon down twice should leave one entry, not a trail of them, and
 * the person who saved it under a name expects to find that name.
 */
export async function saveSession(dir, session) {
  const id = session.id && SAFE_ID.test(session.id) ? session.id : newId();
  const record = { ...session, id, savedAt: Date.now() };

  await writeAtomic(sessionFile(dir, id), record);

  const index = (await listSessions(dir)).filter((s) => s.id !== id);
  index.unshift(summarize(record));

  /* Oldest first out of the door, and their files with them — an index that
   * forgot a file would leave it on disk forever. */
  const dropped = index.splice(MAX_SESSIONS);
  for (const stale of dropped) {
    try {
      await unlink(sessionFile(dir, stale.id));
    } catch {
      // Already gone is the outcome that was wanted.
    }
  }

  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return { id, savedAt: record.savedAt };
}

export async function loadSession(dir, id) {
  const raw = await readFile(sessionFile(dir, id), 'utf8');
  return JSON.parse(raw);
}

export async function deleteSession(dir, id) {
  const file = sessionFile(dir, id);
  try {
    await unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const index = (await listSessions(dir)).filter((s) => s.id !== id);
  await writeAtomic(path.join(dir, INDEX_FILE), index);
  return true;
}
