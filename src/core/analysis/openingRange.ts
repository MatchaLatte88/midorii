import type { OHLCV } from '../model/ohlcv';
import { atr } from '../native-indicators/classics/math';
import { localReading, inWindow } from './tradingSessions';

/**
 * The opening range — what the first minutes of a session decided, and what a day carries
 * into it.
 *
 * Everything here is a fact about the market: where the session opened, how far it travelled
 * in its first `rangeMinutes`, whether it closed that stretch above or below its open, how
 * much volume went through compared with the same stretch on recent days, and how far the
 * instrument normally travels in a day. Nothing here trades. What to do about a range lives in
 * `app/renderer/strategies/openingRange.ts`, which is the whole difference between an
 * indicator and a strategy.
 *
 * Why a session and not a calendar day
 * -----------------------------------
 * An opening range is only meaningful where there is an opening. US equities and index futures
 * have one — 09:30 New York, a wall-clock time that moves against UTC twice a year — and
 * crypto does not, so the closest thing is the UTC day everyone cuts daily candles at. Both
 * are read through {@link localReading}, the same function the session windows and the Silver
 * Bullet hours are read through, so nothing here keeps a second idea of what "09:30 New York"
 * means in January.
 *
 * Neither preset wraps midnight, so a session here is a plain run of bars. A window that did
 * would need the day-key bookkeeping `tradingSessions.ts` does; there is no such window, and
 * writing it to be general would be code with no caller.
 *
 * Volume and volatility are read from the days BEFORE
 * --------------------------------------------------
 * The relative volume of a session and the daily ATR at its open are the two numbers that
 * decide whether a range is worth trading and how wide the stop behind it is. Both are
 * computed strictly from earlier sessions — `atrValues[k - 1]`, the volume of days
 * `k - n .. k - 1` — because a number that included today would be telling the strategy how
 * the day went before it had started. That is the one bug that turns a backtest into a
 * fabrication, and the indexing is the only thing standing between the two, so it is written
 * once, here.
 *
 * The daily ATR is Wilder's, computed off session-aggregated bars through the same `atr()` the
 * ATR indicator plots. A second implementation would have the chart and this file measuring
 * the same market against two slightly different volatilities, with nothing on screen saying
 * so.
 */

export type OpeningRangeSessionId = 'nyse' | 'utc';

interface SessionDef {
    label: string;
    zone: string;
    /** Minutes past local midnight. */
    openMin: number;
    closeMin: number;
}

const SESSIONS: Record<OpeningRangeSessionId, SessionDef> = {
    /* The US cash session — where the volume is, and the open every ORB study is written
     * about. Index futures trade around the clock; the range that matters is still this one. */
    nyse: { label: 'US cash', zone: 'America/New_York', openMin: 9 * 60 + 30, closeMin: 16 * 60 },
    /* A market with no open at all. The UTC day is the only boundary everyone agrees on, and
     * it is where daily crypto candles are cut. */
    utc: { label: 'UTC day', zone: 'UTC', openMin: 0, closeMin: 24 * 60 },
};

export const OPENING_RANGE_SESSION_IDS = Object.keys(SESSIONS) as readonly OpeningRangeSessionId[];

/** What one session's opening range was, and what the days before it say about today. */
export interface OpeningRange {
    /** The bar from which this range could be acted on: the last bar inside the range. */
    index: number;
    /** The session's first bar — where the range starts on a chart. */
    startIndex: number;
    /** The session's last bar. Nothing about this range survives it. */
    sessionEndIndex: number;
    /** The local date the session belongs to, read in its own zone. */
    day: string;
    session: OpeningRangeSessionId;

    /** Open, high, low and close of the opening range itself. */
    open: number;
    high: number;
    low: number;
    close: number;

    /**
     * Which way the range resolved: up when it closed above its open, down when below. Null on
     * a doji, where the open said nothing and there is nothing to follow.
     */
    direction: 'long' | 'short' | null;
    /** The edge a breakout has to take out — the high going long, the low going short. Null on
     *  a doji. */
    trigger: number | null;

