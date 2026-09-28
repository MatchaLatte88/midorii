import type { OHLCV } from '../model/ohlcv';
import { atr, highest, lowest } from '../native-indicators/classics/math';
import { detectFairValueGaps } from './fvg';

/**
 * Accumulation → manipulation → distribution, followed one cycle at a time, and the fair value
 * gaps a chart around those cycles keeps live.
 *
 * One cycle moves through four phases. Each bar belongs to exactly one phase, and a phase that
 * ends on a bar hands over to the next one from the following bar:
 *
 *   searching     the rolling `accLength`-bar range spans at most `accRangePct` of its low and
 *                 begins after the previous cycle's range ended — a new cycle starts
 *   accumulating  every bar that stays inside widens the range to the rolling high and low; the
 *                 first bar trading beyond an edge starts the manipulation on that side
 *   manipulating  the furthest price beyond the edge is tracked. Price reaching back inside the
 *                 broken edge starts the distribution on that bar. Once the manipulation has
 *                 lasted more than `maxManipulationBars` bars without that, it is abandoned
 *   distributing  a pause of `accLength` bars before searching again
 *
 * `breakout` decides which part of a candle counts for the breakout and the return: the wick,
 * or the body. `both` counts either, which is the wick — a body cannot pass an edge its wick
 * has not.
 *
 * Every phase change is read on a closed bar, so appending bars never moves an earlier one.
 */

export type AmdBreakout = 'wicks' | 'bodies' | 'both';
export type AmdManipulationSide = 'above' | 'below';
export type AmdManipulationOutcome = 'running' | 'distribution' | 'abandoned';

export interface AmdManipulation {
    side: AmdManipulationSide;
    /** The breakout bar. */
    index: number;
    time: number;
    /** The furthest price beyond the broken edge, up to `lastIndex`. */
    extreme: number;
    /** The last bar the manipulation was followed on. */
    lastIndex: number;
    outcome: AmdManipulationOutcome;
}

export interface AmdCycle {
    accStartIndex: number;
    accStartTime: number;
    /** The bar the range qualified on — when the cycle became known. */
    index: number;
    time: number;
    /** The last bar folded into the range. */
    accEndIndex: number;
    accEndTime: number;
    accTop: number;
    accBottom: number;
    manipulation: AmdManipulation | null;
    /** The bar that reached back inside the broken edge. */
    distributionIndex: number | null;
    distributionTime: number | null;
}

export interface AmdCycleOptions {
    /** Bars in the rolling window that must stay narrow. Default 50. */
    accLength?: number;
    /** Widest qualifying range, as a percentage of its low. Default 0.5. */
    accRangePct?: number;
    /** Which part of a candle counts beyond an edge. Default `both`. */
    breakout?: AmdBreakout;
    /** Bars a manipulation may last without returning inside. Default 20. */
    maxManipulationBars?: number;
}

export const AMD_CYCLE_DEFAULTS = {
    accLength: 50,
    accRangePct: 0.5,
    breakout: 'both' as AmdBreakout,
    maxManipulationBars: 20,
    fvgMinAtr: 0.5,
    fvgAtrLength: 14,
    skipOverlapping: true,
    maxLiveGaps: 15,
} as const;

const BREAKOUTS: readonly AmdBreakout[] = ['wicks', 'bodies', 'both'];

type Phase = 'searching' | 'accumulating' | 'manipulating' | 'distributing';

