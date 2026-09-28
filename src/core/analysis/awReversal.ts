import type { OHLCV } from '../model/ohlcv';
import { atr } from '../native-indicators/classics/math';
import { readBarClock } from './barClock';
import { findSwings } from './stophunt';
import { localReading } from './tradingSessions';

/**
 * Liquidity-reversal detection shared by two execution variants.
 *
 * `formations` reports the close that creates the fair value gap, early enough for an
 * executable resting order. `referenceEntries` follows the reference script: the creation
 * candle itself counts as a touch, while a gap created outside an enabled session waits for
 * a later in-session touch. Midorii still fills an order no earlier than the following bar.
 *
 * Every swing is exposed on its confirmation bar, never on the pivot bar. Higher-timeframe
 * swings are exposed only after their confirmation candle has closed. Appending history can
 * therefore add signals, but cannot move an existing one backwards.
 */

export type AwDirection = 'bull' | 'bear';
export type AwSession = 'asia' | 'london' | 'nyam' | 'nypm';
export type AwHtfMode = 'auto' | 'manual';

export interface AwReversalSetup {
    direction: AwDirection;
    sweepIndex: number;
    sweepTime: number;
    sweepExtreme: number;
    necklineIndex: number;
    necklineTime: number;
    neckline: number;
    shiftIndex: number;
    shiftTime: number;
    fvgTop: number;
    fvgBottom: number;
    formationIndex: number;
    formationTime: number;
    expiryIndex: number;
    /** Near edge of the gap, used for sizing by both variants. */
    entryPrice: number;
    stop: number;
    /** Nearest untaken opposite-side level when this event became actionable. */
    liquidityTarget: number | null;
    /** Formation bar for limit entries, touch bar for reference entries. */
    index: number;
    time: number;
}

export interface AwReversalDetection {
    formations: AwReversalSetup[];
    referenceEntries: AwReversalSetup[];
    /** Whether an order placed after bar i would enter an enabled session. */
    nextSessionAllowed: number[];
}

export interface AwReversalOptions {
    swingLength?: number;
    maxLiquidity?: number;
    useHtfLiquidity?: boolean;
    htfMode?: AwHtfMode;
    htfMinutes?: number;
    htfPivotStrength?: number;
    usePreviousDay?: boolean;
    atrLength?: number;
    displacementAtr?: number;
    maxSweepToShift?: number;
    fvgSearchWindow?: number;
    maxShiftToEntry?: number;
    sessions?: readonly AwSession[];
    zone?: string;
}

export const AW_REVERSAL_DEFAULTS = {
    swingLength: 3,
    maxLiquidity: 15,
    useHtfLiquidity: true,
    htfMode: 'auto' as AwHtfMode,
    htfMinutes: 60,
    htfPivotStrength: 2,
    usePreviousDay: true,
    atrLength: 2,
    displacementAtr: 1,
    maxSweepToShift: 30,
    fvgSearchWindow: 1,
    maxShiftToEntry: 10,
    sessions: ['asia', 'london', 'nyam'] as readonly AwSession[],
    zone: 'America/New_York',
} as const;

const SESSION_IDS: readonly AwSession[] = ['asia', 'london', 'nyam', 'nypm'];
const MINUTE = 60_000;
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

interface Pivot {
    price: number;
    formedIndex: number;
    formedTime: number;
}

interface LiquidityLevel {
    price: number;
    taken: boolean;
}

interface SweptState {
    phase: 'swept';
    sweepIndex: number;
    sweepTime: number;
    sweepExtreme: number;
    necklineIndex: number;
    necklineTime: number;
    neckline: number;
}

interface ShiftedState extends Omit<SweptState, 'phase'> {
    phase: 'shifted';
    shiftIndex: number;
    shiftTime: number;
}

interface GapState {
    phase: 'gap';
    setup: AwReversalSetup;
}

type SequenceState = SweptState | ShiftedState | GapState;

interface ScheduledLevel {
    side: 'high' | 'low';
    price: number;
}

interface AdvanceArgs {
    state: SequenceState | null;
    bars: readonly OHLCV[];
    index: number;
    atrValue: number | undefined;
    displacementAtr: number;
    maxSweepToShift: number;
    fvgSearchWindow: number;
    maxShiftToEntry: number;
    allowed: boolean;
    liquidity: readonly LiquidityLevel[];
    formations: AwReversalSetup[];
    referenceEntries: AwReversalSetup[];
}

