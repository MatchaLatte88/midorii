/* The paper account on disk — one file, rewritten in place.
 *
 * Not a library like runStore, and not a shelf like sessionStore: there is one
 * paper account, it is never finished, and it is meant to run for months. What
 * it needs is somewhere durable that can be written a few times a minute for
 * weeks without falling over, which is exactly what the renderer's
 * localStorage is not — a five-megabyte quota shared with everything else the
 * app stores, no atomic write, and a whole-account rewrite on the main thread.
 *
 * A finished paper account does not stay here. It goes to runStore, on the
 * same shelf a backtest and a hand-played replay land on, because that is the
 * only place three accounts traded three different ways can be compared. This
 * file only ever holds the one that is still running.
 *
 * Written through a temporary file for the reason the other two stores give:
 * the account is rewritten constantly, and a crash mid-write must cost the
 * newest point rather than the whole account.
 */
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const ACCOUNT_FILE = 'account.json';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

function accountFile(dir) {
  return path.join(dir, ACCOUNT_FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * The stored account, or null where there is none.
 *
 * A file that cannot be read or parsed answers null rather than throwing: the
 * app has to open either way, and an account nobody can read is an account
 * that has to be started again. The reason goes to the log, not to the user's
 * chart.
 */
export async function loadAccount(dir) {
  let raw;
  try {
    raw = await readFile(accountFile(dir), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[midorii] could not read the paper account', err);
    }
    return null;
  }

  try {
    const record = JSON.parse(raw);
    if (record?.version !== VERSION || typeof record.symbol !== 'string' || !record.session) {
      console.warn('[midorii] the stored paper account is not a record this version can read');
      return null;
    }
    return record;
  } catch (err) {
    console.error('[midorii] the stored paper account could not be parsed', err);
    return null;
  }
}

/**
 * Store the account, replacing what was there.
 *
 * One record, so there is no index to keep in step and no id to validate — the
 * account is the account.
 */
export async function saveAccount(dir, account) {
  const record = {
    version: VERSION,
    symbol: account.symbol,
    session: account.session,
    savedAt: Date.now(),
  };
  await writeAtomic(accountFile(dir), record);
  return { savedAt: record.savedAt };
}

/** Throw the account away. Already gone is the outcome that was wanted. */
export async function clearAccount(dir) {
  try {
    await unlink(accountFile(dir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return true;
}
