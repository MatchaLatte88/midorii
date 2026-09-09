// The context a strategy is handed over a live feed. The one rule this file exists to hold:
// it must be the SAME context the backtest builds, because the whole value of a bot is that
// what trades is what was tested. Plus the one thing a backtest has no equivalent for — the
// guards gating entries without ever stopping a strategy managing what it already holds.
// See app/renderer/bot/botContext.ts.
import { describe, it, expect, vi } from 'vitest';
import { botContext } from '../app/renderer/bot/botContext';
import type { BotAccount } from '../app/renderer/bot/botAccount';
import type { BacktestBar, RunnableStrategy } from '../shared/engine/backtest';
import type { OrderSpec } from '../shared/engine/broker.js';
import type { StrategyParams } from '../app/renderer/strategies/types';

function bar(time: number, close = 100): BacktestBar {
    return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

const BARS: BacktestBar[] = [bar(0, 100), bar(60_000, 101), bar(120_000, 102), bar(180_000, 103)];

/** An account that records what it was asked and answers whatever the test sets. */
function fakeAccount(over: Partial<BotAccount> = {}): BotAccount & { placed: OrderSpec[]; cancelled: number[]; closed: number } {
    const placed: OrderSpec[] = [];
    const cancelled: number[] = [];
    let closed = 0;
    let nextId = 1;
    const account = {
        placed,
        cancelled,
        get closed() { return closed; },
        equity: () => 10_000,
        balance: () => 9_500,
        price: () => 102,
        quote: () => null,
        positions: () => [],
        pending: () => [],
        order: (spec: OrderSpec) => {
            placed.push(spec);
            const id = nextId;
            nextId += 1;
            return { id };
        },
        cancel: (id: number) => { cancelled.push(id); return true; },
        cancelAll: () => 0,
        close: () => { closed += 1; },
        flatten: () => { closed += 1; },
        ...over,
    };
    return account as BotAccount & { placed: OrderSpec[]; cancelled: number[]; closed: number };
}

function strategy(over: Partial<RunnableStrategy<StrategyParams>> = {}): RunnableStrategy<StrategyParams> {
    return { onBar: () => undefined, ...over };
}

function context(opts: {
    account?: BotAccount;
    strategy?: RunnableStrategy<StrategyParams>;
    index?: number;
    state?: Record<string, unknown>;
    canOpen?: (spec: OrderSpec) => string | null;
    onRefused?: (spec: OrderSpec, reason: string) => void;
    onOrder?: (spec: OrderSpec, id: number) => void;
}) {
    return botContext({
        bars: BARS,
        index: opts.index ?? BARS.length - 1,
        strategy: opts.strategy ?? strategy(),
        account: opts.account ?? fakeAccount(),
        state: opts.state ?? {},
        canOpen: opts.canOpen,
        onRefused: opts.onRefused,
        onOrder: opts.onOrder,
    });
}

describe('the bar the strategy stands on', () => {
    it('is the one it was pointed at, and nothing after it', () => {
        const ctx = context({ index: 1 });
        expect(ctx.index).toBe(1);
        expect(ctx.bar.close).toBe(101);
        expect(ctx.time).toBe(60_000);
    });

    it('hands back history ending at that bar', () => {
        const ctx = context({ index: 2 });
        expect(ctx.history(2).map((b) => b.close)).toEqual([101, 102]);
        // Asking for more than there is gives what there is, never a later bar.
        expect(ctx.history(10).map((b) => b.close)).toEqual([100, 101, 102]);
    });

    it('refuses a history length that is not a positive whole number', () => {
        const ctx = context({});
        expect(() => ctx.history(0)).toThrow(/positive integer/);
        expect(() => ctx.history(1.5)).toThrow(/positive integer/);
    });
});

describe('series', () => {
    it('reads the current bar and counts back from it', () => {
        const ctx = context({
            index: 2,
            strategy: strategy({ series: { atr: [1, 2, 3, 4] } }),
        });
        expect(ctx.value('atr')).toBe(3);
        expect(ctx.value('atr', 2)).toBe(1);
    });

    it('answers null before the series is defined rather than reaching behind the start', () => {
        const ctx = context({ index: 1, strategy: strategy({ series: { atr: [1, 2, 3, 4] } }) });
        expect(ctx.value('atr', 5)).toBeNull();
    });

    it('names what is declared when asked for something that is not', () => {
        const ctx = context({ strategy: strategy({ series: { atr: [1, 2, 3, 4] } }) });
        expect(() => ctx.value('rsi')).toThrow(/Declared: atr/);
    });
});

describe('events', () => {
    const events = {
        setups: [{ index: 1, id: 'a' }, { index: 3, id: 'b' }, { index: 3, id: 'c' }],
    };

    it('hands over only what THIS bar confirmed', () => {
        const ctx = context({ index: 3, strategy: strategy({ events }) });
        expect(ctx.events<{ index: number; id: string }>('setups').map((e) => e.id)).toEqual(['b', 'c']);
    });

    it('is empty on a bar that confirmed nothing', () => {
        const ctx = context({ index: 2, strategy: strategy({ events }) });
        expect(ctx.events('setups')).toEqual([]);
    });

    it('never reaches a later bar', () => {
        // The whole point of the bucketing: standing on bar 1, bar 3's setups do not exist.
        const ctx = context({ index: 1, strategy: strategy({ events }) });
        expect(ctx.events<{ index: number; id: string }>('setups').map((e) => e.id)).toEqual(['a']);
    });

    it('names what is declared when asked for something that is not', () => {
        const ctx = context({ strategy: strategy({ events }) });
        expect(() => ctx.events('gaps')).toThrow(/Declared: setups/);
    });
});

describe('placing an order', () => {
    it('sends it and answers with the id the strategy will cancel by', () => {
        const account = fakeAccount();
        const ctx = context({ account });
        const order = ctx.order({ side: 'buy', type: 'stop', size: 2, stopPrice: 105 });
        expect(account.placed).toHaveLength(1);
        expect(order.id).toBe(1);
        expect(order.status).toBe('pending');
        expect(order.stopPrice).toBe(105);
    });

    it('reports what was placed', () => {
        const onOrder = vi.fn();
        const ctx = context({ onOrder });
        ctx.buy({ size: 1 });
        expect(onOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', type: 'market' }), 1);
    });

    it('leaves the fill fields null — nothing has filled yet', () => {
        const ctx = context({});
        const order = ctx.sell({ size: 1 });
        expect(order.fillPrice).toBeNull();
        expect(order.filledAt).toBeNull();
        expect(order.fee).toBeNull();
    });
});

describe('the guards, at the order gate', () => {
    it('turns an entry away without sending it', () => {
        const account = fakeAccount();
        const onRefused = vi.fn();
        const ctx = context({ account, canOpen: () => 'Outside the trading window.', onRefused });

        const order = ctx.order({ side: 'buy', type: 'stop', size: 2, stopPrice: 105 });

        expect(account.placed).toHaveLength(0);
        expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy' }), 'Outside the trading window.');
        expect(order.status).toBe('cancelled');
    });

    it('gives a gated order an id that can never be a real one', () => {
        const ctx = context({ canOpen: () => 'no' });
        const first = ctx.order({ side: 'buy', size: 1 });
        const second = ctx.order({ side: 'buy', size: 1 });
        // Negative and distinct: an engine's ids count up from 1, so these can never collide.
        expect(first.id).toBeLessThan(0);
        expect(second.id).toBeLessThan(first.id);
    });

    it('does not throw, so the strategy finishes its bar with its state intact', () => {
        // A strategy that stores the order id and stops asking for the session must reach
        // that line. Throwing would abort the bar with `ctx.state` half written.
        const state: Record<string, unknown> = {};
        const ctx = context({ canOpen: () => 'no', state });
        const order = ctx.order({ side: 'buy', size: 1 });
        state.session = { orderId: order.id };
        expect(state.session).toEqual({ orderId: order.id });
    });

    it('never gates a reduce-only order', () => {
        // It can only make a position smaller. Refusing it would be the guards making a
        // position LARGER than the strategy intends.
        const account = fakeAccount();
        const ctx = context({ account, canOpen: () => 'no' });
        ctx.order({ side: 'sell', size: 1, reduceOnly: true });
        expect(account.placed).toHaveLength(1);
    });

    it('never gates a close', () => {
        const account = fakeAccount({ positions: () => [{ id: 1, size: 1, entryPrice: 100 }] });
        const ctx = context({ account, canOpen: () => 'no' });
        ctx.close('session-close');
        expect(account.closed).toBe(1);
    });

    it('never gates a cancel', () => {
        const account = fakeAccount();
        const ctx = context({ account, canOpen: () => 'no' });
        ctx.cancel(7);
        expect(account.cancelled).toEqual([7]);
    });
});

describe('closing', () => {
    it('does nothing when there is nothing open', () => {
        const account = fakeAccount({ positions: () => [] });
        const ctx = context({ account });
        expect(ctx.close()).toBeNull();
        expect(account.closed).toBe(0);
    });
});

describe('the account, as the strategy reads it', () => {
    it('reports what is open, what is waiting and what it is worth', () => {
        const account = fakeAccount({
            positions: () => [{ id: 3, size: -2, entryPrice: 99 }],
            pending: () => [{ id: 4, side: 'buy', size: 1 }],
        });
        const ctx = context({ account });
        expect(ctx.isFlat).toBe(false);
        expect(ctx.position?.id).toBe(3);
        expect(ctx.positions).toHaveLength(1);
        expect(ctx.pendingOrders).toHaveLength(1);
        expect(ctx.equity).toBe(10_000);
        expect(ctx.balance).toBe(9_500);
    });

    it('is flat with nothing open', () => {
        const ctx = context({});
        expect(ctx.isFlat).toBe(true);
        expect(ctx.position).toBeNull();
    });
});

describe('state', () => {
    it('is the object it was handed, so it survives the strategy being rebuilt', () => {
        const state: Record<string, unknown> = { session: { orderId: 4 } };
        const ctx = context({ state });
        expect(ctx.state).toBe(state);
        ctx.state.session = { orderId: 9 };
        expect(state.session).toEqual({ orderId: 9 });
    });
});