/** Detect formations and reference-style entry triggers, in bar order. */
export function detectAwReversals(
    bars: readonly OHLCV[],
    opts: AwReversalOptions = {},
): AwReversalDetection {
    if (bars.length < 2) return { formations: [], referenceEntries: [], nextSessionAllowed: [] };

    const swingLength = opts.swingLength ?? AW_REVERSAL_DEFAULTS.swingLength;
    const maxLiquidity = opts.maxLiquidity ?? AW_REVERSAL_DEFAULTS.maxLiquidity;
    const useHtfLiquidity = opts.useHtfLiquidity ?? AW_REVERSAL_DEFAULTS.useHtfLiquidity;
    const htfMode = opts.htfMode ?? AW_REVERSAL_DEFAULTS.htfMode;
    const manualHtfMinutes = opts.htfMinutes ?? AW_REVERSAL_DEFAULTS.htfMinutes;
    const htfPivotStrength = opts.htfPivotStrength ?? AW_REVERSAL_DEFAULTS.htfPivotStrength;
    const usePreviousDay = opts.usePreviousDay ?? AW_REVERSAL_DEFAULTS.usePreviousDay;
    const atrLength = opts.atrLength ?? AW_REVERSAL_DEFAULTS.atrLength;
    const displacementAtr = opts.displacementAtr ?? AW_REVERSAL_DEFAULTS.displacementAtr;
    const maxSweepToShift = opts.maxSweepToShift ?? AW_REVERSAL_DEFAULTS.maxSweepToShift;
    const fvgSearchWindow = opts.fvgSearchWindow ?? AW_REVERSAL_DEFAULTS.fvgSearchWindow;
    const maxShiftToEntry = opts.maxShiftToEntry ?? AW_REVERSAL_DEFAULTS.maxShiftToEntry;
    const sessions = opts.sessions ?? AW_REVERSAL_DEFAULTS.sessions;
    const zone = opts.zone ?? AW_REVERSAL_DEFAULTS.zone;

    checkOptions({
        swingLength,
        maxLiquidity,
        htfMode,
        manualHtfMinutes,
        htfPivotStrength,
        atrLength,
        displacementAtr,
        maxSweepToShift,
        fvgSearchWindow,
        maxShiftToEntry,
        sessions,
    });

    const clock = readBarClock(bars, zone);
    const sessionAllowed = clock.openMinutes.map((minutes) => inEnabledSession(minutes, sessions));
    const nextSessionAllowed = clock.closeMinutes.map((minutes) => Number(inEnabledSession(minutes, sessions)));
    const atrValues = atr(bars, atrLength);
    const executionMinutes = clock.stepMs / MINUTE;
    const currentSwings = scheduleCurrentSwings(bars, swingLength);
    const scheduledTargets = new Map<number, ScheduledLevel[]>();

    if (useHtfLiquidity) {
        const htfMinutes = htfMode === 'auto' ? autoHtfMinutes(executionMinutes) : manualHtfMinutes;
        if (!(htfMinutes > executionMinutes)) {
            throw new Error(
                `detectAwReversals: higher timeframe (${htfMinutes}m) must be above `
                + `the execution timeframe (${executionMinutes}m)`,
            );
        }
        scheduleHtfSwings(bars, htfMinutes, htfPivotStrength, zone, scheduledTargets);
    }
    if (usePreviousDay) schedulePreviousDayLevels(bars, clock.days, scheduledTargets);

    const highLiquidity: LiquidityLevel[] = [];
    const lowLiquidity: LiquidityLevel[] = [];
    const formations: AwReversalSetup[] = [];
    const referenceEntries: AwReversalSetup[] = [];
    let lastHigh: Pivot | null = null;
    let lastLow: Pivot | null = null;
    let bull: SequenceState | null = null;
    let bear: SequenceState | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        for (const swing of currentSwings.get(i) ?? []) {
            const pivot = { price: swing.price, formedIndex: swing.formedIndex, formedTime: swing.formedTime };
            if (swing.side === 'high') {
                lastHigh = pivot;
                pushLiquidity(highLiquidity, swing.price, maxLiquidity);
            } else {
                lastLow = pivot;
                pushLiquidity(lowLiquidity, swing.price, maxLiquidity);
            }
        }
        for (const level of scheduledTargets.get(i) ?? []) {
            pushLiquidity(level.side === 'high' ? highLiquidity : lowLiquidity, level.price, maxLiquidity);
        }

        markTaken(highLiquidity, (price) => bar.high > price);
        markTaken(lowLiquidity, (price) => bar.low < price);

        if (bull === null && lastLow && lastHigh
            && i > lastLow.formedIndex && bar.low < lastLow.price && bar.close > lastLow.price) {
            bull = swept('bull', i, bar, lastHigh);
        }
        if (bear === null && lastHigh && lastLow
            && i > lastHigh.formedIndex && bar.high > lastHigh.price && bar.close < lastHigh.price) {
            bear = swept('bear', i, bar, lastLow);
        }

        const common = {
            bars,
            index: i,
            atrValue: atrValues[i],
            displacementAtr,
            maxSweepToShift,
            fvgSearchWindow,
            maxShiftToEntry,
            allowed: sessionAllowed[i]!,
            formations,
            referenceEntries,
        };
        bull = advanceBull({ ...common, state: bull, liquidity: highLiquidity });
        bear = advanceBear({ ...common, state: bear, liquidity: lowLiquidity });
    }

    formations.sort((a, b) => a.index - b.index);
    referenceEntries.sort((a, b) => a.index - b.index);
    return { formations, referenceEntries, nextSessionAllowed };
}

