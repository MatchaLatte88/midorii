import type { HistoryRow } from '../replay/tradeBook';
import type { MidoriProjectXTrade } from '../midori';

/**
 * What the account has already done, built out of what the gateway says it did.
 *
 * ProjectX reports EXECUTIONS, not trades. Each row is one fill: a side, a size, a price, and
 * a `profitAndLoss` that is null on the fill that opened a position and carries the realised
 * result on the one that closed it. A person does not think in half-turns — they think "I was
 * long two from 24,000 and came out at 24,010" — so the two are paired back together here.
 *
 * Why this is a reading and not a fetch
 * -------------------------------------
 * The pairing is the only part of this venue's history that is a judgement, and judgements
 * belong where they can be exercised without a gateway. Everything below is a walk over a
 * list, so it is tested as one.
 *
 * What is NOT invented
 * --------------------
 * Two of a history row's figures cannot be had from this data and are left null rather than
 * filled in. `r` needs the risk a trade opened with, which the venue does not record — the
 * stop that was on it may have moved twice. `exitTag` needs to know whether a stop or a target
 * did it, and an execution does not say; guessing from the direction of the result would
 * label every loser a stop, including the ones somebody closed by hand.
 */

/** 0 buys and 1 sells, the same pair the order endpoints use. */
const SIDE_BUY = 0;

/**
 * Whether the gateway's `profitAndLoss` is stated before commission.
 *
 * It reports the two as separate fields and does not say whether one contains the other. Read
 * as GROSS here — the convention every futures statement this app has been compared against
 * uses, and the reading that makes `fees` mean something rather than be a second copy of a
 * number already subtracted. Stated as a named assumption rather than buried in an expression,
 * because if it is ever measured to be wrong this is the one line that has to change.
 */
const PNL_IS_GROSS = true;

/** A position being accumulated, per contract, as the executions are walked. */
interface OpenLot {
    /** Signed: above zero is long. */
    size: number;
    /** Weighted by size, over every fill that built it. */
    entryPrice: number;
    openedAt: number;
    /** Commission paid getting in, for the part still open. */
    fees: number;
}

/**
 * Closed round trips, newest first — the order a history is read in, and the order the
 * ticket's History tab expects.
 *
 * Voided executions are dropped before anything is walked: the venue has cancelled them, and
 * folding one into an average entry would move a price that never happened.
 */
export function projectxHistory(trades: readonly MidoriProjectXTrade[]): HistoryRow[] {
    const executions = trades
        .filter((t) => !t.voided)
        /* Oldest first: a position is built and then taken off, and the walk below only makes
         * sense in the direction it happened. The gateway answers newest first. */
        .slice()
        .sort((a, b) => Date.parse(a.creationTimestamp) - Date.parse(b.creationTimestamp));

    const lots = new Map<string, OpenLot>();
    const rows: HistoryRow[] = [];

    for (const execution of executions) {
        const at = Date.parse(execution.creationTimestamp);
        if (!Number.isFinite(at)) continue;
        const signed = execution.side === SIDE_BUY ? execution.size : -execution.size;
        if (!(execution.size > 0)) continue;

        const lot = lots.get(execution.contractId);

        // Nothing open, or a fill in the same direction: this is getting in, or adding to it.
        if (!lot || lot.size === 0 || Math.sign(lot.size) === Math.sign(signed)) {
            lots.set(execution.contractId, addTo(lot, signed, execution.price, at, execution.fees));
            continue;
        }

        /* Facing the other way: this is coming out, of as much of the position as it covers.
         * Anything past that is the position going the other way, and starts a fresh lot. */
        const closing = Math.min(Math.abs(signed), Math.abs(lot.size));
        const share = closing / Math.abs(lot.size);
        const entryFees = lot.fees * share;
        /* The exit's own commission, apportioned the same way where this fill closes more
         * than the position held — the rest of it belongs to the reversal. */
        const exitFees = execution.fees * (closing / execution.size);
        const fees = entryFees + exitFees;
        /* The venue's own realised figure, never one computed from the two prices: it knows
         * the contract multiplier, and a price difference does not. Apportioned where this
         * fill closed only part of what it covers. Null — a half-turn the gateway did not
         * price — leaves the row's result at zero rather than at a number nobody stated. */
        const gross = execution.profitAndLoss != null
            ? execution.profitAndLoss * (closing / execution.size)
            : 0;

        rows.push({
            side: lot.size > 0 ? 'long' : 'short',
            size: closing,
            entryPrice: lot.entryPrice,
            exitPrice: execution.price,
            openedAt: lot.openedAt,
            closedAt: at,
            netPnl: PNL_IS_GROSS ? gross - fees : gross,
            fees,
            r: null,
            exitTag: null,
        });

        const left = Math.abs(lot.size) - closing;
        if (left > 0) {
            // Part of it is still on, at the same entry, carrying the fees not yet accounted.
            lots.set(execution.contractId, {
                size: Math.sign(lot.size) * left,
                entryPrice: lot.entryPrice,
                openedAt: lot.openedAt,
                fees: lot.fees - entryFees,
            });
            continue;
        }

        const reversed = Math.abs(signed) - closing;
        lots.set(execution.contractId, reversed > 0
            ? {
                size: Math.sign(signed) * reversed,
                entryPrice: execution.price,
                openedAt: at,
                fees: execution.fees * (reversed / execution.size),
            }
            : { size: 0, entryPrice: 0, openedAt: 0, fees: 0 });
    }

    rows.reverse();
    return rows;
}

/** Fold one fill into a lot, keeping the entry a size-weighted average of what built it. */
function addTo(lot: OpenLot | undefined, signed: number, price: number, at: number, fees: number): OpenLot {
    if (!lot || lot.size === 0) return { size: signed, entryPrice: price, openedAt: at, fees };
    const size = lot.size + signed;
    const weighted = (lot.entryPrice * Math.abs(lot.size) + price * Math.abs(signed)) / Math.abs(size);
    return { size, entryPrice: weighted, openedAt: lot.openedAt, fees: lot.fees + fees };
}
