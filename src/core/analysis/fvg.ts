/**
 * Fair value gaps — three-bar imbalances and what price did with them afterwards.
 *
 * A fair value gap (FVG, also "imbalance") is a stretch of price the market moved through so
 * fast that no two-sided auction happened there. It is read off three consecutive bars:
 *
 *   bullish   bars[i].low  > bars[i-2].high   gap = [high(i-2), low(i)]
 *   bearish   bars[i].high < bars[i-2].low    gap = [high(i),  low(i-2)]
 *
 * The middle bar is the impulse; the gap is the part of its range the neighbours never traded
 * into.
 *
 * One detector, two readers
 * -------------------------
 * The FVG *drawing tool* snaps to the gap under a click and the FVG *indicator* paints every
 * gap on the chart. A second detector that drifted would put the two on different levels for
 * the same market — click a box the indicator drew and land on something else — so both read
 * from here.
 *
 * Two indices, on purpose
 * -----------------------
 * A zone has a shape and a moment it becomes knowable, and they are not the same bar:
 *
 *   startIndex  where the zone begins on the chart. For drawing.
 *   index       the bar that confirms it. Nothing before this bar could have known the zone
 *               exists.
 *
 * A gap is drawn from bar i-2 but only confirmed at i. Collapsing the two is how look-ahead
 * gets into a backtest — draw from i-2 and hand a strategy the same number, and it trades a
 * level two bars before that level was formed. A renderer reads `startIndex`, a strategy reads
 * `index`, and neither may borrow the other's.
 *
 * Mitigation
 * ----------
 * A zone is "mitigated" once price returns into it. How far it has to come back is a genuine
 * disagreement between traders, so it is a parameter rather than a baked-in rule:
 *
 *   touch   price reaches the near edge
 *   ce      price reaches the midpoint — consequent encroachment
 *   full    price crosses the whole zone
 *   break   price CLOSES past the zone — a retest leaves it standing
 *
 * Mitigation is only ever tested on bars after the confirming bar. The bar that creates a zone
 * cannot fill it, however far its own wick runs.
 *
 * Stacked gaps
 * ------------
 * One impulse rarely leaves one gap. A move that runs for five bars leaves a gap under almost
 * every bar, separated by nothing but the thin strips the wicks did trade. Read one at a time
 * those are five zones; read the way a trader reads them they are one imbalance with a few
 * pinholes in it. `mergeWick` is how wide a traded strip may be before it counts as a real
 * separation.
 *
 * Neighbouring in time as well as in price, and that half is not optional: two gaps that merely
 * happen to sit at the same prices are not one imbalance, they are two, months apart. A run
 * therefore breaks as soon as one bar in it leaves no gap of its own.
 *
 * Merging happens before the size filter, never after — a run of thin gaps that adds up to a
 * tradable zone must not be thrown away one gap at a time before anyone has looked at what they
 * add up to.
 *
 * One gap per window
 * ------------------
 * `firstIn` narrows the result to the FIRST gap confirmed inside each of a set of bar windows,
 * and drops everything confirmed outside all of them. That is the first presented gap of a
 * session: one box per session rather than every imbalance in it.
 *
 * Windows are given as bar INDICES rather than times, because this module reads no clock (see
 * below) and which bars a London session covers is a question about time zones that belongs to
 * whoever owns the sessions.
 *
 * It is applied before `show` and `lookback`, and that order is the point: hiding filled zones
 * must not promote the second gap of a session into the first one's place. The first gap is the
 * first gap, whatever later became of it.
 *
 * Time units pass through untouched: nothing here interprets `bar.time`.
 */

/** How far price has to come back before a zone counts as used up. */
export type FvgMitigation = 'touch' | 'ce' | 'full' | 'break';

/** How a size threshold is read: against the price level the zone sits at, or raw. */
export type FvgSizeUnit = 'percent' | 'points';

/** Whether zones that are already filled stay in the result. */
export type FvgShow = 'open' | 'all';

const MITIGATIONS: readonly FvgMitigation[] = ['touch', 'ce', 'full', 'break'];
const SIZE_UNITS: readonly FvgSizeUnit[] = ['percent', 'points'];
const SHOW: readonly FvgShow[] = ['open', 'all'];

