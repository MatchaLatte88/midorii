/* Bybit provider — public V5 market data, no key, no account.
 *
 * Bybit publishes no bulk archive, so history comes a page at a time from /v5/market/kline:
 * at most 1000 candles per request, which at the base timeframe is about sixteen hours of
 * minutes. A year is therefore around 530 calls — slower than Binance's monthly ZIPs and
 * faster than Coinbase's 300-bucket pages, and it runs in the background with progress.
 *
 * Both of Bybit's products live behind this one source, told apart the way the app tells
 * every venue's perpetuals apart: `BTCUSDT` is the spot pair, `BTCUSDT.P` is the USDT
 * perpetual. The mapping itself belongs to the venue module — see `bybitMarket` in
 * app/electron/data/bybit.js — so the download, the chart and the order ticket all read a
 * ticker the same way.
 *
 * Bybit does not report the taker side on a candle, so bars carry NaN in `buyVolume`, which
 * the store reads as "not recorded" rather than "nothing bought" (see barStore.js).
 */
import { bybitInstruments, bybitKlines, bybitMarket } from '../bybit.js';
import { monthLabel } from './http.js';

/** Candles per request — the API's own ceiling. */
const MAX_CANDLES = 1000;

/** Intervals Bybit serves, in minutes. The store only ever asks for 1m. */
const INTERVAL = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240 };

function intervalOf(interval) {
  const minutes = INTERVAL[interval];
  if (!minutes) {
    throw new Error(`Bybit does not serve "${interval}". It has: ${Object.keys(INTERVAL).join(', ')}.`);
  }
  return minutes;
}

/**
 * Downloads a market's history over a date range, one 1000-candle window at a time.
 *
 * A window that comes back empty is recorded as missing rather than treated as the end:
 * Bybit returns nothing for a period before the market listed, and stopping at the first of
 * those would silently truncate the history.
 *
 * @param {(p:{done:number,total:number,label:string}) => void} [onProgress]
 * @returns {Promise<{bars:Array,missing:string[]}>}
 */
export async function downloadRange(symbol, from, to, interval = '1m', onProgress) {
  const { category, symbol: market } = bybitMarket(symbol);
  const minutes = intervalOf(interval);
  const stepMs = minutes * 60_000;
  const windowMs = MAX_CANDLES * stepMs;

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const total = Math.max(1, Math.ceil((toMs - fromMs) / windowMs));

  const bars = [];
  const emptyMonths = new Set();
  const filledMonths = new Set();
  let done = 0;

  for (let cursor = fromMs; cursor < toMs; cursor += windowMs) {
    // Inclusive on both ends, so the last candle of a window is one step short of the next
    // window's first — exactly MAX_CANDLES candles, no overlap.
    const windowEnd = Math.min(cursor + windowMs - stepMs, toMs - stepMs);
    const page = await bybitKlines({
      category, symbol: market, interval: String(minutes), start: cursor, end: windowEnd, limit: MAX_CANDLES,
    });

    const label = monthLabel(cursor);
    if (page.length === 0) emptyMonths.add(label);
    else {
      filledMonths.add(label);
      for (const bar of page) bars.push({ ...bar, buyVolume: NaN });
    }

    done++;
    onProgress?.({ done, total, label });
  }

  if (bars.length === 0) {
    throw new Error(
      `No data returned for ${symbol} between ${from.toISOString().slice(0, 10)} and `
      + `${to.toISOString().slice(0, 10)}. Check the spelling — Bybit writes spot pairs as `
      + `BTCUSDT and its perpetuals as BTCUSDT.P.`,
    );
  }

  // Only months with nothing at all in them count as missing; a month whose first window was
  // empty but which filled later was never a gap.
  const missing = [...emptyMonths].filter((m) => !filledMonths.has(m)).sort();
  return { bars: bars.filter((b) => b.time >= fromMs && b.time < toMs), missing };
}

/** Tradable markets of both kinds, for the symbol picker. */
export async function listSymbols() {
  const [spot, linear] = await Promise.all([bybitInstruments('spot'), bybitInstruments('linear')]);
  return [
    ...spot.map((row) => ({ symbol: row.symbol, base: row.base, quote: row.quote })),
    ...linear.map((row) => ({ symbol: `${row.symbol}.P`, base: row.base, quote: row.quote })),
  ];
}
