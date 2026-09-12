// The ladder: which order a press sends, and where things of yours land.
//
// The rules under the DOM are the ones worth asserting — a press below the market that sends a
// stop instead of a limit is an order filling instantly at a price nobody meant. The painting
// itself is proven in the browser; the suite runs in the node env like the rest.
import { describe, it, expect } from 'vitest';
import { ladderAnchor, ladderOrder, ladderRows } from '../app/renderer/replay/priceLadder';
import type { LadderOrder, LadderPosition } from '../app/renderer/replay/priceLadder';

const TICK = 0.25;

describe('which order a press on the ladder sends', () => {
    const market = 24_000;

    it('buys below the market with a limit — a pullback', () => {
        expect(ladderOrder('buy', 23_990, market, 2)).toMatchObject({
            side: 'buy', type: 'limit', size: 2, limitPrice: 23_990,
        });
    });

    it('buys above the market with a stop — a breakout', () => {
        expect(ladderOrder('buy', 24_010, market, 1)).toMatchObject({ type: 'stop', stopPrice: 24_010 });
    });

    it('sells above the market with a limit, and below it with a stop', () => {
        expect(ladderOrder('sell', 24_010, market, 1)).toMatchObject({ type: 'limit', limitPrice: 24_010 });
        expect(ladderOrder('sell', 23_990, market, 1)).toMatchObject({ type: 'stop', stopPrice: 23_990 });
    });

    it('tags it the way the ticket tags the same kind of order', () => {
        // One vocabulary in the run library, whichever hand placed the trade.
        expect(ladderOrder('buy', 23_990, market, 1)?.tag).toBe('manual-limit');
        expect(ladderOrder('buy', 24_010, market, 1)?.tag).toBe('manual-stop');
    });
});

describe('what the rows are', () => {
    const rows = (over: {
        positions?: LadderPosition[];
        orders?: LadderOrder[];
        quote?: { bid: number; ask: number } | null;
        count?: number;
    } = {}) => ladderRows({
        centre: 24_000,
        tick: TICK,
        count: over.count ?? 5,
        price: 24_000,
        quote: over.quote ?? null,
        positions: over.positions ?? [],
        orders: over.orders ?? [],
        volumeAt: new Map(),
    });

    it('runs highest first, one tick apart, with the centre in the middle', () => {
        expect(rows().map((r) => r.price)).toEqual([24_000.5, 24_000.25, 24_000, 23_999.75, 23_999.5]);
    });

    it('marks the row the market last traded on', () => {
        expect(rows().filter((r) => r.last).map((r) => r.price)).toEqual([24_000]);
    });

    it('marks the best bid and ask as the two rows they are', () => {
        const out = rows({ quote: { bid: 23_999.75, ask: 24_000.25 } });
        expect(out.find((r) => r.bid)?.price).toBe(23_999.75);
        expect(out.find((r) => r.ask)?.price).toBe(24_000.25);
    });

    it('puts a working order on its own row, on the side it would trade from', () => {
        const out = rows({ orders: [{ id: 7, side: 'buy', price: 23_999.75, size: 3 }] });
        const row = out.find((r) => r.price === 23_999.75)!;
        expect(row.buy).toEqual([{ kind: 'buy', label: '3', cancels: 7 }]);
        expect(row.sell).toEqual([]);
    });

    it('puts a long position on the buy side and its stop on the side that closes it', () => {
        const out = rows({
            positions: [{ size: 2, entryPrice: 24_000, stopLoss: 23_999.5, takeProfit: 24_000.5 }],
        });
        expect(out.find((r) => r.price === 24_000)!.buy).toEqual([{ kind: 'position', label: '2', cancels: null }]);
        expect(out.find((r) => r.price === 23_999.5)!.sell).toEqual([{ kind: 'stop', label: 'SL', cancels: null }]);
        expect(out.find((r) => r.price === 24_000.5)!.sell).toEqual([{ kind: 'target', label: 'TP', cancels: null }]);
        expect(out.find((r) => r.price === 24_000)!.entry).toBe(true);
    });

    it('mirrors that for a short', () => {
        const out = rows({ positions: [{ size: -1, entryPrice: 24_000, stopLoss: 24_000.5, takeProfit: null }] });
        expect(out.find((r) => r.price === 24_000)!.sell[0]!.kind).toBe('position');
        expect(out.find((r) => r.price === 24_000.5)!.buy[0]!.kind).toBe('stop');
    });

    it('snaps anything off the grid onto the row that exists', () => {
        // A level worked out from a risk lands between two tradable prices most of the time.
        const out = rows({ orders: [{ id: 7, side: 'buy', price: 23_999.7301, size: 1 }] });
        expect(out.find((r) => r.price === 23_999.75)!.buy).toHaveLength(1);
    });

    it('says how much of the peak each row traded, so the bars are comparable', () => {
        const out = ladderRows({
            centre: 24_000, tick: TICK, count: 3, price: 24_000, quote: null,
            positions: [], orders: [],
            volumeAt: new Map([[24_000, 50], [23_999.75, 200]]),
        });
        expect(out.map((r) => r.volumeShare)).toEqual([0, 0.25, 1]);
    });
});

describe('when the ladder follows the market and when it holds still', () => {
    it('follows while the market is near the middle', () => {
        expect(ladderAnchor({ centre: 24_000, market: 24_000.5, tick: TICK, adrift: false, drift: 12 }))
            .toEqual({ centre: 24_000.5, adrift: false });
    });

    it('lets go once the market has run past the band', () => {
        const out = ladderAnchor({ centre: 24_000, market: 24_010, tick: TICK, adrift: false, drift: 12 });
        expect(out.adrift).toBe(true);
        expect(out.centre).toBe(24_000); // held where it was, so a reader is not dragged along
    });

    it('takes hold again when the market comes back to the middle', () => {
        expect(ladderAnchor({ centre: 24_000, market: 24_000.25, tick: TICK, adrift: true, drift: 12 }))
            .toEqual({ centre: 24_000.25, adrift: false });
    });
});

describe('a ladder with nothing to stand on', () => {
    it('draws no rows without an increment', () => {
        expect(ladderRows({
            centre: 0, tick: 0, count: 5, price: 24_000, quote: null,
            positions: [], orders: [], volumeAt: new Map(),
        })).toEqual([]);
    });

    it('does not offer a press at the market itself — there is no order to rest there', () => {
        expect(ladderOrder('buy', 24_000, 24_000, 1)).toBeNull();
    });
});
