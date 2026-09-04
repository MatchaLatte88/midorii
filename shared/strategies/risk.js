/* Risk and sizing — the two questions every strategy has to answer.
 *
 * Its own file, and with no imports of its own, because both the registry and
 * every individual strategy need it. Putting it in index.js made a cycle:
 * index imports the strategy, the strategy imports the shared parameters back
 * out of index, and whichever loaded first found the other half in its
 * temporal dead zone. Nothing here depends on anything, so nothing can.
 *
 * Position sizing is derived, never set. You choose what a trade may lose; the
 * distance to the stop decides how large it has to be, so being stopped out
 * costs what you said it would however wide the stop happens to be. A strategy
 * that let you set the size instead would let the same setting mean a
 * different amount of money on every trade.
 */

/** How the risk per trade is expressed. */
export const RISK_MODES = ['percent', 'fixed'];

/**
 * The two settings every strategy shares. Prepended to each schema rather than
 * copied into it, so they cannot drift apart between strategies — two runs
 * that named their risk differently would not be comparable, and comparing
 * runs is the reason they are stored.
 */
export const RISK_PARAMS = [
  {
    key: 'riskMode',
    label: 'Risk per trade',
    type: 'select',
    default: 'percent',
    hint: 'How the amount at stake on one trade is expressed. Percent compounds — '
      + 'the stake grows with the account and shrinks after a loss; fixed always risks '
      + 'the same cash, which makes a run easier to read but ignores what the account did.',
    options: [
      { value: 'percent', label: 'Percent of equity' },
      { value: 'fixed', label: 'Fixed amount' },
    ],
  },
  {
    key: 'riskValue',
    label: 'Risk',
    type: 'number',
    default: 1,
    min: 0.01,
    max: 1e6,
    step: 0.25,
    hint: 'How much one trade may lose — read as a percentage of equity or as cash, '
      + 'depending on the mode above. The position size follows from this and the '
      + 'distance to the stop, so a wider stop buys a smaller position rather than a '
      + 'bigger loss.',
  },
  {
    key: 'maxLeverage',
    label: 'Max leverage',
    type: 'number',
    default: 1,
    min: 1,
    max: 100,
    step: 0.5,
    hint: 'The most notional a position may carry, as a multiple of equity. 1 means '
      + 'spot: you cannot hold more than you have. This is a real limit, not a formality '
      + '— risking 1% behind a stop 0.08% away asks for twenty times the account, and '
      + 'without a ceiling the fees on that phantom size decide the whole result.',
  },
  {
    key: 'rrr',
    label: 'Reward : risk',
    type: 'number',
    default: 2,
    min: 0.1,
    max: 20,
    step: 0.1,
    hint: 'Where the target sits, as a multiple of the distance from entry to stop. '
      + 'At 2 a winner returns twice what a loser costs, so the run breaks even at a '
      + 'win rate of about 33% before costs.',
  },
];

/**
 * How large a position has to be for the stop to cost exactly the intended
 * risk, capped at what the account can actually carry — or null when there is
 * no honest answer.
 *
 * Returning null rather than a number is deliberate. A stop at the entry gives
 * a division by zero, and the tempting fallbacks — a default size, or the
 * largest the account allows — both turn "this trade has no defined risk" into
 * a real position. The caller skips the trade instead.
 *
 * The leverage cap is not decoration
 * ----------------------------------
 * Risk-based sizing divides by the distance to the stop, so a tight stop asks
 * for a large position. On BTC at 58,700 with a stop 45 away, risking 1% of a
 * 10,000 account computes 2.2 BTC — 130,000 of notional against 10,000 of
 * equity. Nobody can hold that on spot, and the fees on the phantom size, at
 * 0.1% per side, cost more than the trade was ever allowed to lose.
 *
 * Measured on a month of BTC 5m, uncapped sizing turned 54 Silver Bullet
 * trades into 4,924 of fees against a 10,000 account. The cap is what keeps a
 * backtest describing an account that could exist.
 *
 * Capping lowers the realised risk below what was asked for: the stop is still
 * where it was, but a smaller position loses less at it. That is the honest
 * direction to be wrong in, and it is visible — a run whose sizes are pinned
 * to the ceiling is telling you the stop is too tight for the risk.
 *
 * @param {number} equity        account equity at the moment of the decision
 * @param {number} entry         the price the fill is expected around
 * @param {number} stop          where the trade is wrong
 * @param {'percent'|'fixed'} mode
 * @param {number} value         percent of equity, or cash
 * @param {number} [maxLeverage=1]  notional ceiling as a multiple of equity
 */
export function positionSize(equity, entry, stop, mode, value, maxLeverage = 1) {
  const distance = Math.abs(entry - stop);
  if (!(distance > 0)) return null;

  const risk = mode === 'percent' ? equity * (value / 100) : value;
  if (!(risk > 0)) return null;

  const wanted = risk / distance;
  if (!Number.isFinite(wanted) || wanted <= 0) return null;

  // An account with nothing left cannot open anything, whatever the maths says.
  if (!(equity > 0) || !(entry > 0)) return null;

  const ceiling = (equity * maxLeverage) / entry;
  const size = Math.min(wanted, ceiling);
  return size > 0 ? size : null;
}
