import type { OHLCV } from '../model/ohlcv';
import { atr, highest, lowest } from '../native-indicators/classics/math';
import { inWindow, localReading } from './tradingSessions';

/**
 * Accumulation → manipulation → fair value gap, the three-phase setup behind the AMD FVG
 * study and strategy.
 *
 *   accumulation  the rolling `accLength`-bar range is no wider than `accWidthPct` of its low,
 *                 on a bar inside an enabled session; every such bar re-arms the range
 *   manipulation  within `maxSearch` bars of the last accumulation bar, price trades beyond one
 *                 edge — the first edge broken decides the direction for the whole episode
 *   gap           a three-candle gap against the break, larger than `fvgAtr` × ATR, on a candle
 *                 that closes back inside the range
 *
 * Every bar that satisfies the gap condition is reported as a candidate, not only the first.
 * The reference study takes the first candidate of an episode that arrives while no trade is
 * running and skips — without consuming the episode — those that arrive during one. A later
 * candidate of the same episode can therefore still trigger. Which trade blocks is a question
 * for the consumer: the chart study simulates its own trade ({@link selectAmdFvgSignals}),
 * a strategy uses its real position.
 *
 * Every value is read on the candidate's own close, so appending bars never moves a candidate.
 */

export type AmdDirection = 'bull' | 'bear';
export type AmdSession = 'sydney' | 'tokyo' | 'london' | 'newyork';

export interface AmdFvgCandidate {
    direction: AmdDirection;
    /** First and last bar of the accumulation window. The last bar identifies the episode. */
    accStartIndex: number;
    accStartTime: number;
    accEndIndex: number;
    accEndTime: number;
    accHigh: number;
    accLow: number;
    /** The bar that first traded beyond the range. */
    manipulationIndex: number;
    /** Furthest price beyond the range up to and including this candle. */
    manipulationExtreme: number;
    /** The gap between the high/low two bars back and this candle's low/high. */
    fvgStartIndex: number;
    fvgStartTime: number;
    fvgTop: number;
    fvgBottom: number;
    /** This candle's close, where the reference study measures its levels from. */
    close: number;
    high: number;
    low: number;
    atr: number;
    /** The candle that completed the gap — the first bar the candidate is knowable. */
    index: number;
    time: number;
}

export interface AmdFvgOptions {
    /** Bars in the rolling accumulation window. Default 30. */
    accLength?: number;
    /** Widest accumulation range, as a percentage of its low. Default 0.2. */
    accWidthPct?: number;
    /** Bars after the last accumulation bar in which manipulation and gap may occur. Default 10. */
    maxSearch?: number;
    /** Smallest gap, as a multiple of ATR. The gap must exceed it strictly. Default 0.1. */
    fvgAtr?: number;
    /** Wilder ATR length. Default 14. */
    atrLength?: number;
    /** Sessions whose bars may accumulate and trigger, read on the New York clock. */
    sessions?: readonly AmdSession[];
}

export const AMD_FVG_DEFAULTS = {
    accLength: 30,
    accWidthPct: 0.2,
    maxSearch: 10,
    fvgAtr: 0.1,
    atrLength: 14,
    atrMult: 2,
    rrr: 2,
    sessions: ['newyork'] as readonly AmdSession[],
} as const;

export const AMD_SESSION_IDS: readonly AmdSession[] = ['sydney', 'tokyo', 'london', 'newyork'];

/** Session windows in New York minutes past midnight, end exclusive. */
const SESSION_WINDOWS: Record<AmdSession, readonly [number, number]> = {
    sydney: [17 * 60, 2 * 60],
    tokyo: [19 * 60, 4 * 60],
    london: [3 * 60, 12 * 60],
    newyork: [8 * 60, 17 * 60],
};

const ZONE = 'America/New_York';

/** Whether each bar opens inside an enabled session. */
export function amdSessionMask(bars: readonly OHLCV[], sessions: readonly AmdSession[]): boolean[] {
    for (const session of sessions) {
        if (!AMD_SESSION_IDS.includes(session)) {
            throw new Error(`detectAmdFvg: unknown session "${String(session)}"`);
        }
    }
    return bars.map((bar) => {
        const { minutes } = localReading(bar.time, ZONE);
        return sessions.some((session) => {
            const [start, end] = SESSION_WINDOWS[session];
            return inWindow(minutes, start, end);
        });
    });
}

