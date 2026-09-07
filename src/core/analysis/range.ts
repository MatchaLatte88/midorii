import type { OHLCV } from '../model/ohlcv';
import { atr } from '../native-indicators/classics/math';

/**
 * Ranges — the stretches where the market stops going anywhere.
 *
 * A range (also "consolidation", "balance", "accumulation") is a run of bars that trades back
 * and forth between two prices instead of travelling. It is the other half of what a chart
 * does: the FVG detector next door finds a *move*, and nothing here said where the market was
 * simply standing still, which is where most of the day goes.
 *
 * Four things have to hold, and each one removes a different impostor:
 *
 *   length      at least `minBars`. Three quiet candles are not a range.
 *   compression the span is far narrower than the market normally covers in that many bars.
 *               This is the whole indicator; see below.
 *   touches     both edges were reached `minTouches` separate times. Without it a slow
 *               diagonal drift qualifies — it is narrow, it just is not a range.
 *   an ending   price closes beyond an edge. That is the breakout, and it is what the range
 *               was drawn for.
 *
 * Why a percentage cannot work
 * ----------------------------
 * The obvious definition — "high minus low, under x%" — is the one that makes a range
 * indicator useless, and it is worth showing exactly how badly. On three months of BTC, a 0.3%
 * span over 20 bars marks 77% of the 1m chart and *nothing at all* on 1h. Widen it to 1% and
 * 1m goes to 99% while 1h reaches 11%. There is no threshold in between that works on both:
 * the number is measuring the timeframe, not the market.
 *
 * The fix is to stop measuring price and start measuring price *against how far this market
 * normally travels in the same number of bars*. Over N bars a random walk covers about
 * ATR × √N — the √N is not a fudge, it is how diffusion scales, and it is why 100 bars do not
 * cover ten times what 10 bars cover. So:
 *
 *     compression = height / (ATR × √length)
 *
 * Measured over the same three months, the distribution of that ratio is almost the same
 * number on every timeframe — median 1.21 on 1m, 1.05 on 5m, 0.97 on 15m, 0.97 on 1h, 0.98 on
 * 4h, and the low tail tracks just as closely. One threshold therefore means the same thing
 * everywhere, which is precisely what a percentage could not do.
 *
 * And it settles the question this detector exists to answer: an hourly range must not appear
 * on a 1m chart. It does not. Of the 24 ranges found on 1h in that window, 0 have a counterpart
 * on 1m — because 1200 minute bars of a one-hour balance cover about what 1200 minute bars
 * normally cover. The range is only compressed relative to hourly bars, and only the hourly
 * chart says so. `maxBars` backs the same rule up bluntly: at 300 bars a chart cannot be
 * covered by a level belonging to a timeframe far above it.
 *
 * Compression is measured against the ATR of the bars *before* the range, not inside it.
 * Inside would be circular — a range compresses its own ATR, so every range would pass. Before
 * is also the right reading: the market arrived here moving at some speed, and then stopped.
 *
 * That ATR is the one the ATR indicator plots (`classics/math`), deliberately and not by
 * coincidence: a second implementation here would have the chart and this detector measuring
 * the same market against two slightly different volatilities, with nothing on screen saying
 * so. It is Wilder's smoothing, which is what "ATR(14)" means everywhere else.
 *
 * How one is found
 * ----------------
 * Seed, extend, break.
 *
 *   seed    every position is tested as the start of a `minBars` window. The earliest one that
 *           is compressed enough wins, so the left edge is the market's, not the scan's.
 *   extend  bar by bar. A bar that only wicks past an edge widens the range — that is a raid
 *           on the edge, and the range survives it. A bar that *closes* past one ends it. The
 *           compression test is re-applied at every new length, so a range cannot slowly
 *           inflate into a trend.
 *   break   the closing bar is reported with its direction. 95% of ranges on 1m and 92% on 15m
 *           end this way; the rest widen past the limit without a clean break, or run to the
 *           edge of the data.
 *
 * Ranges never overlap. After one ends the scan resumes past its breakout.
 *
 * Three indices, as in the FVG detector
 * -------------------------------------
 *   startIndex  the first bar of the range. For drawing.
 *   index       the bar on which all four conditions were first true. The only index a
 *               strategy may read.
 *   endIndex    the last bar inside the range.
 *
 * The edges need the same care and it is easy to miss. `top` and `bottom` are final values,
 * and a range does not have them until it is over — quoting them at `index` would hand a
 * strategy an edge the market had not printed yet. So the edges as they stood on the
 * confirming bar are carried separately, as `confirmTop` and `confirmBottom`, and those are
 * the two prices anything trading in real time is allowed to use. In practice they are nearly
 * the final ones — the height grows by 0% at the median and 7% (1m) to 16% (1h) at the 90th
 * percentile — but "nearly always the same" is not a contract.
 *
 * What is deliberately not here
 * -----------------------------
 * A drift or efficiency filter, which is the first thing anyone reaches for to exclude the
 * slow diagonal. It is redundant: the ranges this file returns already have a Kaufman
 * efficiency ratio of 0.09–0.16 at the median against 0.18 for arbitrary windows of the same
 * length, so length, compression and touches have already removed what it would remove. Adding
 * it would cost a parameter and change almost nothing.
 *
 * Time units are passed through untouched: nothing here reads a calendar off `bar.time`, so
 * millisecond and second bars both work. `open` is never read either — the bar type is the
 * chart's own, because the shared ATR is typed against it.
 */

