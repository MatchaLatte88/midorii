import type { OHLCV } from '../model/ohlcv';
import { atr, highest, highs, lowest, lows, stdev, wma } from '../native-indicators/classics/math';

export const SENTIMENT_PROFILE_BINS = 20;
export const SENTIMENT_PROFILE_SCALE = 16;

export type SentimentBreakDirection = 'up' | 'down';

export interface SentimentProfileBin {
    bottom: number;
    top: number;
    volume: number;
    signedVolume: number;
}

export interface VolumeSentimentProfile {
    bins: SentimentProfileBin[];
    maxVolume: number;
    maxAbsSignedVolume: number;
    signedVolume: number;
    currentBin: number | null;
    currentSentiment: number | null;
    overallSentiment: 'bullish' | 'bearish';
}

export interface VolumeSentimentChannel {
    startIndex: number;
    formedIndex: number;
    endIndex: number;
    top: number;
    bottom: number;
    middle: number;
    /** Half of ATR at formation, matching the two highlighted edge zones. */
    zoneSize: number;
    active: boolean;
    breakIndex: number | null;
    breakDirection: SentimentBreakDirection | null;
    profile: VolumeSentimentProfile;
}

export interface VolumeSentimentAnalysis {
    channels: VolumeSentimentChannel[];
    channelFormed: boolean[];
    bullishBreak: boolean[];
    bearishBreak: boolean[];
    bullishTrend: number[];
    bearishTrend: number[];
}

export interface VolumeSentimentOptions {
    /** Rolling high/low window used to normalize close. Default 100. */
    normalizationLength?: number;
    /** WMA, ATR and channel-regime length. Default 14. */
    channelLength?: number;
    /** Compare the candle midpoint with an edge instead of its close. Default true. */
    strongClosesOnly?: boolean;
}

export const VOLUME_SENTIMENT_DEFAULTS = {
    normalizationLength: 100,
    channelLength: 14,
    strongClosesOnly: true,
} as const;

function finiteVolume(bar: OHLCV): number | null {
    return bar.volume != null && Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : null;
}

function crossover(a: readonly number[], b: readonly number[], index: number): boolean {
    if (index < 1) return false;
    const nowA = a[index]!;
    const nowB = b[index]!;
    const prevA = a[index - 1]!;
    const prevB = b[index - 1]!;
    return Number.isFinite(nowA) && Number.isFinite(nowB)
        && Number.isFinite(prevA) && Number.isFinite(prevB)
        && nowA > nowB && prevA <= prevB;
}

function valueCrossover(a: readonly number[], b: readonly number[], index: number): boolean {
    return crossover(a, b, index);
}

function valueCrossunder(a: readonly number[], b: readonly number[], index: number): boolean {
    return crossover(b, a, index);
}

function average(values: readonly number[], end: number, length: number): number {
    const start = end - length + 1;
    if (start < 0 || length < 1) return Number.NaN;
    let sum = 0;
    for (let i = start; i <= end; i += 1) {
        const value = values[i]!;
        if (!Number.isFinite(value)) return Number.NaN;
        sum += value;
    }
    return sum / length;
}

function emptyProfile(): VolumeSentimentProfile {
    return {
        bins: [],
        maxVolume: 0,
        maxAbsSignedVolume: 0,
        signedVolume: 0,
        currentBin: null,
        currentSentiment: null,
        overallSentiment: 'bearish',
    };
}

/**
 * Build the price-by-volume profile used on both sides of a channel.
 *
 * A candle contributes its whole volume to every price bin its high-low range touches. The sign
 * comes only from candle direction. This deliberately describes candle sentiment rather than
 * claiming trade-side order flow that an OHLCV feed does not contain.
 */