interface Episode {
    startIndex: number;
    endIndex: number;
    high: number;
    low: number;
    direction: AmdDirection | null;
    manipulationIndex: number;
    extreme: number;
}

/** Every bar that completes the setup, in bar order. */
export function detectAmdFvg(bars: readonly OHLCV[], opts: AmdFvgOptions = {}): AmdFvgCandidate[] {
    const accLength = opts.accLength ?? AMD_FVG_DEFAULTS.accLength;
    const accWidthPct = opts.accWidthPct ?? AMD_FVG_DEFAULTS.accWidthPct;
    const maxSearch = opts.maxSearch ?? AMD_FVG_DEFAULTS.maxSearch;
    const fvgAtr = opts.fvgAtr ?? AMD_FVG_DEFAULTS.fvgAtr;
    const atrLength = opts.atrLength ?? AMD_FVG_DEFAULTS.atrLength;
    const sessions = opts.sessions ?? AMD_FVG_DEFAULTS.sessions;

    checkOptions({ accLength, accWidthPct, maxSearch, fvgAtr, atrLength });
    const inSession = amdSessionMask(bars, sessions);
    if (bars.length === 0) return [];

    const highs = highest(bars.map((bar) => bar.high), accLength);
    const lows = lowest(bars.map((bar) => bar.low), accLength);
    const atrValues = atr(bars, atrLength);
    const out: AmdFvgCandidate[] = [];
    let episode: Episode | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const rangeHigh = highs[i]!;
        const rangeLow = lows[i]!;
        // A percentage width is undefined for a non-positive low, so such a window never qualifies.
        const accumulating = inSession[i]!
            && Number.isFinite(rangeHigh) && rangeLow > 0
            && ((rangeHigh - rangeLow) / rangeLow) * 100 <= accWidthPct;

        if (accumulating) {
            episode = {
                startIndex: i - accLength + 1,
                endIndex: i,
                high: rangeHigh,
                low: rangeLow,
                direction: null,
                manipulationIndex: -1,
                extreme: Number.NaN,
            };
            continue;
        }
        if (!episode || !inSession[i] || i > episode.endIndex + maxSearch) continue;

        // The upper edge is tested first, so a candle breaking both edges starts a bearish episode.
        if (episode.direction === null) {
            if (bar.high > episode.high) {
                episode.direction = 'bear';
                episode.manipulationIndex = i;
                episode.extreme = bar.high;
            } else if (bar.low < episode.low) {
                episode.direction = 'bull';
                episode.manipulationIndex = i;
                episode.extreme = bar.low;
            }
        }
        if (episode.direction === null || i < 2) continue;

        const atrValue = atrValues[i]!;
        const twoBack = bars[i - 2]!;
        if (episode.direction === 'bear') {
            episode.extreme = Math.max(episode.extreme, bar.high);
            const gap = twoBack.low - bar.high;
            if (Number.isFinite(atrValue) && gap > atrValue * fvgAtr && bar.close < episode.high) {
                out.push(candidate(bars, episode, i, twoBack.low, bar.high, atrValue));
            }
        } else {
            episode.extreme = Math.min(episode.extreme, bar.low);
            const gap = bar.low - twoBack.high;
            if (Number.isFinite(atrValue) && gap > atrValue * fvgAtr && bar.close > episode.low) {
                out.push(candidate(bars, episode, i, bar.low, twoBack.high, atrValue));
            }
        }
    }

    return out;
}

