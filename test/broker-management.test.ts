// Break-even and trailing as the account applies them, rather than the strategy.
//
// Both rules answer a question that is asked INSIDE a bar — is the trade a whole R in
// front, where is the extreme so far — and a strategy only ever sees a bar that has already
// closed. On an hourly chart a break-even evaluated at the close would move the stop an
// hour after the trade earned it, and every one of those hours is a stop that was never
// where it said it was. So they live in the Broker, and are walked step by step with the
// fills. See `_manage` in shared/engine/broker.js.
import { beforeEach, describe, expect, it } from 'vitest';
import { Broker, NO_COSTS, resetOrderIds } from '../shared/engine/broker.js';

beforeEach(() => resetOrderIds());

function bar(time: number, open: number, high: number, low: number, close: number) {
    return { time, open, high, low, close, volume: 1 };
}

/** A long of one unit, entered at market with a bracket — the path every strategy takes. */
function enterLong(broker: Broker, stopLoss: number, takeProfit?: number): void {
    broker.placeOrder({
        side: 'buy',
        type: 'market',
        size: 1,
        bracket: takeProfit == null ? { stopLoss } : { stopLoss, takeProfit },
    });
}

describe('break-even at a multiple of R', () => {
    it('moves the stop to flat once the trade is that far in front', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 1, trailAtR: 0, trailR: 0 },
        });
        enterLong(broker, 97);

        // Fills at this bar's open: entry 100, risk 3 per unit.
        broker.processBar(bar(0, 100, 100, 99.5, 100));
        expect(broker.position!.riskPerUnit).toBe(3);
        expect(broker.position!.stopLoss).toBe(97);

        // 103.5 is 1.17R in front — the rule fires on the extreme, not on the close.
        broker.processBar(bar(60_000, 100, 103.5, 100, 101));
        // No costs, so flat is the entry itself.
        expect(broker.position!.stopLoss).toBeCloseTo(100, 8);

        broker.processBar(bar(120_000, 101, 101, 98, 98));
        expect(broker.positions).toHaveLength(0);
        expect((broker.trades[0] as { netPnl: number }).netPnl).toBeCloseTo(0, 8);
    });

    it('does not fire on a trade that never got there', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 1, trailAtR: 0, trailR: 0 },
        });
        enterLong(broker, 97);
        broker.processBar(bar(0, 100, 100, 99.5, 100));

        // 102.9 is 0.97R — just short, and "nearly" is not a rule.
        broker.processBar(bar(60_000, 100, 102.9, 100, 101));
        expect(broker.position!.stopLoss).toBe(97);
    });

    it('fires once, so a stop that has trailed past flat is never dragged back to it', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 1, trailAtR: 1, trailR: 1 },
        });
        enterLong(broker, 97);
        broker.processBar(bar(0, 100, 100, 99.5, 100));

        broker.processBar(bar(60_000, 100, 106, 100, 105));
        // Break-even put it at 100; the trail then took it to 106 − 3.
        expect(broker.position!.stopLoss).toBeCloseTo(103, 8);
        expect(broker.position!.breakEvenDone).toBe(true);

        broker.processBar(bar(120_000, 105, 108, 104, 107));
        expect(broker.position!.stopLoss).toBeCloseTo(105, 8);
    });

    it('lets the stop it already had take the trade out first', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 1, trailAtR: 0, trailR: 0 },
        });
        enterLong(broker, 97);
        broker.processBar(bar(0, 100, 100, 99.5, 100));

        /* One bar that reaches 104 and 96. Without minutes to order them the pessimistic
         * rule applies and the stop fills — the alternative, letting the high move the stop
         * out of the way of the low, is exactly the look-ahead that makes a break-even rule
         * look free. */
        broker.processBar(bar(60_000, 100, 104, 96, 103));
        expect(broker.positions).toHaveLength(0);
        expect((broker.trades[0] as { netPnl: number }).netPnl).toBeCloseTo(-3, 8);
    });
});

describe('a trailing stop armed in R', () => {
    it('follows the extreme once the trade has proved itself, and never loosens', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 0, trailAtR: 1, trailR: 1 },
        });
        enterLong(broker, 97);
        broker.processBar(bar(0, 100, 100, 99.5, 100));

        // Not yet: 102 is 0.67R.
        broker.processBar(bar(60_000, 100, 102, 100, 101));
        expect(broker.position!.stopLoss).toBe(97);

        // 106 arms it, and the same step's extreme is what it sits behind: 106 − 3.
        broker.processBar(bar(120_000, 101, 106, 101, 105));
        expect(broker.position!.stopLoss).toBeCloseTo(103, 8);

        // A bar that goes nowhere leaves it where it was.
        broker.processBar(bar(180_000, 105, 105.5, 104, 104));
        expect(broker.position!.stopLoss).toBeCloseTo(103, 8);
    });

    it('closes the trade at the trailed stop, not at the one it started with', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 0, trailAtR: 1, trailR: 1 },
        });
        enterLong(broker, 97);
        broker.processBar(bar(0, 100, 100, 99.5, 100));
        broker.processBar(bar(60_000, 100, 106, 100, 105));

        broker.processBar(bar(120_000, 105, 105, 102, 102));
        expect(broker.positions).toHaveLength(0);
        // Out at 103 against an entry of 100 — a point of profit on a trade that risked 3.
        expect((broker.trades[0] as { netPnl: number }).netPnl).toBeCloseTo(3, 8);
    });

    it('is refused a distance of zero rather than putting the stop on the price', () => {
        expect(() => new Broker({ management: { breakEvenAtR: 0, trailAtR: 1, trailR: 0 } }))
            .toThrow(/trailR distance/);
    });

    it('is nothing at all when both rules are zero', () => {
        const broker = new Broker({ management: { breakEvenAtR: 0, trailAtR: 0, trailR: 2 } });
        expect(broker.management).toBeNull();
    });
});

describe('what management does to a position that has no R', () => {
    it('leaves a trade with no stop alone, rather than inventing a unit for it', () => {
        const broker = new Broker({
            balance: 10_000, costs: NO_COSTS, management: { breakEvenAtR: 1, trailAtR: 1, trailR: 1 },
        });
        broker.placeOrder({ side: 'buy', type: 'market', size: 1 });
        broker.processBar(bar(0, 100, 100, 99.5, 100));
        expect(broker.position!.riskPerUnit).toBeNull();

        broker.processBar(bar(60_000, 100, 140, 100, 139));
        expect(broker.position!.stopLoss).toBeNull();
        expect(broker.position!.trailing).toBeNull();
    });
});
