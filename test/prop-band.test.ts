// The account's limits, wired to a screen.
//
// The pure arithmetic is proved in risk-limits.test.ts and the store in account-rules.test.ts.
// What is left — and what is worth the most here — is the one thing in this app that sends an
// order nobody pressed: an account set to close out when its floor is past. It must fire once,
// only where it was asked for by name, and never before the venue has said what the account is
// worth.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flattenAll, wireProp } from '../app/renderer/trading/propBand';
import { saveAccountRules } from '../app/renderer/trading/accountRules';
import { NO_LIMITS } from '../app/renderer/trading/riskLimits';
import type { RiskLimits } from '../app/renderer/trading/riskLimits';
import type { HistoryRow } from '../app/renderer/replay/tradeBook';

function stubStorage(): void {
    const cells = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
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

/** A mount, as far as this module can tell one: an account that states figures, and a screen. */
function harness(rules: Partial<RiskLimits>, start = { equity: 50_000, openPnl: 0 }) {
    const account = { ...start, history: [] as HistoryRow[], currency: 'USD' as string | null };
    const flatten = vi.fn();
    const notify = vi.fn();
    saveAccountRules('projectx:1', { limits: limits(rules), highWater: 0 });

    const prop = wireProp({
        account: 'projectx:1',
        name: 'Evaluation 50k',
        host: null as unknown as HTMLElement,   // only the dialog touches it, and nothing opens one here
        currency: () => account.currency,
        equity: () => account.equity,
        openPnl: () => account.openPnl,
        history: () => account.history,
        flatten,
        notify,
        onChange: () => {},
    });
    /** What a repaint does, in the order the mounts do it. */
    const repaint = (): void => {
        prop.read();
        prop.enforce();
    };
    return { account, prop, flatten, notify, repaint };
}

describe('closing out on a breach', () => {
    beforeEach(() => stubStorage());

    it('does nothing at all on an account that only refuses', () => {
        const h = harness({ startBalance: 50_000, maxLoss: 2_000 });   // onBreach defaults to refuse
        h.account.equity = 47_000;
        h.repaint();
        expect(h.flatten).not.toHaveBeenCalled();
        // But the order is still refused, which is what that setting means.
        expect(() => h.prop.guard({ net: 0, side: 'buy', size: 1 })).toThrow(/maximum loss limit/);
    });

    it('closes out once, and not again on the next tick', () => {
        const h = harness({ startBalance: 50_000, maxLoss: 2_000, onBreach: 'flatten' });
        h.account.equity = 47_000;
        h.repaint();
        h.repaint();
        h.repaint();
        expect(h.flatten).toHaveBeenCalledTimes(1);
        expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/maximum loss limit/), 'error');
    });

    it('arms again once the account is back inside its limits', () => {
        const h = harness({ startBalance: 50_000, dailyLoss: 500, onBreach: 'flatten' });
        h.account.openPnl = -600;
        h.repaint();
        expect(h.flatten).toHaveBeenCalledTimes(1);

        // Flat again, next session: nothing is past, so the latch lets go.
        h.account.openPnl = 0;
        h.repaint();
        h.account.openPnl = -600;
        h.repaint();
        expect(h.flatten).toHaveBeenCalledTimes(2);
    });

    it('does not fire before the venue has said what the account is worth', () => {
        /* The state a chart is in the moment it is armed. A zero equity is below every floor,
         * and acting on it would send a market order seconds after arming. */
        const h = harness({ startBalance: 50_000, maxLoss: 2_000, onBreach: 'flatten' }, { equity: 0, openPnl: 0 });
        h.repaint();
        h.repaint();
        expect(h.flatten).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
    });

    it('says so rather than going quiet when the close-out itself refuses', () => {
        const h = harness({ startBalance: 50_000, maxLoss: 2_000, onBreach: 'flatten' });
        h.flatten.mockImplementation(() => { throw new Error('gateway said no'); });
        h.account.equity = 47_000;
        h.repaint();
        expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/gateway said no/), 'error');
        expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/Close the position at the venue/), 'error');
    });
});