    /** Volume traded inside the opening range, or null where the bars carry none. */
    volume: number | null;
    /**
     * That volume against its own average over the previous sessions — 1 is an ordinary
     * opening, 3 is three times the usual interest. Null while there are not enough previous
     * sessions to average over, and wherever volume is missing.
     */
    relativeVolume: number | null;
    /** Daily ATR over the previous sessions, as known at this session's open. Null during
     *  warm-up. */
    atr: number | null;
}

export interface OpeningRangeOptions {
    session?: OpeningRangeSessionId;
    /** How many minutes of the session the range covers. */
    rangeMinutes?: number;
    /** How many previous sessions the daily ATR averages over. */
    atrDays?: number;
    /** How many previous sessions the opening volume is compared against. */
    relVolumeDays?: number;
}

export const OPENING_RANGE_DEFAULTS = {
    session: 'nyse' as OpeningRangeSessionId,
    rangeMinutes: 5,
    atrDays: 14,
    relVolumeDays: 14,
} as const;

const MINUTE = 60_000;

/** One session's stretch of bars, before anything is measured about it. */
interface RawSession {
    day: string;
    startIndex: number;
    endIndex: number;
}

/**
 * The smallest gap between consecutive bars, which is the bar duration wherever the data has
 * one. Sessions leave larger gaps between them; nothing leaves a smaller one.
 */
function stepMinutesOf(bars: readonly OHLCV[]): number {
    let smallest = Infinity;
    for (let i = 1; i < bars.length; i += 1) {
        const d = bars[i]!.time - bars[i - 1]!.time;
        if (d > 0 && d < smallest) smallest = d;
    }
    if (!Number.isFinite(smallest)) {
        throw new Error('detectOpeningRanges: could not determine the bar duration — timestamps do not advance');
    }
    return smallest / MINUTE;
}

/**
 * Every session's opening range over `bars`, ascending by the bar that completed each one.
 *
 * A range that never completes — the data starts mid-session, or ends inside the opening
 * minutes — is left out rather than reported short: a range measured over two of its five
 * minutes is not a smaller range, it is a different number wearing the same name.
 */
export function detectOpeningRanges(bars: readonly OHLCV[], opts: OpeningRangeOptions = {}): OpeningRange[] {
    const sessionId = opts.session ?? OPENING_RANGE_DEFAULTS.session;
    const rangeMinutes = opts.rangeMinutes ?? OPENING_RANGE_DEFAULTS.rangeMinutes;
    const atrDays = opts.atrDays ?? OPENING_RANGE_DEFAULTS.atrDays;
    const relVolumeDays = opts.relVolumeDays ?? OPENING_RANGE_DEFAULTS.relVolumeDays;

    /* Thrown, not clamped: each of these changes which ranges EXIST and how wide they are, and
     * a silently corrected value answers a question nobody asked. */
    const def = SESSIONS[sessionId];
    if (!def) {
        throw new Error(`detectOpeningRanges: unknown session "${sessionId}". Known: ${OPENING_RANGE_SESSION_IDS.join(', ')}`);
    }
    if (!Number.isInteger(rangeMinutes) || rangeMinutes < 1) {
        throw new Error(`detectOpeningRanges: rangeMinutes must be a positive whole number, got ${rangeMinutes}`);
    }
    if (rangeMinutes >= def.closeMin - def.openMin) {
        throw new Error(`detectOpeningRanges: a ${rangeMinutes}-minute range does not fit inside the ${def.label} session`);
    }
    if (!Number.isInteger(atrDays) || atrDays < 1) {
        throw new Error(`detectOpeningRanges: atrDays must be a positive whole number, got ${atrDays}`);
    }
    if (!Number.isInteger(relVolumeDays) || relVolumeDays < 1) {
        throw new Error(`detectOpeningRanges: relVolumeDays must be a positive whole number, got ${relVolumeDays}`);
    }
    if (bars.length < 2) return [];

    /* A range has to be built out of whole bars covering exactly the minutes asked for. On a
     * 15m chart a "5-minute range" would silently be a 15-minute one, and on a 5m chart a
     * 7-minute one would round up to 10 — both report a number under the wrong name, which is
     * worse than refusing. */
    const stepMinutes = stepMinutesOf(bars);
    if (rangeMinutes % stepMinutes !== 0) {
        throw new Error(
            `detectOpeningRanges: a ${rangeMinutes}-minute opening range cannot be built from `
            + `${stepMinutes}-minute bars — it has to be a whole number of them`,
        );
    }

    const sessions = splitIntoSessions(bars, def);
    if (sessions.length === 0) return [];

    const dailyAtr = dailyAtrSeries(bars, sessions, atrDays);
    const rangeEnd = def.openMin + rangeMinutes;

    /* Opening volume per session, kept for every session including those that never produce a
     * range, so the average behind `relativeVolume` counts days rather than tradable days. */
    const openVolumes: (number | null)[] = [];
    const out: OpeningRange[] = [];

    for (let k = 0; k < sessions.length; k += 1) {
        const s = sessions[k]!;

        let last = -1;
        let high = -Infinity;
        let low = Infinity;
        let volume: number | null = null;

        for (let i = s.startIndex; i <= s.endIndex; i += 1) {
            const bar = bars[i]!;
            if (localReading(bar.time, def.zone).minutes >= rangeEnd) break;
            last = i;
            high = Math.max(high, bar.high);
            low = Math.min(low, bar.low);
            if (typeof bar.volume === 'number' && Number.isFinite(bar.volume)) volume = (volume ?? 0) + bar.volume;
        }
        openVolumes.push(volume);

        /* No bar after the range means nothing could ever have been done about it — the data
         * ends here, or the session does. Not a range, and not an event. */
        if (last < 0 || last >= s.endIndex) continue;

        const open = bars[s.startIndex]!.open;
        const close = bars[last]!.close;
        const direction = close > open ? 'long' : close < open ? 'short' : null;

        out.push({
            index: last,
            startIndex: s.startIndex,
            sessionEndIndex: s.endIndex,
            day: s.day,
            session: sessionId,
            open,
            high,
            low,
            close,
            direction,
            trigger: direction === 'long' ? high : direction === 'short' ? low : null,
            volume,
            relativeVolume: relativeVolumeAt(openVolumes, k, relVolumeDays),
            atr: k > 0 ? dailyAtr[k - 1]! : null,
        });
    }

    return out;
}

