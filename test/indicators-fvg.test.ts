import { describe, it, expect } from 'vitest';
import { detectFairValueGaps, type FvgBar } from '../src/core/analysis/fvg';
import { buildFvgOutput, fvgDescriptor } from '../src/core/native-indicators/fvg';
import type { NativeIndicatorContext, NativeIndicatorOutput } from '../src/core/native-indicators/NativeIndicator';
import type { InputValue } from '../src/core/model/inputs';
import type { OHLCV } from '../src/core/model/ohlcv';

const HR = 3600_000;

/** Bars from `[high, low, close?]`, one per hour from t=0. Close defaults to the midpoint,
 *  which only the `'break'` rule reads. */
function bars(rows: Array<[high: number, low: number, close?: number]>): FvgBar[] {
    return rows.map(([high, low, close], i) => ({ time: i * HR, high, low, close: close ?? (high + low) / 2 }));
}

/** A bullish gap [100, 120] confirmed at bar 2, then bars that come back into it step by step:
 *  bar 3 touches the top edge, bar 4 reaches the midpoint, bar 5 crosses the whole zone. */
const LADDER = bars([
    [100, 90],
    [130, 95],
    [140, 120], // gap [100, 120]
    [138, 119], // into the top edge only
    [130, 109], // past the midpoint (110)
    [125, 99, 105], // through the bottom, closing inside the zone
]);

describe('analysis/fvg mitigation rules', () => {
    const closedAt = (mitigation: 'touch' | 'ce' | 'full' | 'break'): number | null =>
        detectFairValueGaps(LADDER, { mitigation, show: 'all' })[0]!.mitigatedIndex;

    it('ends a zone at the depth the rule asks for', () => {
        expect(closedAt('touch')).toBe(3); // the first bar that reaches the near edge
        expect(closedAt('ce')).toBe(4); // consequent encroachment — the midpoint
        expect(closedAt('full')).toBe(5); // all the way through
    });

    it("leaves a zone standing under 'break' until a bar CLOSES past it", () => {
        // Bar 5 crosses the whole zone but closes back inside it — a retest, not acceptance.
        expect(closedAt('break')).toBeNull();
        const accepted = [...LADDER, { time: 6 * HR, high: 120, low: 80, close: 85 }];
        expect(detectFairValueGaps(accepted, { mitigation: 'break', show: 'all' })[0]!.mitigatedIndex).toBe(6);
    });

    it('hides filled zones by default and keeps them on request', () => {
        expect(detectFairValueGaps(LADDER)).toHaveLength(0); // show: 'open', and this one is filled
        expect(detectFairValueGaps(LADDER, { show: 'all' })).toHaveLength(1);
    });

    it('refuses a setting outside its own vocabulary rather than quietly picking one', () => {
        expect(() => detectFairValueGaps(LADDER, { mitigation: 'halfway' as never })).toThrow(/unknown mitigation/);
        expect(() => detectFairValueGaps(LADDER, { minSizeUnit: 'pips' as never })).toThrow(/unknown minSizeUnit/);
        expect(() => detectFairValueGaps(LADDER, { show: 'some' as never })).toThrow(/unknown show/);
    });
});

// Two open bullish gaps: a wide one at bars 0-2 and a thin one at bars 4-6. Neither is ever
// reached again, so they stay open under every mitigation rule.
const TWO = bars([
    [100, 90],
    [130, 95],
    [140, 120], // [100, 120] — 20 points, 18.2% of its own level
    [145, 125],
    [150, 130],
    [160, 140],
    [165, 151], // [150, 151] — 1 point, 0.66%
]);

