/* Backtest loop — drives a strategy over history against the Broker.
 *
 * Order of events per bar, and why it is this order:
 *
 *   1. fills   orders placed on earlier bars are matched against this bar
 *   2. onBar   the strategy sees this bar as closed and may place new orders
 *
 * An order can therefore never fill on the bar that created it. That single rule removes
 * the most common way a backtest lies to itself: acting on a closing price at that same
 * closing price, which nobody can do.
 *
 * The strategy never receives the bar array. It gets `ctx.history(n)` — the last n closed
 * bars — and `ctx.value(name, back)` for per-bar series, both of which stop at the current
 * bar. Look-ahead is not discouraged here, it is unavailable.
 *
 * Series and events are handed in, not computed here
 * --------------------------------------------------
 * A strategy declares two kinds of precomputed input:
 *
 *   series   one value per bar — a moving average, an ATR. Read with `ctx.value()`.
 *   events   discrete objects that happen a few dozen times across a whole series — a gap,
 *            a sweep, a whole setup. Read with `ctx.events()`, which returns what became
 *            knowable on THIS bar and nothing else.
 *
 * Both arrive already computed, rather than as `{ id, params }` looked up in a registry.
 * The detectors live in the chart core and are written in TypeScript; this file is plain,
 * environment-free JavaScript for the same reason `broker.js` is — so a run can be driven
 * from a test, from the app, or from a script, with twenty bars in an array. Whoever builds
 * the strategy has the bars and computes what it needs; nothing here needs to know how.
 *
 * It also makes a parameter sweep honest instead of clever. Varying the reward-to-risk
 * changes what a strategy does with a setup but not which setups exist, so the caller
 * detects once and hands the same array to every run — which is what a cache inside here
 * would have been faking.
 *
 * The bucketing is by each object's `index`, never its `startIndex`. That distinction is the
 * whole reason the two exist: `startIndex` is where a thing is drawn, `index` is the bar from
 * which it could have been acted on. Reading the drawing index here would hand a strategy a
 * setup before the market had finished making it, which is exactly the lie the split was
 * invented to stop.
 *
 * Events take no part in the warm-up skip. A series is undefined until its window fills,
 * which is a real reason to wait; a bar with no events is not warming up, it is simply a bar
 * where nothing happened.
 */

import { Broker, SIDE } from './broker.js';
import { summarize } from './summary.js';

/* One frozen array for every barless answer, rather than a fresh [] per call. A strategy
 * that asks on every bar would otherwise allocate one per bar, and freezing it means a
 * strategy that pushes into the result corrupts its own call rather than the next bar's. */
const EMPTY = Object.freeze([]);

/**
 * @param {object} params
 * @param {Array} params.bars        strategy-timeframe bars, ascending, closed only
 * @param {Array} [params.baseBars]  1m bars covering the same span, for intrabar fills
 * @param {object} params.strategy   { series?, events?, params?, management?, init?, onBar, onFinish? }
 * @param {object} [params.broker]   Broker options (balance, costs, mode)
 * @param {number} [params.stepMs]   bar duration; inferred when absent
 * @param {number} [params.tradeFrom]  bar time (ms) trading starts at, or absent for "from
 *   the first bar". Everything before it still feeds `series` and `events` — real warm-up,
 *   the same detection a live run would have had — but the strategy's `onBar` never runs
 *   for it, so nothing before this time can become a fill, a trade, or a point on the
 *   equity curve. Lets a caller hand in history a detector needs (a 200-session average,
 *   say) without that history counting as part of what was tested — see the series warm-up
 *   skip below, which this works alongside: whichever of the two skips more bars wins.
 */
