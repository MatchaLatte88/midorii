import { describe, it, expect } from 'vitest';
import { detectIntradayWindows } from '../src/core/analysis/intradayWindows';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * What the intraday window detector promises.
 *
 * The one that matters most is the look-ahead guard. Every window here is defined by a clock,
 * and a clock is easy to get subtly wrong: a signal window that ends one bar too late reads
 * part of the move it is supposed to predict, and the backtest downstream then reports a
 * strategy nobody could have run. That is checked twice below — once as a refusal, and once by
 * pinning the exact bar each window is measured from.
 */

const STEP = 15 * 60_000;
const BARS_PER_DAY = 96;

/** A day of 15-minute bars from midnight UTC, holding each level until the next one. Bar i
 *  opens at i × 15 minutes, so bar 39 closes at 10:00 and bar 91 at 23:00. */
function day(dateIso: string, levels: Record<number, number>, start = 100): OHLCV[] {
    const t0 = Date.parse(`${dateIso}T00:00:00Z`);
    const out: OHLCV[] = [];
    let previous = start;
    let level = start;
    for (let i = 0; i < BARS_PER_DAY; i += 1) {
        if (levels[i] !== undefined) level = levels[i]!;
        const open = previous;
        const close = level;
        out.push({
            time: t0 + i * STEP,
            open,
            high: Math.max(open, close) + 1,
            low: Math.min(open, close) - 1,
            close,
            volume: 10,
        });
        previous = close;
    }
    return out;
}

/** Flat all day: every window returns zero, and the daily range is exactly 2. */
const QUIET: Record<number, number> = {};

/** Up 2% by mid-morning, giving 1 back into the close — the shape the default mode trades. */
const EARLY_UP_LATE_DOWN: Record<number, number> = { 20: 102, 89: 101, 95: 103 };

function bars(testDay: Record<number, number> = EARLY_UP_LATE_DOWN): OHLCV[] {
    return [
        ...day('2024-03-11', QUIET),
        ...day('2024-03-12', QUIET),
        ...day('2024-03-13', QUIET),
        ...day('2024-03-14', testDay),
        ...day('2024-03-15', QUIET, 103),
    ];
}

/** UTC days, a one-hour traded window and a one-hour window before it, so each covers four
 *  bars rather than the minimum two. */
const OPTS = { boundary: 'utc', signalEndMin: 600, tradeMinutes: 60, confirmMinutes: 60, atrDays: 2 } as const;

describe('cutting the day into windows', () => {
    it('reports one entry per trading day', () => {
        const days = detectIntradayWindows(bars(), OPTS);
        expect(days).toHaveLength(5);
        expect(days.map((d) => d.day)).toEqual([
            '2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15',
        ]);
    });

    it('opens the traded window at the right bar and acts one bar before it', () => {
        const d = detectIntradayWindows(bars(), OPTS)[3]!;
        const base = 3 * BARS_PER_DAY;

        // A 60-minute window at the end of a 96-bar day is bars 92-95.
        expect(d.tradeStartIndex).toBe(base + 92);
        expect(d.tradeEndIndex).toBe(base + 95);
        // The order goes on the last bar before it opens.
        expect(d.index).toBe(base + 91);
    });

    it('measures the early window from the previous day close to the chosen minute', () => {
        const d = detectIntradayWindows(bars(), OPTS)[3]!;

        // Previous day closed at 100; bar 39 (09:45-10:00) is the last one before 10:00, and
        // the level was already 102 by then.
        expect(d.signalReturn).toBeCloseTo(0.02, 10);
    });

    it('measures the late window over exactly the hour before the traded one', () => {
        const d = detectIntradayWindows(bars(), OPTS)[3]!;

        // 22:00 to 23:00: bar 87 closed at 102, bar 91 at 101.
        expect(d.confirmReturn).toBeCloseTo(101 / 102 - 1, 10);
    });

    it('reports what the traded window did, which no strategy can read in time', () => {
        const d = detectIntradayWindows(bars(), OPTS)[3]!;

        // Open of bar 92 is the close of bar 91 (101); close of bar 95 is 103.
        expect(d.tradeReturn).toBeCloseTo(103 / 101 - 1, 10);
    });

    it('has no early return on the first day, because there is no close before it', () => {
        expect(detectIntradayWindows(bars(), OPTS)[0]!.signalReturn).toBeNull();
    });

    it('leaves the late window null when it is switched off', () => {
        const d = detectIntradayWindows(bars(), { ...OPTS, confirmMinutes: 0 })[3]!;
        expect(d.confirmReturn).toBeNull();
        expect(d.signalReturn).toBeCloseTo(0.02, 10);
    });
});