export function buildVolumeSentimentProfile(
    bars: readonly OHLCV[],
    startIndex: number,
    endIndex: number,
    bottom: number,
    top: number,
    bins = SENTIMENT_PROFILE_BINS,
): VolumeSentimentProfile {
    if (!(bins >= 1) || !(top > bottom) || bars.length === 0) return emptyProfile();
    const start = Math.max(0, Math.ceil(startIndex));
    const end = Math.min(bars.length - 1, Math.floor(endIndex));
    if (end < start) return emptyProfile();

    const step = (top - bottom) / bins;
    const profileBins: SentimentProfileBin[] = [];
    let maxVolume = 0;
    let maxAbsSignedVolume = 0;
    let signedVolume = 0;

    for (let bin = 0; bin < bins; bin += 1) {
        const binBottom = bottom + bin * step;
        const binTop = bottom + (bin + 1) * step;
        let volume = 0;
        let signed = 0;
        for (let i = start; i <= end; i += 1) {
            const bar = bars[i]!;
            if (bar.low > binTop || bar.high < binBottom) continue;
            const amount = finiteVolume(bar);
            if (amount == null) continue;
            volume += amount;
            signed += amount * (bar.close > bar.open ? 1 : -1);
        }
        profileBins.push({ bottom: binBottom, top: binTop, volume, signedVolume: signed });
        maxVolume = Math.max(maxVolume, volume);
        maxAbsSignedVolume = Math.max(maxAbsSignedVolume, Math.abs(signed));
        signedVolume += signed;
    }

    const close = bars[end]!.close;
    let currentBin: number | null = null;
    for (let i = 0; i < profileBins.length; i += 1) {
        const bin = profileBins[i]!;
        if (close >= bin.bottom && close <= bin.top) {
            currentBin = i;
            break;
        }
    }
    const currentSigned = currentBin == null ? null : profileBins[currentBin]!.signedVolume;
    const currentSentiment = currentSigned == null || maxAbsSignedVolume === 0
        ? null
        : currentSigned / maxAbsSignedVolume;

    return {
        bins: profileBins,
        maxVolume,
        maxAbsSignedVolume,
        signedVolume,
        currentBin,
        currentSentiment,
        overallSentiment: signedVolume > 0 ? 'bullish' : 'bearish',
    };
}

function canCreate(active: readonly VolumeSentimentChannel[], top: number, bottom: number): boolean {
    return active.every((channel) => !(top > channel.bottom && bottom < channel.top));
}

function dynamicTrend(
    values: readonly number[],
    index: number,
    lastBreak: number,
): number {
    const barsSince = lastBreak < 0 ? 0 : index - lastBreak;
    return average(values, index, Math.max(barsSince, 1));
}

/**
 * Detect volatility-regime channels, their breakouts and the expanding post-break trends.
 *
 * Close is first normalized inside its rolling price range. A quiet regime starts when the
 * weighted baseline rises above normalized-price volatility. When volatility crosses back above
 * that baseline after more than ten bars, the intervening high-low range becomes a channel.
 */
