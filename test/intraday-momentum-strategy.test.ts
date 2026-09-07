import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { STRATEGIES, buildStrategy, strategyCatalog } from '../app/renderer/strategies';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What Intraday Session Momentum does with the windows the detector measured.
 *
 * The sign convention is the thing worth guarding. The early window is FOLLOWED and the late
 * one is FADED, and a version that treated both as momentum would look almost identical in
 * code while trading against the stronger of the two published effects. Several tests below
 * exist only to pin that direction down.
 *
 * The setup: four quiet days at 100, then a test day that runs to 102 by mid-morning, gives a
 * point back into the evening, and moves again inside the traded window. On UTC days with a
 * 60-minute traded window, the position goes on at the close of bar 91 and comes off at the
 * close of bar 94.
 */

const STEP = 15 * 60_000;
const BARS_PER_DAY = 96;

function day(dateIso: string, levels: Record<number, number>, start = 100): OHLCV[] {
    const t0 = Date.parse(`${dateIso}T00:00:00Z`);
    const out: OHLCV[] = [];
    let previous = start;
    let level = start;
    for (let i = 0; i < BARS_PER_DAY; i += 1) {
        if (levels[i] !== undefined) level = levels[i]!;
        const open = previous;
        const close = level;
        out.push({
            time: t0 + i * STEP,
            open,
            high: Math.max(open, close) + 1,
            low: Math.min(open, close) - 1,
            close,
            volume: 10,
        });
        previous = close;
    }
    return out;
}

const QUIET: Record<number, number> = {};

/** Early +2%, late −1%: the two disagree in the way the default mode wants, so it goes long.
 *  Inside the traded window price runs 101 → 103. */
const LONG_DAY: Record<number, number> = { 20: 102, 89: 101, 93: 103 };
/** The mirror image: early −2%, late +1% → short, and the window falls 99 → 97. */
const SHORT_DAY: Record<number, number> = { 20: 98, 89: 99, 93: 97 };
/** Early +2% and late +1%: both point up, which the default mode reads as no position. */
const AGREE_DAY: Record<number, number> = { 20: 102, 89: 103, 93: 105 };
/** Long setup, but the traded window drops through the stop at 100. */
const STOPPED_DAY: Record<number, number> = { 20: 102, 89: 101, 93: 99 };

function bars(testDay: Record<number, number>, next = 103): OHLCV[] {
    return [
        ...day('2024-03-11', QUIET),
        ...day('2024-03-12', QUIET),
        ...day('2024-03-13', QUIET),
        ...day('2024-03-14', testDay),
        ...day('2024-03-15', QUIET, next),
    ];
}

/** No costs, so a fill lands exactly where the rules asked for it. */
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

const BASE = {
    boundary: 'utc', signalEndMin: 600, tradeMinutes: 60, confirmMinutes: 60, atrDays: 2,
};

