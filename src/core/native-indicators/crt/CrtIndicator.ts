import type { DrawingBox, DrawingLabel, DrawingLine } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import {
    CRT_DEFAULTS,
    detectCrt,
    type CrtSetup,
} from '../../analysis/crt';
import type { HuntSource } from '../../analysis/stophunt';
import type { SessionPreset } from '../../analysis/tradingSessions';
import { BEARISH, BULLISH, HIGHLIGHT, INVALID, NEUTRAL, VALID } from '../../palette';
import { withAlpha } from '../../color';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

/** CRT plans on the chart: reference range, swept key, Model 1 and the resulting trade. */

export const CRT_INDICATOR_TYPE = 'crt';

const REFERENCE_LABELS: Record<string, number> = {
    '1 hour': 60,
    '4 hours': 240,
    '1 day': 1440,
};
const ZONE_LABELS: Record<string, string> = {
    'New York': 'America/New_York',
    Chicago: 'America/Chicago',
    London: 'Europe/London',
    UTC: 'UTC',
};
const SESSION_LABELS: Record<string, SessionPreset> = { Futures: 'futures', Forex: 'forex' };

const DEFAULTS = {
    referenceTimeframe: '4 hours',
    referenceAnchor: '01:00',
    referenceClock: 'New York',
    useSwing: true,
    useEqual: false,
    useSession: false,
    keyStrength: CRT_DEFAULTS.keyStrength,
    equalTolerance: CRT_DEFAULTS.equalTolerance,
    sessionPreset: 'Futures',
    internalStrength: CRT_DEFAULTS.internalStrength,
    maxSweepToShift: CRT_DEFAULTS.maxSweepToShift,
    orderExpiryBars: CRT_DEFAULTS.orderExpiryBars,
    stopBuffer: CRT_DEFAULTS.stopBuffer,
    minimumRewardRisk: 2,
    lookback: CRT_DEFAULTS.lookback,
    bullColor: BULLISH,
    bearColor: BEARISH,
    rangeColor: NEUTRAL,
    keyColor: HIGHLIGHT,
    profitColor: VALID,
    lossColor: INVALID,
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

function choice<T>(value: InputValue | undefined, choices: Record<string, T>, key: string): T {
    const hit = typeof value === 'string' ? choices[value] : undefined;
    if (hit === undefined) throw new Error(`crt indicator: unknown ${key} "${String(value)}"`);
    return hit;
}

function anchorMinutes(value: InputValue | undefined): number {
    const text = typeof value === 'string' ? value.trim() : DEFAULTS.referenceAnchor;
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) throw new Error(`crt indicator: reference anchor must be HH:MM, got "${text}"`);
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) throw new Error(`crt indicator: invalid reference anchor "${text}"`);
    return hours * 60 + minutes;
}

function sources(inputs: Record<string, InputValue>): HuntSource[] {
    const out: HuntSource[] = [];
    if (bool(inputs.useSwing, DEFAULTS.useSwing)) out.push('swing');
    if (bool(inputs.useEqual, DEFAULTS.useEqual)) out.push('equal');
    if (bool(inputs.useSession, DEFAULTS.useSession)) out.push('session');
    return out;
}

export interface CrtViewOptions {
    bullColor: string;
    bearColor: string;
    rangeColor: string;
    keyColor: string;
    profitColor: string;
    lossColor: string;
}

function line(
    id: string,
    x1: number,
    x2: number,
    price: number,
    ink: string,
    style: 'solid' | 'dashed',
    width = 1,
): DrawingLine {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        x1,
        y1: price,
        x2,
        y2: price,
        extend: 'none',
        color: ink,
        invisible: false,
        width,
        style,
        arrowLeft: false,
        arrowRight: false,
    };
}

