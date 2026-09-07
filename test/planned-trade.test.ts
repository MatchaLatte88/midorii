// Turning a drawn block into an order spec — specifically what becomes of the drawn stop and
// target when the fill is NOT the drawn entry.
//
// A pending order rests at the entry that was drawn, so the two readings coincide there and
// there is nothing to choose. A market order fills at whatever the market is now, and then the
// drawn levels mean one of two different things: the prices themselves (drawn against
// structure, which does not move because the fill did) or the distances between them (the
// shape of the plan, carried to wherever it fills).
import { describe, it, expect } from 'vitest';
import { orderFromPlan, sizingEntry, sizingStop } from '../shared/engine/plannedTrade.js';

/** A long: entry 100, risk 5, reward 10. */
const LONG = { entry: 100, stop: 95, target: 110 };
/** The mirror image, so nothing below can pass by assuming one direction. */
const SHORT = { entry: 100, stop: 105, target: 90 };

describe('orderFromPlan bracket readings', () => {
    it('defaults a market order to the levels as drawn', () => {
        const spec = orderFromPlan(LONG, { price: 101, mode: 'market' });
        expect(spec).toMatchObject({ side: 'buy', type: 'market', price: null });
        expect(spec.bracket).toEqual({ stopLoss: 95, takeProfit: 110 });
    });

    it('carries the distances instead when asked to', () => {
        const spec = orderFromPlan(LONG, { price: 101, mode: 'market', bracket: 'distance' });
        // 5 and 10 as drawn — the fill they attach to is the broker's business, not this file's.
        expect(spec.bracket).toEqual({ stopDistance: 5, targetDistance: 10 });
    });

    it('leaves a pending order on the drawn levels either way', () => {
        for (const bracket of ['levels', 'distance'] as const) {
            const spec = orderFromPlan(LONG, { price: 101, mode: 'pending', bracket });
            // Entry 100 with the market at 101: buying below is a limit.
            expect(spec).toMatchObject({ type: 'limit', price: 100 });
            expect(spec.bracket).toEqual({ stopLoss: 95, takeProfit: 110 });
        }
    });

    it('refuses drawn levels the market has already passed', () => {
        // Long, but the market is below the drawn stop: filling here is instantly out.
        expect(() => orderFromPlan(LONG, { price: 94, mode: 'market' })).toThrow(/already passed .*stop/);
        // Long, market already past the target: nothing left of the plan to fill for.
        expect(() => orderFromPlan(LONG, { price: 111, mode: 'market' })).toThrow(/already passed .*target/);
        // Same block, read as distances, is fine at either price — the shape still applies.
        expect(orderFromPlan(LONG, { price: 94, mode: 'market', bracket: 'distance' }).bracket)
            .toEqual({ stopDistance: 5, targetDistance: 10 });
    });

    it('mirrors all of it for a short', () => {
        expect(orderFromPlan(SHORT, { price: 99, mode: 'market' }).bracket)
            .toEqual({ stopLoss: 105, takeProfit: 90 });
        expect(() => orderFromPlan(SHORT, { price: 106, mode: 'market' })).toThrow(/already passed .*stop/);
        expect(() => orderFromPlan(SHORT, { price: 89, mode: 'market' })).toThrow(/already passed .*target/);
    });

    it('names an unknown bracket reading rather than picking one', () => {
        // @ts-expect-error — the point of the check is the value TypeScript would have refused.
        expect(() => orderFromPlan(LONG, { price: 101, mode: 'market', bracket: 'pips' })).toThrow(/unknown bracket/);
    });

    it('sizes against the same stop under both readings', () => {
        const price = 101;
        for (const bracket of ['levels', 'distance'] as const) {
            const spec = orderFromPlan(LONG, { price, mode: 'market', bracket });
            const entry = sizingEntry(spec, price);
            expect(entry).toBe(price); // a market order fills at the market, not at the drawn entry
            // Levels: the drawn 95. Distances: 101 − 5 = 96. Both are the stop that order will
            // actually carry, which is the one a size has to be worked out against.
            expect(sizingStop(spec, entry)).toBe(bracket === 'levels' ? 95 : 96);
        }
    });
});
