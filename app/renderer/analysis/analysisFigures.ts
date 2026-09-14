/**
 * What a finished account's trades say beyond the figures it already reports.
 *
 * The run's own stats block — net, return, win rate, profit factor, expectancy — is computed
 * once by `summarize` in shared/engine and is never recomputed anywhere, this file included.
 * What is here is the other kind of question, the one the summary does not answer: which side
 * the money came from, how long a trade is held, how bad a losing streak got. Every one of
 * those is derived from the trades and from nothing else.
 *
 * The win/loss convention is `summarize`'s, deliberately: a win is `netPnl > 0`, a loss is
 * `netPnl < 0`, and a trade that came out exactly flat is neither — but it still counts in
 * the denominator, or two screens would report two win rates for the same account.
 *
 * Kept apart from the view that paints it so the arithmetic can be asserted without a DOM.
 */

/** The trade fields a breakdown reads. The engine's closed trade satisfies it. */
export interface AnalysisTrade {
    side: 'long' | 'short';
    size: number;
    netPnl: number;
    openedAt: number;
    closedAt: number;
    /** What the trade risked per unit when it opened, or null when it carried no stop. */
    riskPerUnit: number | null;
    /** Money per point per unit on the account that closed it. Absent means one. */
    pointValue?: number;
}

/** One side of the book, on its own. */
export interface SideBreakdown {
    count: number;
    wins: number;
    losses: number;
    /** Null with no trades on this side — 0% would read as "always lost". */
    winRate: number | null;
    netPnl: number;
}

export interface TradeBreakdown {
    long: SideBreakdown;
    short: SideBreakdown;
    /** The single best and worst results, or null with nothing closed. */
    best: number | null;
    worst: number | null;
    /** Mean holding time in ms, or null with nothing closed. */
    avgHoldMs: number | null;
    /** The longest run of wins, and of losses. A flat trade ends both — it is neither. */
    maxWinStreak: number;
    maxLossStreak: number;
    /**
     * The mean result in R, over the trades that carried a stop to measure against.
     * Null when none did: a trade that risked nothing knowable cannot be averaged into one
     * that did, and folding it in as 0R would flatter every account without stops.
     */
    avgR: number | null;
    /** How many trades that average was taken over, so the figure can be read honestly. */
    rTrades: number;
}

function emptySide(): SideBreakdown {
    return { count: 0, wins: 0, losses: 0, winRate: null, netPnl: 0 };
}

/** Fold one trade into the side it was taken on. */
function addToSide(side: SideBreakdown, netPnl: number): void {
    side.count += 1;
    side.netPnl += netPnl;
    if (netPnl > 0) side.wins += 1;
    else if (netPnl < 0) side.losses += 1;
}

export function tradeBreakdown(trades: readonly AnalysisTrade[]): TradeBreakdown {
    const long = emptySide();
    const short = emptySide();

    let best: number | null = null;
    let worst: number | null = null;
    let heldTotal = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let winStreak = 0;
    let lossStreak = 0;
    let rSum = 0;
    let rTrades = 0;

    for (const t of trades) {
        addToSide(t.side === 'long' ? long : short, t.netPnl);

        if (best == null || t.netPnl > best) best = t.netPnl;
        if (worst == null || t.netPnl < worst) worst = t.netPnl;

        // A snapshot off disk could carry anything; a negative span is not a holding time.
        heldTotal += Math.max(0, t.closedAt - t.openedAt);

        if (t.netPnl > 0) {
            winStreak += 1;
            lossStreak = 0;
        } else if (t.netPnl < 0) {
            lossStreak += 1;
            winStreak = 0;
        } else {
            winStreak = 0;
            lossStreak = 0;
        }
        if (winStreak > maxWinStreak) maxWinStreak = winStreak;
        if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;

        const risk = t.riskPerUnit;
        if (risk != null && risk > 0 && t.size > 0) {
            rSum += t.netPnl / (risk * t.size * (t.pointValue != null && t.pointValue > 0 ? t.pointValue : 1));
            rTrades += 1;
        }
    }

    long.winRate = long.count > 0 ? long.wins / long.count : null;
    short.winRate = short.count > 0 ? short.wins / short.count : null;

    return {
        long,
        short,
        best,
        worst,
        avgHoldMs: trades.length > 0 ? heldTotal / trades.length : null,
        maxWinStreak,
        maxLossStreak,
        avgR: rTrades > 0 ? rSum / rTrades : null,
        rTrades,
    };
}
