// Direct coverage of the Broker's fill mechanics — gaps, siblings, reversals, hedging FIFO,
// and the two fixes this file exists to pin down:
//
//   - the pessimistic fill order used to depend on which order a strategy HAPPENED to place
//     first, because ranking was computed once, before any fill in the step had happened —
//     see `_fillAgainst`'s fixed-point loop.
//   - a bracket attached the instant its entry filled was invisible to the rest of that same
//     step, leaving the trade unprotected for a whole bar (pessimistic) or a whole minute
//     (intrabar) it never needed to be.
//
// `runBacktest`'s own suite covers the loop that drives the Broker; this one drives it
// directly, so a broker bug shows up here without a strategy or a detector in the way.
import { beforeEach, describe, expect, it } from 'vitest';
import { Broker, resetOrderIds } from '../shared/engine/broker.js';

const NO_COSTS = { feeRate: 0, spreadPct: 0, slippagePct: 0 };

beforeEach(() => resetOrderIds());

/** `Broker.fills` is typed `unknown[]` — the internals stay untyped on purpose (see
 *  broker.d.ts). A test reads the shape `_executeOrder` actually produces. */
interface Fill { price: number; fee: number }
function fillsOf(broker: Broker): Fill[] {
    return broker.fills as unknown as Fill[];
}

/** One pessimistic step, in the shape `processBar` hands `_fillAgainst`. */
function step(time: number, open: number, high: number, low: number, close = open): { time: number; open: number; high: number; low: number; close: number } {
    return { time, open, high, low, close };
}

describe('pessimistic fills, ambiguous within one step', () => {
    it('settles a fresh entry and its bracket the same way whichever leg was placed first', () => {
        // Both orderings: a stop placed before its sibling target, and the reverse. Both
        // must land on the stop — the order that hurts the position — never on the placement
        // order, which is what an insertion-order-stable sort used to fall back to while the
        // position these orders act on did not exist yet.
        for (const stopFirst of [true, false]) {
            resetOrderIds();
            const broker = new Broker({ costs: NO_COSTS });
            const entry = broker.placeOrder({ side: 'buy', size: 1, type: 'market' });
            const legs: Array<() => void> = [
                () => broker.placeOrder({
                    side: 'sell', size: 1, type: 'stop', stopPrice: 90,
                    reduceOnly: true, tag: 'stop-loss', parentId: entry.id,
                }),
                () => broker.placeOrder({
                    side: 'sell', size: 1, type: 'limit', limitPrice: 120,
                    reduceOnly: true, tag: 'take-profit', parentId: entry.id,
                }),
            ];
            if (!stopFirst) legs.reverse();
            legs[0]!();
            legs[1]!();

            broker.processBar(step(0, 100, 100, 100, 100)); // entry not yet fillable on its own bar
            broker.processBar(step(1, 100, 130, 80, 120)); // touches both 90 and 120

            expect(broker.trades).toHaveLength(1);
            expect((broker.trades[0] as { exitTag: string }).exitTag).toBe('stop-loss');
        }
    });

    it('protects a bracket entry against the rest of the bar it filled on, not just later bars', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.placeOrder({
            side: 'buy', size: 1, type: 'stop', stopPrice: 105,
            bracket: { stopDistance: 5, targetDistance: 10 },
        });

        broker.processBar(step(0, 100, 100, 100, 100));
        // Triggers the stop-entry at 105, then within the SAME bar falls to 70 — far past
        // where the newly attached stop at 100 sits — before closing at 72.
        broker.processBar(step(1, 100, 106, 70, 72));

        expect(broker.trades).toHaveLength(1);
        const trade = broker.trades[0] as { exitTag: string; exitPrice: number; closedAt: number };
        expect(trade.exitTag).toBe('stop-loss');
        expect(trade.exitPrice).toBeCloseTo(100);
        expect(trade.closedAt).toBe(1); // closed on the entry's own bar, not a bar later
        expect(broker.isFlat).toBe(true);
    });

    it('still executes everything a single unambiguous trigger allows in one step', () => {
        // One order, no ranking question — must not regress into firing nothing.
        const broker = new Broker({ costs: NO_COSTS });
        broker.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
        broker.processBar(step(0, 105, 105, 105, 105));
        broker.processBar(step(1, 102, 103, 99, 101));
        expect(broker.fills).toHaveLength(1);
        expect(broker.position?.size).toBe(1);
    });
});

