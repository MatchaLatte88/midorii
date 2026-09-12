// The quick panel: a size, a side, and optionally what the trade may cost.
//
// The arithmetic here decides where a stop lands on a live position, so it is asserted rather
// than clicked: a risk of 50 on 0.5 units is a stop 100 away, and getting that backwards is a
// stop ten times too far out on a trade that is already on.
import { describe, it, expect } from 'vitest';
import { emptyQuick, quickOrder, quickPlan, sizeStep, stepSize } from '../app/renderer/replay/quickTrade';
import type { QuickDraft } from '../app/renderer/replay/quickTrade';

const PRICE = 90_000;
const quick = (over: Partial<QuickDraft> = {}): QuickDraft => ({ ...emptyQuick(), ...over });

describe('what the quick panel would send', () => {
    it('turns a risk into a stop distance at the size being sent', () => {
        const plan = quickPlan(quick({ size: 0.5, riskCash: 50 }), PRICE);
        expect(plan.size).toBe(0.5);
        expect(plan.stopDistance).toBe(100); // 50 over 0.5 units
        expect(plan.targetDistance).toBeNull();
        expect(plan.notional).toBe(45_000);
        expect(plan.refusal).toBeNull();
    });

    it('measures the target off the stop, in stops', () => {
        const plan = quickPlan(quick({ size: 0.5, riskCash: 50, rrr: 2.5 }), PRICE);
        expect(plan.stopDistance).toBe(100);
        expect(plan.targetDistance).toBe(250);
    });

    it('sends nothing at all when no risk was given', () => {
        const plan = quickPlan(quick({ size: 1 }), PRICE);
        expect(plan.refusal).toBeNull();
        expect(plan.stopDistance).toBeNull();
        // An unprotected market order is a real choice, so it is allowed through.
        expect(quickOrder(quick({ size: 1 }), 'buy', plan).bracket).toBeNull();
    });

    it('carries the protection as distances, not as prices', () => {
        const draft = quick({ size: 0.5, riskCash: 50, rrr: 2 });
        const spec = quickOrder(draft, 'sell', quickPlan(draft, PRICE));
        expect(spec).toEqual({
            side: 'sell', type: 'market', size: 0.5,
            // Attached at the fill, so the risk is 50 whatever the fill turns out to be —
            // which is why it is not `stopLoss: 90100`.
            bracket: { stopDistance: 100, targetDistance: 200 },
            tag: 'manual',
        });
    });

    it('handles a size finer than a hundredth of a unit', () => {
        const plan = quickPlan(quick({ size: 0.0000001, riskCash: 9 }), PRICE);
        expect(plan.size).toBe(0.0000001);
        expect(plan.stopDistance).toBeCloseTo(90_000_000, 0);
        // ...which is wider than the price, and therefore not a stop at all.
        expect(plan.refusal).toMatch(/wider than the price/);
    });
});

describe('what a venue is sent instead', () => {
    // Capital.com, Bybit and Binance all read two prices and nothing else. A distance handed
    // to one of them is protection dropped on the way out — silently, on an order that has
    // already gone — so the panel works the levels out before the order leaves.
    it('turns the distances into levels, on the losing side of the entry', () => {
        const draft = quick({ size: 0.5, riskCash: 50, rrr: 2 });
        const plan = quickPlan(draft, PRICE);
        expect(quickOrder(draft, 'buy', plan, { as: 'levels' }).bracket)
            .toEqual({ stopLoss: 89_900, takeProfit: 90_200 });
        expect(quickOrder(draft, 'sell', plan, { as: 'levels' }).bracket)
            .toEqual({ stopLoss: 90_100, takeProfit: 89_800 });
    });

    it('puts a computed level on the instrument\'s own grid', () => {
        const draft = quick({ size: 0.3, riskCash: 50 });
        const spec = quickOrder(draft, 'buy', quickPlan(draft, PRICE), { as: 'levels', tick: 0.5 });
        // 50 over 0.3 units is 166.666…, which is not a price any venue would take.
        expect(spec.bracket).toEqual({ stopLoss: 89_833.5 });
    });

    it('still sends an unprotected order bare', () => {
        const draft = quick({ size: 1 });
        expect(quickOrder(draft, 'buy', quickPlan(draft, PRICE), { as: 'levels' }).bracket).toBeNull();
    });

    it('refuses to fall back to distances when there is no price to measure from', () => {
        const draft = quick({ size: 1, riskCash: 50 });
        // Unreachable through the panel — quickPlan already refuses — and loud rather than
        // quiet, because the quiet version is an unprotected live order.
        expect(() => quickOrder(draft, 'buy', quickPlan(draft, 0), { as: 'levels' }))
            .toThrow(/needs a price/);
    });
});

