/* Live trading — the same account, against a feed that is still arriving.
 *
 * ReplaySession beside this file drives the Broker with an array of bars and a
 * playhead: it owns the future and hands it over one bar at a time. A live
 * account has no future to hand over. The feed pushes what has just happened,
 * repeatedly, and the only question this class answers is which part of that
 * push has not been played into the account yet.
 *
 * Why a bar update is not a bar
 * -----------------------------
 * A streaming feed re-sends the SAME forming bar on every tick, with its high
 * and low grown. Handing that whole bar to `processBar` on every tick would
 * offer the bar's extremes to the account again and again — so an order placed
 * a second after a spike would fill on that spike, at a price that had already
 * been and gone. That is look-ahead pointing backwards, and it is the one way
 * a paper account flatters itself without anybody noticing.
 *
 * So every update is reduced to the ground the market has covered SINCE the
 * last one: from the price the account was last marked at, through whatever
 * newly extended this bar's range, to the price now. Each price is therefore
 * offered to the book exactly once, which is the property the whole file is
 * for. Everything else — fills, costs, brackets, trailing stops — is the
 * Broker's, unchanged, so a paper trade and a backtest trade are still the
 * same call through the same rules.
 *
 * What it cannot see
 * ------------------
 * Between two updates the market may have travelled further than the two
 * prices show. Where the feed reports the forming bar's high and low, that
 * travel is caught — the extremes are part of the new ground; where it reports
 * only a price, it is not. A paper fill is therefore as good as the feed is
 * fast, and no better, which is the same limitation a real order has.
 */

import { Broker, POSITION_MODE, SIDE } from './broker.js';
import { summarize } from './summary.js';

/** How often the curve takes a point while nothing settles. Doubles as the curve fills —
 *  see {@link LiveSession._thin}. Fifteen minutes is ~670 points a week. */
const EQUITY_SAMPLE_MS = 15 * 60_000;

/** Where the curve starts thinning itself. At the starting sample rate this is about six
 *  months; past it the mark points halve and the rate halves with them, so an account that
 *  runs for years keeps its shape and every trade rather than its resolution. */
const MAX_EQUITY_POINTS = 20_000;

export class LiveSession {
  /**
   * @param {object} [options]
   * @param {number} [options.balance]            starting cash
   * @param {object} [options.costs]              Broker cost overrides
   * @param {'netting'|'hedging'} [options.mode]  how a second entry is read
   */
  constructor({ balance = 10_000, costs = {}, mode = POSITION_MODE.HEDGING } = {}) {
    this.broker = new Broker({ balance, costs, mode });

    /** Open time of the bar the account stands in, or null before the first update. */
    this.barTime = null;
    /** The highest and lowest this bar has been SEEN at — the edge of played ground. */
    this.seenHigh = null;
    this.seenLow = null;

    /** When the account was opened, and the first market instant it saw. Both survive a
     *  restart: an account that has been running a month should say so. */
    this.createdAt = Date.now();
    this.firstBarTime = null;
    /** Updates actually played — what the summary reports as its bar count. */
    this.barsPlayed = 0;

    /* The account over time.
     *
     * Two different jobs, deliberately kept apart. The peak and the worst drawdown are
     * measured on EVERY tick, because a drawdown that happened between two samples still
     * happened — they are two numbers, and sampling them would be reporting a smaller loss
     * than the account actually took. The CURVE is what gets drawn and stored, and that is
     * sampled: an account running for a month cannot keep a point per tick, and does not
     * need to. See {@link _recordEquity}. */
    this.peakEquity = this.broker.equity;
    this.maxDrawdown = 0;
    this.maxDrawdownPct = 0;
    this.sampleMs = EQUITY_SAMPLE_MS;
    this.equityCurve = [];
  }

  /** The newest price the account has been marked at, or null before the first update. */
  get price() {
    return this.broker.lastPrice;
  }

  /** Nothing open and nothing waiting — the account is free to move to another market. */
  get isIdle() {
    return this.broker.positions.length === 0 && this.broker.pending.length === 0;
  }

  /* --- The feed ------------------------------------------------------- */

