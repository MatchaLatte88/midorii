/* A bot's durable runtime on disk — one file per bot, rewritten in place.
 *
 * Paper bots keep their account here. Every bot also keeps its UTC-day guard counters, and
 * Capital.com bots keep the venue ids they have proved they own. The folder is keyed by bot
 * id because none of that state may cross from one bot to another.
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

/** The shape this version writes. Version 2 adds guards and live-broker ownership. */
const VERSION = 2;

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

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function readGuards(value) {
  if (value == null) return undefined;
  if (
    typeof value !== 'object'
    || typeof value.dayKey !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.dayKey)
    || !finite(value.dayOpenEquity)
    || !Number.isInteger(value.tradesToday)
    || value.tradesToday < 0
    || !(value.lastLossAt == null || finite(value.lastLossAt))
  ) {
    throw new Error('the daily guard state is invalid');
  }
  return {
    dayKey: value.dayKey,
    dayOpenEquity: value.dayOpenEquity,
    tradesToday: value.tradesToday,
    lastLossAt: value.lastLossAt ?? null,
  };
}

function readOwnership(value) {
  if (value == null) return undefined;
  if (
    typeof value !== 'object'
    || typeof value.initialized !== 'boolean'
    || !Array.isArray(value.positionDealIds)
    || !value.positionDealIds.every((id) => typeof id === 'string' && id.length > 0)
    || !Array.isArray(value.workingOrderDealIds)
    || !value.workingOrderDealIds.every((id) => typeof id === 'string' && id.length > 0)
    || typeof value.uncertain !== 'boolean'
  ) {
    throw new Error('the Capital.com ownership state is invalid');
  }
  return {
    initialized: value.initialized,
    positionDealIds: [...new Set(value.positionDealIds)],
    workingOrderDealIds: [...new Set(value.workingOrderDealIds)],
    uncertain: value.uncertain,
  };
}

/** One bot's stored runtime, or null only where no record exists. */
export async function loadBotAccount(dir, id) {
  let raw;
  try {
    raw = await readFile(accountFile(dir, id), 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw new Error(`Could not read the runtime state for bot ${id}: ${messageOf(err)}`, { cause: err });
  }

  try {
    const record = JSON.parse(raw);
    if (record?.version === 1 && typeof record.symbol === 'string' && record.symbol && record.session != null) {
      return {
        symbol: record.symbol,
        session: record.session,
        savedAt: finite(record.savedAt) ? record.savedAt : 0,
      };
    }
    if (record?.version !== VERSION || typeof record.symbol !== 'string' || !record.symbol) {
      throw new Error(`version ${JSON.stringify(record?.version)} is not supported`);
    }
    const guards = readGuards(record.guards);
    const capital = readOwnership(record.capital);
    if ('session' in record && record.session == null) {
      throw new Error('the paper account is invalid');
    }
    if (!('session' in record) && !guards && !capital) {
      throw new Error('the record has no paper account or runtime state');
    }
    return {
      symbol: record.symbol,
      ...('session' in record ? { session: record.session } : {}),
      ...(guards ? { guards } : {}),
      ...(capital ? { capital } : {}),
      savedAt: finite(record.savedAt) ? record.savedAt : 0,
    };
  } catch (err) {
    throw new Error(`The runtime state for bot ${id} is unreadable: ${messageOf(err)}`, { cause: err });
  }
}

/** Store one bot's runtime, replacing what was there. */
export async function saveBotAccount(dir, id, account) {
  requireId(id);
  if (!account || typeof account.symbol !== 'string' || !account.symbol) {
    throw new Error('saveBotAccount: this is not a bot runtime snapshot');
  }
  const guards = readGuards(account.guards);
  const capital = readOwnership(account.capital);
  if ('session' in account && account.session == null) {
    throw new Error('saveBotAccount: the paper account is invalid');
  }
  if (!('session' in account) && !guards && !capital) {
    throw new Error('saveBotAccount: the snapshot has no paper account or runtime state');
  }
  const record = {
    version: VERSION,
    symbol: account.symbol,
    ...('session' in account ? { session: account.session } : {}),
    ...(guards ? { guards } : {}),
    ...(capital ? { capital } : {}),
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
