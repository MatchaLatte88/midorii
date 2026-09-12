import type { OHLCV } from '../model/ohlcv';
import { sourceValues } from '../native-indicators/classics/math';
import { readBarClock, type BarClock } from './barClock';
import { inWindow } from './tradingSessions';

/**
 * The session's volume-weighted average price, and how far the market usually sits from it.
 *
 * Everything here is a fact about the market: where the average traded price of the session
 * stands at each bar, and how wide the dispersion around it has been so far. Nothing here
 * trades. What to do about a market two standard deviations away lives in
 * `app/renderer/strategies/vwapReversion.ts`, which is the whole difference between an
 * indicator and a strategy.
 *
 * Anchored to the session, not to the UTC day — and the chart is not
 * ------------------------------------------------------------------
 * A VWAP means "the average price everyone paid since the market opened", so it resets at the
 * open. For the US cash session that is 09:30 New York, a wall-clock time that moves against
 * UTC twice a year; for a market that never opens it is the UTC day, where the daily candles
 * are cut. Both are read through {@link readBarClock}, the same clock every other detector
 * here uses.
 *
 * This is a real and deliberate disagreement with the chart. The `vwap` classic indicator in
 * `native-indicators/classics/overlays.ts` anchors on the UTC Day, Week or Month and has no
 * session anchor, so on an index future its line and this one are two different averages from
 * 00:00 UTC until 09:30 New York, and stay apart for the rest of the day. A backtest from this
 * file will not line up with that line on screen, and that is the indicator's anchor talking
 * rather than a bug here. Giving the chart indicator a session anchor is the fix, and it is a
 * change to the chart rather than to this file.
 *
 * What sigma is, precisely
 * ------------------------
 * The volume-weighted standard deviation of the same source price around the session VWAP,
 * accumulated from the session's open — the population form, each bar weighted by its own
 * volume. It is worth stating because platforms disagree: some band the VWAP with an
 * UNWEIGHTED standard deviation of closes, which is a different number under the same name and
 * draws visibly different bands on a session with one heavy opening minute. Anything measured
 * here is measured against this definition.
 *
 * It is accumulated by West's weighted incremental method rather than as E[x^2] - E[x]^2,
 * which is the same quantity written to survive the arithmetic: on an instrument trading near
 * 20,000 the squared prices reach 4 x 10^8, and subtracting two numbers that size to recover a
 * variance of a few points loses most of the digits that matter. The VWAP itself is the
 * running weighted mean of that method, and is the ordinary sum(price x volume) / sum(volume).
 *
 * Why the first bar of a session has no sigma
 * -------------------------------------------
 * With one bar the dispersion around the average is zero by construction, so a distance
 * measured in sigmas is a division by zero dressed up as a signal. Sigma therefore stays null
 * until a session has two bars carrying volume. That is a mathematical floor and not a
 * judgement about how much of a session must pass before the number means anything — that
 * judgement belongs to the strategy, which has a warm-up setting for it.
 *
 * Bars with no volume contribute nothing. Where an instrument carries no volume at all the
 * VWAP does not exist, every value here is null, and the strategy says so loudly rather than
 * reporting a run with no trades in it.
 */

export type VwapSessionId = 'nyse' | 'utc';

interface SessionDef {
    label: string;
    zone: string;
    /** Minutes past local midnight. */
    openMin: number;
    closeMin: number;
}

/* The same two markets the opening range offers, which keeps its own copy: these are four
 * lines of data about where a trading day starts, and each detector states the window it
 * measures rather than reaching into another one's. */
const SESSIONS: Record<VwapSessionId, SessionDef> = {
    /* The US cash session — where the volume is, and the open a session VWAP resets at. */
    nyse: { label: 'US cash', zone: 'America/New_York', openMin: 9 * 60 + 30, closeMin: 16 * 60 },
    /* A market with no open at all. The UTC day is the only boundary everyone agrees on. */
    utc: { label: 'UTC day', zone: 'UTC', openMin: 0, closeMin: 24 * 60 },
};

export const VWAP_SESSION_IDS = Object.keys(SESSIONS) as readonly VwapSessionId[];

/** Which price of a bar goes into the average. The classics' own names, so the chart and this
 *  file mean the same thing by "HLC3". */