  /**
   * Put the account on a price without letting anything fill on it.
   *
   * The first update of all goes through here: an account that was not running
   * when a bar happened has no business being filled by it, and the whole of
   * that bar would otherwise count as new ground. It is also how an account
   * moves to a market it has never seen.
   *
   * @param {object} bar  a bar (or bar update) from the feed
   */
  mark(bar) {
    this.broker.time = bar.time;
    this.broker.lastPrice = bar.close;
    this.barTime = bar.time;
    this.seenHigh = bar.high;
    this.seenLow = bar.low;
    this.firstBarTime ??= bar.time;
    this._recordEquity(bar.time);
  }

  /**
   * Play one update from the feed into the account.
   *
   * Only the ground covered since the last update is offered to the book — see
   * the note at the top of the file. Returns the step that was played, or null
   * where the update carried nothing new: the first update, which only marks,
   * and a late one for a bar the account has already left behind.
   *
   * @param {object} bar  the forming bar as it now stands, or a newly opened one
   * @returns {?object} the synthetic step handed to the Broker
   */
  onBar(bar) {
    if (!bar || !Number.isFinite(bar.close) || !Number.isFinite(bar.time)) {
      throw new Error('LiveSession.onBar: the update carries no time and close to play');
    }

    if (this.barTime === null) {
      this.mark(bar);
      return null;
    }
    /* A feed that re-sends an older bar is correcting history, not moving the
     * market on. Replaying it would offer prices the account is already past. */
    if (bar.time < this.barTime) return null;

    // Where the account stands now — the open of the ground about to be played.
    const from = this.broker.lastPrice ?? bar.open;
    let high = Math.max(from, bar.close);
    let low = Math.min(from, bar.close);

    if (bar.time === this.barTime) {
      // The same bar again: new ground is whatever pushed its range past what was seen.
      if (bar.high > this.seenHigh) high = Math.max(high, bar.high);
      if (bar.low < this.seenLow) low = Math.min(low, bar.low);
      this.seenHigh = Math.max(this.seenHigh, bar.high);
      this.seenLow = Math.min(this.seenLow, bar.low);
    } else {
      // A bar the account has not stood in before: all of it is new ground.
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      this.barTime = bar.time;
      this.seenHigh = bar.high;
      this.seenLow = bar.low;
    }

    const step = { time: bar.time, open: from, high, low, close: bar.close };
    this.broker.processBar(step);
    this.barsPlayed += 1;
    this._recordEquity(bar.time);
    return step;
  }

  /**
   * Walk the account forward over bars it missed.
   *
   * What the app being closed leaves behind. The bars are ordinary history,
   * played through the same door a live update comes in by, so a stop the
   * market went through while nobody was watching fills where it would have —
   * rather than greeting its owner still open, at a price it never reached.
   *
   * Bars at or before where the account already stands are skipped: those
   * prices are behind it, and offering them again is the look-ahead this file
   * exists to prevent.
   *
   * @param {Array<object>} bars  ascending, the gap and no more
   * @returns {number} how many were actually played
   */
  catchUp(bars) {
    let played = 0;
    for (const bar of bars) {
      if (this.barTime !== null && bar.time <= this.barTime) continue;
      this.onBar(bar);
      played += 1;
    }
    return played;
  }

  /* --- Placing orders --------------------------------------------------
   *
   * The same names ReplaySession offers, doing the same thing through the same
   * Broker — a click is one call whether the bars behind it are history being
   * stepped through or a feed arriving on its own.
   */

  /** Market entry at the last price, with an optional stop and target attached. */
  buy(spec = {}) {
    return this._settled(this.broker.fillNow(this.broker.submitEntry({ side: SIDE.BUY, ...spec })));
  }

  sell(spec = {}) {
    return this._settled(this.broker.fillNow(this.broker.submitEntry({ side: SIDE.SELL, ...spec })));
  }

  /** A bare order — a market one fills now, a limit or stop rests until a price answers it. */
  order(spec) {
    const order = this.broker.placeOrder(spec);
    return this._settled(order.type === 'market' ? this.broker.fillNow(order) : order);
  }

  /** Closes the whole position at market, now. */
  close(tag) {
    const order = this.broker.closePosition(tag);
    return this._settled(order === null ? null : this.broker.fillNow(order));
  }

  /**
   * Closes ONE position outright, at market.
   *
   * Not `closePart` with the position's own size: that books the exit as a
   * scale-out, and the tag is what the trade record ends up saying about how
   * it ended.
   */
  closeOne(positionId) {
    const order = this.broker.closePosition('manual', { positionId });
    return this._settled(order === null ? null : this.broker.fillNow(order));
  }

