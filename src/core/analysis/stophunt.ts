import type { OHLCV } from '../model/ohlcv';
import { computeSessionWindows, type SessionPreset } from './tradingSessions';

/**
 * Stop hunts — liquidity taken above a high or below a low, and given back.
 *
 * A stop hunt (also "liquidity grab", "sweep", "stop raid") is price running through a level
 * where stop orders are known to sit, filling them, and then leaving. It is read off three
 * things, in this order:
 *
 *   a level   somewhere stops are resting, and everyone can see it
 *   a breach  price trades beyond that level
 *   a reclaim price comes back and closes on the original side
 *
 * All three are needed. A breach without a reclaim is not a hunt, it is a break — the level
 * gave way and price kept going. That distinction is the whole indicator: the same first two
 * bars belong to both, and only what happens afterwards says which one it was.
 *
 * Why a level is not just any high
 * ---------------------------------
 * Stops cluster where a chart is legible. Three kinds of level carry enough of them to be
 * worth hunting, and they are different enough that this file collects each in its own way:
 *
 *   swing    a fractal high or low — `strength` bars on each side are lower (higher). The
 *            universal case; every timeframe has them.
 *   equal    two or more swings at the same price within a tolerance. The real cluster: one
 *            obvious line, stops stacked behind all of it.
 *   session  the high and low of a completed trading session. Few, watched by everyone, and
 *            the reason the Asia range gets run at the London open.
 *
 * The sources are independent and can be combined; `sources` says which are on.
 *
 * Nothing may be known before it happened
 * -----------------------------------------
 * This is the one place a sweep detector goes quietly wrong, so it is worth being explicit. A
 * fractal high at bar i is not a fractal until `strength` bars to its right have closed lower.
 * At bar i nobody could know it: the next bar might print higher and there would be no swing
 * at all. Handing a strategy that level at bar i lets it trade a line the market had not drawn
 * yet, and the backtest comes back beautiful.
 *
 * Every level therefore carries two indices, the same split `range.ts` uses:
 *
 *   formedIndex  where the level sits on the chart. For drawing.
 *   knownIndex   the bar from which it could be acted on. For the engine.
 *
 * A sweep carries three, because it has one more moment than a zone does:
 *
 *   levelIndex   the level's formedIndex — where the line starts
 *   sweepIndex   the bar whose wick took the liquidity
 *   index        the bar that confirmed the reclaim; nothing earlier knew
 *
 * `index` is what a strategy reads, and it is never smaller than sweepIndex. With
 * `confirmBars` above 1 the two genuinely differ, and the gap between them is the number of
 * bars a trader spent not yet knowing.
 *
 * The confirmation window
 * ------------------------
 * `confirmBars` is how many bars price has to come back within, counted from the breaching
 * bar inclusive. So:
 *
 *   1   the breaching bar must itself close back inside. The strict reading — one candle,
 *       wick through, body back. Fewest and cleanest signals.
 *   n   price may close beyond the level for up to n-1 bars before reclaiming. Catches slower
 *       hunts, at the cost of more signals and a confirmation that arrives later.
 *
 * Past the window without a reclaim, the level is treated as genuinely broken and dropped. It
 * is not liquidity any more — it was spent, in the other direction. This is why a level can
 * only be swept once: the stops behind it filled the first time, and a second run at the same
 * price is running at nothing.
 *
 * A hunt has a lifetime, and it is short
 * -----------------------------------------
 * `holdBars` is how long after the reclaim price is still asked to respect the level. Closing
 * back through it inside that window means the reclaim failed — the level broke after all,
 * one leg later. Closing back through it a week later means nothing: markets revisit old
 * prices, and a level that was run in July is not still on trial in August.
 *
 * Without a window it is the second reading that wins, and it swallows almost everything. A
 * hunt that survives its window is settled and stops being watched.
 *
 * Direction is named after the trade, not the wick
 * ----------------------------------------------------
 * A hunt through a *high* takes buy-side liquidity and turns down, so it is `bear`. Through a
 * *low* it is `bull`. This matches how the zones in `fvg.ts` are named — direction is what the
 * level does to price afterwards — and it is the opposite of what the wick did, which is
 * exactly the point of the pattern.
 *
 * Time units are passed through untouched, with one exception: session levels read a wall
 * clock, so `sources` including `'session'` needs millisecond bar times — see
 * `tradingSessions.ts`.
 */

export type HuntSide = 'high' | 'low';
export type HuntDirection = 'bull' | 'bear';
export type HuntSource = 'swing' | 'equal' | 'session';
export type StopHuntShow = 'all' | 'active';

