/* Coinbase provider — public Exchange REST API, no key, no account.
 *
 * Coinbase publishes no bulk archive, so history comes a page at a time from
 * /products/{id}/candles: at most 300 buckets per request, which at the base
 * timeframe is five hours of minutes. A year is therefore about 1750 calls —
 * slow, but it is the only way to the data, and the download runs in the
 * background with progress rather than blocking anything.
 *
 * Candle rows are `[time, low, high, open, close, volume]` with time in
 * SECONDS, newest first. Taker buy volume is not reported: bars carry NaN
 * there, which the store reads as "not recorded" rather than "nothing bought"
 * (see barStore.js).
 */
import { createGate, monthLabel, request } from './http.js';

const REST_BASE = 'https://api.exchange.coinbase.com';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Midorii' };

/** Buckets per request — the API's own ceiling. */
const MAX_BUCKETS = 300;

/* Coinbase allows ~10 public requests a second per IP and answers a burst with
 * 429s that cost more time than they save. One request every 150ms sits under
 * that with room for the retries to breathe. */
const gate = createGate(150);

/** Granularities Coinbase serves, in seconds. The store only ever asks for 1m. */
const GRANULARITY = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21_600, '1d': 86_400 };

function granularityOf(interval) {
  const sec = GRANULARITY[interval];
  if (!sec) {
    throw new Error(
      `Coinbase does not serve "${interval}". It has: ${Object.keys(GRANULARITY).join(', ')}.`,
    );
  }
  return sec;
}

/** One candle row → a store bar. */
function rowToBar(r) {
  const time = Number(r[0]) * 1000;
  const bar = {
    time,
    open: Number(r[3]),
    high: Number(r[2]),
    low: Number(r[1]),
    close: Number(r[4]),
    volume: Number(r[5]),
    buyVolume: NaN, // Coinbase does not report the taker side on candles.
  };
  if (!Number.isFinite(bar.time) || !Number.isFinite(bar.open) || !Number.isFinite(bar.close)) {
    throw new Error(`Coinbase returned an unparseable candle: ${JSON.stringify(r)}`);
  }
  return bar;
}

/** One page of candles over `[startMs, endMs]`, ascending. */
async function fetchWindow(product, granSec, startMs, endMs) {
  const url = new URL(`${REST_BASE}/products/${product}/candles`);
  url.searchParams.set('granularity', String(granSec));
  url.searchParams.set('start', new Date(startMs).toISOString());
  url.searchParams.set('end', new Date(endMs).toISOString());

  const res = await request(gate, url.toString(), { headers: HEADERS });
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Coinbase returned ${JSON.stringify(data).slice(0, 200)} for ${product}`);
  }
  return data.map(rowToBar).sort((a, b) => a.time - b.time);
}

/**
 * Downloads a product's history over a date range, one 300-bucket window at a
 * time.
 *
 * A window that comes back empty is recorded as missing rather than treated as
 * the end: Coinbase returns nothing for a period before the product listed,
 * and for the occasional gap, and stopping at the first of those would silently
 * truncate the history.
 *
 * @param {(p:{done:number,total:number,label:string}) => void} [onProgress]
 * @returns {Promise<{bars:Array,missing:string[]}>}
 */
export async function downloadRange(symbol, from, to, interval = '1m', onProgress) {
  const product = symbol.toUpperCase();
  const granSec = granularityOf(interval);
  const granMs = granSec * 1000;
  const step = MAX_BUCKETS * granMs;

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const total = Math.max(1, Math.ceil((toMs - fromMs) / step));

  const bars = [];
  const emptyMonths = new Set();
  const filledMonths = new Set();
  let done = 0;

  for (let cursor = fromMs; cursor < toMs; cursor += step) {
    // Inclusive on both ends, so the last bucket of a window is one step short
    // of the next window's first — exactly MAX_BUCKETS candles, no overlap.
    const windowEnd = Math.min(cursor + step - granMs, toMs - granMs);
    const page = await fetchWindow(product, granSec, cursor, windowEnd);

    const label = monthLabel(cursor);
    if (page.length === 0) emptyMonths.add(label);
    else {
      filledMonths.add(label);
      bars.push(...page);
    }

    done++;
    onProgress?.({ done, total, label });
  }

  if (bars.length === 0) {
    throw new Error(
      `No data returned for ${product} between ${from.toISOString().slice(0, 10)} and `
      + `${to.toISOString().slice(0, 10)}. Check the product id — Coinbase uses pairs `
      + `like BTC-USD, not BTCUSD.`,
    );
  }

  // Only months with nothing at all in them count as missing; a month whose
  // first window was empty but which filled later was never a gap.
  const missing = [...emptyMonths].filter((m) => !filledMonths.has(m)).sort();
  return { bars: bars.filter((b) => b.time >= fromMs && b.time < toMs), missing };
}

/** Tradable products, for the symbol picker. */
export async function listSymbols() {
  const res = await request(gate, `${REST_BASE}/products`, { headers: HEADERS });
  const products = await res.json();
  if (!Array.isArray(products)) throw new Error('Coinbase /products did not return a list');

  return products
    .filter((p) => p.status === 'online' && !p.trading_disabled)
    .map((p) => ({ symbol: p.id, base: p.base_currency, quote: p.quote_currency }));
}
