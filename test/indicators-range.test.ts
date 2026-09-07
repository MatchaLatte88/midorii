// What a range is, what it is not, and what it comes out as on the chart.
//
// Most of these are built from synthetic bars whose ATR is known exactly, so the compression
// limit can be reasoned about rather than guessed at. The timeframe test is the one that needs
// real shape: it checks the property the indicator exists for — that the same settings mean the
// same thing on a fast chart and a slow one.
import { describe, it, expect } from 'vitest';
import { RANGE_DEFAULTS, countTouches, detectRanges } from '../src/core/analysis/range';
import { buildRangeOutput, rangeDescriptor } from '../src/core/native-indicators/range';
import type { Range } from '../src/core/analysis/range';
import type { DrawingBox, DrawingLine } from '../src/core/model/drawings';
import type { OHLCV } from '../src/core/model/ohlcv';

/** Bars from [open, high, low, close] tuples; time is just the index. */
function bars(rows: readonly (readonly [number, number, number, number])[]): OHLCV[] {
    return rows.map(([open, high, low, close], i) => ({ time: i, open, high, low, close, volume: 1 }));
}

type Row = readonly [number, number, number, number];

/**
 * A run of bars oscillating between `low` and `high`.
 *
 * Alternating so both edges are visited over and over — the touch count is never what fails in
 * a test that is about something else.
 */
function oscillate(count: number, low: number, high: number): Row[] {
    const rows: Row[] = [];
    const mid = (low + high) / 2;
    for (let i = 0; i < count; i += 1) rows.push(i % 2 === 0 ? [mid, high, mid, mid] : [mid, mid, low, mid]);
    return rows;
}

/** A move of `step` per bar, wide enough to set an ATR before a range starts. */
function trend(count: number, start: number, step: number): Row[] {
    const rows: Row[] = [];
    let price = start;
    for (let i = 0; i < count; i += 1) {
        rows.push([price, price + step, price, price + step]);
        price += step;
    }
    return rows;
}

/* Thirty bars climbing by 10 sets ATR(14) to 10, then forty bars oscillating in a 12-wide band.
 * The band is 12 against a limit of 0.6 × 10 × √40 ≈ 38, so it is comfortably a range; bar 70
 * closes far above it and breaks it. */
const CONSOLIDATION: Row[] = [
    ...trend(30, 100, 10),
    ...oscillate(40, 394, 406),
    [400, 460, 400, 455],
];

describe('the pattern itself', () => {
    it('reads a compressed, two-sided stretch as a range', () => {
        const ranges = detectRanges(bars(CONSOLIDATION));
        expect(ranges).toHaveLength(1);
        expect(ranges[0]).toMatchObject({
            top: 406, bottom: 394, middle: 400, height: 12,
            startIndex: 30, endIndex: 69, length: 40,
        });
    });

    it('calls the bar that closes beyond an edge the breakout', () => {
        const r = detectRanges(bars(CONSOLIDATION))[0]!;
        expect(r).toMatchObject({ breakIndex: 70, breakDirection: 'up', breakClose: 455, breakTime: 70 });
        expect(r.active).toBe(false); // a range that broke is not still running
    });

    it('mirrors that for a close below the low', () => {
        const r = detectRanges(bars([...trend(30, 100, 10), ...oscillate(40, 394, 406), [400, 400, 340, 345]]))[0]!;
        expect(r.breakDirection).toBe('down');
        expect(r.breakClose).toBe(345);
    });

    it('lets a wick past an edge widen the range instead of ending it', () => {
        // Bar 50 spikes to 420 and closes back at 400 — a raid on the edge, not a breakout.
        const rows = [...trend(30, 100, 10), ...oscillate(40, 394, 406)];
        rows[50] = [400, 420, 400, 400];
        const ranges = detectRanges(bars([...rows, [400, 460, 400, 455]]));
        expect(ranges).toHaveLength(1);
        expect(ranges[0]!.top).toBe(420);
        expect(ranges[0]!.breakIndex).toBe(70);
    });

    it('marks a range still running at the last bar as active', () => {
        const ranges = detectRanges(bars([...trend(30, 100, 10), ...oscillate(40, 394, 406)]));
        expect(ranges).toHaveLength(1);
        expect(ranges[0]!.breakIndex).toBeNull();
        expect(ranges[0]!.active).toBe(true);
    });
});

