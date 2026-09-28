import type { OHLCV } from '../model/ohlcv';
import { atr } from '../native-indicators/classics/math';
import { detectFairValueGaps } from './fvg';
import { detectRanges, type RangeDetectOptions } from './range';

/**
 * Range fakeouts: a range breaks on a close, leaves a fair value gap beyond the broken edge, and
 * is then closed back through its own middle.
 *
 *   range         a compressed two-sided range from the shared range detector
 *   breakout      the close beyond an edge that ended the range
 *   gap           a fair value gap completed between the breakout and the confirmation, reaching
 *                 beyond the broken edge — the imbalance the false move left behind
 *   confirmation  within `maxFakeoutBars` of the breakout, a close past the range middle on the
 *                 far side. The setup trades against the breakout from here
 *
 * `gapSide` decides which gap counts: one pointing the way of the breakout (the impulse out of the
 * range), one pointing back (the snap back in), or either.
 *
 * The range, its edges and middle are final by the breakout bar, and every later value is read on
 * the confirmation close, so appending bars never moves a setup.
 */

export type FakeoutGapSide = 'any' | 'breakout' | 'reversal';

export interface RangeFakeoutGap {
    direction: 'bull' | 'bear';
    top: number;
    bottom: number;
    startIndex: number;
    startTime: number;
    index: number;
    time: number;
}

export interface RangeFakeoutSetup {
    /** The trade: against the breakout. */
    direction: 'bull' | 'bear';
    rangeStartIndex: number;
    rangeStartTime: number;
    rangeEndIndex: number;
    rangeEndTime: number;
    top: number;
    bottom: number;
    middle: number;
    breakIndex: number;
    breakTime: number;
    gap: RangeFakeoutGap;
    /** The furthest price beyond the broken edge from the breakout to the confirmation. */
    extreme: number;
    extremeIndex: number;
    close: number;
    /** The confirmation close — the first bar the setup is knowable. */
    index: number;
    time: number;
}

export interface RangeFakeoutOptions {
    /** Passed to the range detector. */
    range?: RangeDetectOptions;
    /** Bars after the breakout in which the middle must be closed through. Default 10. */
    maxFakeoutBars?: number;
    /** Which gap direction counts. Default `reversal`. */
    gapSide?: FakeoutGapSide;
    /** Smallest gap as a multiple of the 14-bar ATR on its completing bar. Default 0. */
    minGapAtr?: number;
}

/**
 * Detection and trade-plan defaults shared by the chart study and the strategy: ranges of at
 * least 12 bars within 0.8 × ATR × √length, a gap pointing back into the range, and a fixed 1.5R
 * target, meant for a 15-minute chart.
 */
export const RANGE_FAKEOUT_DEFAULTS = {
    minBars: 12,
    compression: 0.8,
    minTouches: 2,
    maxFakeoutBars: 10,
    gapSide: 'reversal' as FakeoutGapSide,
    minGapAtr: 0,
    targetMode: 'fixed' as 'fixed' | 'range',
    rrr: 1.5,
    minEdgeReward: 0.5,
    timeframe: '15',
} as const;

const GAP_SIDES: readonly FakeoutGapSide[] = ['any', 'breakout', 'reversal'];
const GAP_ATR_LENGTH = 14;

