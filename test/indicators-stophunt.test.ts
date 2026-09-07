// What a stop hunt is, what it is not, and what it comes out as on the chart.
import { describe, it, expect } from 'vitest';
import {
    STOPHUNT_DEFAULTS, detectStopHunts, equalLevels, findSwings, sessionLevels,
} from '../src/core/analysis/stophunt';
import type { StopHunt } from '../src/core/analysis/stophunt';
import { buildStopHuntOutput, stopHuntDescriptor } from '../src/core/native-indicators/stophunt';
import type { NativeIndicatorContext, NativeIndicatorOutput } from '../src/core/native-indicators/NativeIndicator';
import { getNativeIndicator, registerNativeIndicator } from '../src/core/native-indicators/NativeIndicator';
import type { InputValue } from '../src/core/model/inputs';
import type { OHLCV } from '../src/core/model/ohlcv';
import { BEARISH, BULLISH } from '../src/core/palette';

/** Bars from [open, high, low, close] tuples; time is just the index. */
function bars(rows: readonly (readonly [number, number, number, number])[]): OHLCV[] {
    return rows.map(([open, high, low, close], i) => ({ time: i, open, high, low, close }));
}

/* A swing high of 15 at index 2 — two lower bars on each side, so it is a fractal at strength 2
 * and known from index 4. Bar 5 wicks to 16 and closes at 13.5, back under it. */
const HUNT_HIGH = [
    [10, 11, 9, 10],
    [10, 12, 10, 11],
    [11, 15, 11, 14],
    [14, 14, 13, 13],
    [13, 14, 12, 13],
    [13, 16, 13, 13.5],
] as const;

// The same six bars, except the last one closes at 15.8 and stays there — the break, not the hunt.
const BREAK_HIGH = [...HUNT_HIGH.slice(0, 5), [13, 16, 13, 15.8]] as const;

// The mirror: a swing low of 9 at index 2, run to 8 and reclaimed.
const HUNT_LOW = [
    [14, 15, 13, 14],
    [14, 14, 12, 13],
    [13, 13, 9, 10],
    [10, 11, 10, 11],
    [11, 12, 10, 11],
    [11, 12, 8, 11.5],
] as const;

describe('analysis/stophunt the pattern itself', () => {
    it('a wick through a swing high and a close back under is a hunt', () => {
        const [h] = detectStopHunts(bars(HUNT_HIGH), { confirmBars: 1 });
        expect(h).toMatchObject({ direction: 'bear', side: 'high', source: 'swing', level: 15, extreme: 16, depth: 1 });
    });

    it('a wick through a swing low and a close back over is the mirror', () => {
        const [h] = detectStopHunts(bars(HUNT_LOW), { confirmBars: 1 });
        expect(h).toMatchObject({ direction: 'bull', side: 'low', level: 9, extreme: 8 });
    });

    it('the same wick without the reclaim is a break, not a hunt', () => {
        expect(detectStopHunts(bars(BREAK_HIGH), { confirmBars: 1 })).toEqual([]);
    });

    it('a level nothing reached is not a hunt', () => {
        const rows = bars([...HUNT_HIGH.slice(0, 5), [13, 14.9, 13, 14.5]]);
        expect(detectStopHunts(rows, { confirmBars: 1 })).toEqual([]);
    });

    it('touching the level exactly is not trading through it', () => {
        const rows = bars([...HUNT_HIGH.slice(0, 5), [13, 15, 13, 13.5]]);
        expect(detectStopHunts(rows, { confirmBars: 1 })).toEqual([]);
    });
});

