import type { DrawingBox, DrawingLabel, DrawingLine } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import { RANGE_DEFAULTS, detectRanges, type Range } from '../../analysis/range';
import { summarizeVolumePressure, volumePressureOfBar } from '../../analysis/volumePressure';
import { mix, withAlpha } from '../../color';
import { BEARISH, BULLISH, INFO, NEUTRAL } from '../../palette';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

/** The type id `chart.addNativeIndicator()` takes. */
export const PRESSURE_CHANNELS_INDICATOR_TYPE = 'pressure-channels';

const DEFAULTS = {
    ...RANGE_DEFAULTS,
    confirmedOnly: true,
    showPressure: true,
    showMeter: true,
    pressureScale: 0.75,
    pressureHistory: 800,
    channelColor: INFO,
    bullColor: BULLISH,
    bearColor: BEARISH,
} as const;

const CHANNEL_FILL_ALPHA = 0.055;
const EDGE_ALPHA = 0.62;
const MIDDLE_ALPHA = 0.34;
const TAIL_ALPHA = 0.44;
const PULSE_MIN_ALPHA = 0.24;
const PULSE_MAX_ALPHA = 0.82;
const METER_SEGMENTS = 11;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function num(value: InputValue | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: InputValue | undefined, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function color(value: InputValue | undefined, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback;
}

export interface PressureChannelViewOptions {
    showPressure: boolean;
    showMeter: boolean;
    /** Fraction of one half-channel available to a full-strength pulse. */
    pressureScale: number;
    /** Only paint pulses this many bars back; channel geometry is unaffected. */
    pressureHistory: number;
    channelColor: string;
    bullColor: string;
    bearColor: string;
}

function line(
    id: string,
    xloc: 'bar_index' | 'bar_time',
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ink: string,
    width: number,
    style: 'solid' | 'dashed' | 'dotted',
    extend: 'none' | 'right' = 'none',
    arrowRight = false,
): DrawingLine {
    return {
        id,
        paneId: 'price',
        xloc,
        overlay: true,
        x1,
        y1,
        x2,
        y2,
        extend,
        color: ink,
        invisible: false,
        width,
        style,
        arrowLeft: false,
        arrowRight,
    };
}

function area(id: string, range: Range, view: PressureChannelViewOptions): DrawingBox {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        left: range.startTime,
        right: range.endTime,
        top: range.top,
        bottom: range.bottom,
        extend: 'none',
        // The wash follows the pressure scale: positive at the high, negative at the low.
        bgColor: withAlpha(view.bullColor, CHANNEL_FILL_ALPHA),
        bgColorTo: withAlpha(view.bearColor, CHANNEL_FILL_ALPHA),
        borderWidth: 0,
        borderStyle: 'solid',
        textSize: 'auto',
        hAlign: 'center',
        vAlign: 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

function pressureInk(score: number, view: PressureChannelViewOptions, alpha = 1): string {
    const hue = score >= 0 ? view.bullColor : view.bearColor;
    const strength = 0.25 + Math.abs(score) * 0.75;
    return withAlpha(mix(NEUTRAL, hue, strength), alpha);
}

function marker(id: string, range: Range, view: PressureChannelViewOptions): DrawingLabel | null {
    if (range.breakTime == null || range.breakClose == null || range.breakDirection == null) return null;
    const up = range.breakDirection === 'up';
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        x: range.breakTime,
        y: range.breakClose,
        yloc: 'price',
        style: up ? 'triangleup' : 'triangledown',
        color: up ? view.bullColor : view.bearColor,
        size: 'tiny',
        textAlign: 'center',
        fontFamily: 'default',
        noFill: false,
        tooltip: up ? 'Confirmed close above the channel' : 'Confirmed close below the channel',
    };
}

function addPulses(
    lines: DrawingLine[],
    range: Range,
    bars: readonly OHLCV[],
    view: PressureChannelViewOptions,
): void {
    if (!view.showPressure) return;
    const summary = summarizeVolumePressure(bars, range.startIndex, range.endIndex);
    if (!summary || !(summary.averageVolume > 0)) return;

    const first = Math.max(range.startIndex, bars.length - Math.max(1, Math.floor(view.pressureHistory)));
    for (let i = first; i <= range.endIndex; i += 1) {
        const bar = bars[i];
        if (!bar) continue;
        const reading = volumePressureOfBar(bar, i > 0 ? bars[i - 1] : undefined);
        if (!reading || !(reading.volume > 0)) continue;

        const score = clamp(reading.signedVolume / summary.averageVolume, -1, 1);
        const amplitude = score * range.height * 0.5 * clamp(view.pressureScale, 0.1, 1);
        const alpha = PULSE_MIN_ALPHA + Math.abs(score) * (PULSE_MAX_ALPHA - PULSE_MIN_ALPHA);
        lines.push(line(
            `pressure_${range.startIndex}_pulse_${i}`,
            // A small in-slot offset keeps the pulse readable beside the candle body.
            'bar_index',
            i + 0.48,
            range.middle,
            i + 0.48,
            range.middle + amplitude,
            pressureInk(score, view, alpha),
            2,
            'solid',
        ));
    }
}

function addMeter(
    lines: DrawingLine[],
    labels: DrawingLabel[],
    range: Range,
    bars: readonly OHLCV[],
    view: PressureChannelViewOptions,
): void {
    if (!range.active || !view.showPressure || !view.showMeter) return;

    const x = range.endIndex + 2;
    const summary = summarizeVolumePressure(bars, range.startIndex, range.endIndex);
    for (let i = 0; i < METER_SEGMENTS; i += 1) {
        const y1 = range.bottom + range.height * (i / METER_SEGMENTS);
        const y2 = range.bottom + range.height * ((i + 0.68) / METER_SEGMENTS);
        const level = (i / (METER_SEGMENTS - 1)) * 2 - 1;
        lines.push(line(
            `pressure_${range.startIndex}_meter_${i}`,
            'bar_index',
            x,
            y1,
            x,
            y2,
            pressureInk(level, view, 0.88),
            4,
            'solid',
        ));
    }

    const score = summary?.score ?? 0;
    const y = range.bottom + ((score + 1) / 2) * range.height;
    labels.push({
        id: `pressure_${range.startIndex}_meter_value`,
        paneId: 'price',
        xloc: 'bar_index',
        overlay: true,
        x: x + 0.5,
        y,
        yloc: 'price',
        text: summary ? `${score >= 0 ? '+' : ''}${Math.round(score * 100)}%` : 'VOL —',
        style: 'label_left',
        color: summary ? pressureInk(score, view) : withAlpha(view.channelColor, 0.8),
        textColor: '#ffffff',
        size: 'tiny',
        textAlign: 'center',
        fontFamily: 'monospace',
        bold: true,
        noFill: false,
        tooltip: summary
            ? 'Recency-weighted volume pressure inside the active channel'
            : 'This data source did not report volume for the active channel',
    });
}

/**
 * Turn detected balance ranges into Midorii's pressure-channel instrument.
 *
 * Channel detection and pressure are deliberately independent. Price decides whether a channel
 * exists; volume only describes what happened inside it. A feed with no volume still gets the
 * same channels and breakouts, without a made-up pressure reading.
 */
export function buildPressureChannelsOutput(
    ranges: readonly Range[],
    bars: readonly OHLCV[],
    view: PressureChannelViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const labels: DrawingLabel[] = [];
    const edgeInk = withAlpha(view.channelColor, EDGE_ALPHA);
    const middleInk = withAlpha(view.channelColor, MIDDLE_ALPHA);
    const tailInk = withAlpha(view.channelColor, TAIL_ALPHA);

    for (const range of ranges) {
        const id = `pressure_${range.startIndex}`;
        boxes.push(area(`${id}_channel`, range, view));
        lines.push(line(`${id}_top`, 'bar_time', range.startTime, range.top, range.endTime, range.top, edgeInk, 1, 'solid'));
        lines.push(line(`${id}_bottom`, 'bar_time', range.startTime, range.bottom, range.endTime, range.bottom, edgeInk, 1, 'solid'));
        lines.push(line(
            `${id}_equilibrium`,
            'bar_time',
            range.startTime,
            range.middle,
            range.endTime,
            range.middle,
            middleInk,
            1,
            'dashed',
            range.active ? 'right' : 'none',
        ));

        if (range.active) {
            lines.push(line(`${id}_tail_top`, 'bar_time', range.endTime, range.top, range.endTime, range.top, tailInk, 1, 'dashed', 'right'));
            lines.push(line(`${id}_tail_bottom`, 'bar_time', range.endTime, range.bottom, range.endTime, range.bottom, tailInk, 1, 'dashed', 'right'));
        }

        addPulses(lines, range, bars, view);
        addMeter(lines, labels, range, bars, view);

        if (range.breakDirection != null && range.breakTime != null && range.breakClose != null) {
            const up = range.breakDirection === 'up';
            const breakInk = up ? view.bullColor : view.bearColor;
            lines.push(line(
                `${id}_break`,
                'bar_time',
                range.endTime,
                up ? range.top : range.bottom,
                range.breakTime,
                range.breakClose,
                withAlpha(breakInk, 0.9),
                2,
                'solid',
                'none',
                true,
            ));
            const breakMarker = marker(`${id}_break_marker`, range, view);
            if (breakMarker) labels.push(breakMarker);
        }
    }

    return { boxes, lines, labels };
}

class PressureChannelsIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* Computed from the canonical bar array, not the visible window. */
    }

    setInputs(inputs: Record<string, InputValue>): void {
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    suspend(): void {
        /* No resources run between frames. */
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.ctx = null;
    }

    private emit(): void {
        if (!this.ctx) return;
        const allBars = this.ctx.bars();
        const confirmedOnly = bool(this.inputs.confirmedOnly, DEFAULTS.confirmedOnly);
        const detectionBars = confirmedOnly && this.ctx.live && allBars.length > 1
            ? allBars.slice(0, -1)
            : allBars;
        const ranges = detectRanges(detectionBars, {
            minBars: num(this.inputs.minBars, DEFAULTS.minBars),
            maxBars: num(this.inputs.maxBars, DEFAULTS.maxBars),
            compression: num(this.inputs.compression, DEFAULTS.compression),
            atrPeriod: num(this.inputs.atrPeriod, DEFAULTS.atrPeriod),
            minTouches: num(this.inputs.minTouches, DEFAULTS.minTouches),
            touchZone: num(this.inputs.touchZone, DEFAULTS.touchZone),
            breakBuffer: num(this.inputs.breakBuffer, DEFAULTS.breakBuffer),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
        });
        this.ctx.emit(buildPressureChannelsOutput(ranges, detectionBars, {
            showPressure: bool(this.inputs.showPressure, DEFAULTS.showPressure),
            showMeter: bool(this.inputs.showMeter, DEFAULTS.showMeter),
            pressureScale: num(this.inputs.pressureScale, DEFAULTS.pressureScale),
            pressureHistory: num(this.inputs.pressureHistory, DEFAULTS.pressureHistory),
            channelColor: color(this.inputs.channelColor, DEFAULTS.channelColor),
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
        }));
    }
}