/** A stretch of bars, as indices into the array handed to the detector. Both ends inclusive. */
export interface FvgWindow {
    startIndex: number;
    endIndex: number;
}

/** The bar fields a gap is read from. `close` only matters to the `'break'` rule, but every
 *  real bar has one and a field that is there under three settings out of four is a trap. */
export interface FvgBar {
    time: number;
    high: number;
    low: number;
    close: number;
}

/** One detected gap. Indices are positions in the array that was passed in — a zone that is
 *  kept must be turned into (time, price) coordinates before anything holds on to it. */
export interface FvgZone {
    direction: 'bull' | 'bear';
    top: number;
    bottom: number;
    /** Height in price — the tie-breaker when boxes overlap (the smallest one wins a click). */
    size: number;
    /** Where the zone begins on the chart (bar i-2). For drawing. */
    startIndex: number;
    /** `bars[startIndex].time`. */
    startTime: number;
    /** The bar that confirms it (bar i). Nothing before this bar could know the zone exists. */
    index: number;
    /** `bars[index].time`. */
    time: number;
    /** The bar that filled it, or null while it is still open. */
    mitigatedIndex: number | null;
    /** `bars[mitigatedIndex].time`, or null. */
    mitigatedTime: number | null;
}

export interface FvgDetectOptions {
    /** How far price must return before the zone counts as filled. Default `'full'`. */
    mitigation?: FvgMitigation;
    /** Smallest zone to report; 0 = no filter. */
    minSize?: number;
    /** How to read {@link FvgDetectOptions.minSize} and {@link FvgDetectOptions.mergeWick}. */
    minSizeUnit?: FvgSizeUnit;
    /** Drop filled zones, or keep them. Default `'open'`. */
    show?: FvgShow;
    /** Only zones confirmed within the last N bars; 0 = all. */
    lookback?: number;
    /** How wide a traded strip may be before it counts as a real separation between two stacked
     *  gaps. Below it, neighbouring gaps of the same direction merge into one zone. 0 keeps
     *  every gap separate. */
    mergeWick?: number;
    /** Keep only the first zone confirmed inside each window, and drop every zone confirmed
     *  outside all of them. Undefined keeps the lot. Empty keeps nothing — a set of windows
     *  nobody asked for is not the same question as no filter. */
    firstIn?: readonly FvgWindow[];
}

/**
 * Every three-bar gap in `bars`: stacked runs joined up, narrowed by size, each closed on the
 * first later bar that reached into it. Ascending by confirming bar.
 */
export function detectFairValueGaps(bars: readonly FvgBar[], opts: FvgDetectOptions = {}): FvgZone[] {
    const mitigation = opts.mitigation ?? 'full';
    const minSizeUnit = opts.minSizeUnit ?? 'percent';
    const show = opts.show ?? 'open';
    check(mitigation, minSizeUnit, show);

    const zones = gapsFor(bars, opts.minSize ?? 0, minSizeUnit, opts.mergeWick ?? 0);
    applyMitigation(bars, zones, mitigation);
    const kept = opts.firstIn === undefined ? zones : firstInWindows(zones, opts.firstIn);
    return report(kept, bars.length, show, opts.lookback ?? 0);
}

/** A setting outside its own vocabulary is a caller bug, and a silent fallback would hide it
 *  behind zones that are quietly the wrong ones. */
function check(mitigation: FvgMitigation, minSizeUnit: FvgSizeUnit, show: FvgShow): void {
    if (!MITIGATIONS.includes(mitigation)) throw new Error(`detectFairValueGaps: unknown mitigation "${mitigation}"`);
    if (!SIZE_UNITS.includes(minSizeUnit)) throw new Error(`detectFairValueGaps: unknown minSizeUnit "${minSizeUnit}"`);
    if (!SHOW.includes(show)) throw new Error(`detectFairValueGaps: unknown show "${show}"`);
}

