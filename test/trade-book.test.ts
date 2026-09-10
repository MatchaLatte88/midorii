import { describe, it, expect } from 'vitest';
import { tradeBook, venueBook, type BookOrder, type BookPosition, type BookSource } from '../app/renderer/replay/tradeBook';

const HOUR = 3_600_000;

function position(over: Partial<BookPosition> = {}): BookPosition {
    return {
        id: 1,
        size: 0.2,
        entryPrice: 78_400,
        openedAt: HOUR,
        stopLoss: 77_900,
        takeProfit: 79_900,
        trailing: null,
        riskPerUnit: 500,
        entryTag: 'fvg',
        ...over,
    };
}

function order(over: Partial<BookOrder> = {}): BookOrder {
    return {
        id: 7,
        side: 'buy',
        type: 'limit',
        size: 0.1,
        limitPrice: 77_000,
        stopPrice: null,
        reduceOnly: false,
        tag: null,
        ...over,
    };
}

/** A Broker stand-in: only what a book reads, with the parts that carry meaning behaving. */
function broker(over: Partial<BookSource> = {}): BookSource {
    return {
        positions: [],
        pending: [],
        positionPnl: () => 0,
        exitResult: () => 0,
        breakEvenRefusal: () => null,
        ...over,
    };
}

describe('replay trade book — positions', () => {
    it('turns a position into a row a person can read', () => {
        const book = tradeBook(broker({
            positions: [position()],
            positionPnl: () => 288,
            exitResult: () => -100,
        }));
        expect(book.positions).toHaveLength(1);
        expect(book.positions[0]).toMatchObject({
            id: 1,
            side: 'long',
            size: 0.2,
            entryPrice: 78_400,
            stopLoss: 77_900,
            takeProfit: 79_900,
            trailing: false,
            unrealized: 288,
            stopResult: -100,
            breakEvenRefusal: null,
        });
    });

    it('reads a short as a short, with its size unsigned', () => {
        // The side carries the direction; a size of −0.15 in a column of numbers reads as a loss.
        const [row] = tradeBook(broker({ positions: [position({ size: -0.15 })] })).positions;
        expect(row).toMatchObject({ side: 'short', size: 0.15 });
    });

    it('measures the open result in R against what the position first risked', () => {
        // 500 a unit over 0.2 units = 100 at risk; 288 open is 2.88R.
        const [row] = tradeBook(broker({ positions: [position()], positionPnl: () => 288 })).positions;
        expect(row!.r).toBeCloseTo(2.88, 10);
    });

    it('has no R for a position that never carried a stop', () => {
        const [row] = tradeBook(broker({
            positions: [position({ stopLoss: null, riskPerUnit: null })],
            positionPnl: () => 50,
        })).positions;
        expect(row!.r).toBeNull();
        // And no stop result either — that is not a risk of zero.
        expect(row!.stopResult).toBeNull();
    });

    it('lets a stop past break-even report a gain rather than a cost', () => {
        const [row] = tradeBook(broker({ positions: [position()], exitResult: () => 120 })).positions;
        expect(row!.stopResult).toBe(120);
    });

    it('carries the engine\'s reason for refusing break-even, so a button can say it', () => {
        const [row] = tradeBook(broker({
            positions: [position()],
            breakEvenRefusal: () => 'The trade has not moved far enough to cover its costs.',
        })).positions;
        expect(row!.breakEvenRefusal).toMatch(/has not moved/);
    });

    it('marks a stop that is following price', () => {
        const [row] = tradeBook(broker({ positions: [position({ trailing: { distance: 200 } })] })).positions;
        expect(row!.trailing).toBe(true);
    });
});

describe('replay trade book — orders', () => {
    it('lists a resting order at the price it waits on', () => {
        const [row] = tradeBook(broker({ pending: [order()] })).orders;
        expect(row).toMatchObject({ id: 7, side: 'buy', type: 'limit', size: 0.1, price: 77_000, tag: null });
    });

    it('takes a stop order\'s trigger as its price', () => {
        const [row] = tradeBook(broker({
            pending: [order({ type: 'stop', limitPrice: null, stopPrice: 80_500 })],
        })).orders;
        expect(row!.price).toBe(80_500);
    });

    it('leaves a position\'s own protection out of the order list', () => {
        // A stop and a target are reduce-only legs of the position that already shows them.
        // Listing them again would offer a second way to cancel protection, and the position
        // would go on looking protected afterwards.
        const book = tradeBook(broker({
            positions: [position()],
            pending: [order({ id: 8, reduceOnly: true }), order({ id: 9 })],
        }));
        expect(book.orders.map((o) => o.id)).toEqual([9]);
    });

    it('has nothing to say about an empty account', () => {
        expect(tradeBook(broker())).toEqual({ positions: [], orders: [] });
    });
});

describe('venue trade book', () => {
    const open = {
        id: 3,
        size: -0.4,
        entryPrice: 78_400,
        openedAt: HOUR,
        stopLoss: 78_900,
        takeProfit: 77_400,
    };

    it('reads the side off the signed size and reports the size positive', () => {
        const [row] = venueBook([open], [], () => 0).positions;
        expect(row).toMatchObject({ id: 3, side: 'short', size: 0.4, entryPrice: 78_400 });
    });

    it('takes the open result from the caller rather than computing one', () => {
        // Capital.com states its own; a spot balance has none until somebody computes it.
        const [row] = venueBook([open], [], () => -128.5).positions;
        expect(row!.unrealized).toBe(-128.5);
    });

    it('leaves the three figures a venue cannot answer for null', () => {
        // R and the stop's result both need the risk the trade OPENED with, which a venue
        // does not record; a break-even refusal is an engine's opinion, and there is none.
        const [row] = venueBook([open], [], () => 0).positions;
        expect(row).toMatchObject({ r: null, stopResult: null, breakEvenRefusal: null, trailing: false });
    });

    it('lists a resting order at the price it waits on, under its own kind', () => {
        const [row] = venueBook([], [{ id: 11, side: 'buy', price: 77_000, size: 0.1, kind: 'stop' }], () => 0).orders;
        expect(row).toMatchObject({ id: 11, side: 'buy', type: 'stop', size: 0.1, price: 77_000, tag: null });
    });

    it('has nothing to say about an empty account', () => {
        expect(venueBook([], [], () => 0)).toEqual({ positions: [], orders: [] });
    });
});