function candidate(
    bars: readonly OHLCV[],
    episode: Episode,
    index: number,
    fvgTop: number,
    fvgBottom: number,
    atrValue: number,
): AmdFvgCandidate {
    const bar = bars[index]!;
    return {
        direction: episode.direction!,
        accStartIndex: episode.startIndex,
        accStartTime: bars[episode.startIndex]!.time,
        accEndIndex: episode.endIndex,
        accEndTime: bars[episode.endIndex]!.time,
        accHigh: episode.high,
        accLow: episode.low,
        manipulationIndex: episode.manipulationIndex,
        manipulationExtreme: episode.extreme,
        fvgStartIndex: index - 2,
        fvgStartTime: bars[index - 2]!.time,
        fvgTop,
        fvgBottom,
        close: bar.close,
        high: bar.high,
        low: bar.low,
        atr: atrValue,
        index,
        time: bar.time,
    };
}

export type AmdTradeOutcome = 'target' | 'stop' | 'open';

/** A candidate the chart study acted on, with the trade it simulates from the signal close. */
export interface AmdFvgSignal extends AmdFvgCandidate {
    stop: number;
    target: number;
    /** The bar on which price first reached the stop or target; null while neither is hit. */
    exitIndex: number | null;
    exitTime: number | null;
    outcome: AmdTradeOutcome;
}

/**
 * The reference study's own trade gating: one simulated trade at a time, its stop `atrMult` ×
 * ATR from the signal close and its target `rrr` times that distance on the other side.
 *
 * The exit is checked from the bar after the signal. A candidate on the exit bar itself may
 * trigger again, because the reference closes the trade before it looks for a new setup.
 * Each episode triggers at most once.
 */
export function selectAmdFvgSignals(
    candidates: readonly AmdFvgCandidate[],
    bars: readonly OHLCV[],
    atrMult: number,
    rrr: number,
): AmdFvgSignal[] {
    if (!(atrMult > 0)) throw new Error(`selectAmdFvgSignals: atrMult must be positive, got ${atrMult}`);
    if (!(rrr > 0)) throw new Error(`selectAmdFvgSignals: rrr must be positive, got ${rrr}`);

    const signals: AmdFvgSignal[] = [];
    let lastEpisode = -1;
    let active: AmdFvgSignal | null = null;

    for (const next of candidates) {
        if (next.accEndIndex === lastEpisode) continue;
        if (active && (active.exitIndex === null || active.exitIndex > next.index)) continue;

        const distance = next.atr * atrMult;
        const long = next.direction === 'bull';
        const signal: AmdFvgSignal = {
            ...next,
            stop: long ? next.close - distance : next.close + distance,
            target: long ? next.close + distance * rrr : next.close - distance * rrr,
            exitIndex: null,
            exitTime: null,
            outcome: 'open',
        };
        resolveExit(bars, signal);
        signals.push(signal);
        lastEpisode = next.accEndIndex;
        active = signal;
    }

    return signals;
}

function resolveExit(bars: readonly OHLCV[], signal: AmdFvgSignal): void {
    const long = signal.direction === 'bull';
    for (let i = signal.index + 1; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const hitStop = long ? bar.low <= signal.stop : bar.high >= signal.stop;
        const hitTarget = long ? bar.high >= signal.target : bar.low <= signal.target;
        if (!hitStop && !hitTarget) continue;
        // Both inside one bar cannot be ordered without finer data; the stop is assumed first.
        signal.outcome = hitStop ? 'stop' : 'target';
        signal.exitIndex = i;
        signal.exitTime = bar.time;
        return;
    }
}

function checkOptions(options: {
    accLength: number;
    accWidthPct: number;
    maxSearch: number;
    fvgAtr: number;
    atrLength: number;
}): void {
    const integer = (name: string, value: number, minimum: number): void => {
        if (!Number.isInteger(value) || value < minimum) {
            throw new Error(`detectAmdFvg: ${name} must be an integer >= ${minimum}, got ${value}`);
        }
    };
    integer('accLength', options.accLength, 2);
    integer('maxSearch', options.maxSearch, 1);
    integer('atrLength', options.atrLength, 1);
    if (!(options.accWidthPct > 0)) {
        throw new Error(`detectAmdFvg: accWidthPct must be positive, got ${options.accWidthPct}`);
    }
    if (!(options.fvgAtr >= 0)) {
        throw new Error(`detectAmdFvg: fvgAtr must be >= 0, got ${options.fvgAtr}`);
    }
}
