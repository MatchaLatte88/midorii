import { describe, it, expect } from 'vitest';
import { bucketBars, sessionBars } from '../src/core/analysis/aggregate';
import { readBarClock } from '../src/core/analysis/barClock';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * Folding minutes into coarser bars, and the index that says when each one was finished.
 *
 * That index is the whole point of the module: a strategy reading a 10-minute bar has to be
 * told about it on the minute that COMPLETED it, not on the one that started the next. One bar
 * either way is a minute of look-ahead or a minute of lateness on every trade.
 */

const MIN = 60_000;
/** 07:00 Central on 2024-06-03 — CDT, so 12:00 UTC. */
const T0 = Date.parse('2024-06-03T12:00:00Z');

function minutes(count: number, from = T0, priceAt: (i: number) => number = (i) => 100 + i): OHLCV[] {
    return Array.from({ length: count }, (_, i) => {
        const p = priceAt(i);
        return { time: from + i * MIN, open: p, high: p + 1, low: p - 1, close: p, volume: 10 };
    });
}

describe('bucketBars', () => {
    it('folds open, high, low, close and volume the way a chart does', () => {
        const { bars } = bucketBars(minutes(20), 10 * MIN);
        expect(bars.length).toBe(2);

        const first = bars[0]!;
        expect(first.open).toBe(100);
        expect(first.close).toBe(109);
        expect(first.high).toBe(110);
        expect(first.low).toBe(99);
        expect(first.volume).toBe(100);
    });

    it('stamps each bucket at its own start, not at its first bar', () => {
        // Starting at 07:03, so the first bucket is the 07:00 one with only seven minutes in it.
        const { bars } = bucketBars(minutes(10, T0 + 3 * MIN), 10 * MIN);
        expect(bars[0]!.time).toBe(T0);
        expect(bars[1]!.time).toBe(T0 + 10 * MIN);
    });

    it('points at the last minute of each bucket, which is what completes it', () => {
        const { sourceEnd } = bucketBars(minutes(25), 10 * MIN);
        // Bucket 0 is minutes 0-9 and is finished by minute 9; bucket 1 by minute 19.
        expect(sourceEnd).toEqual([9, 19, 24]);
    });

    it('leaves a gap as a gap instead of stitching a bar across it', () => {
        const before = minutes(10);
        const after = minutes(10, T0 + 60 * MIN);
        const { bars, sourceEnd } = bucketBars([...before, ...after], 10 * MIN);

        expect(bars.length).toBe(2);
        expect(bars[1]!.time).toBe(T0 + 60 * MIN);
        expect(sourceEnd).toEqual([9, 19]);
    });

    it('is the identity when the bucket is the bar length', () => {
        const source = minutes(5);
        const { bars, sourceEnd } = bucketBars(source, MIN);
        expect(bars).toEqual(source);
        expect(sourceEnd).toEqual([0, 1, 2, 3, 4]);
    });
});

describe('sessionBars', () => {
    /** Three days of minutes, 06:00 to 16:00 Central, so the cash window is a strict subset. */
    function threeDays(): OHLCV[] {
        const bars: OHLCV[] = [];
        for (let d = 0; d < 3; d += 1) {
            const dayStart = Date.parse(`2024-06-0${3 + d}T11:00:00Z`); // 06:00 Central
            for (let i = 0; i < 600; i += 1) {
                const p = 100 + d * 10 + i / 100;
                bars.push({ time: dayStart + i * MIN, open: p, high: p + 1, low: p - 1, close: p, volume: 1 });
            }
        }
        return bars;
    }

    const all = threeDays();
    const clock = readBarClock(all, 'America/Chicago');
    const session = sessionBars(all, clock, 8 * 60 + 30, 15 * 60);

    it('keeps one bar per local day', () => {
        expect(session.bars.length).toBe(3);
        expect(session.days).toEqual(['2024-06-03', '2024-06-04', '2024-06-05']);
    });

    it('opens at the first bar of the window and closes at the last', () => {
        // 06:00 Central is minute 0, so 08:30 is minute 150 and the last inside is 14:59 = 539.
        expect(session.bars[0]!.open).toBe(all[150]!.open);
        expect(session.bars[0]!.close).toBe(all[539]!.close);
        expect(session.sourceEnd[0]).toBe(539);
    });

    it('excludes everything outside the window from the high and low too', () => {
        const outsideHigh = Math.max(...all.slice(0, 150).map((b) => b.high));
        // The pre-market minutes are lower here, so the guard is that the session ignores them.
        expect(session.bars[0]!.high).toBeGreaterThan(outsideHigh);
        expect(session.bars[0]!.low).toBe(all[150]!.low);
    });

    it('drops a day with nothing inside the window rather than inventing a bar', () => {
        // Only the overnight hours of a fourth day.
        const partial = [...all, ...Array.from({ length: 30 }, (_, i) => {
            const p = 200;
            return { time: Date.parse('2024-06-06T11:00:00Z') + i * MIN, open: p, high: p, low: p, close: p, volume: 1 };
        })];
        const clockOf = readBarClock(partial, 'America/Chicago');
        expect(sessionBars(partial, clockOf, 8 * 60 + 30, 15 * 60).bars.length).toBe(3);
    });
});
