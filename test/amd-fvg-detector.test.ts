import { describe, expect, it } from 'vitest';
import {
    detectAmdFvg,
    selectAmdFvgSignals,
    type AmdFvgCandidate,
} from '../src/core/analysis/amdFvg';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

/** 09:00 New York (EST) — inside the New York session, outside London's late hours. */
const NY_OPEN = Date.parse('2024-01-02T14:00:00Z');
/** 03:00 New York — London only. */
const LONDON_ONLY = Date.parse('2024-01-02T08:00:00Z');

function bars(rows: readonly Row[], start = NY_OPEN): OHLCV[] {
    return rows.map(([open, high, low, close], index) => ({
        time: start + index * MINUTE,
        open,
        high,
        low,
        close,
        volume: 1,
    }));
}

const BEAR: Row[] = [
    ...Array.from({ length: 10 }, (): Row => [100, 100.2, 99.9, 100.1]), // accumulation, ends at 9
    [100.1, 100.8, 100, 100.6], // sweep above the range
    [100.6, 100.9, 100.4, 100.5],
    [100.5, 100.5, 99.7, 99.8],
    [99.8, 99.9, 99.2, 99.3], // gap under bar 11, close back inside
    [99.3, 99.4, 98.9, 99], // a second qualifying gap, last bar of the window
    [99, 99.1, 98, 98.2],
    ...Array.from({ length: 4 }, (): Row => [98.2, 98.4, 98, 98.2]),
];

/** The same story upside down: every price reflected around 100. */
function mirrored(rows: readonly Row[]): Row[] {
    return rows.map(([open, high, low, close]) => [200 - open, 200 - low, 200 - high, 200 - close]);
}

const OPTS = { accLength: 5, accWidthPct: 0.5, maxSearch: 5, fvgAtr: 0.1, atrLength: 3 };

describe('AMD FVG detector', () => {
    it('finds accumulation, a sweep above it and a bearish gap back inside', () => {
        const found = detectAmdFvg(bars(BEAR), OPTS);

        expect(found.map((c) => c.index)).toEqual([13, 14]);
        expect(found[0]).toMatchObject({
            direction: 'bear',
            accStartIndex: 5,
            accEndIndex: 9,
            accHigh: 100.2,
            accLow: 99.9,
            manipulationIndex: 10,
            manipulationExtreme: 100.9,
            fvgStartIndex: 11,
            fvgTop: 100.4,
            fvgBottom: 99.9,
            close: 99.3,
        });
        // Both candles belong to one accumulation: a consumer trades it at most once.
        expect(found[1]!.accEndIndex).toBe(9);
    });

    it('mirrors into a bullish setup after a sweep below the range', () => {
        const found = detectAmdFvg(bars(mirrored(BEAR)), OPTS);

        expect(found.map((c) => c.index)).toEqual([13, 14]);
        expect(found[0]).toMatchObject({
            direction: 'bull',
            accLow: 99.8,
            manipulationExtreme: 99.1,
            fvgTop: 100.1,
            fvgBottom: 99.6,
        });
    });

    it('lets the upper edge decide when one candle breaks both', () => {
        const rows = BEAR.map((row): Row => [...row]);
        rows[10] = [100.1, 100.8, 99.5, 100.6];
        expect(detectAmdFvg(bars(rows), OPTS)[0]?.direction).toBe('bear');
    });

    it('only accumulates and triggers inside an enabled session', () => {
        const london = bars(BEAR, LONDON_ONLY);

        expect(detectAmdFvg(london, OPTS)).toEqual([]);
        expect(detectAmdFvg(london, { ...OPTS, sessions: ['london'] }).map((c) => c.index)).toEqual([13, 14]);
        expect(() => detectAmdFvg(london, { ...OPTS, sessions: ['frankfurt' as never] })).toThrow(/unknown session/);
    });

    it('drops gaps outside the search window or below the ATR threshold', () => {
        expect(detectAmdFvg(bars(BEAR), { ...OPTS, maxSearch: 3 })).toEqual([]);
        expect(detectAmdFvg(bars(BEAR), { ...OPTS, fvgAtr: 1 })).toEqual([]);
    });

    it('never arms a range wider than the percentage limit', () => {
        expect(detectAmdFvg(bars(BEAR), { ...OPTS, accWidthPct: 0.2 })).toEqual([]);
    });
});

function candidate(overrides: Partial<AmdFvgCandidate>): AmdFvgCandidate {
    return {
        direction: 'bull',
        accStartIndex: 0,
        accStartTime: 0,
        accEndIndex: 0,
        accEndTime: 0,
        accHigh: 101,
        accLow: 99,
        manipulationIndex: 1,
        manipulationExtreme: 98,
        fvgStartIndex: 0,
        fvgStartTime: 0,
        fvgTop: 100,
        fvgBottom: 99.5,
        close: 100,
        high: 100.5,
        low: 99.5,
        atr: 1,
        index: 2,
        time: 2,
        ...overrides,
    };
}

describe('AMD FVG simulated trade gating', () => {
    const flat: Row = [100, 100.5, 99.5, 100];
    const rows: Row[] = Array.from({ length: 9 }, () => flat);
    rows[6] = [100, 102.5, 99.5, 102]; // reaches the first trade's target
    const series = bars(rows);

    it('skips a candidate while its trade runs, without spending that accumulation', () => {
        const signals = selectAmdFvgSignals([
            candidate({ accEndIndex: 0, index: 2 }),
            candidate({ accEndIndex: 3, index: 4 }), // blocked: the first trade is still open
            candidate({ accEndIndex: 3, index: 6 }), // the exit bar itself may trigger again
            candidate({ accEndIndex: 3, index: 7 }), // same accumulation, already spent
        ], series, 1, 2);

        expect(signals.map((s) => s.index)).toEqual([2, 6]);
        expect(signals[0]).toMatchObject({ stop: 99, target: 102, outcome: 'target', exitIndex: 6 });
        expect(signals[1]).toMatchObject({ outcome: 'open', exitIndex: null });
    });

    it('measures a bearish trade on the other side of the close', () => {
        const [signal] = selectAmdFvgSignals([candidate({ direction: 'bear' })], series, 2, 1.5);
        expect(signal).toMatchObject({ stop: 102, target: 97 });
    });
});
