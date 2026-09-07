import { describe, it, expect } from 'vitest';
import { detectOpeningRanges } from '../src/core/analysis/openingRange';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What the opening range detector promises.
 *
 * The two that matter most are the last two: the daily ATR and the relative volume must be
 * built out of the sessions BEFORE the one they are attached to. Get either wrong and every
 * result downstream is a strategy that knew how the day would go before it started, which no
 * amount of care in the strategy file can undo.
 */

const MIN = 60_000;

type Row = [open: number, high: number, low: number, close: number];

/** 09:30 New York in UTC ms. The 11th of March 2024 onwards is EDT, so 13:30 UTC. */
function open930(day: number): number {
    return Date.parse(`2024-03-${day}T13:30:00Z`);
}

function session(day: number, rows: readonly Row[], volume: number, stepMs = MIN): OHLCV[] {
    const t0 = open930(day);
    return rows.map(([open, high, low, close], i) => ({
        time: t0 + i * stepMs, open, high, low, close, volume,
    }));
}

/** Ten minutes that go nowhere: the opening range closes where it opened, so it has no
 *  direction, and every session has the same daily range of 2. */
const FLAT: Row[] = Array.from({ length: 10 }, () => [100, 101, 99, 100] as Row);

/** An opening range that closes 2 above its open, then breaks out and runs. */
const TREND_UP: Row[] = [
    [100, 101, 99.5, 100.5],
    [100.5, 101.5, 100, 101],
    [101, 102, 100.5, 101.5],
    [101.5, 102.5, 101, 102],
    [102, 102.5, 101.5, 102],
    [102, 102.4, 101.8, 102.2],
    [102.2, 103.5, 102, 103.4],
    [103.4, 104, 103.2, 103.8],
    [103.8, 104.2, 103.5, 104],
    [104, 104.5, 103.8, 104.2],
];

/** Four quiet sessions and a fifth that trends, at twice the opening volume. The test day is
 *  session index 3, so a 2-day ATR and a 2-day volume average are both defined for it. */
function bars(testDay: readonly Row[] = TREND_UP, testVolume = 200): OHLCV[] {
    return [
        ...session(11, FLAT, 100),
        ...session(12, FLAT, 100),
        ...session(13, FLAT, 100),
        ...session(14, testDay, testVolume),
        ...session(15, FLAT, 100),
    ];
}

const OPTS = { rangeMinutes: 5, atrDays: 2, relVolumeDays: 2 } as const;

describe('the opening range itself', () => {
    it('measures the first five minutes and nothing after them', () => {
        const range = detectOpeningRanges(bars(), OPTS)[3]!;

        // The high and low of bars 0-4 of the session, not of the whole day.
        expect(range.high).toBe(102.5);
        expect(range.low).toBe(99.5);
        expect(range.open).toBe(100);
        expect(range.close).toBe(102);
    });

    it('is knowable at the last bar of the range, not the first', () => {
        const range = detectOpeningRanges(bars(), OPTS)[3]!;

        // The session starts at index 30; five one-minute bars end at 34.
        expect(range.startIndex).toBe(30);
        expect(range.index).toBe(34);
        expect(range.sessionEndIndex).toBe(39);
    });

    it('takes its direction from the range close, and points the trigger at that edge', () => {
        const range = detectOpeningRanges(bars(), OPTS)[3]!;

        expect(range.direction).toBe('long');
        expect(range.trigger).toBe(102.5);
    });

    it('calls a range that closed where it opened no direction at all', () => {
        // The quiet sessions are dojis over their opening range.
        const range = detectOpeningRanges(bars(), OPTS)[2]!;

        expect(range.direction).toBeNull();
        expect(range.trigger).toBeNull();
    });

    it('leaves out a session that ends inside its own opening range', () => {
        // Three minutes of data cannot contain a five-minute range, and a range measured over
        // three of its five minutes is a different number under the same name.
        const short = session(11, FLAT.slice(0, 3), 100);
        expect(detectOpeningRanges(short, OPTS)).toEqual([]);
    });

    it('refuses a range that is not a whole number of bars rather than rounding it', () => {
        const quarterly = session(11, FLAT, 100, 15 * MIN);
        expect(() => detectOpeningRanges(quarterly, OPTS))
            .toThrow(/5-minute opening range cannot be built from 15-minute bars/);
    });

    it('refuses a range longer than the session it is measured in', () => {
        expect(() => detectOpeningRanges(bars(), { ...OPTS, rangeMinutes: 600 }))
            .toThrow(/does not fit inside the US cash session/);
    });
});

