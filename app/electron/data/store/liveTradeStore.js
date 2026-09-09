/* The live trading journal on disk — every trade this app has taken on a real account.
 *
 * Why keep one at all, when the venue has the same information? Because the venue's copy is
 * awkward and temporary: `/history/activity` serves at most a single day per request, so
 * reconstructing a month means thirty round trips, and an account that is closed or a set of
 * credentials that is rotated takes the record with it. This file is Midorii's own answer to
 * "what have I actually done", it is written the moment a trade ends, and it outlives the
 * connection that produced it.
 *
 * Append-only in spirit. A trade that has closed is a fact and is never rewritten — the only
 * mutation is filling in figures that were not yet known when it was recorded (see
 * `settle`), which is why each entry carries its own id.
 *
 * One file, rewritten atomically, for the reason paperStore gives: a crash mid-write must
 * cost the newest entry rather than the whole journal.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const JOURNAL_FILE = 'live-trades.json';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

function journalFile(dir) {
  return path.join(dir, JOURNAL_FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/** Every trade on record, oldest first. An unreadable or absent journal reads as empty. */
export async function loadLiveTrades(dir) {
  let raw;
  try {
    raw = await readFile(journalFile(dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(raw);
  if (data?.version !== VERSION || !Array.isArray(data.trades)) return [];
  return data.trades;
}

/**
 * Add one finished trade.
 *
 * Refuses a duplicate id rather than appending it twice: the same closure can be noticed by
 * two reconciles in a row if one of them is slow, and a journal that double-counts is worse
 * than one that misses something — a wrong total is believed, a missing trade is noticed.
 */
export async function appendLiveTrade(dir, trade) {
  const trades = await loadLiveTrades(dir);
  if (trades.some((t) => t.id === trade.id)) return { added: false, total: trades.length };
  trades.push(trade);
  await writeAtomic(journalFile(dir), { version: VERSION, trades });
  return { added: true, total: trades.length };
}

/**
 * Fill in what was not known when a trade was recorded — the venue's own exit price and
 * realized profit, once its transaction history catches up.
 *
 * Only the estimated fields are replaced, and only on a trade still marked estimated: an
 * entry the venue has already confirmed is settled, and settling it twice with a later
 * answer would let a retry rewrite a fact.
 */
export async function settleLiveTrade(dir, id, actual) {
  const trades = await loadLiveTrades(dir);
  const trade = trades.find((t) => t.id === id);
  if (!trade || !trade.estimated) return false;
  if (typeof actual.exitPrice === 'number') trade.exitPrice = actual.exitPrice;
  if (typeof actual.netPnl === 'number') trade.netPnl = actual.netPnl;
  if (typeof actual.fees === 'number') trade.fees = actual.fees;
  // The cash ledger's own denomination replaces the position's, which is the better answer
  // about what the settled figures actually are.
  if (typeof actual.currency === 'string' && actual.currency) trade.currency = actual.currency.toUpperCase();
  trade.estimated = false;
  await writeAtomic(journalFile(dir), { version: VERSION, trades });
  return true;
}

/** Empty the journal. Its own call, never a side effect of anything else. */
export async function clearLiveTrades(dir) {
  await writeAtomic(journalFile(dir), { version: VERSION, trades: [] });
}
