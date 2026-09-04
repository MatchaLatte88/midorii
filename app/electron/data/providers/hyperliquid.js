/* Hyperliquid provider — the public `info` endpoint, no key, no account.
 *
 * One POST answers everything: `candleSnapshot` for bars, `meta` for the perp
 * universe, `spotMeta` for spot pairs. The snapshot returns at most 5000
 * candles per call, so a year of minutes is roughly a hundred calls — far
 * fewer than Coinbase needs, though Hyperliquid keeps a shorter history and
 * will simply return nothing for a window older than it retains. That shows up
 * as missing months in the download's report rather than as a silent gap.
 *
 * Candles are `{ t, T, s, i, o, h, l, c, v, n }` with prices as strings and
 * times in milliseconds. The taker side is not reported, so bars carry NaN
 * there — "not recorded", not "nothing bought" (see barStore.js).
 */
import { createGate, monthLabel, request } from './http.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** Candles per snapshot — the endpoint's own ceiling. */
const MAX_CANDLES = 5000;

/* The info endpoint is weighted rather than counted, and a candle snapshot is
 * one of the expensive calls. A second between them keeps a long download
 * inside the budget from start to finish. */
const gate = createGate(1000);

/** Intervals Hyperliquid serves natively. The store only ever asks for 1m. */
const INTERVAL_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

function intervalMsOf(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) {
    throw new Error(
      `Hyperliquid does not serve "${interval}". It has: ${Object.keys(INTERVAL_MS).join(', ')}.`,
    );
  }
  return ms;
}

/** POST one `info` request and parse the answer. */
async function post(body) {
  const res = await request(gate, INFO_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return res.json();
}

/** One raw candle → a store bar. */
function candleToBar(k) {
  const bar = {
    time: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    buyVolume: NaN, // Hyperliquid does not report the taker side on candles.
  };
  if (!Number.isFinite(bar.time) || !Number.isFinite(bar.open) || !Number.isFinite(bar.close)) {
    throw new Error(`Hyperliquid returned an unparseable candle: ${JSON.stringify(k)}`);
  }
  return bar;
}

/**
 * Downloads a coin's history over a date range, 5000 candles at a time.
 *
 * A window that comes back empty is recorded as missing and the walk carries
 * on: Hyperliquid answers a window from before the coin listed — or from
 * before its retention reaches — with nothing at all, and stopping there would
 * leave the newer history undownloaded.
 *
 * @param {(p:{done:number,total:number,label:string}) => void} [onProgress]
 * @returns {Promise<{bars:Array,missing:string[]}>}
 */
export async function downloadRange(symbol, from, to, interval = '1m', onProgress) {
  const coin = symbol.includes('/') ? symbol : symbol.toUpperCase();
  const intervalMs = intervalMsOf(interval);
  const step = MAX_CANDLES * intervalMs;

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const total = Math.max(1, Math.ceil((toMs - fromMs) / step));

  const bars = [];
  const emptyMonths = new Set();
  const filledMonths = new Set();
  let done = 0;

  for (let cursor = fromMs; cursor < toMs; cursor += step) {
    const windowEnd = Math.min(cursor + step, toMs);
    const data = await post({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: Math.floor(cursor), endTime: Math.floor(windowEnd) },
    });
    if (!Array.isArray(data)) {
      throw new Error(`Hyperliquid returned ${JSON.stringify(data).slice(0, 200)} for ${coin}`);
    }

    const label = monthLabel(cursor);
    if (data.length === 0) emptyMonths.add(label);
    else {
      filledMonths.add(label);
      bars.push(...data.map(candleToBar));
    }

    done++;
    onProgress?.({ done, total, label });
  }

  if (bars.length === 0) {
    throw new Error(
      `No data returned for ${coin} between ${from.toISOString().slice(0, 10)} and `
      + `${to.toISOString().slice(0, 10)}. Hyperliquid names perpetuals by their base `
      + `asset (BTC, not BTCUSDT) and spot pairs as BASE/QUOTE.`,
    );
  }

  const missing = [...emptyMonths].filter((m) => !filledMonths.has(m)).sort();
  return { bars: bars.filter((b) => b.time >= fromMs && b.time < toMs), missing };
}

/** Perpetuals and spot pairs, for the symbol picker. */
export async function listSymbols() {
  const [perpMeta, spotMeta] = await Promise.all([
    post({ type: 'meta' }),
    post({ type: 'spotMeta' }).catch(() => null),
  ]);

  const perps = (perpMeta?.universe ?? [])
    .filter((u) => !u.isDelisted)
    .map((u) => ({ symbol: u.name, base: u.name, quote: 'USD' }));

  const tokens = spotMeta?.tokens ?? [];
  const nameOf = (i) => (i != null ? tokens[i]?.name ?? null : null);
  const spot = (spotMeta?.universe ?? []).map((u) => ({
    symbol: u.name,
    base: nameOf(u.tokens?.[0]) ?? u.name,
    quote: nameOf(u.tokens?.[1]) ?? '',
  }));

  return [...perps, ...spot];
}
