/* Turning a drawn position block into an order.
 *
 * The position tool already asks for everything an order needs except the
 * size: where you get in, where you are wrong, and where you are done. Making
 * a trade out of it should therefore not mean typing the same three numbers
 * into a ticket — which is also the moment they get typed wrong.
 *
 * Two readings of the same block
 * ------------------------------
 *   pending  the levels as drawn. The plan was for *that* price, so the order
 *            waits there. Whether that is a limit or a stop is not a separate
 *            question — it follows from which side of the current price the
 *            entry sits on, and asking would be asking the user to restate
 *            what they already drew.
 *
 *   market   the *distances* as drawn, applied now. A block drawn an hour ago
 *            has an entry the market has left behind; what is still worth
 *            keeping is its shape — risk 500, reward 1000 — and that shape is
 *            what moves to the current price.
 *
 * Distances are carried, not computed here
 * ----------------------------------------
 * A market order fills at the last price plus spread and slippage, and what
 * those come to is the account's business, not this file's. So the bracket
 * goes to the Broker as offsets and is turned into levels at the fill — see
 * `_attachBracket`. Levels computed here from the bare close would quietly
 * make a plan drawn as "risk 500" cost 500 plus the costs of getting in.
 *
 * Stricter than the drawing
 * -------------------------
 * `positionDirection` in the drawing layer answers for *any* arrangement of
 * three anchors, because a block always has to render as something. An order
 * cannot be that forgiving: a stop on the entry has no risk to size against,
 * and a target on the same side as the stop is not a trade in either
 * direction. Both are refused here rather than guessed at, and the message
 * says which anchor to move.
 */

/** How a drawn block is read. */
export const PLAN_MODES = ['market', 'pending'];

/**
 * An order spec from a drawn position block.
 *
 * @param {object} plan            { entry, stop, target } — target may be null
 * @param {object} options
 * @param {number} options.price   the last price anyone can see
 * @param {string} options.mode    'market' or 'pending'
 * @returns {{side, type, price, bracket, risk, reward}}
 *   `price` is the level a resting order waits at, or null for a market order.
 *   `bracket` is what the Broker attaches when the entry fills: absolute levels
 *   for a pending order, distances from the fill for a market one.
 */
export function orderFromPlan(plan, { price, mode }) {
  if (!PLAN_MODES.includes(mode)) {
    throw new Error(`orderFromPlan: unknown mode "${mode}". Known: ${PLAN_MODES.join(', ')}`);
  }
  if (!plan || !Number.isFinite(plan.entry) || !Number.isFinite(plan.stop)) {
    throw new Error('orderFromPlan: the block needs an entry and a stop');
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('orderFromPlan: there is no current price to place this against');
  }

  const { entry, stop } = plan;
  const target = Number.isFinite(plan.target) ? plan.target : null;

  /* The stop decides the direction, not the target: it is the leg the drag
   * itself produced, and the one that has to exist for the trade to be sized
   * at all. */
  if (stop === entry) {
    throw new Error('This block has its stop on the entry, so the trade has no risk '
      + 'to size against — move the stop.');
  }
  const long = stop < entry;
  const side = long ? 'buy' : 'sell';

  if (target != null && target !== entry && (target > entry) !== long) {
    throw new Error('This block has its target on the same side as its stop, which is '
      + 'not a trade in either direction — move the target past the entry.');
  }

  const risk = Math.abs(entry - stop);
  const reward = target == null ? null : Math.abs(target - entry);

  if (mode === 'market') {
    return {
      side,
      type: 'market',
      price: null,
      /* Offsets, resolved against the actual fill. See the header. */
      bracket: {
        stopDistance: risk,
        ...(reward ? { targetDistance: reward } : {}),
      },
      risk,
      reward,
    };
  }

  return {
    side,
    /* Which side of the current price the entry sits on decides this. Buying
     * below the market is a limit, buying above it is a stop; an entry exactly
     * at the market is a limit, which is what fills on the next touch. */
    type: long
      ? (entry <= price ? 'limit' : 'stop')
      : (entry >= price ? 'limit' : 'stop'),
    price: entry,
    bracket: {
      stopLoss: stop,
      ...(target == null ? {} : { takeProfit: target }),
    },
    risk,
    reward,
  };
}

/**
 * The entry a size can be worked out from before the order exists.
 *
 * A resting order knows where it will fill. A market order fills at the last
 * price plus costs, so the last close stands in for it — a hair off, and right
 * for the one thing sizing needs it for: the distance to the stop is carried
 * as a number and is exact either way, and the estimate only reaches the
 * leverage ceiling.
 */
export function sizingEntry(spec, price) {
  return spec.type === 'market' ? price : spec.price;
}

/** The stop level a size should be worked out against, given that entry. */
export function sizingStop(spec, entry) {
  if (spec.bracket.stopLoss != null) return spec.bracket.stopLoss;
  return spec.side === 'buy'
    ? entry - spec.bracket.stopDistance
    : entry + spec.bracket.stopDistance;
}
