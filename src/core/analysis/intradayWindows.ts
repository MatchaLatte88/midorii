import type { OHLCV } from '../model/ohlcv';
import { atr } from '../native-indicators/classics/math';
import { localReading } from './tradingSessions';

/**
 * A trading day cut into the windows that predict each other.
 *
 * The finding this exists to measure is Gao, Han, Li & Zhou's intraday momentum — the first
 * part of a session predicts the last part of it — as Shen, Urquhart & Wang (2022) adapted it
 * to Bitcoin. Everything here is measurement: what each window returned. Whether that is worth
 * a position is decided in `app/renderer/strategies/intradayMomentum.ts`.
 *
 * Where a day starts in a market that never closes
 * ------------------------------------------------
 * On an exchange the answer is the closing bell. Crypto has none, so the boundary is a
 * decision, and it is the single most consequential setting here: move it, and every window
 * below moves with it. The paper's answer is 17:00 New York, because CME Bitcoin futures pause
 * for an hour there, and because US flow dominates the market it studied. The UTC midnight
 * everyone else cuts daily candles at is the other defensible answer. Both are offered; which
 * one is right is an empirical question, not a matter of taste, which is why it is a parameter
 * and not a constant.
 *
 * Everything is an offset from that boundary
 * ------------------------------------------
 * A day is 1440 minutes measured from the boundary, and every window is stated as a position
 * inside it. That is what keeps this correct across a clock change: the windows are anchored to
 * a wall clock read through {@link localReading}, so 16:30 New York stays 16:30 through the
 * March and November weekends when a fixed UTC offset would be an hour wrong. The two days a
 * year that are 1380 or 1500 minutes long stretch or squeeze in the middle, where nothing is
 * measured, rather than at either edge, where everything is.
 *
 * The three windows
 * -----------------
 *   signal    from the previous day's close to a wall-clock time inside this day. The paper's
 *             is the overnight move plus the first half hour of the active session — one
 *             number for "what happened before anyone could act on it".
 *   confirm   the window immediately before the traded one. The paper finds this predicts the
 *             last window NEGATIVELY, which is a reversal and not momentum at all; it is the
 *             stronger of the two signals, and the reason this window exists separately.
 *   trade     the last `tradeMinutes` of the day. What the other two are used to predict.
 *
 * Nothing is reported that was not knowable in time. `index` is the last bar before the traded
 * window opens, and both returns are complete by then — the signal ends earlier by
 * construction (validated below), and the confirm window ends exactly there. A detector that
 * got this wrong would report a strategy that reads the close it is about to trade.
 */

export type DayBoundaryId = 'cme' | 'utc';

interface BoundaryDef {
    label: string;
    zone: string;
    /** Minutes past local midnight where one trading day ends and the next begins. */
    endMin: number;
}

const BOUNDARIES: Record<DayBoundaryId, BoundaryDef> = {
    /* 17:00 New York — the hour CME Bitcoin futures stop for, and the paper's choice. It
     * follows the US clock change rather than a fixed UTC hour. */
    cme: { label: 'CME close (17:00 New York)', zone: 'America/New_York', endMin: 17 * 60 },
    /* Midnight UTC, where daily crypto candles are cut everywhere else. */
    utc: { label: 'UTC midnight', zone: 'UTC', endMin: 24 * 60 },
};

export const DAY_BOUNDARY_IDS = Object.keys(BOUNDARIES) as readonly DayBoundaryId[];

const DAY_MINUTES = 24 * 60;

/** One trading day, with the returns of the windows that are supposed to predict each other. */
export interface IntradayWindows {
    /** The last bar before the traded window opens — the bar an order can be placed on. */
    index: number;
    /** The trading day this belongs to, as a local date in the boundary's own zone. */
    day: string;
    boundary: DayBoundaryId;

    /** First and last bar of the day, for drawing it. */
    startIndex: number;
    endIndex: number;

    /** Return from the previous day's close to the signal window's end. Null on the first day,
     *  which has no previous close. */
    signalReturn: number | null;
    /** Return of the window immediately before the traded one. Null when `confirmMinutes` is 0,
     *  or when the bars do not cover it. */
    confirmReturn: number | null;

    /** First and last bar of the traded window. */
    tradeStartIndex: number;
    tradeEndIndex: number;
    /** What the traded window actually did, open to close. Reported for analysis — a strategy
     *  cannot read it, because it only exists once the window is over. */
    tradeReturn: number;