describe('what is refused', () => {
    it('refuses a trend, however smooth', () => {
        expect(detectRanges(bars(trend(200, 100, 10)))).toEqual([]);
    });

    it('refuses a stretch too short to qualify', () => {
        expect(detectRanges(bars([...trend(30, 100, 10), ...oscillate(15, 394, 406), ...trend(30, 400, 10)]))).toEqual([]);
    });

    it('refuses a narrow diagonal drift for want of touches', () => {
        /* Compressed enough — it creeps by 0.4 a bar — but price visits each edge exactly once,
         * at the two ends. Without the touch rule this passes, and it is the single most common
         * false positive. */
        const rows: Row[] = [...trend(30, 100, 10)];
        let price = 400;
        for (let i = 0; i < 40; i += 1) {
            rows.push([price, price + 0.4, price, price + 0.4]);
            price += 0.4;
        }
        const drift = bars(rows);
        expect(detectRanges(drift)).toEqual([]);
        // One touch per side is no filter at all — both edges are touched by definition.
        expect(detectRanges(drift, { minTouches: 1 })).toHaveLength(1);
    });

    it('refuses an ordinary stretch once compression is tightened', () => {
        const data = bars(CONSOLIDATION);
        expect(detectRanges(data, { compression: 0.6 })).toHaveLength(1);
        // 12 wide against 0.02 × 10 × √20 ≈ 0.9 — nothing survives that.
        expect(detectRanges(data, { compression: 0.02 })).toEqual([]);
    });

    it('cuts a range off at maxBars before it can cover the chart', () => {
        const long = bars([...trend(30, 100, 10), ...oscillate(200, 394, 406)]);
        expect(detectRanges(long)[0]!.length).toBe(200);
        expect(detectRanges(long, { maxBars: 50 })[0]!.length).toBe(50);
    });

    it('refuses bad arguments rather than quietly correcting them', () => {
        const data = bars(CONSOLIDATION);
        expect(() => detectRanges(data, { minBars: 1 })).toThrow(/minBars/);
        expect(() => detectRanges(data, { maxBars: 5, minBars: 20 })).toThrow(/maxBars/);
        expect(() => detectRanges(data, { compression: 0 })).toThrow(/compression/);
        expect(() => detectRanges(data, { touchZone: 0 })).toThrow(/touchZone/);
        expect(() => detectRanges(data, { touchZone: 60 })).toThrow(/touchZone/);
    });

    it('returns nothing for no bars, rather than crashing', () => {
        expect(detectRanges([])).toEqual([]);
        expect(detectRanges([{ time: 0, open: 1, high: 1, low: 1, close: 1 }])).toEqual([]);
    });
});

describe('look-ahead', () => {
    it('knows nothing before the bar that confirmed it', () => {
        const r = detectRanges(bars(CONSOLIDATION))[0]!;
        expect(r.index).toBeGreaterThanOrEqual(r.startIndex + 19); // not before the minimum length
        expect(r.index).toBeLessThanOrEqual(r.endIndex); // nor after the range it confirms
        expect(r.time).toBe(r.index); // the confirming bar's time, not the first bar's
    });

    it('carries the edges that had been printed by then, separately from the final ones', () => {
        /* Bar 50 lifts the top from 406 to 420, well after confirmation. `top` has to carry the
         * final value and `confirmTop` the one a strategy could have read. */
        const rows = [...trend(30, 100, 10), ...oscillate(40, 394, 406)];
        rows[50] = [400, 420, 400, 400];
        const r = detectRanges(bars([...rows, [400, 460, 400, 455]]))[0]!;
        expect(r.top).toBe(420);
        expect(r.confirmTop).toBe(406);
        expect(r.confirmBottom).toBe(394);
        expect(r.index).toBeLessThan(50); // confirmed before that bar existed
    });

    it('never overlaps two ranges, and keeps them in order', () => {
        const ranges = detectRanges(bars([
            ...trend(30, 100, 10), ...oscillate(30, 394, 406),
            ...trend(30, 400, 10), ...oscillate(30, 694, 706),
            ...trend(10, 700, 10),
        ]));
        expect(ranges).toHaveLength(2);
        expect(ranges[0]!.endIndex).toBeLessThan(ranges[1]!.startIndex);
    });

    it('keeps only what was confirmed recently under lookback', () => {
        const data = bars([
            ...trend(30, 100, 10), ...oscillate(30, 394, 406),
            ...trend(30, 400, 10), ...oscillate(30, 694, 706),
            ...trend(10, 700, 10),
        ]);
        expect(detectRanges(data)).toHaveLength(2);
        // The first range confirms around bar 50; 60 bars back from 130 excludes it.
        expect(detectRanges(data, { lookback: 60 })).toHaveLength(1);
    });
});