  /** Takes part of a position off at market, now. */
  closePart(size, positionId = null) {
    const order = this.broker.closePosition('scale-out', { size, positionId });
    return this._settled(order === null ? null : this.broker.fillNow(order));
  }

  /** Out of a position and into the same size the other way, at one price. */
  reverse(positionId = null) {
    const position = this._position(positionId);
    const size = Math.abs(position.size);
    const side = position.size > 0 ? SIDE.SELL : SIDE.BUY;

    const out = this.broker.closePosition('reverse', { positionId: position.id });
    if (out === null) return null;
    this.broker.fillNow(out);

    return this._settled(this.broker.fillNow(this.broker.submitEntry({ side, size, tag: 'reverse' })));
  }

  /** Closes every open position at market. */
  flatten() {
    return this._settled(this.broker.flatten('flatten').map((order) => this.broker.fillNow(order)));
  }

  cancelOrder(id) {
    return this.broker.cancelOrder(id);
  }

  cancelAll(tag) {
    return this.broker.cancelAll(tag);
  }

  /** Puts a stop and a target on an open position, replacing what it had. */
  protect(levels, positionId = null) {
    return this.broker.protect(this._position(positionId), levels);
  }

  /** Moves the stop to where the trade comes out flat after costs. */
  breakEven(positionId = null) {
    return this.broker.breakEven(this._position(positionId));
  }

  /** Follows price with the stop, at a fixed distance behind it. */
  setTrailing(distance, options = {}, positionId = null) {
    return this.broker.setTrailing(this._position(positionId), distance, options);
  }

  /** Moves a resting order instead of cancelling and replacing it. */
  modifyOrder(id, patch) {
    return this.broker.modifyOrder(id, patch);
  }

  /**
   * Note that money has settled, and hand the caller back what it was doing.
   *
   * Every path that can move the realised balance goes through here, so the curve gets a
   * point for it at the market time it happened — not at the next tick, which would put a
   * trade's result a bar after the trade.
   */
  _settled(value) {
    this._recordEquity(this.broker.time ?? Date.now());
    return value;
  }

  /* --- The account over time ------------------------------------------- */

  /**
   * Write the account onto the curve, and keep the peak and the worst drawdown honest.
   *
   * The peak and the drawdown are updated on EVERY call, because a drawdown that happened
   * between two stored points still happened. The curve itself is sampled, in three cases:
   *
   *   settled   the realised balance moved — a trade closed. Kept forever: this is the
   *             record of what the account did, and it is what a stored run is condensed
   *             down to anyway.
   *   marked    nothing settled, but a sample interval has passed. This is what makes an
   *             open position's drift over a week visible instead of a straight line
   *             between two trades.
   *   current   nothing settled and no interval passed: the last MARK is replaced, so the
   *             end of the curve is always the account as it stands. A settlement point is
   *             never replaced — it is a record, not a readout.
   */
  _recordEquity(time) {
    const equity = this.broker.equity;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownPct = this.peakEquity > 0 ? drawdown / this.peakEquity : 0;
    }

    const point = { time, equity, balance: this.broker.balance, drawdown };
    const curve = this.equityCurve;
    const last = curve[curve.length - 1];

    if (!last) {
      curve.push(point);
      return;
    }
    /* A curve that goes back in time is not a curve. A feed correcting an older bar, or a
     * catch-up landing before the last mark, updates where the account IS without moving
     * where it has been. */
    if (time < last.time) return;