describe('gaps', () => {
    it('fills a stop at the open when the bar gaps through it, not at the stop price', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.placeOrder({ side: 'sell', size: 1, type: 'stop', stopPrice: 100 });
        broker.processBar(step(0, 110, 110, 110, 110));
        broker.processBar(step(1, 90, 92, 85, 88)); // opens well below the stop
        expect(fillsOf(broker)[0]?.price).toBe(90);
    });

    it('fills a limit at the open when the bar gaps through it, the better side for the order', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
        broker.processBar(step(0, 110, 110, 110, 110));
        broker.processBar(step(1, 90, 95, 88, 92)); // opens below the limit
        expect(fillsOf(broker)[0]?.price).toBe(90);
    });
});

describe('siblings and reversal', () => {
    it('cancels the other bracket leg the instant one fills', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.submitEntry({ side: 'buy', size: 1, stopLoss: 90, takeProfit: 120 });
        broker.processBar(step(0, 100, 100, 100, 100));
        broker.processBar(step(1, 100, 100, 100, 100)); // fills the market entry only
        broker.processBar(step(2, 85, 85, 85, 85)); // touches the stop, not the target

        expect(broker.orders.filter((o) => o.status === 'cancelled')).toHaveLength(1);
        expect(broker.orders.find((o) => o.tag === 'take-profit')?.status).toBe('cancelled');
        expect(broker.pending).toHaveLength(0);
    });

    it('reverses a long straight to a short on one oversized reducing fill', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'sell', size: 3, type: 'market' }));

        expect(broker.trades).toHaveLength(1); // the long's own close
        expect(broker.position?.size).toBe(-2); // the remainder opened a fresh short
        expect(broker.positions).toHaveLength(1);
    });
});

describe('hedging mode', () => {
    it('closes the oldest opposite position first when an order names none', () => {
        const broker = new Broker({ costs: NO_COSTS, mode: 'hedging' });
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));
        broker.lastPrice = 110;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));
        expect(broker.positions).toHaveLength(2);

        broker.lastPrice = 120;
        broker.fillNow(broker.placeOrder({ side: 'sell', size: 1, type: 'market', reduceOnly: true }));

        expect(broker.positions).toHaveLength(1);
        expect(broker.trades).toHaveLength(1);
        expect((broker.trades[0] as { entryPrice: number }).entryPrice).toBe(100); // the older one
    });

    it('keeps two entries apart rather than averaging them into one', () => {
        const broker = new Broker({ costs: NO_COSTS, mode: 'hedging' });
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));
        broker.lastPrice = 110;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));

        expect(broker.positions.map((p) => p.entryPrice)).toEqual([100, 110]);
    });
});

describe('trailing after fills, never before', () => {
    it('only moves the stop with prices this step already gave it the chance to hit', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' }));
        broker.setTrailing(broker.position!, 10);

        // A bar whose low would have taken out a stop trailed to its own high — proves the
        // trail runs after this step's fills settle, not before.
        broker.processBar(step(1, 100, 130, 100, 125));
        expect(broker.position?.stopLoss).toBeCloseTo(120); // 130 - 10, not stopped out
        expect(broker.isFlat).toBe(false);
    });
});

describe('instrument size discipline', () => {
    it('rounds a size down onto the step before it becomes an order', () => {
        const broker = new Broker({ costs: NO_COSTS, sizeStep: 0.01 });
        const order = broker.placeOrder({ side: 'buy', size: 0.129, type: 'market' });
        expect(order.size).toBeCloseTo(0.12);
    });

    it('refuses a size that rounds to nothing, or below the minimum', () => {
        const broker = new Broker({ costs: NO_COSTS, sizeStep: 1, minSize: 2 });
        expect(() => broker.placeOrder({ side: 'buy', size: 0.4, type: 'market' })).toThrow(/rounds down to nothing/);
        expect(() => broker.placeOrder({ side: 'buy', size: 1.4, type: 'market' })).toThrow(/minimum size/);
    });

    it('leaves size untouched when the instrument has no step', () => {
        const broker = new Broker({ costs: NO_COSTS });
        const order = broker.placeOrder({ side: 'buy', size: 0.123456, type: 'market' });
        expect(order.size).toBe(0.123456);
    });
});