function swept(direction: AwDirection, index: number, bar: OHLCV, neckline: Pivot): SweptState {
    return {
        phase: 'swept',
        sweepIndex: index,
        sweepTime: bar.time,
        sweepExtreme: direction === 'bull' ? bar.low : bar.high,
        necklineIndex: neckline.formedIndex,
        necklineTime: neckline.formedTime,
        neckline: neckline.price,
    };
}

function advanceBull(args: AdvanceArgs): SequenceState | null {
    let state = args.state;
    if (state === null) return null;
    const bar = args.bars[args.index]!;

    if (state.phase === 'swept') {
        if (args.index - state.sweepIndex > args.maxSweepToShift) return null;
        const body = bar.close - bar.open;
        if (Number.isFinite(args.atrValue) && bar.close > state.neckline && bar.close > bar.open
            && body >= args.atrValue! * args.displacementAtr) {
            state = { ...state, phase: 'shifted', shiftIndex: args.index, shiftTime: bar.time };
        }
    }
    if (state.phase === 'shifted') {
        if (args.index - state.shiftIndex > args.fvgSearchWindow + 2) return null;
        if (args.index >= 2 && bar.low > args.bars[args.index - 2]!.high) {
            const setup = formationOf(
                'bull', state, bar.low, args.bars[args.index - 2]!.high,
                args.index, bar.time, args.maxShiftToEntry, nearestAbove(args.liquidity, bar.close),
            );
            args.formations.push(setup);
            state = { phase: 'gap', setup };
        }
    }
    if (state.phase === 'gap') {
        const setup = state.setup;
        if (args.index - setup.formationIndex > args.maxShiftToEntry || bar.close < setup.stop) return null;
        if (args.allowed && bar.low <= setup.fvgTop) {
            args.referenceEntries.push({
                ...setup,
                liquidityTarget: nearestAbove(args.liquidity, bar.close),
                index: args.index,
                time: bar.time,
            });
            return null;
        }
    }
    return state;
}

function advanceBear(args: AdvanceArgs): SequenceState | null {
    let state = args.state;
    if (state === null) return null;
    const bar = args.bars[args.index]!;

    if (state.phase === 'swept') {
        if (args.index - state.sweepIndex > args.maxSweepToShift) return null;
        const body = bar.open - bar.close;
        if (Number.isFinite(args.atrValue) && bar.close < state.neckline && bar.close < bar.open
            && body >= args.atrValue! * args.displacementAtr) {
            state = { ...state, phase: 'shifted', shiftIndex: args.index, shiftTime: bar.time };
        }
    }
    if (state.phase === 'shifted') {
        if (args.index - state.shiftIndex > args.fvgSearchWindow + 2) return null;
        if (args.index >= 2 && bar.high < args.bars[args.index - 2]!.low) {
            const setup = formationOf(
                'bear', state, args.bars[args.index - 2]!.low, bar.high,
                args.index, bar.time, args.maxShiftToEntry, nearestBelow(args.liquidity, bar.close),
            );
            args.formations.push(setup);
            state = { phase: 'gap', setup };
        }
    }
    if (state.phase === 'gap') {
        const setup = state.setup;
        if (args.index - setup.formationIndex > args.maxShiftToEntry || bar.close > setup.stop) return null;
        if (args.allowed && bar.high >= setup.fvgBottom) {
            args.referenceEntries.push({
                ...setup,
                liquidityTarget: nearestBelow(args.liquidity, bar.close),
                index: args.index,
                time: bar.time,
            });
            return null;
        }
    }
    return state;
}

