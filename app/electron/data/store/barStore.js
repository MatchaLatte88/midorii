/* Bar store — one flat binary file per symbol, base timeframe only.
 *
 * Layout: a single Float64Array, stride 7, ascending by time, no duplicates:
 *   [ timeMs, open, high, low, close, volume, buyVolume ]
 * 56 bytes per bar → five years of 1m crypto is ~147 MB on disk and loads in
 * one read. Everything above the base timeframe is aggregated on the fly
 * (see aggregate()), so there is exactly one source of truth per symbol.
 *
 * buyVolume is the share of `volume` where the buyer was the aggressor (the
 * taker). Sell volume is `volume - buyVolume`, and delta is the difference
 * between the two. Sources that do not report it store NaN — deliberately not
 * 0, which would claim every trade was a sell.
 *
 * Metadata lives beside it as <name>.meta.json so the catalog can list what
 * is on disk without opening the binary.
 */
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const STRIDE = 7;
export const BASE_TIMEFRAME = '1m';

/** On-disk format. v1 was stride 6, before buy volume was recorded. */
export const FORMAT_VERSION = 2;
const V1_STRIDE = 6;

/** Timeframe → milliseconds. The only place timeframe strings are defined. */
export const TIMEFRAMES = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function timeframeMs(tf) {
  const ms = TIMEFRAMES[tf];
  if (!ms) throw new Error(`Unknown timeframe: ${tf}`);
  return ms;
}

function datasetPath(dataDir, symbol) {
  return path.join(dataDir, `${symbol}-${BASE_TIMEFRAME}.bin`);
}
function metaPath(dataDir, symbol) {
  return path.join(dataDir, `${symbol}-${BASE_TIMEFRAME}.meta.json`);
}

/**
 * Widens a v1 dataset to the current layout in memory, marking buy volume as
 * unknown. The file itself is left alone until the next merge rewrites it —
 * reading must not have side effects on disk.
 */
export function migrateV1(v1) {
  const count = v1.length / V1_STRIDE;
  const out = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const from = i * V1_STRIDE;
    const to = i * STRIDE;
    for (let k = 0; k < V1_STRIDE; k++) out[to + k] = v1[from + k];
    out[to + 6] = NaN; // never recorded, and not the same thing as zero
  }
  return out;
}

/** Reads the whole dataset for a symbol. Returns null if nothing is stored. */
export async function readDataset(dataDir, symbol) {
  const file = datasetPath(dataDir, symbol);
  if (!existsSync(file)) return null;

  const meta = await readMeta(dataDir, symbol);
  // A dataset written before formats were versioned is v1 by definition.
  const version = meta?.format ?? 1;

  const buf = await readFile(file);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf); // copy: Node pools reads at arbitrary offsets, Float64Array needs alignment

  if (version === 1) {
    if (buf.byteLength % (V1_STRIDE * 8) !== 0) {
      throw new Error(
        `Corrupt dataset ${file}: ${buf.byteLength} bytes is not a multiple of ${V1_STRIDE * 8}`,
      );
    }
    return migrateV1(new Float64Array(bytes.buffer));
  }

  if (version !== FORMAT_VERSION) {
    throw new Error(
      `${file} was written in format v${version}, but this build reads v${FORMAT_VERSION}. `
      + `Delete the file and download the history again.`,
    );
  }

  if (buf.byteLength % (STRIDE * 8) !== 0) {
    throw new Error(
      `Corrupt dataset ${file}: ${buf.byteLength} bytes is not a multiple of ${STRIDE * 8}`,
    );
  }
  return new Float64Array(bytes.buffer);
}

export async function readMeta(dataDir, symbol) {
  const file = metaPath(dataDir, symbol);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Merges bars into a dataset: ascending by time, last write wins on a
 * duplicate timestamp. Rewrites the file whole — at these sizes that costs
 * well under a second and removes every partial-write failure mode. A v1 file
 * is upgraded to the current format by this rewrite.
 *
 * @param {Array<{time,open,high,low,close,volume,buyVolume?}>} bars
 * @returns {Promise<{added:number,total:number,first:number,last:number}>}
 */
export async function mergeBars(dataDir, symbol, bars, extraMeta = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error(`mergeBars(${symbol}): no bars given`);
  }
  await mkdir(dataDir, { recursive: true });

  const existing = await readDataset(dataDir, symbol);
  const existingCount = existing ? existing.length / STRIDE : 0;

  // Index incoming bars by timestamp so duplicates collapse before the merge.
  const incoming = new Map();
  for (const b of bars) {
    if (!Number.isFinite(b.time)) throw new Error(`Bar with invalid time in ${symbol}`);
    incoming.set(b.time, b);
  }

  const merged = new Float64Array((existingCount + incoming.size) * STRIDE);
  let out = 0;
  let kept = 0;

  const write = (time, o, h, l, c, v, bv) => {
    merged[out] = time;
    merged[out + 1] = o;
    merged[out + 2] = h;
    merged[out + 3] = l;
    merged[out + 4] = c;
    merged[out + 5] = v;
    merged[out + 6] = bv;
    out += STRIDE;
  };

  const writeIncoming = (b) => write(
    b.time, b.open, b.high, b.low, b.close, b.volume,
    b.buyVolume === undefined ? NaN : b.buyVolume,
  );

  // Existing bars are already sorted; incoming needs sorting once.
  const newTimes = [...incoming.keys()].sort((a, b) => a - b);
  let i = 0; // index into existing, in bars
  let j = 0; // index into newTimes

  while (i < existingCount || j < newTimes.length) {
    const tOld = i < existingCount ? existing[i * STRIDE] : Infinity;
    const tNew = j < newTimes.length ? newTimes[j] : Infinity;

    if (tOld < tNew) {
      const base = i * STRIDE;
      write(existing[base], existing[base + 1], existing[base + 2], existing[base + 3],
            existing[base + 4], existing[base + 5], existing[base + 6]);
      i++;
      kept++;
    } else if (tNew < tOld) {
      writeIncoming(incoming.get(tNew));
      j++;
    } else {
      // Same timestamp: the incoming bar replaces the stored one.
      writeIncoming(incoming.get(tNew));
      i++; j++; kept++;
    }
  }

  const final = merged.subarray(0, out);
  const total = out / STRIDE;

  // Count how much of the result actually carries buy volume, so the UI can
  // say whether delta is available instead of silently drawing an empty chart.
  let withBuyVolume = 0;
  for (let k = 0; k < total; k++) {
    if (!Number.isNaN(final[k * STRIDE + 6])) withBuyVolume++;
  }

  // Write to a temp file first, then rename — a crash mid-write must never
  // leave a half-written dataset behind.
  const file = datasetPath(dataDir, symbol);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, Buffer.from(final.buffer, final.byteOffset, final.byteLength));
  await rename(tmp, file);

  const meta = {
    symbol,
    timeframe: BASE_TIMEFRAME,
    format: FORMAT_VERSION,
    count: total,
    first: total ? final[0] : null,
    last: total ? final[(total - 1) * STRIDE] : null,
    barsWithBuyVolume: withBuyVolume,
    updatedAt: new Date().toISOString(),
    ...extraMeta,
  };
  await writeFile(metaPath(dataDir, symbol), JSON.stringify(meta, null, 2));

  return { added: total - kept, total, first: meta.first, last: meta.last, withBuyVolume };
}

