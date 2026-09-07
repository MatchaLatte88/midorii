/* Minimal `.env.local` loader — no dotenv dependency needed for four variables.
 *
 * `.env.local` is git-ignored (see .gitignore) and never written by the app itself;
 * the user edits it by hand. A real OS environment variable always wins over a file
 * value, matching the usual dotenv convention. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadEnvLocal(rootDir) {
  const file = path.join(rootDir, '.env.local');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // no .env.local — nothing to load, real env vars still apply
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