const SOURCES: readonly HuntSource[] = ['swing', 'equal', 'session'];
const SHOW: readonly StopHuntShow[] = ['all', 'active'];

/* Which source wins when two levels are swept by the same bar at the same price. An
 * equal-highs cluster and the individual swings inside it are the same liquidity described
 * twice; reporting both would double every signal the cluster produces. Higher wins. */
const SOURCE_RANK: Record<HuntSource, number> = { equal: 3, session: 2, swing: 1 };

/** One resolved stop hunt. Indices are positions in the array that was passed in. */
export interface StopHunt {
    /** Named for what the level does to price now, not for where the wick went. */
    direction: HuntDirection;
    side: HuntSide;
    source: HuntSource;
    level: number;
    /** The wick's furthest point past the level — where the raid actually reached. */
    extreme: number;
    /** How far past the level the wick reached. */
    depth: number;
    /** How many swings stacked into this level (an equal-highs/lows cluster only). */
    count: number;
    /** Which session the level came from — a session source only. */
    sessionName: string | null;

    /** The level's formedIndex — where the line starts. For drawing. */
    levelIndex: number;
    levelTime: number;
    /** The bar whose wick took the liquidity. */
    sweepIndex: number;
    sweepTime: number;
    /** The bar that confirmed the reclaim — the only index a strategy may read. */
    index: number;
    time: number;

    /** The bar that closed back through the level, undoing the reclaim — or null while it
     *  still holds (or its `holdBars` window ran out before one did). */
    invalidatedIndex: number | null;
    invalidatedTime: number | null;
}

export interface StopHuntDetectOptions {
    /** Which levels to watch. Default `['swing']`. */
    sources?: readonly HuntSource[];
    /** Bars either side of a swing point. Default 2. */
    strength?: number;
    /** Bars price may take to reclaim, counted from the breaching bar inclusive. Default 3. */
    confirmBars?: number;
    /** Percent two swings may differ by and still count as one equal-highs/lows level. Default 0.05. */
    equalTolerance?: number;
    /** Which desk's sessions provide the session source. Default 'futures'. */
    sessionPreset?: SessionPreset;
    /** Percent the wick must clear the level by. Default 0. */
    minWick?: number;
    /** Bars the reclaim must hold for; 0 = forever. Default 10. */
    holdBars?: number;
    /** Drop hunts price has since invalidated. Default 'all'. */
    show?: StopHuntShow;
    /** Only hunts confirmed in the last N bars; 0 = all. Default 0. */
    lookback?: number;
}

/** The defaults, in one place — the indicator's schema is built from these. */
export const STOPHUNT_DEFAULTS = {
    sources: ['swing'] as readonly HuntSource[],
    strength: 2,
    confirmBars: 3,
    equalTolerance: 0.05,
    sessionPreset: 'futures' as SessionPreset,
    minWick: 0,
    holdBars: 10,
    show: 'all' as StopHuntShow,
    lookback: 0,
} as const;

/** Every stop hunt in `bars`, ascending by confirmation. */
export function detectStopHunts(bars: readonly OHLCV[], opts: StopHuntDetectOptions = {}): StopHunt[] {
    const sources = opts.sources ?? STOPHUNT_DEFAULTS.sources;
    const strength = opts.strength ?? STOPHUNT_DEFAULTS.strength;
    const confirmBars = opts.confirmBars ?? STOPHUNT_DEFAULTS.confirmBars;
    const equalTolerance = opts.equalTolerance ?? STOPHUNT_DEFAULTS.equalTolerance;
    const sessionPreset = opts.sessionPreset ?? STOPHUNT_DEFAULTS.sessionPreset;
    const minWick = opts.minWick ?? STOPHUNT_DEFAULTS.minWick;
    const holdBars = opts.holdBars ?? STOPHUNT_DEFAULTS.holdBars;
    const show = opts.show ?? STOPHUNT_DEFAULTS.show;

    for (const s of sources) {
        if (!SOURCES.includes(s)) throw new Error(`detectStopHunts: unknown source "${s}". Known: ${SOURCES.join(', ')}`);
    }
    if (!SHOW.includes(show)) throw new Error(`detectStopHunts: unknown show "${show}"`);
    if (!(strength >= 1)) throw new Error(`detectStopHunts: strength must be >= 1, got ${strength}`);
    if (!(confirmBars >= 1)) throw new Error(`detectStopHunts: confirmBars must be >= 1, got ${confirmBars}`);
    if (!(holdBars >= 0)) throw new Error(`detectStopHunts: holdBars must be >= 0, got ${holdBars}`);
    // No sources is a switched-off indicator, not an error.
    if (sources.length === 0 || bars.length === 0) return [];

    const levels = collectLevels(bars, { sources, strength, equalTolerance, sessionPreset });
    const hunts = findSweeps(bars, levels, confirmBars, minWick);
    applyInvalidation(bars, hunts, holdBars);
    return report(hunts, bars.length, show, opts.lookback ?? STOPHUNT_DEFAULTS.lookback);
}

