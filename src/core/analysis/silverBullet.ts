import type { OHLCV } from '../model/ohlcv';
import { detectFairValueGaps, type FvgSizeUnit, type FvgZone } from './fvg';
import { detectStopHunts, type StopHunt } from './stophunt';
import { inWindow, localReading } from './tradingSessions';

/**
 * Silver Bullet — a sweep, a gap, a shift and a retest, inside one hour.
 *
 * Silver Bullet is a *time* before it is a pattern. Three one-hour windows, all in New York
 * local time, and outside them the setup does not exist however good it looks:
 *
 *   03:00-04:00  London open
 *   10:00-11:00  New York AM — the one most people mean
 *   14:00-15:00  New York PM
 *
 * New York local, not UTC, and read through `tradingSessions.ts` for the reason that file
 * spells out: the windows have to follow the US clock change rather than drift an hour off it
 * twice a year. Bar times must therefore be milliseconds.
 *
 * The sequence
 * ------------
 * Four things, in this order, and all four are required:
 *
 *   sweep   liquidity is taken — a high or a low is run and given back.
 *   gap     the reversal is impulsive enough to leave a fair value gap in the opposite
 *           direction.
 *   shift   price closes past the body of the last opposing candle before that gap. For a
 *           short: the last bullish candle before a bearish gap, closed below. This is the
 *           market structure shift, and it is where the setup becomes actionable.
 *   entry   price comes back and touches the near edge of the gap.
 *
 * None of these is invented here. The sweep comes from `stophunt.ts` and the gap from
 * `fvg.ts` — the same detectors the chart paints, so a setup can never sit on a level the
 * chart disagrees about.
 *
 * What the shift actually does
 * ----------------------------
 * It confirms; it does not select. An impulse steep enough to tear a gap has almost always
 * closed past the last candle that opposed it, so nearly every gap satisfies the shift within
 * a bar or two. What decides how many setups exist is the window, the sweep and `minGapSize`
 * — worth knowing before tuning, because loosening the shift will not produce more setups.
 *
 * Armed at the shift, not at the fill
 * -----------------------------------
 * This is the one place the detector deliberately departs from the naive reading, and the
 * whole reason a backtest built on it can be honest.
 *
 * A setup could be reported on the bar price *touched* the gap edge. That bar is knowable only
 * in hindsight: by the time it has closed, the touch has happened and the price is gone, so a
 * strategy reading it can do nothing better than send a market order into the next bar. Every
 * fill is then worse than the level the setup was built on, sometimes by a lot.
 *
 * The way this is actually traded is a resting limit order at the gap edge, and everything
 * that order needs — the edge, the stop beyond the sweep's wick, the target — is known at the
 * SHIFT bar. So that is where a setup is confirmed:
 *
 *   index        the shift bar. The only index a strategy may read; from here the order rests.
 *   expiryIndex  the last bar the order may still fill on. Past it the gap is no longer the
 *                level this move left behind, and the order comes off.
 *   fillIndex    where price actually came back, or null when it never did.
 *
 * Reporting setups that never filled is not noise, it is the point: a strategy that only ever
 * saw the ones price came back to would be handed a pre-filtered list — hindsight wearing a
 * limit order's clothes — and would never pay for the times its order sat there and expired.
 * `show` decides whether the chart draws them; a strategy asks for all of them.
 *
 * Three indices, again
 * --------------------
 * The same discipline as everywhere else in this folder. A setup is drawn from the sweep, but
 * nothing about it is knowable until the shift:
 *
 *   startIndex  the sweep — where the story starts on the chart. For drawing.
 *   index       the shift. For the engine.
 *
 * Every ingredient keeps its own confirmation index too (`sweepIndex` is the wick,
 * `hunt.index` was the reclaim), and the chain is assembled from the confirmed ones only. A
 * setup therefore cannot be built out of a gap that was not yet a gap, or a sweep that was not
 * yet a sweep.
 *
 * Outcomes are pessimistic, and that is a limitation
 * --------------------------------------------------
 * Each filled setup is walked forward to see whether the target or the stop came first. Where
 * one bar touches both, the stop wins — honest but pessimistic.
 *
 * The engine does better: it resolves such a bar by replaying the minute bars underneath it.
 * This detector has only the bars the chart is showing, so its `outcome` is an estimate biased
 * against the setup — read it as a sketch, and let a backtest settle anything that matters.
 */