function area(
    id: string,
    left: number,
    right: number,
    a: number,
    b: number,
    options: {
        bgColor?: string;
        bgColorTo?: string;
        borderColor?: string;
        borderStyle?: 'solid' | 'dashed';
        text?: string;
        textColor?: string;
        hAlign?: 'left' | 'center' | 'right';
        vAlign?: 'top' | 'center' | 'bottom';
    },
): DrawingBox {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        left,
        right,
        top: Math.max(a, b),
        bottom: Math.min(a, b),
        extend: 'none',
        bgColor: options.bgColor,
        bgColorTo: options.bgColorTo,
        borderColor: options.borderColor,
        borderWidth: options.borderColor ? 1 : 0,
        borderStyle: options.borderStyle ?? 'solid',
        text: options.text,
        textColor: options.textColor,
        textSize: 'auto',
        hAlign: options.hAlign ?? 'center',
        vAlign: options.vAlign ?? 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

function label(
    id: string,
    x: number,
    y: number,
    text: string,
    ink: string,
    style: 'label_up' | 'label_down',
): DrawingLabel {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        x,
        y,
        yloc: 'price',
        text,
        style,
        color: withAlpha(ink, 0.85),
        textColor: '#ffffff',
        size: 'tiny',
        textAlign: 'center',
        fontFamily: 'default',
        bold: true,
    };
}

function timeAt(times: readonly number[], index: number): number {
    if (times.length === 0) return 0;
    const last = times.length - 1;
    if (index <= last) return times[index]!;
    const step = times.length > 1 ? times[last]! - times[last - 1]! : 0;
    return times[last]! + (index - last) * step;
}

/** Setups to renderer-neutral geometry. Exported for a positive visual-model test. */
export function buildCrtOutput(
    setups: readonly CrtSetup[],
    times: readonly number[],
    view: CrtViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const labels: DrawingLabel[] = [];
    if (times.length === 0) return { boxes, lines, labels };

    const lastTime = times[times.length - 1]!;

    for (const setup of setups) {
        const directionInk = setup.direction === 'bull' ? view.bullColor : view.bearColor;
        const short = setup.direction === 'bear';
        const id = `crt_${setup.direction}_${setup.referenceStartIndex}_${setup.index}`;
        const planRight = setup.outcomeTime ?? lastTime;
        const modelRight = setup.fillTime ?? Math.min(setup.expiryTime, timeAt(times, setup.expiryIndex));

        // The range was fixed before the sweep. Its faint wash keeps C/H and C/L together.
        boxes.push(area(`${id}_range`, setup.referenceStartTime, planRight, setup.referenceHigh, setup.referenceLow, {
            bgColor: withAlpha(view.rangeColor, 0.035),
            borderColor: withAlpha(view.rangeColor, 0.25),
            borderStyle: 'dashed',
            text: 'CRT range',
            textColor: withAlpha(view.rangeColor, 0.9),
            hAlign: 'left',
            vAlign: short ? 'bottom' : 'top',
        }));
        lines.push(line(`${id}_ch`, setup.referenceStartTime, planRight, setup.referenceHigh, withAlpha(view.rangeColor, 0.55), 'solid'));
        lines.push(line(`${id}_cl`, setup.referenceStartTime, planRight, setup.referenceLow, withAlpha(view.rangeColor, 0.55), 'solid'));

        // The structural liquidity that price raided before turning.
        lines.push(line(`${id}_key`, setup.keyTime, timeAt(times, setup.sweepIndex + 1), setup.keyLevel, withAlpha(view.keyColor, 0.85), 'dashed', 2));
        lines.push(line(`${id}_structure`, setup.structureTime, setup.time, setup.structureLevel, withAlpha(directionInk, 0.5), 'dashed'));

        // Model 1 is the body of the last opposing candle, and its open is the resting price.
        boxes.push(area(`${id}_model`, setup.modelTime, modelRight, setup.modelTop, setup.modelBottom, {
            bgColor: withAlpha(directionInk, 0.13),
            borderColor: withAlpha(directionInk, 0.7),
            text: 'Model 1',
            textColor: directionInk,
            hAlign: 'left',
        }));
        labels.push(label(`${id}_ts`, setup.sweepTime, setup.sweepExtreme, 'TS', view.keyColor, short ? 'label_down' : 'label_up'));

        if (setup.fillTime === null) {
            lines.push(line(`${id}_waiting`, setup.time, timeAt(times, setup.expiryIndex), setup.entryPrice, withAlpha(directionInk, 0.75), 'dashed'));
            continue;
        }

        boxes.push(area(`${id}_risk`, setup.fillTime, planRight, setup.entryPrice, setup.stop, {
            bgColor: withAlpha(view.lossColor, 0.1),
            bgColorTo: withAlpha(view.lossColor, 0.035),
        }));
        boxes.push(area(`${id}_reward`, setup.fillTime, planRight, setup.entryPrice, setup.target, {
            bgColor: withAlpha(view.profitColor, 0.11),
            bgColorTo: withAlpha(view.profitColor, 0.035),
            text: `${setup.rewardRisk.toFixed(1)}R → ${short ? 'C/L' : 'C/H'}`,
            textColor: view.profitColor,
            hAlign: 'left',
            vAlign: short ? 'bottom' : 'top',
        }));
        lines.push(line(`${id}_entry`, setup.fillTime, planRight, setup.entryPrice, withAlpha(directionInk, 0.8), 'dashed'));
        lines.push(line(`${id}_stop`, setup.fillTime, planRight, setup.stop, withAlpha(view.lossColor, 0.8), 'solid'));
        lines.push(line(`${id}_target`, setup.fillTime, planRight, setup.target, withAlpha(view.profitColor, 0.8), 'solid'));
    }

    return { boxes, lines, labels };
}

