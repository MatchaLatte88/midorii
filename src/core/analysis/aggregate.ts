import type { OHLCV } from '../model/ohlcv';
import type { BarClock } from './barClock';

/**
 * Folding one bar series into a coarser one, for a strategy that reads two timeframes at once.
 *
 * The index that matters is not the aggregate's
 * ---------------------------------------------
 * A strategy runs over ONE series, and every decision it makes is stamped with a bar of that
 * series. So an aggregate bar is not useful on its own — what is useful is knowing which
 * source bar COMPLETED it, because that is the first moment its close could have been read.
 * `sourceEnd[k]` is that bar.
 *
 * Getting this off by one is the difference between a backtest and a lie. A 10-minute bar
 * opening at 09:00 is finished at 09:10, and the source bar that finishes it is the minute
 * 09:09-09:10 — not the minute starting at 09:10, which has not happened yet. A strategy told
 * about the aggregate on the 09:09 bar acts at 09:10 and fills at 09:11 at the earliest under
 * the engine's own rule, which is exactly when a person watching a 10-minute chart could have
 * acted. Told about it one bar later, it would be a minute late on every single trade.
 *
 * Both functions keep only bars that actually exist. A gap in the source is a gap in the
 * aggregate rather than a bar stitched across it.
 */
export interface Aggregation {
    /** The coarser bars, ascending. */
    bars: OHLCV[];
    /** For each aggregate bar, the index in the SOURCE series of the last bar folded into it
     *  — the bar from which that aggregate is complete and may be acted on. */
    sourceEnd: number[];
}

/** A session aggregation also says which local day each bar covers. */
export interface SessionAggregation extends Aggregation {
    days: string[];
}

function fold(target: OHLCV, bar: OHLCV): void {
    target.high = Math.max(target.high, bar.high);
    target.low = Math.min(target.low, bar.low);
    target.close = bar.close;
    if (bar.volume != null) target.volume = (target.volume ?? 0) + bar.volume;
}

/**
 * Fixed-length buckets, aligned to the epoch — a 10-minute bucket starts at :00, :10, :20 and
 * so on.
 *
 * Epoch alignment is wall-clock alignment for every bucket that divides an hour, which is
 * every bucket a chart offers below 1h, because time zones are whole hours apart (the handful
 * of 30- and 45-minute zones aside, none of which lists index futures). Above that it is UTC
 * alignment, and a 4-hour bucket is then not the one a New York chart draws.
 */
export function bucketBars(bars: readonly OHLCV[], stepMs: number): Aggregation {
    if (!(stepMs > 0)) throw new Error(`bucketBars: step must be positive, got ${stepMs}`);

    const out: OHLCV[] = [];
    const sourceEnd: number[] = [];
    let currentStart = -1;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const start = Math.floor(bar.time / stepMs) * stepMs;
        if (start !== currentStart) {
            out.push({ ...bar, time: start });
            sourceEnd.push(i);
            currentStart = start;
            continue;
        }
        fold(out[out.length - 1]!, bar);
        sourceEnd[sourceEnd.length - 1] = i;
    }

    return { bars: out, sourceEnd };
}

/**
 * One bar per local day, folded from the bars inside a wall-clock window.
 *
 * The window is what makes this a session bar rather than a calendar-day bar, and for a
 * futures contract the two are very different things: a 23-hour day includes an overnight
 * that the cash market it tracks never traded. A daily indicator meant to line up with an
 * index or its ETF wants the cash hours, so the window is given rather than assumed.
 *
 * `fromMin` inclusive, `toMin` exclusive, both minutes past local midnight, matched against
 * each bar's OPEN.
 */
export function sessionBars(
    bars: readonly OHLCV[],
    clock: BarClock,
    fromMin: number,
    toMin: number,
): SessionAggregation {
    const out: OHLCV[] = [];
    const sourceEnd: number[] = [];
    const days: string[] = [];
    let currentDay: string | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const openMin = clock.openMinutes[i]!;
        if (openMin < fromMin || openMin >= toMin) continue;

        const day = clock.days[i]!;
        const bar = bars[i]!;
        if (day !== currentDay) {
            out.push({ ...bar });
            sourceEnd.push(i);
            days.push(day);
            currentDay = day;
            continue;
        }
        fold(out[out.length - 1]!, bar);
        sourceEnd[sourceEnd.length - 1] = i;
    }

    return { bars: out, sourceEnd, days };
}
