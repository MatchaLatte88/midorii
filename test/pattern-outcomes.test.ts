import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { DEFAULT_COSTS, NO_COSTS } from '../shared/engine/broker.js';
import type { Costs } from '../shared/engine/broker';
import { buildFeatures, type PatternBar } from '../app/renderer/patterns/atoms';
import { createBitset, setBit } from '../app/renderer/patterns/bits';
import { computeOutcomes, type ExitRule } from '../app/renderer/patterns/outcomes';
import { buildPatternStrategy } from '../app/renderer/patterns/patternStrategy';
import { walkTrades } from '../app/renderer/patterns/stats';

/**
 * The search's own trade arithmetic, held to the engine.
 *
 * The search never runs the Broker — it would take hours — so it scores every trade with
 * arithmetic of its own. That arithmetic is only worth anything if it is the Broker's to
 * the fill: a pattern found by one set of rules and backtested by another is a pattern
 * nobody found. So the same signals go through both, and every trade must open on the same
 * bar, close on the same bar, and come out at the same R.
 */

const HOUR = 3_600_000;

/** A seeded random walk with real wicks, some gaps and the odd wide bar. */
function randomBars(count: number, seed: number): PatternBar[] {
    let s = seed >>> 0;
    const rand = (): number => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out: PatternBar[] = [];
    let price = 30_000;
    for (let i = 0; i < count; i++) {
        const gap = rand() < 0.05 ? (rand() - 0.5) * 400 : 0;
        const open = price + gap;
        const move = (rand() - 0.5) * (rand() < 0.1 ? 900 : 300);
        const close = open + move;
        const high = Math.max(open, close) + rand() * 150;
        const low = Math.min(open, close) - rand() * 150;
        const volume = 10 + rand() * 20;
        out.push({ time: Date.UTC(2024, 0, 1) + i * HOUR, open, high, low, close, volume, buyVolume: volume * rand() });
        price = close;
    }
    return out;
}

/** A signal on every bar that can be read and whose trade can finish. The tail is left out
 *  because there the two are asked different questions: the search leaves a trade the data
 *  ends inside of unscored, while the engine opens it and reports it as still open. */
function everyReadyBar(size: number, ready: Uint32Array, exit: ExitRule): Uint32Array {
    const out = createBitset(size);
    for (let i = 0; i < size - exit.maxBars - 1; i++) {
        if ((ready[i >>> 5]! & (1 << (i & 31))) !== 0) setBit(out, i);
    }
    return out;
}

function compare(side: 'long' | 'short', exit: ExitRule, costs: Required<Costs>) {
    const bars = randomBars(900, side === 'long' ? 7 : 11);
    const features = buildFeatures(bars);
    const outcomes = computeOutcomes(bars, features.atr, exit, { ...costs });
    const signals = everyReadyBar(bars.length, features.ready, exit);

    const expected: Array<{ signal: number; exit: number; r: number }> = [];
    walkTrades(
        signals,
        side === 'long' ? outcomes.longR : outcomes.shortR,
        side === 'long' ? outcomes.longExit : outcomes.shortExit,
        { from: 0, to: bars.length },
        (signal, r) => expected.push({
            signal,
            exit: (side === 'long' ? outcomes.longExit : outcomes.shortExit)[signal]!,
            r,
        }),
    );

    const result = runBacktest({
        bars,
        strategy: buildPatternStrategy({
            signals, barCount: bars.length, side, atr: features.atr, exit, riskPct: 1,
        }),
        broker: { balance: 100_000, costs },
    });
    const trades = result.trades as Array<{
        openedAt: number; closedAt: number; netPnl: number; size: number;
    }>;
    return { bars, features, expected, trades };
}

describe('pattern outcomes against the engine', () => {
    for (const side of ['long', 'short'] as const) {
        it(`opens, closes and scores every ${side} trade exactly as the Broker fills it`, () => {
            const exit = { stopAtr: 1, rrr: 2, maxBars: 12 };
            const { bars, features, expected, trades } = compare(side, exit, NO_COSTS);

            expect(expected.length).toBeGreaterThan(40);
            expect(trades.length).toBe(expected.length);
            expected.forEach((want, k) => {
                const got = trades[k]!;
                expect(got.openedAt).toBe(bars[want.signal + 1]!.time);
                expect(got.closedAt).toBe(bars[want.exit]!.time);
                const risk = exit.stopAtr * features.atr[want.signal]!;
                expect(got.netPnl / (got.size * risk)).toBeCloseTo(want.r, 9);
            });
        });
    }

    it('charges costs in R the way the Broker charges them in money', () => {
        const exit = { stopAtr: 1.5, rrr: 1.5, maxBars: 8 };
        const { features, expected, trades } = compare('long', exit, DEFAULT_COSTS);

        expect(trades.length).toBe(expected.length);
        expected.forEach((want, k) => {
            const got = trades[k]!;
            const risk = exit.stopAtr * features.atr[want.signal]!;
            expect(got.netPnl / (got.size * risk)).toBeCloseTo(want.r, 3);
        });
        // And the costs are really there: the same trades are worth less than for free.
        const free = compare('long', exit, NO_COSTS).expected;
        const total = (list: Array<{ r: number }>) => list.reduce((s, t) => s + t.r, 0);
        expect(total(expected)).toBeLessThan(total(free));
    });

    it('leaves a trade the data ends inside of unscored', () => {
        const bars = randomBars(200, 3);
        const features = buildFeatures(bars);
        const exit = { stopAtr: 50, rrr: 50, maxBars: 30 };
        const outcomes = computeOutcomes(bars, features.atr, exit, { ...NO_COSTS });
        // Levels nobody reaches: every trade runs to the clock, so the last 31 bars cannot finish.
        for (let i = bars.length - 31; i < bars.length; i++) expect(outcomes.longR[i]).toBeNaN();
        expect(outcomes.longR[bars.length - 32]).not.toBeNaN();
    });
});
