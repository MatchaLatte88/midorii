import { describe, it, expect } from 'vitest';
import { detectVwapBands } from '../src/core/analysis/vwapBands';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What the session VWAP and its dispersion measure, and where they stop existing.
 *
 * Every number below is forced by flat bars — open, high, low and close all the same — so the
 * typical price is exactly the price and the arithmetic can be stated rather than trusted. Four
 * bars alternating 98 and 102 average 100 and sit one deviation of 2 either side of it; adding
 * a fifth at 90 pulls the average to 98 and widens the deviation to sqrt(19.2).
 */

const MIN = 60_000;

/** 09:30 New York in UTC ms. March 2024 from the 11th is EDT, so 13:30 UTC. */
function open930(day: number): number {
    return Date.parse(`2024-03-${day}T13:30:00Z`);
}

function bar(time: number, price: number, volume?: number): OHLCV {
    return { time, open: price, high: price, low: price, close: price, volume };
}

function session(day: number, prices: readonly number[], volume = 1): OHLCV[] {
    const t0 = open930(day);
    return prices.map((p, i) => bar(t0 + i * MIN, p, volume));
}

describe('the session VWAP', () => {
    /* One bar before the open, a five-bar session, then the next day's. */
    const bars: OHLCV[] = [
        bar(open930(11) - MIN, 100, 1),
        ...session(11, [98, 102, 98, 102, 90]),
        ...session(12, [200, 204]),
    ];
    const bands = detectVwapBands(bars);

    it('leaves a bar outside the session window with nothing at all', () => {
        // 09:29 New York is not in the cash session, and the average of a session that has not
        // started is not a price anything could act on.
        expect(bands.vwap[0]).toBeNull();
        expect(bands.sigma[0]).toBeNull();
        expect(bands.day[0]).toBeNull();
        expect(bands.sinceOpen[0]).toBeNull();
    });

    it('is the volume-weighted average of the session so far', () => {
        expect(bands.vwap[1]).toBe(98);
        expect(bands.vwap[2]).toBe(100);
        expect(bands.vwap[4]).toBe(100);
        // (98 + 102 + 98 + 102 + 90) / 5.
        expect(bands.vwap[5]).toBe(98);
    });

    it('has no deviation on a session\'s first bar, because there is none to have', () => {
        // One observation lies exactly on its own average; a distance measured in sigmas there
        // is a division by zero wearing a signal's clothes.
        expect(bands.sigma[1]).toBeNull();
        expect(bands.sigma[2]).toBe(2);
    });

    it('widens the deviation as the session spreads out', () => {
        expect(bands.sigma[4]).toBe(2);
        expect(bands.sigma[5]).toBeCloseTo(Math.sqrt(19.2), 12);
    });

    it('starts again at the next session\'s open', () => {
        // Nothing of Monday's average survives into Tuesday: the sixth bar is a first bar.
        expect(bands.day[6]).toBe('2024-03-12');
        expect(bands.vwap[6]).toBe(200);
        expect(bands.sigma[6]).toBeNull();
        expect(bands.vwap[7]).toBe(202);
        expect(bands.sigma[7]).toBe(2);
    });

    it('counts elapsed minutes from the session\'s first bar', () => {
        expect(bands.sinceOpen[1]).toBe(0);
        expect(bands.sinceOpen[5]).toBe(4);
        expect(bands.sinceOpen[6]).toBe(0);
    });
});

describe('what each bar contributes', () => {
    it('weighs a bar by its own volume, not by being a bar', () => {
        /* 100 on one lot and 104 on three average 103, not 102 — and the deviation around that
         * average is sqrt((1 × 9 + 3 × 1) / 4) = sqrt(3). */
        const bars = [bar(open930(11), 100, 1), bar(open930(11) + MIN, 104, 3)];
        const bands = detectVwapBands(bars);

        expect(bands.vwap[1]).toBe(103);
        expect(bands.sigma[1]).toBeCloseTo(Math.sqrt(3), 12);
    });

    it('reads the price the source asks for', () => {
        // A bar that is not flat: typical price 101, close 99.
        const moving: OHLCV = { time: open930(11) + MIN, open: 100, high: 105, low: 99, close: 99, volume: 1 };
        const bars = [bar(open930(11), 100, 1), moving];

        expect(detectVwapBands(bars, { source: 'HLC3' }).vwap[1]).toBeCloseTo(100.5, 12);
        expect(detectVwapBands(bars, { source: 'Close' }).vwap[1]).toBeCloseTo(99.5, 12);
    });

    it('ignores a bar carrying no volume rather than counting it as one lot', () => {
        const bars = [bar(open930(11), 100, 1), bar(open930(11) + MIN, 200), bar(open930(11) + 2 * MIN, 100, 1)];
        const bands = detectVwapBands(bars);

        // The 200 traded nothing, so it moved no average.
        expect(bands.vwap[1]).toBe(100);
        expect(bands.vwap[2]).toBe(100);
        expect(bands.sigma[2]).toBe(0);
    });

    it('has no average at all where nothing carries volume', () => {
        const bars = [bar(open930(11), 100), bar(open930(11) + MIN, 104)];
        const bands = detectVwapBands(bars);

        expect(bands.vwap.every((v) => v === null)).toBe(true);
        // The bars are still inside the session — it is the volume that is missing, not the day.
        expect(bands.day[0]).toBe('2024-03-11');
    });
});

describe('the session it is asked for', () => {
    it('measures the UTC day when that is what was asked', () => {
        // 05:00 UTC is the middle of the night in New York and the middle of the UTC day.
        const t0 = Date.parse('2024-03-11T05:00:00Z');
        const bars = [bar(t0, 100, 1), bar(t0 + MIN, 104, 1)];

        expect(detectVwapBands(bars, { session: 'nyse' }).vwap[1]).toBeNull();
        expect(detectVwapBands(bars, { session: 'utc' }).vwap[1]).toBe(102);
    });

    it('refuses a session it does not measure rather than defaulting to one', () => {
        const bars = session(11, [100, 104]);

        expect(() => detectVwapBands(bars, { session: 'lse' as 'nyse' }))
            .toThrow(/unknown session "lse"/);
    });
});