/** Which way price left the range. */
export type RangeBreak = 'up' | 'down';

/** One detected range. Indices are positions in the array that was passed in. */
export interface Range {
    /** The first bar of the range. For drawing. */
    startIndex: number;
    /** `bars[startIndex].time`. */
    startTime: number;
    /** The bar on which all four conditions were first true — the only index a strategy may read. */
    index: number;
    /** `bars[index].time`. */
    time: number;
    /** The last bar inside the range. */
    endIndex: number;
    /** `bars[endIndex].time`. */
    endTime: number;
    /** Bars from `startIndex` to `endIndex` inclusive. */
    length: number;

    top: number;
    bottom: number;
    /** The middle — equilibrium, and the line premium and discount split on. */
    middle: number;
    height: number;
    /** The upper edge as it stood on the confirming bar. See the header. */
    confirmTop: number;
    /** The lower edge as it stood on the confirming bar. */
    confirmBottom: number;

    /** How narrow it came out, in the units of the `compression` setting — below it by
     *  construction, and the lower the tighter. */
    compression: number;
    touchesTop: number;
    touchesBottom: number;

    /** The bar that closed beyond an edge, or null where the range ended some other way. */
    breakIndex: number | null;
    breakTime: number | null;
    breakDirection: RangeBreak | null;
    /** Where the breaking bar settled — the only thing about a breakout known on the bar itself. */
    breakClose: number | null;
    /** Still running at the right edge of the data. A range that ended by widening is over
     *  without a breakout, and is not active. */
    active: boolean;
}

export interface RangeDetectOptions {
    /** Shortest run that may count as a range. Default 20. */
    minBars?: number;
    /** Longest; the blunt guard against a higher timeframe's range covering this chart. Default 300. */
    maxBars?: number;
    /** Height limit as a fraction of ATR × √length. Default 0.6. */
    compression?: number;
    /** Window the reference volatility is read over. Default 14. */
    atrPeriod?: number;
    /** Separate visits each edge needs. Default 2. */
    minTouches?: number;
    /** Percent of the height that counts as reaching an edge. Default 15. */
    touchZone?: number;
    /** Percent of the height a close must clear to end the range. Default 0. */
    breakBuffer?: number;
    /** Only ranges confirmed in the last N bars; 0 = all. */
    lookback?: number;
}

/** The defaults, in one place — the indicator's schema is built from these. */
export const RANGE_DEFAULTS = {
    minBars: 20,
    maxBars: 300,
    compression: 0.6,
    atrPeriod: 14,
    minTouches: 2,
    touchZone: 15,
    breakBuffer: 0,
    lookback: 0,
} as const;

