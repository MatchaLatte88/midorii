/* Parameter sweeps — every combination of a set of ranges, and how to rank them.
 *
 * Pure arithmetic over plain objects: no bars, no engine, no clock. The runner that
 * actually executes a sweep lives in the renderer, beside the strategies it builds;
 * everything here can be checked without either.
 *
 * Why the counting is done up front
 * ---------------------------------
 * Ranges multiply. Three settings with twenty values each is eight thousand runs, and
 * on a year of 5-minute bars that is hours — a number nobody guesses correctly from
 * looking at three input fields. `countCombinations` exists so the UI can say what it is
 * about to cost before anyone waits for it.
 *
 * Floating point is the other trap. A range from 1.2 to 3 in steps of 0.1, walked by
 * repeated addition, arrives at 1.9000000000000001 and then stores that as a parameter —
 * so two sweeps that should be identical are not, and a stored result reads as noise.
 * Every value here is computed as `from + index * step` and rounded to the decimals the
 * step itself carries, so the tenth step of 0.1 is exactly 1.0.
 *
 * Ranking, and why expectancy
 * ---------------------------
 * `expectancy` — net profit per trade — is the default because it asks whether the RULE
 * is worth anything, independently of how often it fired or how large the positions
 * were. Net profit rewards whatever traded most with the most leverage; profit factor
 * ignores how rare the trades were.
 *
 * None of the three is safe on its own, which is what `minTrades` is for: a combination
 * with four trades can top any of them by luck, and reporting it as the best would be
 * the sweep lying about what it found.
 */

/**
 * The most combinations a sweep may expand to.
 *
 * Not a performance budget — it cannot be, because what a combination costs depends
 * entirely on which parameter is being varied. Changing the reward-to-risk reuses the
 * detection and takes milliseconds; changing the minimum gap size forces a fresh one and
 * takes seconds on a year of 5-minute bars. A hundred thousand of the first kind is
 * minutes, a hundred thousand of the second is days.
 *
 * So this guards against a slip, not against ambition: a step of 0.001 where 0.1 was
 * meant expands to millions, and that is worth refusing before anything starts. Judging
 * the cost is `detectionCount`'s job, and the panel shows it next to this number.
 */
export const MAX_COMBINATIONS = 100_000;

/** How many decimals a step implies, so 0.05 gives 2 and 1 gives 0. */
function decimalsOf(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  // Exponent notation ("1e-7") has no decimals to count this way.
  if (text.includes('e') || text.includes('E')) return 10;
  return text.length - dot - 1;
}

function round(value, decimals) {
  const factor = 10 ** Math.min(decimals, 12);
  return Math.round(value * factor) / factor;
}

/**
 * The values one range produces, inclusive of both ends where the step lands on them.
 *
 * A step that overshoots the end simply stops: 4 to 20 by 7 gives 4, 11, 18 — never 25.
 * And a range whose ends are equal is one value, not zero, because "sweep this from 5 to
 * 5" plainly means "use 5".
 */
export function expandRange({ from, to, step }) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(`expandRange: from and to must be numbers, got ${from} and ${to}`);
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`expandRange: step must be a positive number, got ${step}`);
  }
  if (to < from) {
    throw new Error(`expandRange: to (${to}) is before from (${from})`);
  }

  const decimals = decimalsOf(step);
  const span = to - from;
  /* A hair of tolerance so a range that lands exactly on its end still includes it:
   * (3 - 1.2) / 0.1 is 17.999999999999996 in binary floating point, and flooring that
   * would drop the last value. */
  const steps = Math.floor(span / step + 1e-9);

  const out = [];
  for (let i = 0; i <= steps; i++) out.push(round(from + i * step, decimals));
  return out;
}

/** How many runs a set of ranges implies, without building them. */
export function countCombinations(ranges) {
  const entries = Object.entries(ranges ?? {});
  if (entries.length === 0) return 0;
  return entries.reduce((total, [, range]) => total * expandRange(range).length, 1);
}

/**
 * Every combination of the given ranges, as plain parameter objects.
 *
 * Ordered so the last key varies fastest, which is what makes a result list read as a
 * table rather than a shuffle.
 *
 * @param {Object<string, {from:number,to:number,step:number}>} ranges
 * @param {object} [base]   values shared by every combination
 * @param {number} [limit]  refuse rather than build more than this many
 */
export function expandSweep(ranges, base = {}, limit = MAX_COMBINATIONS) {
  const entries = Object.entries(ranges ?? {});
  if (entries.length === 0) return [];

  const total = countCombinations(ranges);
  if (total > limit) {
    throw new Error(
      `This sweep is ${total.toLocaleString()} combinations, over the limit of `
      + `${limit.toLocaleString()}. Widen a step or drop a parameter.`,
    );
  }

  const axes = entries.map(([key, range]) => ({ key, values: expandRange(range) }));
  let out = [{ ...base }];

  for (const axis of axes) {
    const next = [];
    for (const partial of out) {
      for (const value of axis.values) next.push({ ...partial, [axis.key]: value });
    }
    out = next;
  }
  return out;
}

