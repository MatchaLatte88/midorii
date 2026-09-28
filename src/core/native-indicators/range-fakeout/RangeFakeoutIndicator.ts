import type { DrawingBox, DrawingLabel, DrawingLine } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import {
    RANGE_FAKEOUT_DEFAULTS,
    detectRangeFakeouts,
    rangeFakeoutTarget,
    type FakeoutGapSide,
    type RangeFakeoutSetup,
} from '../../analysis/rangeFakeout';
import { BEARISH, BULLISH, INVALID, NEUTRAL, VALID } from '../../palette';
import { withAlpha } from '../../color';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

/** Range fakeouts on the chart: the range, the gap left beyond it, and the trade back through it. */

export const RANGE_FAKEOUT_INDICATOR_TYPE = 'range-fakeout';

const GAP_SIDE_LABELS: Record<string, FakeoutGapSide> = {
    Either: 'any',
    'With the breakout': 'breakout',
    'Against the breakout': 'reversal',
};
const TARGET_LABELS: Record<string, 'fixed' | 'range'> = { 'Fixed reward : risk': 'fixed', 'Far range edge': 'range' };

const DEFAULTS = {
    minBars: RANGE_FAKEOUT_DEFAULTS.minBars,
    compression: RANGE_FAKEOUT_DEFAULTS.compression,
    minTouches: RANGE_FAKEOUT_DEFAULTS.minTouches,
    maxFakeoutBars: RANGE_FAKEOUT_DEFAULTS.maxFakeoutBars,
    gapSide: 'Against the breakout',
    minGapAtr: RANGE_FAKEOUT_DEFAULTS.minGapAtr,
    target: 'Fixed reward : risk',
    rrr: RANGE_FAKEOUT_DEFAULTS.rrr,
    minEdgeReward: RANGE_FAKEOUT_DEFAULTS.minEdgeReward,
    rangeColor: NEUTRAL,
    bullColor: BULLISH,
    bearColor: BEARISH,
    profitColor: VALID,
    lossColor: INVALID,
} as const;

function num(value: InputValue | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function color(value: InputValue | undefined, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback;
}

function choice<T>(value: InputValue | undefined, choices: Record<string, T>, key: string): T {
    const hit = typeof value === 'string' ? choices[value] : undefined;
    if (hit === undefined) throw new Error(`range fakeout indicator: unknown ${key} "${String(value)}"`);
    return hit;
}

/** A setup with the trade the chart projects from its confirmation close. */
export interface RangeFakeoutTrade {
    setup: RangeFakeoutSetup;
    target: number;
    /** The bar that first reached the stop or target; null while neither was reached. */
    exitTime: number | null;
    outcome: 'target' | 'stop' | 'open';
}

/**
 * The projected trade for each setup that is taken, resolved on the bars after the confirmation.
 * A bar reaching both the stop and the target is counted as the stop.
 */
export function projectRangeFakeouts(
    setups: readonly RangeFakeoutSetup[],
    bars: readonly OHLCV[],
    targetMode: 'fixed' | 'range',
    rrr: number,
    minEdgeReward: number,
): RangeFakeoutTrade[] {
    const trades: RangeFakeoutTrade[] = [];
    for (const setup of setups) {
        const target = rangeFakeoutTarget(setup, targetMode, rrr, minEdgeReward);
        if (target === null) continue;
        const short = setup.direction === 'bear';
        let trade: RangeFakeoutTrade = { setup, target, exitTime: null, outcome: 'open' };
        for (let i = setup.index + 1; i < bars.length; i += 1) {
            const bar = bars[i]!;
            const hitStop = short ? bar.high >= setup.extreme : bar.low <= setup.extreme;
            const hitTarget = short ? bar.low <= target : bar.high >= target;
            if (!hitStop && !hitTarget) continue;
            trade = { setup, target, exitTime: bar.time, outcome: hitStop ? 'stop' : 'target' };
            break;
        }
        trades.push(trade);
    }
    return trades;
}

export interface RangeFakeoutViewOptions {
    rangeColor: string;
    bullColor: string;
    bearColor: string;
    profitColor: string;
    lossColor: string;
}

function area(id: string, left: number, right: number, a: number, b: number, fill: string, border?: string): DrawingBox {
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
        bgColor: fill,
        borderColor: border,
        borderWidth: border ? 1 : 0,
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

function line(id: string, x1: number, x2: number, price: number, ink: string, style: 'solid' | 'dashed'): DrawingLine {
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
        width: 1,
        style,
        arrowLeft: false,
        arrowRight: false,
    };
}

/** Trades to renderer-neutral geometry. Exported for a positive visual-model test. */
export function buildRangeFakeoutOutput(
    trades: readonly RangeFakeoutTrade[],
    times: readonly number[],
    view: RangeFakeoutViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const labels: DrawingLabel[] = [];
    if (times.length === 0) return { boxes, lines, labels };
    const lastTime = times[times.length - 1]!;

    for (const { setup, target, exitTime } of trades) {
        const short = setup.direction === 'bear';
        const ink = short ? view.bearColor : view.bullColor;
        const id = `fakeout_${setup.breakTime}`;
        const right = exitTime ?? lastTime;

        boxes.push(area(`${id}_range`, setup.rangeStartTime, setup.breakTime, setup.top, setup.bottom,
            withAlpha(view.rangeColor, 0.12), withAlpha(view.rangeColor, 0.5)));
        lines.push(line(`${id}_middle`, setup.rangeStartTime, setup.time, setup.middle, withAlpha(view.rangeColor, 0.8), 'dashed'));
        const gapInk = setup.gap.direction === 'bull' ? view.bullColor : view.bearColor;
        boxes.push(area(`${id}_gap`, setup.gap.startTime, setup.gap.time, setup.gap.top, setup.gap.bottom,
            withAlpha(gapInk, 0.3), withAlpha(gapInk, 0.7)));
        lines.push(line(`${id}_extreme`, setup.breakTime, setup.time, setup.extreme, withAlpha(ink, 0.8), 'dashed'));

        boxes.push(area(`${id}_reward`, setup.time, right, setup.close, target, withAlpha(view.profitColor, 0.15)));
        boxes.push(area(`${id}_risk`, setup.time, right, setup.close, setup.extreme, withAlpha(view.lossColor, 0.15)));
        labels.push({
            id: `${id}_label`,
            paneId: 'price',
            xloc: 'bar_time',
            x: setup.time,
            y: setup.extreme,
            yloc: 'price',
            text: short ? 'Fakeout short' : 'Fakeout long',
            style: short ? 'label_down' : 'label_up',
            color: withAlpha(ink, 0.85),
            textColor: '#ffffff',
            size: 'tiny',
            textAlign: 'center',
            fontFamily: 'default',
            overlay: true,
        });
    }

    return { boxes, lines, labels };
}

class RangeFakeoutIndicator implements NativeIndicator {
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
        // Setups are defined over the loaded bars, not the viewport.
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
        const setups = detectRangeFakeouts(bars, {
            range: {
                minBars: num(this.inputs.minBars, DEFAULTS.minBars),
                compression: num(this.inputs.compression, DEFAULTS.compression),
                minTouches: num(this.inputs.minTouches, DEFAULTS.minTouches),
            },
            maxFakeoutBars: num(this.inputs.maxFakeoutBars, DEFAULTS.maxFakeoutBars),
            gapSide: choice(this.inputs.gapSide, GAP_SIDE_LABELS, 'gap direction'),
            minGapAtr: num(this.inputs.minGapAtr, DEFAULTS.minGapAtr),
        });
        const trades = projectRangeFakeouts(
            setups,
            bars,
            choice(this.inputs.target, TARGET_LABELS, 'target'),
            num(this.inputs.rrr, DEFAULTS.rrr),
            num(this.inputs.minEdgeReward, DEFAULTS.minEdgeReward),
        );
        this.ctx.emit(buildRangeFakeoutOutput(trades, bars.map((bar) => bar.time), {
            rangeColor: color(this.inputs.rangeColor, DEFAULTS.rangeColor),
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
            profitColor: color(this.inputs.profitColor, DEFAULTS.profitColor),
            lossColor: color(this.inputs.lossColor, DEFAULTS.lossColor),
        }));
    }
}

