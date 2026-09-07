// A paper account that has to be right after weeks, not after ten minutes.
//
// Three things have to hold for that: the worst drawdown is measured on every tick
// and not on the points that happen to be stored; the curve stays bounded however
// long the account runs, without losing a trade; and an account picked back up is
// the SAME account — its age, its peak and its deepest hole come back with it.
import { describe, expect, it } from 'vitest';

import { LiveSession } from '../shared/engine/liveSession.js';
import type { LiveBar } from '../shared/engine/liveSession.js';

const T0 = Date.UTC(2024, 0, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function bar(time: number, close: number, high = close, low = close): LiveBar {
    return { time, open: close, high: Math.max(high, close), low: Math.min(low, close), close, volume: 0 };
}

/** A session with costs off, so a fill lands on the price and nothing else. */
function session(balance = 10_000): LiveSession {
    return new LiveSession({ balance, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } });
}

describe('what the account remembers', () => {
    it('measures the worst drawdown on every tick, not on the stored points', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        s.buy({ size: 10 });

        // A dip and a full recovery, both inside one sampling interval — so neither is
        // a stored point, and a curve-derived drawdown would report nothing at all.
        s.onBar(bar(T0 + MINUTE, 90));
        s.onBar(bar(T0 + 2 * MINUTE, 100));

        expect(s.maxDrawdown).toBe(100); // 10 units × 10 of price
        expect(s.maxDrawdownPct).toBeCloseTo(100 / 10_000, 10);
        expect(s.stats().maxDrawdown).toBe(100);
    });

    it('keeps a point for every trade, whatever the sampling', () => {
        const s = session();
        s.onBar(bar(T0, 100));

        for (let i = 0; i < 5; i++) {
            s.buy({ size: 1 });
            s.onBar(bar(T0 + (i + 1) * MINUTE, 101 + i));
            s.close();
        }

        const settlements = s.equityCurve.filter((p, i) => i > 0 && p.balance !== s.equityCurve[i - 1]!.balance);
        expect(s.broker.trades).toHaveLength(5);
        expect(settlements).toHaveLength(5);
    });

    it('does not grow a point per tick while nothing settles', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        // Two hundred ticks inside one sampling interval.
        for (let i = 1; i <= 200; i++) s.onBar(bar(T0 + i * 1000, 100 + i * 0.01));

        expect(s.equityCurve.length).toBeLessThanOrEqual(2);
        // The tail is still the account as it stands, not where it was 200 ticks ago.
        expect(s.equityCurve[s.equityCurve.length - 1]!.time).toBe(T0 + 200 * 1000);
    });

    it('takes a point once a sampling interval has passed, so a week is not a straight line', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        for (let i = 1; i <= 8; i++) s.onBar(bar(T0 + i * HOUR, 100));

        // 15-minute sampling over 8 hours, but only one update per hour: one point each.
        expect(s.equityCurve).toHaveLength(9);
    });

    it('reports the same net result as the account itself', () => {
        const s = session(1_000);
        s.onBar(bar(T0, 10));
        s.buy({ size: 10 });
        s.onBar(bar(T0 + MINUTE, 12));
        s.close();

        const stats = s.stats();
        expect(stats.tradeCount).toBe(1);
        expect(stats.netPnl).toBe(20);
        expect(stats.netPnl).toBe(s.broker.equity - s.broker.initialBalance);
        expect(stats.returnPct).toBeCloseTo(0.02, 10);
        expect(stats.winRate).toBe(1);
    });
});

describe('an account picked back up', () => {
    it('is the same account, not a new one that looks like it', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        s.buy({ size: 10 });
        s.onBar(bar(T0 + MINUTE, 90)); // a hole, then out of it
        s.onBar(bar(T0 + 2 * MINUTE, 105));
        s.close();

        const back = LiveSession.restore(JSON.parse(JSON.stringify(s.snapshot())));

        expect(back.createdAt).toBe(s.createdAt);
        expect(back.firstBarTime).toBe(T0);
        expect(back.maxDrawdown).toBe(s.maxDrawdown);
        expect(back.maxDrawdown).toBeGreaterThan(0);
        expect(back.peakEquity).toBe(s.peakEquity);
        expect(back.equityCurve).toEqual(s.equityCurve);
        expect(back.stats()).toEqual(s.stats());
    });

    it('carries its drawdown forward instead of starting the hole again', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        s.buy({ size: 10 });
        s.onBar(bar(T0 + MINUTE, 80)); // −200
        s.close();
        const deepest = s.maxDrawdown;
        expect(deepest).toBe(200);

        const back = LiveSession.restore(JSON.parse(JSON.stringify(s.snapshot())));
        expect(back.maxDrawdown).toBe(deepest);

        /* A move that leaves the account above where it has already been must not touch
         * the worst — the drawdown is measured from the PEAK, and the peak came back too.
         * Without that, a restart would report the deepest hole the account ever sat in
         * as whatever happened since breakfast. */
        back.buy({ size: 1 });
        back.onBar(bar(T0 + 2 * MINUTE, 80.5));

        expect(back.peakEquity).toBe(s.peakEquity);
        expect(back.maxDrawdown).toBe(deepest);

        // Going genuinely lower than ever before does move it, which is the other half.
        back.onBar(bar(T0 + 3 * MINUTE, 60));
        expect(back.maxDrawdown).toBeGreaterThan(deepest);
    });

    it('answers with a run in the shape the library stores', () => {
        const s = session();
        s.onBar(bar(T0, 100));
        s.buy({ size: 1 });
        s.onBar(bar(T0 + MINUTE, 110));
        s.close();

        const run = s.result({ resolution: '1' });
        expect(run.from).toBe(T0);
        expect(run.to).toBe(T0 + MINUTE);
        expect(run.trades).toHaveLength(1);
        expect(run.initialBalance).toBe(10_000);
        expect(run.resolution).toBe('1');
        expect(run.stats.netPnl).toBeCloseTo(10, 10);
        expect(run.equityCurve.length).toBeGreaterThan(0);
    });
});

describe('a curve that has to survive months', () => {
    it('thins its marks rather than growing without limit', () => {
        const s = session();
        s.onBar(bar(T0, 100));

        /* Two hundred thousand sampling intervals — years of an account nobody traded.
         * The cap is 20,000 points, and the sample rate halves each time it is hit. */
        let t = T0;
        for (let i = 0; i < 60_000; i++) {
            t += 16 * MINUTE;
            s.onBar(bar(t, 100));
        }

        expect(s.equityCurve.length).toBeLessThanOrEqual(20_001);
        expect(s.sampleMs).toBeGreaterThan(15 * MINUTE);
        // The curve still spans the whole life of the account.
        expect(s.equityCurve[0]!.time).toBe(T0);
        expect(s.equityCurve[s.equityCurve.length - 1]!.time).toBe(t);
    });
});
