/* Broker — orders, fills, position and account state.
 *
 * This is the shared floor under both ways of using Midorii: in replay a human
 * clicks buy, in a backtest a strategy calls ctx.buy(). Both end up here, so a
 * result produced by hand and one produced by a bot are directly comparable.
 *
 * The intrabar problem
 * --------------------
 * On a 1h chart, a bar that touches both the stop and the target tells you
 * nothing about which came first. Most backtesters guess — usually by assuming
 * the stop hit first, which is honest but pessimistic, or the target, which
 * quietly inflates every result.
 *
 * Midorii does not have to guess. It stores 1m bars for everything, so a fill on
 * a 1h bar is resolved by walking that hour's sixty minutes in order and taking
 * whichever level is reached first. `subBars` carries those minutes.
 *
 * Where no finer data exists — a strategy running on the 1m base timeframe —
 * the order of events inside the minute is genuinely unknowable, and the
 * pessimistic rule applies: the fill that hurts the position happens first.
 * `fill.resolution` records which of the two applied, so a result can always
 * be traced back to how it was decided.
 *
 * Why this is in shared/ and not beside the backtest engine
 * ---------------------------------------------------------
 * Because replay is the other half of the sentence at the top. A backtest runs
 * in the main process, where the bars already are; a replay runs in the
 * renderer, because a click has to become an order and a drawn chart in the
 * same frame rather than after a round trip. Both need this class, and the
 * renderer cannot reach into electron/ — so the class that both of them stand
 * on belongs where both of them can import it, which is here.
 *
 * There are no Node imports below, and there must not be: this file is bundled
 * into the renderer.
 */

let nextId = 1;

export const SIDE = { BUY: 'buy', SELL: 'sell' };

/** Costs are per-instrument and belong to the account, not to an order. */
export const DEFAULT_COSTS = {
  /** Round-trip commission per side, as a fraction of notional. 0.001 = 0.1%. */
  feeRate: 0.001,
  /** Full bid/ask spread as a fraction of price. Half is paid on each side. */
  spreadPct: 0.0002,
  /** Extra adverse move on market and triggered stop orders. */
  slippagePct: 0.0002,
};

/**
 * How a fill that is not aimed at an existing position is read.
 *
 * `netting` is what an exchange account does and what every strategy in here
 * is written against: there is one position, and an order in the other
 * direction reduces or reverses it.
 *
 * `hedging` is what a person doing a replay means. A second entry is a second
 * idea — a runner beside a scalp, a level added to — and averaging it into the
 * first destroys the only thing worth knowing afterwards: whether each of them
 * was right. So it stands beside the first, with its own entry, its own stop
 * and its own closed trade.
 */
export const POSITION_MODE = { NETTING: 'netting', HEDGING: 'hedging' };

let nextPositionId = 1;

export class Broker {
  /**
   * @param {object} [options]
   * @param {number} [options.balance=10000]  starting cash, in quote currency
   * @param {object} [options.costs]          overrides for DEFAULT_COSTS
   * @param {'netting'|'hedging'} [options.mode='netting']  see POSITION_MODE
   */
  constructor(options = {}) {
    const { balance = 10_000, costs = {}, mode = POSITION_MODE.NETTING } = options;

    if (mode !== POSITION_MODE.NETTING && mode !== POSITION_MODE.HEDGING) {
      throw new Error(`Broker: mode must be "netting" or "hedging", got ${JSON.stringify(mode)}`);
    }
    this.mode = mode;

    if (!(balance > 0)) throw new Error(`Broker: starting balance must be positive, got ${balance}`);

    this.initialBalance = balance;
    this.balance = balance;
    this.costs = { ...DEFAULT_COSTS, ...costs };

    for (const key of ['feeRate', 'spreadPct', 'slippagePct']) {
      const v = this.costs[key];
      if (!Number.isFinite(v) || v < 0) throw new Error(`Broker: ${key} must be a number >= 0, got ${v}`);
    }

    /** @type {Array<object>} orders still waiting to fill */
    this.pending = [];
    /** @type {Array<object>} every order ever placed, in order */
    this.orders = [];
    /** @type {Array<object>} every fill, in order */
    this.fills = [];
    /** @type {Array<object>} closed round trips */
    this.trades = [];

    /**
     * Open positions, oldest first. size > 0 is long, < 0 is short.
     *
     * Netting mode never holds more than one, so `position` below is simply
     * it and everything written before there could be more than one keeps
     * working unchanged. Hedging mode is the reason this is a list.
     */
    this.positions = [];

    this.time = null;      // current bar time
    this.lastPrice = null; // last close seen, for mark-to-market
  }

  /* ─── Account ─────────────────────────────────────────────────────────── */

  /**
   * The position — the only one in netting mode, the oldest open one in
   * hedging mode. Callers that mean all of them read `positions`.
   */
  get position() {
    return this.positions[0] ?? null;
  }

  /** Cash plus every open position's unrealised result. */
  get equity() {
    return this.balance + this.unrealizedPnl;
  }

  get unrealizedPnl() {
    if (this.lastPrice == null) return 0;
    let sum = 0;
    for (const position of this.positions) {
      sum += (this.lastPrice - position.entryPrice) * position.size;
    }
    return sum;
  }

  /** What one position is worth right now, marked to the last price. */
  positionPnl(position) {
    if (!position || this.lastPrice == null) return 0;
    return (this.lastPrice - position.entryPrice) * position.size;
  }

  positionById(id) {
    return this.positions.find((p) => p.id === id) ?? null;
  }

  /** Long minus short across everything open — the exposure, in base units. */
  get netSize() {
    return this.positions.reduce((sum, p) => sum + p.size, 0);
  }

  get isFlat() {
    return this.positions.length === 0;
  }

  /* ─── Order placement ─────────────────────────────────────────────────── */