describe('analysis/stophunt look-ahead', () => {
    it('a swing is only known once its right-hand bars have closed', () => {
        const [swing] = findSwings(bars(HUNT_HIGH), 2);
        expect(swing).toMatchObject({ formedIndex: 2, knownIndex: 4 });
    });

    it('a level cannot be swept before it is known', () => {
        /* The high at index 2 is 15. Index 3 trades to 15.5 and back — but at index 3 no one
         * could know index 2 was a swing yet: bar 4 has not closed. Strength 2 means the level
         * is knowable at index 4. */
        const rows = bars([
            [10, 11, 9, 10],
            [10, 12, 10, 11],
            [11, 15, 11, 14],
            [14, 15.5, 13, 13.5],
            [13, 14, 12, 13],
            [13, 14, 12, 13],
        ]);
        expect(detectStopHunts(rows, { strength: 2, confirmBars: 1 })).toEqual([]);
    });

    it('the confirming index is never earlier than the sweep, and a bar cannot sweep its own level', () => {
        const rows = bars(HUNT_HIGH);
        for (const confirmBars of [1, 2, 5, 20]) {
            for (const h of detectStopHunts(rows, { confirmBars })) {
                expect(h.index).toBeGreaterThanOrEqual(h.sweepIndex);
                expect(h.sweepIndex).toBeGreaterThan(h.levelIndex);
            }
        }
    });
});

describe('analysis/stophunt the confirmation window', () => {
    // Bar 5 breaches and closes above; bar 6 still closes above; bar 7 closes back under.
    const SLOW_RECLAIM = [
        ...HUNT_HIGH.slice(0, 5),
        [13, 16, 13, 15.8],
        [15.8, 16, 15.4, 15.5],
        [15.5, 15.6, 13.5, 14],
    ] as const;

    it('confirmBars counts from the breaching bar inclusive', () => {
        const rows = bars(SLOW_RECLAIM);
        const n = (confirmBars: number): StopHunt[] => detectStopHunts(rows, { confirmBars });

        // The window is bars 5, 6, 7 — so it takes 3 to reach the reclaim.
        expect(n(1)).toEqual([]);
        expect(n(2)).toEqual([]);
        expect(n(3)).toHaveLength(1);
        expect(n(4)).toHaveLength(1);
    });

    it('a slow reclaim is confirmed on the bar that reclaimed, not the sweep', () => {
        const [h] = detectStopHunts(bars(SLOW_RECLAIM), { confirmBars: 3 });
        expect(h).toMatchObject({ sweepIndex: 5, index: 7, extreme: 16 });
    });

    it('a one-bar hunt is a hunt under every window setting', () => {
        const rows = bars(HUNT_HIGH);
        for (const confirmBars of [1, 2, 10]) {
            const hunts = detectStopHunts(rows, { confirmBars });
            expect(hunts).toHaveLength(1);
            expect(hunts[0]!.sweepIndex).toBe(hunts[0]!.index);
        }
    });

    it('a level is spent once it has been run, whatever happened next', () => {
        // Bar 7 runs the same price again, but the stops behind it filled two bars ago.
        const rows = bars([...HUNT_HIGH, [13.5, 14, 13, 13.5], [13.5, 16, 13.4, 13.8]]);
        const hunts = detectStopHunts(rows, { confirmBars: 1 });
        expect(hunts.filter((h) => h.level === 15)).toHaveLength(1);
    });
});

describe('analysis/stophunt minimum penetration', () => {
    it('minWick ignores a level that was only grazed', () => {
        // 15.01 is 0.067% past the level; 16 is 6.7% past it.
        const grazed = bars([...HUNT_HIGH.slice(0, 5), [13, 15.01, 13, 13.5]]);
        const n = (rows: OHLCV[], minWick: number): number => detectStopHunts(rows, { confirmBars: 1, minWick }).length;

        expect(n(grazed, 0)).toBe(1);
        expect(n(grazed, 0.05)).toBe(1);
        expect(n(grazed, 0.5)).toBe(0);
        // The deep one clears every threshold the shallow one fails.
        expect(n(bars(HUNT_HIGH), 0.5)).toBe(1);
    });
});

