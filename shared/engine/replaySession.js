/* Replay — a person stepping through history one bar at a time.
 *
 * The other half of the sentence at the top of broker.js: in a backtest a
 * strategy calls ctx.buy(), in a replay a person clicks Buy, and both end up
 * in the same Broker. That is what makes a result you traded by hand and a
 * result a bot produced directly comparable, which is the only reason either
 * number is worth storing.
 *
 * The one rule that makes it a test and not a game
 * ------------------------------------------------
 * The bar under the playhead is the last *closed* bar. Everything after it is
 * not hidden as a matter of presentation — it does not exist yet as far as
 * this class is concerned. That is the guarantee, and it is a stronger one
 * than hiding candles: an order cannot be matched against a bar that is not in
 * the array yet, so nothing here can be decided by a price nobody has seen.
 *
 * At market means now
 * -------------------
 * Within that window, a market order fills where a market order fills: at the
 * last price on the screen, the moment it is sent, plus the spread, slippage
 * and commission a strategy would have paid. It is not look-ahead — that close
 * is the newest price in existence as far as the session is concerned — and it
 * is what a real ticket does. It also means the position is on the chart under
 * the hand that opened it, so its stop and target can be dragged straight
 * away, instead of a bar later.
 *
 * A *resting* order is the other case and keeps the backtest's rule exactly:
 * a limit or a stop is answered by the bars that come after it, on the step
 * that reveals them, because that is the only thing that can answer it.
 *
 * Look-ahead in a replay is a different problem from look-ahead in a backtest,
 * because the person doing it can simply look. Nothing here can prevent that.
 * What it can do is make sure the *account* is charged like a real one, which
 * is what the costs above are for.
 *
 * Fills inside the bar
 * --------------------
 * Same answer as the backtest, for the same reason: a bar that touches both
 * the stop and the target says nothing about which came first, so the minutes
 * inside it are walked in order where they exist. `step()` takes them; where
 * the caller has none the Broker's pessimistic rule applies and every fill
 * records which of the two decided it.
 *
 * Why the bars are handed in rather than fetched
 * ----------------------------------------------
 * So this file has no IPC, no clock and no chart in it, and a session can be
 * driven from a test with twenty bars in an array. The renderer's composable
 * owns the fetching, the play/pause timer and the pixels.
 */

import { Broker, POSITION_MODE, SIDE } from './broker.js';
import { summarize } from './summary.js';