  /**
   * Places an order. It never fills on the bar that placed it — the earliest
   * possible fill is the next bar, which is what stops a strategy from trading
   * on a close it could not have known in time.
   *
   * The one exception is a market order a person sent by hand, which `fillNow`
   * takes at the last price the moment it is placed. It is a separate call for
   * exactly that reason: nothing on this path can bend the rule by itself.
   *
   * @param {object} spec
   * @param {'buy'|'sell'} spec.side
   * @param {'market'|'limit'|'stop'} [spec.type='market']
   * @param {number} spec.size            in base units, always positive
   * @param {number} [spec.limitPrice]    required for limit orders
   * @param {number} [spec.stopPrice]     required for stop orders
   * @param {boolean} [spec.reduceOnly]   may only shrink an open position
   * @param {string} [spec.tag]           free label, e.g. 'stop-loss'
   * @param {number} [spec.parentId]      cancelled together with its siblings
   * @param {number} [spec.positionId]    the position this acts on. Only
   *   hedging mode needs it: with several positions open, "reduce" has to say
   *   which one, or a stop belonging to one trade would close another.
   * @param {object} [spec.bracket]       protection to attach the moment it
   *   fills — see `_attachBracket`. Each leg is either an absolute price
   *   (`stopLoss`, `takeProfit`) or a distance from the fill (`stopDistance`,
   *   `targetDistance`), never both.
   */
  placeOrder(spec) {
    const {
      side, type = 'market', size, limitPrice, stopPrice,
      reduceOnly = false, tag = null, parentId = null, bracket = null,
      positionId = null,
    } = spec;

    if (side !== SIDE.BUY && side !== SIDE.SELL) {
      throw new Error(`placeOrder: side must be "buy" or "sell", got ${JSON.stringify(side)}`);
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`placeOrder: size must be a positive number, got ${size}`);
    }
    if (type === 'limit' && !Number.isFinite(limitPrice)) {
      throw new Error('placeOrder: a limit order needs a limitPrice');
    }
    if (type === 'stop' && !Number.isFinite(stopPrice)) {
      throw new Error('placeOrder: a stop order needs a stopPrice');
    }
    if (!['market', 'limit', 'stop'].includes(type)) {
      throw new Error(`placeOrder: unknown order type "${type}"`);
    }
    if (bracket) validateBracket(bracket);

    const order = {
      id: nextId++,
      side,
      type,
      size,
      limitPrice: limitPrice ?? null,
      stopPrice: stopPrice ?? null,
      reduceOnly,
      tag,
      parentId,
      positionId,
      /* Attached on fill rather than now. Null on every order that carries no
       * protection, which is most of them. */
      bracket: bracket ?? null,
      status: 'pending',
      placedAt: this.time,
      filledAt: null,
      fillPrice: null,
      fee: null,
    };

