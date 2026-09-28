import { describe, expect, it } from 'vitest';
import {
    buildCrtReferenceCandles,
    detectCrt,
    type CrtSetup,
} from '../src/core/analysis/crt';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;

function bars(rows: Array<[number, number, number, number]>): OHLCV[] {
    const start = Date.parse('2024-01-02T00:00:00Z');
    return rows.map(([open, high, low, close], index) => ({
        time: start + index * MINUTE,
        open,
        high,
        low,
        close,
        volume: 1,
    }));
}

const SHORT: Array<[number, number, number, number]> = [
    [100, 101, 99, 100],
    [100, 102, 99.5, 101],
    [101, 103, 100, 102],
    [102, 104, 101, 103],
    [103, 106, 102, 105], // external swing high / C/H
    [105, 105, 101, 102],
    [102, 104, 99, 100],
    [100, 102, 98, 101], // internal swing low / C/L
    [101, 103, 99, 102],
    [102, 104, 100, 103],
    [103, 104, 101, 102],
    [102, 105, 101, 104],
    [105, 107, 103, 105.5], // strict high sweep; bullish Model 1 candle
    [105.5, 105.7, 97, 97.5], // bearish displacement through the internal low
    [99, 105.2, 97, 98.5], // retest Model 1 open, then reach C/L
    [98.5, 99, 97.5, 98],
    [98, 99, 97, 98],
    [98, 99, 97, 98],
    [98, 99, 97, 98],
    [98, 99, 97, 98],
];

const LONG: Array<[number, number, number, number]> = [
    [100, 101, 99, 100],
    [100, 100.5, 97, 98],
    [98, 99, 96, 97],
    [97, 98, 95, 96],
    [96, 97, 94, 95], // external swing low / C/L
    [95, 99, 95, 98],
    [98, 101, 97, 100],
    [100, 102, 98, 101], // internal swing high / C/H
    [101, 101.5, 97, 99],
    [99, 100, 96, 98],
    [98, 100, 96, 99],
    [99, 101, 97, 100],
    [95, 96, 93, 94.5], // strict low sweep; bearish Model 1 candle
    [94.5, 103, 94, 102.5], // bullish displacement
    [101, 102.2, 94.8, 101], // retest Model 1 open, then reach C/H
    [101, 102, 100, 101],
    [101, 102, 100, 101],
    [101, 102, 100, 101],
    [101, 102, 100, 101],
    [101, 102, 100, 101],
];

function detect(rows: Array<[number, number, number, number]>): CrtSetup[] {
    return detectCrt(bars(rows), {
        referenceMinutes: 10,
        referenceAnchorMin: 0,
        zone: 'UTC',
        keySources: ['swing'],
        keyStrength: 1,
        internalStrength: 1,
        maxSweepToShift: 4,
        orderExpiryBars: 4,
    });
}

describe('CRT reference candles', () => {
    it('aligns the higher-timeframe grid to the chosen wall-clock anchor', () => {
        const start = Date.parse('2024-01-02T00:00:00Z');
        const hourly: OHLCV[] = Array.from({ length: 12 }, (_, index) => ({
            time: start + index * 60 * MINUTE,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
        }));
        const folded = buildCrtReferenceCandles(hourly, 240, 60, 'UTC');

        // With hourly source bars and a 01:00 H4 anchor, the loaded partial starts at 00:00,
        // then complete chart buckets begin at 01:00, 05:00 and 09:00.
        expect(folded.map((bar) => bar.startIndex)).toEqual([0, 1, 5, 9]);
        expect(folded.map((bar) => bar.complete)).toEqual([false, true, true, true]);
    });

    it('never treats a loaded partial bucket as the reference range', () => {
        const rows = bars(SHORT).map((bar) => ({ ...bar, time: bar.time + MINUTE }));
        expect(detectCrt(rows, {
            referenceMinutes: 10,
            referenceAnchorMin: 0,
            zone: 'UTC',
            keySources: ['swing'],
            keyStrength: 1,
            internalStrength: 1,
            maxSweepToShift: 4,
            orderExpiryBars: 4,
        })).toEqual([]);
    });
});

describe('CRT detector', () => {
    it('builds the bearish sequence and targets the original C/L', () => {
        const [setup] = detect(SHORT);

        expect(setup).toMatchObject({
            direction: 'bear',
            referenceHigh: 106,
            referenceLow: 98,
            keyLevel: 106,
            sweepIndex: 12,
            sweepExtreme: 107,
            structureLevel: 98,
            modelIndex: 12,
            entryPrice: 105,
            stop: 107,
            target: 98,
            index: 13,
            fillIndex: 14,
            outcome: 'target',
        });
        expect(setup!.rewardRisk).toBe(3.5);
    });

    it('mirrors the same rules for a bullish sequence and targets C/H', () => {
        const [setup] = detect(LONG);

        expect(setup).toMatchObject({
            direction: 'bull',
            referenceHigh: 102,
            referenceLow: 94,
            keyLevel: 94,
            sweepIndex: 12,
            sweepExtreme: 93,
            modelIndex: 12,
            entryPrice: 95,
            stop: 93,
            target: 102,
            index: 13,
            fillIndex: 14,
            outcome: 'target',
        });
        expect(setup!.rewardRisk).toBe(3.5);
    });

    it('requires the sweep candle itself to close back inside the key', () => {
        const rows = SHORT.map((row) => [...row] as typeof row);
        rows[12] = [105, 107, 103, 106.5];
        expect(detect(rows)).toEqual([]);
    });

    it('never reports the setup on the sweep bar before displacement closes', () => {
        const [setup] = detect(SHORT);
        expect(setup!.index).toBeGreaterThan(setup!.sweepIndex);
        expect(setup!.structureIndex).toBeLessThan(setup!.sweepIndex);
        expect(setup!.modelIndex).toBeGreaterThanOrEqual(setup!.sweepIndex);
    });

    it('adds the configured raw-price buffer beyond the sweep', () => {
        const [setup] = detectCrt(bars(SHORT), {
            referenceMinutes: 10,
            referenceAnchorMin: 0,
            zone: 'UTC',
            keySources: ['swing'],
            keyStrength: 1,
            internalStrength: 1,
            maxSweepToShift: 4,
            orderExpiryBars: 4,
            stopBuffer: 0.25,
        });
        expect(setup!.stop).toBe(107.25);
    });
});
