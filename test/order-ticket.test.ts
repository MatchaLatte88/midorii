// The typed ticket: what it comes to, and when it refuses to be sent.
//
// Every assertion here is about money going out at a price nobody meant — a buy limit resting
// above the market, a stop on the winning side, a size nobody worked out. The panel greys a
// button for each of these, and a greyed button is not a test.
import { describe, it, expect } from 'vitest';
import {
    MAX_QUICK_SIZES, bracketLevels, emptyTicket, normalizeQuickSizes, ticketOrder, ticketPlan, ticketRefusal,
} from '../app/renderer/replay/orderTicket';
import type { BracketSettings, TicketAccount, TicketDraft } from '../app/renderer/replay/orderTicket';
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

describe('a margined account', () => {
    /** The same 10,000 account, but at a venue: 3.33% margin, 3,000 left to trade with. */
    const MARGINED: TicketAccount = { equity: 10_000, price: 100, available: 3_000, marginFactor: 0.0333 };

    it('says what opening the position would tie up', () => {
        const plan = ticketPlan(ticket({ sizing: 'fixed', fixedSize: 10 }), MARGINED, RISK);
        expect(plan.notional).toBe(1_000);
        // 3.33% of the notional, held against it — not the notional itself.
        expect(plan.margin!.required).toBeCloseTo(33.3, 8);
        expect(plan.margin!.available).toBe(3_000);
    });

    it('reports no margin at all on an account that does not have any', () => {
        // Zero would read as "this is free" rather than "this does not apply".
        expect(ticketPlan(ticket({ sizing: 'fixed', fixedSize: 10 }), ACCOUNT, RISK).margin).toBeNull();
    });

    it('holds the size to the money left, not to the leverage setting', () => {
        // Generous leverage, on an account whose margin runs out first.
        const risk: RiskSettings = { mode: 'percent', value: 1, maxLeverage: 30 };
        // A stop 0.1 away would buy 1,000 units on risk alone; 3,000 of margin at 3.33%
        // of 100 a unit funds about 901.
        const plan = ticketPlan(ticket({ stopLoss: 99.9 }), MARGINED, risk);
        const ceiling = 3_000 / (0.0333 * 100);
        expect(plan.size!).toBeLessThanOrEqual(ceiling + 1e-9);
        expect(plan.size!).toBeCloseTo(ceiling, 6);
        expect(plan.capped).toBe(true);
    });

    it('leaves a size the account can fund untouched', () => {
        // A wide stop: 1% of 10,000 over 5 buys 20 units, well inside the margin.
        const plan = ticketPlan(ticket({ stopLoss: 95 }), MARGINED, RISK);
        expect(plan.size).toBe(20);
        expect(plan.capped).toBe(false);
    });

    it('still uses the leverage ceiling when the venue rules are not known', () => {
        // Unknown margin is not "no margin" — but with nothing to compute from, the account's
        // own leverage setting is the only ceiling there is.
        const partial: TicketAccount = { equity: 10_000, price: 100, available: 3_000 };
        const risk: RiskSettings = { mode: 'percent', value: 1, maxLeverage: 1 };
        const plan = ticketPlan(ticket({ stopLoss: 99.9 }), partial, risk);
        expect(plan.margin).toBeNull();
        expect(plan.size).toBe((10_000 * 1) / 100);
    });
});

describe('the levels an auto-bracketed ticket opens with', () => {
    const ON: BracketSettings = { on: true, unit: 'ticks', stop: 40, target: 80 };

    it('puts the stop on the losing side and the target on the winning one', () => {
        // A quarter-point instrument: 40 ticks is 10, 80 is 20.
        const long = bracketLevels(100, 'buy', ON, 0.25);
        expect(long.stopLoss).toBe(90);
        expect(long.takeProfit).toBe(120);

        // The same distances, mirrored — a short is wrong ABOVE where it went in.
        const short = bracketLevels(100, 'sell', ON, 0.25);
        expect(short.stopLoss).toBe(110);
        expect(short.takeProfit).toBe(80);
    });

    it('counts a cash distance in what the market is quoted in', () => {
        // Not ticks: 40 means forty of the price's own units, whatever the increment is.
        const levels = bracketLevels(100, 'buy', { ...ON, unit: 'cash' }, 0.25);
        expect(levels.stopLoss).toBe(60);
        expect(levels.takeProfit).toBe(180);
    });

    it('places nothing in ticks on an instrument whose increment is unknown', () => {
        // The whole point of a tick distance is the instrument's own grid. Without it there
        // is no length to the distance, and a fallback of 1 would be a stop nobody chose.
        expect(bracketLevels(100, 'buy', ON, null)).toEqual({ stopLoss: null, takeProfit: null });
        expect(bracketLevels(100, 'buy', ON, 0)).toEqual({ stopLoss: null, takeProfit: null });
    });

    it('lands a cash distance on the instrument’s own grid', () => {
        // 33.3 off 100 is 66.7, which a half-point instrument cannot quote.
        const levels = bracketLevels(100, 'buy', { on: true, unit: 'cash', stop: 33.3, target: 33.3 }, 0.5);
        expect(levels.stopLoss).toBe(66.5);
        expect(levels.takeProfit).toBe(133.5);
    });

    it('places nothing at all when it is switched off', () => {
        expect(bracketLevels(100, 'buy', { ...ON, on: false }, 0.25)).toEqual({ stopLoss: null, takeProfit: null });
    });

    it('places nothing without a price to measure from', () => {
        // A resting order whose entry has not been typed yet.
        expect(bracketLevels(0, 'buy', ON, 0.25)).toEqual({ stopLoss: null, takeProfit: null });
    });

    it('leaves out the half whose distance is zero', () => {
        // A target of nothing is not a target on top of the entry; it is no target.
        const levels = bracketLevels(100, 'buy', { ...ON, target: 0 }, 0.25);
        expect(levels.stopLoss).toBe(90);
        expect(levels.takeProfit).toBeNull();
    });

    it('refuses a level the distance would put at or below zero', () => {
        // A stop further away than the price itself is not a price.
        const levels = bracketLevels(10, 'buy', { on: true, unit: 'cash', stop: 20, target: 5 }, null);
        expect(levels.stopLoss).toBeNull();
        expect(levels.takeProfit).toBe(15);
    });
});

describe('the sizes offered on the ticket', () => {
    it('sorts and de-duplicates, because the row is read left to right', () => {
        expect(normalizeQuickSizes([10, 3, 1, 3, 5])).toEqual([1, 3, 5, 10]);
    });

    it('reads a typed list, spaces and all', () => {
        expect(normalizeQuickSizes(' 1 , 3 ,5 '.split(','))).toEqual([1, 3, 5]);
    });

    it('drops what is not a size', () => {
        // Zero, negatives and words are not quantities anybody can trade.
        expect(normalizeQuickSizes([1, 0, -2, 'abc', null, 5])).toEqual([1, 5]);
    });

    it('says nothing rather than nothing usable', () => {
        // Null is what leaves the sizes as they were — an empty row could not be got back.
        expect(normalizeQuickSizes([])).toBeNull();
        expect(normalizeQuickSizes(['', 'x', -1])).toBeNull();
    });

    it('stops at a row that can still be aimed at', () => {
        const many = Array.from({ length: MAX_QUICK_SIZES + 5 }, (_, i) => i + 1);
        expect(normalizeQuickSizes(many)).toHaveLength(MAX_QUICK_SIZES);
    });
});
