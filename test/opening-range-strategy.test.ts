import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { STRATEGIES, buildStrategy, strategyCatalog } from '../app/renderer/strategies';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What the Relative Volume ORB strategy does with what the detector found.
 *
 * The numbers below are all forced by one setup, so they are worth stating once. Three quiet
 * sessions each cover a range of 2, so the daily ATR on the test day is 2 and a 10% stop is
 * 0.20 wide. Risking 1% of 10,000 across 0.20 is 500 units. The opening range closes at 102
 * having opened at 100, so the trade is long and the order sits at the range high, 102.50.
 */

const MIN = 60_000;

type Row = [open: number, high: number, low: number, close: number];

/** 09:30 New York in UTC ms. March 2024 from the 11th is EDT, so 13:30 UTC. */
function open930(day: number): number {
    return Date.parse(`2024-03-${day}T13:30:00Z`);
}

function session(day: number, rows: readonly Row[], volume: number): OHLCV[] {
    const t0 = open930(day);
    return rows.map(([open, high, low, close], i) => ({
        time: t0 + i * MIN, open, high, low, close, volume,
    }));
}

/** A session that goes nowhere: its opening range is a doji, so it is never traded, and its
 *  daily range is 2 whatever the day before did. */
const FLAT: Row[] = Array.from({ length: 10 }, () => [100, 101, 99, 100] as Row);

/** Opening range 100 → 102 (high 102.50), no break on bar 5, break and run from bar 6. */
const TREND_UP: Row[] = [
    [100, 101, 99.5, 100.5],
    [100.5, 101.5, 100, 101],
    [101, 102, 100.5, 101.5],
    [101.5, 102.5, 101, 102],
    [102, 102.5, 101.5, 102],
    [102, 102.4, 101.8, 102.2],
    [102.2, 103.5, 102, 103.4],
    [103.4, 104, 103.2, 103.8],
    [103.8, 104.2, 103.5, 104],
    [104, 104.5, 103.8, 104.2],
];

/** The same break, but bar 7 comes back through the stop at 102.30. */
const STOPPED_OUT: Row[] = TREND_UP.map((row, i) => (i === 7 ? [103.4, 103.6, 102, 102.2] : row));

/** Opening range 102 → 100, so only a short is allowed — and then price runs UP through the
 *  range high, which this strategy is not allowed to take. */
const REVERSAL: Row[] = [
    [102, 102.5, 101.5, 101.5],
    [101.5, 102, 101, 101],
    [101, 101.5, 100.5, 100.5],
    [100.5, 101, 100, 100],
    [100, 100.5, 99.5, 100],
    [100, 103, 100, 102.8],
    [102.8, 104, 102.5, 103.8],
    [103.8, 104.5, 103.5, 104.2],
    [104.2, 105, 104, 104.8],
    [104.8, 105.5, 104.5, 105.2],
];

function bars(testDay: readonly Row[] = TREND_UP, testVolume = 200): OHLCV[] {
    return [
        ...session(11, FLAT, 100),
        ...session(12, FLAT, 100),
        ...session(13, FLAT, 100),
        ...session(14, testDay, testVolume),
        ...session(15, FLAT, 100),
    ];
}

/** No costs, so a fill lands exactly where the rules asked for it. */
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

/** Short windows so the warm-up is over by the fourth session; leverage out of the way so the
 *  size is the one the risk asked for rather than the one the account could carry. */
const BASE = { atrDays: 2, relVolumeDays: 2, maxLeverage: 20 };

function run(params: Record<string, unknown> = {}, rows: readonly Row[] = TREND_UP, volume = 200) {
    const series = bars(rows, volume);
    return runBacktest({
        bars: series,
        strategy: buildStrategy('openingrange', { ...BASE, ...params }, series),
        broker: FREE,
    });
}

interface Trade {
    side: string;
    size: number;
    entryPrice: number;
    exitPrice: number;
    closedAt: number;
    netPnl: number;
    stopLoss: number | null;
    entryTag: string | null;
    exitTag: string | null;
}

describe('the order the opening range asks for', () => {
    it('rests a stop order at the edge the range closed towards', () => {
        const result = run();

        expect(result.orders.filter((o) => o.tag === '2024-03-14')).toHaveLength(1);
        const entry = result.orders.find((o) => o.tag === '2024-03-14')!;
        expect(entry.type).toBe('stop');
        expect(entry.side).toBe('buy');
        expect(entry.stopPrice).toBe(102.5);
        expect(entry.status).toBe('filled');
        expect(entry.fillPrice).toBe(102.5);
    });

    it('sizes the position off the risk and the ATR stop, not off the balance', () => {
        const trade = run().trades[0] as Trade;

        // 1% of 10,000 across a 0.20 stop, which is 10% of a daily ATR of 2.
        expect(trade.size).toBeCloseTo(500, 6);
        expect(trade.stopLoss).toBeCloseTo(102.3, 6);
    });

    it('places the stop a fraction of the ATR from the fill, not from the trigger', () => {
        // A gap straight through the trigger: the entry fills at the open, well above 102.50,
        // and the stop has to follow it or the trade risks more than it was sized for.
        const gapped: Row[] = TREND_UP.map((row, i) => (i === 6 ? [103, 103.5, 102.9, 103.4] : row));
        const trade = run({}, gapped).trades[0] as Trade;

        expect(trade.entryPrice).toBe(103);
        expect(trade.stopLoss).toBeCloseTo(102.8, 6);
    });

    it('takes only the direction the range closed in, however far price breaks the other way', () => {
        const result = run({}, REVERSAL);

        // The range closed lower, so the only order is a sell stop at its low — and price
        // never went there. A two-sided breakout would have been long by bar 5.
        const entries = result.orders.filter((o) => o.tag === '2024-03-14');
        expect(entries).toHaveLength(1);
        expect(entries[0]!.side).toBe('sell');
        expect(entries[0]!.stopPrice).toBe(99.5);
        expect(entries[0]!.status).toBe('cancelled');
        expect(result.trades).toHaveLength(0);
    });

    it('does not trade a range that closed where it opened', () => {
        // Every quiet session is a doji, and the test day is one too here.
        expect(run({}, FLAT).orders).toHaveLength(0);
    });

    it('waits for a daily ATR rather than guessing a stop width', () => {
        // A 4-day ATR is still filling on the fourth session, so there is nothing to size against.
        expect(run({ atrDays: 4 }).orders).toHaveLength(0);
    });
});

