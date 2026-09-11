import type { OHLCV } from '../model/ohlcv';
import { localReading } from './tradingSessions';

/**
 * Every bar read off one market's wall clock: when it opened, when it closed, and which
 * local day it belongs to.
 *
 * Why a strategy needs the CLOSE time and not just the open
 * --------------------------------------------------------
 * A rule stated by a person is stated in closes. "Signals print at the completed 10-minute
 * closes from 08:40 to 10:00" names the moment the information existed, which is the only
 * moment it could have been acted on. Translating that into bar OPENS — 08:30 to 09:50 —
 * makes the rule depend on the bar length: the same setting would mean 08:35 on a 5m chart
 * and 08:20 on a 20m one. So the window is matched against the close, and the bar length
 * drops out of the parameter entirely.
 *
 * The same goes for getting flat. "Close at 14:50" is an order placed on the bar that closes
 * AT 14:50, because an order never fills on the bar that placed it — it fills at the next
 * bar's open, which is 14:50. Expressed in opens that would be 14:40, and wrong the moment
 * somebody runs the same strategy on a different timeframe.
 *
 * Two readings per bar, and why that is not wasteful
 * -------------------------------------------------
 * The close is read through `Intl` a second time rather than derived as `open + step`,
 * because the two differ across a daylight-saving boundary — the arithmetic answer is an
 * hour wrong for any bar the clock changes inside. It is tempting to argue that index
 * futures are closed at 02:00 on a Sunday and so it can never happen; that argument holds
 * for CME contracts and for nothing else, and this module is not told what it is reading.
 * Detection results are cached across a sweep (see strategies/detection.ts), so the cost is
 * paid once per stretch of history rather than once per run.
 *
 * Bar times are milliseconds and mark the bar's OPEN, which is what the rest of the chart
 * means by `time`.
 */
export interface BarClock {
    /** Bar duration in ms — the smallest positive gap actually present in the series. */
    stepMs: number;
    /** Minutes past local midnight at each bar's open. */
    openMinutes: number[];
    /** The same at each bar's close, one bar duration later. */
    closeMinutes: number[];
    /** Local date stamp (`YYYY-MM-DD`) of each bar's open — what separates one session's
     *  occurrence of a window from the next one's. */
    days: string[];
}

/**
 * Bar duration: the smallest positive gap between consecutive bars.
 *
 * The smallest rather than the first, for the same reason the backtest loop infers it that
 * way — a series with a weekend in it has a 48-hour "gap" that is not the bar length.
 */
export function barStepMs(bars: readonly OHLCV[]): number {
    if (bars.length < 2) {
        throw new Error('barStepMs: at least two bars are needed to tell how long one is');
    }
    let smallest = Infinity;
    for (let i = 1; i < bars.length; i += 1) {
        const gap = bars[i]!.time - bars[i - 1]!.time;
        if (gap > 0 && gap < smallest) smallest = gap;
    }
    if (!Number.isFinite(smallest)) {
        throw new Error('barStepMs: timestamps do not advance, so the bar duration is unknowable');
    }
    return smallest;
}

/** Reads every bar's open, close and local day in `zone`. Needs at least two bars — one bar
 *  does not say how long a bar is. */
export function readBarClock(bars: readonly OHLCV[], zone: string): BarClock {
    const stepMs = barStepMs(bars);
    const openMinutes = new Array<number>(bars.length);
    const closeMinutes = new Array<number>(bars.length);
    const days = new Array<string>(bars.length);

    for (let i = 0; i < bars.length; i += 1) {
        const time = bars[i]!.time;
        const opened = localReading(time, zone);
        openMinutes[i] = opened.minutes;
        days[i] = opened.day;
        closeMinutes[i] = localReading(time + stepMs, zone).minutes;
    }

    return { stepMs, openMinutes, closeMinutes, days };
}

/**
 * Whether a bar's close falls in an inclusive wall-clock window.
 *
 * Inclusive at both ends because that is how the windows these read are written: "from 08:40
 * to 10:00" includes the 10:00 close, and the rule that says so calls it "the last bar that
 * can fire".
 */
export function closeInWindow(minutes: number, fromMin: number, toMin: number): boolean {
    // A window that ends before it starts runs through midnight — the overnight session.
    return fromMin <= toMin
        ? minutes >= fromMin && minutes <= toMin
        : minutes >= fromMin || minutes <= toMin;
}