export function runBacktest({
  bars, baseBars = null, strategy, broker: brokerOptions = {}, stepMs = null, tradeFrom = null,
}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('runBacktest: no bars to run on');
  }
  if (!strategy || typeof strategy.onBar !== 'function') {
    throw new Error('runBacktest: the strategy must provide an onBar(ctx) function');
  }

  /* Break-even and trailing come with the strategy but belong to the account: both
   * are decided inside a bar, and a strategy only ever sees one that has closed. See
   * `management` in broker.js. A caller that set them on `broker` directly wins — a
   * run override is a deliberate act, a schema default is not. */
  const broker = new Broker(
    strategy.management != null && brokerOptions.management === undefined
      ? { ...brokerOptions, management: strategy.management }
      : brokerOptions,
  );
  const startedAt = Date.now();

  const series = strategy.series ?? {};
  for (const [name, values] of Object.entries(series)) {
    if (!Array.isArray(values)) {
      throw new Error(`runBacktest: series "${name}" must be an array, got ${typeof values}`);
    }
    if (values.length !== bars.length) {
      throw new Error(
        `runBacktest: series "${name}" has ${values.length} values for ${bars.length} bars`,
      );
    }
  }
  const seriesNames = Object.keys(series);

  /* Events, bucketed by the bar that confirmed each object. The strategy can only reach
   * bucket i while it is on bar i, so bucketing the whole thing up front costs nothing in
   * correctness. */
  const buckets = {};
  for (const [name, items] of Object.entries(strategy.events ?? {})) {
    if (!Array.isArray(items)) {
      throw new Error(`runBacktest: events "${name}" must be an array, got ${typeof items}`);
    }
    const byBar = new Array(bars.length);
    for (const item of items) {
      const at = item?.index;
      if (!Number.isInteger(at)) {
        throw new Error(`runBacktest: an item of events "${name}" has no integer index`);
      }
      // Outside the run entirely — nothing on this pass can act on it.
      if (at < 0 || at >= bars.length) continue;
      (byBar[at] ??= []).push(item);
    }
    buckets[name] = byBar;
  }
  const eventNames = Object.keys(buckets);

  /* Skip the warm-up: bars where a declared series is still undefined. A strategy that had
   * to null-check every value would be mostly null-checks. */
  let start = 0;
  if (seriesNames.length > 0) {
    while (start < bars.length && seriesNames.some((n) => series[n][start] == null)) start++;
  }
  /* A second, independent floor: bars before `tradeFrom` are real history — series and
   * events already cover them — but trading starts no earlier than this. Whichever of the
   * two skips more bars wins; neither can pull `start` backwards. */
  if (tradeFrom != null) {
    while (start < bars.length && bars[start].time < tradeFrom) start++;
  }

  const equityCurve = [];
  let peakEquity = broker.equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  let i = 0; // current bar index, closed over by the context
  const step = stepMs ?? inferStepMs(bars);
  const subBarsFor = makeSubBarLookup(bars, baseBars, step);

  const ctx = {
    /* The bar just closed. Prices are read from it — `ctx.bar.close` — because `ctx.close()`
     * is the method that closes a position. One name cannot mean both a price and an action. */
    get bar() { return bars[i]; },
    get index() { return i; },
    get time() { return bars[i].time; },

    /** The last `n` closed bars, oldest first, ending with the current one. */
    history(n = 1) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`history(${n}): n must be a positive integer`);
      return bars.slice(Math.max(0, i - n + 1), i + 1);
    },

    /**
     * A series value. `back` counts bars into the past: 0 is this bar, 1 the one before.
     * Returns null before the series is defined.
     */
    value(name, back = 0) {
      const s = series[name];
      if (!s) {
        throw new Error(`Unknown series "${name}". Declared: ${seriesNames.join(', ') || 'none'}`);
      }
      if (!Number.isInteger(back) || back < 0) {
        throw new Error(`value("${name}", ${back}): back must be a non-negative integer`);
      }
      const at = i - back;
      return at < 0 ? null : s[at];
    },

    /**
     * The events of `name` that this bar confirmed, oldest first, or an empty array. Never
     * anything from a later bar: the bucket is keyed by the index at which each item became
     * knowable.
     */
    events(name) {
      const byBar = buckets[name];
      if (!byBar) {
        throw new Error(`Unknown events "${name}". Declared: ${eventNames.join(', ') || 'none'}`);
      }
      return byBar[i] ?? EMPTY;
    },

    get position() { return broker.position; },
    get positions() { return broker.positions; },
    get balance() { return broker.balance; },
    get equity() { return broker.equity; },
    get isFlat() { return broker.isFlat; },
    get pendingOrders() { return broker.pending; },

    params: strategy.params ?? {},

    buy(spec = {}) {
      return broker.submitEntry({ side: SIDE.BUY, ...spec });
    },
    sell(spec = {}) {
      return broker.submitEntry({ side: SIDE.SELL, ...spec });
    },
    order(spec) {
      return broker.placeOrder(spec);
    },
    close(tag) {
      return broker.closePosition(tag);
    },
    cancel(id) {
      return broker.cancelOrder(id);
    },
    cancelAll(tag) {
      return broker.cancelAll(tag);
    },

    /** Free-form store that survives across bars, for strategy state. */
    state: {},
  };

  strategy.init?.(ctx);

  for (i = start; i < bars.length; i++) {
    const bar = bars[i];

    // 1. Resolve what this bar fills, using its minutes where available.
    broker.processBar(bar, subBarsFor(i));

    // 2. Let the strategy react to the now-closed bar.
    strategy.onBar(ctx);

    const equity = broker.equity;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    /* Tracked independently of the cash figure above, not read off its winning bar: a
     * shallower cash drawdown from a lower peak can still be the worse percentage — a
     * 2,000 pullback from a 20,000 peak is 10%, and a later 1,500 pullback from a peak of
     * only 5,000 is 30% — and comparing only on cash would silently drop the second one. */
    if (peakEquity > 0) {
      const drawdownPct = drawdown / peakEquity;
      if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    }

    equityCurve.push({ time: bar.time, equity, balance: broker.balance, drawdown });
  }

  strategy.onFinish?.(ctx);

  /* Anything still open is reported as it stands rather than closed out: a position the
   * strategy did not exit is not a trade it made, and forcing one would put a result on the
   * shelf that nobody decided. The stats mark it to the last close through `broker.equity`. */
  const openAtEnd = broker.position ? { ...broker.position } : null;

  return {
    trades: broker.trades,
    fills: broker.fills,
    orders: broker.orders,
    equityCurve,
    openPosition: openAtEnd,
    stats: summarize({
      broker, equityCurve, maxDrawdown, maxDrawdownPct, barCount: bars.length - start,
    }),
    warmupBars: start,
    barCount: bars.length,
    /* How long one bar is. Reported because a stored run is read back long after the fact by
     * things that only have the trades — a trade review has to know how much chart a trade is
     * worth without re-deriving it. */
    stepMs: Number.isFinite(step) ? step : null,
    /* The costs the run was actually charged, not the overrides it was handed. A caller that
     * passes nothing gets the Broker's defaults, and a run that stored `{}` would claim to
     * have been free — worse, it would look comparable to a run made after someone changed
     * those defaults. */
    costs: { ...broker.costs },
    initialBalance: broker.initialBalance,
    /* The instrument the run was actually charged in — same reasoning as `costs` above.
     * A stored run that omitted these could not be told apart from one run against a
     * plain spot instrument, which is exactly the confusion that let every futures
     * backtest trade at pointValue 1 unnoticed. */
    pointValue: broker.pointValue,
    sizeStep: broker.sizeStep,
    minSize: broker.minSize,
    resolution: baseBars && baseBars.length > 0 ? 'intrabar' : 'pessimistic',
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Builds a lookup from strategy-bar index to the 1m bars inside it.
 *
 * A bar's span is its own start plus one timeframe — deliberately not "up to the next bar".
 * Where the series has a gap (a halt, a symbol not yet listed), the two differ, and minutes
 * from inside the gap do not belong to the bar before it. Attributing them there would let a
 * fill happen on a bar whose own high and low never saw that price.
 *
 * Both arrays are ascending, so one walking pointer covers the whole series.
 */
function makeSubBarLookup(bars, baseBars, stepMs) {
  if (!baseBars || baseBars.length === 0) return () => null;

  const buckets = new Array(bars.length);
  let b = 0;

  for (let k = 0; k < bars.length; k++) {
    const from = bars[k].time;
    const to = from + stepMs;

    while (b < baseBars.length && baseBars[b].time < from) b++;
    const startIdx = b;
    while (b < baseBars.length && baseBars[b].time < to) b++;
    buckets[k] = b > startIdx ? baseBars.slice(startIdx, b) : null;
  }

  return (k) => buckets[k];
}

/** Bar duration: given explicitly, or the smallest gap actually present. */
function inferStepMs(bars) {
  if (bars.length < 2) return Infinity;
  let smallest = Infinity;
  for (let k = 1; k < bars.length; k++) {
    const d = bars[k].time - bars[k - 1].time;
    if (d > 0 && d < smallest) smallest = d;
  }
  if (!Number.isFinite(smallest)) {
    throw new Error('runBacktest: could not determine the bar duration — timestamps do not advance');
  }
  return smallest;
}
