import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import { detectVwapBands } from '../src/core/analysis/vwapBands';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What VWAP Reversion does with a market that has run from its own average.
 *
 * The numbers are forced by one setup and are worth stating once. Bars are flat — open, high,
 * low and close all the same — so the typical price is exactly the price. Four bars alternating
 * 98 and 102 leave the average at 100 with a deviation of 2; a fifth at 90 pulls the average to
 * 98 and widens the deviation to sqrt(19.2) = 4.3818. At a 1.5-deviation entry the band is then
 * 98 − 6.573 = 91.43, the close at 90 is through it, and the stop a further deviation out sits
 * at 87.046. Risking 1% of 10,000 across 90 − 87.046 buys 33.85 units.
 */

const MIN = 60_000;

/** 09:30 New York in UTC ms. March 2024 from the 11th is EDT, so 13:30 UTC. */
function open930(day: number): number {
    return Date.parse(`2024-03-${day}T13:30:00Z`);
}

function session(day: number, prices: readonly number[], volume = 1): OHLCV[] {
    const t0 = open930(day);
    return prices.map((p, i) => ({ time: t0 + i * MIN, open: p, high: p, low: p, close: p, volume }));
}

/** The signal fires on bar 4 and fills on bar 5. The market then sits at 92, which is neither
 *  the target (98) nor the stop (87.046), so only the clock can end the trade. */
const HELD = [98, 102, 98, 102, 90, 90, 92, 92, 92, 92];

/** The same entry, and the market comes back to the average on bar 6. */
const REVERTS = [98, 102, 98, 102, 90, 90, 98, 98, 98, 98];

/** Stopped out on bar 6, which is itself a fresh crossing and is taken. */
const SECOND_LEG = [98, 102, 98, 102, 90, 90, 80, 80, 100, 100, 80];

/**
 * A session anchored by ten bars before it moves, so the average does not chase price down and
 * bars 11 and 12 stay beyond the band without crossing out of it. Bar 10 closes 2.6 deviations
 * out — past where its own stop would go — and bar 16 is the one clean crossing.
 */
const ANCHORED = [98, 102, 98, 102, 98, 102, 98, 102, 98, 102, 90, 90, 90, 90, 100, 100, 88];

/** No costs, so a fill lands exactly where the rules asked for it. */
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

/** A 1.5-deviation fade with a one-deviation stop, no warm-up and no session cap in the way,
 *  so each test is about the one rule it names. */
const BASE = {
    riskMode: 'percent', riskValue: 1, maxLeverage: 20, rrr: 2,
    session: 'nyse', source: 'HLC3',
    entrySigmas: 1.5, stopSigmas: 1, warmupMinutes: 0,
    lastEntryMin: 15 * 60, flatMin: 15 * 60 + 55, maxEntries: 5,
};

interface Trade {
    side: string;
    size: number;
    entryPrice: number;
    exitPrice: number;
    closedAt: number;
    netPnl: number;
    entryTag: string | null;
    exitTag: string | null;
}

function run(params: Record<string, unknown> = {}, bars: OHLCV[] = session(11, HELD)) {
    const result = runBacktest({
        bars,
        strategy: buildStrategy('vwapreversion', { ...BASE, ...params }, bars),
        broker: FREE,
    });
    return {
        result,
        /* The entries only — the stop and the target the broker hangs under each one are
         * reduceOnly and would otherwise be counted as orders the strategy placed. */
        entries: result.orders.filter((o) => !o.reduceOnly),
        barOf: (time: number | null): number => bars.findIndex((b) => b.time === time),
    };
}

describe('the order a run from the average asks for', () => {
    it('buys the bar that closed beyond the band, at the next bar\'s open', () => {
        const { entries, barOf } = run();

        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.side).toBe('buy');
        expect(entry.type).toBe('market');
        expect(barOf(entry.placedAt)).toBe(4);
        expect(entry.fillPrice).toBe(90);
        expect(entry.tag).toBe('2024-03-11');
    });

    it('targets the VWAP itself and stops a further deviation beyond the band', () => {
        const entry = run().entries[0]!;

        // The average as it stood on the signal bar, frozen there rather than tracked.
        expect(entry.bracket?.takeProfit).toBe(98);
        // The 1.5-deviation band plus one more deviation: the 2.5-deviation line below 98.
        expect(entry.bracket?.stopLoss).toBeCloseTo(98 - 2.5 * Math.sqrt(19.2), 10);
        expect(entry.bracket?.stopLoss).toBeCloseTo(87.0455488, 6);
    });

    it('sizes the position off the risk and the stop, not off the balance', () => {
        // 1% of 10,000 is 100, across 90 − 87.0455 = 2.9545 a unit.
        expect(run().entries[0]!.size).toBeCloseTo(100 / (90 - 87.0455488), 4);
    });

    it('comes off at the average when the market returns to it', () => {
        const { result } = run({}, session(11, REVERTS));
        const trade = result.trades[0] as Trade;

        expect(trade.exitPrice).toBe(98);
        expect(trade.exitTag).toBe('take-profit');
        expect(trade.netPnl).toBeCloseTo(trade.size * 8, 6);
    });
});

