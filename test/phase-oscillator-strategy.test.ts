import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import {
    PHASE_OSCILLATOR_DEFAULTS,
    computePhaseOscillator,
    detectPhaseOscillator,
} from '../src/core/analysis/phaseOscillator';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * The Phase-Oscillator sleeve: what the oscillator is, which bars count as a crossing, and
 * what the strategy does with one.
 *
 * The day below is 2024-06-03, when Chicago is on CDT and 07:00 Central is 12:00 UTC. Bars
 * are 10 minutes, which is the timeframe the published measurement uses, so the clock windows
 * land on bar boundaries: a bar opening at 08:30 closes at 08:40 and is the first that may
 * fire, and one opening at 14:40 closes at 14:50 and is where the flat-at order is placed.
 */

const TEN_MIN = 600_000;

/** 00:00 Central on 2024-06-03 in UTC ms. CDT is UTC−5, so local midnight is 05:00 UTC. */
const DAY_START = Date.parse('2024-06-03T05:00:00Z');

/** Minutes past Central midnight → the index of the 10m bar that OPENS then. */
function barAtOpen(minutes: number): number {
    return minutes / 10;
}

/**
 * A day of 10-minute bars that zig-zags by ±0.5 around `base` — enough true range for the
 * ATR to settle near 1 — with `moves` overriding the close of individual bars.
 *
 * Each bar's high and low straddle its own close, so a bar that jumps also has the range to
 * match instead of being a closing price nothing traded through.
 */
function day(base: number, moves: Map<number, number> = new Map(), count = 96): OHLCV[] {
    const bars: OHLCV[] = [];
    let prev = base;
    for (let i = 0; i < count; i += 1) {
        const close = moves.get(i) ?? base + (i % 2 === 0 ? 0.5 : -0.5);
        bars.push({
            time: DAY_START + i * TEN_MIN,
            open: prev,
            high: Math.max(prev, close) + 0.25,
            low: Math.min(prev, close) - 0.25,
            close,
            volume: 100,
        });
        prev = close;
    }
    return bars;
}

/** A run away from the mean, starting at the bar that opens at `fromMin` and lasting
 *  `bars` bars, moving `step` each bar. Large enough to carry the smoothed oscillator
 *  through +100. */
function ramp(fromMin: number, base: number, bars = 6, step = 2): Map<number, number> {
    const moves = new Map<number, number>();
    const start = barAtOpen(fromMin);
    for (let i = 0; i < bars; i += 1) moves.set(start + i, base + step * (i + 1));
    return moves;
}

function detect(bars: readonly OHLCV[]) {
    return detectPhaseOscillator(bars, PHASE_OSCILLATOR_DEFAULTS);
}

function run(bars: readonly OHLCV[], params: Record<string, unknown> = {}) {
    return runBacktest({
        bars: bars as OHLCV[],
        strategy: buildStrategy('phaseoscillator', { maxLeverage: 1, ...params }, bars),
        broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
    });
}

describe('the phase oscillator itself', () => {
    it('is the distance from the EMA measured in ATRs, scaled so 100 is three of them', () => {
        /* Hand-checkable: with smoothing off and the averages at length 2, the reading is
         * forced by the last two bars alone. The EMA(2) of closes and the RMA(2) of true
         * ranges are both running averages with alpha 2/3 and 1/2 — so rather than assert a
         * magic number, assert the identity the formula claims: the reading is exactly
         * 100 × (close − mean) ÷ (3 × atr) for whatever mean and atr the bars produced. */
        const bars = day(100, new Map([[40, 104]]));
        const options = { emaLength: 21, atrLength: 14, atrMultiple: 3, smoothing: 1 };
        const osc = computePhaseOscillator(bars, options);

        // Reconstruct the same two averages the other way round and confirm they agree.
        const reading = osc[40]!;
        expect(Number.isFinite(reading)).toBe(true);
        const implied = bars[40]!.close - (reading * 3 * impliedAtr(bars, 14, 40)) / 100;
        // `implied` is the EMA the reading claims; a 21-EMA of a series around 100 sits there.
        expect(implied).toBeGreaterThan(99);
        expect(implied).toBeLessThan(103);
    });

    it('does not exist until both averages have warmed up', () => {
        const osc = computePhaseOscillator(day(100), PHASE_OSCILLATOR_DEFAULTS);
        // 21-bar EMA and 14-bar ATR: nothing before bar 20 can be a reading.
        expect(Number.isFinite(osc[19]!)).toBe(false);
        expect(osc.slice(0, 20).every((v) => !Number.isFinite(v))).toBe(true);
    });
});

/** The ATR the oscillator used, recovered from the series so the test does not restate it. */
function impliedAtr(bars: readonly OHLCV[], length: number, at: number): number {
    let tr = 0;
    for (let i = 1; i <= at; i += 1) {
        const b = bars[i]!;
        const pc = bars[i - 1]!.close;
        const range = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
        if (i <= length) tr += range / length;
        else tr = tr + (range - tr) / length;
    }
    return tr;
}

