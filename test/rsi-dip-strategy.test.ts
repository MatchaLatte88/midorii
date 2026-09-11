import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { buildStrategy } from '../app/renderer/strategies';
import { detectRsiDip, RSI_DIP_DEFAULTS } from '../src/core/analysis/rsiDip';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * The RSI(2) dip: which sessions qualify, when the ticket goes in, and when it comes off.
 *
 * Sessions here are minute bars over the US cash window only — 08:30 to 15:00 Central — which
 * is what the daily bar is folded from, and the reason a run on an index future does not read
 * its overnight. Each session is one price, flat all day, so the daily close is exactly that
 * price and the RSI is forced by the sequence rather than by the shape of any bar.
 *
 * The trend average is shortened to 30 in these tests. The published setting is 200, and
 * testing it at 200 would mean building two hundred sessions to exercise a comparison that
 * does not change with the length. It cannot be shortened much further than this: the filter
 * exists to keep the strategy out of a market that is falling, so an average close enough to
 * the price is one that a two-session dip always drops below, and then no dip ever qualifies.
 */

const MIN = 60_000;
/** 08:30 Central on a June 2024 weekday — CDT, so 13:30 UTC. */
function sessionStart(dayOffset: number): number {
    return Date.parse('2024-06-03T13:30:00Z') + dayOffset * 86_400_000;
}

/** One session of minutes at a flat price, 08:30 to 15:00 Central inclusive of 14:59. */
function session(dayOffset: number, price: number): OHLCV[] {
    return Array.from({ length: 390 }, (_, i) => ({
        time: sessionStart(dayOffset) + i * MIN,
        open: price,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 1,
    }));
}

/** Minutes past Central midnight → that minute's index within a session. */
const minuteOf = (h: number, m: number): number => h * 60 + m - (8 * 60 + 30);

function series(prices: readonly number[]): OHLCV[] {
    return prices.flatMap((price, day) => session(day, price));
}

/** Index of minute `m` of session `d` in the full series. */
const at = (d: number, m: number): number => d * 390 + m;

const OPTIONS = { ...RSI_DIP_DEFAULTS, smaLength: 30 };

/** Thirty-five sessions climbing a point each. Long enough for a 30-session average to sit
 *  well below the price, which is what leaves room for a dip to stay above it. */
const TREND = Array.from({ length: 35 }, (_, i) => 100 + i);

/**
 * The trend, then two four-point down sessions and a recovery. RSI(2) at the bottom is 7.7
 * against gains of a point a session, and 126 is still five points above the average, so
 * session 36 qualifies and nothing else does.
 */
const DIP = [...TREND, 130, 126, 130, 134, 138];

/** The same dip carried one session further, so two sessions in a row qualify. */
const DIP_TWICE = [...TREND, 130, 126, 124, 128, 132, 136];

/** The same shape in a market that has been falling: oversold, but below its average. */
const FALLING = [...Array.from({ length: 35 }, (_, i) => 200 - i), 166, 162, 166, 170];

function run(prices: readonly number[], params: Record<string, unknown> = {}) {
    const bars = series(prices);
    return {
        bars,
        result: runBacktest({
            bars,
            strategy: buildStrategy('rsidip', { maxLeverage: 1, smaLength: 30, ...params }, bars),
            broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
        }),
    };
}

describe('which sessions are dips', () => {
    it('needs both halves: oversold AND above the trend', () => {
        const { signals } = detectRsiDip(series(DIP), OPTIONS);
        expect(signals.length).toBe(1);
        // Session 36 closes at 126 after 134: two down sessions, RSI(2) at 7.7.
        expect(signals[0]!.day).toBe('2024-07-09');
        expect(signals[0]!.rsi).toBeLessThan(10);
        expect(signals[0]!.close).toBeGreaterThan(signals[0]!.sma);
    });

    it('knows the signal at the last bar of the cash session, not at midnight', () => {
        const { signals } = detectRsiDip(series(DIP), OPTIONS);
        // 14:59 Central is the last minute inside the window.
        expect(signals[0]!.index).toBe(at(36, minuteOf(14, 59)));
    });

    it('takes nothing from a dip below the trend', () => {
        expect(detectRsiDip(series(FALLING), OPTIONS).signals.length).toBe(0);
    });

    it('folds the daily bar from the cash window only', () => {
        const bars = series(DIP);
        // An overnight spike that the ETF this signal comes from would never have seen.
        const withNight = [...bars];
        withNight.splice(at(36, 0), 0, {
            time: sessionStart(36) - 120 * MIN, open: 500, high: 500, low: 500, close: 500, volume: 1,
        });
        const { daily } = detectRsiDip(withNight, OPTIONS);
        expect(Math.max(...daily.map((b) => b.high))).toBeLessThan(500);
    });

    it('reads nothing until the trend average exists', () => {
        // Four sessions cannot produce a 30-session average.
        expect(detectRsiDip(series([100, 99, 98, 97]), OPTIONS).signals.length).toBe(0);
    });
});

describe('what the strategy does with a dip', () => {
    it('buys at the entry time on the session AFTER the signal', () => {
        const { bars, result } = run(DIP);
        expect(result.fills.length).toBeGreaterThan(0);

        const entry = result.fills[0] as { time: number; side: string; price: number };
        expect(entry.side).toBe('buy');
        /* The signal is known at the close of session 36. The order goes in on session 37's
         * bar completing at 09:01 — the one opening at 09:00 — and fills at the next. */
        expect(entry.time).toBe(bars[at(37, minuteOf(9, 1))]!.time);
        expect(entry.price).toBe(bars[at(37, minuteOf(9, 1))]!.open);
    });

    it('sells at 14:50 on the second session after entry', () => {
        const { bars, result } = run(DIP);
        const exit = result.fills[result.fills.length - 1] as { time: number };
        // Entry is session 37, so the second session after it is 39.
        expect(exit.time).toBe(bars[at(39, minuteOf(14, 50))]!.time);
        expect(result.trades.length).toBe(1);
        expect(result.openPosition).toBeNull();
    });

    it('holds for as many sessions as it is told to', () => {
        const { bars, result } = run(DIP, { holdSessions: 1 });
        const exit = result.fills[result.fills.length - 1] as { time: number };
        expect(exit.time).toBe(bars[at(38, minuteOf(14, 50))]!.time);
    });

    it('is long only, whatever the market does', () => {
        const { result } = run(DIP);
        const trades = result.trades as Array<{ side: string }>;
        expect(trades.every((t) => t.side === 'long')).toBe(true);
    });

    it('carries no stop, so the debit is not the risk', () => {
        const { result } = run(DIP);
        expect(result.orders.filter((o) => o.tag === 'stop-loss').length).toBe(0);
    });

    it('passes over a dip that arrives while a position is on', () => {
        /* Two qualifying sessions in a row. The first is entered on the second one's morning,
         * so by the time that second signal is known at 14:59 there is a position on — and
         * with one position per name it is passed over rather than queued. */
        expect(detectRsiDip(series(DIP_TWICE), OPTIONS).signals.length).toBe(2);
        expect(run(DIP_TWICE).result.trades.length).toBe(1);
    });
});