describe('touches', () => {
    it('counts a visit once however long price stays at the edge', () => {
        // Four bars pinned to the top, then one away, then one back: two visits.
        const data = bars([
            [10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10],
            [5, 5, 0, 5],
            [10, 10, 10, 10],
        ]);
        expect(countTouches(data, 0, 5, 10, 0, 0.15)).toEqual({ top: 2, bottom: 1 });
    });

    it('measures the edge zone as a share of the height, not a fixed distance', () => {
        // A bar reaching 9 is inside the top 15% of a 0..10 range, and outside 5%.
        const data = bars([[9, 9, 9, 9]]);
        expect(countTouches(data, 0, 0, 10, 0, 0.15).top).toBe(1);
        expect(countTouches(data, 0, 0, 10, 0, 0.05).top).toBe(0);
    });
});

describe('timeframe independence', () => {
    it('finds the same range whatever the bars measure', () => {
        /* The whole point of the indicator. Two markets with identical shape but volatility an
         * order of magnitude apart — a fast chart and a slow one — must produce the same range
         * under the same settings, which a threshold in price or percent could not do. */
        const shape = (scale: number): OHLCV[] => bars([
            ...trend(30, 100, 10 * scale),
            ...oscillate(40, 400 - 6 * scale, 400 + 6 * scale),
            [400, 400 + 60 * scale, 400, 400 + 55 * scale],
        ]);

        const fast = detectRanges(shape(1));
        const slow = detectRanges(shape(10));
        expect(fast).toHaveLength(1);
        expect(slow).toHaveLength(1);
        for (const key of ['startIndex', 'index', 'endIndex', 'length', 'breakIndex', 'breakDirection'] as const) {
            expect(slow[0]![key]).toEqual(fast[0]![key]);
        }
        // The heights differ by exactly the scale; the compression reading does not.
        expect(slow[0]!.height).toBeCloseTo(fast[0]!.height * 10, 8);
        expect(Math.abs(slow[0]!.compression - fast[0]!.compression)).toBeLessThan(1e-9);
    });

    it('needs more room the longer a range runs, not the same room', () => {
        /* √length, not length: doubling the bars raises the limit by about 1.41, so a band that
         * is fine over 20 bars can still be too wide over 80. Without the square root a range
         * could hold a constant width forever and quietly become a trend channel. */
        const found = detectRanges(bars([...trend(30, 100, 10), ...oscillate(80, 375, 425)]));
        // 50 wide against 0.6 × 10 × √20 ≈ 27 at twenty bars, and ≈ 54 at eighty.
        expect(found).toHaveLength(1);
        expect(found[0]!.length).toBeGreaterThan(60); // only qualifies once it has run long enough
        expect(found[0]!.startIndex).toBeGreaterThan(30); // so it cannot start at the band's first bar
    });
});