function run(params: Record<string, unknown> = {}, testDay = LONG_DAY, next = 103) {
    const series = bars(testDay, next);
    return runBacktest({
        bars: series,
        strategy: buildStrategy('intradaymomentum', { ...BASE, ...params }, series),
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

describe('which way the day is traded', () => {
    it('goes long when the early window rose and the late one gave some back', () => {
        const result = run();

        expect(result.trades).toHaveLength(1);
        const trade = result.trades[0] as Trade;
        expect(trade.side).toBe('long');
        expect(trade.entryTag).toBe('2024-03-14');
    });

    it('goes short on the mirror image', () => {
        const trade = run({}, SHORT_DAY, 97).trades[0] as Trade;
        expect(trade.side).toBe('short');
        // Entered at 99, out at 97 — a short that made two points.
        expect(trade.entryPrice).toBe(99);
        expect(trade.exitPrice).toBe(97);
    });

    it('stands aside when both windows point the same way', () => {
        // A momentum-only reading would have gone long here. The published rule does not.
        expect(run({}, AGREE_DAY, 105).orders).toHaveLength(0);
    });

    it('follows the early window on its own when asked to', () => {
        const trade = run({ mode: 'signal' }, AGREE_DAY, 105).trades[0] as Trade;
        expect(trade.side).toBe('long');
    });

    it('fades the late window rather than following it', () => {
        // The late window rose here, so trading it alone is a SHORT.
        const trade = run({ mode: 'confirm' }, AGREE_DAY, 105).trades[0] as Trade;
        expect(trade.side).toBe('short');
    });

    it('does not trade a day that went nowhere', () => {
        expect(run({}, QUIET, 100).orders).toHaveLength(0);
    });

    it('refuses a mode that reads a window switched off', () => {
        const series = bars(LONG_DAY);
        expect(() => buildStrategy('intradaymomentum', { ...BASE, confirmMinutes: 0 }, series))
            .toThrow(/reads the late window, but Late window is 0/);
        // The mode that does not need it still builds.
        expect(() => buildStrategy('intradaymomentum', { ...BASE, confirmMinutes: 0, mode: 'signal' }, series))
            .not.toThrow();
    });
});

describe('entering and leaving on the clock', () => {
    it('enters at market when the traded window opens', () => {
        const result = run();
        const entry = result.orders.find((o) => o.tag === '2024-03-14')!;

        expect(entry.type).toBe('market');
        expect(entry.side).toBe('buy');
        // Filled at the window's opening price, which is the close of the bar before it.
        expect(entry.fillPrice).toBe(101);
    });

    it('is flat by the end of the window, not the next day', () => {
        const trade = run().trades[0] as Trade;

        /* Bar 95 of the 14th opens at 23:45 UTC. Closing on the last bar instead would fill
         * the next morning, holding a position the strategy never decided to hold. */
        expect(trade.exitTag).toBe('window-close');
        expect(trade.closedAt).toBe(Date.parse('2024-03-14T23:45:00Z'));
        expect(trade.exitPrice).toBe(103);
    });

    it('leaves nothing open at the end of the run', () => {
        expect(run().openPosition).toBeNull();
    });

    it('takes one position per day and does not re-enter', () => {
        const result = run();
        expect(result.orders.filter((o) => o.tag === '2024-03-14')).toHaveLength(1);
    });
});

describe('how large the position is', () => {
    it('sizes at the leverage ceiling when there is no stop', () => {
        const trade = run().trades[0] as Trade;

        // The researched strategy has no stop, so there is no risk distance to divide by:
        // the whole account at 1x, entered at 101.
        expect(trade.size).toBeCloseTo(10_000 / 101, 6);
        expect(trade.stopLoss).toBeNull();
        expect(trade.netPnl).toBeCloseTo((10_000 / 101) * 2, 6);
    });

    it('scales that position with the leverage ceiling', () => {
        const trade = run({ maxLeverage: 3 }).trades[0] as Trade;
        expect(trade.size).toBeCloseTo((3 * 10_000) / 101, 6);
    });

    it('switches to risk-based sizing once a stop is asked for', () => {
        // 50% of a daily ATR of 2 is a stop 1.00 below the fill; 1% of 10,000 across it is 100.
        const trade = run({ stopAtrPct: 50, maxLeverage: 5 }).trades[0] as Trade;

        expect(trade.stopLoss).toBeCloseTo(100, 6);
        expect(trade.size).toBeCloseTo(100, 6);
    });

    it('loses exactly what it risked when that stop is hit', () => {
        const trade = run({ stopAtrPct: 50, maxLeverage: 5 }, STOPPED_DAY, 99).trades[0] as Trade;

        expect(trade.exitTag).toBe('stop-loss');
        expect(trade.exitPrice).toBeCloseTo(100, 6);
        expect(trade.netPnl).toBeCloseTo(-100, 6);
    });

    it('waits for a daily ATR before it can place a stop at all', () => {
        // A 4-day ATR is still filling on the fourth day, so there is nothing to size against.
        expect(run({ stopAtrPct: 50, atrDays: 4 }).orders).toHaveLength(0);
    });
});

describe('intraday session momentum in the catalog', () => {
    it('is registered and states all four commitments', () => {
        expect(Object.keys(STRATEGIES)).toContain('intradaymomentum');
        const spec = strategyCatalog().find((s) => s.id === 'intradaymomentum')!;

        expect(spec.name).toBe('Intraday Session Momentum');
        expect(spec.rules!.entry).toMatch(/market order/i);
        expect(spec.rules!.target).toMatch(/clock/i);
    });

    it('reuses one detection across every way of trading the same windows', () => {
        const keys = STRATEGIES.intradaymomentum!.detectionKeys!;
        expect(keys).toContain('boundary');
        expect(keys).toContain('signalEndMin');
        // How a day is traded is not what the day was.
        expect(keys).not.toContain('mode');
        expect(keys).not.toContain('stopAtrPct');
    });
});
