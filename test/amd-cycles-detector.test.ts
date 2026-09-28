import { describe, expect, it } from 'vitest';
import { detectAmdCycles, trackAmdGaps } from '../src/core/analysis/amdCycles';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

function bars(rows: readonly Row[]): OHLCV[] {
    const start = Date.parse('2024-01-02T14:00:00Z');
    return rows.map(([open, high, low, close], index) => ({ time: start + index * MINUTE, open, high, low, close, volume: 1 }));
}

const FLAT: Row = [100, 100.2, 99.9, 100.1];
const LOW_FLAT: Row = [99.1, 99.3, 98.9, 99.1];

/** Accumulation at 4, breakout above at 6, return at 8; a second range at 15 breaks below and never returns. */
const STORY: Row[] = [
    ...Array.from({ length: 6 }, () => FLAT),
    [100.1, 100.8, 100, 100.6], // 6: wick above the range
    [100.6, 100.9, 100.4, 100.5], // 7
    [100.5, 100.6, 100, 100.1], // 8: back below the broken edge
    [100.1, 100.15, 99.5, 99.6],
    [99.6, 99.7, 99, 99.1],
    ...Array.from({ length: 5 }, () => LOW_FLAT), // 11-15: second range qualifies at 15
    [99.1, 99.2, 98.5, 98.6], // 16: below the second range
    ...Array.from({ length: 5 }, (): Row => [98.6, 98.8, 98.4, 98.6]),
];

const OPTS = { accLength: 5, accRangePct: 0.5, breakout: 'wicks' as const, maxManipulationBars: 3 };

describe('AMD cycle detector', () => {
    it('follows accumulation, manipulation and distribution', () => {
        const [first, second] = detectAmdCycles(bars(STORY), OPTS);

        expect(first).toMatchObject({
            accStartIndex: 0,
            index: 4,
            accEndIndex: 5,
            accTop: 100.2,
            accBottom: 99.9,
            distributionIndex: 8,
            manipulation: { side: 'above', index: 6, extreme: 100.9, lastIndex: 8, outcome: 'distribution' },
        });
        expect(second).toMatchObject({
            accStartIndex: 11,
            index: 15,
            distributionIndex: null,
            manipulation: { side: 'below', index: 16, extreme: 98.4, outcome: 'abandoned', lastIndex: 20 },
        });
    });

    it('pauses one accumulation length after a distribution before searching again', () => {
        const rows = STORY.slice(0, 9).concat(Array.from({ length: 10 }, () => FLAT));
        const cycles = detectAmdCycles(bars(rows), OPTS);
        // The window 9-13 is already narrow, but the pause runs through bar 14.
        expect(cycles.map((c) => c.index)).toEqual([4, 15]);
    });

    it('still accepts a return on the bar that would otherwise abandon the manipulation', () => {
        const rows = STORY.map((row): Row => [...row]);
        rows[20] = [98.6, 99, 98.5, 98.9]; // high back above the second range's low
        const second = detectAmdCycles(bars(rows), OPTS)[1]!;
        expect(second.manipulation).toMatchObject({ outcome: 'distribution', lastIndex: 20 });
        expect(second.distributionIndex).toBe(20);
    });

    it('lets a wick widen the range when only bodies count, and reads Both as the wick', () => {
        const rows = STORY.map((row): Row => [...row]);
        rows[6] = [100.1, 100.8, 100, 100.15]; // wick above, body inside

        const bodies = detectAmdCycles(bars(rows.slice(0, 7)), { ...OPTS, breakout: 'bodies' })[0]!;
        expect(bodies).toMatchObject({ accTop: 100.8, accEndIndex: 6, manipulation: null });

        const wicks = detectAmdCycles(bars(rows), OPTS);
        expect(wicks[0]!.manipulation?.index).toBe(6);
        expect(detectAmdCycles(bars(rows), { ...OPTS, breakout: 'both' })).toEqual(wicks);
    });

    it('refuses settings outside their vocabulary', () => {
        expect(() => detectAmdCycles(bars(STORY), { ...OPTS, breakout: 'closes' as never })).toThrow(/unknown breakout/);
        expect(() => detectAmdCycles(bars(STORY), { ...OPTS, accLength: 1 })).toThrow(/accLength/);
    });
});

/** A bullish gap A at 2 ([101, 104]) and a bullish gap B inside it at 7 ([102.5, 103.2]). */
const NESTED: Row[] = [
    [100, 101, 99, 100],
    [100, 106, 100, 105],
    [105, 106, 104, 105.5],
    [105.5, 106, 103.5, 104],
    [104, 104.5, 101.8, 102],
    [102, 102.5, 101.5, 102.2],
    [102.2, 104, 102, 103.8],
    [103.8, 105, 103.2, 104.8],
];

/** A bullish gap at 2 ([101, 102]), broken by the close at 5 and closed back over at 6. */
const BROKEN: Row[] = [
    [100, 101, 99, 100],
    [100, 104, 100, 103.5],
    [103.5, 105, 102, 104.5],
    [104.5, 105, 103, 104],
    [104, 104.5, 101.5, 101.8],
    [101.8, 102, 100.5, 100.8],
    [100.8, 102.5, 100.6, 102.2],
    [102.2, 102.4, 102, 102.3],
];

const GAPS = { minAtr: 0, atrLength: 1 };

describe('AMD gap tracker', () => {
    it('drops a gap lying inside a holding gap of the same direction', () => {
        const bulls = (skipOverlapping: boolean) => trackAmdGaps(bars(NESTED), { ...GAPS, skipOverlapping })
            .filter((g) => g.direction === 'bull')
            .map((g) => [g.bottom, g.top]);
        expect(bulls(true)).toEqual([[101, 104]]);
        expect(bulls(false)).toEqual([[101, 104], [102.5, 103.2]]);
    });

    it('ends a broken gap, or keeps it inverted until a close crosses back', () => {
        const gapAt2 = (keepInverted: boolean) => trackAmdGaps(bars(BROKEN), { ...GAPS, keepInverted })
            .find((g) => g.index === 2)!;
        expect(gapAt2(false)).toMatchObject({ brokenIndex: 5, inverted: false, endIndex: 5 });
        expect(gapAt2(true)).toMatchObject({ brokenIndex: 5, inverted: true, endIndex: 6 });
    });

    it('drops the oldest live gap beyond the limit, and filters by ATR', () => {
        const [a] = trackAmdGaps(bars(NESTED), { ...GAPS, skipOverlapping: false, maxLive: 1 });
        expect(a).toMatchObject({ index: 2, endIndex: 5 });
        expect(trackAmdGaps(bars(NESTED), { minAtr: 10, atrLength: 1 })).toEqual([]);
    });
});