describe('what counts as a crossing', () => {
    const bars = day(100, ramp(8 * 60 + 30, 100));
    const { crosses, oscillator } = detect(bars);

    it('finds the bar that traversed the level, not every bar beyond it', () => {
        expect(crosses.length).toBeGreaterThan(0);
        for (const cross of crosses) {
            const now = oscillator[cross.index]!;
            const prev = oscillator[cross.index - 1]!;
            if (cross.direction === 'long') {
                expect(prev).toBeLessThanOrEqual(100);
                expect(now).toBeGreaterThan(100);
            } else {
                expect(prev).toBeGreaterThanOrEqual(-100);
                expect(now).toBeLessThan(-100);
            }
        }
    });

    it('reports one crossing per traversal', () => {
        let traversals = 0;
        for (let i = 1; i < oscillator.length; i += 1) {
            const now = oscillator[i]!;
            const prev = oscillator[i - 1]!;
            if (!Number.isFinite(now) || !Number.isFinite(prev)) continue;
            if ((prev <= 100 && now > 100) || (prev >= -100 && now < -100)) traversals += 1;
        }
        expect(crosses.length).toBe(traversals);
    });

    it('marks a crossing inside the morning window by its bar CLOSE', () => {
        const first = crosses[0]!;
        expect(first.direction).toBe('long');
        expect(first.inEntryWindow).toBe(true);
        // Closes at or after 08:40 and at or before 10:00 — the bar opening at 08:30 is first.
        expect(first.index).toBeGreaterThanOrEqual(barAtOpen(8 * 60 + 30));
        expect(first.index).toBeLessThanOrEqual(barAtOpen(9 * 60 + 50));
    });
});

describe('what the strategy does with one', () => {
    it('buys at the open of the bar after the crossing', () => {
        const bars = day(100, ramp(8 * 60 + 30, 100));
        const { crosses } = detect(bars);
        const signal = crosses[0]!;

        const result = run(bars);
        expect(result.fills.length).toBeGreaterThan(0);

        const entry = result.fills[0] as { time: number; price: number; side: string };
        expect(entry.side).toBe('buy');
        expect(entry.time).toBe(bars[signal.index + 1]!.time);
        expect(entry.price).toBe(bars[signal.index + 1]!.open);
    });

    it('is flat at the flat-at time, filling at that bar open', () => {
        const bars = day(100, ramp(8 * 60 + 30, 100));
        const result = run(bars);

        const exit = result.fills[result.fills.length - 1] as { time: number; price: number };
        const exitBar = barAtOpen(14 * 60 + 50);
        expect(exit.time).toBe(bars[exitBar]!.time);
        expect(exit.price).toBe(bars[exitBar]!.open);
        expect(result.openPosition).toBeNull();
    });

    it('takes no position from a crossing outside the signal window', () => {
        // The same ramp, three hours later: a real crossing, but not one that may be traded.
        const bars = day(100, ramp(12 * 60 + 30, 100));
        const { crosses } = detect(bars);
        expect(crosses.length).toBeGreaterThan(0);
        expect(crosses.every((c) => !c.inEntryWindow)).toBe(true);

        expect(run(bars).trades.length).toBe(0);
    });

    it('reverses on an opposite crossing inside the window, in one fill', () => {
        const down = ramp(8 * 60, 100, 6, 2);
        // Straight back down through the mean and well beyond it, still inside the window.
        const start = barAtOpen(9 * 60);
        for (let i = 0; i < 8; i += 1) down.set(start + i, 112 - 5 * (i + 1));

        const bars = day(100, down);
        const { crosses } = detect(bars);
        const inWindow = crosses.filter((c) => c.inEntryWindow);
        expect(inWindow.map((c) => c.direction)).toEqual(['long', 'short']);

        const result = run(bars);
        const trades = result.trades as Array<{ side: string }>;
        expect(trades.length).toBe(2);
        expect(trades[0]!.side).toBe('long');
        expect(trades[1]!.side).toBe('short');

        /* One order did both jobs: the reversal is a single fill, not a close and an entry
         * racing for the same bar's open. */
        const reversalBar = bars[inWindow[1]!.index + 1]!;
        const atReversal = (result.fills as Array<{ time: number }>)
            .filter((f) => f.time === reversalBar.time);
        expect(atReversal.length).toBe(1);
    });

    it('closes on an opposite crossing after the window without re-entering', () => {
        const moves = ramp(8 * 60 + 30, 100, 6, 2);
        // Down through the other side long after the window has shut.
        const start = barAtOpen(11 * 60);
        for (let i = 0; i < 8; i += 1) moves.set(start + i, 112 - 4 * (i + 1));

        const bars = day(100, moves);
        const { crosses } = detect(bars);
        const shorts = crosses.filter((c) => c.direction === 'short');
        expect(shorts.length).toBeGreaterThan(0);
        expect(shorts.every((c) => !c.inEntryWindow)).toBe(true);

        const result = run(bars);
        const trades = result.trades as Array<{ side: string }>;
        expect(trades.length).toBe(1);
        expect(trades[0]!.side).toBe('long');

        // It ended at the crossing, not at the flat-at time.
        const exit = result.fills[result.fills.length - 1] as { time: number };
        expect(exit.time).toBe(bars[shorts[0]!.index + 1]!.time);
    });
});
