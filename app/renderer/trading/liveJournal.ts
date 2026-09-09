import type { HistoryRow } from '../replay/tradeBook';
import type { LiveTradeRecord } from './CapitalController';
import { reconstructClosedTrades, type CapitalActivity, type CapitalTransaction } from './capitalHistory';

/**
 * What has actually been traded on a real account, kept by Midorii rather than by the venue.
 *
 * The venue has the same facts and is a poor place to keep them: `/history/activity` serves
 * at most one day per request, so a month is thirty round trips, and the record goes away
 * with the account or the credentials. Trading happens HERE, so the record lives here — the
 * same reasoning that puts the paper account and the run library on disk instead of asking
 * an exchange to remember them.
 *
 * Held in memory once loaded, and written through on every close. The list is small — a
 * trade is one short object and an active account produces a few a day — so there is no
 * paging and no windowing to get wrong.
 */

/** Every trade on record, newest first. Never throws: a journal that cannot be read is
 *  reported and treated as empty, because the alternative is a screen that will not open. */
export async function loadJournal(): Promise<LiveTradeRecord[]> {
    try {
        const trades = await window.midori.live.trades();
        // Newest first is how a history is read; the file keeps them in the order they
        // happened, which is how a journal is written.
        return [...trades].reverse();
    } catch (err) {
        console.error('[midorii] could not read the live trading journal', err);
        return [];
    }
}

/**
 * Record one finished trade. Resolves to whether it was actually added.
 *
 * A failure here is loud on purpose. Everything else in this app can be recomputed — a
 * backtest re-run, a paper account replayed — and this cannot: it is the only record that
 * money moved, and losing one silently would leave a total that is wrong in a way nobody can
 * find afterwards.
 */
export async function recordTrade(trade: LiveTradeRecord): Promise<boolean> {
    const { added } = await window.midori.live.append(trade);
    return added;
}

/** Turn journal entries into the rows the trade panel already knows how to draw. */
export function journalRows(trades: readonly LiveTradeRecord[]): HistoryRow[] {
    return trades.map((t) => ({
        side: t.side,
        size: t.size,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        netPnl: t.netPnl,
        fees: t.fees,
        /* No R on a live trade. R is measured against what the trade risked when it OPENED,
         * and a venue records no such thing — it knows the stop a position carries now, which
         * is a different number the moment anybody moves one. Null says "cannot be stated",
         * which is the truth; a computed stand-in would quietly rescale every comparison
         * against a backtest. */
        r: null,
        /* An estimated exit is marked in the one place the panel already shows words, so a
         * figure that is not the venue's own never reads as though it were. */
        exitTag: t.estimated ? 'estimated' : t.exitTag,
    }));
}

/** What the journal comes to, for a screen that summarizes rather than lists. */
export interface JournalSummary {
    trades: number;
    wins: number;
    /**
     * The results added up — which is only a meaningful number when they are all the same
     * kind of money. See {@link JournalSummary.currencies}.
     */
    netPnl: number;
    /** How many of the entries carry an exit this app worked out rather than read. */
    estimated: number;
    /**
     * Every currency the entries are denominated in, in the order first seen.
     *
     * One entry is the ordinary case and the total means what it says. More than one, and the
     * total is a sum of different monies: shown with the fact stated rather than suppressed,
     * because a screen that quietly refused to total would be just as confusing as one that
     * quietly totalled the wrong thing. Empty where nothing recorded a currency at all.
     */
    currencies: string[];
    /** Whether more than one kind of money went into `netPnl`. */
    mixed: boolean;
}

export function summarizeJournal(trades: readonly LiveTradeRecord[]): JournalSummary {
    let wins = 0;
    let netPnl = 0;
    let estimated = 0;
    const currencies: string[] = [];
    for (const t of trades) {
        if (t.netPnl > 0) wins += 1;
        netPnl += t.netPnl;
        if (t.estimated) estimated += 1;
        if (t.currency && !currencies.includes(t.currency)) currencies.push(t.currency);
    }
    return { trades: trades.length, wins, netPnl, estimated, currencies, mixed: currencies.length > 1 };
}


/** How far back to look for the real figures behind a reconstructed exit. */
const SETTLE_WINDOW_DAYS = 7;

/**
 * Replace reconstructed exits with the venue's own figures, where its ledgers have caught up.
 *
 * The journal records a closure the moment it notices one, which is the only way not to lose
 * trades — but a position closed by a stop between two reads leaves this app guessing at the
 * exit price and the result, and knowing nothing at all about financing or commission. The
 * venue's history knows all four, a few minutes later. This is the second pass that turns the
 * guess into the record.
 *
 * Only entries still marked estimated are touched, and only within a window: an old journal is
 * not re-read on every pass, and a trade the venue has already confirmed is a fact that a
 * later retry must not be able to rewrite.
 *
 * Returns how many entries were settled. Never throws — a history that cannot be read leaves
 * the estimates exactly as they were, which is what they already say they are.
 */
export async function settleEstimates(trades: readonly LiveTradeRecord[]): Promise<number> {
    const pending = trades.filter((t) => t.estimated);
    if (pending.length === 0) return 0;

    const now = Date.now();
    const oldest = Math.min(...pending.map((t) => t.closedAt));
    // Clamped: the endpoint is read a day at a time, so an ancient estimate is left alone
    // rather than turned into a week of requests it would not answer anyway.
    const from = Math.max(oldest - 60_000, now - SETTLE_WINDOW_DAYS * 86_400_000);

    let facts;
    try {
        const { transactions, activities } = await window.midori.capital.history({ from, to: now });
        facts = reconstructClosedTrades(transactions as CapitalTransaction[], activities as CapitalActivity[]);
    } catch (err) {
        console.warn('[midorii] could not read the Capital.com history to settle estimated trades', err);
        return 0;
    }

    let settled = 0;
    for (const trade of pending) {
        const fact = facts.get(trade.id);
        // A voided or corrected deal is not settled here: it did not stand as booked, and
        // quietly rewriting it to zero would hide that from whoever reads the journal.
        if (!fact || fact.voided) continue;
        try {
            const ok = await window.midori.live.settle({
                id: trade.id,
                netPnl: fact.netPnl,
                fees: fact.fees,
                ...(fact.exitPrice != null ? { exitPrice: fact.exitPrice } : {}),
                /* The cash ledger's own denomination, which is the better answer about what
                 * the settled figures are than the position's was. Nothing is converted on
                 * the way: this app has no exchange rate, and a plausible wrong total in the
                 * record money is judged by is the one mistake worth taking trouble over. */
                ...(fact.currency ? { currency: fact.currency } : {}),
            });
            if (ok) settled += 1;
        } catch (err) {
            console.warn(`[midorii] could not settle trade ${trade.id}`, err);
        }
    }
    return settled;
}
