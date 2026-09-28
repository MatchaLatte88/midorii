import type { DrawingBox, DrawingLabel } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import type { Background } from '../../model/scene';
import {
    AMD_FVG_DEFAULTS,
    amdSessionMask,
    detectAmdFvg,
    selectAmdFvgSignals,
    type AmdFvgSignal,
    type AmdSession,
} from '../../analysis/amdFvg';
import { ACCENT, BEARISH, BULLISH, NEUTRAL } from '../../palette';
import { withAlpha } from '../../color';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

/** Accumulation range, manipulation, the qualifying gap and the simulated trade. */

export const AMD_FVG_INDICATOR_TYPE = 'amd-fvg';

const DEFAULTS = {
    accLength: AMD_FVG_DEFAULTS.accLength,
    accWidthPct: AMD_FVG_DEFAULTS.accWidthPct,
    maxSearch: AMD_FVG_DEFAULTS.maxSearch,
    fvgAtr: AMD_FVG_DEFAULTS.fvgAtr,
    atrLength: AMD_FVG_DEFAULTS.atrLength,
    atrMult: AMD_FVG_DEFAULTS.atrMult,
    rrr: AMD_FVG_DEFAULTS.rrr,
    useSydney: false,
    useTokyo: false,
    useLondon: false,
    useNewYork: true,
    showSessions: true,
    accColor: NEUTRAL,
    bearColor: BEARISH,
    bullColor: BULLISH,
    profitColor: BULLISH,
    lossColor: BEARISH,
    fvgColor: '#ffffff',
    sessionColor: ACCENT,
    labelOffset: 1,
} as const;