describe('analysis/fvg narrowing filters', () => {

    it('drops zones under the minimum size, in whichever unit was asked for', () => {
        expect(detectFairValueGaps(TWO)).toHaveLength(2);
        expect(detectFairValueGaps(TWO, { minSize: 5, minSizeUnit: 'points' }).map((z) => z.size)).toEqual([20]);
        expect(detectFairValueGaps(TWO, { minSize: 1, minSizeUnit: 'percent' }).map((z) => z.size)).toEqual([20]);
        // A threshold both clear leaves both standing.
        expect(detectFairValueGaps(TWO, { minSize: 0.5, minSizeUnit: 'percent' })).toHaveLength(2);
    });

    it('counts the lookback window back from the newest bar', () => {
        // The wide gap is confirmed at bar 2, the thin one at bar 6, over seven bars.
        expect(detectFairValueGaps(TWO, { lookback: 3 }).map((z) => z.index)).toEqual([6]);
        expect(detectFairValueGaps(TWO, { lookback: 5 }).map((z) => z.index)).toEqual([2, 6]);
    });

    it('carries the times of the three moments a zone has', () => {
        const [zone] = detectFairValueGaps(LADDER, { show: 'all' });
        expect(zone).toMatchObject({ startTime: 0, time: 2 * HR, mitigatedTime: 5 * HR });
    });
});

/* Three open bullish gaps, confirmed at bars 2, 5 and 8. Nothing ever comes back into any of
 * them, so which ones survive is only ever the window filter's doing. */
const THREE = bars([
    [100, 90],
    [130, 95],
    [140, 120], // gap [100, 120]
    [145, 125],
    [150, 130],
    [160, 146], // gap [145, 146]
    [165, 150],
    [170, 155],
    [180, 172], // gap [165, 172]
]);

/* A gap at bar 2 that is filled at bar 3, and a second one at bar 5 that stays open — the
 * shape that tells "first gap of the window" apart from "first gap still standing". */
const REFILLED = bars([
    [100, 90],
    [130, 95],
    [140, 120], // gap [100, 120], filled by the next bar
    [125, 95],
    [120, 100],
    [150, 130], // gap [125, 130], open
]);

describe('analysis/fvg first gap per window', () => {
    it('is not applied at all without a window list', () => {
        expect(detectFairValueGaps(THREE).map((z) => z.index)).toEqual([2, 5, 8]);
    });

    it('keeps the first gap confirmed in each window and drops the rest', () => {
        const zones = detectFairValueGaps(THREE, {
            firstIn: [{ startIndex: 0, endIndex: 5 }, { startIndex: 6, endIndex: 8 }],
        });
        expect(zones.map((z) => z.index)).toEqual([2, 8]);
    });

    it('drops gaps confirmed outside every window', () => {
        expect(detectFairValueGaps(THREE, { firstIn: [{ startIndex: 3, endIndex: 6 }] }).map((z) => z.index)).toEqual([5]);
        expect(detectFairValueGaps(THREE, { firstIn: [{ startIndex: 6, endIndex: 7 }] })).toHaveLength(0);
    });

    it('returns a gap that falls in two overlapping windows once', () => {
        const zones = detectFairValueGaps(THREE, {
            firstIn: [{ startIndex: 0, endIndex: 5 }, { startIndex: 1, endIndex: 6 }],
        });
        expect(zones.map((z) => z.index)).toEqual([2]);
    });

    it('keeps nothing for an empty window list — no sessions is not every session', () => {
        expect(detectFairValueGaps(THREE, { firstIn: [] })).toHaveLength(0);
    });

    it('picks the first gap before hiding filled ones, so the second never takes its place', () => {
        const firstIn = [{ startIndex: 0, endIndex: 5 }];
        expect(detectFairValueGaps(REFILLED, { firstIn, show: 'all' }).map((z) => z.index)).toEqual([2]);
        // The window's first gap is filled, so the window is empty — the gap at bar 5 is not
        // promoted into its place.
        expect(detectFairValueGaps(REFILLED, { firstIn })).toHaveLength(0);
    });
});