class CrtIndicator implements NativeIndicator {
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
        // CRT is defined over the loaded bars, not the viewport.
    }

    setInputs(inputs: Record<string, InputValue>): void {
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    suspend(): void {
        // No timers or external resources.
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.ctx = null;
    }

    private emit(): void {
        if (!this.ctx) return;
        const bars: readonly OHLCV[] = this.ctx.bars();
        const minimumRewardRisk = num(this.inputs.minimumRewardRisk, DEFAULTS.minimumRewardRisk);
        const setups = detectCrt(bars, {
            referenceMinutes: choice(this.inputs.referenceTimeframe, REFERENCE_LABELS, 'reference timeframe'),
            referenceAnchorMin: anchorMinutes(this.inputs.referenceAnchor),
            zone: choice(this.inputs.referenceClock, ZONE_LABELS, 'reference clock'),
            keySources: sources(this.inputs),
            keyStrength: num(this.inputs.keyStrength, DEFAULTS.keyStrength),
            equalTolerance: num(this.inputs.equalTolerance, DEFAULTS.equalTolerance),
            sessionPreset: choice(this.inputs.sessionPreset, SESSION_LABELS, 'session preset'),
            internalStrength: num(this.inputs.internalStrength, DEFAULTS.internalStrength),
            maxSweepToShift: num(this.inputs.maxSweepToShift, DEFAULTS.maxSweepToShift),
            orderExpiryBars: num(this.inputs.orderExpiryBars, DEFAULTS.orderExpiryBars),
            stopBuffer: num(this.inputs.stopBuffer, DEFAULTS.stopBuffer),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
        }).filter((setup) => setup.rewardRisk >= minimumRewardRisk);

        this.ctx.emit(buildCrtOutput(setups, bars.map((bar) => bar.time), {
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
            rangeColor: color(this.inputs.rangeColor, DEFAULTS.rangeColor),
            keyColor: color(this.inputs.keyColor, DEFAULTS.keyColor),
            profitColor: color(this.inputs.profitColor, DEFAULTS.profitColor),
            lossColor: color(this.inputs.lossColor, DEFAULTS.lossColor),
        }));
    }
}

