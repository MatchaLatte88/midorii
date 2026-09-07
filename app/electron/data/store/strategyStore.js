/* What each strategy is set to — one small file, rewritten whenever it changes.
 *
 * Not a library of results and not a working session: this is configuration. A strategy
 * has settings the way an indicator has settings, and they belong to the strategy rather
 * than to any one run — which is exactly why they live here and not in the run store. A
 * backtest starts from them and may override them for that run; what it stores is what it
 * actually ran with, so the two never have to agree afterwards.
 *
 * On disk rather than in the renderer's own storage on purpose. Browser storage is keyed by
 * origin, and this app is served from a dev server in development and from a file in a
 * packaged build — settings kept there would quietly not be the same settings.
 *
 * The values are stored as they arrive and validated where the schema is, in the renderer.
 * Nothing here knows what a reward-to-risk is, and a build that renames a parameter must
 * not be met with a file that silently drops it: the renderer resolves what it reads
 * against the current schema, and says so when what was stored no longer fits.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const FILE = 'strategies.json';

/** A cap on one strategy's settings, so a bad caller cannot write a megabyte of them. */
const MAX_KEYS = 100;

/** Ids are keys in one object, but they still reach a file, so they stay plain. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function settingsPath(dir) {
  return path.join(dir, FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

/**
 * Every strategy's stored settings, keyed by id.
 *
 * An unreadable file answers as empty rather than throwing: settings are a convenience, and
 * losing them must not stop the app from opening. The next save rewrites it.
 */
export async function loadStrategySettings(dir) {
  const file = settingsPath(dir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Replaces one strategy's settings and answers with the whole set. */
export async function saveStrategySettings(dir, id, params) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid strategy id: ${JSON.stringify(id)}`);
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('saveStrategySettings: the settings must be an object');
  }
  if (Object.keys(params).length > MAX_KEYS) {
    throw new Error(`saveStrategySettings: ${Object.keys(params).length} settings is more than a strategy has`);
  }

  const all = await loadStrategySettings(dir);
  all[id] = params;
  await writeAtomic(settingsPath(dir), all);
  return all;
}

/** Forgets one strategy's settings, so it falls back to its own defaults. */
export async function clearStrategySettings(dir, id) {
  const all = await loadStrategySettings(dir);
  if (!(id in all)) return all;
  delete all[id];
  await writeAtomic(settingsPath(dir), all);
  return all;
}
