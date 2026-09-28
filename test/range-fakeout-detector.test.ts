import { describe, expect, it } from 'vitest';
import { detectRangeFakeouts, rangeFakeoutTarget } from '../src/core/analysis/rangeFakeout';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

function bars(rows: readonly Row[]): OHLCV[] {
    const start = Date.parse('2024-01-02T14:00:00Z');
    return rows.map(([open, high, low, close], index) => ({ time: start + index * MINUTE, open, high, low, close, volume: 1 }));
}

/** A trend that never qualifies as a range, then a range 99–101 (bars 16–25). */
const LEAD: Row[] = [
    ...Array.from({ length: 16 }, (_, k): Row => [70 + k, 72 + k, 69 + k, 71 + k]),
    ...Array.from({ length: 10 }, (_, k): Row => (k % 2 === 0 ? [99.6, 101, 99.4, 100.6] : [100.4, 100.6, 99, 99.4])),
];

/** Breakout close at 26, a gap with the breakout at 27, a gap back at 29 closing under the middle. */
const FAKEOUT: Row[] = [
    ...LEAD,
    [100.6, 101.6, 100.5, 101.4], // 26: close above the range
    [101.4, 101.6, 101.3, 101.5], // 27: bullish gap over bar 25
    [101.5, 101.55, 100.3, 100.4],
    [100.4, 101.2, 99.8, 99.95], // 29: bearish gap under bar 27, close under 100
    [99.95, 100.1, 99.5, 99.6],
    [99.6, 99.7, 98.9, 99.1], // reaches the range low
    ...Array.from({ length: 5 }, (): Row => [99.1, 99.3, 98.9, 99.1]),
];

function mirrored(rows: readonly Row[]): Row[] {
    return rows.map(([open, high, low, close]) => [200 - open, 200 - low, 200 - high, 200 - close]);
}

const OPTS = { range: { minBars: 5 } };

describe('range fakeout detector', () => {
    it('finds the close back through the middle after a gap beyond the broken edge', () => {
        const [setup, ...rest] = detectRangeFakeouts(bars(FAKEOUT), OPTS);
        expect(rest).toEqual([]);
        expect(setup).toMatchObject({
            direction: 'bear',
            rangeStartIndex: 16,
            rangeEndIndex: 25,
            top: 101,
            bottom: 99,
            middle: 100,
            breakIndex: 26,
            extreme: 101.6,
            close: 99.95,
            index: 29,
            // The default counts only a gap pointing back into the range.
            gap: { direction: 'bear', top: 101.3, bottom: 101.2, index: 29 },
        });
    });

    it('can take the breakout impulse gap instead', () => {
        for (const gapSide of ['any', 'breakout'] as const) {
            const [setup] = detectRangeFakeouts(bars(FAKEOUT), { ...OPTS, gapSide });
            expect(setup!.gap).toMatchObject({ direction: 'bull', bottom: 100.6, top: 101.3, index: 27 });
        }
    });

    it('mirrors into a long after a fakeout below the range', () => {
        const [setup] = detectRangeFakeouts(bars(mirrored(FAKEOUT)), OPTS);
        expect(setup).toMatchObject({ direction: 'bull', extreme: 98.4, close: 100.05, index: 29 });
    });

    it('needs the gap by the first close through the middle, inside the window', () => {
        const noGap = FAKEOUT.map((row): Row => [...row]);
        noGap[29] = [100.4, 101.35, 99.8, 99.95]; // no longer clears bar 27's low
        expect(detectRangeFakeouts(bars(noGap), OPTS)).toEqual([]);
        expect(detectRangeFakeouts(bars(FAKEOUT), { ...OPTS, maxFakeoutBars: 2 })).toEqual([]);
    });

    it('targets the far edge only while it offers the minimum reward', () => {
        const [setup] = detectRangeFakeouts(bars(FAKEOUT), OPTS);
        // Risk 1.65 to the stop at 101.6; the range low at 99 is 0.95 away, about 0.58R.
        expect(rangeFakeoutTarget(setup!, 'range', 2, 0.5)).toBe(99);
        expect(rangeFakeoutTarget(setup!, 'range', 2, 0.6)).toBeNull();
        expect(rangeFakeoutTarget(setup!, 'fixed', 1, 0.6)).toBeCloseTo(99.95 - 1.65, 10);
    });

    it('refuses settings outside their vocabulary', () => {
        expect(() => detectRangeFakeouts(bars(FAKEOUT), { gapSide: 'inside' as never })).toThrow(/unknown gapSide/);
        expect(() => detectRangeFakeouts(bars(FAKEOUT), { maxFakeoutBars: 0 })).toThrow(/maxFakeoutBars/);
    });
});
