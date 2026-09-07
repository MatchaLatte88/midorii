import { describe, it, expect } from 'vitest';
import { tradeBreakdown, type AnalysisTrade } from '../app/renderer/analysis/analysisFigures';

const HOUR = 3_600_000;

/** One closed round trip, with only the fields a breakdown reads. */
function trade(over: Partial<AnalysisTrade> = {}): AnalysisTrade {
    return {
        side: 'long',
        size: 1,
        netPnl: 0,
        openedAt: 0,
        closedAt: HOUR,
        riskPerUnit: null,
        ...over,
    };
}

describe('analysis trade breakdown', () => {
    it('reports nothing rather than zeroes for an account that closed nothing', () => {
        const b = tradeBreakdown([]);
        expect(b.long).toEqual({ count: 0, wins: 0, losses: 0, winRate: null, netPnl: 0 });
        expect(b.short.winRate).toBeNull();
        expect(b.best).toBeNull();
        expect(b.worst).toBeNull();
        expect(b.avgHoldMs).toBeNull();
        expect(b.avgR).toBeNull();
        expect(b.rTrades).toBe(0);
        expect(b.maxWinStreak).toBe(0);
        expect(b.maxLossStreak).toBe(0);
    });

    it('splits the book by side and keeps each side’s own win rate', () => {
        const b = tradeBreakdown([
            trade({ side: 'long', netPnl: 100 }),
            trade({ side: 'long', netPnl: -40 }),
            trade({ side: 'long', netPnl: 60 }),
            trade({ side: 'short', netPnl: -25 }),
        ]);
        expect(b.long).toMatchObject({ count: 3, wins: 2, losses: 1, netPnl: 120 });
        expect(b.long.winRate).toBeCloseTo(2 / 3, 10);
        expect(b.short).toMatchObject({ count: 1, wins: 0, losses: 1, netPnl: -25 });
        expect(b.short.winRate).toBe(0);
    });

    it('counts a flat trade in the denominator, as summarize does', () => {
        // A trade that came out exactly even is neither a win nor a loss, but it happened.
        const b = tradeBreakdown([trade({ netPnl: 100 }), trade({ netPnl: 0 })]);
        expect(b.long).toMatchObject({ count: 2, wins: 1, losses: 0 });
        expect(b.long.winRate).toBe(0.5);
    });

    it('takes the best and the worst single result', () => {
        const b = tradeBreakdown([
            trade({ netPnl: -10 }),
            trade({ netPnl: 250 }),
            trade({ netPnl: -300 }),
        ]);
        expect(b.best).toBe(250);
        expect(b.worst).toBe(-300);
    });

    it('averages the holding time, ignoring a span that runs backwards', () => {
        const b = tradeBreakdown([
            trade({ openedAt: 0, closedAt: HOUR }),
            trade({ openedAt: 0, closedAt: 3 * HOUR }),
        ]);
        expect(b.avgHoldMs).toBe(2 * HOUR);

        // A snapshot off disk could carry anything; a negative span is not a holding time.
        const broken = tradeBreakdown([trade({ openedAt: HOUR, closedAt: 0 })]);
        expect(broken.avgHoldMs).toBe(0);
    });

    it('measures the longest run of wins and of losses, which a flat trade ends', () => {
        const b = tradeBreakdown([
            trade({ netPnl: 1 }),
            trade({ netPnl: 1 }),
            trade({ netPnl: -1 }),
            trade({ netPnl: -1 }),
            trade({ netPnl: -1 }),
            trade({ netPnl: 1 }),
            trade({ netPnl: 0 }),
            trade({ netPnl: 1 }),
        ]);
        expect(b.maxWinStreak).toBe(2);
        expect(b.maxLossStreak).toBe(3);
    });

    it('averages R over the trades that carried a stop, and says how many that was', () => {
        const b = tradeBreakdown([
            // 100 made against 50 risked — 2R.
            trade({ netPnl: 100, size: 1, riskPerUnit: 50 }),
            // −50 against 25 risked over two units — −1R.
            trade({ netPnl: -50, size: 2, riskPerUnit: 25 }),
            // No stop: not 0R, simply not in the average.
            trade({ netPnl: 500, riskPerUnit: null }),
        ]);
        expect(b.avgR).toBeCloseTo(0.5, 10);
        expect(b.rTrades).toBe(2);
    });

    it('leaves R unanswered when nothing carried a stop', () => {
        const b = tradeBreakdown([trade({ netPnl: 80 }), trade({ netPnl: -20, riskPerUnit: 0 })]);
        expect(b.avgR).toBeNull();
        expect(b.rTrades).toBe(0);
    });
});