describe('the figures the band shows', () => {
    beforeEach(() => stubStorage());

    it('counts the open trade in both rooms', () => {
        const h = harness({ startBalance: 50_000, maxLoss: 2_000, dailyLoss: 800 });
        h.account.history = [closed(-300, new Date().toISOString())];
        h.account.openPnl = -200;
        h.account.equity = 49_500;
        h.prop.read();

        const value = (id: string): string => h.prop.columns.find((c) => c.id === id)!.value();
        expect(value('mll-room')).toBe('1,500.00');    // 49,500 against a floor of 48,000
        expect(value('dll-room')).toBe('300.00');      // 800 less the 500 the day is down
    });

    it('shows a dash for every limit that is not set', () => {
        const h = harness({});
        h.prop.read();
        for (const id of ['mll-room', 'dll-room', 'goal']) {
            expect(h.prop.columns.find((c) => c.id === id)!.value()).toBe('—');
        }
    });

    it('marks a room that is gone, and only then', () => {
        const h = harness({ startBalance: 50_000, maxLoss: 2_000 });
        h.prop.read();
        const mll = h.prop.columns.find((c) => c.id === 'mll-room')!;
        expect(mll.tone?.()).toBeNull();
        h.account.equity = 48_000;
        h.prop.read();
        expect(mll.tone?.()).toBe('down');
    });

    it('names the account’s money on the labels, since the figure alone is not an amount', () => {
        const h = harness({});
        const label = h.prop.columns.find((c) => c.id === 'mll-room')!.label;
        expect(typeof label === 'function' ? label() : label).toBe('To MLL USD');
    });

    it('takes the currency that only arrives with the venue’s first answer', () => {
        /* A CFD account does not say what it is held in at mount. A label fixed then would go
         * without it for the rest of the session, and a figure without its money is not an
         * amount. */
        const h = harness({});
        h.account.currency = null;
        const label = h.prop.columns.find((c) => c.id === 'dll-room')!.label;
        const read = (): string => (typeof label === 'function' ? label() : label);
        expect(read()).toBe('To DLL');
        h.account.currency = 'EUR';
        expect(read()).toBe('To DLL EUR');
    });

    it('reports the goal as progress, and marks it once it is made', () => {
        const h = harness({ startBalance: 50_000, profitGoal: 3_000 });
        h.account.equity = 51_500;
        h.prop.read();
        const goal = h.prop.columns.find((c) => c.id === 'goal')!;
        expect(goal.value()).toBe('50%');
        expect(goal.tone?.()).toBeNull();

        h.account.equity = 53_000;
        h.prop.read();
        expect(goal.tone?.()).toBe('up');
    });
});

describe('going flat when everything has to come off', () => {
    it('attempts every position even after one has refused, then says what did', () => {
        /* Stopping at the first refusal would leave the rest open on an account that has just
         * been told to go flat. */
        const closeOne = vi.fn((id: number) => {
            if (id === 2) throw new Error('position 2 refused');
        });
        const cancelAll = vi.fn();
        expect(() => flattenAll({
            positions: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
            closeOne,
            cancelAll,
        })).toThrow(/position 2 refused/);

        expect(closeOne).toHaveBeenCalledTimes(3);
        expect(cancelAll).toHaveBeenCalledTimes(1);   // and the working orders still went
    });

    it('says nothing when everything came off', () => {
        expect(() => flattenAll({
            positions: () => [{ id: 1 }],
            closeOne: () => {},
            cancelAll: () => {},
        })).not.toThrow();
    });

    it('is content with an account that has no working orders to cancel', () => {
        expect(() => flattenAll({ positions: () => [], closeOne: () => {} })).not.toThrow();
    });
});