/* ─── Levels ────────────────────────────────────────────────────────────── */

/** One level, in the shape `findSweeps` walks. */
interface Level {
    side: HuntSide;
    price: number;
    formedIndex: number;
    formedTime: number;
    knownIndex: number;
    source: HuntSource;
    count: number;
    sessionName: string | null;
}

function level(side: HuntSide, price: number, formedIndex: number, formedTime: number, knownIndex: number, source: HuntSource, sessionName: string | null = null, count = 1): Level {
    return { side, price, formedIndex, formedTime, knownIndex, source, count, sessionName };
}

/** Every level the chosen sources produce, ordered by the bar it became knowable on — which
 *  is the order `findSweeps` needs to walk them in. */
function collectLevels(
    bars: readonly OHLCV[],
    opt: { sources: readonly HuntSource[]; strength: number; equalTolerance: number; sessionPreset: SessionPreset },
): Level[] {
    const swings = findSwings(bars, opt.strength);
    const levels: Level[] = [];

    if (opt.sources.includes('swing')) levels.push(...swings);
    if (opt.sources.includes('equal')) levels.push(...equalLevels(swings, opt.equalTolerance));
    if (opt.sources.includes('session')) levels.push(...sessionLevels(bars, opt.sessionPreset));

    levels.sort((a, b) => a.knownIndex - b.knownIndex);
    return levels;
}

/**
 * Fractal swing points: a high with `strength` lower highs on each side, and the mirror for
 * lows.
 *
 * Ties count as failures on both sides. Two bars at exactly the same high are not a swing
 * between them — they are the equal-highs case, which is a different level with different
 * stops behind it, and is built separately.
 */
export function findSwings(bars: readonly OHLCV[], strength: number): Level[] {
    const out: Level[] = [];

    for (let i = strength; i < bars.length - strength; i += 1) {
        let isHigh = true;
        let isLow = true;

        for (let k = 1; k <= strength; k += 1) {
            const left = bars[i - k]!;
            const right = bars[i + k]!;
            if (left.high >= bars[i]!.high || right.high >= bars[i]!.high) isHigh = false;
            if (left.low <= bars[i]!.low || right.low <= bars[i]!.low) isLow = false;
            if (!isHigh && !isLow) break;
        }

        /* knownIndex is i + strength, never i: the right-hand bars are what make it a swing,
         * and the last of them closes there. See the header. */
        if (isHigh) out.push(level('high', bars[i]!.high, i, bars[i]!.time, i + strength, 'swing'));
        if (isLow) out.push(level('low', bars[i]!.low, i, bars[i]!.time, i + strength, 'swing'));
    }

    return out;
}

/** Whether two prices are the same level, within a percentage of the first. */
function withinTolerance(a: number, b: number, tolerancePercent: number): boolean {
    if (tolerancePercent <= 0) return a === b;
    // A percentage of nothing cannot be compared against.
    if (!(Math.abs(a) > 0)) return a === b;
    return (Math.abs(a - b) / Math.abs(a)) * 100 <= tolerancePercent;
}

/**
 * Clusters of swings at the same price — equal highs and equal lows.
 *
 * The level is the cluster's extreme, not its average: stops sit beyond the furthest of them,
 * so a run that stopped at the mean would not have filled anything. It is drawn from the
 * first swing in the cluster, because that is where the line starts being visible on a chart,
 * and becomes knowable with the second — one high is not an equal high.
 *
 * A cluster stays open as long as further swings keep landing in tolerance of its extreme, so
 * a triple top is one level of three, not two of two.
 */