/** Every confirmed fakeout, ordered by its confirmation bar. */
export function detectRangeFakeouts(bars: readonly OHLCV[], opts: RangeFakeoutOptions = {}): RangeFakeoutSetup[] {
    const maxFakeoutBars = opts.maxFakeoutBars ?? RANGE_FAKEOUT_DEFAULTS.maxFakeoutBars;
    const gapSide = opts.gapSide ?? RANGE_FAKEOUT_DEFAULTS.gapSide;
    const minGapAtr = opts.minGapAtr ?? RANGE_FAKEOUT_DEFAULTS.minGapAtr;
    if (!Number.isInteger(maxFakeoutBars) || maxFakeoutBars < 1) {
        throw new Error(`detectRangeFakeouts: maxFakeoutBars must be an integer >= 1, got ${maxFakeoutBars}`);
    }
    if (!GAP_SIDES.includes(gapSide)) throw new Error(`detectRangeFakeouts: unknown gapSide "${String(gapSide)}"`);
    if (!(minGapAtr >= 0)) throw new Error(`detectRangeFakeouts: minGapAtr must be >= 0, got ${minGapAtr}`);
    if (bars.length === 0) return [];

    const atrValues = atr(bars, GAP_ATR_LENGTH);
    const gaps = detectFairValueGaps(bars, { show: 'all' }).filter((zone) => {
        const reference = atrValues[zone.index]!;
        return Number.isFinite(reference) && zone.top - zone.bottom >= reference * minGapAtr;
    });
    const setups: RangeFakeoutSetup[] = [];

    for (const range of detectRanges(bars, opts.range)) {
        if (range.breakIndex === null || range.breakDirection === null) continue;
        const up = range.breakDirection === 'up';
        const last = Math.min(bars.length - 1, range.breakIndex + maxFakeoutBars);

        let extreme = up ? -Infinity : Infinity;
        let extremeIndex = range.breakIndex;
        for (let i = range.breakIndex; i <= last; i += 1) {
            const bar = bars[i]!;
            if (up ? bar.high > extreme : bar.low < extreme) {
                extreme = up ? bar.high : bar.low;
                extremeIndex = i;
            }
            if (up ? !(bar.close < range.middle) : !(bar.close > range.middle)) continue;

            const gap = gapIn(gaps, range.breakIndex, i, up, range.top, range.bottom, gapSide);
            if (gap) {
                setups.push({
                    direction: up ? 'bear' : 'bull',
                    rangeStartIndex: range.startIndex,
                    rangeStartTime: range.startTime,
                    rangeEndIndex: range.endIndex,
                    rangeEndTime: range.endTime,
                    top: range.top,
                    bottom: range.bottom,
                    middle: range.middle,
                    breakIndex: range.breakIndex,
                    breakTime: range.breakTime!,
                    gap,
                    extreme,
                    extremeIndex,
                    close: bar.close,
                    index: i,
                    time: bar.time,
                });
            }
            // The first close through the middle decides the fakeout either way.
            break;
        }
    }

    return setups.sort((a, b) => a.index - b.index);
}

/** The first qualifying gap completed from the breakout to `to`, reaching beyond the broken edge. */
function gapIn(
    gaps: ReturnType<typeof detectFairValueGaps>,
    from: number,
    to: number,
    up: boolean,
    top: number,
    bottom: number,
    side: FakeoutGapSide,
): RangeFakeoutGap | null {
    const outward = up ? 'bull' : 'bear';
    for (const zone of gaps) {
        if (zone.index < from) continue;
        if (zone.index > to) return null;
        if (up ? !(zone.top > top) : !(zone.bottom < bottom)) continue;
        if (side === 'breakout' && zone.direction !== outward) continue;
        if (side === 'reversal' && zone.direction === outward) continue;
        return {
            direction: zone.direction,
            top: zone.top,
            bottom: zone.bottom,
            startIndex: zone.startIndex,
            startTime: zone.startTime,
            index: zone.index,
            time: zone.time,
        };
    }
    return null;
}

/**
 * The target a setup is traded to, or null when the setup is not taken.
 *
 * `fixed` puts it `rrr` times the risk from the confirmation close. `range` puts it at the far
 * range edge and skips the setup when that edge offers less than `minEdgeReward` times the risk;
 * an edge no longer ahead of the close falls back to the fixed target.
 */
export function rangeFakeoutTarget(
    setup: RangeFakeoutSetup,
    targetMode: 'fixed' | 'range',
    rrr: number,
    minEdgeReward: number,
): number | null {
    const short = setup.direction === 'bear';
    const risk = Math.abs(setup.close - setup.extreme);
    if (!(risk > 0)) return null;
    const fixed = short ? setup.close - risk * rrr : setup.close + risk * rrr;
    if (targetMode !== 'range') return fixed;
    const edge = short ? setup.bottom : setup.top;
    if (short ? !(edge < setup.close) : !(edge > setup.close)) return fixed;
    return Math.abs(edge - setup.close) / risk >= minEdgeReward ? edge : null;
}
