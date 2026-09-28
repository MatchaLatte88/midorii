import type { OHLCV } from '../model/ohlcv';
import { barStepMs } from './barClock';
import {
    detectStopHunts,
    findSwings,
    type HuntDirection,
    type HuntSource,
    type StopHunt,
} from './stophunt';
import { localReading, type SessionPreset } from './tradingSessions';

/**
 * Candle Range Theory (CRT) — one closed reference candle, an external-liquidity sweep,
 * Model 1 displacement and a resting retest order back to the opposing candle's open.
 *
 * The detector runs on the execution bars. It folds those bars into a higher-timeframe
 * reference series on a wall clock, so a 01:00 New York four-hour grid remains 01:00, 05:00,
 * 09:00 through daylight-saving changes. The most recently completed reference candle is the
 * only range a sweep may belong to. That makes the choice objective and prevents an older,
 * better-looking range from being selected with hindsight.
 *
 * The sequence is deliberately strict:
 *
 *   reference  the last completed higher-timeframe candle supplies C/H and C/L
 *   key        a confirmed swing, equal high/low, or completed-session level outside it
 *   sweep      one execution candle trades through the key and closes back inside
 *   shift      a directional close breaks the latest confirmed internal swing
 *   Model 1    the last opposing candle from the sweep to the shift; entry is its open
 *
 * A setup becomes actionable only on the shift close. Every earlier index remains attached for
 * drawing, but {@link CrtSetup.index} is the only one a strategy reads.
 */

export type CrtDirection = HuntDirection;
export type CrtOutcome = 'target' | 'stop' | 'open' | 'armed' | 'expired';

export interface CrtReferenceCandle extends OHLCV {
    /** Whether the loaded history contains the bucket's wall-clock opening bar. */
    complete: boolean;
    /** First execution bar folded into the candle. */
    startIndex: number;
    /** Last execution bar folded into the candle. */
    endIndex: number;
    startTime: number;
    endTime: number;
}

export interface CrtSetup {
    direction: CrtDirection;

    referenceStartIndex: number;
    referenceEndIndex: number;
    referenceStartTime: number;
    referenceEndTime: number;
    referenceHigh: number;
    referenceLow: number;

    keySource: HuntSource;
    keyLevel: number;
    keyIndex: number;
    keyTime: number;

    sweepIndex: number;
    sweepTime: number;
    sweepExtreme: number;

    structureIndex: number;
    structureTime: number;
    structureLevel: number;

    /** The Model 1 order-block candle — always opposing the expected trade. */
    modelIndex: number;
    modelTime: number;
    modelTop: number;
    modelBottom: number;

    entryPrice: number;
    stop: number;
    target: number;
    risk: number;
    reward: number;
    rewardRisk: number;

    expiryIndex: number;
    expiryTime: number;
    fillIndex: number | null;
    fillTime: number | null;

    /** The shift close — the first bar from which the complete setup was knowable. */
    index: number;
    time: number;

    outcome: CrtOutcome;
    outcomeIndex: number | null;
    outcomeTime: number | null;
}

export interface CrtDetectOptions {
    /** Higher-timeframe candle length in minutes. Default 240 (H4). */
    referenceMinutes?: number;
    /** Wall-clock start anchoring the higher-timeframe grid, in local minutes. Default 01:00. */
    referenceAnchorMin?: number;
    /** IANA clock used for the grid. Default New York. */
    zone?: string;
    /** Which structural levels may supply the liquidity key. Default swing highs/lows. */
    keySources?: readonly HuntSource[];
    /** Swing strength used for swing/equal key levels. Default 2. */
    keyStrength?: number;
    /** Tolerance for equal highs/lows, as a percentage of price. Default 0.05. */
    equalTolerance?: number;
    /** Which session definitions supply session levels. Default futures. */
    sessionPreset?: SessionPreset;
    /** Swing strength used for the internal structure break. Default 2. */
    internalStrength?: number;
    /** Last bar on which the structure shift may close, counted after the sweep. Default 12. */
    maxSweepToShift?: number;
    /** Last bar on which the Model 1 limit may fill, counted after the shift. Default 12. */
    orderExpiryBars?: number;
    /** Raw price distance placed beyond the sweep extreme. Default 0. */
    stopBuffer?: number;
    /** Only setups confirmed in the last N execution bars; 0 = all. */
    lookback?: number;
}