    if (this.broker.balance !== last.balance) {
      curve.push(point);
      this._thin();
      return;
    }
    if (time - last.time >= this.sampleMs) {
      curve.push(point);
      this._thin();
      return;
    }
    // Replace the tail only where it is a mark; a settlement stays where it was recorded.
    const before = curve[curve.length - 2];
    if (!before || before.balance === last.balance) curve[curve.length - 1] = point;
  }

  /**
   * Halve the sampled points once the curve gets long, and halve the sample rate with them.
   *
   * Every settlement survives — those are the trades. What goes is half of the marks
   * between them, which is resolution rather than information: an account that has been
   * running for years is read by its shape and its trades, not by where its unrealised
   * profit was on a Tuesday afternoon eighteen months ago.
   */
  _thin() {
    const curve = this.equityCurve;
    if (curve.length <= MAX_EQUITY_POINTS) return;

    const kept = [curve[0]];
    let skip = false;
    for (let i = 1; i < curve.length - 1; i++) {
      if (curve[i].balance !== curve[i - 1].balance) {
        kept.push(curve[i]);
        continue;
      }
      skip = !skip;
      if (!skip) kept.push(curve[i]);
    }
    kept.push(curve[curve.length - 1]);

    // Nothing was droppable — an account that is all trades. Doubling the rate would not
    // help it, and the cap is not worth losing a trade over.
    if (kept.length === curve.length) return;

    this.equityCurve = kept;
    this.sampleMs *= 2;
  }

  /** What the account has done, in the same figures every stored run reports. */
  stats() {
    return summarize({
      broker: this.broker,
      equityCurve: this.equityCurve,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: this.maxDrawdownPct,
      barCount: this.barsPlayed,
    });
  }

  /** Wall-clock time the account has been open, across every sitting. */
  get elapsedMs() {
    return Date.now() - this.createdAt;
  }

  /**
   * The account as a finished run — the same shape a backtest and a replay produce, so a
   * paper account that is being started over can go onto the same shelf and be compared
   * against both rather than thrown away.
   *
   * @param {object} [options]
   * @param {?string} [options.resolution]  the timeframe it was last traded on, for the label
   */
  result({ resolution = null } = {}) {
    return {
      trades: this.broker.trades,
      fills: this.broker.fills,
      orders: this.broker.orders,
      equityCurve: this.equityCurve,
      openPosition: this.broker.position ? { ...this.broker.position } : null,
      stats: this.stats(),
      /* A paper account warms nothing up: it starts when somebody switches it on. */
      warmupBars: 0,
      barCount: this.barsPlayed,
      stepMs: null,
      costs: { ...this.broker.costs },
      initialBalance: this.broker.initialBalance,
      resolution,
      elapsedMs: this.elapsedMs,
      from: this.firstBarTime ?? this.createdAt,
      to: this.broker.time ?? Date.now(),
    };
  }

  /** The position an action names, or the one that is open. */
  _position(positionId) {
    const position = positionId == null
      ? this.broker.position
      : this.broker.positionById(positionId);
    if (!position) throw new Error('There is no such position open');
    return position;
  }

  /* --- Persistence ---------------------------------------------------- */

  /**
   * The account, and where in the feed it stands.
   *
   * The bars are not in it: they are the market's, they are the same bars
   * tomorrow, and the point of recording where it stands is that the gap to now
   * can be fetched and played — see {@link catchUp}.
   */
  snapshot() {
    return {
      broker: this.broker.snapshot(),
      barTime: this.barTime,
      seenHigh: this.seenHigh,
      seenLow: this.seenLow,
      createdAt: this.createdAt,
      firstBarTime: this.firstBarTime,
      barsPlayed: this.barsPlayed,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: this.maxDrawdownPct,
      sampleMs: this.sampleMs,
      equityCurve: this.equityCurve,
    };
  }

  /** Rebuilds a session from `snapshot`. */
  static restore(data) {
    const session = new LiveSession();
    session.broker = Broker.restore(data.broker);
    session.barTime = data.barTime ?? null;
    session.seenHigh = data.seenHigh ?? null;
    session.seenLow = data.seenLow ?? null;

    /* An account picked back up is the SAME account: when it was opened, what it has been
     * through, and the worst it ever was. Starting those again would report a month-old
     * account as new and its deepest drawdown as zero. */
    session.createdAt = Number.isFinite(data.createdAt) ? data.createdAt : Date.now();
    session.firstBarTime = Number.isFinite(data.firstBarTime) ? data.firstBarTime : null;
    session.barsPlayed = Number.isFinite(data.barsPlayed) ? data.barsPlayed : 0;
    session.peakEquity = Number.isFinite(data.peakEquity) ? data.peakEquity : session.broker.equity;
    session.maxDrawdown = Number.isFinite(data.maxDrawdown) ? data.maxDrawdown : 0;
    session.maxDrawdownPct = Number.isFinite(data.maxDrawdownPct) ? data.maxDrawdownPct : 0;
    session.sampleMs = Number.isFinite(data.sampleMs) && data.sampleMs > 0 ? data.sampleMs : EQUITY_SAMPLE_MS;
    session.equityCurve = Array.isArray(data.equityCurve) ? data.equityCurve : [];
    return session;
  }
}
