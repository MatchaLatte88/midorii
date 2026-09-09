// The journal file itself: Midorii's own record of what has been traded on a real account.
// Two things must hold, and they pull in opposite directions — nothing that happened may be
// missing, and nothing may be counted twice. A missing trade is noticed; a duplicated one is
// believed. Plain JS, like the other store tests: it touches node:fs, which the renderer's
// TypeScript build has no types for.
// See app/electron/data/store/liveTradeStore.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendLiveTrade, clearLiveTrades, loadLiveTrades, settleLiveTrade } from '../app/electron/data/store/liveTradeStore.js';

const trade = (over = {}) => ({
    id: 'deal-1', symbol: 'EURUSD', side: 'long', size: 1000,
    entryPrice: 1.09, exitPrice: 1.095, openedAt: 1_000, closedAt: 2_000,
    netPnl: 5, fees: 0, estimated: false, live: true, exitTag: 'manual', currency: 'EUR', ...over,
});

describe('the journal on disk', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'midorii-journal-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('reads as empty before anything has been written', async () => {
        expect(await loadLiveTrades(dir)).toEqual([]);
    });

    it('keeps trades in the order they happened', async () => {
        await appendLiveTrade(dir, trade({ id: 'a', closedAt: 1 }));
        await appendLiveTrade(dir, trade({ id: 'b', closedAt: 2 }));
        expect((await loadLiveTrades(dir)).map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('refuses the same closure twice', async () => {
        expect((await appendLiveTrade(dir, trade())).added).toBe(true);
        // Two overlapping reads can both notice the same position is gone.
        expect((await appendLiveTrade(dir, trade())).added).toBe(false);
        expect(await loadLiveTrades(dir)).toHaveLength(1);
    });

    it('fills in an estimate once the venue confirms it', async () => {
        await appendLiveTrade(dir, trade({ estimated: true, exitPrice: 1.0949, netPnl: 4.9 }));
        expect(await settleLiveTrade(dir, 'deal-1', { exitPrice: 1.0952, netPnl: 5.2, fees: 0.1 })).toBe(true);
        const [t] = await loadLiveTrades(dir);
        expect(t).toMatchObject({ exitPrice: 1.0952, netPnl: 5.2, fees: 0.1, estimated: false });
    });

    it('will not overwrite a trade the venue already confirmed', async () => {
        await appendLiveTrade(dir, trade({ estimated: false, netPnl: 5 }));
        // A late retry must not be able to rewrite a fact.
        expect(await settleLiveTrade(dir, 'deal-1', { netPnl: 999 })).toBe(false);
        expect((await loadLiveTrades(dir))[0].netPnl).toBe(5);
    });

    it('empties only when asked', async () => {
        await appendLiveTrade(dir, trade());
        await clearLiveTrades(dir);
        expect(await loadLiveTrades(dir)).toEqual([]);
    });
});