function num(value: InputValue | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: InputValue | undefined, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function color(value: InputValue | undefined, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback;
}

function sessions(inputs: Record<string, InputValue>): AmdSession[] {
    const out: AmdSession[] = [];
    if (bool(inputs.useSydney, DEFAULTS.useSydney)) out.push('sydney');
    if (bool(inputs.useTokyo, DEFAULTS.useTokyo)) out.push('tokyo');
    if (bool(inputs.useLondon, DEFAULTS.useLondon)) out.push('london');
    if (bool(inputs.useNewYork, DEFAULTS.useNewYork)) out.push('newyork');
    return out;
}

export interface AmdFvgViewOptions {
    accColor: string;
    bearColor: string;
    bullColor: string;
    profitColor: string;
    lossColor: string;
    fvgColor: string;
    sessionColor: string;
    labelOffset: number;
}

function area(
    id: string,
    x1: number,
    x2: number,
    a: number,
    b: number,
    fill: string,
    border?: { color: string; style: 'solid' | 'dotted' },
): DrawingBox {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        left: Math.min(x1, x2),
        right: Math.max(x1, x2),
        top: Math.max(a, b),
        bottom: Math.min(a, b),
        extend: 'none',
        bgColor: fill,
        borderColor: border?.color,
        borderWidth: border ? 1 : 0,
        borderStyle: border?.style ?? 'solid',
        textSize: 'auto',
        hAlign: 'center',
        vAlign: 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

function label(id: string, x: number, y: number, text: string, ink: string, style: 'label_up' | 'label_down'): DrawingLabel {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        x,
        y,
        yloc: 'price',
        text,
        style,
        color: ink,
        textColor: '#ffffff',
        size: 'tiny',
        textAlign: 'center',
        fontFamily: 'default',
        overlay: true,
    };
}

/**
 * One wash per run of in-session bars. Edges sit halfway between neighbouring bars, so a wash
 * covers whole candle slots rather than starting and ending at candle centres.
 */
function sessionBackgrounds(times: readonly number[], mask: readonly boolean[], ink: string): Background[] {
    const out: Background[] = [];
    const edge = (left: number, right: number): number => (left + right) / 2;
    const step = times.length > 1 ? times[1]! - times[0]! : 0;
    let start = -1;
    for (let i = 0; i <= times.length; i += 1) {
        const inside = i < times.length && mask[i] === true;
        if (inside && start < 0) start = i;
        if (inside || start < 0) continue;
        const last = i - 1;
        out.push({
            id: `amd_session_${times[start]}`,
            paneId: 'price',
            from: start > 0 ? edge(times[start - 1]!, times[start]!) : times[start]! - step / 2,
            to: last < times.length - 1 ? edge(times[last]!, times[last + 1]!) : times[last]! + step / 2,
            color: ink,
            overlay: true,
        });
        start = -1;
    }
    return out;
}

/** Signals to renderer-neutral geometry. Exported for a positive visual-model test. */
export function buildAmdFvgOutput(
    signals: readonly AmdFvgSignal[],
    times: readonly number[],
    sessionMask: readonly boolean[] | null,
    view: AmdFvgViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const labels: DrawingLabel[] = [];
    const backgrounds = sessionMask ? sessionBackgrounds(times, sessionMask, withAlpha(view.sessionColor, 0.04)) : [];
    if (times.length === 0) return { boxes, labels, backgrounds };

    const lastTime = times[times.length - 1]!;
    const fvgInk = withAlpha(view.fvgColor, 0.4);

    for (const signal of signals) {
        const bear = signal.direction === 'bear';
        const id = `amd_${signal.direction}_${signal.time}`;
        const tradeRight = signal.exitTime ?? lastTime;

        boxes.push(area(`${id}_acc`, signal.accStartTime, signal.accEndTime, signal.accHigh, signal.accLow, withAlpha(view.accColor, 0.2)));
        boxes.push(area(
            `${id}_manipulation`,
            signal.accEndTime,
            signal.fvgStartTime,
            signal.manipulationExtreme,
            bear ? signal.accHigh : signal.accLow,
            withAlpha(bear ? view.bearColor : view.bullColor, 0.25),
        ));
        boxes.push(area(`${id}_fvg`, signal.fvgStartTime, signal.time, signal.fvgTop, signal.fvgBottom, fvgInk, {
            color: fvgInk,
            style: 'dotted',
        }));
        boxes.push(area(`${id}_target`, signal.time, tradeRight, signal.close, signal.target, withAlpha(view.profitColor, 0.25)));
        boxes.push(area(`${id}_stop`, signal.time, tradeRight, signal.close, signal.stop, withAlpha(view.lossColor, 0.25)));

        const offset = signal.atr * view.labelOffset;
        labels.push(bear
            ? label(`${id}_label`, signal.time, signal.high + offset, 'AMD Bearish', view.bearColor, 'label_down')
            : label(`${id}_label`, signal.time, signal.low - offset, 'AMD Bullish', view.bullColor, 'label_up'));
    }

    return { boxes, labels, backgrounds };
}

class AmdFvgIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };
    private lastSeenTime = Number.NEGATIVE_INFINITY;
    private readonly alerted = new Set<string>();

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.alerted.clear();
        this.primeAlerts(this.emit());
    }

    onBars(): void {
        const signals = this.emit();
        if (this.lastSeenTime === Number.NEGATIVE_INFINITY) this.primeAlerts(signals);
        else this.raiseAlerts(signals);
    }

    onViewport(): void {
        // Setups are defined over the loaded bars, not the viewport.
    }

    setInputs(inputs: Record<string, InputValue>): void {
        this.inputs = { ...DEFAULTS, ...inputs };
        this.primeAlerts(this.emit());
    }

    suspend(): void {
        // No timers or external resources.
    }

    resume(): void {
        this.primeAlerts(this.emit());
    }

    stop(): void {
        this.ctx = null;
        this.alerted.clear();
    }

    private emit(): AmdFvgSignal[] {
        if (!this.ctx) return [];
        const bars: readonly OHLCV[] = this.ctx.bars();
        const enabled = sessions(this.inputs);
        const candidates = detectAmdFvg(bars, {
            accLength: num(this.inputs.accLength, DEFAULTS.accLength),
            accWidthPct: num(this.inputs.accWidthPct, DEFAULTS.accWidthPct),
            maxSearch: num(this.inputs.maxSearch, DEFAULTS.maxSearch),
            fvgAtr: num(this.inputs.fvgAtr, DEFAULTS.fvgAtr),
            atrLength: num(this.inputs.atrLength, DEFAULTS.atrLength),
            sessions: enabled,
        });
        const signals = selectAmdFvgSignals(
            candidates,
            bars,
            num(this.inputs.atrMult, DEFAULTS.atrMult),
            num(this.inputs.rrr, DEFAULTS.rrr),
        );
        const mask = bool(this.inputs.showSessions, DEFAULTS.showSessions) ? amdSessionMask(bars, enabled) : null;

        this.ctx.emit(buildAmdFvgOutput(signals, bars.map((bar) => bar.time), mask, {
            accColor: color(this.inputs.accColor, DEFAULTS.accColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            profitColor: color(this.inputs.profitColor, DEFAULTS.profitColor),
            lossColor: color(this.inputs.lossColor, DEFAULTS.lossColor),
            fvgColor: color(this.inputs.fvgColor, DEFAULTS.fvgColor),
            sessionColor: color(this.inputs.sessionColor, DEFAULTS.sessionColor),
            labelOffset: num(this.inputs.labelOffset, DEFAULTS.labelOffset),
        }));
        return signals;
    }

    private signalKeys(signals: readonly AmdFvgSignal[], fromTime: number, raise: boolean): void {
        for (const signal of signals) {
            if (signal.time < fromTime) continue;
            const key = `${signal.direction}:${signal.time}`;
            if (this.alerted.has(key)) continue;
            this.alerted.add(key);
            if (!raise) continue;
            const bull = signal.direction === 'bull';
            this.ctx?.emitAlert?.({
                id: key,
                title: bull ? 'Bullish AMD Signal' : 'Bearish AMD Signal',
                message: bull
                    ? 'Price swept below the accumulation range and left a bullish gap back inside it.'
                    : 'Price swept above the accumulation range and left a bearish gap back inside it.',
                time: signal.time,
                barIndex: signal.index,
            });
        }
    }

    /** Marks everything already on the chart as seen, so loading history raises nothing. */
    private primeAlerts(signals: readonly AmdFvgSignal[]): void {
        const bars = this.ctx?.bars() ?? [];
        this.lastSeenTime = bars.length > 0 ? bars[bars.length - 1]!.time : Number.NEGATIVE_INFINITY;
        this.signalKeys(signals, this.lastSeenTime, false);
    }

    private raiseAlerts(signals: readonly AmdFvgSignal[]): void {
        const bars = this.ctx?.bars() ?? [];
        this.signalKeys(signals, this.lastSeenTime, true);
        this.lastSeenTime = bars.length > 0 ? bars[bars.length - 1]!.time : this.lastSeenTime;
    }
}

