/* Whether the live feed is being recorded — one small file.
 *
 * On unless it has been switched off. A day that was not recorded can never be recorded
 * afterwards, and the cost of recording one nobody replays is some megabytes; the other way
 * round is a morning worth practising that is simply gone. Settings shows how much the
 * recordings take and switches it off.
 *
 * On disk in the main process rather than in the renderer's storage, because the recorder
 * lives here and has to know before the first tick arrives — which can be before the window
 * has said anything at all.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'recorder.json';

export async function loadRecorderEnabled(dir) {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, FILE), 'utf8'));
    return raw?.enabled !== false;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error('[midorii] could not read whether the feed is recorded — recording', err);
    }
    return true;
  }
}

export async function saveRecorderEnabled(dir, enabled) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ enabled: enabled === true }), 'utf8');
  await rename(tmp, file);
  return enabled === true;
}
