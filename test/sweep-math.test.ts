import { describe, it, expect } from 'vitest';
import {
    MAX_COMBINATIONS, bestAndWorst, countCombinations, detectionCount, expandRange, expandSweep,
    rankResults, splitRange,
} from '../shared/analysis/sweep.js';
import type { SweepEntry, SweepStats } from '../shared/analysis/sweep';

/** A result with only the figures ranking reads. */
function entry(params: Record<string, number>, stats: Partial<SweepStats>): SweepEntry {
    return {
        params,
        stats: {
            tradeCount: 20,
            netPnl: 0,
            returnPct: 0,
            winRate: 0.5,
            maxDrawdownPct: 0.1,
            profitFactor: 1,
            expectancy: 0,
            feesPaid: 0,
            ...stats,
        },
    };
}

describe('expanding a range', () => {
    it('includes both ends when the step lands on them', () => {
        expect(expandRange({ from: 1, to: 3, step: 1 })).toEqual([1, 2, 3]);
    });

    it('stops rather than overshooting the end', () => {
        expect(expandRange({ from: 4, to: 20, step: 7 })).toEqual([4, 11, 18]);
    });

    it('reads a range of one value as that value', () => {
        expect(expandRange({ from: 5, to: 5, step: 1 })).toEqual([5]);
    });

    it('does not accumulate floating-point error', () => {
        // Walked by repeated addition this arrives at 1.9000000000000001 and stores it.
        const values = expandRange({ from: 1.2, to: 3, step: 0.1 });
        expect(values).toContain(1.9);
        expect(values[values.length - 1]).toBe(3);
        expect(values.every((v) => String(v).replace(/^-?\d+\.?/, '').length <= 1)).toBe(true);
    });

    it('refuses a step that cannot walk a range', () => {
        expect(() => expandRange({ from: 1, to: 3, step: 0 })).toThrow(/positive/);
        expect(() => expandRange({ from: 3, to: 1, step: 1 })).toThrow(/before/);
        expect(() => expandRange({ from: NaN, to: 3, step: 1 })).toThrow(/numbers/);
    });
});

describe('counting before running', () => {
    it('multiplies the axes', () => {
        expect(countCombinations({
            rrr: { from: 1, to: 3, step: 1 },        // 3
            riskValue: { from: 1, to: 2, step: 0.5 }, // 3
        })).toBe(9);
    });

    it('is zero when nothing is swept', () => {
        expect(countCombinations({})).toBe(0);
    });

    it('counts only the parameters that change the detection', () => {
        const ranges = {
            rrr: { from: 1, to: 4, step: 1 },       // 4, traded differently
            strength: { from: 2, to: 4, step: 1 },  // 3, detected differently
        };
        expect(countCombinations(ranges)).toBe(12);
        expect(detectionCount(ranges, ['strength'])).toBe(3);
        // Nothing swept touches the detection: one detection covers the whole sweep.
        expect(detectionCount(ranges, ['minGapSize'])).toBe(1);
    });
});

describe('expanding a sweep', () => {
    it('varies the last key fastest, so the list reads as a table', () => {
        const out = expandSweep({
            a: { from: 1, to: 2, step: 1 },
            b: { from: 10, to: 20, step: 10 },
        });
        expect(out).toEqual([
            { a: 1, b: 10 }, { a: 1, b: 20 },
            { a: 2, b: 10 }, { a: 2, b: 20 },
        ]);
    });

    it('carries the fixed settings into every combination', () => {
        const out = expandSweep({ a: { from: 1, to: 2, step: 1 } }, { riskMode: 'percent' });
        expect(out).toEqual([
            { riskMode: 'percent', a: 1 },
            { riskMode: 'percent', a: 2 },
        ]);
    });

    it('refuses a slip before anything starts rather than after an hour of it', () => {
        // A step of 0.001 where 0.1 was meant.
        expect(() => expandSweep({ a: { from: 0, to: 1000, step: 0.001 } }))
            .toThrow(/over the limit/);
        expect(MAX_COMBINATIONS).toBeGreaterThan(0);
    });
});

describe('ranking', () => {
    const results = [
        entry({ rrr: 1 }, { expectancy: 5, netPnl: 100, tradeCount: 20 }),
        entry({ rrr: 2 }, { expectancy: 9, netPnl: 90, tradeCount: 10 }),
        entry({ rrr: 3 }, { expectancy: 50, netPnl: 150, tradeCount: 3 }),
        entry({ rrr: 4 }, { expectancy: null, netPnl: 0, tradeCount: 0 }),
    ];

    it('sets aside what has too few trades to be evidence either way', () => {
        const { ranked, excluded } = rankResults(results, 'expectancy', 10);

        // The 50-per-trade combination fired three times. It is not the best of anything.
        expect(ranked.map((r) => r.params.rrr)).toEqual([2, 1]);
        expect(excluded.map((r) => r.params.rrr)).toEqual([3, 4]);
    });

    it('sorts a missing figure last, because an absence is not a high score', () => {
        const { ranked } = rankResults([
            entry({ rrr: 1 }, { profitFactor: null }),
            entry({ rrr: 2 }, { profitFactor: 1.4 }),
        ], 'profitFactor', 0);
        expect(ranked.map((r) => r.params.rrr)).toEqual([2, 1]);
    });

    it('orders by the metric it was asked for', () => {
        const byPnl = rankResults(results, 'netPnl', 10).ranked;
        expect(byPnl.map((r) => r.params.rrr)).toEqual([1, 2]);
    });

    it('refuses a metric it cannot read', () => {
        expect(() => rankResults(results, 'sharpe' as never)).toThrow(/unknown metric/);
    });
});

describe('both ends', () => {
    const ranked = [1, 2, 3, 4, 5, 6].map((n) => entry({ rrr: n }, { expectancy: 10 - n }));

    it('reports the best and the worst, worst first from the bottom', () => {
        const { best, worst, overlapping } = bestAndWorst(ranked, 2);
        expect(best.map((r) => r.params.rrr)).toEqual([1, 2]);
        expect(worst.map((r) => r.params.rrr)).toEqual([6, 5]);
        expect(overlapping).toBe(false);
    });

    it('says so when the two ends are the same rows', () => {
        expect(bestAndWorst(ranked.slice(0, 3), 2).overlapping).toBe(true);
    });
});

describe('splitting the range', () => {
    it('optimises on the earlier stretch and checks against the later one', () => {
        const { train, test } = splitRange(0, 1000, 0.7);
        expect(train).toEqual({ from: 0, to: 700 });
        expect(test).toEqual({ from: 700, to: 1000 });
    });

    it('refuses a fraction that leaves one side empty', () => {
        expect(() => splitRange(0, 1000, 1)).toThrow(/between 0 and 1/);
        expect(() => splitRange(0, 1000, 0)).toThrow(/between 0 and 1/);
    });

    it('refuses a range that does not move forward', () => {
        expect(() => splitRange(1000, 1000)).toThrow(/must end after it starts/);
    });
});
