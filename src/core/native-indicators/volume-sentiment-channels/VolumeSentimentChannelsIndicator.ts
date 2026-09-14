import type { DrawingBox, DrawingLabel, DrawingLine } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import type { SeriesSpec } from '../../model/series';
import type { Fill, FillGradientStop } from '../../model/scene';
import {
    SENTIMENT_PROFILE_SCALE,
    VOLUME_SENTIMENT_DEFAULTS,
    detectVolumeSentimentChannels,
    type VolumeSentimentAnalysis,
    type VolumeSentimentChannel,
} from '../../analysis/volumeSentimentChannels';
import { withAlpha } from '../../color';
import { NEUTRAL } from '../../palette';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

export const VOLUME_SENTIMENT_CHANNELS_INDICATOR_TYPE = 'volume-sentiment-channels';

const DEFAULTS = {
    ...VOLUME_SENTIMENT_DEFAULTS,
    bullColor: '#00ffbb', // palette-exempt: this study's user-editable supplied default
    bearColor: '#ff1100', // palette-exempt: this study's user-editable supplied default
} as const;

const MAX_DRAWN_CHANNELS = 20;
const PROFILE_RIGHT_OFFSET = 3;

function num(value: InputValue | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: InputValue | undefined, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function color(value: InputValue | undefined, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export interface VolumeSentimentViewOptions {
    bullColor: string;
    bearColor: string;
}

function box(id: string, left: number, right: number, top: number, bottom: number, options: {
    bgColor?: string;
    borderColor?: string;
    borderWidth?: number;
    text?: string;
    textColor?: string;
    hAlign?: 'left' | 'center' | 'right';
    vAlign?: 'top' | 'center' | 'bottom';
    fontFamily?: 'default' | 'monospace';
}): DrawingBox {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_index',
        overlay: true,
        left,
        right,
        top: Math.max(top, bottom),
        bottom: Math.min(top, bottom),
        extend: 'none',
        bgColor: options.bgColor,
        borderColor: options.borderColor,
        borderWidth: options.borderWidth ?? 0,
        borderStyle: 'solid',
        text: options.text,
        textColor: options.textColor,
        textSize: 'auto',
        hAlign: options.hAlign ?? 'center',
        vAlign: options.vAlign ?? 'center',
        wrap: false,
        fontFamily: options.fontFamily ?? 'default',
        bold: false,
        italic: false,
    };
}

function line(
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ink: string,
    width: number,
    style: 'solid' | 'dashed' | 'dotted',
): DrawingLine {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_index',
        overlay: true,
        x1,
        y1,
        x2,
        y2,
        extend: 'none',
        color: ink,
        invisible: false,
        width,
        style,
        arrowLeft: false,
        arrowRight: false,
    };
}

function profileColor(signedVolume: number, strength: number, view: VolumeSentimentViewOptions): string {
    const hue = signedVolume > 0 ? view.bullColor : view.bearColor;
    return withAlpha(hue, 0.1 + clamp(strength, 0, 1) * 0.9);
}

function textFor(channel: VolumeSentimentChannel): { current: string; overall: string } {
    const score = channel.profile.currentSentiment;
    const current = score == null
        ? 'Current Sentiment: —'
        : `Current Sentiment: ${score >= 0 ? '+' : ''}${Math.round(score * 100)}%`;
    const overall = `Overall Sentiment: ${channel.profile.overallSentiment === 'bullish' ? 'Bullish' : 'Bearish'}`;
    return { current, overall };
}