describe('analysis/stophunt equal highs and lows', () => {
    // Two swing highs, at 15 and 15.005 — 0.03% apart. Bar 9 runs both.
    const EQUAL_HIGHS = [
        [10, 11, 9, 10],
        [10, 12, 10, 11],
        [11, 15, 11, 14],
        [14, 14, 13, 13],
        [13, 14, 12, 13],
        [13, 14.5, 12.5, 14],
        [14, 15.005, 13.8, 14.2],
        [14.2, 14.4, 13, 13.2],
        [13.2, 14, 12.8, 13.5],
        [13.5, 16, 13.4, 14],
    ] as const;

    it('two swings at the same price are one level, at the extreme', () => {
        const [lv] = equalLevels(findSwings(bars(EQUAL_HIGHS), 2), 0.05);
        // The extreme, not the average: stops sit beyond the furthest of them.
        expect(lv).toMatchObject({ side: 'high', price: 15.005, count: 2, formedIndex: 2, knownIndex: 8 });
    });

    it('the tolerance decides what counts as the same price', () => {
        const swings = findSwings(bars(EQUAL_HIGHS), 2);
        // 0.03% apart: inside a 0.05% tolerance, outside a 0.01% one.
        expect(equalLevels(swings, 0.05)).toHaveLength(1);
        expect(equalLevels(swings, 0.01)).toHaveLength(0);
        // Zero demands an exact match rather than turning the filter off.
        expect(equalLevels(swings, 0)).toHaveLength(0);
    });

    it('a cluster reports how many swings stacked up in it', () => {
        const [h] = detectStopHunts(bars(EQUAL_HIGHS), { sources: ['equal'] });
        expect(h).toMatchObject({ source: 'equal', count: 2, level: 15.005 });
    });

    it('the cluster and the swings inside it are not reported twice', () => {
        const hunts = detectStopHunts(bars(EQUAL_HIGHS), { sources: ['swing', 'equal'] });
        const atSweep9 = hunts.filter((h) => h.sweepIndex === 9);
        expect(atSweep9).toHaveLength(1);
        expect(atSweep9[0]!.source).toBe('equal');
    });
});

