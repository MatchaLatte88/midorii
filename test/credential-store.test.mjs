import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The credential store, with Electron's keychain stubbed.
 *
 * `safeStorage` is the one thing here that cannot run outside Electron, and also the one
 * thing that does not need to: what these tests are about is which FIELDS survive the round
 * trip, not whether the OS encrypts them. The stub is reversible rather than real, so a
 * field dropped on the way in still shows up as missing on the way out.
 *
 * A .mjs test, like the other store tests — it reaches for node:fs and a temp directory,
 * which the typechecked .ts tests in this project are not set up for.
 */
vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
    },
}));

let store;
let dir;

beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'midorii-creds-'));
    vi.resetModules();
    store = await import('../app/electron/data/store/credentialStore.js');
    return () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
});

describe('credential round trip', () => {
    it('gives back the login name and the environment it was saved with', async () => {
        await store.saveCredentials(dir, 'capital', {
            identifier: 'trader@example.com', env: 'live', apiKey: 'key', password: 'pw',
        });
        expect(await store.readSecret(dir, 'capital')).toMatchObject({
            identifier: 'trader@example.com', env: 'live', apiKey: 'key', password: 'pw',
        });
    });

    /**
     * The bug this pins: anything beyond the known fields used to be destructured away and
     * silently dropped. Nothing failed — the save resolved, and the connection then came
     * back from disk missing the field it needed, which looked like a broker refusing a
     * perfectly good key.
     */
    it('keeps fields it does not know about, rather than dropping them', async () => {
        await store.saveCredentials(dir, 'projectx', {
            identifier: 'matcha', env: 'demo', apiKey: 'key',
            base: 'https://api.thefuturesdesk.projectx.com',
            hub: 'https://rtc.thefuturesdesk.projectx.com/hubs/market',
        });
        expect(await store.readSecret(dir, 'projectx')).toMatchObject({
            identifier: 'matcha',
            env: 'demo',
            apiKey: 'key',
            base: 'https://api.thefuturesdesk.projectx.com',
            hub: 'https://rtc.thefuturesdesk.projectx.com/hubs/market',
        });
    });

    it('shows the extras on the public record too, so a screen can display them', async () => {
        await store.saveCredentials(dir, 'projectx', {
            identifier: 'matcha', env: 'demo', apiKey: 'key', base: 'https://example.test',
        });
        expect(await store.readPublic(dir, 'projectx')).toMatchObject({
            configured: true, identifier: 'matcha', env: 'demo', hasSecret: true, base: 'https://example.test',
        });
    });

    it('never puts the secret on the public record, whatever else it carries', async () => {
        await store.saveCredentials(dir, 'projectx', {
            identifier: 'matcha', env: 'demo', apiKey: 'the-key', base: 'https://example.test',
        });
        const pub = await store.readPublic(dir, 'projectx');
        expect(JSON.stringify(pub)).not.toContain('the-key');
        expect(pub.secret).toBeUndefined();
        expect(pub.apiKey).toBeUndefined();
    });

    it('keeps one provider out of another', async () => {
        await store.saveCredentials(dir, 'capital', { identifier: 'a@example.com', env: 'demo', apiKey: 'k1', password: 'p' });
        await store.saveCredentials(dir, 'projectx', { identifier: 'matcha', env: 'live', apiKey: 'k2', base: 'https://example.test' });
        expect(await store.readSecret(dir, 'capital')).toMatchObject({ identifier: 'a@example.com', apiKey: 'k1' });
        expect(await store.readSecret(dir, 'projectx')).toMatchObject({ identifier: 'matcha', apiKey: 'k2', base: 'https://example.test' });
        // The capital entry gained nothing from its neighbour.
        expect((await store.readSecret(dir, 'capital')).base).toBeUndefined();
    });

    it('reports nothing stored as exactly that', async () => {
        expect(await store.readPublic(dir, 'projectx')).toMatchObject({ configured: false, identifier: null, hasSecret: false });
        expect(await store.readSecret(dir, 'projectx')).toBeNull();
    });

    it('forgets a provider without touching the others', async () => {
        await store.saveCredentials(dir, 'capital', { identifier: 'a@example.com', env: 'demo', apiKey: 'k1', password: 'p' });
        await store.saveCredentials(dir, 'projectx', { identifier: 'matcha', env: 'demo', apiKey: 'k2' });
        expect(await store.clearCredentials(dir, 'projectx')).toBe(true);
        expect(await store.readSecret(dir, 'projectx')).toBeNull();
        expect(await store.readSecret(dir, 'capital')).toMatchObject({ apiKey: 'k1' });
    });
});