export function equalLevels(swings: readonly Level[], tolerancePercent: number): Level[] {
    const out: Level[] = [];

    for (const side of ['high', 'low'] as const) {
        const pts = swings.filter((s) => s.side === side);
        const used = new Array<boolean>(pts.length).fill(false);

        for (let i = 0; i < pts.length; i += 1) {
            if (used[i]) continue;
            const members = [pts[i]!];
            let extreme = pts[i]!.price;

            for (let j = i + 1; j < pts.length; j += 1) {
                if (used[j]) continue;
                if (!withinTolerance(extreme, pts[j]!.price, tolerancePercent)) continue;
                used[j] = true;
                members.push(pts[j]!);
                extreme = side === 'high' ? Math.max(extreme, pts[j]!.price) : Math.min(extreme, pts[j]!.price);
            }

            if (members.length < 2) continue;
            used[i] = true;

            const first = members[0]!;
            const second = members[1]!;
            out.push(level(side, extreme, first.formedIndex, first.formedTime, second.knownIndex, 'equal', null, members.length));
        }
    }

    return out;
}

/**
 * The high and low of every completed session in the data.
 *
 * Only completed ones: a session's high is not a level while the session is still making it.
 * The session running at the right edge of the data is therefore skipped, which is right —
 * its extremes are still moving.
 */
export function sessionLevels(bars: readonly OHLCV[], preset: SessionPreset): Level[] {
    const windows = computeSessionWindows(bars, preset);
    const out: Level[] = [];
    const lastIndex = bars.length - 1;

    for (const w of windows) {
        // Still open at the right edge of the data — its extremes are not final.
        if (w.endIndex >= lastIndex) continue;
        const known = w.endIndex + 1;
        out.push(level('high', w.high, w.startIndex, w.startTime, known, 'session', w.name));
        out.push(level('low', w.low, w.startIndex, w.startTime, known, 'session', w.name));
    }

    return out;
}

/* ─── Sweeps ────────────────────────────────────────────────────────────── */

/** A level that has been breached and is waiting on its reclaim window. */
interface Pending extends Level {
    sweepIndex: number;
    sweepTime: number;
    extreme: number;
}

/**
 * Walks the bars once, holding the levels that are both known and unspent, and closes each
 * one the first time price trades beyond it.
 *
 * A breach opens a window rather than producing a signal, because at the breaching bar the
 * outcome is not yet decided. The window resolves one of two ways and the level is gone
 * either way: reclaimed, and it was a hunt; or run out, and the level genuinely broke.
 */
function findSweeps(bars: readonly OHLCV[], levels: readonly Level[], confirmBars: number, minWick: number): StopHunt[] {
    const hunts: StopHunt[] = [];
    const open: Level[] = []; // known, not yet breached
    const pending: Pending[] = []; // breached, waiting on the reclaim window
    let next = 0;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;

        /* Pending first: a level breached at an earlier bar can be reclaimed at this one, and
         * resolving those before opening new breaches keeps the two from interleaving on the
         * same bar. */
        for (let k = pending.length - 1; k >= 0; k -= 1) {
            const p = pending[k]!;
            if (reclaims(p, bar)) {
                pending.splice(k, 1);
                hunts.push(hunt(p, bars, i));
                continue;
            }
            // Window counted from the breaching bar inclusive: 1 means that bar only.
            if (i - p.sweepIndex >= confirmBars - 1) pending.splice(k, 1);
        }

        /* A level becomes available on its knownIndex, never before. Levels are sorted by it,
         * so this walks the array once across the whole loop. */
        while (next < levels.length && levels[next]!.knownIndex <= i) open.push(levels[next++]!);

        for (let k = open.length - 1; k >= 0; k -= 1) {
            const lv = open[k]!;
            /* A level cannot be swept by a bar that helped form it. A session high is some
             * bar's high, and a swing high is literally bars[formedIndex]'s; without this the
             * level is breached on the bar it came from. */
            if (i <= lv.formedIndex) continue;
            if (!breaches(lv, bar, minWick)) continue;

            open.splice(k, 1);
            const p: Pending = { ...lv, sweepIndex: i, sweepTime: bar.time, extreme: lv.side === 'high' ? bar.high : bar.low };

            /* The breaching bar gets the first chance to reclaim, whatever the window is: one
             * candle through and back is a hunt under every reading. Only if it does not close
             * back inside does the window open. */
            if (reclaims(p, bar)) hunts.push(hunt(p, bars, i));
            else if (confirmBars > 1) pending.push(p);
        }
    }

    hunts.sort((a, b) => a.index - b.index || a.sweepIndex - b.sweepIndex);
    return dedupe(hunts);
}