describe('what the indicator draws', () => {
    const view = { color: '#787b86', bullColor: '#089981', bearColor: '#f23645' };
    /** Both arrays, unwrapped once — the output type makes them optional, this builder never does. */
    const drawn = (ranges: readonly Range[]): { boxes: DrawingBox[]; lines: DrawingLine[] } => {
        const out = buildRangeOutput(ranges, view);
        return { boxes: out.boxes ?? [], lines: out.lines ?? [] };
    };
    const byId = (out: { boxes: { id: string }[]; lines: { id: string }[] }): string[] =>
        [...out.boxes.map((b) => b.id), ...out.lines.map((l) => l.id)];

    it('draws a box, two edges, an equilibrium and the break', () => {
        const r = detectRanges(bars(CONSOLIDATION))[0]!;
        const out = drawn([r]);
        expect(byId(out)).toEqual([
            'range_30_box', 'range_30_break',
            'range_30_top', 'range_30_bottom', 'range_30_mid', 'range_30_break_close',
        ]);

        const box = out.boxes.find((b) => b.id === 'range_30_box')!;
        expect(box).toMatchObject({ left: r.startTime, right: r.endTime, top: 406, bottom: 394 });
        // No border of its own: the two price edges are lines, and a range has no vertical sides.
        expect(box.borderWidth).toBe(0);

        const mid = out.lines.find((l) => l.id === 'range_30_mid')!;
        expect(mid).toMatchObject({ y1: 400, y2: 400, style: 'dashed', extend: 'none' });
    });

    it('runs the edges on past the last bar while the range is still live', () => {
        const r = detectRanges(bars([...trend(30, 100, 10), ...oscillate(40, 394, 406)]))[0]!;
        const out = drawn([r]);
        const tails = out.lines.filter((l) => l.id.includes('_tail_'));
        expect(tails).toHaveLength(2);
        for (const t of tails) expect(t).toMatchObject({ extend: 'right', style: 'dashed', x1: r.endTime });
        // The equilibrium is still the level being traded back to, so it runs on too.
        expect(out.lines.find((l) => l.id === 'range_30_mid')!.extend).toBe('right');
        // Nothing broke, so there is no break mark.
        expect(out.boxes.some((b) => b.id.endsWith('_break'))).toBe(false);
    });

    it('draws the break from the edge that gave way to the close that broke it', () => {
        const r = detectRanges(bars(CONSOLIDATION))[0]!;
        const out = drawn([r]);
        const brk = out.boxes.find((b) => b.id === 'range_30_break')!;
        // Top edge 406 up to the breaking close 455, over the bars either side of the break.
        expect(brk).toMatchObject({ top: 455, bottom: 406, left: r.endTime, right: r.breakTime });
        expect(brk.bgColor).toBe('rgba(8,153,129,0.3)'); // up broke it, so the bull colour
        expect(out.lines.find((l) => l.id === 'range_30_break_close')!).toMatchObject({ y1: 455, style: 'solid' });
    });

    it('takes the bear colour for a break downward', () => {
        const r = detectRanges(bars([...trend(30, 100, 10), ...oscillate(40, 394, 406), [400, 400, 340, 345]]))[0]!;
        const brk = drawn([r]).boxes.find((b) => b.id === 'range_30_break')!;
        expect(brk).toMatchObject({ top: 394, bottom: 345 });
        expect(brk.bgColor).toBe('rgba(242,54,69,0.3)');
    });

    it('draws nothing at all for no ranges', () => {
        expect(drawn([])).toEqual({ boxes: [], lines: [] });
    });
});

describe('the indicator descriptor', () => {
    it('declares the defaults the detector actually uses', () => {
        /* Two lists that have to agree: the schema the settings dialog builds fields from, and
         * the detector's own defaults. A drift between them would show as a chart that changes
         * the moment a field is touched. */
        const declared = Object.fromEntries(
            rangeDescriptor.inputsSchema().map((f) => [f.key, f.defval]),
        ) as Record<string, number>;
        const data = bars(CONSOLIDATION);
        expect(detectRanges(data, declared)).toEqual(detectRanges(data));

        for (const [key, value] of Object.entries(RANGE_DEFAULTS)) {
            expect(declared[key]).toBe(value);
        }
    });

    it('stays out of the price scale', () => {
        // Ranges are context spread over the whole history; folding them in would zoom the
        // chart out to whatever range sits furthest from price.
        expect(rangeDescriptor.autoscaleDrawings).toBe(false);
        expect(rangeDescriptor.multiInstance).toBe(true);
    });
});
