// The conditions a strategy has to satisfy before it may trade unattended. The rules under
// test: a guard can only ever refuse an ENTRY, a window that wraps midnight is one window
// rather than an empty one, the daily limits are measured against the day's own opening
// equity, and every refusal says which guard turned the trade away.
// See app/renderer/strategies/liveGuards.ts.
import { describe, it, expect } from 'vitest';
import {
    LIVE_GUARD_KEYS,
    LIVE_GUARD_PARAMS,
    guardRefusal,
    guardsOf,
    insideWindow,
    resolveGuards,
    type GuardState,
    type LiveGuards,
} from '../app/renderer/strategies/liveGuards';

/** The defaults, as a bot that has never been configured would run under. */
function defaults(over: Partial<LiveGuards> = {}): LiveGuards {
    return { ...guardsOf(resolveGuards({})), ...over };
}

/** A bot standing still on a Wednesday afternoon with nothing wrong. */
function state(over: Partial<GuardState> = {}): GuardState {
    const now = Date.UTC(2026, 8, 9, 14, 0); // Wednesday
    return {
        now,
        equity: 10_000,
        dayOpenEquity: 10_000,
        openPositions: 0,
        tradesToday: 0,
        lastLossAt: null,
        lastTickAt: now - 1_000,
        spread: null,
        ...over,
    };
}

describe('the guard schema', () => {
    it('resolves to the defaults a bot that was never configured runs under', () => {
        const guards = guardsOf(resolveGuards({}));
        expect(guards.tradingDays).toEqual([1, 2, 3, 4, 5]);
        expect(guards.maxOpenPositions).toBe(1);
        // Off by default, every one of them: a guard nobody asked for must not be the
        // reason a bot took no trades.
        expect(guards.maxTradesPerDay).toBe(0);
        expect(guards.dailyLossLimit).toBe(0);
        expect(guards.dailyProfitTarget).toBe(0);
        expect(guards.cooldownMinutes).toBe(0);
        expect(guards.maxSpreadPct).toBe(0);
        // Except this one. A bot trading on a price that stopped arriving an hour ago is
        // the single most expensive thing an unattended strategy can do.
        expect(guards.staleFeedSeconds).toBe(120);
    });

    it('refuses a clock outside the day', () => {
        expect(() => resolveGuards({ sessionStart: 1440 })).toThrow(/above 1439/);
        expect(() => resolveGuards({ sessionEnd: -1 })).toThrow(/below 0/);
    });

    it('keeps the key list and the schema in step', () => {
        expect(LIVE_GUARD_KEYS).toEqual(LIVE_GUARD_PARAMS.map((p) => p.key));
    });
});

describe('the trading window', () => {
    it('is the whole day when the two ends are equal', () => {
        const guards = defaults({ sessionStart: 0, sessionEnd: 0 });
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 3, 0))).toBe(true);
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 23, 59))).toBe(true);
    });

    it('holds between its ends and not outside them', () => {
        const guards = defaults({ sessionStart: 9 * 60 + 30, sessionEnd: 16 * 60 });
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 9, 29))).toBe(false);
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 9, 30))).toBe(true);
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 15, 59))).toBe(true);
        // The end is exclusive: 16:00 is when it stops, not the last minute it runs.
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 16, 0))).toBe(false);
    });

    it('wraps over midnight rather than being empty', () => {
        // 22:00–06:00 is the Asian session, not a window that ends before it starts.
        const guards = defaults({ sessionStart: 22 * 60, sessionEnd: 6 * 60 });
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 23, 0))).toBe(true);
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 2, 0))).toBe(true);
        expect(insideWindow(guards, Date.UTC(2026, 8, 9, 12, 0))).toBe(false);
    });

    it('is shut on a day the bot does not trade', () => {
        const guards = defaults({ tradingDays: [1, 2, 3, 4, 5] });
        // 2026-09-12 is a Saturday.
        expect(insideWindow(guards, Date.UTC(2026, 8, 12, 14, 0))).toBe(false);
    });
});