    /** Daily ATR over the previous days, known at this day's start. Null during warm-up. */
    atr: number | null;
}

export interface IntradayWindowsOptions {
    boundary?: DayBoundaryId;
    /** Wall-clock minute past local midnight where the signal window ends. */
    signalEndMin?: number;
    /** How many minutes at the end of the day are traded. */
    tradeMinutes?: number;
    /** How many minutes immediately before the traded window form the confirm window. 0 = none. */
    confirmMinutes?: number;
    /** How many previous days the daily ATR averages over. */
    atrDays?: number;
}

export const INTRADAY_WINDOWS_DEFAULTS = {
    boundary: 'cme' as DayBoundaryId,
    /* 10:00 New York: half an hour after the US cash open, which is where the paper puts the
     * end of its first window. Everything before it — the overnight move and the opening
     * half hour — is the signal. */
    signalEndMin: 10 * 60,
    tradeMinutes: 30,
    confirmMinutes: 30,
    atrDays: 14,
} as const;

/** One day's bars, before anything is measured about them. */
interface RawDay {
    key: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Where a timestamp sits inside its trading day: which day it belongs to, and how many minutes
 * past the boundary it is.
 *
 * A bar at or after the boundary belongs to the NEXT day — 18:00 on Monday is early Tuesday
 * when the day ends at 17:00. Getting this backwards would split every day in two and put the
 * signal window after the one it predicts.
 */
function dayPositionOf(timeMs: number, def: BoundaryDef): { key: string; offset: number } {
    const { minutes, day } = localReading(timeMs, def.zone);
    if (minutes < def.endMin) {
        // Still in the day that started yesterday at the boundary.
        return { key: day, offset: minutes - def.endMin + DAY_MINUTES };
    }
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    // Date.UTC rolls day+1 over month and year ends on its own.
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    return { key: next, offset: minutes - def.endMin };
}

/**
 * Every trading day in `bars` with its window returns, ascending by the bar each becomes
 * actionable on.
 *
 * A day whose traded window is missing, or which has no bar left before that window opens, is
 * left out: there is nothing to decide on it.
 */
export function detectIntradayWindows(
    bars: readonly OHLCV[],
    opts: IntradayWindowsOptions = {},
): IntradayWindows[] {
    const boundaryId = opts.boundary ?? INTRADAY_WINDOWS_DEFAULTS.boundary;
    const signalEndMin = opts.signalEndMin ?? INTRADAY_WINDOWS_DEFAULTS.signalEndMin;
    const tradeMinutes = opts.tradeMinutes ?? INTRADAY_WINDOWS_DEFAULTS.tradeMinutes;
    const confirmMinutes = opts.confirmMinutes ?? INTRADAY_WINDOWS_DEFAULTS.confirmMinutes;
    const atrDays = opts.atrDays ?? INTRADAY_WINDOWS_DEFAULTS.atrDays;

    const def = BOUNDARIES[boundaryId];
    if (!def) {
        throw new Error(`detectIntradayWindows: unknown boundary "${boundaryId}". Known: ${DAY_BOUNDARY_IDS.join(', ')}`);
    }
    if (!Number.isInteger(tradeMinutes) || tradeMinutes < 1 || tradeMinutes >= DAY_MINUTES) {
        throw new Error(`detectIntradayWindows: tradeMinutes must be between 1 and ${DAY_MINUTES - 1}, got ${tradeMinutes}`);
    }
    if (!Number.isInteger(confirmMinutes) || confirmMinutes < 0) {
        throw new Error(`detectIntradayWindows: confirmMinutes must be 0 or more, got ${confirmMinutes}`);
    }
    if (tradeMinutes + confirmMinutes > DAY_MINUTES) {
        throw new Error('detectIntradayWindows: the traded and confirm windows do not fit inside one day');
    }
    if (!Number.isInteger(signalEndMin) || signalEndMin < 0 || signalEndMin >= DAY_MINUTES) {
        throw new Error(`detectIntradayWindows: signalEndMin must be a minute of the day, got ${signalEndMin}`);
    }
    if (!Number.isInteger(atrDays) || atrDays < 1) {
        throw new Error(`detectIntradayWindows: atrDays must be a positive whole number, got ${atrDays}`);
    }

    const tradeStartOffset = DAY_MINUTES - tradeMinutes;
    const confirmStartOffset = tradeStartOffset - confirmMinutes;

    /* The signal must be complete before the traded window opens, or the strategy would be
     * reading a price from the window it is about to bet on. Stated as an offset because that
     * is the only frame in which the two are comparable. */
    const signalEndOffset = signalEndMin < def.endMin
        ? signalEndMin - def.endMin + DAY_MINUTES
        : signalEndMin - def.endMin;
    if (signalEndOffset >= tradeStartOffset) {
        throw new Error(
            'detectIntradayWindows: the signal window ends after the traded window opens, which '
            + 'would let the signal see the move it is meant to predict',
        );
    }

    if (bars.length < 2) return [];

    const days = splitIntoDays(bars, def);
    if (days.length === 0) return [];

    const dailyAtr = dailyAtrSeries(bars, days, atrDays);
    const out: IntradayWindows[] = [];

    for (let k = 0; k < days.length; k += 1) {
        const day = days[k]!;

        /* One pass over the day collecting the four bars every window boundary needs: the last
         * bar before each offset, and the first bar of the traded window. */
        let signalEndBar = -1;
        let confirmStartBar = -1;
        let tradeStartBar = -1;
        let tradeEndBar = -1;

        for (let i = day.startIndex; i <= day.endIndex; i += 1) {
            const { offset } = dayPositionOf(bars[i]!.time, def);
            if (offset < signalEndOffset) signalEndBar = i;
            if (offset < confirmStartOffset) confirmStartBar = i;
            if (offset < tradeStartOffset) continue;
            if (tradeStartBar < 0) tradeStartBar = i;
            tradeEndBar = i;
        }

        // No traded window in the data, or no bar before it to act on.
        if (tradeStartBar < 0 || tradeEndBar < 0 || tradeStartBar === day.startIndex) continue;

        /* The bar an order goes on: the last one before the window opens. Not `tradeStartBar -
         * 1` by arithmetic — with a gap in the data that could be a bar from another day — but
         * it is the same index whenever the day is contiguous, which is the normal case. */
        const actionIndex = tradeStartBar - 1;
        if (actionIndex < day.startIndex) continue;

        /* From the previous day's close, which is the paper's baseline and the price the day
         * actually opened against. The first day in the data has none. */
        const previousClose = k > 0 ? bars[days[k - 1]!.endIndex]!.close : null;
        const signalReturn = previousClose != null && signalEndBar >= 0 && previousClose > 0
            ? bars[signalEndBar]!.close / previousClose - 1
            : null;

        const confirmReturn = confirmMinutes > 0 && confirmStartBar >= 0 && bars[confirmStartBar]!.close > 0
            ? bars[actionIndex]!.close / bars[confirmStartBar]!.close - 1
            : null;

        out.push({
            index: actionIndex,
            day: day.key,
            boundary: boundaryId,
            startIndex: day.startIndex,
            endIndex: day.endIndex,
            signalReturn,
            confirmReturn,
            tradeStartIndex: tradeStartBar,
            tradeEndIndex: tradeEndBar,
            tradeReturn: bars[tradeEndBar]!.close / bars[tradeStartBar]!.open - 1,
            atr: k > 0 ? dailyAtr[k - 1]! : null,
        });
    }

    return out;
}

/** The bars of each trading day, in order. */
function splitIntoDays(bars: readonly OHLCV[], def: BoundaryDef): RawDay[] {
    const out: RawDay[] = [];
    let open: RawDay | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const { key } = dayPositionOf(bars[i]!.time, def);
        if (open && open.key === key) {
            open.endIndex = i;
            continue;
        }
        open = { key, startIndex: i, endIndex: i };
        out.push(open);
    }
    return out;
}

/**
 * Wilder's ATR over day-aggregated bars: entry k is the ATR after day k closed, so a strategy
 * reads k − 1 and learns nothing about the day it is trading.
 */
function dailyAtrSeries(bars: readonly OHLCV[], days: readonly RawDay[], atrDays: number): (number | null)[] {
    const daily: OHLCV[] = days.map((d) => {
        let high = -Infinity;
        let low = Infinity;
        for (let i = d.startIndex; i <= d.endIndex; i += 1) {
            high = Math.max(high, bars[i]!.high);
            low = Math.min(low, bars[i]!.low);
        }
        return {
            time: bars[d.startIndex]!.time,
            open: bars[d.startIndex]!.open,
            high,
            low,
            close: bars[d.endIndex]!.close,
        };
    });

    return atr(daily, atrDays).map((v) => (Number.isFinite(v) ? v : null));
}
