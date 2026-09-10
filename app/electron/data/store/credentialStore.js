/* Broker credentials on disk, encrypted by the operating system.
 *
 * These are not settings. An API key and its password are the keys to an account that holds
 * money, and the difference between them and everything else this app stores is that a
 * plain-text copy is a standing risk rather than an inconvenience. So they go through
 * Electron's `safeStorage`, which encrypts with a key held by the OS keychain — DPAPI on
 * Windows, the Keychain on macOS, libsecret where it exists on Linux. The ciphertext on disk
 * is useless on another machine, and useless to another user on this one.
 *
 * The secret never goes back to the renderer. A screen that edits credentials does not need
 * to READ them — it needs to know whether they are set and to be able to replace them — so
 * `readPublic` answers exactly that and nothing more. There is no channel that hands the
 * secret back out, which means there is no bug that can accidentally put it on screen or
 * in a log.
 *
 * Where encryption is unavailable (a Linux box with no keyring), storing is REFUSED rather
 * than quietly falling back to plain text. A person who was told their password was kept
 * safely would have no way of finding out otherwise.
 */
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';

const CREDENTIALS_FILE = 'brokers.json';

/** The shape this version writes. A record from the future is not guessed at. */
const VERSION = 1;

function credentialsFile(dir) {
  return path.join(dir, CREDENTIALS_FILE);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/** Whether this machine can encrypt at all. */
export function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function readFileRecord(dir) {
  let raw;
  try {
    raw = await readFile(credentialsFile(dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const data = JSON.parse(raw);
  return data?.version === VERSION ? data : null;
}

/**
 * What a screen may know about the stored credentials: everything except the secrets.
 *
 * The identifier comes back because it is what the person recognises the account by, and it
 * is not what protects it. The API key and the password never do.
 */
export async function readPublic(dir, provider) {
  const record = await readFileRecord(dir);
  const entry = record?.brokers?.[provider];
  if (!entry) return { configured: false, identifier: null, env: null, hasSecret: false };
  return {
    configured: true,
    identifier: entry.identifier ?? null,
    env: entry.env ?? 'demo',
    hasSecret: typeof entry.secret === 'string' && entry.secret.length > 0,
    savedAt: entry.savedAt ?? null,
  };
}

/**
 * The full credentials, for the main process alone.
 *
 * Never exposed over IPC. Returns null where nothing is stored or where the ciphertext
 * cannot be read — a key rotated by the OS, or a file copied from another machine — which
 * is a case to report as "not configured" rather than to crash on.
 */
export async function readSecret(dir, provider) {
  const record = await readFileRecord(dir);
  const entry = record?.brokers?.[provider];
  if (!entry?.secret) return null;
  let decrypted;
  try {
    decrypted = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
  } catch {
    return null;
  }
  try {
    const secret = JSON.parse(decrypted);
    return { identifier: entry.identifier ?? null, env: entry.env ?? 'demo', ...secret };
  } catch {
    return null;
  }
}

/**
 * Store one provider's credentials, encrypted.
 *
 * `identifier` and `env` are kept in the clear because a screen has to show them; the API key
 * and the password or secret key are encrypted together as one blob, so neither can be read without the
 * OS key.
 */
export async function saveCredentials(dir, provider, { identifier = null, env, apiKey, password, secretKey }) {
  if (!encryptionAvailable()) {
    throw new Error(
      'This machine cannot encrypt stored secrets, so Midorii will not write them to disk. '
      + 'On Linux this usually means no keyring is running. Use a .env.local file instead.',
    );
  }
  const record = (await readFileRecord(dir)) ?? { version: VERSION, brokers: {} };
  const privatePart = { apiKey };
  if (password != null) privatePart.password = password;
  if (secretKey != null) privatePart.secretKey = secretKey;
  const blob = safeStorage.encryptString(JSON.stringify(privatePart)).toString('base64');
  record.brokers[provider] = {
    identifier,
    env: env === 'live' ? 'live' : 'demo',
    secret: blob,
    savedAt: Date.now(),
  };
  await writeAtomic(credentialsFile(dir), record);
}

/** Forget one provider's credentials. */
export async function clearCredentials(dir, provider) {
  const record = await readFileRecord(dir);
  if (!record?.brokers?.[provider]) return false;
  delete record.brokers[provider];
  if (Object.keys(record.brokers).length === 0) {
    // Nothing left to keep — remove the file rather than leaving an empty shell behind.
    await unlink(credentialsFile(dir)).catch(() => {});
    return true;
  }
  await writeAtomic(credentialsFile(dir), record);
  return true;
}