export const crtDescriptor: NativeIndicatorDescriptor = {
    type: CRT_INDICATOR_TYPE,
    title: 'Candle Range Theory',
    shortTitle: 'CRT',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'referenceTimeframe', title: 'Reference timeframe', type: 'string',
            defval: DEFAULTS.referenceTimeframe, options: Object.keys(REFERENCE_LABELS), group: 'Reference range',
            tooltip: 'The higher timeframe that supplies C/H and C/L. It must be above the chart timeframe.',
        },
        {
            key: 'referenceAnchor', title: 'Grid starts', type: 'string',
            defval: DEFAULTS.referenceAnchor, group: 'Reference range',
            tooltip: 'Wall-clock anchor in HH:MM. 01:00 makes H4 candles start at 01:00, 05:00 and 09:00.',
        },
        {
            key: 'referenceClock', title: 'Clock', type: 'string',
            defval: DEFAULTS.referenceClock, options: Object.keys(ZONE_LABELS), group: 'Reference range',
            tooltip: 'The wall clock used to align reference candles, including daylight-saving changes.',
        },
        { key: 'useSwing', title: 'Swing keys', type: 'bool', defval: DEFAULTS.useSwing, group: 'Key level' },
        { key: 'useEqual', title: 'Equal high/low keys', type: 'bool', defval: DEFAULTS.useEqual, group: 'Key level' },
        { key: 'useSession', title: 'Session keys', type: 'bool', defval: DEFAULTS.useSession, group: 'Key level' },
        {
            key: 'keyStrength', title: 'Key swing strength', type: 'int', defval: DEFAULTS.keyStrength,
            min: 1, max: 50, step: 1, group: 'Key level',
        },
        {
            key: 'equalTolerance', title: 'Equal within (%)', type: 'float', defval: DEFAULTS.equalTolerance,
            min: 0, max: 10, step: 0.01, group: 'Key level', when: { key: 'useEqual', equals: true },
        },
        {
            key: 'sessionPreset', title: 'Session levels', type: 'string', defval: DEFAULTS.sessionPreset,
            options: Object.keys(SESSION_LABELS), group: 'Key level', when: { key: 'useSession', equals: true },
        },
        {
            key: 'internalStrength', title: 'Internal swing strength', type: 'int',
            defval: DEFAULTS.internalStrength, min: 1, max: 20, step: 1, group: 'Model 1',
        },
        {
            key: 'maxSweepToShift', title: 'Sweep → shift', type: 'int',
            defval: DEFAULTS.maxSweepToShift, min: 1, max: 200, step: 1, group: 'Model 1',
        },
        {
            key: 'orderExpiryBars', title: 'Order rests for', type: 'int',
            defval: DEFAULTS.orderExpiryBars, min: 1, max: 500, step: 1, group: 'Trade plan',
        },
        {
            key: 'stopBuffer', title: 'Stop buffer (points)', type: 'float',
            defval: DEFAULTS.stopBuffer, min: 0, max: 1e6, step: 0.01, group: 'Trade plan',
        },
        {
            key: 'minimumRewardRisk', title: 'Minimum reward : risk', type: 'float',
            defval: DEFAULTS.minimumRewardRisk, min: 0.1, max: 20, step: 0.1, group: 'Trade plan',
        },
        {
            key: 'lookback', title: 'Last bars', type: 'int', defval: DEFAULTS.lookback,
            min: 0, max: 20_000, step: 100, group: 'Display', tooltip: '0 shows every loaded setup.',
        },
        { key: 'bullColor', title: 'Long', type: 'color', defval: DEFAULTS.bullColor, group: 'Style' },
        { key: 'bearColor', title: 'Short', type: 'color', defval: DEFAULTS.bearColor, group: 'Style' },
        { key: 'rangeColor', title: 'Reference range', type: 'color', defval: DEFAULTS.rangeColor, group: 'Style' },
        { key: 'keyColor', title: 'Key and sweep', type: 'color', defval: DEFAULTS.keyColor, group: 'Style' },
        { key: 'profitColor', title: 'Reward zone', type: 'color', defval: DEFAULTS.profitColor, group: 'Style' },
        { key: 'lossColor', title: 'Risk zone', type: 'color', defval: DEFAULTS.lossColor, group: 'Style' },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new CrtIndicator(),
};

/** Register the built-in CRT indicator. Idempotent through the native registry. */
export function registerCrt(): void {
    registerNativeIndicator(crtDescriptor);
}
