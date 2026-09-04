// The bar store's timeframe grammar and bucketing. Plain `.mjs` because the store
// itself is untyped Electron-side JS (app/electron/data/store/barStore.js).
//
// Two dialects arrive here — Vela's canonical bare minutes and Midorii's own
// aliases — and the store aggregates every one of them from the same 1-minute
// base, so this is where "the chart may ask for any timeframe" is actually true
// or not.
import { describe, expect, it } from 'vitest';

import {
    aggregate,
    bucketEnd,
    bucketStart,
    parseTimeframe,
    STRIDE,
    timeframeMs,
} from '../app/electron/data/store/barStore.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A Float64Array of minute bars in the store's own layout, close = index. */
function minutes(startMs, count) {
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        const base = i * STRIDE;
        data[base] = startMs + i * MINUTE;
        data[base + 1] = 100 + i; // open
        data[base + 2] = 200 + i; // high
        data[base + 3] = 50 + i; //  low
        data[base + 4] = 150 + i; // close
        data[base + 5] = 1; //       volume
        data[base + 6] = 0.5; //     buy volume
    }
    return data;
}

describe('parseTimeframe', () => {
    it('reads Vela canonical values (a bare number is minutes)', () => {
        expect(timeframeMs('1')).toBe(MINUTE);
        expect(timeframeMs('60')).toBe(HOUR);
        expect(timeframeMs('240')).toBe(4 * HOUR);
        expect(timeframeMs('D')).toBe(DAY);
        expect(timeframeMs('W')).toBe(7 * DAY);
    });

    it("reads Midorii's own aliases", () => {
        expect(timeframeMs('1m')).toBe(MINUTE);
        expect(timeframeMs('15m')).toBe(15 * MINUTE);
        expect(timeframeMs('1h')).toBe(HOUR);
        expect(timeframeMs('4h')).toBe(4 * HOUR);
        expect(timeframeMs('1d')).toBe(DAY);
    });

    it('separates minutes from months by case', () => {
        expect(parseTimeframe('3m')).toEqual({ ms: 3 * MINUTE, months: 0 });
        expect(parseTimeframe('3M')).toEqual({ ms: null, months: 3 });
    });

    it('refuses what it cannot bucket exactly', () => {
        for (const bad of ['', '0', 'nope', '1s', '30S', '1.5h', '-5', 'D1']) {
            expect(() => parseTimeframe(bad), bad).toThrow(/Unknown timeframe/);
        }
    });
});

describe('bucket edges', () => {
    it('puts a day on UTC midnight', () => {
        const spec = parseTimeframe('D');
        const t = Date.UTC(2024, 4, 17, 13, 42);
        expect(bucketStart(t, spec)).toBe(Date.UTC(2024, 4, 17));
        expect(bucketEnd(bucketStart(t, spec), spec)).toBe(Date.UTC(2024, 4, 18));
    });

    it('puts a week on Monday, not on the epoch Thursday', () => {
        const spec = parseTimeframe('W');
        // 2024-05-17 was a Friday; its week opens on Monday the 13th.
        const start = bucketStart(Date.UTC(2024, 4, 17, 13, 42), spec);
        expect(start).toBe(Date.UTC(2024, 4, 13));
        expect(new Date(start).getUTCDay()).toBe(1);
    });

    it('puts a month on the first, with the calendar length', () => {
        const spec = parseTimeframe('M');
        const start = bucketStart(Date.UTC(2024, 1, 20), spec); // February 2024
        expect(start).toBe(Date.UTC(2024, 1, 1));
        // A leap February — 29 days, which no fixed millisecond length gets right.
        expect(bucketEnd(start, spec) - start).toBe(29 * DAY);
    });
});

describe('aggregate', () => {
    const start = Date.UTC(2024, 0, 1);

    it('folds minutes into hourly buckets', () => {
        const data = minutes(start, 120);
        const bars = aggregate(data, start, start + 2 * HOUR, '60');

        expect(bars.map((b) => b.time)).toEqual([start, start + HOUR]);
        expect(bars[0].open).toBe(100);
        expect(bars[0].close).toBe(150 + 59);
        expect(bars[0].high).toBe(200 + 59);
        expect(bars[0].low).toBe(50);
        expect(bars[0].volume).toBe(60);
    });

    it('serves the same bars for both spellings of one timeframe', () => {
        const data = minutes(start, 300);
        expect(aggregate(data, start, start + 5 * HOUR, '240'))
            .toEqual(aggregate(data, start, start + 5 * HOUR, '4h'));
    });

    it('opens the first bucket where the bucket opens, not where the caller asked', () => {
        const data = minutes(start, 120);
        // Asking from 00:30 still means the 00:00 hour — built from all sixty of
        // its minutes, or the candle would show a low that never printed.
        const bars = aggregate(data, start + 30 * MINUTE, start + 2 * HOUR, '60');
        expect(bars[0].time).toBe(start);
        expect(bars[0].open).toBe(100);
    });

    it('withholds a half-filled trailing bucket unless asked for it', () => {
        const data = minutes(start, 90); // an hour and a half
        const to = start + 2 * HOUR;

        expect(aggregate(data, start, to, '60', true).map((b) => b.time)).toEqual([start]);

        const withOpen = aggregate(data, start, to, '60', false);
        expect(withOpen.map((b) => b.time)).toEqual([start, start + HOUR]);
        // The bar in progress: thirty minutes of an hour that is not over.
        expect(withOpen[1].volume).toBe(30);
    });
});