export const amdFvgDescriptor: NativeIndicatorDescriptor = {
    type: AMD_FVG_INDICATOR_TYPE,
    title: 'AMD FVG Setup',
    shortTitle: 'AMD FVG',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'accLength', title: 'Accumulation length', type: 'int', defval: DEFAULTS.accLength,
            min: 5, max: 500, step: 1, group: 'AMD logic',
            tooltip: 'Bars in the rolling window whose high-low range must stay narrow.',
        },
        {
            key: 'accWidthPct', title: 'Accumulation range max %', type: 'float', defval: DEFAULTS.accWidthPct,
            min: 0.01, max: 20, step: 0.01, group: 'AMD logic',
            tooltip: 'The widest the accumulation range may be, as a percentage of its low.',
        },
        {
            key: 'maxSearch', title: 'Max search window', type: 'int', defval: DEFAULTS.maxSearch,
            min: 1, max: 200, step: 1, group: 'AMD logic',
            tooltip: 'Bars after the accumulation in which the sweep and the gap must both occur.',
        },
        {
            key: 'fvgAtr', title: 'Min FVG gap (ATR)', type: 'float', defval: DEFAULTS.fvgAtr,
            min: 0, max: 10, step: 0.05, group: 'AMD logic',
            tooltip: 'The gap must be larger than this multiple of ATR. Higher values require stronger gaps.',
        },
        { key: 'atrLength', title: 'ATR length', type: 'int', defval: DEFAULTS.atrLength, min: 1, max: 200, step: 1, group: 'Trade plan' },
        { key: 'atrMult', title: 'ATR stop multiplier', type: 'float', defval: DEFAULTS.atrMult, min: 0.1, max: 20, step: 0.1, group: 'Trade plan' },
        { key: 'rrr', title: 'Reward : risk', type: 'float', defval: DEFAULTS.rrr, min: 0.1, max: 20, step: 0.1, group: 'Trade plan' },
        {
            key: 'useSydney', title: 'Sydney 17:00–02:00', type: 'bool', defval: DEFAULTS.useSydney, group: 'Sessions',
            tooltip: 'Session hours are read on the New York clock and follow its daylight-saving changes.',
        },
        { key: 'useTokyo', title: 'Tokyo 19:00–04:00', type: 'bool', defval: DEFAULTS.useTokyo, group: 'Sessions' },
        { key: 'useLondon', title: 'London 03:00–12:00', type: 'bool', defval: DEFAULTS.useLondon, group: 'Sessions' },
        { key: 'useNewYork', title: 'New York 08:00–17:00', type: 'bool', defval: DEFAULTS.useNewYork, group: 'Sessions' },
        { key: 'showSessions', title: 'Highlight active sessions', type: 'bool', defval: DEFAULTS.showSessions, group: 'Sessions' },
        { key: 'accColor', title: 'Accumulation', type: 'color', defval: DEFAULTS.accColor, group: 'Style' },
        { key: 'bearColor', title: 'Manipulation (bear)', type: 'color', defval: DEFAULTS.bearColor, group: 'Style' },
        { key: 'bullColor', title: 'Manipulation (bull)', type: 'color', defval: DEFAULTS.bullColor, group: 'Style' },
        { key: 'profitColor', title: 'Take profit', type: 'color', defval: DEFAULTS.profitColor, group: 'Style' },
        { key: 'lossColor', title: 'Stop loss', type: 'color', defval: DEFAULTS.lossColor, group: 'Style' },
        { key: 'fvgColor', title: 'Fair value gap', type: 'color', defval: DEFAULTS.fvgColor, group: 'Style' },
        { key: 'sessionColor', title: 'Session highlight', type: 'color', defval: DEFAULTS.sessionColor, group: 'Style' },
        {
            key: 'labelOffset', title: 'Label offset (ATR)', type: 'float', defval: DEFAULTS.labelOffset,
            min: 0, max: 10, step: 0.1, group: 'Style',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new AmdFvgIndicator(),
};

/** Register the built-in AMD FVG indicator. Idempotent through the native registry. */
export function registerAmdFvg(): void {
    registerNativeIndicator(amdFvgDescriptor);
}