    this.orders.push(order);
    this.pending.push(order);
    return order;
  }

  cancelOrder(id) {
    const i = this.pending.findIndex((o) => o.id === id);
    if (i === -1) return false;
    const [order] = this.pending.splice(i, 1);
    order.status = 'cancelled';
    return true;
  }

  /**
   * Moves a resting order, without cancelling and replacing it.
   *
   * Cancel-and-replace was the only way to move a level here, and it lies
   * about two things: the new order is a different id, so anything holding the
   * old one — a drawing, a bracket sibling, a row in the panel — loses it; and
   * for a moment there is no protection in the market at all. Neither is true
   * of what a broker's ticket does when a stop is dragged, which is amend the
   * order that is already there.
   *
   * Only a resting order can be amended: a filled one is history and a
   * cancelled one is gone. Size may only be reduced — growing a resting entry
   * would be a new decision at an old price, taken at whatever the market has
   * done since, and that is a new order.
   *
   * @param {number} id
   * @param {object} patch  any of limitPrice, stopPrice, size
   * @returns {object} the amended order
   */
  modifyOrder(id, patch = {}) {
    const order = this.pending.find((o) => o.id === id);
    if (!order) throw new Error(`modifyOrder: no pending order with id ${id}`);

    const { limitPrice, stopPrice, size } = patch;

    if (limitPrice != null) {
      if (order.type !== 'limit') {
        throw new Error(`modifyOrder: order ${id} is a ${order.type} order and has no limit price`);
      }
      if (!Number.isFinite(limitPrice)) {
        throw new Error(`modifyOrder: limitPrice must be a finite number, got ${limitPrice}`);
      }
      order.limitPrice = limitPrice;
    }

    if (stopPrice != null) {
      if (order.type !== 'stop') {
        throw new Error(`modifyOrder: order ${id} is a ${order.type} order and has no stop price`);
      }
      if (!Number.isFinite(stopPrice)) {
        throw new Error(`modifyOrder: stopPrice must be a finite number, got ${stopPrice}`);
      }
      order.stopPrice = stopPrice;
    }

    if (size != null) {
      if (!(size > 0)) throw new Error(`modifyOrder: size must be positive, got ${size}`);
      if (size > order.size) {
        throw new Error(
          'modifyOrder: an order can be cut down but not grown — a larger size at the '
          + 'old price is a new decision, so place a new order',
        );
      }
      order.size = size;
    }

    return order;
  }

  /** Cancels every pending order, optionally only those with a given tag. */
  cancelAll(tag = null) {
    const keep = [];
    for (const order of this.pending) {
      if (tag === null || order.tag === tag) order.status = 'cancelled';
      else keep.push(order);
    }
    const cancelled = this.pending.length - keep.length;
    this.pending = keep;
    return cancelled;
  }

  /**
   * Market entry with optional protective orders attached. The stop and target
   * are placed immediately and cancel each other when one of them fills, so a
   * position is never left with a stray order behind it.
   */
  submitEntry({ side, size, stopLoss, takeProfit, tag = null }) {
    // Catch a bad protective level here, where the caller can still see which
    // of the two it was, rather than inside the generic order validation.
    if (stopLoss != null && !Number.isFinite(stopLoss)) {
      throw new Error(`submitEntry: stopLoss must be a finite number, got ${stopLoss}`);
    }
    if (takeProfit != null && !Number.isFinite(takeProfit)) {
      throw new Error(`submitEntry: takeProfit must be a finite number, got ${takeProfit}`);
    }

    const entry = this.placeOrder({ side, size, type: 'market', tag });
    /* Remembered on the entry order so the closed trade can carry them. The
     * protective orders themselves are gone by then — one filled, the other was
     * cancelled — and a review that wants to draw the bracket would otherwise
     * have to reconstruct it from an order log nothing stores. */
    entry.stopLoss = stopLoss ?? null;
    entry.takeProfit = takeProfit ?? null;
    const exitSide = side === SIDE.BUY ? SIDE.SELL : SIDE.BUY;

    if (stopLoss != null) {
      this.placeOrder({
        side: exitSide, size, type: 'stop', stopPrice: stopLoss,
        reduceOnly: true, tag: 'stop-loss', parentId: entry.id,
      });
    }
    if (takeProfit != null) {
      this.placeOrder({
        side: exitSide, size, type: 'limit', limitPrice: takeProfit,
        reduceOnly: true, tag: 'take-profit', parentId: entry.id,
      });
    }
    return entry;
  }

  /**
   * Closes a position at market — all of it, or part.
   *
   * Taking part off is not a convenience: it is most of what managing a trade
   * consists of. Half at the first target and a runner behind it is a
   * different trade from either of the two whole ones, and a session that can
   * only be all-in or flat cannot practise it.
   *
   * The part that goes is a closed trade in its own right, with the entry it
   * was opened at and the price it left at; what stays keeps that same entry.
   * That is how the two halves of a scale-out end up in the same list as
   * everything else, each judged on what it actually did.
   *
   * @param {string} [tag]
   * @param {object} [options]
   * @param {number} [options.size]        base units to close; all of it when absent
   * @param {number} [options.positionId]  which one, where several are open
   */
  closePosition(tag = 'close', options = {}) {
    const { size = null, positionId = null } = options;

    const position = positionId == null ? this.position : this.positionById(positionId);
    if (!position) return null;

    const open = Math.abs(position.size);
    if (size != null && !(size > 0)) {
      throw new Error(`closePosition: size must be a positive number, got ${size}`);
    }
    const amount = size == null ? open : Math.min(size, open);

    const side = position.size > 0 ? SIDE.SELL : SIDE.BUY;
    return this.placeOrder({
      side, size: amount, type: 'market', reduceOnly: true, tag, positionId: position.id,
    });
  }

  /** A market close for every open position, as one order each. */
  flatten(tag = 'flatten') {
    return this.positions.map((p) => this.closePosition(tag, { positionId: p.id }));
  }

  /* ─── Managing what is open ───────────────────────────────────────────── */

  /**
   * Puts a stop and a target on an open position, replacing what it had.
   *
   * The orders that are already there are *amended* where they can be, rather
   * than cancelled and replaced. A stop moved by cancel-and-replace is a new
   * id — so anything holding the old one loses it — and for the moment in
   * between there is no protection in the market at all. Neither is what
   * happens when a stop is dragged on a real ticket.
   *
   * Both legs are grouped under the position's entry order, so whichever of
   * them fills retires the other however often they have been moved since.
   *
   * A level given as null removes that leg. Passing neither is refused rather
   * than read as "remove both": clearing protection is a decision, and it
   * should look like one at the call site.
   *
   * @param {object} position
   * @param {{stopLoss?: ?number, takeProfit?: ?number}} levels
   */
  protect(position, levels = {}) {
    if (!position) throw new Error('protect: there is no position to protect');
    if (!('stopLoss' in levels) && !('takeProfit' in levels)) {
      throw new Error('protect: give a stopLoss, a takeProfit, or both');
    }

    for (const key of ['stopLoss', 'takeProfit']) {
      const value = levels[key];
      if (value != null && !Number.isFinite(value)) {
        throw new Error(`protect: ${key} must be a finite number or null, got ${value}`);
      }
    }

    if ('stopLoss' in levels) this._setLeg(position, 'stop-loss', levels.stopLoss);
    if ('takeProfit' in levels) this._setLeg(position, 'take-profit', levels.takeProfit);
    return position;
  }

  /**
   * What this position would come out at, net, if it closed at a price.
   *
   * Every level on a position is an exit at a price, so every level is worth
   * exactly this: what a stop costs if it fills, what a target makes if it
   * fills, and — where it comes out at zero — where break-even is. One
   * function for all of them, so the number a tag prints beside a level and
   * the level `breakEven` places can never disagree.
   *
   * Net, not gross. The commission on the way in has already been paid and
   * comes off here; the way out costs the fee again plus half the spread, and
   * slippage on top wherever the exit takes liquidity — which a stop does and
   * a resting target does not. That is the whole reason a stop on the entry is
   * a loss rather than a wash.
   *
   * The open P&L on a position is gross and marked to the last price, which is
   * a different question and stays a different number: nothing has been paid
   * on the way out of a trade that is still running. This one is only ever
   * asked about an exit.
   *
   * @param {object} position
   * @param {number} price                      where it would close
   * @param {object} [options]
   * @param {boolean} [options.takesLiquidity]  true for a stop, false for a limit
   */
  exitResult(position, price, { takesLiquidity = true } = {}) {
    if (!position) throw new Error('exitResult: there is no position');
    if (!Number.isFinite(price)) {
      throw new Error(`exitResult: price must be a finite number, got ${price}`);
    }

    const { feeRate, spreadPct, slippagePct } = this.costs;
    const long = position.size > 0;
    const cost = spreadPct / 2 + (takesLiquidity ? slippagePct : 0);
    // The same fill an exit order would actually get — see _executeOrder.
    const fill = price * (long ? 1 - cost : 1 + cost);

    const gross = (fill - position.entryPrice) * position.size;
    return gross - position.fees - Math.abs(position.size) * fill * feeRate;
  }

  /**
   * The price at which this position comes out at nothing.
   *
   * Not the entry. The entry is where it came in *before* costs: the
   * commission on the way in is already paid, and getting out costs the fee
   * again plus half the spread and the slippage a stop pays for taking
   * liquidity. A "break-even" stop sitting on the entry is therefore a small
   * loss, every time, and the whole point of moving it is to stop that.
   *
   * Solved rather than estimated. The obvious form — take the entry and add
   * what an exit at the entry would cost — charges the exit fee on the wrong
   * price, because the fill it is charged on is this level and not the entry.
   * The error is a fraction of a fee, which is small and is also exactly the
   * size of the number this is supposed to produce: a break-even that comes
   * out at −0.10 is not a break-even. So this is the inverse of `exitResult`,
   * and `exitResult(p, breakEvenPrice(p))` is zero.
   */
  breakEvenPrice(position) {
    if (!position) throw new Error('breakEvenPrice: there is no position');
    const { feeRate, spreadPct, slippagePct } = this.costs;
    const size = Math.abs(position.size);

    const paid = size > 0 ? position.fees / size : 0;
    const cost = spreadPct / 2 + slippagePct;

    return position.size > 0
      ? (position.entryPrice + paid) / ((1 - cost) * (1 - feeRate))
      : (position.entryPrice - paid) / ((1 + cost) * (1 + feeRate));
  }

  /**
   * Why this position cannot be moved to break-even yet, or null when it can.
   *
   * Break-even for a long sits *above* the entry — the fee on the way in is
   * paid and the way out costs the fee again plus the spread — so a trade
   * that is only a little in front has its break-even level above the last
   * price. A sell stop up there is not protection: it is marketable the moment
   * it is live, and the next bar closes the trade at its open, for a loss. The
   * button would then have done the exact opposite of what it says.
   *
   * The same rule the chart applies to a stop dragged through the market
   * (`levelRefusal` in replayLevels.js), and against the same last close: the
   * bar that would fill it is the next one and nobody has seen it. Strictly in
   * front, so a level landing exactly on the last price is refused too —
   * which side of it the next open falls is a coin toss.
   *
   * Answered rather than thrown so the panel can grey the button and say why,
   * instead of offering an action that can only fail. `breakEven` throws it.
   */
  breakEvenRefusal(position) {
    if (!position) return 'There is no position to move to break-even.';
    if (this.lastPrice == null) return null;

    const price = this.breakEvenPrice(position);
    const long = position.size > 0;
    if (long ? price < this.lastPrice : price > this.lastPrice) return null;

    return 'This trade is not far enough in front to come out flat: break-even is at '
      + `${Number(price.toPrecision(8))} and the market is at `
      + `${Number(this.lastPrice.toPrecision(8))}. A stop there would close the `
      + `${long ? 'long' : 'short'} at market on the next bar, not protect it.`;
  }

  /** Moves the stop to where the trade comes out flat after costs. */
  breakEven(position) {
    const refusal = this.breakEvenRefusal(position);
    if (refusal) throw new Error(refusal);
    return this.protect(position, { stopLoss: this.breakEvenPrice(position) });
  }

  /**
   * Follows price with the stop, at a fixed distance behind it.
   *
   * The distance is in price, not percent, because that is what the stop is:
   * where the trade is wrong. It is measured from the *extreme reached so far*
   * and only ever moves the stop in the position's favour — a trailing stop
   * that could also loosen would be a way of quietly widening a loss.
   *
   * `activateAt` holds it off until price has traded through a level, which is
   * how a trail is normally used: leave the original stop where it was
   * until the trade has proved something, then follow.
   *
   * Where it happens inside a bar is `_trail`, and it matters: the stop is
   * pulled up *after* that bar's fills have been settled, never before. Doing
   * it the other way round would let the high of a bar drag the stop up out of
   * the way of the low that would have hit it — a look-ahead that flatters
   * every trailing result ever measured.
   *
   * @param {object} position
   * @param {?number} distance    price units behind the extreme; null turns it off
   * @param {object} [options]
   * @param {?number} [options.activateAt]  price that has to trade first
   */
  setTrailing(position, distance, options = {}) {
    if (!position) throw new Error('setTrailing: there is no position');

    if (distance == null) {
      position.trailing = null;
      return position;
    }
    if (!(distance > 0)) {
      throw new Error(`setTrailing: distance must be a positive number, got ${distance}`);
    }

    const { activateAt = null } = options;
    if (activateAt != null && !Number.isFinite(activateAt)) {
      throw new Error(`setTrailing: activateAt must be a finite number, got ${activateAt}`);
    }

    position.trailing = {
      distance,
      activateAt,
      armed: activateAt == null,
      /* The best price seen since the trail was set — not since the position
       * was opened. A trail switched on now cannot claim ground the trade gave
       * back before anyone asked for it. */
      extreme: this.lastPrice ?? position.entryPrice,
    };
    return position;
  }

  /**
   * Fills a market order at the last price, instead of on the next bar.
   *
   * The next-bar rule above exists to stop a *strategy* trading on a close it
   * could not have reacted to in time. A person clicking Buy in a replay is in
   * the opposite position: the close under the playhead is the last price on
   * the screen, and a market order sent at that moment takes it, plus spread
   * and slippage — that is what a market order is. Making the click wait for
   * the next bar's open charges it whatever the gap happened to be for a
   * decision that was already made, and leaves the chart with no position on
   * it to hang a stop off until the bar arrives.
   *
   * So this is the one door out of the rule, and it is deliberately a separate
   * call rather than a mode: `processBar` cannot reach it, and only a caller
   * holding a market order in its hand can push it through. In practice that
   * is ReplaySession and nothing else. A backtest never calls it, and its
   * fills still come from the bar after the decision.
   *
   * Everything else is the ordinary fill path — the same costs, the same
   * position arithmetic, the same bracket attached on the way in. Only the
   * price and the moment differ, and `fill.resolution` says 'immediate' so a
   * fill decided this way is never mistaken for one a bar decided.
   *
   * @param {object} order  a pending market order from `placeOrder`
   * @returns {object} that order, filled — or cancelled, where a reduceOnly
   *   order found nothing left to close.
   */
  fillNow(order) {
    if (order.type !== 'market') {
      throw new Error(`fillNow: only a market order fills on the spot, got "${order.type}"`);
    }
    if (order.status !== 'pending') {
      throw new Error(`fillNow: this order is already ${order.status}`);
    }
    if (!Number.isFinite(this.lastPrice)) {
      throw new Error('fillNow: there is no price yet to fill against');
    }

    this._executeOrder(order, this.lastPrice, { time: this.time }, 'immediate');
    return order;
  }

  /* ─── Bar processing ──────────────────────────────────────────────────── */

  /**
   * Advances the broker by one bar: fills what this bar makes fillable, then
   * marks the position to the close.
   *
   * @param {object} bar               the strategy-timeframe bar
   * @param {Array<object>} [subBars]  the 1m bars inside it, in order
   */
  processBar(bar, subBars = null) {
    this.time = bar.time;

    /* A trailing stop has to be walked through the bar even with nothing
     * pending: the trail is what places the stop order in the first place. */
    const busy = () => this.pending.length > 0 || this.positions.some((p) => p.trailing);

    if (busy()) {
      // With sub-bars the sequence inside the bar is known and fills happen in
      // real order. Without them, one pass over the bar decides everything.
      const steps = subBars && subBars.length > 0 ? subBars : [bar];
      const resolution = steps === subBars ? 'intrabar' : 'pessimistic';

      for (const step of steps) {
        if (!busy()) break;
        this._fillAgainst(step, resolution);
        // After the fills of this step, never before — see `setTrailing`.
        this._trail(step);
      }
    }

    this.lastPrice = bar.close;
  }

  /** Runs every pending order against one price step. */
  _fillAgainst(step, resolution) {
    // Snapshot: a fill can cancel siblings, and that must not disturb this pass.
    const candidates = [...this.pending];
    const triggered = [];

    for (const order of candidates) {
      if (order.status !== 'pending') continue;
      const price = this._triggerPrice(order, step);
      if (price === null) continue;
      triggered.push({ order, price });
    }

    if (triggered.length === 0) return;

    /* Two orders triggering in the same step is exactly the ambiguous case.
     * Without sub-bars, settle it against the position: the order that hurts
     * fills first. Never in the strategy's favour — that is how a backtest
     * starts flattering itself. */
    if (triggered.length > 1 && resolution === 'pessimistic') {
      triggered.sort((a, b) => this._adverseRank(b.order, b.price) - this._adverseRank(a.order, a.price));
    }

    for (const { order, price } of triggered) {
      if (order.status !== 'pending') continue; // cancelled by an earlier fill
      this._executeOrder(order, price, step, resolution);
    }
  }

  /**
   * The price at which an order becomes fillable within this step, or null.
   *
   * A gap through the level fills at the open, not at the level — that is the
   * whole point of a gap, and pretending otherwise understates risk.
   */
  _triggerPrice(order, step) {
    switch (order.type) {
      case 'market':
        return step.open;

      case 'limit':
        if (order.side === SIDE.BUY) {
          if (step.open <= order.limitPrice) return step.open; // gapped below: better fill
          return step.low <= order.limitPrice ? order.limitPrice : null;
        }
        if (step.open >= order.limitPrice) return step.open;
        return step.high >= order.limitPrice ? order.limitPrice : null;

      case 'stop':
        if (order.side === SIDE.BUY) {
          if (step.open >= order.stopPrice) return step.open; // gapped through
          return step.high >= order.stopPrice ? order.stopPrice : null;
        }
        if (step.open <= order.stopPrice) return step.open;
        return step.low <= order.stopPrice ? order.stopPrice : null;

      default:
        throw new Error(`Unknown order type: ${order.type}`);
    }
  }

  /** How bad this fill is for the position it acts on — higher fills first. */
  _adverseRank(order, price) {
    const position = this._resolvePosition(order) ?? this.position;
    if (!position) return 0;
    const closing = Math.sign(position.size) !== (order.side === SIDE.BUY ? 1 : -1);
    if (!closing) return 0;
    // Closing a long lower is worse; closing a short higher is worse.
    return position.size > 0 ? -price : price;
  }

  _executeOrder(order, rawPrice, step, resolution) {
    const { spreadPct, slippagePct, feeRate } = this.costs;
    const dir = order.side === SIDE.BUY ? 1 : -1;

    // Half the spread is paid on every fill; slippage only where the fill is
    // taken at whatever the market offers.
    const takesLiquidity = order.type === 'market' || order.type === 'stop';
    const cost = spreadPct / 2 + (takesLiquidity ? slippagePct : 0);
    const fillPrice = rawPrice * (1 + dir * cost);

    let size = order.size;
    if (order.reduceOnly) {
      const open = this._openSizeFor(order);
      if (open === 0) {
        // The position is already gone — this is the sibling of a filled exit.
        this._removePending(order);
        order.status = 'cancelled';
        return;
      }
      size = Math.min(size, open);
    }

    const notional = size * fillPrice;
    const fee = notional * feeRate;

    order.status = 'filled';
    order.filledAt = step.time ?? this.time;
    order.fillPrice = fillPrice;
    order.fee = fee;
    this._removePending(order);

    this.balance -= fee;

    const fill = {
      orderId: order.id,
      time: order.filledAt,
      side: order.side,
      size,
      price: fillPrice,
      fee,
      tag: order.tag,
      resolution,
      /* Carried from the entry order, where submitEntry recorded them, so the
       * position and then the closed trade can keep the bracket. Null on every
       * fill that is not an entry, which is what a stop or target fill is. */
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
    };
    this.fills.push(fill);

    const position = this._applyToPosition(fill, order);

    // Protection an entry was carrying goes in now that there is a position.
    if (order.bracket) this._attachBracket(order, fill, position);

    // A filled bracket leg retires its siblings.
    if (order.parentId != null || order.tag === 'stop-loss' || order.tag === 'take-profit') {
      this._cancelSiblings(order);
    }
  }

  /**
   * Places the stop and target an entry was carrying, now that it has filled.
   *
   * Why this exists at all
   * ----------------------
   * `submitEntry` can place a bracket up front because a market entry fills on
   * the very next bar. A *resting* entry cannot: a stop and a target sitting in
   * the market against a position that does not exist yet would either open a
   * trade in the wrong direction, or — being reduceOnly — quietly cancel
   * themselves the first time price reached one of them, leaving the entry to
   * fill later with nothing behind it.
   *
   * So the levels ride along on the order and become real orders here, at the
   * moment the position does. That is also what an exchange does with an
   * attached OCO.
   *
   * When they become live
   * ---------------------
   * `_fillAgainst` snapshots the pending orders before it starts, so these are
   * not considered on the step that placed them — they are live from the next
   * one. With sub-bars that is the next minute of the same bar, which is close
   * to how quickly real protection arms. Without them it is the next bar, and
   * on that one bar the trade is unprotected in its own favour. That is the
   * same one-step delay every order in this engine is subject to, and the fill
   * still records the resolution it was decided under.
   *
   * An entry pushed through by `fillNow` lands outside any pass at all, so its
   * protection is simply pending when the next bar is processed. Which is the
   * honest answer there too: the bar under the playhead has already closed, so
   * nothing placed now could have been in the market during it.
   *
   * Distances, not just levels
   * --------------------------
   * A leg given as a distance is measured from the price this actually filled
   * at, spread and slippage included, so a plan drawn as "risk 500" costs 500
   * however far the market gapped on the way in. A leg given as a price is used
   * as it stands. The two forms are mutually exclusive per leg — see
   * `validateBracket`.
   */
  _attachBracket(order, fill, position) {
    // Nothing opened — a reduceOnly fill, or one that closed out instead.
    if (!position) return;

    const long = position.size > 0;
    const dir = long ? 1 : -1;
    const { stopLoss, takeProfit, stopDistance, targetDistance } = order.bracket;

    const stop = stopLoss ?? (stopDistance == null ? null : fill.price - dir * stopDistance);
    const target = takeProfit ?? (targetDistance == null ? null : fill.price + dir * targetDistance);
    if (stop == null && target == null) return;

    const exitSide = long ? SIDE.SELL : SIDE.BUY;
    const size = fill.size;

    /* Both under the entry's id, so whichever fills retires the other — the
     * same grouping submitEntry uses, and the reason a position is never left
     * with a stray order behind it. */
    if (stop != null) {
      this.placeOrder({
        side: exitSide, size, type: 'stop', stopPrice: stop,
        reduceOnly: true, tag: 'stop-loss', parentId: order.id, positionId: position.id,
      });
    }
    if (target != null) {
      this.placeOrder({
        side: exitSide, size, type: 'limit', limitPrice: target,
        reduceOnly: true, tag: 'take-profit', parentId: order.id, positionId: position.id,
      });
    }

    /* The position keeps them too, because that is what the closed trade
     * carries and what a review draws the bracket from. */
    position.stopLoss = stop;
    position.takeProfit = target;
    this._rememberRisk(position);
  }

  /* ─── Positions ───────────────────────────────────────────────────────── */

  /**
   * Which open position an order acts on, or null for "whatever is open".
   *
   * Named directly by `positionId` where the caller knew it, and otherwise
   * through the entry order the bracket was hung under — `submitEntry` places
   * a stop and a target before the position they protect exists, so the entry
   * order's id is the only handle they can carry.
   */
  _resolvePosition(order) {
    if (!order) return null;
    if (order.positionId != null) return this.positionById(order.positionId);
    if (order.parentId != null) {
      return this.positions.find((p) => p.entryOrderId === order.parentId) ?? null;
    }
    return null;
  }

  /**
   * The position a fill from this order lands on, or null for a new one.
   *
   * Netting mode always answers with the one position — exactly what it did
   * before there could be more than one, whatever the order says.
   *
   * Hedging mode answers with the position the order names. A named position
   * that is already gone answers null and closes nothing: the order is the
   * sibling of an exit that has filled, and must never reach across to another
   * trade. An unnamed order that only reduces takes the oldest position facing
   * the other way, which is first-in-first-out and the one rule nobody has to
   * look up. An unnamed order that could open is a new idea, and gets one.
   */
  _targetFor(order, signed) {
    if (this.mode === POSITION_MODE.NETTING) return this.position;

    const named = this._resolvePosition(order);
    if (named) return named;
    if (order?.positionId != null || order?.parentId != null) return null;

    if (order?.reduceOnly) {
      return this.positions.find((p) => Math.sign(p.size) !== Math.sign(signed)) ?? null;
    }
    return null;
  }

  /** How much a reduceOnly order is allowed to close. */
  _openSizeFor(order) {
    const signed = order.side === SIDE.BUY ? 1 : -1;
    const target = this._targetFor(order, signed);
    return target ? Math.abs(target.size) : 0;
  }

  /** A fresh position from the fill that opened it. */
  _openPosition(fill, order, { fees = fill.fee, size = fill.size } = {}) {
    const position = {
      id: nextPositionId++,
      /* The order that opened it, so a bracket placed before the position
       * existed can still be resolved to it. */
      entryOrderId: order?.id ?? null,
      size: fill.side === SIDE.BUY ? size : -size,
      entryPrice: fill.price,
      openedAt: fill.time,
      fees,
      entryFills: [fill],
      stopLoss: fill.stopLoss ?? null,
      takeProfit: fill.takeProfit ?? null,
      trailing: null,
      /**
       * What one unit of this position risked when it first had a stop.
       *
       * The ruler R is measured with, and it is set once and never moved. The
       * obvious alternative — measure against wherever the stop is now — makes
       * R useless the moment anyone uses it: a stop pulled to break-even
       * divides by almost nothing, and a trade that is 40 cents in front reads
       * as +23R. R is only worth anything as a fixed unit, and the unit is what
       * the trade was willing to lose when it was put on.
       *
       * Null until a stop exists, because until then it risked an amount
       * nobody had decided.
       */
      riskPerUnit: null,
      /* What the entry order was tagged with, carried to the closed trade.
       * Without it a finished trade only says how it ended — stop or target —
       * and never why it was taken, so a run cannot be broken down by
       * whatever the strategy grouped its entries under. */
      entryTag: fill.tag ?? null,
    };
    this._rememberRisk(position);
    this.positions.push(position);
    return position;
  }

  /**
   * Notes what a position risks per unit, the first time it has a stop.
   *
   * Called from every place a stop reaches a position — the entry that carried
   * one, the bracket that attaches after a resting entry fills, and every later
   * amendment including the trail's. Only the first one is kept: the others are
   * the trade being managed, and managing it is exactly what must not change
   * the unit its result is measured in.
   */
  _rememberRisk(position) {
    if (position.riskPerUnit != null || position.stopLoss == null) return;
    const distance = Math.abs(position.entryPrice - position.stopLoss);
    if (distance > 0) position.riskPerUnit = distance;
  }

  /** Books a closed round trip against a position. */
  _recordTrade(position, fill, closing) {
    const closedSize = closing * Math.sign(position.size);
    const pnl = (fill.price - position.entryPrice) * closedSize;

    this.balance += pnl;

    this.trades.push({
      side: position.size > 0 ? 'long' : 'short',
      size: closing,
      entryPrice: position.entryPrice,
      exitPrice: fill.price,
      openedAt: position.openedAt,
      closedAt: fill.time,
      pnl,
      fees: position.fees,
      netPnl: pnl - position.fees,
      entryTag: position.entryTag ?? null,
      stopLoss: position.stopLoss ?? null,
      takeProfit: position.takeProfit ?? null,
      /* What it risked per unit to begin with, so its result can be stated in
       * R afterwards. Not derivable from `stopLoss` above: that is where the
       * stop was when the trade ended, which for anything managed to
       * break-even is a distance of almost nothing. */
      riskPerUnit: position.riskPerUnit ?? null,
      exitTag: fill.tag,
    });

    return pnl;
  }

  /**
   * Retires a position, and the protection that was standing behind it.
   *
   * The orders had to go too, and used not to. A stop and a target are
   * reduceOnly, so once their position is gone they close nothing — they wait
   * in the book until price happens to touch one, notice there is nothing left
   * to reduce, and cancel themselves. Harmless to the account, and wrong
   * everywhere a person looks: a chart drawing a stop line under a position
   * that was closed by hand two minutes ago, and a working-orders list
   * offering to cancel protection for a trade that is over.
   *
   * They are collected before the position leaves the list, because
   * `_resolvePosition` finds them by looking for it.
   */
  _closePosition(position) {
    const orphaned = this.pending.filter(
      (o) => o.reduceOnly && this._resolvePosition(o) === position,
    );

    const i = this.positions.indexOf(position);
    if (i !== -1) this.positions.splice(i, 1);

    for (const order of orphaned) this.cancelOrder(order.id);
  }

  _removePending(order) {
    const i = this.pending.indexOf(order);
    if (i !== -1) this.pending.splice(i, 1);
  }

  _cancelSiblings(order) {
    const group = order.parentId ?? order.id;
    for (const other of [...this.pending]) {
      if (other.id === order.id) continue;
      if ((other.parentId ?? other.id) === group) {
        this._removePending(other);
        other.status = 'cancelled';
      }
    }
  }

  /**
   * Applies a fill to the position it belongs to, realising P&L on the closed
   * part.
   *
   * @returns {?object} the position the fill left open, or null where it closed
   *   one out — that is what the bracket riding on an entry gets attached to.
   */
  _applyToPosition(fill, order = null) {
    const signed = fill.side === SIDE.BUY ? fill.size : -fill.size;
    const pos = this._targetFor(order, signed);

    if (!pos) {
      /* A reduceOnly fill with nothing left to reduce cannot open anything —
       * it would turn a stray exit into a fresh trade in the wrong direction.
       * `_executeOrder` already cancels those, so this is the belt to that
       * brace. */
      if (order?.reduceOnly) return null;
      return this._openPosition(fill, order);
    }

    const sameDirection = Math.sign(pos.size) === Math.sign(signed);

    if (sameDirection) {
      // Adding: the entry becomes the size-weighted average.
      const totalSize = pos.size + signed;
      pos.entryPrice = (pos.entryPrice * pos.size + fill.price * signed) / totalSize;
      pos.size = totalSize;
      pos.fees += fill.fee;
      pos.entryFills.push(fill);
      this._resizeProtection(pos);
      return pos;
    }

    // Reducing or reversing.
    const closing = Math.min(Math.abs(signed), Math.abs(pos.size));
    pos.fees += fill.fee;
    this._recordTrade(pos, fill, closing);

    const remaining = pos.size + signed;

    if (remaining === 0) {
      this._closePosition(pos);
      return null;
    }

    if (Math.sign(remaining) !== Math.sign(pos.size)) {
      // Reversed: what is left opens a fresh position in the other direction.
      this._closePosition(pos);
      // Fees up to here went with the closed trade, so the new one starts at 0.
      return this._openPosition(fill, order, { fees: 0, size: Math.abs(remaining) });
    }

    pos.size = remaining;
    pos.fees = 0; // fees up to here are settled with the closed trade
    this._resizeProtection(pos);
    return pos;
  }

  /* ─── Protection ──────────────────────────────────────────────────────── */

  /**
   * The pending orders protecting a position, by leg.
   *
   * Netting mode takes every order with that tag, because there is only one
   * position for them to belong to — including one orphaned by a reversal,
   * which would otherwise sit in the market against a trade it was never
   * placed for.
   */
  _protectionOrders(position, tag) {
    return this.pending.filter((o) => {
      if (o.tag !== tag || !o.reduceOnly) return false;
      if (this.mode === POSITION_MODE.NETTING) return true;
      return this._resolvePosition(o) === position;
    });
  }

  /**
   * Puts one leg of the protection where it has been asked for.
   *
   * An order that is already there is moved rather than replaced, so it keeps
   * its id and there is never a gap with nothing in the market. A null level
   * cancels the leg.
   */
  _setLeg(position, tag, price) {
    const existing = this._protectionOrders(position, tag);

    if (price == null) {
      for (const order of existing) this.cancelOrder(order.id);
    } else if (existing.length > 0) {
      const [keep, ...extra] = existing;
      for (const order of extra) this.cancelOrder(order.id);
      if (keep.type === 'stop') keep.stopPrice = price;
      else keep.limitPrice = price;
      keep.size = Math.abs(position.size);
    } else {
      const exitSide = position.size > 0 ? SIDE.SELL : SIDE.BUY;
      this.placeOrder({
        side: exitSide,
        size: Math.abs(position.size),
        type: tag === 'stop-loss' ? 'stop' : 'limit',
        ...(tag === 'stop-loss' ? { stopPrice: price } : { limitPrice: price }),
        reduceOnly: true,
        tag,
        positionId: position.id,
        /* Grouped under the entry order, so whichever leg fills retires the
         * other however often either has been moved since. A position opened
         * by a fill with no order behind it groups under itself. */
        parentId: position.entryOrderId,
      });
    }

    if (tag === 'stop-loss') position.stopLoss = price;
    else position.takeProfit = price;
    this._rememberRisk(position);
  }

  /**
   * Keeps the protection the same size as what it protects.
   *
   * A position that has been half closed leaves a stop for the whole of it in
   * the market. reduceOnly means it cannot do damage — it fills for whatever
   * is left — but it reads as a stop for a size that is no longer there, and
   * anything showing order sizes would be showing a number that is wrong.
   */
  _resizeProtection(position) {
    const size = Math.abs(position.size);
    for (const tag of ['stop-loss', 'take-profit']) {
      for (const order of this._protectionOrders(position, tag)) order.size = size;
    }
  }

  /**
   * Pulls trailing stops along with the price, once per step.
   *
   * Called after that step's fills, which is the whole correctness argument:
   * a stop is where the trade is wrong *now*, so it may only be moved by
   * prices that have already been given the chance to hit it. Trailing first
   * would let the high of a bar lift the stop out of the way of the low that
   * would have taken it out — the kind of look-ahead that makes every trailing
   * backtest look better than the trade would have been.
   */
  _trail(step) {
    for (const position of [...this.positions]) {
      const trail = position.trailing;
      if (!trail) continue;

      const long = position.size > 0;
      const extreme = long
        ? Math.max(trail.extreme, step.high)
        : Math.min(trail.extreme, step.low);
      trail.extreme = extreme;

      if (!trail.armed) {
        const reached = long ? step.high >= trail.activateAt : step.low <= trail.activateAt;
        if (!reached) continue;
        trail.armed = true;
      }

      const candidate = long ? extreme - trail.distance : extreme + trail.distance;
      const current = position.stopLoss;
      // Only ever in the position's favour.
      if (current != null && (long ? candidate <= current : candidate >= current)) continue;

      this._setLeg(position, 'stop-loss', candidate);
    }
  }

  /* ─── Putting it down and picking it up ───────────────────────────────── */

  /**
   * Everything about this account, as plain data.
   *
   * For a session that is stopped today and carried on tomorrow. Bars are not
   * in here — they are in the data store and can be fetched again — and
   * neither is anything with behaviour: what comes back has to survive a trip
   * through JSON and a different run of the program.
   *
   * Two kinds of identity have to survive it, because this class relies on
   * both: a pending order is the *same object* as its entry in `orders`, and a
   * position's entry fills are the same objects as their entries in `fills`.
   * Written out they become an id list and index lists, and `restore` ties
   * them back together — copies that merely looked alike would come apart the
   * first time an order was cancelled.
   */
  snapshot() {
    return {
      mode: this.mode,
      initialBalance: this.initialBalance,
      balance: this.balance,
      costs: { ...this.costs },
      orders: this.orders.map((o) => ({ ...o })),
      pendingIds: this.pending.map((o) => o.id),
      fills: this.fills.map((f) => ({ ...f })),
      trades: this.trades.map((t) => ({ ...t })),
      positions: this.positions.map((p) => {
        const { entryFills, trailing, ...rest } = p;
        return {
          ...rest,
          trailing: trailing ? { ...trailing } : null,
          entryFillIndexes: entryFills.map((f) => this.fills.indexOf(f)).filter((i) => i !== -1),
        };
      }),
      time: this.time,
      lastPrice: this.lastPrice,
    };
  }

  /** Rebuilds an account from `snapshot`. */
  static restore(data) {
    const broker = new Broker({
      balance: data.initialBalance, costs: data.costs, mode: data.mode,
    });

    broker.balance = data.balance;
    broker.time = data.time ?? null;
    broker.lastPrice = data.lastPrice ?? null;

    broker.orders = data.orders.map((o) => ({ ...o }));
    const byId = new Map(broker.orders.map((o) => [o.id, o]));
    broker.pending = (data.pendingIds ?? []).map((id) => byId.get(id)).filter((o) => o != null);

    broker.fills = data.fills.map((f) => ({ ...f }));
    broker.trades = data.trades.map((t) => ({ ...t }));
    broker.positions = (data.positions ?? []).map((p) => {
      const { entryFillIndexes = [], ...rest } = p;
      return {
        ...rest,
        trailing: p.trailing ? { ...p.trailing } : null,
        entryFills: entryFillIndexes.map((i) => broker.fills[i]).filter((f) => f != null),
      };
    });

    /* Ids only ever climb. A restored account keeps the ids its orders were
     * given, so the counter has to clear them — otherwise the next order
     * placed would carry an id that is already in the book. */
    for (const order of broker.orders) nextId = Math.max(nextId, order.id + 1);
    for (const position of broker.positions) {
      nextPositionId = Math.max(nextPositionId, position.id + 1);
    }

    return broker;
  }
}

