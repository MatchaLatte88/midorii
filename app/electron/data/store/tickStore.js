/* Recorded market data — every print and every quote, as it arrived.
 *
 * The bar store keeps candles; a candle is what is left of a minute after everything that
 * happened inside it has been thrown away. Practising at the ladder needs the part that is
 * thrown away: which side hit, in what order, while the bid and the ask stood where. So the
 * feed is written down as it comes in, and a replay can play it back.
 *
 * Layout: one folder per contract, one file per UTC day, each file a run of gzip members.
 *   <root>/<NAME>/<YYYY-MM-DD>.ticks.gz
 * Every flush appends a member of its own. Appending is the whole reason for the format: a
 * day is written in hundreds of small pieces over hours, a rewrite per piece would cost the
 * day's size every few seconds, and gzip is defined as a sequence of members — Node reads
 * them back as one stream.
 *
 * One line per event, a JSON array:
 *   [time, 1, price, volume, side]   a print; side 0 = the buyer crossed the spread, 1 = the seller
 *   [time, 2, bid, ask, last]        a quote, complete — the relay folds the gateway's deltas first
 *
 * What a crash costs
 * ------------------
 * At most the member being written. Reading stops at a member that ends early and keeps
 * everything before it, and a damaged file is repaired before anything new is appended to it.
 */
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PRINT = 1;
export const QUOTE = 2;

/** Folder names come from contract names, which come from a venue — checked all the same. */
const SAFE_NAME = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

const DAY_MS = 86_400_000;

function requireName(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new Error(`"${name}" cannot name a recording. Letters, digits, dot, dash or underscore, up to 32.`);
  }
  return name;
}

function dayOf(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function dayFile(root, name, day) {
  return path.join(root, requireName(name), `${day}.ticks.gz`);
}

/** Everything a buffer of members holds, stopping where a crash cut one short. */
function inflate(buffer) {
  return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
}

/** Day file → the size it had after this process last wrote to it. */
const writtenSize = new Map();

/**
 * Before appending to a day file, make sure it ends cleanly.
 *
 * A crash, or a write that failed half way, can leave a member cut short, and a reader stops
 * there — which is fine while it is the last thing in the file. The moment another member is
 * appended after it, the break sits in the MIDDLE, and everything after it would be unreadable
 * too. So a file that is not the size this process last left it at — a fresh start of the app,
 * or a write that did not finish — is checked, and rewritten keeping every whole line that can
 * be read, before anything new goes on the end of it.
 */
async function repairIfNeeded(file) {
  if (!existsSync(file)) return;
  const size = (await stat(file)).size;
  if (writtenSize.get(file) === size) return;
  const buffer = await readFile(file);
  try {
    zlib.gunzipSync(buffer);
  } catch {
    const kept = inflate(buffer);
    const whole = kept.slice(0, kept.lastIndexOf('\n') + 1);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, zlib.gzipSync(whole));
    await rename(tmp, file);
    console.warn(`[midorii] a recording was cut short and has been repaired: ${file}`);
  }
}

/**
 * Append events to the recording. Events may span days; each lands in its own day's file.
 * Nothing to append is not an error — a flush on a quiet market is a flush of nothing.
 */
export async function appendTicks(root, name, events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  await mkdir(path.join(root, requireName(name)), { recursive: true });

  const byDay = new Map();
  for (const event of events) {
    if (!Array.isArray(event) || !Number.isFinite(event[0])) {
      throw new Error('appendTicks: an event must be an array starting with its time');
    }
    const day = dayOf(event[0]);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(JSON.stringify(event));
  }
  for (const [day, lines] of byDay) {
    const file = dayFile(root, name, day);
    await repairIfNeeded(file);
    try {
      await appendFile(file, zlib.gzipSync(`${lines.join('\n')}\n`));
    } catch (err) {
      writtenSize.delete(file);   // whatever landed, the next append checks it first
      throw err;
    }
    writtenSize.set(file, (await stat(file)).size);
  }
  return events.length;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (Array.isArray(event) && Number.isFinite(event[0])) out.push(event);
    } catch {
      // A line cut in half by a crash is the end of what that member holds.
    }
  }
  return out;
}

/**
 * The events in [from, to), oldest first.
 *
 * Sorted by their own time, stably: the gateway sends quotes that trail the prints they
 * describe, and two events at the same millisecond keep the order they arrived in.
 */
export async function readTicks(root, name, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error('readTicks: from must be before to');
  }
  const out = [];
  for (let day = Date.parse(`${dayOf(from)}T00:00:00Z`); day < to; day += DAY_MS) {
    const file = dayFile(root, name, dayOf(day));
    if (!existsSync(file)) continue;
    const events = await dayEvents(file);
    for (let i = firstAtOrAfter(events, from); i < events.length && events[i][0] < to; i++) out.push(events[i]);
  }
  return out;
}

/**
 * A replay reads a day in small stretches, one after the other, for as long as it plays — and
 * a busy day is tens of megabytes to inflate and a million lines to parse. So the parsed day is
 * kept, for the last few days read, and read again only when the file has grown (it is still
 * being recorded) or it has fallen out.
 */
const MAX_CACHED_DAYS = 3;
const dayCache = new Map();

async function dayEvents(file) {
  const { size } = await stat(file);
  const hit = dayCache.get(file);
  if (hit && hit.size === size) {
    dayCache.delete(file);
    dayCache.set(file, hit);   // most recently used last
    return hit.events;
  }
  const events = parseLines(inflate(await readFile(file)))
    .map((event, i) => ({ event, i }))
    .sort((a, b) => a.event[0] - b.event[0] || a.i - b.i)
    .map(({ event }) => event);
  dayCache.delete(file);
  dayCache.set(file, { size, events });
  while (dayCache.size > MAX_CACHED_DAYS) dayCache.delete(dayCache.keys().next().value);
  return events;
}

/** The index of the first event at or after `time` in time-sorted `events`. */
function firstAtOrAfter(events, time) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (events[mid][0] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What is known about the contract a recording is of — its price increment above all. */
export async function readRecordingMeta(root, name) {
  const file = path.join(root, requireName(name), 'meta.json');
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeRecordingMeta(root, name, meta) {
  const dir = path.join(root, requireName(name));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'meta.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, file);
}

/** What has been recorded: one entry per contract, with its days and how much disk it takes. */
export async function listRecordings(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const days = [];
    let bytes = 0;
    for (const file of await readdir(path.join(root, entry.name))) {
      const match = /^(\d{4}-\d{2}-\d{2})\.ticks\.gz$/.exec(file);
      if (!match) continue;
      days.push(match[1]);
      bytes += (await stat(path.join(root, entry.name, file))).size;
    }
    if (days.length === 0) continue;
    days.sort();
    out.push({ name: entry.name, days, bytes });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