/** Every cycle that started in `bars`, oldest first. The newest may still be in progress. */
export function detectAmdCycles(bars: readonly OHLCV[], opts: AmdCycleOptions = {}): AmdCycle[] {
    const accLength = opts.accLength ?? AMD_CYCLE_DEFAULTS.accLength;
    const accRangePct = opts.accRangePct ?? AMD_CYCLE_DEFAULTS.accRangePct;
    const breakout = opts.breakout ?? AMD_CYCLE_DEFAULTS.breakout;
    const maxManipulationBars = opts.maxManipulationBars ?? AMD_CYCLE_DEFAULTS.maxManipulationBars;
    checkCycleOptions(accLength, accRangePct, breakout, maxManipulationBars);

    const highs = highest(bars.map((bar) => bar.high), accLength);
    const lows = lowest(bars.map((bar) => bar.low), accLength);
    const cycles: AmdCycle[] = [];
    let phase: Phase = 'searching';
    let cycle: AmdCycle | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const upper = breakout === 'bodies' ? Math.max(bar.open, bar.close) : bar.high;
        const lower = breakout === 'bodies' ? Math.min(bar.open, bar.close) : bar.low;

        if (phase === 'searching') {
            const top = highs[i]!;
            const bottom = lows[i]!;
            // A percentage width is undefined for a non-positive low, so such a window never qualifies.
            const narrow = Number.isFinite(top) && bottom > 0 && ((top - bottom) / bottom) * 100 <= accRangePct;
            const start = i - accLength + 1;
            if (!narrow || (cycle !== null && start <= cycle.accEndIndex)) continue;
            cycle = {
                accStartIndex: start,
                accStartTime: bars[start]!.time,
                index: i,
                time: bar.time,
                accEndIndex: i,
                accEndTime: bar.time,
                accTop: top,
                accBottom: bottom,
                manipulation: null,
                distributionIndex: null,
                distributionTime: null,
            };
            cycles.push(cycle);
            phase = 'accumulating';
            continue;
        }

        const active = cycle!;
        if (phase === 'accumulating') {
            const side: AmdManipulationSide | null = upper > active.accTop ? 'above' : lower < active.accBottom ? 'below' : null;
            if (side === null) {
                active.accTop = Math.max(active.accTop, highs[i]!);
                active.accBottom = Math.min(active.accBottom, lows[i]!);
                active.accEndIndex = i;
                active.accEndTime = bar.time;
                continue;
            }
            active.manipulation = {
                side,
                index: i,
                time: bar.time,
                extreme: side === 'above' ? bar.high : bar.low,
                lastIndex: i,
                outcome: 'running',
            };
            phase = 'manipulating';
            continue;
        }

        if (phase === 'manipulating') {
            const manipulation = active.manipulation!;
            manipulation.lastIndex = i;
            const returned = manipulation.side === 'above'
                ? lower < active.accTop
                : upper > active.accBottom;
            manipulation.extreme = manipulation.side === 'above'
                ? Math.max(manipulation.extreme, bar.high)
                : Math.min(manipulation.extreme, bar.low);
            if (returned) {
                manipulation.outcome = 'distribution';
                active.distributionIndex = i;
                active.distributionTime = bar.time;
                phase = 'distributing';
            } else if (i - manipulation.index > maxManipulationBars) {
                manipulation.outcome = 'abandoned';
                phase = 'searching';
            }
            continue;
        }

        if (i - active.distributionIndex! > accLength) phase = 'searching';
    }

    return cycles;
}

/** A fair value gap as the cycle chart tracks it, from formation until it stops being live. */
export interface AmdGap {
    /** The direction the gap formed in. An inverted gap acts in the opposite one. */
    direction: 'bull' | 'bear';
    top: number;
    bottom: number;
    startIndex: number;
    startTime: number;
    /** The bar that completed the gap. */
    index: number;
    time: number;
    /** The bar whose close crossed the far edge; null while the gap holds. */
    brokenIndex: number | null;
    /** Whether the broken gap stayed live as an inverted gap. */
    inverted: boolean;
    /** The bar on which the gap stopped being live; null while it still is. */
    endIndex: number | null;
}

export interface AmdGapOptions {
    /** A gap must be larger than this multiple of ATR. Default 0.5. */
    minAtr?: number;
    /** Wilder ATR length for the size filter. Default 14. */
    atrLength?: number;
    /**
     * Drop a new gap lying entirely inside a holding gap of the same direction, and do not keep a
     * broken gap as inverted when it overlaps an inverted gap of the same original direction.
     */
    skipOverlapping?: boolean;
    /** Live gaps kept at once; the oldest is dropped beyond this. Default 15. */
    maxLive?: number;
    /** Keep broken gaps live as inverted gaps until price closes back through them. */
    keepInverted?: boolean;
}

/**
 * Fair value gaps above an ATR-relative size, followed until they stop being live: a gap holds
 * until a close crosses its far edge; kept as an inverted gap, it then lasts until a close
 * crosses back over its other edge. Gap geometry and the breaking close come from the shared
 * fair value gap detector, so the zones sit on the same prices as every other gap on the chart.
 */
