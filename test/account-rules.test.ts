// Each account's own limits, as they are stored and read back.
//
// Two things are being proved here. That one account's numbers can never be read as another's
// — the whole reason they are keyed — and that the trailing mark only ever goes UP, since a
// mark that slipped back would drop a floor the account had already earned.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    NO_RULES,
    PAPER_ACCOUNT_KEY,
    loadAccountRules,
    markAfterChange,
    normalizeAccountRules,
    normalizeRules,
    propGuard,
    saveAccountRules,
} from '../app/renderer/trading/accountRules';
import { NO_LIMITS } from '../app/renderer/trading/riskLimits';
import type { RiskLimits } from '../app/renderer/trading/riskLimits';
import type { HistoryRow } from '../app/renderer/replay/tradeBook';

/** This module reaches for localStorage, which vitest's node environment has none of. */
function stubStorage(): Map<string, string> {
    const cells = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
    return cells;
}

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

describe('reading a stored rule set', () => {
    beforeEach(() => stubStorage());

    it('is everything off for an account nothing was ever set on', () => {
        expect(loadAccountRules('projectx:1')).toEqual(NO_RULES);
    });

    it('keeps one account’s numbers out of another’s', () => {
        // The reason the key exists: an evaluation and a funded account are two thresholds.
        saveAccountRules('projectx:1', { limits: limits({ maxLoss: 2_000, startBalance: 50_000 }), highWater: 51_000 });
        saveAccountRules('projectx:2', { limits: limits({ maxLoss: 3_000, startBalance: 150_000 }), highWater: 0 });

        expect(loadAccountRules('projectx:1').limits.maxLoss).toBe(2_000);
        expect(loadAccountRules('projectx:1').highWater).toBe(51_000);
        expect(loadAccountRules('projectx:2').limits.maxLoss).toBe(3_000);
        expect(loadAccountRules('projectx:2').highWater).toBe(0);
    });

    it('does not disturb the other accounts when one is written', () => {
        saveAccountRules('capital:demo', { limits: limits({ dailyLoss: 100 }), highWater: 0 });
        saveAccountRules('capital:live', { limits: limits({ dailyLoss: 900 }), highWater: 0 });
        saveAccountRules('capital:demo', { limits: limits({ dailyLoss: 200 }), highWater: 0 });

        expect(loadAccountRules('capital:live').limits.dailyLoss).toBe(900);
        expect(loadAccountRules('capital:demo').limits.dailyLoss).toBe(200);
    });

    it('reads a corrupted record as no rules rather than throwing', () => {
        localStorage.setItem('midorii-account-rules', '{ not json');
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(loadAccountRules('paper')).toEqual(NO_RULES);
        expect(quiet).toHaveBeenCalled();   // reported, never swallowed
    });

    it('spells the paper account’s key one way only', () => {
        saveAccountRules(PAPER_ACCOUNT_KEY, { limits: limits({ dailyLoss: 250 }), highWater: 0 });
        expect(loadAccountRules('paper').limits.dailyLoss).toBe(250);
    });
});

describe('taking over the limits an older version kept globally', () => {
    beforeEach(() => stubStorage());

    it('starts an account off on the figures that used to apply to everything', () => {
        localStorage.setItem('midorii-paper-settings', JSON.stringify({
            balance: 10_000,
            dailyLossLimit: 750,
            maxPositionSize: 4,
            lossStreakLimit: 3,
        }));
        const rules = loadAccountRules('projectx:7').limits;
        expect(rules.dailyLoss).toBe(750);
        expect(rules.maxSize).toBe(4);
        expect(rules.lossStreak).toBe(3);
        // Nothing is inherited that never existed: the floor and the goal start off.
        expect(rules.maxLoss).toBe(0);
        expect(rules.startBalance).toBe(0);
        expect(rules.profitGoal).toBe(0);
    });

    it('stops consulting it the moment that account has rules of its own', () => {
        localStorage.setItem('midorii-paper-settings', JSON.stringify({ dailyLossLimit: 750 }));
        saveAccountRules('projectx:7', { limits: limits({ dailyLoss: 0 }), highWater: 0 });
        // Zero means off, and somebody chose it — the old global figure must not come back.
        expect(loadAccountRules('projectx:7').limits.dailyLoss).toBe(0);
    });

    it('ignores an old record with nothing usable in it', () => {
        localStorage.setItem('midorii-paper-settings', JSON.stringify({ dailyLossLimit: -5 }));
        expect(loadAccountRules('paper').limits.dailyLoss).toBe(0);
    });
});