describe('which bars are allowed to be a signal', () => {
    it('does not fire again while the market simply stays beyond the band', () => {
        const bars = session(11, ANCHORED);
        const bands = detectVwapBands(bars);
        const z = (i: number): number => (bars[i]!.close - bands.vwap[i]!) / bands.sigma[i]!;

        // Bars 11 and 12 are beyond the band and past the warm-up, and neither is a crossing:
        // the bar before each was already out there.
        expect(z(11)).toBeLessThan(-1.5);
        expect(z(12)).toBeLessThan(-1.5);

        const { entries, barOf } = run({ warmupMinutes: 11 }, bars);
        expect(entries).toHaveLength(1);
        expect(barOf(entries[0]!.placedAt)).toBe(16);
    });

    it('passes over a bar that has already run past where its own stop would go', () => {
        const bars = session(11, ANCHORED);
        const bands = detectVwapBands(bars);

        /* Bar 10 IS a crossing — 2.6 deviations out, from a bar that was inside. But a
         * 1.5-deviation entry with a one-deviation stop puts that stop at 2.5 deviations, which
         * this close is already through: there is no risk distance left to size against. */
        expect((bars[10]!.close - bands.vwap[10]!) / bands.sigma[10]!).toBeLessThan(-2.5);

        const { entries, barOf } = run({}, bars);
        expect(entries.map((o) => barOf(o.placedAt))).toEqual([16]);
    });

    it('takes the next crossing once the trade before it is over', () => {
        // Bar 6 stops the first trade out and is itself a fresh crossing.
        const { entries, barOf, result } = run({}, session(11, SECOND_LEG));

        expect(entries.map((o) => barOf(o.placedAt))).toEqual([4, 6]);
        expect((result.trades as Trade[]).map((t) => t.exitTag)).toEqual(['stop-loss', 'take-profit']);
    });

    it('spends only the session\'s allowance of trades', () => {
        const { entries } = run({ maxEntries: 1 }, session(11, SECOND_LEG));
        expect(entries).toHaveLength(1);
    });

    it('says nothing until the session has run for the warm-up', () => {
        // The crossing on bar 4 is four minutes into the session.
        expect(run({ warmupMinutes: 5 }).entries).toHaveLength(0);
        expect(run({ warmupMinutes: 4 }).entries).toHaveLength(1);
    });

    it('stops opening trades at the last entry time, inclusive', () => {
        // The signal bar completes at 09:35.
        expect(run({ lastEntryMin: 9 * 60 + 34 }).entries).toHaveLength(0);
        expect(run({ lastEntryMin: 9 * 60 + 35 }).entries).toHaveLength(1);
    });
});

describe('how a trade ends when neither level is reached', () => {
    it('comes off on the clock', () => {
        const { result, barOf } = run({ flatMin: 9 * 60 + 37 });
        const trade = result.trades[0] as Trade;

        // Ordered on the bar completing at 09:37 and filled at the next bar's open.
        expect(trade.exitTag).toBe('flat-at');
        expect(barOf(trade.closedAt)).toBe(7);
        expect(trade.exitPrice).toBe(92);
    });

    it('is never carried into the next session, whatever the clock is set to', () => {
        /* Two sessions of cash-hours bars only: no bar here ever reads as outside the window,
         * so the day change is the only thing that can end the trade. Without it the position
         * would ride into a session measured against a different average. */
        const bars = [...session(11, HELD), ...session(12, [92, 92, 92, 92])];
        const { result, barOf } = run({}, bars);
        const trade = result.trades[0] as Trade;

        expect(trade.exitTag).toBe('session-end');
        expect(barOf(trade.closedAt)).toBe(11);
        expect(result.openPosition).toBeNull();
    });
});

describe('data it cannot be run on', () => {
    it('refuses bars with no volume rather than reporting no trades', () => {
        const bars = session(11, HELD).map(({ volume, ...rest }) => rest);

        expect(() => run({}, bars)).toThrow(/carry no volume/);
    });

    it('refuses bars that never enter the session it was asked for', () => {
        // 05:00 UTC is the middle of the night in New York.
        const t0 = Date.parse('2024-03-11T05:00:00Z');
        const bars = Array.from({ length: 4 }, (_, i) => ({
            time: t0 + i * MIN, open: 100, high: 100, low: 100, close: 100, volume: 1,
        }));

        expect(() => run({}, bars)).toThrow(/none of these bars fall inside the nyse session/);
    });
});
