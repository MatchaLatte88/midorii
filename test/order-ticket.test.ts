// The typed ticket: what it comes to, and when it refuses to be sent.
//
// Every assertion here is about money going out at a price nobody meant — a buy limit resting
// above the market, a stop on the winning side, a size nobody worked out. The panel greys a
// button for each of these, and a greyed button is not a test.
import { describe, it, expect } from 'vitest';
import { emptyTicket, ticketOrder, ticketPlan, ticketRefusal } from '../app/renderer/replay/orderTicket';
import type { TicketAccount, TicketDraft } from '../app/renderer/replay/orderTicket';
import type { RiskSettings } from '../app/renderer/replay/replayOrders';

/** 10,000 in the account, the market at 100. */
const ACCOUNT: TicketAccount = { equity: 10_000, price: 100 };
/** 1% of equity per trade, no leverage — so a stop 5 away buys 20 units. */
const RISK: RiskSettings = { mode: 'percent', value: 1, maxLeverage: 1 };

const ticket = (over: Partial<TicketDraft> = {}): TicketDraft => ({ ...emptyTicket(), ...over });

/** The refusal for one side of a draft, through the plan the panel would be showing. */
const refusal = (draft: TicketDraft, side: 'buy' | 'sell', account = ACCOUNT): string | null =>
    ticketRefusal(draft, side, account, ticketPlan(draft, account, RISK));

describe('what the ticket comes to', () => {
    it('sizes a market order off the market and the stop', () => {
        const plan = ticketPlan(ticket({ stopLoss: 95, takeProfit: 110 }), ACCOUNT, RISK);
        expect(plan.reference).toBe(100);
        expect(plan.size).toBe(20); // 100 of risk over a distance of 5
        expect(plan.notional).toBe(2000);
        expect(plan.risk).toEqual({ cash: 100, share: 0.01 });
        expect(plan.rr).toBe(2);
        expect(plan.capped).toBe(false);
    });

    it('sizes a resting order off its own price, not the market', () => {
        // Entry 90, stop 85: the same distance of 5, but a fill 10 lower.
        const plan = ticketPlan(ticket({ type: 'limit', entryPrice: 90, stopLoss: 85 }), ACCOUNT, RISK);
        expect(plan.reference).toBe(90);
        expect(plan.size).toBe(20);
        expect(plan.notional).toBe(1800);
    });

    it('says when the leverage cap decided the size rather than the risk', () => {
        // A stop 0.1 away asks for 1,000 units; the account can carry 100.
        const plan = ticketPlan(ticket({ stopLoss: 99.9 }), ACCOUNT, RISK);
        expect(plan.size).toBe(100);
        expect(plan.capped).toBe(true);
        // And the trade now loses less than the 1% it was allowed to — visibly so.
        expect(plan.risk!.cash).toBeCloseTo(10, 8);
    });

    it('leaves the risk unstated on a fixed size with no stop', () => {
        const plan = ticketPlan(ticket({ sizing: 'fixed', fixedSize: 2 }), ACCOUNT, RISK);
        expect(plan.size).toBe(2);
        expect(plan.notional).toBe(200);
        // Not zero: a trade with no stop risks an amount nobody has worked out.
        expect(plan.risk).toBeNull();
        expect(plan.rr).toBeNull();
    });

    it('has nothing to say before the session has a price', () => {
        const plan = ticketPlan(ticket({ stopLoss: 95 }), { equity: 10_000, price: 0 }, RISK);
        expect(plan.reference).toBeNull();
        expect(plan.size).toBeNull();
        expect(plan.risk).toBeNull();
    });
});