describe('what a stored record may say', () => {
    it('fills in everything a half-written record is missing', () => {
        expect(normalizeRules({ maxLoss: 2_000 })).toEqual({
            limits: { ...NO_LIMITS, maxLoss: 2_000 },
            highWater: 0,
        });
    });

    it('refuses a mode it has never heard of', () => {
        expect(normalizeRules({ mllMode: 'whatever' }).limits.mllMode).toBe('static');
    });

    it('refuses figures it cannot mean', () => {
        const out = normalizeRules({ maxLoss: -1, dailyLoss: 'lots', lossStreak: 500, highWater: -3 });
        expect(out.limits.maxLoss).toBe(0);
        expect(out.limits.dailyLoss).toBe(0);
        expect(out.limits.lossStreak).toBe(0);
        expect(out.highWater).toBe(0);
    });

    it('only ever closes out on a breach where the record says so in as many words', () => {
        expect(normalizeRules({}).limits.onBreach).toBe('refuse');
        expect(normalizeRules({ onBreach: 'yes' }).limits.onBreach).toBe('refuse');
        expect(normalizeRules({ onBreach: 'flatten' }).limits.onBreach).toBe('flatten');
    });

    it('reads something that is not a set of accounts as no accounts', () => {
        expect(normalizeAccountRules(null)).toEqual({});
        expect(normalizeAccountRules(['projectx:1'])).toEqual({});
    });
});

describe('the mark a rule change leaves behind', () => {
    it('is kept when what it measures has not changed', () => {
        const before = limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' });
        const after = { ...before, maxLoss: 3_000, profitGoal: 3_000 };
        expect(markAfterChange(before, after, 52_500)).toBe(52_500);
    });

    it('goes back to the starting balance when the starting balance moves', () => {
        // A mark measures one configuration; 52,500 says nothing about a 150k account.
        const before = limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' });
        const after = { ...before, startBalance: 150_000 };
        expect(markAfterChange(before, after, 52_500)).toBe(150_000);
    });

    it('goes back when what the floor follows changes', () => {
        const before = limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' });
        const after = { ...before, mllMode: 'intraday' as const };
        expect(markAfterChange(before, after, 52_500)).toBe(50_000);
    });
});

describe('the guard a mount holds', () => {
    beforeEach(() => stubStorage());

    it('writes the mark through as it rises, so a restart keeps the floor', () => {
        saveAccountRules('projectx:9', {
            limits: limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'intraday' }),
            highWater: 0,
        });
        const guard = propGuard('projectx:9');

        const up = guard.read({ equity: 53_000, openPnl: 0, history: [] });
        expect(up.highWater).toBe(53_000);
        expect(up.floor).toBe(51_000);

        // A fresh guard — what a restart is — starts from the mark that was stored.
        expect(propGuard('projectx:9').read({ equity: 50_000, openPnl: 0, history: [] }).floor).toBe(51_000);
    });

    it('never lets a mark fall back', () => {
        const guard = propGuard('projectx:9');
        guard.set({ limits: limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'intraday' }), highWater: 55_000 });
        const read = guard.read({ equity: 50_100, openPnl: 0, history: [] });
        expect(read.highWater).toBe(55_000);
        expect(loadAccountRules('projectx:9').highWater).toBe(55_000);
    });

    it('reconstructs the mark from the closed trades on an end-of-day floor', () => {
        const guard = propGuard('projectx:9');
        guard.set({ limits: limits({ startBalance: 50_000, maxLoss: 2_000, mllMode: 'eod' }), highWater: 0 });
        const history = [
            closed(-1_000, '2026-09-10T22:00:00Z'),
            closed(2_000, '2026-09-09T22:00:00Z'),
        ];
        // The best day closed at 52,000, so the floor is 50,000 — not 49,000 off today.
        expect(guard.read({ equity: 51_000, openPnl: 0, history }).floor).toBe(50_000);
    });

    it('hands back the rules it was given, for the dialog to edit', () => {
        const guard = propGuard('capital:live');
        guard.set({ limits: limits({ dailyLoss: 400 }), highWater: 0 });
        expect(guard.limits().dailyLoss).toBe(400);
        expect(guard.rules()).toEqual({ limits: limits({ dailyLoss: 400 }), highWater: 0 });
    });
});