export function detectVolumeSentimentChannels(
    bars: readonly OHLCV[],
    options: VolumeSentimentOptions = {},
): VolumeSentimentAnalysis {
    const normalizationLength = options.normalizationLength ?? VOLUME_SENTIMENT_DEFAULTS.normalizationLength;
    const channelLength = options.channelLength ?? VOLUME_SENTIMENT_DEFAULTS.channelLength;
    const strongClosesOnly = options.strongClosesOnly ?? VOLUME_SENTIMENT_DEFAULTS.strongClosesOnly;
    if (!(normalizationLength >= 1)) {
        throw new Error(`detectVolumeSentimentChannels: normalizationLength must be >= 1, got ${normalizationLength}`);
    }
    if (!(channelLength >= 1)) {
        throw new Error(`detectVolumeSentimentChannels: channelLength must be >= 1, got ${channelLength}`);
    }

    const size = bars.length;
    const channelFormed = new Array<boolean>(size).fill(false);
    const bullishBreak = new Array<boolean>(size).fill(false);
    const bearishBreak = new Array<boolean>(size).fill(false);
    const bullishTrend = new Array<number>(size).fill(Number.NaN);
    const bearishTrend = new Array<number>(size).fill(Number.NaN);
    if (size === 0) return { channels: [], channelFormed, bullishBreak, bearishBreak, bullishTrend, bearishTrend };

    const highValues = highs(bars);
    const lowValues = lows(bars);
    const rollingHigh = highest(highValues, normalizationLength);
    const rollingLow = lowest(lowValues, normalizationLength);
    const normalized = bars.map((bar, i) => {
        const top = rollingHigh[i]!;
        const bottom = rollingLow[i]!;
        const span = top - bottom;
        return Number.isFinite(span) && span > 0 ? (bar.close - bottom) / span : Number.NaN;
    });
    const volatility = stdev(normalized, 14);
    const baseline = wma(volatility, channelLength);
    const ranges = atr(bars, channelLength);
    const channels: VolumeSentimentChannel[] = [];
    const active: VolumeSentimentChannel[] = [];

    let quietCross = -1;
    let lastBullishBreak = -1;
    let lastBearishBreak = -1;
    let bullishActive = false;
    let bearishActive = false;
    const bullishRaw = new Array<number>(size).fill(Number.NaN);
    const bearishRaw = new Array<number>(size).fill(Number.NaN);
    const closeValues = bars.map((bar) => bar.close);

    for (let i = 0; i < size; i += 1) {
        if (crossover(baseline, volatility, i)) quietCross = i;
        const duration = Math.max(quietCross < 0 ? 0 : i - quietCross, 1);

        if (crossover(volatility, baseline, i) && duration > 10) {
            const rangeStart = Math.max(0, i - duration + 1);
            let top = -Infinity;
            let bottom = Infinity;
            for (let j = rangeStart; j <= i; j += 1) {
                top = Math.max(top, bars[j]!.high);
                bottom = Math.min(bottom, bars[j]!.low);
            }
            if (top > bottom && canCreate(active, top, bottom)) {
                const channel: VolumeSentimentChannel = {
                    // The visual/profile window includes the bar immediately before the high-low fold.
                    startIndex: Math.max(0, i - duration),
                    formedIndex: i,
                    endIndex: i,
                    top,
                    bottom,
                    middle: (top + bottom) / 2,
                    zoneSize: Number.isFinite(ranges[i]!) ? ranges[i]! / 2 : 0,
                    active: true,
                    breakIndex: null,
                    breakDirection: null,
                    profile: emptyProfile(),
                };
                channels.push(channel);
                active.push(channel);
                channelFormed[i] = true;
            }
        }

        const compare = strongClosesOnly ? (bars[i]!.open + bars[i]!.close) / 2 : bars[i]!.close;
        for (let j = active.length - 1; j >= 0; j -= 1) {
            const channel = active[j]!;
            if (compare > channel.top || compare < channel.bottom) {
                const up = compare > channel.top;
                channel.active = false;
                channel.endIndex = Math.max(channel.formedIndex, i - 1);
                channel.breakIndex = i;
                channel.breakDirection = up ? 'up' : 'down';
                if (up) bullishBreak[i] = true;
                else bearishBreak[i] = true;
                active.splice(j, 1);
            } else {
                channel.endIndex = i;
            }
        }

        if (bullishBreak[i]) {
            lastBullishBreak = i;
            bullishActive = true;
        }
        if (bearishBreak[i]) {
            lastBearishBreak = i;
            bearishActive = true;
        }
        bullishRaw[i] = dynamicTrend(lowValues, i, lastBullishBreak);
        bearishRaw[i] = dynamicTrend(highValues, i, lastBearishBreak);
        if (bullishActive && valueCrossunder(closeValues, bullishRaw, i)) bullishActive = false;
        if (bearishActive && valueCrossover(closeValues, bearishRaw, i)) bearishActive = false;
        if (bullishActive) bullishTrend[i] = bullishRaw[i]!;
        if (bearishActive) bearishTrend[i] = bearishRaw[i]!;
    }

    for (const channel of channels) {
        channel.profile = buildVolumeSentimentProfile(
            bars,
            channel.startIndex,
            channel.endIndex,
            channel.bottom,
            channel.top,
        );
    }

    return { channels, channelFormed, bullishBreak, bearishBreak, bullishTrend, bearishTrend };
}