describe('the look-ahead guard', () => {
    it('refuses a signal window that ends after the traded window opens', () => {
        // 23:30 is inside a 60-minute window that opens at 23:00 — the signal would be reading
        // the move it is supposed to predict.
        expect(() => detectIntradayWindows(bars(), { ...OPTS, signalEndMin: 23 * 60 + 30 }))
            .toThrow(/would let the signal see the move it is meant to predict/);
    });

    it('refuses windows that do not fit inside a day', () => {
        expect(() => detectIntradayWindows(bars(), { ...OPTS, tradeMinutes: 800, confirmMinutes: 800 }))
            .toThrow(/do not fit inside one day/);
    });

    it('refuses a boundary it does not know', () => {
        expect(() => detectIntradayWindows(bars(), { boundary: 'tokyo' as 'utc' }))
            .toThrow(/unknown boundary "tokyo"/);
    });
});

describe('what the days before say about today', () => {
    it('reads the daily ATR from earlier days only', () => {
        const d = detectIntradayWindows(bars(), OPTS)[3]!;

        /* The quiet days each cover 2. The test day covers far more — it ran from 99 to 104 —
         * and if any of that leaked in this would not be 2. */
        expect(d.atr).toBe(2);
    });

    it('has no ATR on the first day', () => {
        expect(detectIntradayWindows(bars(), OPTS)[0]!.atr).toBeNull();
    });
});

describe('where the day is cut', () => {
    /** Four hours of 15-minute bars starting 16:00 New York, which straddles a 17:00 boundary. */
    const straddle: OHLCV[] = Array.from({ length: 16 }, (_, i) => {
        const t = Date.parse('2024-03-14T20:00:00Z') + i * STEP; // 16:00 EDT
        return { time: t, open: 100, high: 101, low: 99, close: 100, volume: 1 };
    });

    it('puts a bar past the CME close into the next trading day', () => {
        const days = detectIntradayWindows(straddle, {
            boundary: 'cme', signalEndMin: 10 * 60, tradeMinutes: 30, confirmMinutes: 0, atrDays: 1,
        });

        /* 16:00-17:00 belongs to the 14th and ends at the boundary, so its last half hour is a
         * complete traded window: bars 2 and 3. Everything from 17:00 on is the 15th, which
         * runs out of data long before its own close and produces nothing. */
        expect(days).toHaveLength(1);
        expect(days[0]!.day).toBe('2024-03-14');
        expect(days[0]!.tradeStartIndex).toBe(2);
        expect(days[0]!.tradeEndIndex).toBe(3);
    });

    it('puts the same bars in a different place under a UTC day', () => {
        // Identical bars, one boundary later: 20:00-23:45 UTC is all one day, and its traded
        // hour is 23:00 onwards — bar 12, not bar 2.
        const days = detectIntradayWindows(straddle, { ...OPTS, atrDays: 1 });

        expect(days).toHaveLength(1);
        expect(days[0]!.day).toBe('2024-03-14');
        expect(days[0]!.tradeStartIndex).toBe(12);
        expect(days[0]!.tradeEndIndex).toBe(15);
    });
});
