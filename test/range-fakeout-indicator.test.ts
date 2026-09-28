import { describe, expect, it } from 'vitest';
import { detectRangeFakeouts } from '../src/core/analysis/rangeFakeout';
import type { OHLCV } from '../src/core/model/ohlcv';
import {
    buildRangeFakeoutOutput,
    projectRangeFakeouts,
    rangeFakeoutDescriptor,
} from '../src/core/native-indicators/range-fakeout';

const MINUTE = 60_000;
type Row = [number, number, number, number];

const ROWS: Row[] = [
    ...Array.from({ length: 16 }, (_, k): Row => [70 + k, 72 + k, 69 + k, 71 + k]),
    ...Array.from({ length: 10 }, (_, k): Row => (k % 2 === 0 ? [99.6, 101, 99.4, 100.6] : [100.4, 100.6, 99, 99.4])),
    [100.6, 101.6, 100.5, 101.4],
    [101.4, 101.6, 101.3, 101.5],
    [101.5, 101.55, 100.3, 100.4],
    [100.4, 101.2, 99.8, 99.95],
    [99.95, 100.1, 99.5, 99.6],
    [99.6, 99.7, 98.9, 99.1],
    ...Array.from({ length: 5 }, (): Row => [99.1, 99.3, 98.9, 99.1]),
];
const SERIES: OHLCV[] = ROWS.map(([open, high, low, close], index) => ({
    time: Date.parse('2024-01-02T14:00:00Z') + index * MINUTE, open, high, low, close, volume: 1,
}));
const TIMES = SERIES.map((bar) => bar.time);
const VIEW = { rangeColor: '#888888', bullColor: '#00aa88', bearColor: '#ee3344', profitColor: '#00cc88', lossColor: '#ff4455' };

describe('range fakeout native indicator', () => {
    const setups = detectRangeFakeouts(SERIES, { range: { minBars: 5 } });

    it('draws the range, its middle, the gap, the fakeout extreme and the resolved trade', () => {
        const trades = projectRangeFakeouts(setups, SERIES, 'range', 2, 0.5);
        expect(trades).toEqual([expect.objectContaining({ target: 99, outcome: 'target', exitTime: TIMES[31] })]);

        const out = buildRangeFakeoutOutput(trades, TIMES, VIEW);
        const box = (suffix: string) => out.boxes!.find((b) => b.id.endsWith(suffix))!;
        expect(box('_range')).toMatchObject({ left: TIMES[16], right: TIMES[26], top: 101, bottom: 99 });
        expect(box('_gap')).toMatchObject({ left: TIMES[27], right: TIMES[29], top: 101.3, bottom: 101.2 });
        expect(box('_reward')).toMatchObject({ left: TIMES[29], right: TIMES[31], top: 99.95, bottom: 99 });
        expect(box('_risk')).toMatchObject({ top: 101.6, bottom: 99.95 });
        expect(out.lines!.map((l) => [l.id.split('_').pop(), l.y1])).toEqual([['middle', 100], ['extreme', 101.6]]);
        expect(out.labels![0]).toMatchObject({ text: 'Fakeout short', x: TIMES[29], y: 101.6 });
    });

    it('leaves out a setup the strategy would skip', () => {
        expect(projectRangeFakeouts(setups, SERIES, 'range', 2, 0.6)).toEqual([]);
    });

    it('is a price overlay with the strategy settings', () => {
        expect(rangeFakeoutDescriptor).toMatchObject({ type: 'range-fakeout', paneHint: 'price', overlay: true });
        expect(rangeFakeoutDescriptor.defaultInputs()).toMatchObject({
            minBars: 12, compression: 0.8, gapSide: 'Against the breakout', target: 'Fixed reward : risk', rrr: 1.5,
        });
    });
});