export const pressureChannelsDescriptor: NativeIndicatorDescriptor = {
    type: PRESSURE_CHANNELS_INDICATOR_TYPE,
    title: 'Pressure Channels',
    shortTitle: 'Pressure',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'minBars', title: 'Min length', type: 'int', defval: DEFAULTS.minBars,
            min: 2, max: 1000, step: 1, group: 'Channel',
            tooltip: 'Minimum number of bars in a compressed, two-sided price range.',
        },
        {
            key: 'maxBars', title: 'Max length', type: 'int', defval: DEFAULTS.maxBars,
            min: 10, max: 5000, step: 10, group: 'Channel',
            tooltip: 'Maximum number of bars one channel may cover.',
        },
        {
            key: 'compression', title: 'Compression', type: 'float', defval: DEFAULTS.compression,
            min: 0.05, max: 3, step: 0.05, group: 'Channel',
            tooltip: 'Maximum channel height relative to prior volatility and the square root of its length. Lower is tighter.',
        },
        {
            key: 'atrPeriod', title: 'Volatility over', type: 'int', defval: DEFAULTS.atrPeriod,
            min: 2, max: 200, step: 1, group: 'Channel',
            tooltip: 'Bars used to measure volatility before a channel starts.',
        },
        {
            key: 'minTouches', title: 'Touches per side', type: 'int', defval: DEFAULTS.minTouches,
            min: 1, max: 10, step: 1, group: 'Channel',
            tooltip: 'Separate visits required at both edges of the channel.',
        },
        {
            key: 'touchZone', title: 'Edge zone', type: 'float', defval: DEFAULTS.touchZone,
            min: 1, max: 50, step: 1, group: 'Channel',
            tooltip: 'Share of channel height that counts as touching an edge, in percent.',
        },
        {
            key: 'breakBuffer', title: 'Breakout buffer', type: 'float', defval: DEFAULTS.breakBuffer,
            min: 0, max: 50, step: 1, group: 'Channel',
            tooltip: 'Distance a close must clear beyond an edge, as a percent of channel height.',
        },
        {
            key: 'lookback', title: 'Last bars', type: 'int', defval: DEFAULTS.lookback,
            min: 0, max: 5000, step: 10, group: 'Channel',
            tooltip: 'Only show channels confirmed within this many recent bars. Zero keeps all.',
        },
        {
            key: 'confirmedOnly', title: 'Confirmed bars only', type: 'bool', defval: DEFAULTS.confirmedOnly,
            group: 'Channel',
            tooltip: 'Ignore the newest still-forming live bar when detecting channels and breakouts.',
        },
        {
            key: 'showPressure', title: 'Pressure pulses', type: 'bool', defval: DEFAULTS.showPressure,
            group: 'Pressure',
            tooltip: 'Show volume-weighted closing pressure around the channel equilibrium.',
        },
        {
            key: 'showMeter', title: 'Live meter', type: 'bool', defval: DEFAULTS.showMeter,
            group: 'Pressure', when: { key: 'showPressure', equals: true },
            tooltip: 'Show the recency-weighted pressure score beside the active channel.',
        },
        {
            key: 'pressureScale', title: 'Pulse height', type: 'float', defval: DEFAULTS.pressureScale,
            min: 0.1, max: 1, step: 0.05, group: 'Pressure',
            when: { key: 'showPressure', equals: true },
            tooltip: 'Maximum share of either half-channel used by a pressure pulse.',
        },
        {
            key: 'pressureHistory', title: 'Pulse history', type: 'int', defval: DEFAULTS.pressureHistory,
            min: 50, max: 5000, step: 50, group: 'Pressure',
            when: { key: 'showPressure', equals: true },
            tooltip: 'Maximum recent bars that may carry pressure pulses. Channel detection is unaffected.',
        },
        {
            key: 'channelColor', title: 'Channel', type: 'color', defval: DEFAULTS.channelColor,
            group: 'Appearance',
            tooltip: 'Color of the channel rails and equilibrium.',
        },
        {
            key: 'bullColor', title: 'Positive pressure', type: 'color', defval: DEFAULTS.bullColor,
            group: 'Appearance',
            tooltip: 'Color of positive pressure and upward breakouts.',
        },
        {
            key: 'bearColor', title: 'Negative pressure', type: 'color', defval: DEFAULTS.bearColor,
            group: 'Appearance',
            tooltip: 'Color of negative pressure and downward breakouts.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new PressureChannelsIndicator(),
};

/** Register the built-in pressure-channel indicator (idempotent). */
export function registerPressureChannels(): void {
    registerNativeIndicator(pressureChannelsDescriptor);
}