export function trackAmdGaps(bars: readonly OHLCV[], opts: AmdGapOptions = {}): AmdGap[] {
    const minAtr = opts.minAtr ?? AMD_CYCLE_DEFAULTS.fvgMinAtr;
    const atrLength = opts.atrLength ?? AMD_CYCLE_DEFAULTS.fvgAtrLength;
    const skipOverlapping = opts.skipOverlapping ?? AMD_CYCLE_DEFAULTS.skipOverlapping;
    const maxLive = opts.maxLive ?? AMD_CYCLE_DEFAULTS.maxLiveGaps;
    const keepInverted = opts.keepInverted ?? false;
    if (!(minAtr >= 0)) throw new Error(`trackAmdGaps: minAtr must be >= 0, got ${minAtr}`);
    if (!Number.isInteger(atrLength) || atrLength < 1) throw new Error(`trackAmdGaps: atrLength must be an integer >= 1, got ${atrLength}`);
    if (!Number.isInteger(maxLive) || maxLive < 1) throw new Error(`trackAmdGaps: maxLive must be an integer >= 1, got ${maxLive}`);

    const atrValues = atr(bars, atrLength);
    const formed = new Map<number, { gap: AmdGap; breaksAt: number | null }>();
    for (const zone of detectFairValueGaps(bars, { mitigation: 'break', show: 'all' })) {
        formed.set(zone.index, {
            gap: {
                direction: zone.direction,
                top: zone.top,
                bottom: zone.bottom,
                startIndex: zone.startIndex,
                startTime: zone.startTime,
                index: zone.index,
                time: zone.time,
                brokenIndex: null,
                inverted: false,
                endIndex: null,
            },
            breaksAt: zone.mitigatedIndex,
        });
    }

    const tracked: AmdGap[] = [];
    const live: Array<{ gap: AmdGap; breaksAt: number | null }> = [];

    for (let i = 0; i < bars.length; i += 1) {
        const born = formed.get(i);
        const atrValue = atrValues[i]!;
        if (born && Number.isFinite(atrValue) && born.gap.top - born.gap.bottom > atrValue * minAtr) {
            const nested = skipOverlapping && live.some(({ gap }) => gap.brokenIndex === null
                && gap.direction === born.gap.direction
                && born.gap.bottom >= gap.bottom && born.gap.top <= gap.top);
            if (!nested) {
                live.push(born);
                tracked.push(born.gap);
            }
        }
        if (live.length > maxLive) live.shift()!.gap.endIndex = i;

        const close = bars[i]!.close;
        // Newest first: a gap inverted on this bar already counts against older ones breaking with it.
        for (let k = live.length - 1; k >= 0; k -= 1) {
            const { gap, breaksAt } = live[k]!;
            if (gap.brokenIndex === null) {
                if (breaksAt !== i) continue;
                gap.brokenIndex = i;
                const crowded = skipOverlapping && live.some((other, j) => j !== k
                    && other.gap.brokenIndex !== null
                    && other.gap.direction === gap.direction
                    && gap.bottom <= other.gap.top && gap.top >= other.gap.bottom);
                if (keepInverted && !crowded) {
                    gap.inverted = true;
                    continue;
                }
            } else {
                const retired = gap.direction === 'bull' ? close > gap.top : close < gap.bottom;
                if (!retired) continue;
            }
            gap.endIndex = i;
            live.splice(k, 1);
        }
    }

    return tracked;
}

function checkCycleOptions(accLength: number, accRangePct: number, breakout: AmdBreakout, maxManipulationBars: number): void {
    if (!Number.isInteger(accLength) || accLength < 2) {
        throw new Error(`detectAmdCycles: accLength must be an integer >= 2, got ${accLength}`);
    }
    if (!(accRangePct > 0)) throw new Error(`detectAmdCycles: accRangePct must be positive, got ${accRangePct}`);
    if (!BREAKOUTS.includes(breakout)) throw new Error(`detectAmdCycles: unknown breakout "${String(breakout)}"`);
    if (!Number.isInteger(maxManipulationBars) || maxManipulationBars < 1) {
        throw new Error(`detectAmdCycles: maxManipulationBars must be an integer >= 1, got ${maxManipulationBars}`);
    }
}