describe('what a guard refuses', () => {
    it('lets an ordinary entry through', () => {
        expect(guardRefusal(defaults(), state())).toBeNull();
    });

    it('names the window when the clock is outside it', () => {
        const guards = defaults({ sessionStart: 9 * 60, sessionEnd: 10 * 60 });
        expect(guardRefusal(guards, state())).toMatch(/09:00–10:00 UTC/);
    });

    it('says the days rather than the hours when there is no window set', () => {
        const guards = defaults();
        const saturday = state({ now: Date.UTC(2026, 8, 12, 14, 0) });
        expect(guardRefusal(guards, saturday)).toMatch(/trading days/);
    });

    it('refuses on a feed that has gone quiet', () => {
        const guards = defaults({ staleFeedSeconds: 60 });
        const quiet = state({ lastTickAt: state().now - 120_000 });
        expect(guardRefusal(guards, quiet)).toMatch(/quiet for 120s/);
    });

    it('refuses before the feed has ever spoken', () => {
        expect(guardRefusal(defaults(), state({ lastTickAt: null }))).toMatch(/has not spoken/);
    });

    it('says nothing about a quiet feed when the check is switched off', () => {
        const guards = defaults({ staleFeedSeconds: 0 });
        expect(guardRefusal(guards, state({ lastTickAt: null }))).toBeNull();
    });

    it('refuses a second position when the bot may hold one', () => {
        expect(guardRefusal(defaults(), state({ openPositions: 1 }))).toMatch(/already has a position/);
    });

    it('refuses once the day\'s trades are used up', () => {
        const guards = defaults({ maxTradesPerDay: 3 });
        expect(guardRefusal(guards, state({ tradesToday: 3 }))).toMatch(/its 3 trades for today/);
        expect(guardRefusal(guards, state({ tradesToday: 2 }))).toBeNull();
    });

    it('measures the daily loss against the day\'s own opening equity', () => {
        const guards = defaults({ dailyLossLimit: 2 });
        // Down 2% exactly is at the limit, which is where it stops.
        expect(guardRefusal(guards, state({ equity: 9_800 }))).toMatch(/2\.00% on the day/);
        expect(guardRefusal(guards, state({ equity: 9_801 }))).toBeNull();
    });

    it('counts an open position\'s loss, not only booked ones', () => {
        // The equity handed in is the marked one; a limit that only saw booked losses would
        // let a single trade run straight through it.
        const guards = defaults({ dailyLossLimit: 1 });
        expect(guardRefusal(guards, state({ equity: 9_890 }))).not.toBeNull();
    });

    it('stops for the day at the profit target', () => {
        const guards = defaults({ dailyProfitTarget: 3 });
        expect(guardRefusal(guards, state({ equity: 10_300 }))).toMatch(/3\.00% on the day/);
        expect(guardRefusal(guards, state({ equity: 10_299 }))).toBeNull();
    });

    it('says nothing about the day when there is no opening equity to measure against', () => {
        const guards = defaults({ dailyLossLimit: 1 });
        expect(guardRefusal(guards, state({ dayOpenEquity: 0, equity: 5_000 }))).toBeNull();
    });

    it('waits out a cooldown and then stops mentioning it', () => {
        const guards = defaults({ cooldownMinutes: 15 });
        const now = state().now;
        expect(guardRefusal(guards, state({ lastLossAt: now - 5 * 60_000 }))).toMatch(/10 more minutes/);
        expect(guardRefusal(guards, state({ lastLossAt: now - 15 * 60_000 }))).toBeNull();
    });

    it('refuses a spread wider than the bot will trade', () => {
        const guards = defaults({ maxSpreadPct: 0.02 });
        // 0.05% wide.
        expect(guardRefusal(guards, state({ spread: { bid: 100, ask: 100.05 } }))).toMatch(/wider than the 0.02%/);
        expect(guardRefusal(guards, state({ spread: { bid: 100, ask: 100.01 } }))).toBeNull();
    });

    it('says nothing about a spread on a venue that quotes one price', () => {
        const guards = defaults({ maxSpreadPct: 0.001 });
        expect(guardRefusal(guards, state({ spread: null }))).toBeNull();
    });

    it('reports the most fundamental refusal first', () => {
        // Outside the window AND over every limit: the window is what it says, because a bot
        // that is shut has nothing to say about its spread.
        const guards = defaults({ sessionStart: 9 * 60, sessionEnd: 10 * 60, maxSpreadPct: 0.001, maxTradesPerDay: 1 });
        const bad = state({ tradesToday: 5, spread: { bid: 100, ask: 105 } });
        expect(guardRefusal(guards, bad)).toMatch(/trading window/);
    });
});