/** First index whose time is >= target. Returns the bar count when target is past the end. */
export function lowerBound(data, target) {
  let lo = 0;
  let hi = data.length / STRIDE;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid * STRIDE] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Aggregates base-timeframe bars into `tf`, bucketed on UTC boundaries.
 *
 * With `dropIncomplete` set, a trailing bucket that the data does not fully
 * cover is withheld — a half-filled bucket handed to a strategy is exactly the
 * look-ahead that makes a backtest lie, so the engine always asks for closed
 * buckets only. The chart may ask for the open one.
 *
 * Note: UTC bucketing is correct for 24/7 crypto. Session-based markets
 * (futures, equities) need session-aware boundaries — not implemented yet.
 */
export function aggregate(data, from, to, tf, dropIncomplete = true) {
  const step = timeframeMs(tf);
  const out = [];
  const count = data.length / STRIDE;

  let i = lowerBound(data, from);
  let bucketStart = -1;
  let o = 0, h = 0, l = 0, c = 0, v = 0, bv = 0;

  const flush = () => {
    if (bucketStart >= 0) {
      out.push({ time: bucketStart, open: o, high: h, low: l, close: c, volume: v, buyVolume: bv });
    }
  };

  for (; i < count; i++) {
    const base = i * STRIDE;
    const t = data[base];
    if (t >= to) break;

    const bs = Math.floor(t / step) * step;
    if (bs !== bucketStart) {
      flush();
      bucketStart = bs;
      o = data[base + 1];
      h = data[base + 2];
      l = data[base + 3];
      c = data[base + 4];
      v = data[base + 5];
      bv = data[base + 6];
    } else {
      if (data[base + 2] > h) h = data[base + 2];
      if (data[base + 3] < l) l = data[base + 3];
      c = data[base + 4];
      v += data[base + 5];
      // NaN propagates on purpose: one unknown minute makes the bucket unknown.
      bv += data[base + 6];
    }
  }

  // The last bucket counts as closed only if data exists up to its final minute.
  const lastTime = count ? data[(count - 1) * STRIDE] : 0;
  const reachesEnd = bucketStart >= 0
    && Math.min(lastTime, to - 1) >= bucketStart + step - timeframeMs(BASE_TIMEFRAME);
  if (bucketStart >= 0 && (reachesEnd || !dropIncomplete)) flush();

  return out;
}

/** Reads a time range at the requested timeframe. */
export async function readBars(dataDir, symbol, tf, from, to, dropIncomplete = true) {
  const data = await readDataset(dataDir, symbol);
  if (!data) throw new Error(`No local data for ${symbol}. Download or import it first.`);
  if (tf === BASE_TIMEFRAME) {
    const out = [];
    const count = data.length / STRIDE;
    for (let i = lowerBound(data, from); i < count; i++) {
      const base = i * STRIDE;
      if (data[base] >= to) break;
      out.push({
        time: data[base], open: data[base + 1], high: data[base + 2],
        low: data[base + 3], close: data[base + 4], volume: data[base + 5],
        buyVolume: data[base + 6],
      });
    }
    return out;
  }
  return aggregate(data, from, to, tf, dropIncomplete);
}

/** Every dataset on disk, for the library view. */
export async function listDatasets(dataDir) {
  if (!existsSync(dataDir)) return [];
  const files = await readdir(dataDir);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    const meta = JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));
    const bin = datasetPath(dataDir, meta.symbol);
    meta.bytes = existsSync(bin) ? (await stat(bin)).size : 0;
    meta.format ??= 1;
    // A v1 dataset predates buy volume entirely.
    meta.barsWithBuyVolume ??= 0;
    out.push(meta);
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
