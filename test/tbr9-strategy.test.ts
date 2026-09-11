import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import {
    TIME_BASED_RANGE_DEFAULTS,
    detectTimeBasedRange,
} from '../src/core/analysis/timeBasedRange';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * TBR9: the cell, the walls it is measured against, and what the strategy does with a break.
 *
 * Every number below is forced by one construction, so it is worth stating once. The twenty
 * sessions before the test day return alternately +0.4% and −0.4%, which is a mean of zero
 * and a sample standard deviation of
 *
 *     sqrt(20 × 0.004² ÷ 19) = 0.00410346…
 *
 * The test day opens its cell at exactly 100, so the walls sit a quarter of that either side:
 * 100.102586 above and 99.897414 below. A cell that stays between 99.95 and 100.05 is
 * therefore quiet, and a trigger bar reaching 100.2 has touched the upper wall.
 *
 * The day is 2024-06-03, when Chicago is on CDT: 07:00 Central is 12:00 UTC.
 */

const MIN = 60_000;
const CELL_OPEN = 100;

/** Sigma as the twenty alternating sessions below produce it. */
const SIGMA = Math.sqrt((20 * 0.004 ** 2) / 19);
const UPPER = CELL_OPEN * (1 + 0.25 * SIGMA);
const LOWER = CELL_OPEN * (1 - 0.25 * SIGMA);

/** 07:00 Central on a June day, in UTC ms. */
function cellOpenTime(day: number, month = 6): number {
    const mm = String(month).padStart(2, '0');
    return Date.parse(`2024-${mm}-${String(day).padStart(2, '0')}T12:00:00Z`);
}

/**
 * One previous session, as the two bars sigma actually reads: the cell open and the close the
 * morning return is measured to. The hours between are not built, because nothing reads them
 * — and a session with no trigger-window bar cannot become a setup of its own, which keeps
 * the history clean.
 */
function priorSession(day: number, month: number, ret: number): OHLCV[] {
    const t0 = cellOpenTime(day, month);
    const close = CELL_OPEN * (1 + ret);
    return [
        { time: t0, open: CELL_OPEN, high: CELL_OPEN, low: CELL_OPEN, close: CELL_OPEN, volume: 1 },
        // 10:59 Central, so its close lands exactly on the 11:00 mark.
        { time: t0 + 239 * MIN, open: close, high: close, low: close, close, volume: 1 },
    ];
}

/** Twenty sessions alternating ±0.4%, oldest first: 2024-05-14 through 2024-06-02. */
function history(): OHLCV[] {
    const bars: OHLCV[] = [];
    for (let i = 0; i < 20; i += 1) {
        const dayOfMonth = 14 + i;
        const month = dayOfMonth <= 31 ? 5 : 6;
        const day = dayOfMonth <= 31 ? dayOfMonth : dayOfMonth - 31;
        bars.push(...priorSession(day, month, i % 2 === 0 ? 0.004 : -0.004));
    }
    return bars;
}

type Row = [open: number, high: number, low: number, close: number];

/** A quiet cell bar: inside both walls with room to spare. */
const QUIET: Row = [100, 100.05, 99.95, 100];
/** After the break: above the cell open so the stop is never touched, and below the upper
 *  wall so it is not a second break of its own. */
const HOLDING: Row = [100.08, 100.09, 100.02, 100.08];

/**
 * The test day, 07:00 to 11:00 Central at one-minute bars, with `moves` overriding individual
 * minutes. Minute 0 is 07:00, minute 60 is 08:00 — the first bar of the trigger window — and
 * minute 239 is 10:59, whose close is the flat-at mark.
 */
function testDay(moves: Map<number, Row> = new Map()): OHLCV[] {
    const t0 = cellOpenTime(3);
    const bars: OHLCV[] = [];
    for (let i = 0; i <= 240; i += 1) {
        const [open, high, low, close] = moves.get(i) ?? (i < 60 ? QUIET : HOLDING);
        bars.push({ time: t0 + i * MIN, open, high, low, close, volume: 1 });
    }
    return bars;
}

/** A bar that touches the upper wall at 08:00 and closes above the cell open. */
const BREAK_UP = new Map<number, Row>([[60, [100.05, 100.2, 100.03, 100.08]]]);

function bars(moves?: Map<number, Row>): OHLCV[] {
    return [...history(), ...testDay(moves)];
}

/** Index of the test day's minute `i` within the full series. */
function at(i: number): number {
    return 40 + i;
}

function detect(all: readonly OHLCV[]) {
    return detectTimeBasedRange(all, TIME_BASED_RANGE_DEFAULTS);
}

function run(all: readonly OHLCV[], params: Record<string, unknown> = {}) {
    return runBacktest({
        bars: all as OHLCV[],
        strategy: buildStrategy('tbr9', { riskMode: 'fixed', riskValue: 100, maxLeverage: 50, ...params }, all),
        broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
    });
}

