import type { OHLCV } from '../model/ohlcv';
import { atr, closes, ema } from '../native-indicators/classics/math';
import { closeInWindow, readBarClock, type BarClock } from './barClock';

/**
 * Saty's Phase Oscillator, and the ±100 crossings a strategy trades off it.
 *
 * What the oscillator is
 * ----------------------
 * How far price has run from its own mean, measured in the volatility it has been running
 * through:
 *
 *     100 × (close − EMA(close, 21)) ÷ (3 × ATR(14)), smoothed by EMA(3)
 *
 * The 3 × ATR in the denominator is what sets the scale: a reading of 100 means price sits
 * three average ranges above its 21-bar mean, which is the "extended" the indicator was
 * built to mark. Crossing that level is read as a move committing to itself rather than as
 * something to fade — the strategy that trades it buys the upside cross.
 *
 * Both averages run on the same bars as the oscillator. That is worth saying because the
 * other Saty indicator in the same family — the ATR levels — uses a DAILY ATR against a
 * daily close, and the two are easy to conflate. Here everything is the chart's own
 * timeframe, with no higher one involved.
 *
 * Warm-up is Wilder's and Pine's: both the EMA and the RMA inside the ATR seed from a simple
 * average of their first `len` values, so the series only begins once there are enough bars
 * for both — see `classics/math.ts`. Bars before that carry NaN and can produce no crossing.
 *
 * What counts as a crossing
 * -------------------------
 * A completed bar whose oscillator moved from at-or-below +100 to above it, or from
 * at-or-above −100 to below it. Two things follow from stating it that way:
 *
 *   - Only completed bars count. The crossing is attached to the bar that finished the move,
 *     and `index` is that bar, so a strategy acting on it is acting at its close or later.
 *   - A bar that merely stays beyond the level is not a crossing. The level has to be
 *     traversed, so one extended stretch of market fires once, not on every bar of it.
 *
 * Crossings are reported wherever they happen, all day, and marked with whether they fell
 * inside the entry window. The exit rule needs the ones outside it — a position opened at
 * 09:20 is closed by the opposite cross at 13:40, which is not a signal to enter anything
 * but is very much a signal to get out — so filtering them here would throw away half of
 * what the strategy reads.
 */

/** Clocks are minutes past local midnight, read in `zone`. */
export interface PhaseOscillatorOptions {
    /** Length of the EMA the distance is measured from. */
    emaLength: number;
    /** Length of the Wilder ATR the distance is measured in. */
    atrLength: number;
    /** How many ATRs the ±100 reading corresponds to. */
    atrMultiple: number;
    /** Length of the EMA that smooths the finished oscillator. */
    smoothing: number;
    /** The level whose crossing is the signal, plus and minus. */
    level: number;
    /** Earliest bar CLOSE that may fire an entry. */
    fromMin: number;
    /** Latest bar close that may fire one. */
    toMin: number;
    /** IANA zone the clocks above are read in. */
    zone: string;
}

/**
 * Saty's published settings, and the Central-Time morning window the measured version of the
 * strategy fires in. The window is stated in bar closes: the first ticket is one minute after
 * the 08:40 close, and the 10:00 close is the last bar that can fire one.
 */
export const PHASE_OSCILLATOR_DEFAULTS: PhaseOscillatorOptions = {
    emaLength: 21,
    atrLength: 14,
    atrMultiple: 3,
    smoothing: 3,
    level: 100,
    fromMin: 8 * 60 + 40,
    toMin: 10 * 60,
    zone: 'America/Chicago',
};

/** One ±level crossing on a completed bar. */
export interface PhaseOscillatorCross {
    /** The bar that completed the crossing — the first bar it could be acted on from. */
    index: number;
    /** Up through +level is long, down through −level is short. */
    direction: 'long' | 'short';
    /** The oscillator reading that crossed. */
    value: number;
    /** Local day of the bar, for one-per-session bookkeeping. */
    day: string;
    /** Whether the bar's CLOSE fell inside the entry window. False ones are exit-only. */
    inEntryWindow: boolean;
}

export interface PhaseOscillatorDetection {
    /** The oscillator itself, one value per bar; NaN until both averages have warmed up. */
    oscillator: number[];
    crosses: PhaseOscillatorCross[];
    clock: BarClock;
}

/** The oscillator series on its own, for a chart that wants to draw what a run traded. */
export function computePhaseOscillator(
    bars: readonly OHLCV[],
    options: Pick<PhaseOscillatorOptions, 'emaLength' | 'atrLength' | 'atrMultiple' | 'smoothing'>,
): number[] {
    const { emaLength, atrLength, atrMultiple, smoothing } = options;
    const mean = ema(closes(bars), emaLength);
    const range = atr(bars, atrLength);

    const raw = new Array<number>(bars.length).fill(Number.NaN);
    for (let i = 0; i < bars.length; i += 1) {
        const m = mean[i]!;
        const r = range[i]!;
        /* A zero ATR is a stretch of market that did not move at all. The distance from the
         * mean is then either zero or undefined, and neither is a reading — dividing would
         * put an Infinity into the series that every later smoothed value inherits. */
        if (!Number.isFinite(m) || !Number.isFinite(r) || r <= 0) continue;
        raw[i] = (100 * (bars[i]!.close - m)) / (atrMultiple * r);
    }

    return ema(raw, smoothing);
}

export function detectPhaseOscillator(
    bars: readonly OHLCV[],
    options: PhaseOscillatorOptions = PHASE_OSCILLATOR_DEFAULTS,
): PhaseOscillatorDetection {
    if (bars.length < 2) {
        throw new Error('detectPhaseOscillator: at least two bars are needed');
    }

    const { level, fromMin, toMin, zone } = options;
    const oscillator = computePhaseOscillator(bars, options);
    const clock = readBarClock(bars, zone);
    const crosses: PhaseOscillatorCross[] = [];

    for (let i = 1; i < bars.length; i += 1) {
        const now = oscillator[i]!;
        const prev = oscillator[i - 1]!;
        // Still warming up, or a gap in the data broke the recursion: nothing was crossed.
        if (!Number.isFinite(now) || !Number.isFinite(prev)) continue;

        let direction: 'long' | 'short' | null = null;
        if (prev <= level && now > level) direction = 'long';
        else if (prev >= -level && now < -level) direction = 'short';
        if (direction === null) continue;

        crosses.push({
            index: i,
            direction,
            value: now,
            day: clock.days[i]!,
            inEntryWindow: closeInWindow(clock.closeMinutes[i]!, fromMin, toMin),
        });
    }

    return { oscillator, crosses, clock };
}