function formationOf(
    direction: AwDirection,
    state: ShiftedState,
    fvgTop: number,
    fvgBottom: number,
    index: number,
    time: number,
    maxShiftToEntry: number,
    liquidityTarget: number | null,
): AwReversalSetup {
    return {
        direction,
        sweepIndex: state.sweepIndex,
        sweepTime: state.sweepTime,
        sweepExtreme: state.sweepExtreme,
        necklineIndex: state.necklineIndex,
        necklineTime: state.necklineTime,
        neckline: state.neckline,
        shiftIndex: state.shiftIndex,
        shiftTime: state.shiftTime,
        fvgTop,
        fvgBottom,
        formationIndex: index,
        formationTime: time,
        expiryIndex: index + maxShiftToEntry,
        entryPrice: direction === 'bull' ? fvgTop : fvgBottom,
        stop: state.sweepExtreme,
        liquidityTarget,
        index,
        time,
    };
}

function scheduleCurrentSwings(
    bars: readonly OHLCV[],
    strength: number,
): Map<number, ReturnType<typeof findSwings>> {
    const scheduled = new Map<number, ReturnType<typeof findSwings>>();
    for (const swing of findSwings(bars, strength)) {
        const at = scheduled.get(swing.knownIndex) ?? [];
        at.push(swing);
        scheduled.set(swing.knownIndex, at);
    }
    return scheduled;
}

function scheduleHtfSwings(
    bars: readonly OHLCV[],
    minutes: number,
    strength: number,
    zone: string,
    scheduled: Map<number, ScheduledLevel[]>,
): void {
    const aggregate = aggregateInZone(bars, minutes, zone);
    for (const swing of findSwings(aggregate.bars, strength)) {
        /* The last aggregate in a prefix is still forming. Waiting for the next bucket keeps
         * this mapping stable when that prefix later receives more execution bars. */
        if (swing.knownIndex >= aggregate.bars.length - 1) continue;
        const sourceIndex = aggregate.sourceEnd[swing.knownIndex];
        if (sourceIndex != null) addScheduled(scheduled, sourceIndex, { side: swing.side, price: swing.price });
    }
}

function schedulePreviousDayLevels(
    bars: readonly OHLCV[],
    days: readonly string[],
    scheduled: Map<number, ScheduledLevel[]>,
): void {
    let day = days[0]!;
    let high = bars[0]!.high;
    let low = bars[0]!.low;

    for (let i = 1; i < bars.length; i += 1) {
        if (days[i] === day) {
            high = Math.max(high, bars[i]!.high);
            low = Math.min(low, bars[i]!.low);
            continue;
        }
        addScheduled(scheduled, i, { side: 'high', price: high });
        addScheduled(scheduled, i, { side: 'low', price: low });
        day = days[i]!;
        high = bars[i]!.high;
        low = bars[i]!.low;
    }
}

function aggregateInZone(
    bars: readonly OHLCV[],
    minutes: number,
    zone: string,
): { bars: OHLCV[]; sourceEnd: number[] } {
    const out: OHLCV[] = [];
    const sourceEnd: number[] = [];
    let activeBucket: number | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const reading = localReading(bar.time, zone);
        const [year, month, day] = reading.day.split('-').map(Number) as [number, number, number];
        const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
        const absoluteMinute = dayNumber * DAY_MINUTES + reading.minutes;
        /* 1970-01-01 was Thursday. Adding three days makes seven-day buckets start Monday;
         * every shorter interval stays aligned to local midnight. */
        const aligned = minutes === WEEK_MINUTES ? absoluteMinute + 3 * DAY_MINUTES : absoluteMinute;
        const bucket = Math.floor(aligned / minutes);

        if (bucket !== activeBucket) {
            out.push({ ...bar });
            sourceEnd.push(i);
            activeBucket = bucket;
            continue;
        }
        const current = out[out.length - 1]!;
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
        if (bar.volume != null) current.volume = (current.volume ?? 0) + bar.volume;
        sourceEnd[sourceEnd.length - 1] = i;
    }
    return { bars: out, sourceEnd };
}