describe('when the ticket refuses to be sent', () => {
    it('sends a plain market order both ways', () => {
        const draft = ticket({ sizing: 'fixed', fixedSize: 1 });
        expect(refusal(draft, 'buy')).toBeNull();
        expect(refusal(draft, 'sell')).toBeNull();
    });

    it('keeps a limit below the market for a buy and above it for a sell', () => {
        const below = ticket({ type: 'limit', entryPrice: 90, sizing: 'fixed', fixedSize: 1 });
        expect(refusal(below, 'buy')).toBeNull();
        expect(refusal(below, 'sell')).toMatch(/sell limit waits above the market/);

        const above = ticket({ type: 'limit', entryPrice: 110, sizing: 'fixed', fixedSize: 1 });
        expect(refusal(above, 'buy')).toMatch(/buy limit rests below the market/);
        expect(refusal(above, 'sell')).toBeNull();
    });

    it('mirrors that for a stop entry — the breakout side, not the pullback side', () => {
        const above = ticket({ type: 'stop', entryPrice: 110, sizing: 'fixed', fixedSize: 1 });
        expect(refusal(above, 'buy')).toBeNull();
        expect(refusal(above, 'sell')).toMatch(/sell stop rests below the market/);

        const onIt = ticket({ type: 'stop', entryPrice: 100, sizing: 'fixed', fixedSize: 1 });
        expect(refusal(onIt, 'buy')).toMatch(/away from the market/);
    });

    it('asks for a price before it will rest anything', () => {
        expect(refusal(ticket({ type: 'limit', sizing: 'fixed', fixedSize: 1 }), 'buy'))
            .toMatch(/needs a price to wait at/);
    });

    it('refuses a stop on the winning side and a target on the losing one', () => {
        const draft = ticket({ stopLoss: 105, takeProfit: 110 });
        expect(refusal(draft, 'buy')).toBe('A stop belongs on the losing side of the entry.');
        // For a sell the stop is right, but the target is now on the wrong side.
        expect(refusal(draft, 'sell')).toBe('A target belongs on the winning side of the entry.');
    });

    it('will not size against a stop that is not there', () => {
        expect(refusal(ticket(), 'buy')).toMatch(/Risk sizing needs a stop/);
        expect(refusal(ticket({ sizing: 'fixed' }), 'buy')).toMatch(/positive number of units/);
    });

    it('names what blocks both sides before what blocks one of them', () => {
        // A stop on the wrong side for a buy AND no size yet: both sides are refused, and the
        // panel shows one message for the pair — so it has to be the one they share.
        const draft = ticket({ sizing: 'fixed', fixedSize: null, stopLoss: 105 });
        expect(refusal(draft, 'buy')).toMatch(/positive number of units/);
        expect(refusal(draft, 'sell')).toMatch(/positive number of units/);
        // With a size, the direction-specific reason is what is left.
        const sized = { ...draft, fixedSize: 1 };
        expect(refusal(sized, 'buy')).toBe('A stop belongs on the losing side of the entry.');
        expect(refusal(sized, 'sell')).toBeNull();
    });

    it('refuses everything while the session has no price', () => {
        const draft = ticket({ sizing: 'fixed', fixedSize: 1 });
        expect(refusal(draft, 'buy', { equity: 10_000, price: 0 })).toMatch(/no price yet/);
    });
});

describe('the order the ticket sends', () => {
    it('carries the levels as a bracket rather than as live orders', () => {
        const spec = ticketOrder(ticket({ stopLoss: 95, takeProfit: 110 }), 'buy', 20);
        expect(spec).toEqual({
            side: 'buy', type: 'market', size: 20,
            bracket: { stopLoss: 95, takeProfit: 110 },
            tag: 'manual',
        });
    });

    it('names the resting price by the type it is', () => {
        expect(ticketOrder(ticket({ type: 'limit', entryPrice: 90, stopLoss: 85 }), 'buy', 20))
            .toMatchObject({ type: 'limit', limitPrice: 90, tag: 'manual-limit' });
        expect(ticketOrder(ticket({ type: 'stop', entryPrice: 110, stopLoss: 105 }), 'buy', 20))
            .toMatchObject({ type: 'stop', stopPrice: 110, tag: 'manual-stop' });
    });

    it('sends no bracket at all when neither level was given', () => {
        const spec = ticketOrder(ticket({ sizing: 'fixed', fixedSize: 1 }), 'sell', 1);
        expect(spec.bracket).toBeNull();
    });

    it('sends one leg where only one was given', () => {
        expect(ticketOrder(ticket({ stopLoss: 95 }), 'buy', 20).bracket).toEqual({ stopLoss: 95 });
        expect(ticketOrder(ticket({ takeProfit: 110 }), 'buy', 20).bracket).toEqual({ takeProfit: 110 });
    });
});