describe('when the quick panel refuses', () => {
    it('asks for a size before anything else', () => {
        expect(quickPlan(quick(), PRICE).refusal).toBe('Type a size first.');
        expect(quickPlan(quick({ size: 0 }), PRICE).refusal).toBe('Type a size first.');
    });

    it('will not take a reward:risk with no risk to measure it against', () => {
        expect(quickPlan(quick({ size: 1, rrr: 2 }), PRICE).refusal).toMatch(/needs a risk to measure against/);
    });

    it('refuses figures that are not positive', () => {
        expect(quickPlan(quick({ size: 1, riskCash: -5 }), PRICE).refusal).toMatch(/positive amount/);
        expect(quickPlan(quick({ size: 1, riskCash: 5, rrr: 0 }), PRICE).refusal).toMatch(/positive multiple/);
    });

    it('refuses before the session has a price', () => {
        expect(quickPlan(quick({ size: 1 }), 0).refusal).toMatch(/no price yet/);
    });
});

describe('stepping the size', () => {
    it('steps at the precision already typed', () => {
        expect(sizeStep('1')).toBe(1);
        expect(sizeStep('0.25')).toBe(0.01);
        expect(sizeStep('0.0000001')).toBe(1e-7);
        // Nothing typed yet: a whole unit, so the first press gives a round number.
        expect(sizeStep('')).toBe(1);
    });

    it('adds and subtracts one of those steps', () => {
        expect(stepSize('1', 1)).toBe('2');
        expect(stepSize('0.25', 1)).toBe('0.26');
        expect(stepSize('0.0000001', 1)).toBe('0.0000002');
        expect(stepSize('', 1)).toBe('1');
    });

    it('leaves no binary-float dust behind', () => {
        // 0.1 + 0.1 is 0.30000000000000004 two presses later without the rounding.
        expect(stepSize(stepSize('0.1', 1), 1)).toBe('0.3');
    });

    it('empties rather than going to zero or below', () => {
        expect(stepSize('1', -1)).toBe('');
        expect(stepSize('', -1)).toBe('');
        expect(stepSize('0.01', -1)).toBe('');
    });
});

/**
 * The same panel on an instrument whose point is not a unit of account money.
 *
 * This one decides where a stop LANDS on a trade that is about to be on, so getting the
 * multiplier wrong is not a display error: on one NQ contract, reading "$100 of risk" as a
 * hundred points puts the stop twenty times too far out and the trade risks $2,000.
 */
describe('the quick panel on a contract that multiplies', () => {
    const NQ = 20; // a quarter-point tick worth $5 is $20 a point

    it('divides the risk by what the size is worth, not by the size', () => {
        const plan = quickPlan(quick({ size: 1, riskCash: 100 }), 24_000, NQ);
        expect(plan.stopDistance).toBe(5); // $100 over $20 a point
    });

    it('measures the target off that distance, so the reward is in the same money', () => {
        const plan = quickPlan(quick({ size: 1, riskCash: 100, rrr: 2 }), 24_000, NQ);
        expect(plan.stopDistance).toBe(5);
        expect(plan.targetDistance).toBe(10);
    });

    it('states the notional a contract carries rather than its price', () => {
        expect(quickPlan(quick({ size: 2 }), 24_000, NQ).notional).toBe(960_000);
    });

    it('is unchanged where a point is a unit — every spot account here', () => {
        const spot = quickPlan(quick({ size: 0.5, riskCash: 50 }), PRICE);
        expect(spot).toEqual(quickPlan(quick({ size: 0.5, riskCash: 50 }), PRICE, 1));
    });
});
