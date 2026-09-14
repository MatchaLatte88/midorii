import type { HistoryRow } from '../replay/tradeBook';
import type { AccountView } from '../replay/tradeDock';

/**
 * The dock's account line for an account no engine is behind.
 *
 * A paper account's figures come off its own engine, which has watched every tick since the
 * account opened. A venue account has only its closed trades — so the line is worked out from
 * those, over whatever stretch of history the venue hands over, and says nothing an equity
 * curve would be needed for beyond what the closed trades themselves trace.
 *
 * `balance` is the realised balance NOW, without what is open: the start of the stretch is
 * that balance minus what the stretch realised, and the return and the drawdown are measured
 * against it. Unknown (zero or less) means no percentages rather than percentages of nothing.
 */
export function historyStats(history: readonly HistoryRow[], balance: number): AccountView['stats'] {
    let netPnl = 0;
    let fees = 0;
    let wins = 0;
    for (const row of history) {
        netPnl += row.netPnl;
        fees += row.fees;
        if (row.netPnl > 0) wins += 1;
    }
    const start = balance - netPnl;

    /* Peak to trough over the closed-trade curve, oldest first. Closed trades only: the open
     * excursions in between were never recorded, so this is the least the drawdown was. */
    let maxDrawdownPct = 0;
    if (start > 0) {
        let equity = start;
        let peak = start;
        for (let i = history.length - 1; i >= 0; i -= 1) {
            equity += history[i]!.netPnl;
            peak = Math.max(peak, equity);
            if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
        }
    }

    return {
        netPnl,
        returnPct: start > 0 ? netPnl / start : 0,
        tradeCount: history.length,
        winRate: history.length > 0 ? wins / history.length : null,
        maxDrawdownPct,
        feesPaid: fees,
    };
}