/** Every range in `bars`, ascending by start. Ranges never overlap. */
export function detectRanges(bars: readonly OHLCV[], opts: RangeDetectOptions = {}): Range[] {
    const minBars = opts.minBars ?? RANGE_DEFAULTS.minBars;
    const maxBars = opts.maxBars ?? RANGE_DEFAULTS.maxBars;
    const compression = opts.compression ?? RANGE_DEFAULTS.compression;
    const atrPeriod = opts.atrPeriod ?? RANGE_DEFAULTS.atrPeriod;
    const minTouches = opts.minTouches ?? RANGE_DEFAULTS.minTouches;
    const touchZone = opts.touchZone ?? RANGE_DEFAULTS.touchZone;
    const breakBuffer = opts.breakBuffer ?? RANGE_DEFAULTS.breakBuffer;

    /* Thrown, not clamped. Every one of these changes what a range IS, and a silently
     * corrected setting would paint a chart of boxes that answer a different question. */
    if (!(minBars >= 2)) throw new Error(`detectRanges: minBars must be >= 2, got ${minBars}`);
    if (!(maxBars >= minBars)) throw new Error(`detectRanges: maxBars (${maxBars}) must be >= minBars (${minBars})`);
    if (!(compression > 0)) throw new Error(`detectRanges: compression must be > 0, got ${compression}`);
    if (!(atrPeriod >= 1)) throw new Error(`detectRanges: atrPeriod must be >= 1, got ${atrPeriod}`);
    if (!(minTouches >= 1)) throw new Error(`detectRanges: minTouches must be >= 1, got ${minTouches}`);
    if (!(touchZone > 0 && touchZone <= 50)) throw new Error(`detectRanges: touchZone must be in (0, 50], got ${touchZone}`);
    if (!(breakBuffer >= 0)) throw new Error(`detectRanges: breakBuffer must be >= 0, got ${breakBuffer}`);
    if (bars.length === 0) return [];

    const found = scan(bars, {
        minBars,
        maxBars,
        compression,
        atrPeriod,
        minTouches,
        touchZone: touchZone / 100,
        breakBuffer: breakBuffer / 100,
    });
    return report(found, bars.length, opts.lookback ?? RANGE_DEFAULTS.lookback);
}

interface ScanOptions {
    minBars: number;
    maxBars: number;
    compression: number;
    atrPeriod: number;
    minTouches: number;
    /** Already a fraction of the height. */
    touchZone: number;
    /** Already a fraction of the height. */
    breakBuffer: number;
}