/** Which of the three hours a setup belongs to. */
export type SilverBulletWindowId = 'london' | 'am' | 'pm';

/** How much of the chain has to fall inside the hour. */
export type SilverBulletScope = 'signal' | 'all';

/** Whether setups price never came back to stay in the result. */
export type SilverBulletShow = 'taken' | 'all';

/** What became of a setup. `armed` is the right edge of the data: the order is still resting. */
export type SilverBulletOutcome = 'target' | 'stop' | 'open' | 'armed' | 'expired';

/** One of the three windows, in minutes past local midnight in {@link ZONE}. */
export interface SilverBulletWindow {
    id: SilverBulletWindowId;
    label: string;
    startMin: number;
    endMin: number;
}

/** The three windows. Fixed: they are what the setup is named after. */
export const SILVER_BULLET_WINDOWS: readonly SilverBulletWindow[] = [
    { id: 'london', label: 'London', startMin: 3 * 60, endMin: 4 * 60 },
    { id: 'am', label: 'NY AM', startMin: 10 * 60, endMin: 11 * 60 },
    { id: 'pm', label: 'NY PM', startMin: 14 * 60, endMin: 15 * 60 },
];

/** The clock all three are read against. */
export const ZONE = 'America/New_York';

const WINDOW_IDS: readonly SilverBulletWindowId[] = ['london', 'am', 'pm'];
const SCOPES: readonly SilverBulletScope[] = ['signal', 'all'];
const SHOW: readonly SilverBulletShow[] = ['taken', 'all'];
const SIZE_UNITS: readonly FvgSizeUnit[] = ['percent', 'points'];

/** One complete setup. Indices are positions in the array that was passed in. */
export interface SilverBulletSetup {
    /** Named for what the setup does to price: a high was run, so the trade is short. */
    direction: 'bull' | 'bear';
    window: SilverBulletWindowId;
    windowLabel: string;
    /** One occurrence of one window — a local date plus the window, so "the first setup" can
     *  mean the first of that morning rather than the first ever. */
    slotKey: string;

    /* The sweep this grew out of. */
    sweepIndex: number;
    sweepTime: number;
    sweepLevel: number;
    /** The wick's furthest point past the level — where the stop goes. */
    sweepExtreme: number;

    /* The gap, carried whole so the chart can draw the same box `fvg.ts` would. */
    gapTop: number;
    gapBottom: number;
    gapStartIndex: number;
    gapIndex: number;

    /* The shift, and the candle body it broke. */
    shiftIndex: number;
    shiftTime: number;
    shiftLevel: number;
    shiftRefIndex: number;

    /** The near edge of the gap — where the order rests. Known at {@link SilverBulletSetup.index}. */
    entryPrice: number;
    /** Just beyond the wick that took the liquidity. */
    stop: number;
    target: number;
    /** Distance from the entry to the stop, per unit. */
    risk: number;
    rrr: number;

    /** The last bar the resting order may fill on. May sit past the end of the data. */
    expiryIndex: number;
    expiryTime: number;
    /** The bar price came back and filled at, or null while it has not (or never did). */
    fillIndex: number | null;
    fillTime: number | null;

    /** Where the story starts on the chart (the sweep). For drawing. */
    startIndex: number;
    startTime: number;
    /** The shift — the only index a strategy may read. */
    index: number;
    time: number;

    outcome: SilverBulletOutcome;
    outcomeIndex: number | null;
    outcomeTime: number | null;
    /** Bars from the fill to the outcome; null while nothing has resolved. */
    barsToOutcome: number | null;
}

