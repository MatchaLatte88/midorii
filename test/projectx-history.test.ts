// Executions into trades.
//
// ProjectX reports half-turns: a fill, a side, and a result that is null on the way in and a
// number on the way out. What a person reads is the round trip, so the two are paired — and
// every assertion here is about a figure somebody would check against their broker statement.
import { describe, it, expect } from 'vitest';
import { projectxHistory } from '../app/renderer/trading/projectxHistory';
import type { MidoriProjectXTrade } from '../app/renderer/midori';

const CONTRACT = 'CON.F.US.ENQ.U26';

let nextId = 1;
/** One execution. `side` 0 buys, 1 sells — the gateway's own pair. */
const fill = (over: Partial<MidoriProjectXTrade> = {}): MidoriProjectXTrade => ({
    id: nextId++,
    accountId: 42,
    contractId: CONTRACT,
    creationTimestamp: '2026-09-11T12:00:00+00:00',
    price: 24_000,
    profitAndLoss: null,
    fees: 1.4,
    side: 0,
    size: 1,
    voided: false,
    orderId: 100,
    ...over,
});

describe('pairing half-turns into trades', () => {
    it('makes one long out of a buy and the sell that closed it', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            side: 'long',
            size: 1,
            entryPrice: 24_000,
            exitPrice: 24_010,
            // The venue's own realised figure, less the commission on both halves.
            netPnl: 200 - 2.8,
            fees: 2.8,
        });
    });

    it('makes a short out of a sell and the buy that closed it', () => {
        const rows = projectxHistory([
            fill({ side: 1, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 0, price: 23_990, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows[0]).toMatchObject({ side: 'short', entryPrice: 24_000, exitPrice: 23_990 });
    });

    it('takes the result from the venue rather than from the two prices', () => {
        /* The whole reason it is read rather than computed: ten points on one NQ is $200, and
         * nothing in an execution says what a point is worth. A price difference would say 10. */
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, fees: 0, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 1, price: 24_010, profitAndLoss: 200, fees: 0, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows[0]!.netPnl).toBe(200);
    });

    it('averages the entry over the fills that built the position', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, size: 1, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 0, price: 24_020, size: 1, creationTimestamp: '2026-09-11T12:01:00+00:00' }),
            fill({ side: 1, price: 24_030, size: 2, profitAndLoss: 400, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ size: 2, entryPrice: 24_010, openedAt: Date.parse('2026-09-11T12:00:00+00:00') });
    });

    it('closes only what a partial exit covered, and leaves the rest open', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, size: 2, fees: 2, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 1, price: 24_010, size: 1, profitAndLoss: 200, fees: 1, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows).toHaveLength(1);
        // Half the entry commission belongs to the half that is still on.
        expect(rows[0]).toMatchObject({ size: 1, fees: 2, netPnl: 198 });
    });

    it('ends one trade and starts another when a fill reverses the position', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, size: 1, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            // Selling two from long one: one closes, one opens a short.
            fill({ side: 1, price: 24_010, size: 2, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
            fill({ side: 0, price: 24_005, size: 1, profitAndLoss: 100, creationTimestamp: '2026-09-11T12:09:00+00:00' }),
        ]);
        expect(rows.map((r) => r.side)).toEqual(['short', 'long']); // newest first
        expect(rows[0]).toMatchObject({ entryPrice: 24_010, exitPrice: 24_005 });
    });

    it('reads oldest first however the gateway ordered them', () => {
        const open = fill({ side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' });
        const close = fill({ side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' });
        // The gateway answers newest first; the walk only makes sense the other way round.
        expect(projectxHistory([close, open])).toEqual(projectxHistory([open, close]));
    });

    it('drops a voided execution rather than folding it into an average', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 0, price: 30_000, voided: true, creationTimestamp: '2026-09-11T12:01:00+00:00' }),
            fill({ side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows[0]).toMatchObject({ size: 1, entryPrice: 24_000 });
    });

    it('reports nothing for a position that is still open', () => {
        expect(projectxHistory([fill({ side: 0 })])).toEqual([]);
    });

    it('keeps contracts apart', () => {
        const rows = projectxHistory([
            fill({ side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ contractId: 'CON.F.US.ES.U26', side: 0, price: 5_000, creationTimestamp: '2026-09-11T12:01:00+00:00' }),
            fill({ side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        // Only the NQ round trip closed; the ES buy is still open and is not paired with it.
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ entryPrice: 24_000 });
    });

    it('leaves R and the exit reason null — the venue records neither', () => {
        const rows = projectxHistory([
            fill({ side: 0, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
            fill({ side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
        ]);
        expect(rows[0]!.r).toBeNull();
        expect(rows[0]!.exitTag).toBeNull();
    });
});