describe('limitFillMode', () => {
    it('fills on a touch by default', () => {
        const broker = new Broker({ costs: NO_COSTS });
        broker.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
        broker.processBar(step(0, 105, 105, 105, 105));
        broker.processBar(step(1, 102, 103, 100, 101)); // low touches 100 exactly, no lower
        expect(broker.fills).toHaveLength(1);
    });

    it('refuses a mere touch and waits for the level to be crossed, in "through" mode', () => {
        const broker = new Broker({ costs: NO_COSTS, limitFillMode: 'through' });
        broker.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
        broker.processBar(step(0, 105, 105, 105, 105));
        broker.processBar(step(1, 102, 103, 100, 101)); // touches 100, never trades under it
        expect(broker.fills).toHaveLength(0);
        broker.processBar(step(2, 101, 102, 99.9, 100.2)); // now genuinely trades through
        expect(broker.fills).toHaveLength(1);
    });

    it('still fills a gap straight through the level either way', () => {
        for (const limitFillMode of ['touch', 'through'] as const) {
            resetOrderIds();
            const broker = new Broker({ costs: NO_COSTS, limitFillMode });
            broker.placeOrder({ side: 'buy', size: 1, type: 'limit', limitPrice: 100 });
            broker.processBar(step(0, 105, 105, 105, 105));
            broker.processBar(step(1, 95, 96, 94, 95)); // opens well below the limit
            expect(fillsOf(broker)[0]?.price).toBe(95);
        }
    });

    it('leaves a stop untouched by the mode — a stop triggers on contact by definition', () => {
        const broker = new Broker({ costs: NO_COSTS, limitFillMode: 'through' });
        broker.placeOrder({ side: 'sell', size: 1, type: 'stop', stopPrice: 100 });
        broker.processBar(step(0, 105, 105, 105, 105));
        broker.processBar(step(1, 102, 103, 100, 101)); // low touches 100 exactly
        expect(broker.fills).toHaveLength(1);
    });

    it('refuses an unknown mode', () => {
        expect(() => new Broker({ limitFillMode: 'partial' as never })).toThrow(/touch.*through/);
    });
});

describe('feePerUnit — a flat commission alongside, not instead of, feeRate', () => {
    it('charges both cost models together on a fill', () => {
        const broker = new Broker({
            balance: 10_000,
            costs: { feeRate: 0.0005, feePerUnit: 1.5, spreadPct: 0, slippagePct: 0 },
            pointValue: 20,
        });
        broker.lastPrice = 100;
        broker.fillNow(broker.placeOrder({ side: 'buy', size: 2, type: 'market' }));
        // notional = 2 * 100 * 20 = 4,000 → feeRate share 2; feePerUnit share 2 * 1.5 = 3.
        expect(fillsOf(broker)[0]?.fee).toBeCloseTo(5);
    });

    it('keeps exitResult(breakEvenPrice(position)) at zero with a flat per-unit fee in play', () => {
        for (const side of ['buy', 'sell'] as const) {
            resetOrderIds();
            const broker = new Broker({
                balance: 10_000,
                costs: { feeRate: 0.0005, feePerUnit: 1.5, spreadPct: 0.0002, slippagePct: 0.0002 },
                pointValue: 20,
            });
            broker.lastPrice = 100;
            broker.fillNow(broker.placeOrder({ side, size: 2, type: 'market' }));
            const position = broker.position!;
            const flat = broker.breakEvenPrice(position)!;
            expect(broker.exitResult(position, flat)).toBeCloseTo(0, 6);
        }
    });
});