function addChannel(
    boxes: DrawingBox[],
    lines: DrawingLine[],
    channel: VolumeSentimentChannel,
    bars: readonly OHLCV[],
    view: VolumeSentimentViewOptions,
): void {
    const id = `sentiment_${channel.formedIndex}`;
    const width = Math.max(1, channel.endIndex - channel.startIndex);
    const sentimentLeft = channel.startIndex - width * 0.15;
    const zoneSize = Math.max(0, channel.zoneSize);
    const texts = textFor(channel);
    const close = bars[channel.endIndex]?.close ?? channel.middle;
    const currentAbove = close > channel.middle;

    boxes.push(box(`${id}_channel`, channel.startIndex, channel.endIndex, channel.top, channel.bottom, {
        bgColor: withAlpha(NEUTRAL, 0.1),
    }));
    boxes.push(box(`${id}_upper`, channel.startIndex, channel.endIndex, channel.top, channel.top - zoneSize, {
        bgColor: withAlpha(view.bearColor, 0.3),
        text: currentAbove ? texts.overall : texts.current,
        textColor: currentAbove
            ? undefined
            : channel.profile.currentSentiment != null && channel.profile.currentSentiment >= 0
                ? view.bullColor
                : view.bearColor,
    }));
    boxes.push(box(`${id}_lower`, channel.startIndex, channel.endIndex, channel.bottom + zoneSize, channel.bottom, {
        bgColor: withAlpha(view.bullColor, 0.3),
        text: currentAbove ? texts.current : texts.overall,
        textColor: currentAbove
            ? channel.profile.currentSentiment != null && channel.profile.currentSentiment >= 0
                ? view.bullColor
                : view.bearColor
            : undefined,
    }));

    lines.push(line(`${id}_center`, sentimentLeft, channel.middle, channel.endIndex, channel.middle, withAlpha(NEUTRAL, 0.5), 1, 'dashed'));
    lines.push(line(`${id}_upper_top`, sentimentLeft, channel.top, channel.endIndex, channel.top, view.bearColor, 2, 'solid'));
    lines.push(line(`${id}_upper_inner`, sentimentLeft, channel.top - zoneSize, channel.endIndex, channel.top - zoneSize, withAlpha(view.bearColor, 0.8), 1, 'dotted'));
    lines.push(line(`${id}_lower_inner`, sentimentLeft, channel.bottom + zoneSize, channel.endIndex, channel.bottom + zoneSize, withAlpha(view.bullColor, 0.8), 1, 'dotted'));
    lines.push(line(`${id}_lower_bottom`, sentimentLeft, channel.bottom, channel.endIndex, channel.bottom, view.bullColor, 2, 'solid'));

    const maxAbs = channel.profile.maxAbsSignedVolume;
    for (let i = 0; i < channel.profile.bins.length; i += 1) {
        const bin = channel.profile.bins[i]!;
        const strength = maxAbs > 0 ? Math.abs(bin.signedVolume) / maxAbs : 0;
        const ink = profileColor(bin.signedVolume, strength, view);
        boxes.push(box(`${id}_sentiment_${i}`, sentimentLeft, channel.startIndex, bin.top, bin.bottom, {
            bgColor: ink,
            borderColor: ink,
            borderWidth: 1,
            text: bin.volume > 0 ? `${Math.round(strength * 100)}%` : undefined,
            fontFamily: 'monospace',
        }));
    }

    if (!channel.active || channel.profile.maxVolume <= 0) return;
    const profileRight = channel.endIndex + PROFILE_RIGHT_OFFSET;
    for (let i = 0; i < channel.profile.bins.length; i += 1) {
        const bin = channel.profile.bins[i]!;
        if (!(bin.volume > 0)) continue;
        const strength = bin.volume / channel.profile.maxVolume;
        const profileWidth = strength * SENTIMENT_PROFILE_SCALE;
        const ink = profileColor(bin.signedVolume, strength, view);
        boxes.push(box(`${id}_live_profile_${i}`, profileRight - profileWidth, profileRight, bin.top, bin.bottom, {
            bgColor: ink,
            borderColor: ink,
            borderWidth: 1,
        }));
    }
}

function breakMarker(
    id: string,
    index: number,
    up: boolean,
    bars: readonly OHLCV[],
    view: VolumeSentimentViewOptions,
): DrawingLabel {
    let price = up ? Infinity : -Infinity;
    for (let i = Math.max(0, index - 2); i <= index; i += 1) {
        price = up ? Math.min(price, bars[i]!.low) : Math.max(price, bars[i]!.high);
    }
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        x: bars[index]!.time,
        y: price,
        yloc: 'price',
        style: up ? 'triangleup' : 'triangledown',
        color: up ? view.bullColor : view.bearColor,
        size: 'tiny',
        textAlign: 'center',
        fontFamily: 'default',
        tooltip: up ? 'Bullish channel break' : 'Bearish channel break',
    };
}