export class ReplaySession {
  /**
   * @param {object} options
   * @param {Array<object>} options.bars    ascending, times in milliseconds
   * @param {number} options.startIndex     the last bar visible at the start
   * @param {number} [options.balance]      starting cash
   * @param {object} [options.costs]        Broker cost overrides
   * @param {number} [options.stepMs]       bar duration; inferred when absent
   * @param {'netting'|'hedging'} [options.mode]  how a second entry is read
   */
  constructor({
    bars, startIndex, balance = 10_000, costs = {}, stepMs = null,
    mode = POSITION_MODE.HEDGING,
  }) {
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new Error('ReplaySession: no bars to replay');
    }
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= bars.length) {
      throw new Error(
        `ReplaySession: startIndex ${startIndex} is outside the ${bars.length} bars given`,
      );
    }

    this.bars = bars;
    this.startIndex = startIndex;
    this.index = startIndex;
    this.stepMs = stepMs ?? inferStepMs(bars);
    this.broker = new Broker({ balance, costs, mode });

    /* Where the session began, as a moment rather than an index.
     *
     * An index only means something against one array of bars, and the array
     * is replaced whenever the timeframe changes. The moment survives that —
     * it is the same instant on every timeframe — so it is what `startIndex`
     * is recomputed from and what the stored result reports as its range. */
    this.startTime = bars[startIndex].time;

    /**
     * The playhead as a clock: the instant the revealed history ends.
     *
     * The index says which bar is under the playhead, but "which bar" is a
     * different question on every timeframe, and the answer has to survive
     * switching between them. The end of the last revealed bar does: it is one
     * instant, it is the same instant on a 5m chart and on a 1h chart, and
     * everything before it is what this session has been allowed to see.
     */
    this.clock = bars[startIndex].time + this.stepMs;

    /**
     * The bar in progress, where the playhead sits inside one.
     *
     * Only ever after a switch to a slower timeframe: the clock lands at 10:35
     * and the hourly bar it falls in is not over. Showing the whole of that
     * bar would be showing the next 25 minutes, and hiding it would take back
     * 35 minutes that have already been played. So it is drawn as far as it
     * has got, and `step` finishes it rather than moving on.
     *
     * `{ index, full }` — where it sits, and the complete bar it becomes.
     */
    this.forming = null;

    this.startedAt = Date.now();
    /** Time spent in earlier sittings, for a session that was put down. */
    this.elapsedBefore = 0;
    /** How many stepped bars carried their own minutes, for the honest label. */
    this.intrabarSteps = 0;
    this.steps = 0;

    /* Marked to the bar the session starts on, so equity is a real number
     * before anything has been stepped. No order exists yet, so nothing can
     * fill on it — this only gives the account a price to be worth something
     * at. */
    this.broker.time = bars[startIndex].time;
    this.broker.lastPrice = bars[startIndex].close;

    this.peakEquity = this.broker.equity;
    this.maxDrawdown = 0;
    this.maxDrawdownPct = 0;

    this.equityCurve = [{
      time: bars[startIndex].time,
      equity: this.broker.equity,
      balance: this.broker.balance,
      drawdown: 0,
    }];
  }

  /** The last closed bar — what the chart is allowed to show. */
  get bar() {
    return this.bars[this.index];
  }

  /** Nothing further has been loaded; stepping would run past the data. */
  get atEnd() {
    // A bar in progress always has a step left in it: finishing it.
    if (this.forming !== null && this.forming.index === this.index) return false;
    return this.index >= this.bars.length - 1;
  }

  /** Bars stepped through so far. */
  get progress() {
    return this.index - this.startIndex;
  }

  /**
   * Reveals the next bar and settles everything it makes fillable.
   *
   * The order matches the backtest loop exactly: fills first, then the person
   * gets to look. Whatever they do next is an order for the bar after this
   * one.
   *
   * @param {Array<object>} [subBars]  the minutes inside the revealed bar
   * @returns {object} the bar now under the playhead
   */
  step(subBars = null) {
    /* A bar in progress is finished rather than left behind: the playhead is
     * already inside it, so the next step is the rest of it. */
    const finishing = this.forming !== null && this.forming.index === this.index;

    if (!finishing && this.atEnd) {
      throw new Error('ReplaySession: there is no bar after this one — load more first');
    }

    let bar;
    let steps = subBars;

    if (finishing) {
      bar = this.forming.full;
      this.bars = [...this.bars];
      this.bars[this.index] = bar;
      this.forming = null;

      /* Only the minutes that have not been played yet. The earlier ones are
       * already in the account: they were stepped through on the timeframe the
       * session was on before, and running them again would fill orders
       * against prices that have been and gone.
       *
       * Without minutes to hand there is nothing finer to walk, and the whole
       * bar is taken as one step — the same pessimistic rule the Broker
       * applies everywhere else, and recorded the same way. */
      steps = subBars ? subBars.filter((m) => m.time >= this.clock) : null;
      if (steps && steps.length === 0) steps = null;
    } else {
      this.index += 1;
      bar = this.bars[this.index];
    }

    this.broker.processBar(bar, steps);
    this.clock = bar.time + this.stepMs;

    this.steps += 1;
    if (steps && steps.length > 0) this.intrabarSteps += 1;

    this._recordEquity(bar.time);
    return bar;
  }

  /**
   * Writes the account onto the equity curve.
   *
   * Never backwards: a switch to a slower timeframe puts the playhead inside a
   * bar that started before the last point on the curve, and a curve that goes
   * back in time is not a curve. The point that is already there is updated
   * instead — same instant, newer account.
   */
  _recordEquity(time) {
    const equity = this.broker.equity;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownPct = this.peakEquity > 0 ? drawdown / this.peakEquity : 0;
    }

    const point = {
      time, equity, balance: this.broker.balance, drawdown,
    };
    const last = this.equityCurve[this.equityCurve.length - 1];

    if (last && time <= last.time) this.equityCurve[this.equityCurve.length - 1] = point;
    else this.equityCurve.push(point);
  }

  /* ─── Placing orders ──────────────────────────────────────────────────
   *
   * The same five names the backtest hands a strategy under `ctx`, doing the
   * same thing through the same Broker. A person clicking Buy and a strategy
   * calling ctx.buy() are then not merely comparable afterwards — they are the
   * same call, and there is no second path for one of them to be wrong on.
   */

  /**
   * Market entry, with optional stop and target attached.
   *
   * Filled on the spot, at the last price — see "At market means now" at the
   * top. The stop and target `submitEntry` places are ordinary resting orders
   * and wait for a bar to answer them, which is the only thing that can.
   */
  buy(spec = {}) {
    return this.broker.fillNow(this.broker.submitEntry({ side: SIDE.BUY, ...spec }));
  }

  sell(spec = {}) {
    return this.broker.fillNow(this.broker.submitEntry({ side: SIDE.SELL, ...spec }));
  }

  /**
   * A bare order — limit or stop entries, and anything without a bracket.
   *
   * A market order among them goes straight through, wherever it came from: a
   * drawn block entered at market is the same order the Buy button sends, and
   * one of the two waiting a bar longer than the other would be a difference
   * nobody chose.
   */
  order(spec) {
    const order = this.broker.placeOrder(spec);
    return order.type === 'market' ? this.broker.fillNow(order) : order;
  }

  /** Closes the whole position at market, now, at the last price. */
  close(tag) {
    const order = this.broker.closePosition(tag);
    return order === null ? null : this.broker.fillNow(order);
  }

  cancelAll(tag) {
    return this.broker.cancelAll(tag);
  }

  /* ─── Managing what is open ───────────────────────────────────────────── *
   *
   * Everything here goes to the same Broker the entries went to, and comes
   * out as ordinary orders. Taking half off is a market order for half; a
   * break-even stop is the same stop order moved. Nothing is a special case
   * the account gets to settle differently.
   */

  /**
   * Takes part of a position off at market, now, at the last price.
   *
   * @param {number} size            base units to close
   * @param {number} [positionId]    which one, where several are open
   */
  closePart(size, positionId = null) {
    const order = this.broker.closePosition('scale-out', { size, positionId });
    return order === null ? null : this.broker.fillNow(order);
  }

  /**
   * Turns a position round: out of it, and into the same size the other way.
   *
   * One action rather than two, because as two it is not the same thing. Close
   * and then re-enter means reading the size off the panel, typing it into the
   * ticket, and picking a side — three chances to be wrong while the reason
   * for turning round is still on the screen. It is also two decisions the
   * market can move between; here both fills are taken at the same last price.
   *
   * What comes out is honest about being two trades: the old one is closed and
   * recorded with the result it actually had, and a new one is opened. A
   * reversal that showed up as a single position that "changed its mind" would
   * hide a loss inside a winner.
   *
   * The new position carries no stop and no target. A stop that protected a
   * long is where a short is right, so inheriting the levels would put
   * protection on the wrong side of the market — and the whole point of
   * turning round is that the previous read was wrong, including its levels.
   *
   * @param {number} [positionId]  which one, where several are open
   * @returns {?object} the entry order of the new position, or null if there
   *   was nothing open to turn round
   */
  reverse(positionId = null) {
    const position = this._position(positionId);
    const size = Math.abs(position.size);
    const side = position.size > 0 ? SIDE.SELL : SIDE.BUY;

    const out = this.broker.closePosition('reverse', { positionId: position.id });
    if (out === null) return null;
    this.broker.fillNow(out);

    return this.broker.fillNow(
      this.broker.submitEntry({ side, size, tag: 'reverse' }),
    );
  }

  /** Closes every open position at market. */
  flatten() {
    return this.broker.flatten('flatten').map((order) => this.broker.fillNow(order));
  }

  /**
   * Puts a stop and a target on an open position, replacing what it had.
   *
   * Resting orders, so they are live from the next bar — protection decided
   * after a bar has closed cannot have been in the market during it, and there
   * is nothing left in that bar for it to catch.
   */
  protect(levels, positionId = null) {
    const position = this._position(positionId);
    return this.broker.protect(position, levels);
  }

  /**
   * Moves the stop to where the trade comes out flat after costs.
   *
   * Refused by the Broker where that level is not in front of the market yet
   * — see `breakEvenRefusal`, which is also what greys the button.
   */
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

  /** The position an action names, or the one that is open. */
  _position(positionId) {
    const position = positionId == null
      ? this.broker.position
      : this.broker.positionById(positionId);
    if (!position) throw new Error('There is no such position open');
    return position;
  }

  /* ─── Changing timeframe under a running session ──────────────────────── */

  /**
   * Swaps the bars for the same history at another resolution.
   *
   * The reason this exists: reading the higher timeframe and trading the lower
   * one is not a preference, it is the method. A session that locks the
   * timeframe for its whole length asks the person either to trade blind or to
   * start again, and both of those are worse than the problem the lock was
   * solving.
   *
   * What the lock was solving is real, though, and this is how it is kept:
   *
   *   The clock does not move. Every trade already taken stays exactly where
   *   it happened — `startIndex` and the playhead are recomputed from the
   *   moments they stand at, not carried across as numbers that mean something
   *   different in the new array.
   *
   *   No bar is played twice. The playhead lands on the last bar of the new
   *   timeframe that had *ended* by the clock. Where the clock is inside a bar
   *   — 10:35 on an hourly chart — that bar is shown as far as it has got and
   *   finished by the next step, so the minutes between 10:00 and 10:35 are
   *   neither replayed nor skipped.
   *
   *   Nothing after the clock becomes visible. The window may contain later
   *   bars, as it always does; the playhead is what decides what exists.
   *
   * The account is untouched. `lastPrice` in particular stays what it was: the
   * newest price anyone has seen does not change because the chart is being
   * drawn at a different resolution, and re-marking it to an older bar's close
   * would move the equity for no reason anybody chose.
   *
   * @param {object} params
   * @param {Array<object>} params.bars   the same history at the new resolution
   * @param {number} params.stepMs        the new bar duration
   * @param {?object} [params.forming]    the bar in progress, aggregated from
   *   finer data up to the clock. Omitted where the clock sits exactly on a
   *   bar boundary, which is every switch to a faster timeframe.
   */
  rebase({ bars, stepMs, forming = null }) {
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new Error('ReplaySession.rebase: no bars to switch to');
    }
    if (!(stepMs > 0)) {
      throw new Error(`ReplaySession.rebase: stepMs must be positive, got ${stepMs}`);
    }

    const clock = this.clock;

    /* The last bar that had finished by the clock. Not the last bar that had
     * *started*: a bar that is still running contains prices from after the
     * playhead, and putting it on the chart whole is look-ahead with a candle
     * drawn round it. */
    let closed = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].time + stepMs <= clock) closed = i;
      else break;
    }
    if (closed === -1 && forming === null) {
      throw new Error(
        'ReplaySession.rebase: the window does not reach the playhead — '
        + 'load bars that start before it',
      );
    }

    const next = [...bars];
    let index = closed;
    let formingState = null;

    if (forming != null) {
      const running = closed + 1;
      const full = bars[running];

      if (full != null && full.time === forming.time) {
        formingState = { index: running, full };
        next[running] = forming;
        index = running;
      } else if (full == null && (closed === -1 || bars[closed].time < forming.time)) {
        /* The window has no complete bar there — the stored data ends inside
         * this one. What has been aggregated is then not a preview of a bar
         * that exists, it is the whole of what exists, so it goes in as an
         * ordinary last bar. The session runs to the end of the data and stops
         * there, which is what it does at the edge of the data anyway. */
        next.push(forming);
        index = next.length - 1;
      } else {
        throw new Error(
          'ReplaySession.rebase: the bar in progress does not line up with the window',
        );
      }
    }

    this.bars = next;
    this.stepMs = stepMs;
    this.index = index;
    this.forming = formingState;
    this.startIndex = Math.min(index, barIndexAt(next, this.startTime));

    /* The broker is marked to the bar the playhead is on, but not re-priced:
     * `lastPrice` is the newest price that has been seen, and that is a fact
     * about the session, not about the chart's resolution. */
    this.broker.time = next[index].time;

    return this;
  }

  /**
   * Adds bars to the end of the window, so a session can keep going past what
   * was loaded when it started.
   *
   * Only ever appended, never prepended: every index this session has recorded
   * — the playhead, the start — counts from the front of the array, and
   * putting a bar in front of them would silently move all of them onto
   * different bars. The prefix is checked rather than trusted, because a
   * mismatch here would misplace every trade the session has already taken.
   */
  extend(bars) {
    if (!Array.isArray(bars) || bars.length === 0) return 0;

    const last = this.bars[this.bars.length - 1].time;
    const added = bars.filter((b) => b.time > last);
    if (added.length === 0) return 0;

    for (let i = 1; i < added.length; i++) {
      if (added[i].time <= added[i - 1].time) {
        throw new Error('ReplaySession.extend: the added bars are not ascending');
      }
    }

    this.bars = [...this.bars, ...added];
    return added.length;
  }

  /**
   * How the fills that happened were decided.
   *
   * Read off the fills themselves rather than off what was offered, because
   * that is the honest answer: a session where nothing ever traded through an
   * ambiguous bar was not helped by the minutes it was given. With no fills at
   * all it falls back to whether the minutes were there to be used.
   *
   * A fill taken at market is not among them. It was not decided by a bar —
   * its price was on the screen — so it is neither resolved nor guessed at,
   * and counting it as a guess would label a session of hand-sent entries
   * pessimistic when nothing in it was ever in doubt.
   */
  get resolution() {
    const fills = this.broker.fills.filter((f) => f.resolution !== 'immediate');
    if (fills.length > 0) {
      return fills.every((f) => f.resolution === 'intrabar') ? 'intrabar' : 'pessimistic';
    }
    return this.steps > 0 && this.intrabarSteps === this.steps ? 'intrabar' : 'pessimistic';
  }

  /**
   * The session as a finished run, in the shape runBacktest returns.
   *
   * Same shape on purpose: it goes into the same store, is read by the same
   * results page and lands in the same comparison. A replay that reported its
   * own dialect of the same numbers could not be put next to a backtest, which
   * is the entire point of having done it.
   */
  result() {
    return {
      trades: this.broker.trades,
      fills: this.broker.fills,
      orders: this.broker.orders,
      equityCurve: this.equityCurve,
      openPosition: this.broker.position ? { ...this.broker.position } : null,
      stats: summarize({
        broker: this.broker,
        equityCurve: this.equityCurve,
        maxDrawdown: this.maxDrawdown,
        maxDrawdownPct: this.maxDrawdownPct,
        barCount: this.progress,
      }),
      /* A replay warms nothing up: the person had the whole chart to the left
       * of the playhead before they pressed anything. */
      warmupBars: 0,
      barCount: this.progress,
      stepMs: Number.isFinite(this.stepMs) ? this.stepMs : null,
      costs: { ...this.broker.costs },
      initialBalance: this.broker.initialBalance,
      resolution: this.resolution,
      elapsedMs: this.elapsedMs,
      /* Where on the chart it happened, so a stored replay carries the same
       * range a backtest does and the two line up in a comparison. */
      from: this.startTime,
      to: this.clock,
    };
  }

  /** Time at the session, across every sitting it has had. */
  get elapsedMs() {
    return this.elapsedBefore + (Date.now() - this.startedAt);
  }

  /* ─── Putting it down and picking it up ───────────────────────────────── */

  /**
   * The session as plain data, for carrying on another day.
   *
   * The bars are not in it. They are in the data store, they are the same bars
   * tomorrow, and a session is a few hundred kilobytes of account either way —
   * writing a copy of the market beside it would be storing the one thing that
   * cannot go stale as though it could.
   *
   * What is in it is the account and the clock. The clock is the reason this
   * works at all: it is an instant rather than an index, so it still means the
   * same thing when the window is fetched again with a different number of
   * bars in front of it.
   */
  snapshot() {
    return {
      version: 1,
      stepMs: Number.isFinite(this.stepMs) ? this.stepMs : null,
      startTime: this.startTime,
      clock: this.clock,
      broker: this.broker.snapshot(),
      equityCurve: this.equityCurve.map((p) => ({ ...p })),
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: this.maxDrawdownPct,
      steps: this.steps,
      intrabarSteps: this.intrabarSteps,
      elapsedMs: this.elapsedMs,
    };
  }

  /**
   * Picks a stored session back up on freshly fetched bars.
   *
   * The playhead is not restored as a number — it is recomputed from the clock
   * against the bars that have just arrived, by the same `rebase` a timeframe
   * change goes through. That is what makes it safe for the window to come
   * back a different shape, which it will: the store fetches around a moment,
   * and how many bars sit in front of that moment is not something either side
   * promises the other.
   *
   * @param {object} snapshot
   * @param {object} params
   * @param {Array<object>} params.bars
   * @param {?object} [params.forming]  the bar in progress, where the clock
   *   sits inside one — same as `rebase`.
   */
  static restore(snapshot, { bars, forming = null }) {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error('ReplaySession.restore: this is not a session snapshot');
    }

    const session = new ReplaySession({
      bars,
      startIndex: 0,
      balance: snapshot.broker.initialBalance,
      costs: snapshot.broker.costs,
      stepMs: snapshot.stepMs,
      mode: snapshot.broker.mode,
    });

    session.broker = Broker.restore(snapshot.broker);
    session.startTime = snapshot.startTime;
    session.clock = snapshot.clock;
    session.equityCurve = snapshot.equityCurve.map((p) => ({ ...p }));
    session.peakEquity = snapshot.peakEquity;
    session.maxDrawdown = snapshot.maxDrawdown;
    session.maxDrawdownPct = snapshot.maxDrawdownPct;
    session.steps = snapshot.steps;
    session.intrabarSteps = snapshot.intrabarSteps;
    session.elapsedBefore = snapshot.elapsedMs ?? 0;
    session.startedAt = Date.now();

    session.rebase({ bars, stepMs: snapshot.stepMs, forming });
    return session;
  }
}

/**
 * The index of the bar holding a moment, clamped into the array.
 *
 * A binary search rather than a scan because `rebase` runs it over a window
 * that is fifteen hundred bars of lead alone, and a timeframe switch should
 * feel like a switch rather than a load.
 */
export function barIndexAt(bars, timeMs) {
  if (!Array.isArray(bars) || bars.length === 0) return 0;
  if (timeMs <= bars[0].time) return 0;
  if (timeMs >= bars[bars.length - 1].time) return bars.length - 1;

  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bars[mid].time <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Bar duration: the smallest gap actually present, as the backtest infers it. */
function inferStepMs(bars) {
  if (bars.length < 2) return Infinity;
  let smallest = Infinity;
  for (let k = 1; k < bars.length; k++) {
    const d = bars[k].time - bars[k - 1].time;
    if (d > 0 && d < smallest) smallest = d;
  }
  if (!Number.isFinite(smallest)) {
    throw new Error('ReplaySession: could not determine the bar duration — timestamps do not advance');
  }
  return smallest;
}