/**
 * How many distinct detections a sweep will need.
 *
 * The number that actually decides how long a sweep takes. Detection results are cached
 * per set of detector parameters, so a sweep over the reward-to-risk detects once
 * however many reward levels it tries, while a sweep over the minimum gap size detects
 * once per value. Reporting the combination count alone would tell someone that 323 runs
 * are coming without saying whether that is twenty seconds or twenty minutes.
 *
 * @param {object} ranges
 * @param {string[]} detectionKeys  which parameters change what is detected
 */
export function detectionCount(ranges, detectionKeys = []) {
  const keys = new Set(detectionKeys);
  const entries = Object.entries(ranges ?? {}).filter(([key]) => keys.has(key));
  if (entries.length === 0) return 1; // nothing swept changes the detection
  return entries.reduce((total, [, range]) => total * expandRange(range).length, 1);
}

/* ─── Ranking ───────────────────────────────────────────────────────────── */

/** The measures a sweep can be sorted by, and how to read one off a result. */
export const RANK_METRICS = {
  expectancy: {
    id: 'expectancy',
    label: 'Expectancy per trade',
    hint: 'Net profit divided by the number of trades. Asks whether the rule itself is '
      + 'worth anything, regardless of how often it fired or how large the positions were.',
    read: (stats) => stats.expectancy,
  },
  netPnl: {
    id: 'netPnl',
    label: 'Net profit',
    hint: 'What the account ended up with. Direct, but it favours settings that traded '
      + 'more and risked more, even where the rule behind them is poor.',
    read: (stats) => stats.netPnl,
  },
  profitFactor: {
    id: 'profitFactor',
    label: 'Profit factor',
    hint: 'Gross profit over gross loss. Independent of position size and trade count, so '
      + 'it measures the quality of the rule — and says nothing about how often it fires.',
    read: (stats) => stats.profitFactor,
  },
  returnPct: {
    id: 'returnPct',
    label: 'Return',
    hint: 'What the account gained as a fraction of what it started with. Reads the same '
      + 'way across two runs with different starting balances, and nothing else.',
    read: (stats) => stats.returnPct,
  },
};

/**
 * Sorts sweep results best-first by one metric.
 *
 * A result with too few trades is not ranked at all rather than ranked badly: it is not
 * evidence either way, and leaving it in the ordering means the top of the list
 * eventually fills with combinations that happened to fire twice. The excluded ones come
 * back out under `excluded` so the UI can say how many were set aside and why, rather
 * than silently losing them.
 *
 * A null metric — no trades, or a profit factor with no losses to divide by — sorts last
 * for the same reason: it is an absence, not a high score.
 */
export function rankResults(results, metric = 'expectancy', minTrades = 10) {
  const spec = RANK_METRICS[metric];
  if (!spec) {
    throw new Error(`rankResults: unknown metric "${metric}". `
      + `Known: ${Object.keys(RANK_METRICS).join(', ')}`);
  }

  const ranked = [];
  const excluded = [];

  for (const result of results ?? []) {
    const trades = result?.stats?.tradeCount ?? 0;
    if (trades < minTrades) excluded.push(result);
    else ranked.push(result);
  }

  ranked.sort((a, b) => {
    const av = spec.read(a.stats);
    const bv = spec.read(b.stats);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  return { ranked, excluded };
}

/**
 * The best and worst few, for a side-by-side comparison.
 *
 * Both ends, never just the winners: the spread between them is what says whether a
 * parameter matters at all. Four combinations that all land within a hair of each other
 * mean the setting is not the thing driving the result, and only the loser's number
 * reveals that.
 *
 * Overlapping is possible and allowed — with five results, best-4 and worst-4 share
 * three. The caller decides what to do about that; hiding it would misrepresent how
 * little was actually tested.
 */
export function bestAndWorst(ranked, count = 4) {
  return {
    best: ranked.slice(0, count),
    worst: ranked.slice(-count).reverse(),
    overlapping: ranked.length < count * 2,
  };
}

/* ─── Splitting a range ─────────────────────────────────────────────────── */

/**
 * Splits a time range into the stretch a sweep optimises on and the stretch it is then
 * checked against.
 *
 * This is the only defence a sweep has against itself. Trying a thousand combinations on
 * one set of bars and keeping the best is a reliable way to find the combination that
 * memorised those bars — it will look excellent and mean nothing. Re-running the winners
 * on bars they never influenced is what separates a setting that holds from one that got
 * lucky.
 *
 * The test stretch is the LATER one. A rule tuned on recent data and checked against
 * older data is checked against a market that came first, which is not the question
 * anyone is asking.
 */
export function splitRange(from, to, trainFraction = 0.7) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error('splitRange: the range must end after it starts');
  }
  if (!(trainFraction > 0) || !(trainFraction < 1)) {
    throw new Error(`splitRange: the training fraction must be between 0 and 1, got ${trainFraction}`);
  }

  const cut = Math.round(from + (to - from) * trainFraction);
  return { train: { from, to: cut }, test: { from: cut, to } };
}