export interface SilverBulletDetectOptions {
    /** Which hours count. Default all three; an empty list is a switched-off indicator. */
    windows?: readonly SilverBulletWindowId[];
    /** How much of the chain must fall inside the hour. Default `'signal'`. */
    scope?: SilverBulletScope;
    /** Bars either side of the swing the sweep runs. Default 2. */
    strength?: number;
    /** Bars the sweep has to be reclaimed within. Default 3. */
    confirmBars?: number;
    /** Bars the gap may lag the sweep by. Default 12. */
    maxSweepToGap?: number;
    /** Bars the retest may lag the gap by — and how long the order rests. Default 12. */
    maxGapToEntry?: number;
    /** Smallest gap worth trading; 0 keeps every one. Default 0. */
    minGapSize?: number;
    /** How {@link SilverBulletDetectOptions.minGapSize} and `mergeWick` are read. Default `'points'`. */
    minGapSizeUnit?: FvgSizeUnit;
    /** How wide a traded strip may be before two stacked gaps count as separate zones. Default 0. */
    mergeWick?: number;
    /** Target distance as a multiple of the risk. Default 2. */
    rrr?: number;
    /** Keep setups price never came back to. Default `'taken'`. */
    show?: SilverBulletShow;
    /** Only setups confirmed in the last N bars; 0 = all. Default 0. */
    lookback?: number;
}

/** The defaults, in one place — the indicator's schema is built from these. */
export const SILVER_BULLET_DEFAULTS = {
    windows: WINDOW_IDS,
    scope: 'signal' as SilverBulletScope,
    strength: 2,
    confirmBars: 3,
    maxSweepToGap: 12,
    maxGapToEntry: 12,
    minGapSize: 0,
    minGapSizeUnit: 'points' as FvgSizeUnit,
    mergeWick: 0,
    rrr: 2,
    show: 'taken' as SilverBulletShow,
    lookback: 0,
} as const;

/** Every Silver Bullet setup in `bars`, ascending by the shift that confirmed it. */
export function detectSilverBullet(bars: readonly OHLCV[], opts: SilverBulletDetectOptions = {}): SilverBulletSetup[] {
    const windows = opts.windows ?? SILVER_BULLET_DEFAULTS.windows;
    const scope = opts.scope ?? SILVER_BULLET_DEFAULTS.scope;
    const strength = opts.strength ?? SILVER_BULLET_DEFAULTS.strength;
    const confirmBars = opts.confirmBars ?? SILVER_BULLET_DEFAULTS.confirmBars;
    const maxSweepToGap = opts.maxSweepToGap ?? SILVER_BULLET_DEFAULTS.maxSweepToGap;
    const maxGapToEntry = opts.maxGapToEntry ?? SILVER_BULLET_DEFAULTS.maxGapToEntry;
    const minGapSize = opts.minGapSize ?? SILVER_BULLET_DEFAULTS.minGapSize;
    const minGapSizeUnit = opts.minGapSizeUnit ?? SILVER_BULLET_DEFAULTS.minGapSizeUnit;
    const mergeWick = opts.mergeWick ?? SILVER_BULLET_DEFAULTS.mergeWick;
    const rrr = opts.rrr ?? SILVER_BULLET_DEFAULTS.rrr;
    const show = opts.show ?? SILVER_BULLET_DEFAULTS.show;

    /* Thrown, not clamped: every one of these changes which setups EXIST, and a silently
     * corrected value would paint a chart that answers a different question. */
    for (const w of windows) {
        if (!WINDOW_IDS.includes(w)) throw new Error(`detectSilverBullet: unknown window "${w}". Known: ${WINDOW_IDS.join(', ')}`);
    }
    if (!SCOPES.includes(scope)) throw new Error(`detectSilverBullet: unknown scope "${scope}"`);
    if (!SHOW.includes(show)) throw new Error(`detectSilverBullet: unknown show "${show}"`);
    if (!SIZE_UNITS.includes(minGapSizeUnit)) throw new Error(`detectSilverBullet: unknown minGapSizeUnit "${minGapSizeUnit}"`);
    if (!(rrr > 0)) throw new Error(`detectSilverBullet: rrr must be > 0, got ${rrr}`);
    if (!(maxSweepToGap >= 1)) throw new Error(`detectSilverBullet: maxSweepToGap must be >= 1, got ${maxSweepToGap}`);
    if (!(maxGapToEntry >= 1)) throw new Error(`detectSilverBullet: maxGapToEntry must be >= 1, got ${maxGapToEntry}`);
    // No windows is a switched-off indicator, not an error.
    if (windows.length === 0 || bars.length === 0) return [];

    /* The sweep needs no hold window here: whether the reclaim survived ten bars later says
     * nothing about a trade that was already entered and resolved by then. */
    const hunts = detectStopHunts(bars, { sources: ['swing'], strength, confirmBars, holdBars: 0, show: 'all' });
    const zones = detectFairValueGaps(bars, { show: 'all', minSize: minGapSize, minSizeUnit: minGapSizeUnit, mergeWick });

    const slots = new SlotReader(bars, windows);
    const candidates: SilverBulletSetup[] = [];

    for (const hunt of hunts) {
        const setup = build(bars, hunt, zones, slots, { scope, maxSweepToGap, maxGapToEntry, rrr });
        if (setup !== null) candidates.push(setup);
    }

    /* Sorted BEFORE the one-per-window rule, not after: "the first setup of that morning" is
     * the earliest one, and the hunts it is built from arrive in reclaim order, which is not
     * the same thing. */
    candidates.sort((a, b) => a.index - b.index);

    const setups: SilverBulletSetup[] = [];
    const taken = new Set<string>();
    for (const setup of candidates) {
        if (taken.has(setup.slotKey)) continue;
        taken.add(setup.slotKey);
        resolve(bars, setup);
        setups.push(setup);
    }

    return report(setups, bars.length, show, opts.lookback ?? SILVER_BULLET_DEFAULTS.lookback);
}

