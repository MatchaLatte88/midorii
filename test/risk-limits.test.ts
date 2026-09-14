// The limits that end a session, and the floor that ends the account.
//
// Every assertion here is about a figure a person reads off the band or an order being refused
// or let through, and one of them is the one that matters most: a breached limit must never
// trap somebody inside the trade that breached it. Closing always works.
import { describe, it, expect } from 'vitest';
import {
    NO_LIMITS,
    accountStanding,
    eodHighWater,
    increases,
    limitRefusal,
    mllFloor,
    sessionStart,
    sessionState,
} from '../app/renderer/trading/riskLimits';
import type { PropStanding, RiskLimits } from '../app/renderer/trading/riskLimits';
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

/** Inside the session that began at 2026-09-11T21:00Z. */
const NOW = Date.parse('2026-09-11T23:00:00Z');

/** The standing, with everything an account would state defaulted to something uneventful. */
const stand = (
    over: Partial<RiskLimits>,
    account: { equity?: number; openPnl?: number; history?: readonly HistoryRow[]; mark?: number } = {},
): PropStanding => accountStanding({
    limits: limits(over),
    equity: account.equity ?? 50_000,
    openPnl: account.openPnl ?? 0,
    history: account.history ?? [],
    storedHighWater: account.mark ?? 0,
    now: NOW,
});

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
    it('counts only what closed inside this session', () => {
        const state = sessionState([
            closed(-100, '2026-09-11T22:00:00Z'),
            closed(-900, '2026-09-11T20:00:00Z'), // the session before — not this one
        ], NOW);
        expect(state.realised).toBe(-100);
    });

    it('counts the run of losses ending now, newest first', () => {
        const state = sessionState([
            closed(-50, '2026-09-11T22:30:00Z'),
            closed(-50, '2026-09-11T22:20:00Z'),
            closed(200, '2026-09-11T22:10:00Z'),
            closed(-50, '2026-09-11T22:00:00Z'),
        ], NOW);
        expect(state.lossStreak).toBe(2);
    });

    it('does not count a scratch as a loss', () => {
        const state = sessionState([closed(0, '2026-09-11T22:30:00Z'), closed(-50, '2026-09-11T22:00:00Z')], NOW);
        expect(state.lossStreak).toBe(0);
    });
});

describe('the mark an end-of-day floor trails', () => {
    it('is the starting balance with nothing traded', () => {
        expect(eodHighWater([], 50_000, 50_000, NOW)).toBe(50_000);
    });

    it('is the best day’s CLOSE, not the balance now', () => {
        /* The whole point of the mode. The account closed Wednesday at 52,000, gave some back
         * on Thursday and is at 51,500 today — a floor measured off today would sit 500 too
         * low, which is the direction that warns too late. */
        const history = [
            closed(500, '2026-09-11T22:00:00Z'),    // today, still open
            closed(-1000, '2026-09-10T22:00:00Z'),
            closed(2000, '2026-09-09T22:00:00Z'),
        ];
        expect(eodHighWater(history, 51_500, 50_000, NOW)).toBe(52_000);
    });

    it('leaves today out of it, however good today is', () => {
        // Nothing but a winning day that has not closed: the mark is still where it began.
        const history = [closed(5_000, '2026-09-11T22:00:00Z')];
        expect(eodHighWater(history, 55_000, 50_000, NOW)).toBe(50_000);
    });

    it('folds in the last day that DID close when nothing has closed today', () => {
        const history = [
            closed(-1000, '2026-09-10T22:00:00Z'),
            closed(2000, '2026-09-09T22:00:00Z'),
        ];
        expect(eodHighWater(history, 51_000, 50_000, NOW)).toBe(52_000);
    });

    it('works back to the balance before the history window, and counts that too', () => {
        /* All the venue serves is one losing day. The balance before it — 60,000 — is itself a
         * day's close and is the highest thing known, so it is the mark. */
        const history = [closed(-10_000, '2026-09-10T22:00:00Z')];
        expect(eodHighWater(history, 50_000, 50_000, NOW)).toBe(60_000);
    });
});

