// What a point is worth, and what a market order fills at when there is a real quote.
//
// A futures contract is the case the engine was not written for: one gold contract moving a
// point is a hundred dollars. Every figure that turns a price difference into money has to
// carry that, or a paper account on a future states its results a hundred times too small.
import { beforeEach, describe, expect, it } from 'vitest';
import { Broker, resetOrderIds } from '../shared/engine/broker.js';
import { rMultiple } from '../app/renderer/format';

const NO_COSTS = { feeRate: 0, spreadPct: 0, slippagePct: 0 };

beforeEach(() => resetOrderIds());

function filledLong(broker: Broker, price: number, size = 1): void {
    broker.lastPrice = price;
    broker.fillNow(broker.placeOrder({ side: 'buy', size, type: 'market' }));
}

describe('what a point is worth', () => {
    it('books a closed trade in money: points times contracts times the point value', () => {
        const broker = new Broker({ balance: 50_000, costs: NO_COSTS, pointValue: 100 });
        filledLong(broker, 2_000, 2);
        broker.lastPrice = 2_010;
        expect(broker.unrealizedPnl).toBe(2_000);
        expect(broker.positionPnl(broker.position)).toBe(2_000);
        broker.fillNow(broker.closePosition('manual')!);
        expect(broker.balance).toBe(52_000);
        expect((broker.trades[0] as { netPnl: number; pointValue: number }).netPnl).toBe(2_000);
    });

    it('charges fees on the notional in money, and states the exit and break-even in the same unit', () => {
        const broker = new Broker({ balance: 50_000, costs: { feeRate: 0.0001, spreadPct: 0, slippagePct: 0 }, pointValue: 100 });
        filledLong(broker, 2_000);
        // 1 contract × 2,000 × $100 = $200,000 notional → $20 fee.
        expect(broker.balance).toBeCloseTo(49_980);
        const position = broker.position!;
        const flat = broker.breakEvenPrice(position)!;
        expect(broker.exitResult(position, flat)).toBeCloseTo(0, 6);
        expect(broker.exitResult(position, 2_010)).toBeCloseTo(1_000 - 20 - 2_010 * 100 * 0.0001, 6);
    });

    it('stays at one unless told otherwise, and survives a snapshot', () => {
        expect(new Broker().pointValue).toBe(1);
        const broker = new Broker({ pointValue: 20 });
        expect(Broker.restore(broker.snapshot()).pointValue).toBe(20);
        // A record stored before a point had a value meant one.
        const old = broker.snapshot() as Record<string, unknown>;
        delete old.pointValue;
        expect(Broker.restore(old).pointValue).toBe(1);
    });

    it('refuses to change while something is open', () => {
        const broker = new Broker({ costs: NO_COSTS });
        filledLong(broker, 100);
        expect(() => broker.setPointValue(50)).toThrow(/cannot change/);
        broker.fillNow(broker.closePosition('manual')!);
        broker.setPointValue(50);
        expect(broker.pointValue).toBe(50);
        expect(() => broker.setPointValue(0)).toThrow(/positive/);
    });

    it('measures R against the risk in money', () => {
        expect(rMultiple({ netPnl: 2_000, size: 2, riskPerUnit: 5, pointValue: 100 })).toBe(2);
        expect(rMultiple({ netPnl: 10, size: 2, riskPerUnit: 5 })).toBe(1);
    });
});

describe('a market order against a real quote', () => {
    it('buys at the ask and sells at the bid, with no simulated spread on top', () => {
        const broker = new Broker({ costs: { feeRate: 0, spreadPct: 0.01, slippagePct: 0 } });
        broker.lastPrice = 100;
        broker.setQuote(99.5, 100.5);
        const buy = broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' })) as unknown as { fillPrice: number };
        expect(buy.fillPrice).toBe(100.5);
        const sell = broker.fillNow(broker.closePosition('manual')!) as unknown as { fillPrice: number };
        expect(sell.fillPrice).toBe(99.5);
    });

    it('still pays slippage, and falls back to the last price plus spread once the quote is cleared', () => {
        const broker = new Broker({ costs: { feeRate: 0, spreadPct: 0.02, slippagePct: 0.001 } });
        broker.lastPrice = 100;
        broker.setQuote(99, 101);
        const quoted = broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' })) as unknown as { fillPrice: number };
        expect(quoted.fillPrice).toBeCloseTo(101 * 1.001);
        broker.setQuote(null, null);
        const plain = broker.fillNow(broker.placeOrder({ side: 'buy', size: 1, type: 'market' })) as unknown as { fillPrice: number };
        expect(plain.fillPrice).toBeCloseTo(100 * (1 + 0.01 + 0.001));
    });

    it('refuses a crossed or empty quote', () => {
        const broker = new Broker();
        expect(() => broker.setQuote(101, 100)).toThrow(/bid <= ask/);
        expect(() => broker.setQuote(0, 100)).toThrow(/bid <= ask/);
    });
});