/** Found, stacked ones joined up, then narrowed by size — in that order. */
function gapsFor(bars: readonly FvgBar[], minSize: number, unit: FvgSizeUnit, mergeWick: number): FvgZone[] {
    const gaps = mergeGaps(findGaps(bars), mergeWick, unit);
    if (!(minSize > 0)) return gaps;
    return gaps.filter((g) => bigEnough(g.top, g.bottom, minSize, unit));
}

/** Every three-bar gap, in the order they formed, with no opinion about what happened next. */
function findGaps(bars: readonly FvgBar[]): FvgZone[] {
    const gaps: FvgZone[] = [];
    for (let i = 2; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const left = bars[i - 2]!;
        let direction: 'bull' | 'bear';
        let bottom: number;
        let top: number;
        if (bar.low > left.high) {
            direction = 'bull';
            bottom = left.high;
            top = bar.low;
        } else if (bar.high < left.low) {
            direction = 'bear';
            bottom = bar.high;
            top = left.low;
        } else continue;
        gaps.push({
            direction,
            top,
            bottom,
            size: top - bottom,
            startIndex: i - 2,
            startTime: left.time,
            index: i,
            time: bar.time,
            mitigatedIndex: null,
            mitigatedTime: null,
        });
    }
    return gaps;
}

/**
 * Joins runs of gaps separated only by strips too thin to count as a separation. Zones that do
 * not merge come back untouched.
 *
 * The merged zone spans every gap in the run, starts where the first one starts and is confirmed
 * where the LAST one is confirmed: nothing could know the extent of the run before its last gap
 * existed, and a strategy handed the earlier index would trade a zone that had not finished
 * forming.
 */
function mergeGaps(gaps: FvgZone[], mergeWick: number, unit: FvgSizeUnit): FvgZone[] {
    if (!(mergeWick > 0)) return gaps;
    const out: FvgZone[] = [];
    // The run each direction is currently building, or null.
    const runs: { bull: FvgZone | null; bear: FvgZone | null } = { bull: null, bear: null };
    for (const gap of gaps) {
        const run = runs[gap.direction];
        const strip = run === null ? null : stripBetween(run, gap);
        // Overlapping bar spans, and a strip between them thinner than the setting.
        const joins = run !== null && strip !== null && gap.startIndex <= run.index
            && !bigEnough(strip.top, strip.bottom, mergeWick, unit);
        if (!joins) {
            const fresh = { ...gap };
            runs[gap.direction] = fresh;
            out.push(fresh);
            continue;
        }
        run.top = Math.max(run.top, gap.top);
        run.bottom = Math.min(run.bottom, gap.bottom);
        run.size = run.top - run.bottom;
        if (gap.startIndex < run.startIndex) {
            run.startIndex = gap.startIndex;
            run.startTime = gap.startTime;
        }
        if (gap.index > run.index) {
            run.index = gap.index;
            run.time = gap.time;
        }
    }
    // Runs of the two directions interleave, so extending one can leave the array out of order —
    // and applyMitigation walks it expecting to meet zones in the order they were confirmed.
    return out.sort((a, b) => a.index - b.index);
}

/** The traded strip between two zones — the stretch of price that lies between them and did
 *  therefore change hands. Empty when they overlap or touch. */
function stripBetween(a: FvgZone, b: FvgZone): { top: number; bottom: number } {
    if (a.bottom > b.top) return { top: a.bottom, bottom: b.top };
    if (b.bottom > a.top) return { top: b.bottom, bottom: a.top };
    // A percentage still needs a real price to measure against, so an empty strip sits at the
    // edge the two share rather than at zero.
    const price = Math.max(a.bottom, b.bottom);
    return { top: price, bottom: price };
}

/**
 * Whether a span clears a threshold, in whichever unit was asked for.
 *
 * Percent measures against the zone's own price level, so one threshold works for a coin at
 * 100k and for one at 0.00001, and keeps meaning the same thing as price moves. Points measure
 * the raw distance the instrument is quoted in, which is what a fixed stop is sized in.
 */
function bigEnough(top: number, bottom: number, minSize: number, unit: FvgSizeUnit): boolean {
    const height = top - bottom;
    if (unit === 'points') return height >= minSize;
    const mid = (top + bottom) / 2;
    if (!(mid > 0)) return false; // a percentage of nothing is not a filter that can be applied
    return (height / mid) * 100 >= minSize;
}

