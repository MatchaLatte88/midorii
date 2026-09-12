// The tape: how a burst of prints becomes rows somebody can read.
//
// The folding is the whole of it. A tape that printed 1, 1, 1, 1, 1 down a column is a tape
// nobody reads, and the same five as one 5 is the thing that actually happened.
import { describe, it, expect } from 'vitest';
import { foldPrints, heavyFrom } from '../app/renderer/replay/timeAndSales';
import type { TapePrint, TapeRow } from '../app/renderer/replay/timeAndSales';

let clock = 1_000;
const print = (over: Partial<TapePrint> = {}): TapePrint => ({
    time: (clock += 1_000),
    price: 24_000,
    size: 1,
    side: 'buy',
    ...over,
});

describe('folding a burst of prints', () => {
    it('rolls consecutive prints at the same price and side into one row', () => {
        const rows = foldPrints([], [print({ size: 1 }), print({ size: 1 }), print({ size: 3 })]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ price: 24_000, side: 'buy', size: 5, prints: 3 });
    });

    it('keeps the newest time on a row that is still running', () => {
        const first = print({ size: 1, time: 10_000 });
        const second = print({ size: 1, time: 11_000 });
        expect(foldPrints([], [first, second])[0]!.time).toBe(11_000);
    });

    it('starts a new row when the price moves', () => {
        const rows = foldPrints([], [print({ price: 24_000 }), print({ price: 24_000.25 })]);
        expect(rows.map((r) => r.price)).toEqual([24_000.25, 24_000]);
    });

    it('starts a new row when the aggressor changes, at the same price', () => {
        // Two sides trading at one price is the thing a tape is read for; adding them would
        // hide it behind a single number.
        const rows = foldPrints([], [print({ side: 'buy' }), print({ side: 'sell' })]);
        expect(rows.map((r) => r.side)).toEqual(['sell', 'buy']);
    });

    it('reads the burst oldest first and shows it newest first', () => {
        const rows = foldPrints([], [print({ price: 1, size: 1 }), print({ price: 2, size: 1 }), print({ price: 3, size: 1 })]);
        expect(rows.map((r) => r.price)).toEqual([3, 2, 1]);
    });

    it('folds into what is already showing rather than starting again', () => {
        const first = foldPrints([], [print({ size: 2 })]);
        const second = foldPrints(first, [print({ size: 3 })]);
        expect(second).toHaveLength(1);
        expect(second[0]!.size).toBe(5);
    });

    it('drops a print with nothing in it rather than making a row of it', () => {
        expect(foldPrints([], [print({ size: 0 }), print({ price: 0 })])).toEqual([]);
    });

    it('leaves the rows untouched for an empty burst', () => {
        const rows = foldPrints([], [print()]);
        expect(foldPrints(rows, [])).toBe(rows);
    });

    it('keeps only the newest rows once it is full', () => {
        let rows: TapeRow[] = [];
        for (let i = 0; i < 30; i += 1) rows = foldPrints(rows, [print({ price: 24_000 + i })], 10);
        expect(rows).toHaveLength(10);
        expect(rows[0]!.price).toBe(24_029);
    });
});

describe('which prints stand out', () => {
    const sized = (sizes: number[]): TapeRow[] =>
        sizes.map((size, i) => ({ time: i, price: 24_000 + i, size, side: 'buy', prints: 1 }));

    it('marks nothing until there is enough tape to compare against', () => {
        // A threshold read off four prints would be a threshold about nothing.
        expect(heavyFrom(sized([1, 50, 1, 2]))).toBe(0);
    });

    it('reads the threshold off the tape rather than fixing one', () => {
        /* Twenty lots is a large print on one instrument and noise on another, so the figure
         * comes from what is currently going through. */
        const rows = sized([1, 1, 1, 1, 1, 1, 1, 1, 1, 40]);
        expect(heavyFrom(rows)).toBe(40);
        expect(heavyFrom(sized(Array.from({ length: 20 }, () => 5)))).toBe(5);
    });
});