/* ─── Windows ───────────────────────────────────────────────────────────── */

/** One occurrence of one window: a local date plus the window that day. */
interface Slot {
    id: SilverBulletWindowId;
    label: string;
    key: string;
}

/**
 * Which Silver Bullet hour a bar falls in, if any.
 *
 * Read on demand and remembered, rather than mapped across every bar up front. A year of 5m
 * bars is a hundred thousand wall-clock readings — and a hundred thousand `Intl` calls — to
 * answer a question that is only ever asked about the few dozen bars which confirmed
 * something.
 */
class SlotReader {
    private readonly memo = new Map<number, Slot | null>();
    private readonly active: readonly SilverBulletWindow[];

    constructor(private readonly bars: readonly OHLCV[], windows: readonly SilverBulletWindowId[]) {
        this.active = SILVER_BULLET_WINDOWS.filter((w) => windows.includes(w.id));
    }

    at(index: number): Slot | null {
        const hit = this.memo.get(index);
        if (hit !== undefined) return hit;

        const bar = this.bars[index];
        let slot: Slot | null = null;
        if (bar !== undefined) {
            /* The local date comes from the same reading as the clock: asking twice is how an
             * occurrence ends up filed under the wrong day either side of midnight. */
            const { minutes, day } = localReading(bar.time, ZONE);
            for (const w of this.active) {
                if (!inWindow(minutes, w.startMin, w.endMin)) continue;
                slot = { id: w.id, label: w.label, key: `${day}:${w.id}` };
                break;
            }
        }
        this.memo.set(index, slot);
        return slot;
    }
}

/* ─── The chain ─────────────────────────────────────────────────────────── */

interface ChainOptions {
    scope: SilverBulletScope;
    maxSweepToGap: number;
    maxGapToEntry: number;
    rrr: number;
}

/**
 * The first complete setup this sweep leads to, or null.
 *
 * One sweep can be followed by several gaps, and the first of them need not be the one that
 * works — the structure shift may not land in time, or the gap may sit beyond the sweep's own
 * extreme and leave no room for a stop. So the candidates are walked in order and the first
 * whose whole chain closes is kept, rather than taking the first gap and giving up when it
 * fails.
 */
