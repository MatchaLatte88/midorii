/* Binance provider — public archive at data.binance.vision.
 *
 * No API key, no rate limit, no account: Binance publishes monthly and daily
 * kline dumps as ZIPped CSV with a SHA256 sidecar. That makes it the one free
 * source where a full 1m history can be fetched end to end, which is why it is
 * the first provider Midorii ships.
 *
 * Midorii never redistributes this data — it downloads into the user's own
 * machine on their request. That distinction is what keeps the app a tool
 * rather than a data product.
 *
 * CSV columns (no header row):
 *   0 openTime  1 open  2 high  3 low  4 close  5 volume  6 closeTime
 *   7 quoteVolume  8 trades  9 takerBuyBase  10 takerBuyQuote  11 ignore
 */
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const HOST = 'https://data.binance.vision';

/**
 * Binance switched the dump timestamps from milliseconds to microseconds
 * during 2025 — old files carry 1672531200000, newer ones 1748736000000000.
 * Verified against BTCUSDT 2023-01 (ms) and 2025-06 (µs). Anything past this
 * threshold is microseconds; a millisecond timestamp would not reach 1e14
 * until the year 5138.
 */
const MICROSECOND_THRESHOLD = 1e14;

function normalizeTime(raw) {
  return raw > MICROSECOND_THRESHOLD ? Math.floor(raw / 1000) : raw;
}

function monthUrl(symbol, interval, year, month) {
  const mm = String(month).padStart(2, '0');
  return `${HOST}/data/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${year}-${mm}.zip`;
}

function dayUrl(symbol, interval, year, month, day) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${HOST}/data/spot/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${year}-${mm}-${dd}.zip`;
}

/**
 * Fetches one archive and returns its parsed bars.
 * Returns null on 404 — for an archive that does not exist yet (a month before
 * the symbol was listed, or one not yet published) that is information, not a
 * failure. Every other status throws.
 */
async function fetchArchive(url, { verifyChecksum = true } = {}) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${res.statusText}`);

  const zip = new Uint8Array(await res.arrayBuffer());

  if (verifyChecksum) {
    const sumRes = await fetch(`${url}.CHECKSUM`);
    if (sumRes.ok) {
      const expected = (await sumRes.text()).trim().split(/\s+/)[0];
      const actual = createHash('sha256').update(zip).digest('hex');
      if (expected !== actual) {
        throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
      }
    }
    // A missing .CHECKSUM is not fatal — older archives predate them.
  }

  const entries = unzipSync(zip);
  const names = Object.keys(entries);
  if (names.length !== 1) {
    throw new Error(`${url}: expected exactly one file in the archive, found ${names.length}`);
  }
  return parseKlineCsv(new TextDecoder().decode(entries[names[0]]), url);
}

/** Parses a Binance kline CSV into bars, normalizing the timestamp unit. */
export function parseKlineCsv(text, source = 'csv') {
  const bars = [];
  let lineNo = 0;

  for (const line of text.split('\n')) {
    lineNo++;
    const row = line.trim();
    if (!row) continue;
    // Newer dumps may carry a header row; older ones do not.
    if (row.charCodeAt(0) > 57) continue;

    const f = row.split(',');
    if (f.length < 6) throw new Error(`${source}:${lineNo}: expected >= 6 columns, got ${f.length}`);

    const time = normalizeTime(Number(f[0]));
    const open = Number(f[1]);
    const high = Number(f[2]);
    const low = Number(f[3]);
    const close = Number(f[4]);
    const volume = Number(f[5]);

    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) {
      throw new Error(`${source}:${lineNo}: unparseable row: ${row.slice(0, 80)}`);
    }
    if (high < low) throw new Error(`${source}:${lineNo}: high ${high} below low ${low}`);

    // Column 9 is the volume where the buyer was the taker — the aggressive
    // side. Everything else in `volume` was sold into the bid. A row without
    // the column yields NaN, which means "not recorded", not "no buying".
    const buyVolume = f.length > 9 ? Number(f[9]) : NaN;
    if (f.length > 9 && !Number.isFinite(buyVolume)) {
      throw new Error(`${source}:${lineNo}: unparseable taker buy volume: ${f[9]}`);
    }
    if (Number.isFinite(buyVolume) && buyVolume > volume * 1.000001) {
      throw new Error(
        `${source}:${lineNo}: taker buy volume ${buyVolume} exceeds total volume ${volume}`,
      );
    }

    bars.push({ time, open, high, low, close, volume, buyVolume });
  }
  return bars;
}

/** Every [year, month] pair between two dates, inclusive. */
function monthsBetween(from, to) {
  const out = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth() + 1;
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push([y, m]);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Downloads a symbol's history over a date range.
 *
 * Monthly archives cover everything up to the previous month; the current
 * month is filled from daily archives, which is how the local history reaches
 * yesterday without any live feed.
 *
 * @param {(p:{done:number,total:number,label:string}) => void} [onProgress]
 * @returns {Promise<{bars:Array,missing:string[]}>}
 */
export async function downloadRange(symbol, from, to, interval = '1m', onProgress) {
  const sym = symbol.toUpperCase();
  const months = monthsBetween(from, to);
  const now = new Date();
  const currentKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;

  const bars = [];
  const missing = [];
  let done = 0;

  for (const [y, m] of months) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    const isCurrentMonth = `${y}-${m}` === currentKey;

    if (!isCurrentMonth) {
      const monthBars = await fetchArchive(monthUrl(sym, interval, y, m));
      if (monthBars) bars.push(...monthBars);
      else missing.push(label);
    } else {
      // Current month: walk the daily archives until they run out.
      const lastDay = Math.min(
        to.getUTCFullYear() === y && to.getUTCMonth() + 1 === m ? to.getUTCDate() : 31,
        new Date(Date.UTC(y, m, 0)).getUTCDate(),
      );
      let gotAny = false;
      for (let d = 1; d <= lastDay; d++) {
        const dayBars = await fetchArchive(dayUrl(sym, interval, y, m, d));
        if (dayBars) { bars.push(...dayBars); gotAny = true; }
      }
      if (!gotAny) missing.push(label);
    }

    done++;
    onProgress?.({ done, total: months.length, label });
  }

  if (bars.length === 0) {
    throw new Error(
      `No data returned for ${sym} between ${from.toISOString().slice(0, 10)} and `
      + `${to.toISOString().slice(0, 10)}. Check the symbol spelling — Binance uses `
      + `pairs like BTCUSDT, not BTC/USD.`,
    );
  }

  // Trim to the requested window; archives are whole months.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return { bars: bars.filter((b) => b.time >= fromMs && b.time < toMs), missing };
}

/** Tradable spot symbols, for the symbol picker. */
export async function listSymbols() {
  const res = await fetch('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT');
  if (!res.ok) throw new Error(`exchangeInfo → HTTP ${res.status}`);
  const info = await res.json();
  return info.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
}
