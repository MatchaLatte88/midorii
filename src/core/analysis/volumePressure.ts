import type { OHLCV } from '../model/ohlcv';

/** One bar's provider-neutral estimate of where its volume pressed inside its own range. */
export interface VolumePressureReading {
    /** Closing-location bias: -1 at the low, 0 at the middle, +1 at the high. */
    bias: number;
    /** Reported volume. Zero is valid; missing volume produces no reading. */
    volume: number;
    /** Volume signed by {@link bias}. */
    signedVolume: number;
}

/** A range's volume pressure, normalized so -1 is wholly bearish and +1 wholly bullish. */
export interface VolumePressureSummary {
    score: number;
    averageVolume: number;
    bars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Estimate a bar's pressure from information every Midorii provider already supplies.
 *
 * The close's location inside the high-low range is the observable fact: a close at the high
 * assigns the whole bar's volume upward, one at the low assigns it downward, and one at the
 * middle is balanced. A flat bar falls back to its body, then to the previous close. This is an
 * estimate of pressure, not aggressor-side trade volume, and is deliberately named as such.
 */
export function volumePressureOfBar(bar: OHLCV, previous?: OHLCV): VolumePressureReading | null {
    if (bar.volume == null || !Number.isFinite(bar.volume) || bar.volume < 0) return null;

    let bias = 0;
    const span = bar.high - bar.low;
    if (Number.isFinite(span) && span > 0) {
        bias = ((bar.close - bar.low) - (bar.high - bar.close)) / span;
    } else if (bar.close !== bar.open) {
        bias = bar.close > bar.open ? 1 : -1;
    } else if (previous && bar.close !== previous.close) {
        bias = bar.close > previous.close ? 1 : -1;
    }
    bias = clamp(bias, -1, 1);
    return { bias, volume: bar.volume, signedVolume: bar.volume * bias };
}

/**
 * Summarize a stretch with a mild recency weight: the newest bar counts fully and each older
 * one counts `decay` as much as the bar after it. Dividing signed volume by total volume keeps
 * the result comparable across symbols and timeframes.
 */
export function summarizeVolumePressure(
    bars: readonly OHLCV[],
    from: number,
    to: number,
    decay = 0.94,
): VolumePressureSummary | null {
    const start = Math.max(0, Math.ceil(from));
    const end = Math.min(bars.length - 1, Math.floor(to));
    if (end < start) return null;
    if (!(decay > 0 && decay <= 1)) throw new Error(`summarizeVolumePressure: decay must be in (0, 1], got ${decay}`);

    let weightedSigned = 0;
    let weightedVolume = 0;
    let volumeTotal = 0;
    let count = 0;
    let weight = 1;

    for (let i = end; i >= start; i -= 1) {
        const reading = volumePressureOfBar(bars[i]!, i > 0 ? bars[i - 1] : undefined);
        if (reading) {
            weightedSigned += reading.signedVolume * weight;
            weightedVolume += reading.volume * weight;
            volumeTotal += reading.volume;
            count += 1;
        }
        weight *= decay;
    }

    if (count === 0 || !(weightedVolume > 0)) return null;
    return {
        score: clamp(weightedSigned / weightedVolume, -1, 1),
        averageVolume: volumeTotal / count,
        bars: count,
    };
}