function build(bars: readonly OHLCV[], hunt: StopHunt, zones: readonly FvgZone[], slots: SlotReader, opts: ChainOptions): SilverBulletSetup | null {
    /* Zones are ascending by confirming bar, so the search starts at the first one that could
     * possibly qualify instead of walking the whole series for every hunt. */
    for (let i = firstAfter(zones, hunt.index); i < zones.length; i += 1) {
        const gap = zones[i]!;
        if (gap.index - hunt.index > opts.maxSweepToGap) break;
        /* The gap has to point the same way the sweep does: a high was run, so the trade is
         * short, so the gap is bearish. */
        if (gap.direction !== hunt.direction) continue;

        const setup = chain(bars, hunt, gap, slots, opts);
        if (setup !== null) return setup;
    }
    return null;
}

/** Where the first zone confirmed strictly after `barIndex` sits. Binary, for the reason
 *  `firstAtOrAfter` in fvg.ts gives: this runs once per hunt on every repaint. */
function firstAfter(zones: readonly FvgZone[], barIndex: number): number {
    let lo = 0;
    let hi = zones.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (zones[mid]!.index <= barIndex) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** One sweep and one gap, carried through to an armed order — or null if the chain breaks. */
function chain(bars: readonly OHLCV[], hunt: StopHunt, gap: FvgZone, slots: SlotReader, opts: ChainOptions): SilverBulletSetup | null {
    const shift = findShift(bars, gap, opts.maxGapToEntry);
    if (shift === null) return null;

    const slot = slots.at(shift.index);
    if (slot === null) return null;
    if (opts.scope === 'all') {
        const key = slot.key;
        if (slots.at(hunt.sweepIndex)?.key !== key || slots.at(gap.index)?.key !== key) return null;
    }

    const short = hunt.direction === 'bear';
    /* The near edge, not the middle: the order rests at the boundary price returns to. For a
     * bearish gap that is its bottom — price has to come back UP to it. */
    const entryPrice = short ? gap.bottom : gap.top;
    /* The stop sits beyond the wick that took the liquidity. Where the entry is already past
     * it the setup is upside down and there is no trade in it — which happens when a later gap
     * sits beyond the sweep's own extreme. */
    const stop = hunt.extreme;
    const risk = short ? stop - entryPrice : entryPrice - stop;
    if (!(risk > 0)) return null;

    const target = short ? entryPrice - opts.rrr * risk : entryPrice + opts.rrr * risk;
    const expiryIndex = gap.index + opts.maxGapToEntry;

    return {
        direction: hunt.direction,
        window: slot.id,
        windowLabel: slot.label,
        slotKey: slot.key,

        sweepIndex: hunt.sweepIndex,
        sweepTime: hunt.sweepTime,
        sweepLevel: hunt.level,
        sweepExtreme: hunt.extreme,

        gapTop: gap.top,
        gapBottom: gap.bottom,
        gapStartIndex: gap.startIndex,
        gapIndex: gap.index,

        shiftIndex: shift.index,
        shiftTime: bars[shift.index]!.time,
        shiftLevel: shift.level,
        shiftRefIndex: shift.refIndex,

        entryPrice,
        stop,
        target,
        risk,
        rrr: opts.rrr,

        expiryIndex,
        expiryTime: timeAt(bars, expiryIndex),
        fillIndex: null,
        fillTime: null,

        /* Drawn from the sweep, actionable at the shift — the split every detector in this
         * folder keeps, for the reason fvg.ts gives at length. */
        startIndex: hunt.sweepIndex,
        startTime: hunt.sweepTime,
        index: shift.index,
        time: bars[shift.index]!.time,

        outcome: 'armed',
        outcomeIndex: null,
        outcomeTime: null,
        barsToOutcome: null,
    };
}

/**
 * The market structure shift: price closing past the body of the last opposing candle before
 * the gap.
 *
 * "Opposing" is what makes this a shift rather than a restatement of the gap. For a bearish
 * setup the reference is the last *bullish* candle — the final push up before the reversal —
 * and closing below its body says that push has been undone. The level is that candle's open,
 * which is the body edge facing the impulse in both directions.
 *
 * Doji are skipped: a candle with no body has no body edge to break.
 */
function findShift(bars: readonly OHLCV[], gap: FvgZone, limit: number): { index: number; level: number; refIndex: number } | null {
    const wantBull = gap.direction === 'bear';

    let refIndex = -1;
    for (let j = gap.startIndex - 1; j >= 0; j -= 1) {
        const b = bars[j]!;
        if (b.close === b.open) continue;
        if (b.close > b.open === wantBull) {
            refIndex = j;
            break;
        }
    }
    if (refIndex < 0) return null;

    const level = bars[refIndex]!.open;
    /* From the gap's confirming bar onwards — that bar is usually the impulse itself and is
     * allowed to be the one that breaks the body. */
    const last = Math.min(bars.length - 1, gap.index + limit);
    for (let k = gap.index; k <= last; k += 1) {
        const broke = gap.direction === 'bear' ? bars[k]!.close < level : bars[k]!.close > level;
        if (broke) return { index: k, level, refIndex };
    }
    return null;
}

/**
 * A bar time, extrapolated past the last bar with its own spacing.
 *
 * An expiry can fall past the end of the data — the order is still resting at the right edge —
 * and a time of `undefined` there would put the mark on the last bar instead, which reads as
 * "it expired here".
 */
function timeAt(bars: readonly OHLCV[], index: number): number {
    const last = bars.length - 1;
    if (index <= last) return bars[index]!.time;
    const spacing = bars.length > 1 ? bars[last]!.time - bars[last - 1]!.time : 0;
    return bars[last]!.time + (index - last) * spacing;
}

/**
 * Walks a setup forward: first to the fill, then to whichever of target and stop came first.
 *
 * The fill can be no earlier than the bar after the shift, which is exactly when an order
 * placed on the shift bar becomes live — see the engine's one-step rule. Where one bar touches
 * both the stop and the target, the stop wins; see the header.
 */
function resolve(bars: readonly OHLCV[], setup: SilverBulletSetup): void {
    const short = setup.direction === 'bear';
    const last = Math.min(bars.length - 1, setup.expiryIndex);

    let fill = -1;
    for (let i = setup.index + 1; i <= last; i += 1) {
        const bar = bars[i]!;
        const touched = short ? bar.high >= setup.entryPrice : bar.low <= setup.entryPrice;
        if (touched) {
            fill = i;
            break;
        }
    }

    if (fill < 0) {
        // Still resting at the right edge of the data, or the window closed on it.
        setup.outcome = setup.expiryIndex > bars.length - 1 ? 'armed' : 'expired';
        return;
    }

    setup.fillIndex = fill;
    setup.fillTime = bars[fill]!.time;
    setup.outcome = 'open';

    for (let i = fill; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const hitStop = short ? bar.high >= setup.stop : bar.low <= setup.stop;
        const hitTarget = short ? bar.low <= setup.target : bar.high >= setup.target;
        if (!hitStop && !hitTarget) continue;

        setup.outcome = hitStop ? 'stop' : 'target';
        setup.outcomeIndex = i;
        setup.outcomeTime = bar.time;
        setup.barsToOutcome = i - fill;
        return;
    }
}

/** The two filters that narrow what is reported without changing what a setup is. */
function report(setups: SilverBulletSetup[], barCount: number, show: SilverBulletShow, lookback: number): SilverBulletSetup[] {
    let out = show === 'all' ? setups : setups.filter((s) => s.fillIndex !== null);

    // Counted back from the newest bar, so the window survives paging in history.
    if (lookback > 0) {
        const cutoff = barCount - lookback;
        out = out.filter((s) => s.index >= cutoff);
    }
    return out;
}
