/**
 * What a finished trade actually cost, joined out of the venue's two ledgers.
 *
 * A position that closed while nobody was watching leaves this app with a reconstruction: the
 * last price it saw and the last unrealized figure the venue gave. Both are estimates, and
 * the journal marks them as such. This is where they are replaced by facts.
 *
 * Capital.com keeps the answer in two places and neither is sufficient alone:
 *
 *   - `/history/transactions` is the cash ledger. A `TRADE` row's `size` field is the realized
 *     result (yes, `size`), and separate `SWAP` and commission rows carry the overnight
 *     financing and the commission — reported as NEGATIVE numbers, being costs.
 *   - `/history/activity` is the position's life: direction, size, the level it opened at, the
 *     level it closed at, and `source` — whether a stop, a target, or a person ended it.
 *
 * They are joined on the deal id. Everything here is a pure function of two payloads, so the
 * join can be asserted against captured samples without a network.
 */

/** One row of the cash ledger. `size` is an amount of money here, not a position size. */
export interface CapitalTransaction {
    transactionType?: string;
    /** What the amount is denominated in. */
    currency?: string;
    /** The deal it belongs to. Capital.com uses `reference` on most rows. */
    reference?: string;
    dealId?: string;
    /** An amount of money — the realized result on a TRADE row, the cost on a SWAP one. */
    size?: string | number;
    status?: string;
    instrumentName?: string;
    /** Note the lower-case `c`: the activity ledger spells the same idea `dateUTC`. */
    dateUtc?: string;
    date?: string;
}

/** One row of the activity ledger, as `detailed=true` returns it. */
export interface CapitalActivity {
    type?: string;
    dealId?: string;
    epic?: string;
    /** `SL`, `TP`, `USER`, `SYSTEM`, … — what ended the position. */
    source?: string;
    dateUTC?: string;
    date?: string;
    details?: {
        direction?: string;
        size?: string | number;
        level?: string | number;
        /** Present ONLY on the closing event — which is how the two are told apart. */
        openPrice?: string | number;
    } | null;
}

/** What the ledgers say about one finished trade. */
export interface ClosedTradeFacts {
    dealId: string;
    /** The realized result, financing and commission included. */
    netPnl: number;
    /** What the trade cost in swap and commission, as a positive number. */
    fees: number;
    entryPrice: number | null;
    exitPrice: number | null;
    /** `SL`, `TP`, `USER` … — lower-cased for the journal's own vocabulary. */
    exitTag: string | null;
    /** A correction or a cancellation: the trade did not stand as booked. */
    voided: boolean;
    /**
     * The currency the cash ledger booked this row in.
     *
     * Carried rather than assumed. Capital.com does not document whether a transaction's
     * amount is in the instrument's currency or the account's, and its own CSV export has a
     * column for each — so the only safe thing to do with a number whose unit is uncertain is
     * to keep the unit attached to it. Whoever adds two of these up can then check they are
     * the same kind of money first.
     */
    currency: string | null;
}

/** Transaction types that carry a commission rather than a result. */
const COMMISSION_TYPES = new Set(['TRADE_COMMISSION', 'COMMISSION']);
/** Types that describe a round trip's cash result. */
const RESULT_TYPES = new Set(['TRADE', 'TRADE_CORRECTION', 'VOID']);

function toNumber(value: unknown): number | null {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** The deal a ledger row belongs to. Capital.com uses `reference` on the cash side. */
function dealOf(row: CapitalTransaction): string | null {
    const raw = row.reference ?? row.dealId;
    return raw == null || raw === '' ? null : String(raw);
}

/**
 * Join the two ledgers into one answer per finished trade.
 *
 * Only deals the CASH ledger knows about come back: a position that opened but has not closed
 * has activities and no result, and returning it with a zero result would settle a trade that
 * is still running.
 */
export function reconstructClosedTrades(
    transactions: readonly CapitalTransaction[],
    activities: readonly CapitalActivity[],
): Map<string, ClosedTradeFacts> {
    /* The closing activity is the one carrying `openPrice`; the opening one is not. Activities
     * arrive newest-first, so the LAST opening event seen for a deal is its earliest — the one
     * the position actually opened on. */
    const opens = new Map<string, CapitalActivity>();
    const closes = new Map<string, CapitalActivity>();
    for (const a of activities) {
        if (a.type !== 'POSITION' || a.dealId == null) continue;
        const deal = String(a.dealId);
        if (a.details?.openPrice != null) {
            if (!closes.has(deal)) closes.set(deal, a);
        } else {
            opens.set(deal, a);
        }
    }

    // Costs, summed per deal — a position held over several nights has several swap rows.
    const swap = new Map<string, number>();
    const commission = new Map<string, number>();
    for (const t of transactions) {
        const deal = dealOf(t);
        const amount = toNumber(t.size);
        if (deal == null || amount == null) continue;
        if (t.transactionType === 'SWAP') swap.set(deal, (swap.get(deal) ?? 0) + amount);
        else if (COMMISSION_TYPES.has(t.transactionType ?? '')) {
            commission.set(deal, (commission.get(deal) ?? 0) + amount);
        }
    }

    const out = new Map<string, ClosedTradeFacts>();
    for (const t of transactions) {
        if (!RESULT_TYPES.has(t.transactionType ?? '')) continue;
        // An unprocessed row is a result that has not settled; taking it would book a figure
        // the venue may still revise.
        if (t.status && t.status !== 'PROCESSED') continue;
        const deal = dealOf(t);
        if (deal == null) continue;

        if (t.transactionType !== 'TRADE') {
            out.set(deal, { dealId: deal, netPnl: 0, fees: 0, entryPrice: null, exitPrice: null, exitTag: null, voided: true, currency: t.currency ?? null });
            continue;
        }

        const result = toNumber(t.size);
        if (result == null) continue;
        const financing = swap.get(deal) ?? 0;
        const fee = commission.get(deal) ?? 0;
        const close = closes.get(deal);
        const open = opens.get(deal);

        out.set(deal, {
            dealId: deal,
            // Capital reports costs as negatives, so they ADD to the result as it stands.
            netPnl: result + financing + fee,
            // Turned around for the journal, which records a cost as a positive number.
            fees: -(financing + fee),
            entryPrice: toNumber(open?.details?.level) ?? toNumber(close?.details?.openPrice),
            exitPrice: toNumber(close?.details?.level),
            exitTag: close?.source ? close.source.toLowerCase() : null,
            voided: false,
            currency: t.currency ?? null,
        });
    }
    return out;
}