describe('what the days before say about today', () => {
    it('reads the daily ATR from earlier sessions only', () => {
        const range = detectOpeningRanges(bars(), OPTS)[3]!;

        /* The three quiet sessions each cover 2. The test day itself covers 5 — from 99.5 to
         * 104.5 — and if any of that leaked in, this would not be 2. That is the whole test:
         * the ATR a stop is sized from cannot know how the day went. */
        expect(range.atr).toBe(2);
    });

    it('has no ATR for the first session, because there is nothing behind it', () => {
        expect(detectOpeningRanges(bars(), OPTS)[0]!.atr).toBeNull();
    });

    it('measures opening volume against the same minutes on previous sessions', () => {
        const range = detectOpeningRanges(bars(), OPTS)[3]!;

        // 5 bars at 200 against two quiet sessions of 5 bars at 100.
        expect(range.volume).toBe(1000);
        expect(range.relativeVolume).toBe(2);
    });

    it('says null rather than 1 while there are not enough sessions to compare against', () => {
        const ranges = detectOpeningRanges(bars(), OPTS);

        // "Not enough history to say" and "an ordinary opening" are different answers, and a
        // filter that confused them would trade the warm-up.
        expect(ranges[0]!.relativeVolume).toBeNull();
        expect(ranges[1]!.relativeVolume).toBeNull();
        expect(ranges[2]!.relativeVolume).toBe(1);
    });

    it('reports no relative volume when the bars carry none', () => {
        const stripped = bars().map(({ volume, ...rest }) => rest);
        const range = detectOpeningRanges(stripped, OPTS)[3]!;

        expect(range.volume).toBeNull();
        expect(range.relativeVolume).toBeNull();
        // The range itself is still a fact about the market.
        expect(range.direction).toBe('long');
    });
});

describe('sessions', () => {
    /** The same ten minutes, but starting at 00:00 UTC — where a market with no open has one. */
    function utcSession(day: number, rows: readonly Row[]): OHLCV[] {
        const t0 = Date.parse(`2024-03-${day}T00:00:00Z`);
        return rows.map(([open, high, low, close], i) => ({
            time: t0 + i * MIN, open, high, low, close, volume: 100,
        }));
    }

    const midnight = [...utcSession(11, TREND_UP), ...utcSession(12, FLAT)];

    it('opens the UTC preset at midnight, one range per calendar day', () => {
        const ranges = detectOpeningRanges(midnight, { ...OPTS, session: 'utc' });

        expect(ranges).toHaveLength(2);
        expect(ranges[0]!.day).toBe('2024-03-11');
        expect(ranges[0]!.index).toBe(4);
        expect(ranges[0]!.trigger).toBe(102.5);
        expect(ranges[1]!.startIndex).toBe(10);
    });

    it('finds nothing in the same bars under the New York open, because they are not in it', () => {
        // 00:00 UTC is 20:00 the previous evening in New York — hours after the cash close.
        expect(detectOpeningRanges(midnight, OPTS)).toEqual([]);
    });

    it('skips a session whose opening minutes are missing from the data', () => {
        // Bars from 13:30 UTC never touch the first five minutes of the UTC day.
        expect(detectOpeningRanges(bars(), { ...OPTS, session: 'utc' })).toEqual([]);
    });

    it('refuses a session it does not know', () => {
        expect(() => detectOpeningRanges(bars(), { session: 'tokyo' as 'utc' }))
            .toThrow(/unknown session "tokyo"/);
    });
});