export const CRT_DEFAULTS = {
    referenceMinutes: 240,
    referenceAnchorMin: 60,
    zone: 'America/New_York',
    keySources: ['swing'] as readonly HuntSource[],
    keyStrength: 2,
    equalTolerance: 0.05,
    sessionPreset: 'futures' as SessionPreset,
    internalStrength: 2,
    maxSweepToShift: 12,
    orderExpiryBars: 12,
    stopBuffer: 0,
    lookback: 0,
} as const;

/**
 * Fold execution bars into wall-clock-aligned reference candles.
 *
 * Exported so the alignment can be positively tested without manufacturing a whole setup.
 * A missing execution bar stays missing inside its bucket; bars are never stitched across a
 * bucket boundary or a daylight-saving change.
 */
export function buildCrtReferenceCandles(
    bars: readonly OHLCV[],
    referenceMinutes: number,
    referenceAnchorMin: number,
    zone: string,
): CrtReferenceCandle[] {
    if (!(referenceMinutes >= 1) || !Number.isInteger(referenceMinutes)) {
        throw new Error(`detectCrt: referenceMinutes must be a positive integer, got ${referenceMinutes}`);
    }
    if (1440 % referenceMinutes !== 0) {
        throw new Error(`detectCrt: referenceMinutes must divide a wall-clock day, got ${referenceMinutes}`);
    }
    if (!(referenceAnchorMin >= 0 && referenceAnchorMin <= 1439) || !Number.isInteger(referenceAnchorMin)) {
        throw new Error(`detectCrt: referenceAnchorMin must be an integer from 0 to 1439, got ${referenceAnchorMin}`);
    }
    if (bars.length === 0) return [];

    const out: CrtReferenceCandle[] = [];
    let activeBucket: number | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const reading = localReading(bar.time, zone);
        const localMinute = wallMinutes(reading.day, reading.minutes);
        const bucket = Math.floor((localMinute - referenceAnchorMin) / referenceMinutes);

        if (bucket !== activeBucket) {
            out.push({
                ...bar,
                complete: i > 0 || localMinute === bucket * referenceMinutes + referenceAnchorMin,
                startIndex: i,
                endIndex: i,
                startTime: bar.time,
                endTime: bar.time,
            });
            activeBucket = bucket;
            continue;
        }

        const current = out[out.length - 1]!;
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
        if (bar.volume != null) current.volume = (current.volume ?? 0) + bar.volume;
        current.endIndex = i;
        current.endTime = bar.time;
    }

    return out;
}