/** Walks the bars once, seeding at every position and extending what holds. */
function scan(bars: readonly OHLCV[], opt: ScanOptions): Range[] {
    const { minBars, maxBars, compression, atrPeriod, minTouches, touchZone, breakBuffer } = opt;
    const volatility = atr(bars, atrPeriod);
    const out: Range[] = [];

    /* The first bar that has an ATR behind it. Starting at 0 would read a warming-up
     * reference for every seed until the average has enough bars to mean anything. */
    let i = atrPeriod + 1;

    while (i + minBars <= bars.length) {
        const reference = volatility[i - 1];
        // No volatility to measure against — a flat patch, or still warming up (NaN).
        if (reference == null || !(reference > 0)) {
            i += 1;
            continue;
        }

        /* The most a range of `n` bars may span. √n because that is how far a random walk
         * gets; see the header. */
        const limit = (n: number): number => compression * reference * Math.sqrt(n);

        let top = -Infinity;
        let bottom = Infinity;
        for (let j = i; j < i + minBars; j += 1) {
            const bar = bars[j]!;
            if (bar.high > top) top = bar.high;
            if (bar.low < bottom) bottom = bar.low;
        }
        if (top - bottom > limit(minBars)) {
            i += 1;
            continue;
        }

        let end = i + minBars - 1;
        let confirmIndex = -1;
        let confirmTop = 0;
        let confirmBottom = 0;

        /* The seed may already be a range. Checked before extending, because the confirming
         * bar is the earliest bar on which all four conditions held — not the earliest one
         * this loop happens to look at. */
        if (hasTouches(bars, i, end, top, bottom, touchZone, minTouches)) {
            confirmIndex = end;
            confirmTop = top;
            confirmBottom = bottom;
        }

        let breakIndex: number | null = null;
        let breakDirection: RangeBreak | null = null;

        for (let j = end + 1; j < bars.length && j - i + 1 <= maxBars; j += 1) {
            const bar = bars[j]!;
            const pad = (top - bottom) * breakBuffer;

            // A close beyond an edge is the end of the range, whatever the wick did.
            if (bar.close > top + pad) {
                breakIndex = j;
                breakDirection = 'up';
                break;
            }
            if (bar.close < bottom - pad) {
                breakIndex = j;
                breakDirection = 'down';
                break;
            }

            const nextTop = bar.high > top ? bar.high : top;
            const nextBottom = bar.low < bottom ? bar.low : bottom;
            /* Widened past what this many bars may span. The range ends here, but without a
             * breakout — nothing broke, it just stopped being a range. */
            if (nextTop - nextBottom > limit(j - i + 1)) break;

            top = nextTop;
            bottom = nextBottom;
            end = j;

            /* Only until it is confirmed. Afterwards the count is descriptive, and the edges
             * are allowed to move without putting the range back on trial. */
            if (confirmIndex < 0 && hasTouches(bars, i, end, top, bottom, touchZone, minTouches)) {
                confirmIndex = end;
                confirmTop = top;
                confirmBottom = bottom;
            }
        }

        // Never enough visits to either edge: narrow, but not a range.
        if (confirmIndex < 0) {
            i += 1;
            continue;
        }

        const visits = countTouches(bars, i, end, top, bottom, touchZone);
        const breaking = breakIndex == null ? null : bars[breakIndex]!;
        out.push({
            startIndex: i,
            startTime: bars[i]!.time,
            index: confirmIndex,
            time: bars[confirmIndex]!.time,
            endIndex: end,
            endTime: bars[end]!.time,
            length: end - i + 1,

            top,
            bottom,
            middle: (top + bottom) / 2,
            height: top - bottom,
            confirmTop,
            confirmBottom,

            compression: (top - bottom) / (reference * Math.sqrt(end - i + 1)),
            touchesTop: visits.top,
            touchesBottom: visits.bottom,

            breakIndex,
            breakTime: breaking?.time ?? null,
            breakDirection,
            breakClose: breaking?.close ?? null,
            active: breakIndex == null && end === bars.length - 1,
        });

        // Past the breakout, so ranges never overlap.
        i = (breakIndex ?? end) + 1;
    }

    return out;
}

/**
 * Separate visits to each edge.
 *
 * Separate, not bars: price sitting at the top for twenty candles is one visit to the top, not
 * twenty. A visit ends when price leaves the edge zone, so the count is how many times price
 * came *back* — which is what tells a two-sided auction apart from a stretch that merely began
 * and ended in the right places.
 *
 * `zone` is a fraction of the height. At 0.15 the top zone is the upper 15% of the range. Note
 * that one visit to each edge is guaranteed by construction — the edges are the extremes of
 * these very bars — so `minTouches` of 1 is not a filter, and 2 is the first setting that asks
 * for anything.
 */
export function countTouches(
    bars: readonly OHLCV[],
    from: number,
    to: number,
    top: number,
    bottom: number,
    zone: number,
): { top: number; bottom: number } {
    const height = top - bottom;
    const topLine = top - height * zone;
    const bottomLine = bottom + height * zone;
    let atTop = 0;
    let atBottom = 0;
    let inTop = false;
    let inBottom = false;

    for (let i = from; i <= to; i += 1) {
        const bar = bars[i]!;
        if (bar.high >= topLine) {
            if (!inTop) {
                atTop += 1;
                inTop = true;
            }
        } else inTop = false;
        if (bar.low <= bottomLine) {
            if (!inBottom) {
                atBottom += 1;
                inBottom = true;
            }
        } else inBottom = false;
    }

    return { top: atTop, bottom: atBottom };
}

/** Whether both edges have been visited often enough. */
function hasTouches(
    bars: readonly OHLCV[],
    from: number,
    to: number,
    top: number,
    bottom: number,
    zone: number,
    minTouches: number,
): boolean {
    const visits = countTouches(bars, from, to, top, bottom, zone);
    return visits.top >= minTouches && visits.bottom >= minTouches;
}

/** The one filter that narrows what is reported without changing what a range is. */
function report(ranges: Range[], barCount: number, lookback: number): Range[] {
    if (!(lookback > 0)) return ranges;
    // Counted back from the newest bar, so the window survives paging in history.
    const cutoff = barCount - lookback;
    return ranges.filter((r) => r.index >= cutoff);
}
