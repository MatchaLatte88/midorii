/* A bot's own paper account on disk — one file per bot, rewritten in place.
 *
 * The counterpart of paperStore, and different from it in the one way that matters: there is
 * exactly one chart paper account and there are as many bot accounts as there are bots. So
 * this is a folder keyed by bot id rather than a single file, and everything else — the
 * atomic write, the answer-null-on-unreadable rule, the reason it is on disk at all — is
 * paperStore's, for paperStore's reasons.
 *
 * Why a bot's account has to survive at all
 * -----------------------------------------
 * A bot is meant to run for weeks. Without this, stopping one — or closing the app — threw
 * away every trade it had made, and it started again at its opening balance with nothing
 * anywhere to say what it had done. That is not a bot anybody can judge.
 *
 * A FINISHED account does not stay here. It goes to runStore, on the same shelf a backtest
 * of the same strategy lands on, which is the only place the two can be compared — and
 * comparing them is the entire reason to run a strategy live after testing it. This file
 * only holds the account that is still running.
 */
import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

/** Ids reach a file name, so they stay plain. The same rule strategyStore applies. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function requireId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid bot id: ${JSON.stringify(id)}`);
  }
  return id;
}

function accountFile(dir, id) {
  return path.join(dir, `${requireId(id)}.json`);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * One bot's stored account, or null where there is none.
 *
 * Unreadable answers null rather than throwing, exactly as the chart's account does: the bot
 * has to be startable either way, and an account nobody can read is one that has to be
 * started again. What it must never do is start on half of one.
 */
export async function loadBotAccount(dir, id) {
  let raw;
  try {
    raw = await readFile(accountFile(dir, id), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[midorii] could not read the account for bot ${id}`, err);
    }
    return null;
  }

  try {
    const record = JSON.parse(raw);
    if (record?.version !== VERSION || typeof record.symbol !== 'string' || !record.session) {
      console.warn(`[midorii] the stored account for bot ${id} is not a record this version can read`);
      return null;
    }
    return record;
  } catch (err) {
    console.error(`[midorii] the stored account for bot ${id} could not be parsed`, err);
    return null;
  }
}

/** Store one bot's account, replacing what was there. */
export async function saveBotAccount(dir, id, account) {
  requireId(id);
  if (!account || typeof account.symbol !== 'string' || !account.session) {
    throw new Error('saveBotAccount: this is not an account snapshot');
  }
  const record = {
    version: VERSION,
    symbol: account.symbol,
    session: account.session,
    savedAt: Date.now(),
  };
  await writeAtomic(accountFile(dir, id), record);
  return { savedAt: record.savedAt };
}

/** Throw one bot's account away. Already gone is the outcome that was wanted. */
export async function clearBotAccount(dir, id) {
  try {
    await unlink(accountFile(dir, id));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return true;
}

/**
 * The bot ids that have an account stored.
 *
 * For the sweep that removes accounts belonging to bots that no longer exist — a deleted bot
 * takes its account with it, but a file left behind by a crash mid-delete would otherwise sit
 * there for good.
 */
export async function listBotAccounts(dir) {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[midorii] could not list the stored bot accounts', err);
    }
    return [];
  }
}