/** The bars of each session, in order. A gap in the data ends nothing: a session is the run of
 *  bars sharing one local date inside the window, however many of them there are. */
function splitIntoSessions(bars: readonly OHLCV[], def: SessionDef): RawSession[] {
    const out: RawSession[] = [];
    let open: RawSession | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const { minutes, day } = localReading(bars[i]!.time, def.zone);
        if (!inWindow(minutes, def.openMin, def.closeMin)) {
            open = null;
            continue;
        }
        if (open && open.day === day) {
            open.endIndex = i;
            continue;
        }
        open = { day, startIndex: i, endIndex: i };
        out.push(open);
    }
    return out;
}

/**
 * Wilder's ATR over session-aggregated bars: entry k is the ATR *after* session k closed, so a
 * strategy reads k − 1 and never learns anything about the day it is trading.
 */
function dailyAtrSeries(bars: readonly OHLCV[], sessions: readonly RawSession[], atrDays: number): (number | null)[] {
    const daily: OHLCV[] = sessions.map((s) => {
        let high = -Infinity;
        let low = Infinity;
        for (let i = s.startIndex; i <= s.endIndex; i += 1) {
            high = Math.max(high, bars[i]!.high);
            low = Math.min(low, bars[i]!.low);
        }
        return {
            time: bars[s.startIndex]!.time,
            open: bars[s.startIndex]!.open,
            high,
            low,
            close: bars[s.endIndex]!.close,
        };
    });

    // NaN while the average is still filling, which is a real reason to wait rather than guess.
    return atr(daily, atrDays).map((v) => (Number.isFinite(v) ? v : null));
}

/** Opening volume at `k` over the average of the `days` sessions before it, or null when any
 *  of them is missing. */
function relativeVolumeAt(volumes: readonly (number | null)[], k: number, days: number): number | null {
    if (k < days) return null;
    let sum = 0;
    for (let i = k - days; i < k; i += 1) {
        const v = volumes[i];
        if (v == null) return null;
        sum += v;
    }
    const today = volumes[k];
    if (today == null || sum <= 0) return null;
    return today / (sum / days);
}
