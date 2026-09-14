// Moving a Capital.com session between the demo and the live account, on one stored key.
//
// The order is the whole of it. `switchCapitalEnvironment` tries the other side on a session
// of its own and only replaces the running configuration once that login actually worked —
// so a key the venue has not issued for the other side leaves the account in use untouched.
// Getting this wrong in the permissive direction points the app at an endpoint it could not
// reach, on the one venue here where the two accounts differ by being real money.
// See app/electron/data/capital.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — capital.js is main-process JavaScript with no type declarations.
import { capitalEnvironment, configureCapital, switchCapitalEnvironment } from '../app/electron/data/capital.js';

const CREDS = { apiKey: 'k', identifier: 'me@example.com', password: 'p', env: 'demo' as const };

/** A login that succeeds, followed by the account list `capitalProbe` reads after it. */
function reachable(accounts: unknown[] = []): typeof fetch {
    return vi.fn(async (url: unknown) => {
        if (String(url).endsWith('/session')) {
            return {
                ok: true,
                headers: new Headers({ cst: 'cst-token', 'x-security-token': 'sec-token' }),
            } as unknown as Response;
        }
        return { ok: true, json: async () => ({ accounts }) } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** A login the venue turns away, the way it turns away a key issued for the other side. */
function refused(errorCode = 'error.invalid.api.key'): typeof fetch {
    return vi.fn(async () => ({
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => ({ errorCode }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('switchCapitalEnvironment', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        configureCapital(CREDS);
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        configureCapital(null);
        vi.restoreAllMocks();
    });

    it('moves the session to the other account and reports the one it reached', async () => {
        globalThis.fetch = reachable([
            { accountId: 'A1', accountName: 'Live', currency: 'EUR', preferred: true, balance: { balance: 10, available: 9 } },
        ]);
        const result = await switchCapitalEnvironment('live');
        expect(result.env).toBe('live');
        expect(capitalEnvironment()).toMatchObject({ configured: true, env: 'live', live: true });
        // Not merely "accepted" — whose money this now is.
        expect(result.accounts).toHaveLength(1);
        expect(result.accounts[0]).toMatchObject({ accountId: 'A1', accountName: 'Live' });
    });

    it('leaves the account in use alone when the other side refuses the key', async () => {
        globalThis.fetch = refused();
        await expect(switchCapitalEnvironment('live')).rejects.toThrow(/api key/i);
        // The refusal must not have moved anything: this is the assurance the ordering exists for.
        expect(capitalEnvironment()).toMatchObject({ env: 'demo', live: false });
    });

    it('keeps the credentials it was given — only the endpoint changes', async () => {
        const fetcher = reachable();
        globalThis.fetch = fetcher;
        await switchCapitalEnvironment('live');
        const [url, init] = (fetcher as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]!;
        expect(url).toContain('api-capital.backend-capital.com');
        expect(url).not.toContain('demo-api-capital');
        expect(JSON.parse(init.body)).toMatchObject({ identifier: CREDS.identifier, password: CREDS.password });
    });

    it('reads anything that is not "live" as the demo account', async () => {
        globalThis.fetch = reachable();
        await switchCapitalEnvironment('live');
        expect(capitalEnvironment().live).toBe(true);
        // The field is a switch between two, never a third thing.
        expect((await switchCapitalEnvironment('something else')).env).toBe('demo');
        expect(capitalEnvironment().live).toBe(false);
    });

    it('confirms the account already on without dropping its session', async () => {
        globalThis.fetch = reachable([{ accountId: 'D1', accountName: 'Demo', currency: 'EUR', preferred: true }]);
        const result = await switchCapitalEnvironment('demo');
        expect(result.env).toBe('demo');
        expect(result.accounts).toHaveLength(1);
        expect(capitalEnvironment()).toMatchObject({ env: 'demo', live: false });
    });

    it('refuses to switch when no credentials are configured at all', async () => {
        configureCapital(null);
        await expect(switchCapitalEnvironment('live')).rejects.toThrow(/not connected/i);
    });
});
