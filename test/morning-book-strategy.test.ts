import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import { detectMorningBook } from '../src/core/analysis/morningBook';
import { PHASE_OSCILLATOR_DEFAULTS } from '../src/core/analysis/phaseOscillator';
import { TIME_BASED_RANGE_DEFAULTS } from '../src/core/analysis/timeBasedRange';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * The morning book: one seat, two engines, and what happens to the loser.
 *
 * The construction is the one the TBR9 tests use — twenty previous sessions returning
 * alternately ±0.4%, so sigma is 0.0041 and the cell walls sit at 100.1026 and 99.8974 around
 * a cell that opens at exactly 100. On top of it the test day runs a full minute series from
 * 00:00 to 15:00 Central, which is what the oscillator needs: its averages are measured on
 * ten-minute bars folded out of those minutes, and twenty-one of them is three and a half
 * hours of warm-up.
 *
 * The day is 2024-06-03, when Chicago is on CDT: 00:00 Central is 05:00 UTC.
 */

const MIN = 60_000;
const CELL_OPEN = 100;
const SIGMA = Math.sqrt((20 * 0.004 ** 2) / 19);
const UPPER = CELL_OPEN * (1 + 0.25 * SIGMA);

/** 00:00 Central on the test day. */
const DAY_START = Date.parse('2024-06-03T05:00:00Z');

function cellOpenTime(day: number, month: number): number {
    const mm = String(month).padStart(2, '0');
    return Date.parse(`2024-${mm}-${String(day).padStart(2, '0')}T12:00:00Z`);
}

/** One previous session, as the two bars sigma reads: the 07:00 open and the 11:00 close. */
function priorSession(day: number, month: number, ret: number): OHLCV[] {
    const t0 = cellOpenTime(day, month);
    const close = CELL_OPEN * (1 + ret);
    return [
        { time: t0, open: CELL_OPEN, high: CELL_OPEN, low: CELL_OPEN, close: CELL_OPEN, volume: 1 },
        { time: t0 + 239 * MIN, open: close, high: close, low: close, close, volume: 1 },
    ];
}

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

/** Minutes past Central midnight → index within the test day. */
const min = (h: number, m: number): number => h * 60 + m;
/** The same, as an index into the full series. */
const at = (i: number): number => 40 + i;

/**
 * The test day: 00:00 to 15:00 Central at one-minute bars. Quiet by default — a ±0.05 zig-zag
 * around 100, which stays inside the cell walls and gives the ten-minute bars enough true
 * range for an ATR — with `closes` overriding individual minutes.
 *
 * The minute before 07:00 is pinned to 100 whatever else happens, because the cell bar's OPEN
 * is the previous close and everything in this file is measured from a cell open of exactly
 * 100. Leaving it on the zig-zag put the walls 0.05 out and made every cell hour "loud".
 */
function testDay(closes: Map<number, number> = new Map()): OHLCV[] {
    const bars: OHLCV[] = [];
    let prev = CELL_OPEN;
    for (let i = 0; i <= min(15, 0); i += 1) {
        const close = i === min(7, 0) - 1
            ? CELL_OPEN
            : closes.get(i) ?? (i % 2 === 0 ? 100.05 : 99.95);
        bars.push({
            time: DAY_START + i * MIN,
            open: prev,
            high: Math.max(prev, close) + 0.01,
            low: Math.min(prev, close) - 0.01,
            close,
            volume: 1,
        });
        prev = close;
    }
    return bars;
}

function bars(closes?: Map<number, number>): OHLCV[] {
    return [...history(), ...testDay(closes)];
}

/** Every minute from `fromMin` to the end of the day held at `level`. */
function plateau(fromMin: number, level: number): Map<number, number> {
    const out = new Map<number, number>();
    for (let i = fromMin; i <= min(15, 0); i += 1) out.set(i, level);
    return out;
}

/**
 * A run away from `base` starting at `fromMin`, then a plateau at the top so nothing crosses
 * back the other way before the day ends. Big enough to carry the smoothed oscillator past
 * +100 on ten-minute bars whose ATR is about 0.1.
 */
function ramp(fromMin: number, base: number, count = 20, step = 0.1): Map<number, number> {
    const out = plateau(fromMin, base + step * count);
    for (let i = 0; i < count; i += 1) out.set(fromMin + i, base + step * (i + 1));
    return out;
}

/** Later parts win, so a scenario reads as a list of things that happen in order. */
function scenario(...parts: Array<Map<number, number>>): Map<number, number> {
    const out = new Map<number, number>();
    for (const part of parts) for (const [k, v] of part) out.set(k, v);
    return out;
}

/**
 * The cell breaks at 08:00 and the market then sits still until 08:40, so the oscillator
 * cannot cross until well after — both engines fire, and the cell is first by forty minutes.
 */
const BOTH_FIRE = scenario(
    plateau(min(8, 0), 100.15),
    ramp(min(8, 40), 100.15),
);

