// The dock's account line for a venue account, worked out from its closed trades alone.
import { describe, it, expect } from 'vitest';
import { historyStats } from '../app/renderer/trading/accountStats';
import type { HistoryRow } from '../app/renderer/replay/tradeBook';

const row = (netPnl: number, fees = 0): HistoryRow => ({
    side: 'long', size: 1, entryPrice: 100, exitPrice: 101, openedAt: 0, closedAt: 0, netPnl, fees, r: null, exitTag: null,
});

describe('the account line from closed trades', () => {
    it('totals, counts and measures the return against the balance the stretch started from', () => {
        // Newest first: +300, then −200, then +100 — the balance now is 10,200.
        const stats = historyStats([row(300, 4), row(-200, 4), row(100, 4)], 10_200);
        expect(stats.netPnl).toBe(200);
        expect(stats.tradeCount).toBe(3);
        expect(stats.winRate).toBeCloseTo(2 / 3);
        expect(stats.feesPaid).toBe(12);
        expect(stats.returnPct).toBeCloseTo(200 / 10_000);
        // Peak 10,100 after the oldest trade, trough 9,900 after the next.
        expect(stats.maxDrawdownPct).toBeCloseTo(200 / 10_100);
    });

    it('reports no win rate and no percentages it cannot measure', () => {
        expect(historyStats([], 10_000)).toMatchObject({ netPnl: 0, tradeCount: 0, winRate: null, returnPct: 0, maxDrawdownPct: 0 });
        expect(historyStats([row(50)], 0)).toMatchObject({ returnPct: 0, maxDrawdownPct: 0 });
    });
});
