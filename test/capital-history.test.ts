// Turning a reconstructed exit into a fact. Capital.com keeps the answer in two ledgers that
// have to be joined, and neither is self-explanatory: a TRADE row's `size` is an amount of
// MONEY, costs arrive as negative numbers, and the closing activity is told from the opening
// one only by carrying an `openPrice`. Every one of those is a chance to book a wrong result
// into the record money is judged by.
// See app/renderer/trading/capitalHistory.ts.
import { describe, it, expect } from 'vitest';
import { reconstructClosedTrades } from '../app/renderer/trading/capitalHistory';
import type { CapitalActivity, CapitalTransaction } from '../app/renderer/trading/capitalHistory';

const DEAL = '00601567-0001-54c4-0000-00009115276c';

/** The cash ledger's result row. `size` is money here, despite the name. */
const tradeRow = (over: Partial<CapitalTransaction> = {}): CapitalTransaction => ({
    transactionType: 'TRADE', reference: DEAL, size: '-0.93', status: 'PROCESSED',
    instrumentName: 'Gold', currency: 'EUR', dateUtc: '2026-06-26T12:04:15.826', ...over,
});

/** The position's life. The closing event is the one carrying `openPrice`. */
const closeAct = (over: Partial<CapitalActivity['details']> = {}, source = 'USER'): CapitalActivity => ({
    type: 'POSITION', dealId: DEAL, epic: 'GOLD', source, dateUTC: '2026-06-26T12:04:15.826',
    details: { direction: 'SELL', size: 1, level: 4044.6, openPrice: 4045.53, ...over },
});

const openAct = (over: Partial<CapitalActivity['details']> = {}): CapitalActivity => ({
    type: 'POSITION', dealId: DEAL, epic: 'GOLD', source: 'USER', dateUTC: '2026-06-26T12:03:49.325',
    details: { direction: 'BUY', size: 1, level: 4045.53, ...over },
});

describe('joining the two ledgers', () => {
    it('reads the result off the cash row and the levels off the activities', () => {
        const facts = reconstructClosedTrades([tradeRow()], [closeAct(), openAct()]);
        const fact = facts.get(DEAL)!;
        expect(fact.netPnl).toBeCloseTo(-0.93, 8);
        expect(fact.entryPrice).toBe(4045.53);
        expect(fact.exitPrice).toBe(4044.6);
        expect(fact.voided).toBe(false);
    });

    it('adds financing and commission, which arrive as negative costs', () => {
        const facts = reconstructClosedTrades(
            [
                tradeRow({ size: '10' }),
                { transactionType: 'SWAP', reference: DEAL, size: '-1.5', status: 'PROCESSED' },
                { transactionType: 'TRADE_COMMISSION', reference: DEAL, size: '-0.5', status: 'PROCESSED' },
            ],
            [closeAct(), openAct()],
        );
        const fact = facts.get(DEAL)!;
        // 10 made, 2 paid: the costs are already negative, so they add.
        expect(fact.netPnl).toBeCloseTo(8, 8);
        // The journal records a cost as a positive number.
        expect(fact.fees).toBeCloseTo(2, 8);
    });

    it('sums a position held over several nights', () => {
        const facts = reconstructClosedTrades(
            [
                tradeRow({ size: '20' }),
                { transactionType: 'SWAP', reference: DEAL, size: '-1', status: 'PROCESSED' },
                { transactionType: 'SWAP', reference: DEAL, size: '-1', status: 'PROCESSED' },
            ],
            [closeAct(), openAct()],
        );
        expect(facts.get(DEAL)!.fees).toBeCloseTo(2, 8);
        expect(facts.get(DEAL)!.netPnl).toBeCloseTo(18, 8);
    });

    it('says what ended the position', () => {
        // The export writes SL for a stop and USER for a manual close.
        expect(reconstructClosedTrades([tradeRow()], [closeAct({}, 'SL'), openAct()]).get(DEAL)!.exitTag).toBe('sl');
        expect(reconstructClosedTrades([tradeRow()], [closeAct({}, 'TP'), openAct()]).get(DEAL)!.exitTag).toBe('tp');
        expect(reconstructClosedTrades([tradeRow()], [closeAct(), openAct()]).get(DEAL)!.exitTag).toBe('user');
    });

    it('falls back to the close event for an entry it has no opening activity for', () => {
        // A position opened before the window still closed inside it.
        const fact = reconstructClosedTrades([tradeRow()], [closeAct()]).get(DEAL)!;
        expect(fact.entryPrice).toBe(4045.53); // details.openPrice on the closing event
    });

    it('takes the earliest opening event, activities arriving newest first', () => {
        const later = openAct({ level: 4099 });
        const earlier = openAct({ level: 4045.53 });
        // Newest first is the order the venue returns them in.
        const fact = reconstructClosedTrades([tradeRow()], [closeAct(), later, earlier]).get(DEAL)!;
        expect(fact.entryPrice).toBe(4045.53);
    });

    it('marks a correction or a cancellation rather than booking it as a result', () => {
        for (const type of ['TRADE_CORRECTION', 'VOID']) {
            const fact = reconstructClosedTrades([tradeRow({ transactionType: type })], []).get(DEAL)!;
            // Quietly rewriting it to zero would hide from the reader that it did not stand.
            expect(fact.voided).toBe(true);
        }
    });

    it('ignores a result the venue has not settled', () => {
        expect(reconstructClosedTrades([tradeRow({ status: 'PENDING' })], []).size).toBe(0);
    });

    it('ignores a position that has not closed', () => {
        // Activities without a cash result: returning it with a zero would settle a trade
        // that is still running.
        expect(reconstructClosedTrades([], [openAct()]).size).toBe(0);
    });

    it('accepts either name the venue uses for the deal', () => {
        const byDealId = reconstructClosedTrades([{ transactionType: 'TRADE', dealId: DEAL, size: '5', status: 'PROCESSED' }], []);
        expect(byDealId.get(DEAL)!.netPnl).toBe(5);
    });

    it('is not confused by another deal in the same window', () => {
        const other = 'deal-other';
        const facts = reconstructClosedTrades(
            [tradeRow(), tradeRow({ reference: other, size: '7' }),
             { transactionType: 'SWAP', reference: other, size: '-3', status: 'PROCESSED' }],
            [closeAct(), openAct()],
        );
        expect(facts.get(DEAL)!.netPnl).toBeCloseTo(-0.93, 8);
        expect(facts.get(other)!.netPnl).toBeCloseTo(4, 8);
        // Costs must not leak between deals.
        expect(facts.get(DEAL)!.fees).toBe(-0);
    });
});


describe('the currency a result is booked in', () => {
    it('comes through with the figures rather than being assumed', () => {
        // Capital.com does not document whether an amount is in the instrument's currency or
        // the account's, and its own export has a column for each. The only safe thing to do
        // with a number whose unit is uncertain is to keep the unit attached.
        expect(reconstructClosedTrades([tradeRow()], [closeAct(), openAct()]).get(DEAL)!.currency).toBe('EUR');
    });

    it('is null where the ledger did not say', () => {
        expect(reconstructClosedTrades([tradeRow({ currency: undefined })], []).get(DEAL)!.currency).toBeNull();
    });

    it('is carried onto a voided deal too', () => {
        const fact = reconstructClosedTrades([tradeRow({ transactionType: 'VOID' })], []).get(DEAL)!;
        expect(fact.voided).toBe(true);
        expect(fact.currency).toBe('EUR');
    });
});