/**
 * Checks a bracket before it is stored on an order.
 *
 * Refused here rather than at the fill, because that is the only moment the
 * caller can still see which of its own numbers was wrong. A bracket that
 * failed silently would leave an entry to fill hours later with no protection
 * behind it and nothing to say why.
 */
function validateBracket(bracket) {
  if (typeof bracket !== 'object') {
    throw new Error(`placeOrder: bracket must be an object, got ${typeof bracket}`);
  }

  const legs = [
    ['stopLoss', 'stopDistance'],
    ['takeProfit', 'targetDistance'],
  ];

  for (const [priceKey, distanceKey] of legs) {
    const price = bracket[priceKey];
    const distance = bracket[distanceKey];

    if (price != null && distance != null) {
      throw new Error(
        `placeOrder: give ${priceKey} or ${distanceKey}, not both — `
        + 'a level and an offset to the same level cannot both be the answer',
      );
    }
    if (price != null && !Number.isFinite(price)) {
      throw new Error(`placeOrder: ${priceKey} must be a finite number, got ${price}`);
    }
    if (distance != null && !(distance > 0)) {
      throw new Error(`placeOrder: ${distanceKey} must be a positive number, got ${distance}`);
    }
  }
}

/** Resets order and position ids — tests need runs to be reproducible. */
export function resetOrderIds() {
  nextId = 1;
  nextPositionId = 1;
}