describe('analysis/stophunt session levels', () => {
    /** Hourly bars from a fixed UTC start, so session windows land predictably. */
    function hourlyBars(rows: ReadonlyArray<readonly [number, number, number, number]>, startMs: number): OHLCV[] {
        return rows.map(([open, high, low, close], i) => ({ time: startMs + i * 3_600_000, open, high, low, close }));
    }

    it('session levels come from closed sessions only', () => {
        // 24 hours from midnight UTC on a Wednesday, so Asia, London and New York all appear.
        const start = Date.UTC(2025, 0, 8, 0, 0);
        const rows = hourlyBars(
            Array.from({ length: 40 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as const),
            start,
        );
        const levels = sessionLevels(rows, 'futures');

        expect(levels.length).toBeGreaterThan(0);
        for (const lv of levels) {
            expect(['high', 'low']).toContain(lv.side);
            expect(lv.source).toBe('session');
            expect(lv.sessionName).toBeTruthy();
            // Knowable only after the session closed, never during it.
            expect(lv.knownIndex).toBeGreaterThan(lv.formedIndex);
            // The session still running at the right edge is not a level yet.
            expect(lv.knownIndex).toBeLessThanOrEqual(rows.length - 1);
        }
    });

    it('a session still open at the right edge gives no level', () => {
        const start = Date.UTC(2025, 0, 8, 0, 0);
        // Four bars, all inside the Asia window — the session never closes in view.
        const rows = hourlyBars([[100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102], [102, 104, 101, 103]], start);
        expect(sessionLevels(rows, 'futures')).toEqual([]);
    });
});

describe('analysis/stophunt invalidation, show and lookback', () => {
    // The hunt at bar 5 works, then bar 7 closes back above the level — the reclaim did not hold.
    const FAILED_HUNT = [...HUNT_HIGH, [13.5, 14, 13, 13.5], [13.5, 17, 13.4, 16.5]] as const;

    it('a hunt price closed back through is marked, not deleted', () => {
        const [h] = detectStopHunts(bars(FAILED_HUNT), { confirmBars: 1 });
        expect(h).toMatchObject({ invalidatedIndex: 7, sweepIndex: 5 });
    });

    it('a hunt is only on trial for holdBars after it confirmed', () => {
        const rows = bars(FAILED_HUNT);
        const invalidated = (holdBars: number): number | null => detectStopHunts(rows, { confirmBars: 1, holdBars })[0]!.invalidatedIndex;

        expect(invalidated(2)).toBe(7);
        expect(invalidated(10)).toBe(7);
        expect(invalidated(1)).toBeNull(); // failed after its window had closed
        expect(invalidated(0)).toBe(7); // the unbounded reading
    });

    it('a hunt that survived its window cannot fail later', () => {
        const rows = bars([...HUNT_HIGH, ...Array.from({ length: 6 }, () => [13.5, 14, 13, 13.5] as const), [13.5, 17, 13.4, 16.5]]);
        expect(detectStopHunts(rows, { confirmBars: 1, holdBars: 3 })[0]!.invalidatedIndex).toBeNull();
        expect(detectStopHunts(rows, { confirmBars: 1, holdBars: 0 })[0]!.invalidatedIndex).toBe(12);
    });

    it('a negative hold window is refused', () => {
        expect(() => detectStopHunts(bars(HUNT_HIGH), { holdBars: -1 })).toThrow(/holdBars must be >= 0/);
    });

    it('show decides whether a failed hunt stays on the chart', () => {
        const rows = bars(FAILED_HUNT);
        expect(detectStopHunts(rows, { confirmBars: 1 })).toHaveLength(1); // default keeps it
        expect(detectStopHunts(rows, { confirmBars: 1, show: 'active' })).toEqual([]);
    });

    it('the confirming bar cannot invalidate its own hunt', () => {
        for (const h of detectStopHunts(bars(HUNT_HIGH), { confirmBars: 1 })) expect(h.invalidatedIndex).not.toBe(h.index);
    });

    it('lookback counts back from the newest bar', () => {
        const rows = bars([...HUNT_HIGH, [13.5, 14, 13, 13.5], [13.5, 14, 13, 13.5]]);
        const n = (lookback: number): number => detectStopHunts(rows, { confirmBars: 1, lookback }).length;

        expect(n(3)).toBe(1);
        expect(n(2)).toBe(0); // the window stopped short of the confirming bar
        expect(n(0)).toBe(1); // zero is off, not a window of nothing
    });
});

describe('analysis/stophunt edges', () => {
    it('too few bars to hold a swing produce nothing', () => {
        for (const n of [0, 1, 2, 3, 4]) expect(detectStopHunts(bars(HUNT_HIGH.slice(0, n)), { strength: 2 })).toEqual([]);
    });

    it('no sources is a switched-off indicator, not an error', () => {
        expect(detectStopHunts(bars(HUNT_HIGH), { sources: [] })).toEqual([]);
    });

    it('equal ties are not swings between themselves', () => {
        const rows = bars([[10, 11, 9, 10], [10, 15, 10, 14], [14, 15, 13, 14], [14, 14, 13, 13], [13, 14, 12, 13]]);
        expect(findSwings(rows, 1).filter((s) => s.side === 'high' && s.price === 15)).toEqual([]);
    });

    it('a bad parameter is refused rather than guessed', () => {
        const rows = bars(HUNT_HIGH);
        expect(() => detectStopHunts(rows, { sources: ['orderblock' as never] })).toThrow(/unknown source/);
        expect(() => detectStopHunts(rows, { show: 'maybe' as never })).toThrow(/unknown show/);
        expect(() => detectStopHunts(rows, { strength: 0 })).toThrow(/strength must be >= 1/);
        expect(() => detectStopHunts(rows, { confirmBars: 0 })).toThrow(/confirmBars must be >= 1/);
    });

    it('the schema defaults and the code defaults are the same rules', () => {
        const rows = bars(HUNT_HIGH);
        expect(detectStopHunts(rows, { ...STOPHUNT_DEFAULTS })).toEqual(detectStopHunts(rows));
    });
});

describe('native-indicators/stophunt output', () => {
    const HR = 3600_000;
    const TIMES = [0, HR, 2 * HR, 3 * HR, 4 * HR, 5 * HR];
    const view = { bullColor: BULLISH, bearColor: BEARISH };

    const oneBar: StopHunt = {
        direction: 'bear', side: 'high', source: 'swing', level: 100, extreme: 105, depth: 5, count: 1, sessionName: null,
        levelIndex: 0, levelTime: 0, sweepIndex: 2, sweepTime: 2 * HR, index: 2, time: 2 * HR,
        invalidatedIndex: null, invalidatedTime: null,
    };
    const slowReclaim: StopHunt = { ...oneBar, index: 4, time: 4 * HR };
    const failed: StopHunt = { ...oneBar, invalidatedIndex: 3, invalidatedTime: 3 * HR };
    const bull: StopHunt = { ...oneBar, direction: 'bull', side: 'low' };

    it('draws no window when the breaching bar confirmed on its own', () => {
        const { boxes } = buildStopHuntOutput([oneBar], TIMES, view);
        expect(boxes!.filter((b) => b.id.endsWith('_window'))).toHaveLength(0);
        expect(boxes!.filter((b) => b.id.endsWith('_raid'))).toHaveLength(1);
    });

    it('draws a window box spanning the bars spent waiting on the reclaim', () => {
        const { boxes } = buildStopHuntOutput([slowReclaim], TIMES, view);
        const [win] = boxes!.filter((b) => b.id.endsWith('_window'));
        // Raid ends at bar 3 (sweepIndex + 1); the window runs on to bar 5 (index + 1).
        expect(win).toMatchObject({ left: 3 * HR, right: 5 * HR, top: 105, bottom: 100 });
    });

    it('the raid box spans the level to the wick extreme, over the breaching bar only', () => {
        const [raid] = buildStopHuntOutput([oneBar], TIMES, view).boxes!;
        expect(raid).toMatchObject({ left: 2 * HR, right: 3 * HR, top: 105, bottom: 100, xloc: 'bar_time' });
    });

    it('the level line runs from where it formed to where it was swept', () => {
        const [line] = buildStopHuntOutput([oneBar], TIMES, view).lines!;
        expect(line).toMatchObject({ x1: 0, x2: 2 * HR, y1: 100, y2: 100, style: 'dashed' });
    });

    it('draws no level line when the level formed on the bar it was swept', () => {
        const sameBar: StopHunt = { ...oneBar, levelTime: oneBar.sweepTime };
        const { lines } = buildStopHuntOutput([sameBar], TIMES, view);
        expect(lines!.filter((l) => l.id.endsWith('_level'))).toHaveLength(0);
    });

    it('the read line runs solid across the raid and the window, at the level', () => {
        const [edge] = buildStopHuntOutput([slowReclaim], TIMES, view).lines!.filter((l) => l.id.endsWith('_edge'));
        expect(edge).toMatchObject({ x1: 2 * HR, x2: 5 * HR, y1: 100, style: 'solid' });
    });

    it('a failed hunt keeps its marks but dashes the read and fades every alpha', () => {
        const [liveEdge] = buildStopHuntOutput([oneBar], TIMES, view).lines!.filter((l) => l.id.endsWith('_edge'));
        const [failedEdge] = buildStopHuntOutput([failed], TIMES, view).lines!.filter((l) => l.id.endsWith('_edge'));
        expect(failedEdge!.style).toBe('dashed');
        expect(liveEdge!.style).toBe('solid');
        expect(failedEdge!.color).not.toBe(liveEdge!.color);
    });

    it('colors a mark by the side the liquidity came from', () => {
        const [bearRaid] = buildStopHuntOutput([oneBar], TIMES, view).boxes!;
        const [bullRaid] = buildStopHuntOutput([bull], TIMES, view).boxes!;
        expect(bearRaid!.bgColor).toContain('242,54,69'); // BEARISH
        expect(bullRaid!.bgColor).toContain('8,153,129'); // BULLISH
    });

    it('gives every hunt a stable id, so a repaint patches rather than piles up', () => {
        const first = buildStopHuntOutput([oneBar, bull], TIMES, view).boxes!.map((b) => b.id);
        const again = buildStopHuntOutput([oneBar, bull], TIMES, view).boxes!.map((b) => b.id);
        expect(first).toEqual(again);
        expect(new Set(first).size).toBe(first.length);
    });

    it('has nothing to say about no hunts', () => {
        expect(buildStopHuntOutput([], TIMES, view)).toEqual({ boxes: [], lines: [] });
    });
});

describe('native-indicators/stophunt instance', () => {
    function run(inputs?: Record<string, InputValue>, source: readonly (readonly [number, number, number, number])[] = HUNT_HIGH): NativeIndicatorOutput {
        const rows: OHLCV[] = bars(source);
        let captured: NativeIndicatorOutput | undefined;
        const ctx: NativeIndicatorContext = {
            symbol: 'TEST', timeframe: '1h', live: false,
            bars: () => rows,
            data: undefined as never,
            emit: (out) => {
                captured = out;
            },
            pushData: () => {},
            setStatus: () => {},
        };
        const instance = stopHuntDescriptor.create();
        instance.start(ctx, { ...stopHuntDescriptor.defaultInputs(), ...inputs });
        instance.stop();
        expect(captured).toBeDefined();
        return captured!;
    }

    it('registers as a stacking price overlay', () => {
        registerNativeIndicator(stopHuntDescriptor);
        const desc = getNativeIndicator('stophunt')!;
        expect(desc.title).toBe('Stop Hunts');
        expect(desc).toMatchObject({ paneHint: 'price', overlay: true, multiInstance: true });
        for (const input of desc.inputsSchema()) expect(desc.defaultInputs()[input.key]).toBeDefined();
    });

    it('finds the default swing hunt with confirmBars 1', () => {
        expect(run({ confirmBars: 1 }).boxes).not.toHaveLength(0);
    });

    it('the equal source reports the cluster once where swing alone counts each swing in it', () => {
        // Two swing highs at 15 and 15.005, both run by the same bar.
        const EQUAL_HIGHS = [
            [10, 11, 9, 10], [10, 12, 10, 11], [11, 15, 11, 14], [14, 14, 13, 13], [13, 14, 12, 13],
            [13, 14.5, 12.5, 14], [14, 15.005, 13.8, 14.2], [14.2, 14.4, 13, 13.2], [13.2, 14, 12.8, 13.5], [13.5, 16, 13.4, 14],
        ] as const;
        const swingOnly = run({ useSwing: true, useEqualHighsLows: false, confirmBars: 1 }, EQUAL_HIGHS).boxes!.filter((b) => b.id.endsWith('_raid'));
        const equalOnly = run({ useSwing: false, useEqualHighsLows: true, confirmBars: 1 }, EQUAL_HIGHS).boxes!.filter((b) => b.id.endsWith('_raid'));
        // Swing sees the two swing highs as two separate levels; equal merges them into one cluster.
        expect(swingOnly).toHaveLength(2);
        expect(equalOnly).toHaveLength(1);
    });

    it('no sources on emits nothing', () => {
        expect(run({ useSwing: false, useEqualHighsLows: false, useSessions: false }).boxes).toEqual([]);
    });

    it('refuses a label it does not know rather than painting a different question', () => {
        const rows = bars(HUNT_HIGH);
        const ctx: NativeIndicatorContext = {
            symbol: 'TEST', timeframe: '1h', live: false,
            bars: () => rows,
            data: undefined as never,
            emit: () => {},
            pushData: () => {},
            setStatus: () => {},
        };
        const instance = stopHuntDescriptor.create();
        expect(() => instance.start(ctx, { ...stopHuntDescriptor.defaultInputs(), show: 'Whenever' })).toThrow(/unknown show/);
    });
});