/** The cell hour reaches a wall, which disqualifies that engine for the day. */
const CELL_DISQUALIFIED = scenario(
    new Map([[min(7, 30), UPPER + 0.01]]),
    ramp(min(8, 40), 100),
);

const OPTIONS = {
    oscillatorStepMs: 10 * MIN,
    oscillator: PHASE_OSCILLATOR_DEFAULTS,
    cell: TIME_BASED_RANGE_DEFAULTS,
};

function run(all: readonly OHLCV[], params: Record<string, unknown> = {}) {
    return runBacktest({
        bars: all as OHLCV[],
        strategy: buildStrategy('morningbook', { riskMode: 'fixed', riskValue: 100, maxLeverage: 1, ...params }, all),
        broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
    });
}

describe('which engine takes the seat', () => {
    it('gives it to the cell when its break comes first', () => {
        const { signals } = detectMorningBook(bars(BOTH_FIRE), OPTIONS);
        expect(signals.length).toBe(1);
        expect(signals[0]!.source).toBe('cell');
        expect(signals[0]!.index).toBe(at(min(8, 0)));
        expect(signals[0]!.stop).toBe(CELL_OPEN);
    });

    it('leaves the oscillator nothing, even though it crossed too', () => {
        const { crosses } = detectMorningBook(bars(BOTH_FIRE), OPTIONS);
        const wouldHaveTraded = crosses.filter((c) => c.inEntryWindow);
        // It really did fire — it was just second, which is the whole rule.
        expect(wouldHaveTraded.length).toBeGreaterThan(0);
        expect(wouldHaveTraded[0]!.index).toBeGreaterThan(at(min(8, 0)));
    });

    it('gives it to the oscillator when the cell hour was not quiet', () => {
        const { signals } = detectMorningBook(bars(CELL_DISQUALIFIED), OPTIONS);
        expect(signals.length).toBe(1);
        expect(signals[0]!.source).toBe('oscillator');
        expect(signals[0]!.stop).toBeNull();
        // Its bar closes inside the oscillator's own window, which opens at 08:40.
        expect(signals[0]!.index).toBeGreaterThanOrEqual(at(min(8, 39)));
    });

    it('reports one seat per session however many signals there were', () => {
        const { signals, crosses } = detectMorningBook(bars(BOTH_FIRE), OPTIONS);
        expect(signals.length).toBe(1);
        // Crossings are all still reported: the oscillator's exit rule needs them.
        expect(crosses.length).toBeGreaterThan(0);
    });

    it('refuses an oscillator timeframe the chart cannot be folded into', () => {
        expect(() => detectMorningBook(bars(), { ...OPTIONS, oscillatorStepMs: 90_000 }))
            .toThrow(/whole multiple/);
    });
});

describe('what the book does with the seat', () => {
    it('trades a cell seat with its stop and its 11:00 close', () => {
        const all = bars(BOTH_FIRE);
        const result = run(all);

        const entry = result.fills[0] as { time: number; side: string };
        expect(entry.side).toBe('buy');
        expect(entry.time).toBe(all[at(min(8, 1))]!.time);

        const stops = result.orders.filter((o) => o.tag === 'stop-loss');
        expect(stops.length).toBe(1);
        expect(stops[0]!.stopPrice).toBe(CELL_OPEN);

        const exit = result.fills[result.fills.length - 1] as { time: number };
        expect(exit.time).toBe(all[at(min(11, 0))]!.time);
        expect(result.trades.length).toBe(1);
    });

    it('trades an oscillator seat with no stop and its 14:50 close', () => {
        const all = bars(CELL_DISQUALIFIED);
        const result = run(all);

        expect(result.orders.filter((o) => o.tag === 'stop-loss').length).toBe(0);

        const exit = result.fills[result.fills.length - 1] as { time: number };
        expect(exit.time).toBe(all[at(min(14, 50))]!.time);
        expect(result.trades.length).toBe(1);
    });

    it('takes no second trade after the seat is spent', () => {
        // The oscillator crosses at 08:50-odd while the cell trade is still on, and again
        // nothing happens: one seat, one trade, whatever the rest of the morning does.
        expect(run(bars(BOTH_FIRE)).trades.length).toBe(1);
    });

    it('spends the seat even when the cell ticket is refused', () => {
        /* The wall is touched by a wick at 08:00 and the bar closes back through the cell
         * open, so the cell engine has a signal and no trade — and the oscillator, which
         * crosses later, has already lost the morning.
         *
         * 99.95 and not lower: the bar's low has to stay off the OTHER wall, or the session
         * is skipped for touching both in one minute rather than refused for giving the break
         * back — a different rule, and not the one under test. */
        const closes = scenario(BOTH_FIRE, new Map([[min(8, 0), 99.95]]));
        const all = bars(closes).map((bar, i) => (
            i === at(min(8, 0)) ? { ...bar, high: UPPER + 0.05 } : bar
        ));

        const { signals } = detectMorningBook(all, OPTIONS);
        expect(signals.length).toBe(1);
        expect(signals[0]!.source).toBe('cell');
        expect(run(all).trades.length).toBe(0);
    });
});