function autoHtfMinutes(executionMinutes: number): number {
    if (executionMinutes <= 1) return 15;
    if (executionMinutes <= 3) return 30;
    if (executionMinutes <= 5) return 60;
    if (executionMinutes <= 15) return 240;
    if (executionMinutes <= 30) return 360;
    if (executionMinutes <= 180) return DAY_MINUTES;
    return WEEK_MINUTES;
}

function inEnabledSession(minutes: number, sessions: readonly AwSession[]): boolean {
    return (sessions.includes('asia') && (minutes >= 20 * 60 || minutes < 2 * 60))
        || (sessions.includes('london') && minutes >= 2 * 60 && minutes < 8 * 60)
        || (sessions.includes('nyam') && minutes >= 8 * 60 && minutes < 12 * 60)
        || (sessions.includes('nypm') && minutes >= 12 * 60 && minutes < 16 * 60);
}

function pushLiquidity(levels: LiquidityLevel[], price: number, max: number): void {
    levels.push({ price, taken: false });
    if (levels.length > max) levels.shift();
}

function markTaken(levels: LiquidityLevel[], reached: (price: number) => boolean): void {
    for (const level of levels) {
        if (!level.taken && reached(level.price)) level.taken = true;
    }
}

function nearestAbove(levels: readonly LiquidityLevel[], price: number): number | null {
    let nearest: number | null = null;
    for (const level of levels) {
        if (level.taken || level.price <= price) continue;
        if (nearest == null || level.price < nearest) nearest = level.price;
    }
    return nearest;
}

function nearestBelow(levels: readonly LiquidityLevel[], price: number): number | null {
    let nearest: number | null = null;
    for (const level of levels) {
        if (level.taken || level.price >= price) continue;
        if (nearest == null || level.price > nearest) nearest = level.price;
    }
    return nearest;
}

function addScheduled(
    scheduled: Map<number, ScheduledLevel[]>,
    index: number,
    level: ScheduledLevel,
): void {
    const at = scheduled.get(index) ?? [];
    at.push(level);
    scheduled.set(index, at);
}

function checkOptions(options: {
    swingLength: number;
    maxLiquidity: number;
    htfMode: AwHtfMode;
    manualHtfMinutes: number;
    htfPivotStrength: number;
    atrLength: number;
    displacementAtr: number;
    maxSweepToShift: number;
    fvgSearchWindow: number;
    maxShiftToEntry: number;
    sessions: readonly AwSession[];
}): void {
    const positiveInteger = (name: string, value: number, minimum = 1): void => {
        if (!Number.isInteger(value) || value < minimum) {
            throw new Error(`detectAwReversals: ${name} must be an integer >= ${minimum}, got ${value}`);
        }
    };
    positiveInteger('swingLength', options.swingLength, 2);
    positiveInteger('maxLiquidity', options.maxLiquidity);
    positiveInteger('htfMinutes', options.manualHtfMinutes);
    positiveInteger('htfPivotStrength', options.htfPivotStrength);
    positiveInteger('atrLength', options.atrLength);
    positiveInteger('maxSweepToShift', options.maxSweepToShift);
    positiveInteger('fvgSearchWindow', options.fvgSearchWindow, 0);
    positiveInteger('maxShiftToEntry', options.maxShiftToEntry);
    if (!(options.displacementAtr > 0)) {
        throw new Error(`detectAwReversals: displacementAtr must be positive, got ${options.displacementAtr}`);
    }
    if (options.htfMode !== 'auto' && options.htfMode !== 'manual') {
        throw new Error(`detectAwReversals: unknown htfMode "${String(options.htfMode)}"`);
    }
    for (const session of options.sessions) {
        if (!SESSION_IDS.includes(session)) {
            throw new Error(`detectAwReversals: unknown session "${String(session)}"`);
        }
    }
}