/** Every complete CRT setup, ordered by the shift that made it actionable. */
export function detectCrt(bars: readonly OHLCV[], opts: CrtDetectOptions = {}): CrtSetup[] {
    if (bars.length === 0) return [];

    const referenceMinutes = opts.referenceMinutes ?? CRT_DEFAULTS.referenceMinutes;
    const referenceAnchorMin = opts.referenceAnchorMin ?? CRT_DEFAULTS.referenceAnchorMin;
    const zone = opts.zone ?? CRT_DEFAULTS.zone;
    const keySources = opts.keySources ?? CRT_DEFAULTS.keySources;
    const keyStrength = opts.keyStrength ?? CRT_DEFAULTS.keyStrength;
    const equalTolerance = opts.equalTolerance ?? CRT_DEFAULTS.equalTolerance;
    const sessionPreset = opts.sessionPreset ?? CRT_DEFAULTS.sessionPreset;
    const internalStrength = opts.internalStrength ?? CRT_DEFAULTS.internalStrength;
    const maxSweepToShift = opts.maxSweepToShift ?? CRT_DEFAULTS.maxSweepToShift;
    const orderExpiryBars = opts.orderExpiryBars ?? CRT_DEFAULTS.orderExpiryBars;
    const stopBuffer = opts.stopBuffer ?? CRT_DEFAULTS.stopBuffer;

    if (!(keyStrength >= 1)) throw new Error(`detectCrt: keyStrength must be >= 1, got ${keyStrength}`);
    if (!(internalStrength >= 1)) throw new Error(`detectCrt: internalStrength must be >= 1, got ${internalStrength}`);
    if (!(maxSweepToShift >= 1)) throw new Error(`detectCrt: maxSweepToShift must be >= 1, got ${maxSweepToShift}`);
    if (!(orderExpiryBars >= 1)) throw new Error(`detectCrt: orderExpiryBars must be >= 1, got ${orderExpiryBars}`);
    if (!(stopBuffer >= 0)) throw new Error(`detectCrt: stopBuffer must be >= 0, got ${stopBuffer}`);

    const executionMinutes = barStepMs(bars) / 60_000;
    if (!(referenceMinutes > executionMinutes)) {
        throw new Error(
            `detectCrt: reference timeframe (${referenceMinutes}m) must be above the execution timeframe (${executionMinutes}m)`,
        );
    }

    const references = buildCrtReferenceCandles(bars, referenceMinutes, referenceAnchorMin, zone);
    const hunts = detectStopHunts(bars, {
        sources: keySources,
        strength: keyStrength,
        confirmBars: 1,
        equalTolerance,
        sessionPreset,
        holdBars: 0,
        show: 'all',
    });
    const structure = findSwings(bars, internalStrength);
    const usedReferences = new Set<number>();
    const setups: CrtSetup[] = [];

    for (const hunt of hunts) {
        const reference = latestReferenceBefore(references, hunt.sweepIndex);
        if (!reference || usedReferences.has(reference.startIndex)) continue;
        if (!keyOutsideReference(hunt, reference)) continue;

        const pivot = latestInternalPivot(structure, hunt, reference.startIndex);
        if (!pivot) continue;

        const setup = completeSetup(bars, reference, hunt, pivot, {
            maxSweepToShift,
            orderExpiryBars,
            stopBuffer,
        });
        if (!setup) continue;

        usedReferences.add(reference.startIndex);
        resolveOutcome(bars, setup);
        setups.push(setup);
    }

    setups.sort((a, b) => a.index - b.index);
    const lookback = opts.lookback ?? CRT_DEFAULTS.lookback;
    if (!(lookback > 0)) return setups;
    const cutoff = bars.length - lookback;
    return setups.filter((setup) => setup.index >= cutoff);
}

function wallMinutes(day: string, minutes: number): number {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000) * 1440 + minutes;
}

function latestReferenceBefore(
    references: readonly CrtReferenceCandle[],
    sourceIndex: number,
): CrtReferenceCandle | null {
    for (let i = references.length - 1; i >= 0; i -= 1) {
        if (references[i]!.complete && references[i]!.endIndex < sourceIndex) return references[i]!;
    }
    return null;
}

function keyOutsideReference(hunt: StopHunt, reference: CrtReferenceCandle): boolean {
    return hunt.direction === 'bear'
        ? hunt.level >= reference.high
        : hunt.level <= reference.low;
}

interface InternalPivot {
    formedIndex: number;
    formedTime: number;
    price: number;
}

function latestInternalPivot(
    structure: ReturnType<typeof findSwings>,
    hunt: StopHunt,
    referenceStartIndex: number,
): InternalPivot | null {
    const wanted = hunt.direction === 'bear' ? 'low' : 'high';
    for (let i = structure.length - 1; i >= 0; i -= 1) {
        const pivot = structure[i]!;
        if (pivot.side !== wanted) continue;
        if (pivot.formedIndex < referenceStartIndex || pivot.formedIndex >= hunt.sweepIndex) continue;
        if (pivot.knownIndex > hunt.sweepIndex) continue;
        return { formedIndex: pivot.formedIndex, formedTime: pivot.formedTime, price: pivot.price };
    }
    return null;
}

interface CompletionOptions {
    maxSweepToShift: number;
    orderExpiryBars: number;
    stopBuffer: number;
}