describe('the relative volume filter', () => {
    it('trades an opening that drew twice the usual volume', () => {
        expect(run({ minRelVolume: 150 }).trades).toHaveLength(1);
    });

    it('stands aside when the opening was quieter than the floor asks for', () => {
        expect(run({ minRelVolume: 250 }).orders).toHaveLength(0);
    });

    it('trades the same range with the filter switched off', () => {
        // The version of these rules the research measures at 3.2% a year.
        expect(run({ minRelVolume: 0 }, TREND_UP, 100).trades).toHaveLength(1);
    });

    it('stands aside while there is not enough history to call an opening unusual', () => {
        // With a 4-day average the fourth session has nothing to compare against, and "cannot
        // say" must not be read as "ordinary".
        expect(run({ relVolumeDays: 4, atrDays: 2 }).orders).toHaveLength(0);
    });

    it('says so rather than reporting no trades when the bars carry no volume', () => {
        const series = bars().map(({ volume, ...rest }) => rest);
        expect(() => buildStrategy('openingrange', BASE, series)).toThrow(/carry no volume/);
    });

    it('runs on volumeless bars once the filter is off', () => {
        const series = bars().map(({ volume, ...rest }) => rest);
        const result = runBacktest({
            bars: series,
            strategy: buildStrategy('openingrange', { ...BASE, minRelVolume: 0 }, series),
            broker: FREE,
        });
        expect(result.trades).toHaveLength(1);
    });
});

describe('getting out', () => {
    it('is flat by the session close, not the next morning', () => {
        const trade = run().trades[0] as Trade;

        // The close is ordered on the second-to-last bar so it fills on the last one. Filling
        // on the next bar instead would exit at 09:30 the following day, across the gap.
        expect(trade.exitTag).toBe('session-close');
        expect(trade.closedAt).toBe(open930(14) + 9 * MIN);
        expect(trade.exitPrice).toBe(104);
        expect(trade.netPnl).toBeCloseTo(500 * 1.5, 6);
    });

    it('leaves nothing open at the end of the run', () => {
        expect(run().openPosition).toBeNull();
    });

    it('loses exactly what it risked when the stop is hit', () => {
        const trade = run({}, STOPPED_OUT).trades[0] as Trade;

        expect(trade.exitTag).toBe('stop-loss');
        expect(trade.exitPrice).toBeCloseTo(102.3, 6);
        // 1% of the starting balance, which is what the size was solved for.
        expect(trade.netPnl).toBeCloseTo(-100, 6);
    });

    it('holds to the close with no target attached by default', () => {
        expect(run().orders.some((o) => o.tag === 'take-profit')).toBe(false);
    });

    it('takes the reward-to-risk target once it is switched on', () => {
        const trade = run({ useTarget: true, rrr: 5 }).trades[0] as Trade;

        // Five times a 0.20 stop is 1.00 above the 102.50 fill.
        expect(trade.exitTag).toBe('take-profit');
        expect(trade.exitPrice).toBeCloseTo(103.5, 6);
        expect(trade.netPnl).toBeCloseTo(500, 6);
    });

    it('takes one trade per session and does not re-enter after it is over', () => {
        const result = run();

        expect(result.trades).toHaveLength(1);
        expect(result.orders.filter((o) => o.tag === '2024-03-14')).toHaveLength(1);
    });
});

describe('opening range breakout in the catalog', () => {
    it('is registered and states all four commitments', () => {
        expect(Object.keys(STRATEGIES)).toContain('openingrange');
        const spec = strategyCatalog().find((s) => s.id === 'openingrange')!;

        expect(spec.name).toBe('Relative Volume ORB');
        expect(spec.rules!.entry).toMatch(/stop order/i);
        expect(spec.rules!.target).toMatch(/session close/i);
    });

    it('reuses one detection across every relative-volume level a sweep asks about', () => {
        // The floor is the setting most worth sweeping, so it must not force a re-detection.
        const keys = STRATEGIES.openingrange!.detectionKeys!;
        expect(keys).toContain('rangeMinutes');
        expect(keys).not.toContain('minRelVolume');
        expect(keys).not.toContain('atrStopPct');
    });
});