describe('what the fvg indicator draws', () => {
    const view = { bullColor: '#0a0', bearColor: '#a00', boxWidth: 0, midline: false };
    const times = (rows: readonly FvgBar[]): number[] => rows.map((b) => b.time);

    it('runs an open zone to the right edge and stops a filled one where it was filled', () => {
        const { boxes } = buildFvgOutput(detectFairValueGaps(TWO), times(TWO), view);
        expect(boxes).toHaveLength(2);
        expect(boxes![0]).toMatchObject({ left: 0, extend: 'right', borderStyle: 'solid' });

        const filled = detectFairValueGaps(LADDER, { show: 'all' });
        const [box] = buildFvgOutput(filled, times(LADDER), view).boxes!;
        expect(box).toMatchObject({ extend: 'none', borderStyle: 'dashed', right: 5 * HR });
    });

    it('caps a box at the requested width, counted from the bar the zone starts on', () => {
        const [box] = buildFvgOutput(detectFairValueGaps(TWO), times(TWO), { ...view, boxWidth: 2 }).boxes!;
        expect(box).toMatchObject({ left: 0, right: 2 * HR, extend: 'none' });
    });

    it('draws the midpoint only when asked, and never across a zone that is over', () => {
        const filled = detectFairValueGaps(LADDER, { show: 'all' });
        expect(buildFvgOutput(filled, times(LADDER), { ...view, midline: true }).lines).toHaveLength(0);
        expect(buildFvgOutput(detectFairValueGaps(TWO), times(TWO), { ...view, midline: true }).lines).toHaveLength(2);
    });

    it('offers the first-presented mode and its three sessions, off by default', () => {
        const keys = fvgDescriptor.inputsSchema().map((i) => i.key);
        expect(keys).toEqual(expect.arrayContaining(['firstPresented', 'sessionAsia', 'sessionLondon', 'sessionNewYork']));
        expect(fvgDescriptor.defaultInputs()).toMatchObject({
            firstPresented: false,
            sessionAsia: true,
            sessionLondon: true,
            sessionNewYork: true,
        });
    });
});

describe('native-indicators/fvg first presented gap', () => {
    /* Hourly bars over one winter day from 2024-01-10 00:00 UTC, climbing so that every bar
     * from the third on leaves a gap of its own. Winter puts the three desks at fixed UTC
     * hours: Asia 00:00-06:00, London 08:00-16:30, New York 14:30-21:00 — so the first gap
     * confirmed in each one is the gap at bar 2, at bar 8 and at bar 15. */
    const DAY: OHLCV[] = Array.from({ length: 24 }, (_, i) => ({
        time: Date.UTC(2024, 0, 10) + i * HR,
        open: 10 * i,
        high: 10 * i + 5,
        low: 10 * i,
        close: 10 * i + 2,
        volume: 1,
    }));

    function run(inputs?: Record<string, InputValue>): NativeIndicatorOutput {
        let captured: NativeIndicatorOutput | undefined;
        const ctx: NativeIndicatorContext = {
            symbol: 'TEST', timeframe: '1h', live: false,
            bars: () => DAY,
            data: undefined as never,
            emit: (out) => {
                captured = out;
            },
            pushData: () => {},
            setStatus: () => {},
        };
        const instance = fvgDescriptor.create();
        instance.start(ctx, { ...fvgDescriptor.defaultInputs(), ...inputs });
        instance.stop();
        expect(captured).toBeDefined();
        return captured!;
    }

    const ids = (out: NativeIndicatorOutput): string[] => (out.boxes ?? []).map((b) => b.id);

    it('draws every gap until the mode is switched on, then one per session', () => {
        expect(ids(run())).toHaveLength(22);
        expect(ids(run({ firstPresented: true }))).toEqual(['fvg_bull_2', 'fvg_bull_8', 'fvg_bull_15']);
    });

    it('each session stands on its own', () => {
        expect(ids(run({ firstPresented: true, sessionLondon: false, sessionNewYork: false }))).toEqual(['fvg_bull_2']);
        expect(ids(run({ firstPresented: true, sessionAsia: false, sessionNewYork: false }))).toEqual(['fvg_bull_8']);
        expect(ids(run({ firstPresented: true, sessionAsia: false, sessionLondon: false }))).toEqual(['fvg_bull_15']);
    });

    it('draws nothing with the mode on and no session ticked', () => {
        expect(ids(run({ firstPresented: true, sessionAsia: false, sessionLondon: false, sessionNewYork: false }))).toEqual([]);
    });
});
