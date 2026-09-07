/* Price alerts on disk — one file, rewritten in place.
 *
 * A small, flat list rather than a shelf like runStore: an alert is either pending or
 * fired-and-done, there is no history to browse, and the whole list is small enough to
 * read and write whole every time — same reasoning as paperStore, minus the account
 * shape. Written through a temporary file for the same reason: a crash mid-write must
 * cost nothing more than the newest edit.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ALERTS_FILE = 'alerts.json';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

function alertsFile(dir) {
  return path.join(dir, ALERTS_FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/**
 * The stored alerts, or an empty list where there are none (or the file cannot be read).
 * A file that cannot be read or parsed answers empty rather than throwing: the app has
 * to open either way, and alerts nobody can read are alerts that have to be set again.
 */
export async function loadAlerts(dir) {
  let raw;
  try {
    raw = await readFile(alertsFile(dir), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[midorii] could not read the stored alerts', err);
    }
    return [];
  }

  try {
    const record = JSON.parse(raw);
    if (record?.version !== VERSION || !Array.isArray(record.alerts)) {
      console.warn('[midorii] the stored alerts are not a record this version can read');
      return [];
    }
    return record.alerts;
  } catch (err) {
    console.error('[midorii] the stored alerts could not be parsed', err);
    return [];
  }
}

/** Store the whole list, replacing what was there. */
export async function saveAlerts(dir, alerts) {
  const record = { version: VERSION, alerts, savedAt: Date.now() };
  await writeAtomic(alertsFile(dir), record);
  return { savedAt: record.savedAt };
}