describe('which sessions are setups', () => {
    it('places the walls a quarter of a sigma either side of the cell open', () => {
        const { setups } = detect(bars(BREAK_UP));
        expect(setups.length).toBe(1);

        const setup = setups[0]!;
        expect(setup.sigma).toBeCloseTo(SIGMA, 10);
        expect(setup.cellOpen).toBe(CELL_OPEN);
        expect(setup.upper).toBeCloseTo(UPPER, 10);
        expect(setup.lower).toBeCloseTo(LOWER, 10);
        expect(setup.direction).toBe('long');
        expect(setup.index).toBe(at(60));
    });

    it('passes over a session whose cell hour reached a wall', () => {
        const loud = new Map(BREAK_UP);
        // One cell minute reaching the wall is enough, even though it closes back inside.
        loud.set(30, [100, UPPER, 99.95, 100]);
        expect(detect(bars(loud)).setups.length).toBe(0);
    });

    it('trades the first touch, not a later one', () => {
        const twice = new Map(BREAK_UP);
        twice.set(90, [100.08, 100.4, 100.02, 100.35]);
        const { setups } = detect(bars(twice));
        expect(setups.length).toBe(1);
        expect(setups[0]!.index).toBe(at(60));
    });

    it('passes over a bar that reached both walls, rather than guessing which came first', () => {
        const both = new Map(BREAK_UP);
        both.set(60, [100, 100.2, 99.8, 100.15]);
        expect(detect(bars(both)).setups.length).toBe(0);
    });

    it('takes no setup before there are twenty sessions to forecast from', () => {
        // The same test day with only nineteen sessions behind it.
        const short = [...history().slice(2), ...testDay(BREAK_UP)];
        expect(detectTimeBasedRange(short, TIME_BASED_RANGE_DEFAULTS).setups.length).toBe(0);
    });

    it('does not touch a wall that is out of the trigger window', () => {
        const late = new Map<number, Row>([[125, [100.08, 100.2, 100.02, 100.15]]]);
        // 09:05 Central: past the 09:00 end of the trigger window.
        expect(detect(bars(late)).setups.length).toBe(0);
    });
});

describe('what the strategy does with a setup', () => {
    it('buys at the open of the bar after the touch, stopped at the cell open', () => {
        const all = bars(BREAK_UP);
        const result = run(all);

        const entry = result.fills[0] as { time: number; price: number; side: string };
        expect(entry.side).toBe('buy');
        expect(entry.time).toBe(all[at(61)]!.time);
        expect(entry.price).toBe(all[at(61)]!.open);

        const stops = result.orders.filter((o) => o.tag === 'stop-loss');
        expect(stops.length).toBe(1);
        expect(stops[0]!.stopPrice).toBe(CELL_OPEN);
    });

    it('is flat at 11:00, filling at that bar open', () => {
        const all = bars(BREAK_UP);
        const result = run(all);

        const exit = result.fills[result.fills.length - 1] as { time: number; price: number };
        expect(exit.time).toBe(all[at(240)]!.time);
        expect(exit.price).toBe(all[at(240)]!.open);
        expect(result.openPosition).toBeNull();
        expect(result.trades.length).toBe(1);
    });

    it('is stopped at the cell open when price comes back through it', () => {
        const reversing = new Map(BREAK_UP);
        reversing.set(70, [100.08, 100.09, 99.8, 99.9]);
        const result = run(bars(reversing));

        const trades = result.trades as Array<{ exitPrice: number; side: string }>;
        expect(trades.length).toBe(1);
        expect(trades[0]!.side).toBe('long');
        expect(trades[0]!.exitPrice).toBe(CELL_OPEN);
    });

    it('does not trade a wall that was touched and given straight back', () => {
        const wick = new Map(BREAK_UP);
        // The wall is touched by the high, but the bar closes back through the cell open.
        wick.set(60, [100.05, 100.2, 99.9, 99.95]);
        const { setups } = detect(bars(wick));
        expect(setups.length).toBe(1);

        expect(run(bars(wick)).trades.length).toBe(0);
    });

    it('holds the ticket until the earliest entry time when one is set', () => {
        const all = bars(BREAK_UP);
        // 08:30 Central is the US cash open — what the options version of the sleeve waits for.
        const result = run(all, { entryFromMin: 8 * 60 + 30 });

        const entry = result.fills[0] as { time: number };
        // The bar closing at 08:30 is the one opening at 08:29, so the fill is 08:30.
        expect(entry.time).toBe(all[at(90)]!.time);
    });

    it('kills a waiting ticket when a close gives the break back', () => {
        const fading = new Map(BREAK_UP);
        fading.set(70, [100.08, 100.09, 99.9, 99.95]);
        const result = run(bars(fading), { entryFromMin: 8 * 60 + 30 });
        expect(result.trades.length).toBe(0);
        expect(result.openPosition).toBeNull();
    });

    it('sizes off the distance from the expected fill to the cell open', () => {
        const all = bars(BREAK_UP);
        const result = run(all, { riskMode: 'fixed', riskValue: 100, maxLeverage: 100 });

        /* The ticket is sized on the signal bar's close, 100.08, against a stop at 100: a
         * distance of 0.08, so 100 of risk buys 1,250 units — well inside the ceiling of
         * 100 × 10,000 ÷ 100.08, which is what makes this a test of the risk rule. */
        const entry = result.fills[0] as { size: number };
        expect(entry.size).toBeCloseTo(1250, 6);
    });
});