describe('where the floor sits', () => {
    it('is nowhere without both an amount and a starting balance', () => {
        expect(mllFloor(limits({ maxLoss: 2_000 }), 50_000)).toBeNull();
        expect(mllFloor(limits({ startBalance: 50_000 }), 50_000)).toBeNull();
    });

    it('ignores the mark when it is set to stay put', () => {
        expect(mllFloor(limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'static' }), 58_000))
            .toBe(48_000);
    });

    it('follows the mark up when it trails', () => {
        expect(mllFloor(limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' }), 52_000))
            .toBe(50_000);
    });

    it('never trails DOWN under a losing account', () => {
        // A mark below where the account started is not a mark; the floor stays where it began.
        expect(mllFloor(limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' }), 47_000))
            .toBe(48_000);
    });

    it('stops at the starting balance when it is set to freeze there', () => {
        const frozen = limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod', mllFreezeAtStart: true });
        expect(mllFloor(frozen, 51_000)).toBe(49_000);   // still climbing
        expect(mllFloor(frozen, 54_000)).toBe(50_000);   // would be 52,000 — capped
        expect(mllFloor(frozen, 99_000)).toBe(50_000);   // and stays there
    });
});

describe('what the account stands on', () => {
    it('counts the open position in the day, the way a firm counts it', () => {
        const standing = stand({ dailyLoss: 1_000 }, {
            history: [closed(-400, '2026-09-11T22:00:00Z')],
            openPnl: -300,
        });
        expect(standing.dayResult).toBe(-700);
        expect(standing.dayRoom).toBe(300);
        expect(standing.breached).toBeNull();
    });

    it('is past the daily limit on the open trade alone', () => {
        // The reason it counts: a limit met only after the loss was booked is met too late.
        const standing = stand({ dailyLoss: 1_000 }, { openPnl: -1_000 });
        expect(standing.breached).toBe('dll');
    });

    it('has no daily room at all when no daily limit is set', () => {
        expect(stand({}, { openPnl: -50_000 }).dayRoom).toBeNull();
        expect(stand({}, { openPnl: -50_000 }).breached).toBeNull();
    });

    it('measures the profit and the goal from the starting balance, open trade included', () => {
        const standing = stand({ startBalance: 50_000, profitGoal: 3_000 }, { equity: 51_500, openPnl: 500 });
        expect(standing.profit).toBe(1_500);
        expect(standing.goalProgress).toBeCloseTo(0.5);
        expect(standing.goalRoom).toBe(1_500);
    });

    it('stops the goal’s remainder at zero once it is reached', () => {
        const standing = stand({ startBalance: 50_000, profitGoal: 3_000 }, { equity: 54_000 });
        expect(standing.goalProgress).toBeCloseTo(4 / 3);
        expect(standing.goalRoom).toBe(0);
    });

    it('says nothing about profit with no starting balance to measure from', () => {
        const standing = stand({ profitGoal: 3_000 }, { equity: 51_500 });
        expect(standing.profit).toBeNull();
        expect(standing.goalProgress).toBeNull();
    });

    it('raises an intraday mark on the equity itself', () => {
        const standing = stand(
            { startBalance: 50_000, maxLoss: 2_000, mllMode: 'intraday' },
            { equity: 53_000 },
        );
        expect(standing.highWater).toBe(53_000);
        expect(standing.floor).toBe(51_000);
    });

    it('keeps a stored mark that the account has since fallen below', () => {
        /* What the store is for: the floor rose once and does not come back down because the
         * history window rolled forward or the app was restarted. */
        const standing = stand(
            { startBalance: 50_000, maxLoss: 2_000, mllMode: 'intraday' },
            { equity: 50_500, mark: 56_000 },
        );
        expect(standing.highWater).toBe(56_000);
        expect(standing.floor).toBe(54_000);
        expect(standing.breached).toBe('mll');
    });

    it('is on the floor when the equity is exactly on it', () => {
        // At it, not merely through it: a firm closes the account on the touch.
        const standing = stand({ startBalance: 50_000, maxLoss: 2_000 }, { equity: 48_000 });
        expect(standing.room).toBe(0);
        expect(standing.breached).toBe('mll');
    });

    it('answers nothing measured against the equity before the account has stated one', () => {
        /* The state a freshly armed chart is in for a second or two. Judged as a reading, a
         * zero equity is below every floor — and on an account set to close out, that second
         * would send a market order nobody asked for. */
        const standing = stand(
            { startBalance: 50_000, maxLoss: 2_000, profitGoal: 3_000 },
            { equity: 0 },
        );
        expect(standing.known).toBe(false);
        expect(standing.breached).toBeNull();
        expect(standing.room).toBeNull();
        expect(standing.profit).toBeNull();
        expect(standing.goalProgress).toBeNull();
        // The floor itself is still knowable — it comes off the settings, not off the account.
        expect(standing.floor).toBe(48_000);
    });

    it('still answers the daily limit before the first read, since that counts trades', () => {
        // Honestly zero rather than unknown: nothing has closed and nothing is open.
        const standing = stand({ dailyLoss: 500 }, { equity: 0 });
        expect(standing.dayRoom).toBe(500);
        expect(standing.breached).toBeNull();
    });

    it('leaves the stored mark alone while the account is silent', () => {
        const standing = stand(
            { startBalance: 50_000, maxLoss: 2_000, mllMode: 'intraday' },
            { equity: 0, mark: 53_000 },
        );
        expect(standing.highWater).toBe(53_000);
    });

    it('names the floor first when both are past', () => {
        const standing = stand(
            { startBalance: 50_000, maxLoss: 2_000, dailyLoss: 500 },
            { equity: 47_000, openPnl: -3_000 },
        );
        expect(standing.breached).toBe('mll');
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
    const down = (amount: number): PropStanding =>
        stand({ dailyLoss: 500 }, { history: [closed(-amount, '2026-09-11T22:00:00Z')] });
    const flat = stand({});

    it('lets everything through with no limits set — which is how they ship', () => {
        const nothing = stand({}, { history: [closed(-100_000, '2026-09-11T22:00:00Z')] });
        expect(limitRefusal(NO_LIMITS, nothing, { net: 0, side: 'buy', size: 99 })).toBeNull();
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

    it('refuses a new trade once the account is on its floor, and names the level', () => {
        const rules = limits({ startBalance: 50_000, maxLoss: 2_000 });
        const onIt = stand({ startBalance: 50_000, maxLoss: 2_000 }, { equity: 47_900 });
        const refusal = limitRefusal(rules, onIt, { net: 0, side: 'buy', size: 1 });
        expect(refusal).toMatch(/maximum loss limit/);
        expect(refusal).toMatch(/48000\.00/);
        // And the way out is still open, which is the whole distinction.
        expect(limitRefusal(rules, onIt, { net: 1, side: 'sell', size: 1 })).toBeNull();
    });

    it('stops after the run of losses somebody said to stop at', () => {
        const streak = stand({ lossStreak: 3 }, {
            history: [
                closed(-10, '2026-09-11T22:30:00Z'),
                closed(-10, '2026-09-11T22:20:00Z'),
                closed(-10, '2026-09-11T22:10:00Z'),
            ],
        });
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

    it('says nothing about a profit goal that has been reached', () => {
        // A goal is a destination, not a limit. Reaching it refuses nothing.
        const done = stand({ startBalance: 50_000, profitGoal: 3_000 }, { equity: 60_000 });
        expect(limitRefusal(limits({ startBalance: 50_000, profitGoal: 3_000 }), done, { net: 0, side: 'buy', size: 1 }))
            .toBeNull();
    });
});