export const rangeFakeoutDescriptor: NativeIndicatorDescriptor = {
    type: RANGE_FAKEOUT_INDICATOR_TYPE,
    title: 'Range Fakeout',
    shortTitle: 'Fakeout',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        { key: 'minBars', title: 'Min bars', type: 'int', defval: DEFAULTS.minBars, min: 5, max: 300, step: 1, group: 'Range' },
        {
            key: 'compression', title: 'Compression', type: 'float', defval: DEFAULTS.compression,
            min: 0.1, max: 3, step: 0.05, group: 'Range',
            tooltip: 'Height limit as a multiple of ATR × √length. Lower finds tighter ranges.',
        },
        { key: 'minTouches', title: 'Touches per edge', type: 'int', defval: DEFAULTS.minTouches, min: 1, max: 10, step: 1, group: 'Range' },
        {
            key: 'maxFakeoutBars', title: 'Fakeout window', type: 'int', defval: DEFAULTS.maxFakeoutBars,
            min: 1, max: 200, step: 1, group: 'Fakeout',
            tooltip: 'Bars after the breakout close in which price must close back through the range middle.',
        },
        {
            key: 'gapSide', title: 'Gap direction', type: 'string', defval: DEFAULTS.gapSide,
            options: Object.keys(GAP_SIDE_LABELS), group: 'Fakeout',
        },
        {
            key: 'minGapAtr', title: 'Min gap (ATR)', type: 'float', defval: DEFAULTS.minGapAtr,
            min: 0, max: 10, step: 0.05, group: 'Fakeout',
        },
        { key: 'target', title: 'Target', type: 'string', defval: DEFAULTS.target, options: Object.keys(TARGET_LABELS), group: 'Trade plan' },
        {
            key: 'rrr', title: 'Reward : risk', type: 'float', defval: DEFAULTS.rrr, min: 0.1, max: 20, step: 0.1, group: 'Trade plan',
            tooltip: 'The fixed target, and the fallback when the far range edge is no longer ahead of the entry.',
        },
        {
            key: 'minEdgeReward', title: 'Min reward : risk to the edge', type: 'float', defval: DEFAULTS.minEdgeReward,
            min: 0, max: 10, step: 0.1, group: 'Trade plan',
            tooltip: 'Far range edge only. Setups whose edge offers less than this multiple of the risk are not drawn.',
        },
        { key: 'rangeColor', title: 'Range', type: 'color', defval: DEFAULTS.rangeColor, group: 'Style' },
        { key: 'bullColor', title: 'Bullish', type: 'color', defval: DEFAULTS.bullColor, group: 'Style' },
        { key: 'bearColor', title: 'Bearish', type: 'color', defval: DEFAULTS.bearColor, group: 'Style' },
        { key: 'profitColor', title: 'Reward zone', type: 'color', defval: DEFAULTS.profitColor, group: 'Style' },
        { key: 'lossColor', title: 'Risk zone', type: 'color', defval: DEFAULTS.lossColor, group: 'Style' },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new RangeFakeoutIndicator(),
};

/** Register the built-in range fakeout indicator. Idempotent through the native registry. */
export function registerRangeFakeout(): void {
    registerNativeIndicator(rangeFakeoutDescriptor);
}
