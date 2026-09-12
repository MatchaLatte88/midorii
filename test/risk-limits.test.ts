// The limits that end a session.
//
// Every assertion here is about an order being refused or let through, and one of them is the
// one that matters most: a breached limit must never trap somebody inside the trade that
// breached it. Closing always works.
import { describe, it, expect } from 'vitest';
import { NO_LIMITS, increases, limitRefusal, sessionStart, sessionState } from '../app/renderer/trading/riskLimits';
import type { RiskLimits } from '../app/renderer/trading/riskLimits';
import type { HistoryRow } from '../app/renderer/replay/tradeBook';

/** A closed trade, as an account reports one. */
const closed = (netPnl: number, closedAt: string): HistoryRow => ({
    side: netPnl >= 0 ? 'long' : 'short',
    size: 1,
    entryPrice: 100,
    exitPrice: 100,
    openedAt: Date.parse(closedAt) - 60_000,
    closedAt: Date.parse(closedAt),
    netPnl,
    fees: 0,
    r: null,
    exitTag: null,
});

const limits = (over: Partial<RiskLimits> = {}): RiskLimits => ({ ...NO_LIMITS, ...over });

describe('where a session begins', () => {
    it('starts at 17:00 New York, not at local midnight', () => {
        // 2026-09-11 is summer time: New York is UTC−4, so 17:00 there is 21:00 UTC.
        const during = Date.parse('2026-09-11T23:00:00Z');
        expect(new Date(sessionStart(during)).toISOString()).toBe('2026-09-11T21:00:00.000Z');
    });

    it('puts the small hours in the session that began the evening before', () => {
        const overnight = Date.parse('2026-09-12T03:00:00Z');
        expect(new Date(sessionStart(overnight)).toISOString()).toBe('2026-09-11T21:00:00.000Z');
    });

    it('follows New York through the clock change rather than a fixed offset', () => {
        // January is standard time: UTC−5, so 17:00 there is 22:00 UTC.
        const winter = Date.parse('2026-01-15T23:00:00Z');
        expect(new Date(sessionStart(winter)).toISOString()).toBe('2026-01-15T22:00:00.000Z');
    });
});

describe('what the session has done', () => {
    const now = Date.parse('2026-09-11T23:00:00Z'); // inside the session that began at 21:00Z

    it('counts only what closed inside this session', () => {
        const state = sessionState([
            closed(-100, '2026-09-11T22:00:00Z'),
            closed(-900, '2026-09-11T20:00:00Z'), // the session before — not this one
        ], now);
        expect(state.realised).toBe(-100);
    });

    it('counts the run of losses ending now, newest first', () => {
        const state = sessionState([
            closed(-50, '2026-09-11T22:30:00Z'),
            closed(-50, '2026-09-11T22:20:00Z'),
            closed(200, '2026-09-11T22:10:00Z'),
            closed(-50, '2026-09-11T22:00:00Z'),
        ], now);
        expect(state.lossStreak).toBe(2);
    });

    it('does not count a scratch as a loss', () => {
        const state = sessionState([closed(0, '2026-09-11T22:30:00Z'), closed(-50, '2026-09-11T22:00:00Z')], now);
        expect(state.lossStreak).toBe(0);
    });
});

describe('whether an order adds to what is on', () => {
    it('counts anything from flat as adding', () => {
        expect(increases({ net: 0, side: 'buy', size: 1 })).toBe(true);
        expect(increases({ net: 0, side: 'sell', size: 1 })).toBe(true);
    });

    it('counts the same direction as adding and the other as reducing', () => {
        expect(increases({ net: 2, side: 'buy', size: 1 })).toBe(true);
        expect(increases({ net: 2, side: 'sell', size: 1 })).toBe(false);
        expect(increases({ net: -2, side: 'buy', size: 1 })).toBe(false);
    });
});

describe('when an order is refused', () => {
    const now = Date.parse('2026-09-11T23:00:00Z');
    const down = (amount: number) => sessionState([closed(-amount, '2026-09-11T22:00:00Z')], now);
    const flat = sessionState([], now);

    it('lets everything through with no limits set — which is how they ship', () => {
        expect(limitRefusal(NO_LIMITS, down(100_000), { net: 0, side: 'buy', size: 99 })).toBeNull();
    });

    it('refuses a new trade once the session loss limit is reached', () => {
        const refusal = limitRefusal(limits({ dailyLoss: 500 }), down(500), { net: 0, side: 'buy', size: 1 });
        expect(refusal).toMatch(/loss limit for this session is reached/);
    });

    it('still lets the position be CLOSED once that limit is reached', () => {
        // The one that matters: a limit must not trap somebody inside the trade that broke it.
        expect(limitRefusal(limits({ dailyLoss: 500 }), down(900), { net: 2, side: 'sell', size: 2 })).toBeNull();
    });

    it('leaves the limit alone while the session is still above it', () => {
        expect(limitRefusal(limits({ dailyLoss: 500 }), down(499), { net: 0, side: 'buy', size: 1 })).toBeNull();
    });

    it('stops after the run of losses somebody said to stop at', () => {
        const streak = sessionState([
            closed(-10, '2026-09-11T22:30:00Z'),
            closed(-10, '2026-09-11T22:20:00Z'),
            closed(-10, '2026-09-11T22:10:00Z'),
        ], now);
        expect(limitRefusal(limits({ lossStreak: 3 }), streak, { net: 0, side: 'buy', size: 1 }))
            .toMatch(/3 losing trades in a row/);
        // And still lets the way out through.
        expect(limitRefusal(limits({ lossStreak: 3 }), streak, { net: 1, side: 'sell', size: 1 })).toBeNull();
    });

    it('refuses what would hold more than the most that may be held', () => {
        expect(limitRefusal(limits({ maxSize: 3 }), flat, { net: 2, side: 'buy', size: 2 }))
            .toMatch(/would hold 4 against a limit of 3/);
        expect(limitRefusal(limits({ maxSize: 3 }), flat, { net: 2, side: 'buy', size: 1 })).toBeNull();
    });

    it('measures the size against the short side the same way', () => {
        expect(limitRefusal(limits({ maxSize: 3 }), flat, { net: -3, side: 'sell', size: 1 }))
            .toMatch(/would hold 4/);
    });
});