/** Whether a bar traded far enough beyond a level to have filled stops. */
function breaches(lv: Level, bar: OHLCV, minWick: number): boolean {
    if (lv.side === 'high') {
        if (!(bar.high > lv.price)) return false;
        return minWick <= 0 || beyondEnough(bar.high - lv.price, lv.price, minWick);
    }
    if (!(bar.low < lv.price)) return false;
    return minWick <= 0 || beyondEnough(lv.price - bar.low, lv.price, minWick);
}

/* Measured as a percentage of the level, for the reason `bigEnough()` in fvg.ts gives: one
 * threshold has to keep meaning the same thing across instruments and as price moves. */
function beyondEnough(distance: number, price: number, minWick: number): boolean {
    if (!(Math.abs(price) > 0)) return false;
    return (distance / Math.abs(price)) * 100 >= minWick;
}

/** Whether a bar closed back on the level's original side. */
function reclaims(p: Pending, bar: OHLCV): boolean {
    return p.side === 'high' ? bar.close < p.price : bar.close > p.price;
}

/** A resolved hunt, in the shape the chart and a strategy both read. */
function hunt(p: Pending, bars: readonly OHLCV[], confirmIndex: number): StopHunt {
    return {
        // Named for what the level does to price now, not for where the wick went.
        direction: p.side === 'high' ? 'bear' : 'bull',
        side: p.side,
        source: p.source,
        level: p.price,
        extreme: p.extreme,
        // How far past the level the wick reached — the depth of the raid.
        depth: Math.abs(p.extreme - p.price),
        count: p.count,
        sessionName: p.sessionName,

        levelIndex: p.formedIndex,
        levelTime: p.formedTime,

        sweepIndex: p.sweepIndex,
        sweepTime: p.sweepTime,

        /* Confirmation. Never earlier than the sweep, and the only index a strategy may
         * read — see the header. */
        index: confirmIndex,
        time: bars[confirmIndex]!.time,

        invalidatedIndex: null,
        invalidatedTime: null,
    };
}

/**
 * Drops hunts that describe the same liquidity twice.
 *
 * An equal-highs cluster and each swing inside it are one line on the chart, and a bar that
 * runs the cluster runs all of them. Same bar, same side, same price: keep the strongest
 * source and drop the rest.
 */
function dedupe(hunts: readonly StopHunt[]): StopHunt[] {
    const seen = new Map<string, StopHunt>();

    for (const h of hunts) {
        const key = `${h.sweepIndex}:${h.side}:${h.level}`;
        const prev = seen.get(key);
        if (!prev || SOURCE_RANK[h.source] > SOURCE_RANK[prev.source]) seen.set(key, h);
    }

    return hunts.filter((h) => seen.get(`${h.sweepIndex}:${h.side}:${h.level}`) === h);
}

/**
 * Marks each hunt with the bar that proved it wrong, if one did — but only while it is still
 * on trial.
 *
 * A hunt says price rejected a level. Closing back beyond that level says it did not, and
 * `holdBars` is how long that question stays open. A hunt that survives its window is settled
 * and stops being watched.
 *
 * The hunt still happened either way and its mark still says where, so a failure is annotated
 * rather than deleted; `show` decides whether it stays on the chart.
 */
function applyInvalidation(bars: readonly OHLCV[], hunts: StopHunt[], holdBars: number): void {
    const live: StopHunt[] = [];
    let next = 0;

    for (let i = 0; i < bars.length; i += 1) {
        for (let k = live.length - 1; k >= 0; k -= 1) {
            const h = live[k]!;
            // Out of its window: it held, and nothing later can take that back.
            if (holdBars > 0 && i - h.index > holdBars) {
                live.splice(k, 1);
                continue;
            }
            const failed = h.side === 'high' ? bars[i]!.close > h.level : bars[i]!.close < h.level;
            if (!failed) continue;
            h.invalidatedIndex = i;
            h.invalidatedTime = bars[i]!.time;
            live.splice(k, 1);
        }
        /* Opening after closing keeps the confirming bar from invalidating itself: it closed
         * back inside by definition, but the next bar need not have. */
        while (next < hunts.length && hunts[next]!.index <= i) live.push(hunts[next++]!);
    }
}

/** The two filters that narrow what is reported without changing what a hunt is. */
function report(hunts: StopHunt[], barCount: number, show: StopHuntShow, lookback: number): StopHunt[] {
    let out = show === 'all' ? hunts : hunts.filter((h) => h.invalidatedIndex === null);

    // Counted back from the newest bar, so the window survives paging in history.
    if (lookback > 0) {
        const cutoff = barCount - lookback;
        out = out.filter((h) => h.index >= cutoff);
    }
    return out;
}