/**
 * Walks the bars once and closes each zone on the first bar AFTER its own that reaches into it.
 * Zones must be ordered by `index`, which {@link mergeGaps} guarantees.
 */
function applyMitigation(bars: readonly FvgBar[], zones: FvgZone[], mitigation: FvgMitigation): void {
    const open: FvgZone[] = [];
    let next = 0;
    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        /* Closing runs before opening, which is what keeps a bar from filling the zone it
         * creates. Under 'touch' that would otherwise be the normal case: the near edge of a
         * fresh bullish gap is that bar's own low. */
        for (let k = open.length - 1; k >= 0; k -= 1) {
            const zone = open[k]!;
            if (!reaches(zone, bar, mitigation)) continue;
            zone.mitigatedIndex = i;
            zone.mitigatedTime = bar.time;
            open.splice(k, 1);
        }
        while (next < zones.length && zones[next]!.index <= i) open.push(zones[next++]!);
    }
}

/** Whether a bar returned far enough into the zone to count as mitigation. */
function reaches(zone: FvgZone, bar: FvgBar, mitigation: FvgMitigation): boolean {
    /* 'break' is the one rule a retest survives: the zone dies only when price CLOSES past it.
     * The other three end it the moment price comes back into it, which is what "mitigated"
     * means for a gap — the imbalance has been auctioned away. */
    if (mitigation === 'break') {
        return zone.direction === 'bull' ? bar.close < zone.bottom : bar.close > zone.top;
    }
    if (zone.direction === 'bull') {
        // Price comes back DOWN into a bullish zone.
        const level = mitigation === 'touch' ? zone.top : mitigation === 'ce' ? (zone.top + zone.bottom) / 2 : zone.bottom;
        return bar.low <= level;
    }
    const level = mitigation === 'touch' ? zone.bottom : mitigation === 'ce' ? (zone.top + zone.bottom) / 2 : zone.top;
    return bar.high >= level;
}

/**
 * The first zone confirmed inside each window, in confirmation order.
 *
 * Confirmed, not started: a gap whose first bar sits before the window opened is not that
 * window's first gap — it is the previous one's, finishing. Which is also the only reading a
 * session can be traded on, since nothing knew the zone existed until its confirming bar.
 *
 * Windows may overlap — London and New York do for two hours every day — and a gap inside both
 * is the first of both. It is one zone either way, so it comes back once.
 */
function firstInWindows(zones: readonly FvgZone[], windows: readonly FvgWindow[]): FvgZone[] {
    // Positions rather than zones: identity is enough to de-duplicate, and the order they are
    // put back in has to be the order they were confirmed in.
    const keep = new Set<number>();
    for (const window of windows) {
        const at = firstAtOrAfter(zones, window.startIndex);
        const zone = zones[at];
        if (zone !== undefined && zone.index <= window.endIndex) keep.add(at);
    }
    return [...keep].sort((a, b) => a - b).map((i) => zones[i]!);
}

/**
 * Where the first zone confirmed at or after `barIndex` sits, or `zones.length` when there is
 * none. Binary, because this runs once per window on every repaint and a year of 1m bars is
 * hundreds of sessions against thousands of zones.
 *
 * Zones arrive ascending by confirming bar, which {@link mergeGaps} guarantees.
 */
function firstAtOrAfter(zones: readonly FvgZone[], barIndex: number): number {
    let lo = 0;
    let hi = zones.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (zones[mid]!.index < barIndex) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** The two narrowing filters that do not change what a zone is. */
function report(zones: FvgZone[], barCount: number, show: FvgShow, lookback: number): FvgZone[] {
    const out = show === 'all' ? zones : zones.filter((z) => z.mitigatedIndex === null);
    // Counted back from the newest bar, not from a date: the window has to mean the same thing
    // after older bars are paged in behind it.
    if (!(lookback > 0)) return out;
    const cutoff = barCount - lookback;
    return out.filter((z) => z.index >= cutoff);
}