export type VwapSource = 'HLC3' | 'OHLC4' | 'Close';

export interface VwapBandsOptions {
    session?: VwapSessionId;
    source?: VwapSource;
}

export const VWAP_BANDS_DEFAULTS = {
    session: 'nyse' as VwapSessionId,
    /* The typical price, which is what a VWAP is conventionally built from and what the chart
     * indicator defaults to. */
    source: 'HLC3' as VwapSource,
} as const;

/** One value per bar, for every bar handed in. Null wherever the bar sits outside a session,
 *  or before the number exists. */
export interface VwapBands {
    /** The session's volume-weighted average price as of this bar's close. */
    vwap: (number | null)[];
    /** Volume-weighted standard deviation around it, accumulated from the session's open. */
    sigma: (number | null)[];
    /** Minutes of elapsed time since this bar's session opened. Measured from the timestamps
     *  rather than off the wall clock, so the hour a clock change adds or removes is counted
     *  as the hour of trading it actually was. */
    sinceOpen: (number | null)[];
    /** The local day of the session this bar belongs to — what separates one occurrence of a
     *  session from the next. */
    day: (string | null)[];
    /** The clock the series was read on, for a strategy with its own wall-clock rules to apply
     *  to the same bars. */
    clock: BarClock;
}

const MINUTE = 60_000;

/**
 * The session VWAP and its dispersion at every bar, in order.
 *
 * A bar outside the session window carries nulls rather than the last value inside it: the
 * average of a session that has closed is not a price anything can act on, and carrying it
 * forward would let a rule read a level hours after it stopped being measured.
 */
export function detectVwapBands(bars: readonly OHLCV[], opts: VwapBandsOptions = {}): VwapBands {
    const sessionId = opts.session ?? VWAP_BANDS_DEFAULTS.session;
    const source = opts.source ?? VWAP_BANDS_DEFAULTS.source;

    /* Thrown, not defaulted: an unknown session is a caller asking for a market this does not
     * measure, and quietly handing back the US cash session answers a question nobody asked. */
    const def = SESSIONS[sessionId];
    if (!def) {
        throw new Error(`detectVwapBands: unknown session "${sessionId}". Known: ${VWAP_SESSION_IDS.join(', ')}`);
    }

    const clock = readBarClock(bars, def.zone);
    const prices = sourceValues(bars, source);

    const vwap = new Array<number | null>(bars.length).fill(null);
    const sigma = new Array<number | null>(bars.length).fill(null);
    const sinceOpen = new Array<number | null>(bars.length).fill(null);
    const day = new Array<string | null>(bars.length).fill(null);

    /* The running accumulation, reset at each session open. `mean` is the VWAP itself and `m2`
     * the weighted sum of squared deviations from it — see the header. */
    let openDay: string | null = null;
    let openTime = 0;
    let weight = 0;
    let mean = 0;
    let m2 = 0;
    let volumeBars = 0;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const today = clock.days[i]!;

        if (!inWindow(clock.openMinutes[i]!, def.openMin, def.closeMin)) {
            /* Outside the window entirely. The next bar inside it opens a fresh session even if
             * it shares the local day, which is what an overnight gap in a cash session is. */
            openDay = null;
            continue;
        }

        if (openDay !== today) {
            openDay = today;
            openTime = bar.time;
            weight = 0;
            mean = 0;
            m2 = 0;
            volumeBars = 0;
        }

        day[i] = today;
        sinceOpen[i] = (bar.time - openTime) / MINUTE;

        const volume = bar.volume;
        const price = prices[i]!;
        if (typeof volume === 'number' && Number.isFinite(volume) && volume > 0 && Number.isFinite(price)) {
            weight += volume;
            const delta = price - mean;
            mean += (volume / weight) * delta;
            m2 += volume * delta * (price - mean);
            volumeBars += 1;
        }

        if (weight <= 0) continue;
        vwap[i] = mean;
        /* Clamped at zero: m2 is non-negative in exact arithmetic and can land a hair below it
         * in floating point, which Math.sqrt would turn into NaN. */
        if (volumeBars >= 2) sigma[i] = Math.sqrt(Math.max(0, m2 / weight));
    }

    return { vwap, sigma, sinceOpen, day, clock };
}