function trendSeries(
    analysis: VolumeSentimentAnalysis,
    bars: readonly OHLCV[],
    view: VolumeSentimentViewOptions,
): { series: SeriesSpec[]; fills: Fill[] } {
    const midpointId = 'volume-sentiment:midpoint';
    const bullishId = 'volume-sentiment:bullish-trend';
    const bearishId = 'volume-sentiment:bearish-trend';
    const midpoints = bars.map((bar) => ({ time: bar.time, value: (bar.open + bar.close) / 2 }));
    const bullishPoints = bars.map((bar, i) => ({
        time: bar.time,
        value: Number.isFinite(analysis.bullishTrend[i]!) ? analysis.bullishTrend[i]! : null,
    }));
    const bearishPoints = bars.map((bar, i) => ({
        time: bar.time,
        value: Number.isFinite(analysis.bearishTrend[i]!) ? analysis.bearishTrend[i]! : null,
    }));
    const series: SeriesSpec[] = [
        {
            id: midpointId,
            title: 'Candle midpoint',
            paneId: 'price',
            kind: 'line',
            points: midpoints,
            visible: false,
            overlay: true,
            style: { color: withAlpha(NEUTRAL, 0), width: 1, lineStyle: 'solid' },
        },
        {
            id: bullishId,
            title: 'Bullish Trend',
            paneId: 'price',
            kind: 'line',
            points: bullishPoints,
            overlay: true,
            zOrder: 2,
            style: { color: view.bullColor, width: 1, lineStyle: 'solid' },
        },
        {
            id: bearishId,
            title: 'Bearish Trend',
            paneId: 'price',
            kind: 'line',
            points: bearishPoints,
            overlay: true,
            zOrder: 2,
            style: { color: view.bearColor, width: 1, lineStyle: 'solid' },
        },
    ];

    const bullishGradient: Array<FillGradientStop | null> = bars.map((bar, i) => {
        const trend = analysis.bullishTrend[i]!;
        if (!Number.isFinite(trend)) return null;
        return {
            topValue: (bar.open + bar.close) / 2,
            bottomValue: trend,
            topColor: withAlpha(view.bullColor, 0.02),
            bottomColor: withAlpha(view.bullColor, 0.3),
        };
    });
    const bearishGradient: Array<FillGradientStop | null> = bars.map((bar, i) => {
        const trend = analysis.bearishTrend[i]!;
        if (!Number.isFinite(trend)) return null;
        return {
            topValue: trend,
            bottomValue: (bar.open + bar.close) / 2,
            topColor: withAlpha(view.bearColor, 0.3),
            bottomColor: withAlpha(view.bearColor, 0.02),
        };
    });
    const fills: Fill[] = [
        {
            id: 'volume-sentiment:bullish-fill',
            paneId: 'price',
            fromSeriesId: midpointId,
            toSeriesId: bullishId,
            gradient: bullishGradient,
            overlay: true,
        },
        {
            id: 'volume-sentiment:bearish-fill',
            paneId: 'price',
            fromSeriesId: midpointId,
            toSeriesId: bearishId,
            gradient: bearishGradient,
            overlay: true,
        },
    ];
    return { series, fills };
}

/** Turn the detector snapshot into the complete channel/profile/trend composition. */
export function buildVolumeSentimentChannelsOutput(
    analysis: VolumeSentimentAnalysis,
    bars: readonly OHLCV[],
    view: VolumeSentimentViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const labels: DrawingLabel[] = [];
    for (const channel of analysis.channels.slice(-MAX_DRAWN_CHANNELS)) {
        addChannel(boxes, lines, channel, bars, view);
    }
    for (let i = 0; i < bars.length; i += 1) {
        if (analysis.bullishBreak[i]) labels.push(breakMarker(`sentiment_break_up_${i}`, i, true, bars, view));
        if (analysis.bearishBreak[i]) labels.push(breakMarker(`sentiment_break_down_${i}`, i, false, bars, view));
    }
    const trends = trendSeries(analysis, bars, view);
    return { boxes, lines, labels, series: trends.series, fills: trends.fills };
}

type AlertKind = 'formed' | 'break-up' | 'break-down';

function alertKey(kind: AlertKind, time: number): string {
    return `${kind}:${time}`;
}

class VolumeSentimentChannelsIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };
    private lastSeenTime = Number.NEGATIVE_INFINITY;
    private readonly alerted = new Set<string>();

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.alerted.clear();
        const analysis = this.compute();
        this.emitOutput(analysis);
        this.primeAlerts(analysis);
    }

    onBars(): void {
        const analysis = this.compute();
        this.emitOutput(analysis);
        if (this.lastSeenTime === Number.NEGATIVE_INFINITY) this.primeAlerts(analysis);
        else this.emitAlerts(analysis);
    }

    onViewport(): void {
        /* Channels and profiles are computed from the canonical bars, not the visible window. */
    }

    setInputs(inputs: Record<string, InputValue>): void {
        this.inputs = { ...DEFAULTS, ...inputs };
        const analysis = this.compute();
        this.emitOutput(analysis);
        this.primeAlerts(analysis);
    }

    suspend(): void {
        /* No resources run between frames. */
    }

    resume(): void {
        const analysis = this.compute();
        this.emitOutput(analysis);
        this.primeAlerts(analysis);
    }

    stop(): void {
        this.ctx = null;
        this.alerted.clear();
    }

    private compute(): VolumeSentimentAnalysis {
        return detectVolumeSentimentChannels(this.ctx?.bars() ?? [], {
            normalizationLength: num(this.inputs.normalizationLength, DEFAULTS.normalizationLength),
            channelLength: num(this.inputs.channelLength, DEFAULTS.channelLength),
            strongClosesOnly: bool(this.inputs.strongClosesOnly, DEFAULTS.strongClosesOnly),
        });
    }

    private view(): VolumeSentimentViewOptions {
        return {
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
        };
    }

    private emitOutput(analysis: VolumeSentimentAnalysis): void {
        if (!this.ctx) return;
        this.ctx.emit(buildVolumeSentimentChannelsOutput(analysis, this.ctx.bars(), this.view()));
    }

    private signalKeys(analysis: VolumeSentimentAnalysis, fromTime: number, emit: boolean): void {
        if (!this.ctx) return;
        const bars = this.ctx.bars();
        const raise = (kind: AlertKind, index: number, title: string, message: string): void => {
            const bar = bars[index];
            if (!bar || bar.time < fromTime) return;
            const key = alertKey(kind, bar.time);
            if (this.alerted.has(key)) return;
            this.alerted.add(key);
            if (emit) {
                this.ctx?.emitAlert?.({ id: key, title, message, time: bar.time, barIndex: index });
            }
        };
        for (let i = 0; i < bars.length; i += 1) {
            if (analysis.channelFormed[i]) raise('formed', i, 'Channel Formed', 'A new channel has formed.');
            if (analysis.bullishBreak[i]) raise('break-up', i, 'Bullish Channel Break', 'Price broke above the channel.');
            if (analysis.bearishBreak[i]) raise('break-down', i, 'Bearish Channel Break', 'Price broke below the channel.');
        }
    }

    private primeAlerts(analysis: VolumeSentimentAnalysis): void {
        const bars = this.ctx?.bars() ?? [];
        this.lastSeenTime = bars.length > 0 ? bars[bars.length - 1]!.time : Number.NEGATIVE_INFINITY;
        this.signalKeys(analysis, this.lastSeenTime, false);
    }

    private emitAlerts(analysis: VolumeSentimentAnalysis): void {
        const bars = this.ctx?.bars() ?? [];
        this.signalKeys(analysis, this.lastSeenTime, true);
        this.lastSeenTime = bars.length > 0 ? bars[bars.length - 1]!.time : this.lastSeenTime;
    }
}

export const volumeSentimentChannelsDescriptor: NativeIndicatorDescriptor = {
    type: VOLUME_SENTIMENT_CHANNELS_INDICATOR_TYPE,
    title: 'Volume Sentiment Breakout Channels',
    shortTitle: 'Sentiment Breakout',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'normalizationLength',
            title: 'Normalization Length',
            type: 'int',
            defval: DEFAULTS.normalizationLength,
            min: 1,
            max: 5000,
            step: 1,
            group: 'Main Settings',
            tooltip: 'Bars used for the rolling high-low normalization. Higher values are steadier and slower to react.',
        },
        {
            key: 'channelLength',
            title: 'Box Detection Length',
            type: 'int',
            defval: DEFAULTS.channelLength,
            min: 1,
            max: 500,
            step: 1,
            group: 'Main Settings',
            tooltip: 'Length used by the volatility baseline, ATR edge zones and channel regime.',
        },
        {
            key: 'strongClosesOnly',
            title: 'Strong Closes Only',
            type: 'bool',
            defval: DEFAULTS.strongClosesOnly,
            group: 'Main Settings',
            tooltip: 'Require the candle midpoint to clear the channel edge. Off requires the close itself to clear it.',
        },
        {
            key: 'bullColor',
            title: 'Bullish Colour',
            type: 'color',
            defval: DEFAULTS.bullColor,
            group: 'Appearance',
            tooltip: 'Color for positive sentiment, the lower zone and bullish breakouts.',
        },
        {
            key: 'bearColor',
            title: 'Bearish Colour',
            type: 'color',
            defval: DEFAULTS.bearColor,
            group: 'Appearance',
            tooltip: 'Color for negative sentiment, the upper zone and bearish breakouts.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new VolumeSentimentChannelsIndicator(),
};

export function registerVolumeSentimentChannels(): void {
    registerNativeIndicator(volumeSentimentChannelsDescriptor);
}
