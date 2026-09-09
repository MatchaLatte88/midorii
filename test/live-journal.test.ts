// What the trade panel is shown, and what a journal comes to. The file itself is covered in
// live-trade-store.test.mjs; this is the reading of it.
// See app/renderer/trading/liveJournal.ts.
import { describe, it, expect } from 'vitest';
import { journalRows, summarizeJournal } from '../app/renderer/trading/liveJournal';
import type { LiveTradeRecord } from '../app/renderer/trading/CapitalController';

const trade = (over: Partial<LiveTradeRecord> = {}): LiveTradeRecord => ({
    id: 'deal-1', symbol: 'EURUSD', side: 'long', size: 1000,
    entryPrice: 1.09, exitPrice: 1.095, openedAt: 1_000, closedAt: 2_000,
    netPnl: 5, fees: 0, estimated: false, live: true, exitTag: 'manual', currency: 'EUR', ...over,
});

describe('what the panel is shown', () => {
    it('carries the figures straight through', () => {
        const [row] = journalRows([trade()]);
        expect(row).toMatchObject({ side: 'long', size: 1000, entryPrice: 1.09, exitPrice: 1.095, netPnl: 5 });
    });

    it('states no R at all, rather than a computed stand-in', () => {
        // R is measured against what a trade risked when it OPENED, and a venue records no
        // such thing. A stand-in would quietly rescale every comparison against a backtest.
        expect(journalRows([trade()])[0]!.r).toBeNull();
    });

    it('says when an exit was reconstructed rather than read', () => {
        expect(journalRows([trade({ estimated: true, exitTag: null })])[0]!.exitTag).toBe('estimated');
        expect(journalRows([trade({ estimated: false, exitTag: 'manual' })])[0]!.exitTag).toBe('manual');
    });
});

describe('summarizeJournal', () => {
    it('counts what was made and how much of it is certain', () => {
        const summary = summarizeJournal([
            trade({ id: 'a', netPnl: 10 }),
            trade({ id: 'b', netPnl: -4 }),
            trade({ id: 'c', netPnl: 7, estimated: true }),
        ]);
        expect(summary).toEqual({ trades: 3, wins: 2, netPnl: 13, estimated: 1, currencies: ['EUR'], mixed: false });
    });

    it('has an answer for an empty journal', () => {
        expect(summarizeJournal([])).toEqual({ trades: 0, wins: 0, netPnl: 0, estimated: 0, currencies: [], mixed: false });
    });

    it('names every currency the results are booked in', () => {
        const summary = summarizeJournal([
            trade({ id: 'a', netPnl: 10, currency: 'EUR' }),
            trade({ id: 'b', netPnl: 5, currency: 'USD' }),
        ]);
        // The total still adds up as it stands — refusing to total would be as confusing as
        // totalling silently — but the screen has to be able to say it is mixed.
        expect(summary.currencies).toEqual(['EUR', 'USD']);
        expect(summary.mixed).toBe(true);
        expect(summary.netPnl).toBe(15);
    });

    it('is not fooled into calling one currency a mixture', () => {
        const summary = summarizeJournal([trade({ id: 'a' }), trade({ id: 'b' })]);
        expect(summary.mixed).toBe(false);
        expect(summary.currencies).toEqual(['EUR']);
    });

    it('treats an unrecorded currency as unknown rather than as a second one', () => {
        // Entries written before the currency was recorded carry null. Unknown is not another
        // kind of money, and must not make a single-currency journal read as mixed.
        const summary = summarizeJournal([trade({ id: 'a', currency: 'EUR' }), trade({ id: 'b', currency: null })]);
        expect(summary.currencies).toEqual(['EUR']);
        expect(summary.mixed).toBe(false);
    });
});
