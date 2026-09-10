// The bot runtime is a safety boundary: a missing file means a new bot, while a corrupt
// file may contain daily limits or venue ids that cannot safely be guessed. These tests
// exercise the real JSON store and its one supported migration.
// See app/electron/data/store/botAccountStore.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBotAccount, saveBotAccount } from '../app/electron/data/store/botAccountStore.js';

const guards = {
    dayKey: '2026-09-10',
    dayOpenEquity: 9_950,
    tradesToday: 2,
    lastLossAt: 1_789_000_000_000,
};

const capital = {
    initialized: true,
    positionDealIds: ['position-1'],
    workingOrderDealIds: ['order-1'],
    uncertain: false,
};

describe('a bot runtime on disk', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-bot-runtime-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('returns null only when no runtime exists', async () => {
        expect(await loadBotAccount(dir, 'bot_missing')).toBeNull();
    });

    it('reads the previous paper-account format', async () => {
        await writeFile(path.join(dir, 'bot_legacy.json'), JSON.stringify({
            version: 1,
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            savedAt: 123,
        }));

        expect(await loadBotAccount(dir, 'bot_legacy')).toEqual({
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            savedAt: 123,
        });
    });

    it('round-trips a paper account with its daily guards', async () => {
        await saveBotAccount(dir, 'bot_paper', {
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            guards,
        });

        const stored = await loadBotAccount(dir, 'bot_paper');
        expect(stored).toMatchObject({
            symbol: 'fake:TEST',
            session: { broker: { trades: [] } },
            guards,
        });
        expect(stored.savedAt).toEqual(expect.any(Number));
    });

    it('round-trips live ownership without inventing a paper account', async () => {
        await saveBotAccount(dir, 'bot_live', {
            symbol: 'capital:EURUSD',
            guards,
            capital,
        });

        const stored = await loadBotAccount(dir, 'bot_live');
        expect(stored).toMatchObject({ symbol: 'capital:EURUSD', guards, capital });
        expect('session' in stored).toBe(false);
    });

    it('rejects malformed JSON instead of starting from empty state', async () => {
        await writeFile(path.join(dir, 'bot_broken.json'), '{"version":2,');
        await expect(loadBotAccount(dir, 'bot_broken')).rejects.toThrow(/unreadable/i);
    });

    it('rejects a future format instead of guessing at its safety fields', async () => {
        await writeFile(path.join(dir, 'bot_future.json'), JSON.stringify({
            version: 99,
            symbol: 'capital:EURUSD',
            guards,
            capital,
        }));
        await expect(loadBotAccount(dir, 'bot_future')).rejects.toThrow(/not supported/i);
    });
});
