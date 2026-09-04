/* The figures a finished account is judged on.
 *
 * Its own file because two things produce a finished account: the backtest
 * loop, and a replay session a person clicked their way through. If each
 * summed itself up, the same account would report two different win rates as
 * soon as one of them was edited — and the whole reason the two share a Broker
 * is that a result made by hand and one made by a bot have to be comparable.
 *
 * Only quantities that can be computed honestly from what the account did.
 */

/**
 * @param {object} params
 * @param {object} params.broker         the broker the account ran through
 * @param {Array}  params.equityCurve    one point per bar
 * @param {number} params.maxDrawdown    worst peak-to-trough, in cash
 * @param {number} params.maxDrawdownPct the same, against the peak it fell from
 * @param {number} params.barCount       bars the account was actually live for
 */
export function summarize({ broker, equityCurve, maxDrawdown, maxDrawdownPct, barCount }) {
  const trades = broker.trades;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netPnl = broker.equity - broker.initialBalance;
  const fees = broker.fills.reduce((a, f) => a + f.fee, 0);

  return {
    initialBalance: broker.initialBalance,
    finalEquity: broker.equity,
    netPnl,
    returnPct: netPnl / broker.initialBalance,
    maxDrawdown,
    maxDrawdownPct,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    // An account with no trades has no win rate — 0% would read as "always lost".
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
    // Infinite profit factor is real when nothing lost; null keeps it out of sums.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    expectancy: trades.length > 0 ? trades.reduce((a, t) => a + t.netPnl, 0) / trades.length : null,
    feesPaid: fees,
    barCount,
    equityPoints: equityCurve.length,
  };
}