function completeSetup(
    bars: readonly OHLCV[],
    reference: CrtReferenceCandle,
    hunt: StopHunt,
    pivot: InternalPivot,
    opts: CompletionOptions,
): CrtSetup | null {
    const short = hunt.direction === 'bear';
    const last = Math.min(bars.length - 1, hunt.sweepIndex + opts.maxSweepToShift);
    let modelIndex = opposing(bars[hunt.sweepIndex]!, hunt.direction) ? hunt.sweepIndex : -1;

    for (let i = hunt.sweepIndex + 1; i <= last; i += 1) {
        const bar = bars[i]!;
        const invalidated = short ? bar.close > hunt.level : bar.close < hunt.level;
        if (invalidated) return null;

        const shifted = short
            ? bar.close < bar.open && bar.close < pivot.price
            : bar.close > bar.open && bar.close > pivot.price;

        if (shifted && modelIndex >= hunt.sweepIndex) {
            const model = bars[modelIndex]!;
            const entryPrice = model.open;
            const stop = short
                ? hunt.extreme + opts.stopBuffer
                : hunt.extreme - opts.stopBuffer;
            const target = short ? reference.low : reference.high;
            const risk = short ? stop - entryPrice : entryPrice - stop;
            const reward = short ? entryPrice - target : target - entryPrice;
            if (!(risk > 0) || !(reward > 0)) return null;

            const expiryIndex = i + opts.orderExpiryBars;
            return {
                direction: hunt.direction,

                referenceStartIndex: reference.startIndex,
                referenceEndIndex: reference.endIndex,
                referenceStartTime: reference.startTime,
                referenceEndTime: reference.endTime,
                referenceHigh: reference.high,
                referenceLow: reference.low,

                keySource: hunt.source,
                keyLevel: hunt.level,
                keyIndex: hunt.levelIndex,
                keyTime: hunt.levelTime,

                sweepIndex: hunt.sweepIndex,
                sweepTime: hunt.sweepTime,
                sweepExtreme: hunt.extreme,

                structureIndex: pivot.formedIndex,
                structureTime: pivot.formedTime,
                structureLevel: pivot.price,

                modelIndex,
                modelTime: model.time,
                modelTop: Math.max(model.open, model.close),
                modelBottom: Math.min(model.open, model.close),

                entryPrice,
                stop,
                target,
                risk,
                reward,
                rewardRisk: reward / risk,

                expiryIndex,
                expiryTime: timeAt(bars, expiryIndex),
                fillIndex: null,
                fillTime: null,

                index: i,
                time: bar.time,

                outcome: 'armed',
                outcomeIndex: null,
                outcomeTime: null,
            };
        }

        if (opposing(bar, hunt.direction)) modelIndex = i;
    }

    return null;
}

function opposing(bar: OHLCV, direction: CrtDirection): boolean {
    return direction === 'bear' ? bar.close > bar.open : bar.close < bar.open;
}

function resolveOutcome(bars: readonly OHLCV[], setup: CrtSetup): void {
    const short = setup.direction === 'bear';
    const lastFill = Math.min(bars.length - 1, setup.expiryIndex);

    let fill = -1;
    for (let i = setup.index + 1; i <= lastFill; i += 1) {
        const touched = short ? bars[i]!.high >= setup.entryPrice : bars[i]!.low <= setup.entryPrice;
        if (!touched) continue;
        fill = i;
        break;
    }

    if (fill < 0) {
        setup.outcome = setup.expiryIndex > bars.length - 1 ? 'armed' : 'expired';
        return;
    }

    setup.fillIndex = fill;
    setup.fillTime = bars[fill]!.time;
    setup.outcome = 'open';

    for (let i = fill; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const hitStop = short ? bar.high >= setup.stop : bar.low <= setup.stop;
        const hitTarget = short ? bar.low <= setup.target : bar.high >= setup.target;
        if (!hitStop && !hitTarget) continue;

        // Same-bar ambiguity is pessimistic, matching the backtest without finer bars.
        setup.outcome = hitStop ? 'stop' : 'target';
        setup.outcomeIndex = i;
        setup.outcomeTime = bar.time;
        return;
    }
}

function timeAt(bars: readonly OHLCV[], index: number): number {
    const last = bars.length - 1;
    if (index <= last) return bars[index]!.time;
    const spacing = bars.length > 1 ? bars[last]!.time - bars[last - 1]!.time : 0;
    return bars[last]!.time + (index - last) * spacing;
}
