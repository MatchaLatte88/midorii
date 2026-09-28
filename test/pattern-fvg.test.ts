import { describe, it, expect } from 'vitest';
import { buildFeatures, FVG_MAX_AGE, type PatternBar } from '../app/renderer/patterns/atoms';
import { hasBit } from '../app/renderer/patterns/bits';

/**
 * The fair value gap atoms, on a gap built by hand.
 *
 * Sixty quiet bars to warm the averages up, then a bullish gap between 101 and 104 confirmed
 * on bar 62, and whatever `after` says price did with it.
 */

const HOUR = 3_600_000;
const GAP_BAR = 62;

type Ohlc = [open: number, high: number, low: number, close: number];

function series(after: Ohlc[]): PatternBar[] {
    const rows: Ohlc[] = [];
    for (let i = 0; i < 60; i++) {
        const close = 100 + (i % 2 === 0 ? 0.4 : -0.4);
        rows.push([100, 101, 99, close]);
    }
    rows.push([100, 101, 99, 100.5]); // 60 — the gap's left edge: high 101
    rows.push([100.5, 106, 100.3, 105.8]); // 61 — the impulse
    rows.push([105.8, 106.5, 104, 106]); // 62 — low 104 leaves [101, 104] untraded
    rows.push(...after);
    return rows.map(([open, high, low, close], i) => ({ time: Date.UTC(2024, 0, 1) + i * HOUR, open, high, low, close, volume: 10 }));
}

function atomAt(bars: PatternBar[], id: string, index: number): boolean {
    const atom = buildFeatures(bars).atoms.find((a) => a.id === id);
    if (!atom) throw new Error(`no atom ${id}`);
    return hasBit(atom.bits, index);
}

function atomBars(bars: PatternBar[], id: string): number[] {
    const atom = buildFeatures(bars).atoms.find((a) => a.id === id)!;
    return bars.map((_b, i) => i).filter((i) => hasBit(atom.bits, i));
}

describe('fair value gap atoms', () => {
    const retest = series([
        [106, 106.5, 105, 105.5], // 63 — stays above the gap
        [105.5, 105.8, 103, 104.5], // 64 — dips in, closes back above it
        [104.5, 104.8, 102, 103], // 65 — in it, closes inside
        [103, 103.2, 99.5, 100], // 66 — closes below it: broken
        [100, 104.5, 99.8, 104.2], // 67 — back in, but the gap is gone
    ]);

    it('marks the bar that completes the gap, and only that one', () => {
        expect(atomBars(retest, 'f.bullnew')).toEqual([GAP_BAR]);
    });

    it('follows a retest from the first touch to the close that breaks it', () => {
        expect(atomBars(retest, 'f.bulltap')).toEqual([64, 65, 66]);
        expect(atomBars(retest, 'f.bullhold')).toEqual([64]);
        expect(atomBars(retest, 'f.bullbreak')).toEqual([66]);
    });

    it('stops watching a gap once it is too old to be a fresh imbalance', () => {
        const quiet: Ohlc[] = Array.from({ length: FVG_MAX_AGE + 5 }, () => [106, 106.5, 105.5, 106]);
        const touchAt = (age: number): PatternBar[] => {
            const after = quiet.slice(0, age - 1);
            after.push([106, 106.2, 103.5, 105]);
            return series(after);
        };
        expect(atomAt(touchAt(FVG_MAX_AGE), 'f.bulltap', GAP_BAR + FVG_MAX_AGE)).toBe(true);
        expect(atomAt(touchAt(FVG_MAX_AGE + 1), 'f.bulltap', GAP_BAR + FVG_MAX_AGE + 1)).toBe(false);
    });

    it('ignores a gap too thin to be anything but noise', () => {
        const bars = series([]);
        // Close the gap to 0.1 — a twentieth of the two-point average range here.
        bars[GAP_BAR] = { ...bars[GAP_BAR]!, low: 101.1 };
        expect(atomBars(bars, 'f.bullnew')).toEqual([]);
    });
});
