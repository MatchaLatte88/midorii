/**
 * What the account is worth right now, while a session runs.
 *
 * Every figure comes off the Broker as it stands — nothing here keeps a running total of its
 * own. The account is the one that knows, and a second tally computed on the side is how the
 * chart and the stored run end up disagreeing about the same afternoon.
 *
 * Kept apart from the strip that paints it so the arithmetic can be asserted without a chart.
 */

/** The one field of a position this file reads. */
export interface AccountPosition {
    stopLoss: number | null;
}

/** The slice of the Broker a readout needs. The real `Broker` satisfies it. */
export interface AccountSource {
    balance: number;
    equity: number;
    unrealizedPnl: number;
    netSize: number;
    initialBalance: number;
    positions: readonly AccountPosition[];
    /** What closing `position` at `price` leaves behind, net of the costs of getting out. */
    exitResult(position: AccountPosition, price: number): number;
}

export interface AccountFigures {
    /** Balance plus what is open — the number the account is actually worth. */
    equity: number;
    /** Realised only: what is settled and would still be there if everything closed at zero. */
    cash: number;
    initialBalance: number;
    /** Equity against the balance the session started with, as a fraction. */
    returnPct: number;
    /** Unrealised profit, or null with nothing open — an account holding nothing is not
     *  breaking even on it. */
    open: number | null;
    /**
     * What every stop in the market would come to together if all of them filled, as a cost:
     * positive is money still at risk, negative is a gain already locked in behind a stop that
     * has been moved past break-even.
     *
     * Null when nothing open carries a stop at all. A position without one does not risk
     * nothing, it risks an amount nobody knows — reporting that as 0.00 would show the most
     * dangerous account on the screen as the safest.
     */
    risk: number | null;
    /** Open positions with no stop behind them. Counted, never folded into `risk`. */
    unprotected: number;
    /** The net position in units, signed: positive long, negative short. */
    netSize: number;
    openPositions: number;
}

export function accountFigures(broker: AccountSource): AccountFigures {
    let risk = 0;
    let unprotected = 0;
    let anyProtected = false;

    for (const position of broker.positions) {
        if (position.stopLoss == null) {
            unprotected += 1;
            continue;
        }
        anyProtected = true;
        /* `exitResult` is negative while the stop is protection and positive once it sits past
         * break-even, so negating it turns it into a cost. The bare distance from the entry
         * cannot tell those apart: it reads a break-even stop as a loss the size of the round
         * trip, and a stop trailed into profit as twice that. */
        risk -= broker.exitResult(position, position.stopLoss);
    }

    const open = broker.positions.length > 0 ? broker.unrealizedPnl : null;
    const start = broker.initialBalance;

    return {
        equity: broker.equity,
        cash: broker.balance,
        initialBalance: start,
        // A session cannot start on nothing, but a restored snapshot is data from disk.
        returnPct: start > 0 ? (broker.equity - start) / start : 0,
        open,
        risk: anyProtected ? risk : null,
        unprotected,
        netSize: broker.netSize,
        openPositions: broker.positions.length,
    };
}
