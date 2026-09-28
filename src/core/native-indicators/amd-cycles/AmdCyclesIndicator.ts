import type { DrawingBox, DrawingLabel } from '../../model/drawings';
import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import {
    AMD_CYCLE_DEFAULTS,
    detectAmdCycles,
    trackAmdGaps,
    type AmdBreakout,
    type AmdCycle,
    type AmdGap,
} from '../../analysis/amdCycles';
import { BEARISH, BULLISH, HIGHLIGHT, NEUTRAL } from '../../palette';
import { withAlpha } from '../../color';
import type {
    NativeIndicator,
    NativeIndicatorContext,
    NativeIndicatorDescriptor,
    NativeIndicatorOutput,
} from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';

/** AMD cycles on the chart: the latest ranges and manipulations, and the gaps still live. */

export const AMD_CYCLES_INDICATOR_TYPE = 'amd-cycles';

const BREAKOUT_LABELS: Record<string, AmdBreakout> = { Wicks: 'wicks', Bodies: 'bodies', Both: 'both' };

/** Live boxes reach this many bars past the bar they were last updated on. */
const RIGHT_REACH = 5;

const DEFAULTS = {
    accLength: AMD_CYCLE_DEFAULTS.accLength,
    accRangePct: AMD_CYCLE_DEFAULTS.accRangePct,
    breakout: 'Both',
    maxManipulationBars: AMD_CYCLE_DEFAULTS.maxManipulationBars,
    maxCycles: 5,
    showFvg: true,
    showIfvg: false,
    fvgMinAtr: AMD_CYCLE_DEFAULTS.fvgMinAtr,
    maxGaps: AMD_CYCLE_DEFAULTS.maxLiveGaps,
    skipOverlapping: AMD_CYCLE_DEFAULTS.skipOverlapping,
    alertAccumulation: true,
    alertManipulation: true,
    accColor: NEUTRAL,
    manColor: HIGHLIGHT,
    fvgBullColor: BULLISH,
    fvgBearColor: BEARISH,
    ifvgBullColor: BULLISH,
    ifvgBearColor: BEARISH,
    boxTextColor: '#ffffff',
    labelTextColor: '#ffffff',
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

function breakoutOf(value: InputValue | undefined): AmdBreakout {
    const hit = typeof value === 'string' ? BREAKOUT_LABELS[value] : undefined;
    if (hit === undefined) throw new Error(`amd cycles indicator: unknown breakout type "${String(value)}"`);
    return hit;
}

export interface AmdCyclesViewOptions {
    maxCycles: number;
    showFvg: boolean;
    showIfvg: boolean;
    accColor: string;
    manColor: string;
    fvgBullColor: string;
    fvgBearColor: string;
    ifvgBullColor: string;
    ifvgBearColor: string;
    boxTextColor: string;
    labelTextColor: string;
}

function timeAt(times: readonly number[], index: number): number {
    const last = times.length - 1;
    if (index <= last) return times[index]!;
    const step = times.length > 1 ? times[last]! - times[last - 1]! : 0;
    return times[last]! + (index - last) * step;
}

function area(
    id: string,
    left: number,
    right: number,
    a: number,
    b: number,
    ink: string,
    text?: { value: string; color: string },
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
        bgColor: withAlpha(ink, 0.2),
        borderColor: withAlpha(ink, 0.5),
        borderWidth: 1,
        borderStyle: 'solid',
        text: text?.value,
        textColor: text?.color,
        textSize: 'small',
        hAlign: 'center',
        vAlign: 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

/** Cycles and gaps to renderer-neutral geometry. Exported for a positive visual-model test. */
export function buildAmdCyclesOutput(
    cycles: readonly AmdCycle[],
    gaps: readonly AmdGap[],
    times: readonly number[],
    view: AmdCyclesViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const labels: DrawingLabel[] = [];
    if (times.length === 0) return { boxes, labels };
    const lastIndex = times.length - 1;

    for (const cycle of cycles.slice(-view.maxCycles)) {
        boxes.push(area(`amd_acc_${cycle.time}`, cycle.accStartTime, cycle.accEndTime, cycle.accTop, cycle.accBottom, view.accColor));
    }

    const manipulations = cycles.filter((cycle) => cycle.manipulation !== null && cycle.manipulation.outcome !== 'abandoned');
    for (const cycle of manipulations.slice(-view.maxCycles)) {
        const manipulation = cycle.manipulation!;
        const above = manipulation.side === 'above';
        const edge = above ? cycle.accTop : cycle.accBottom;
        const right = timeAt(times, manipulation.lastIndex + RIGHT_REACH);
        const id = `amd_man_${manipulation.time}`;
        boxes.push(area(id, manipulation.time, right, manipulation.extreme, edge, view.manColor));
        labels.push({
            id: `${id}_label`,
            paneId: 'price',
            xloc: 'bar_time',
            x: right,
            y: (manipulation.extreme + edge) / 2,
            yloc: 'price',
            text: 'Manipulation',
            style: 'label_left',
            color: withAlpha(view.manColor, 0.5),
            textColor: view.labelTextColor,
            size: 'small',
            textAlign: 'center',
            fontFamily: 'default',
            overlay: true,
        });
    }

    const gapRight = timeAt(times, lastIndex + RIGHT_REACH);
    const gapText = withAlpha(view.boxTextColor, 0.5);
    for (const gap of gaps) {
        if (gap.endIndex !== null) continue;
        const id = `amd_gap_${gap.direction}_${gap.time}`;
        if (gap.brokenIndex === null && view.showFvg) {
            const ink = gap.direction === 'bull' ? view.fvgBullColor : view.fvgBearColor;
            boxes.push(area(id, gap.startTime, gapRight, gap.top, gap.bottom, ink, { value: 'FVG', color: gapText }));
        } else if (gap.inverted && view.showIfvg) {
            // A broken bullish gap now resists from above, so it takes the bearish colour.
            const ink = gap.direction === 'bull' ? view.ifvgBearColor : view.ifvgBullColor;
            boxes.push(area(id, gap.startTime, gapRight, gap.top, gap.bottom, ink, { value: 'IFVG', color: gapText }));
        }
    }

    return { boxes, labels };
}

interface AmdCyclesAnalysis {
    cycles: AmdCycle[];
    gaps: AmdGap[];
}

class AmdCyclesIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };
    /** Time of the newest closed bar already looked at for alerts. */
    private lastClosedTime = Number.NEGATIVE_INFINITY;
    private readonly alerted = new Set<string>();

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.alerted.clear();
        this.primeAlerts(this.emit());
    }

    onBars(): void {
        const analysis = this.emit();
        if (this.lastClosedTime === Number.NEGATIVE_INFINITY) this.primeAlerts(analysis);
        else this.raiseAlerts(analysis);
    }

    onViewport(): void {
        // Cycles and gaps are defined over the loaded bars, not the viewport.
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

    private emit(): AmdCyclesAnalysis {
        if (!this.ctx) return { cycles: [], gaps: [] };
        const bars: readonly OHLCV[] = this.ctx.bars();
        const showFvg = bool(this.inputs.showFvg, DEFAULTS.showFvg);
        const showIfvg = bool(this.inputs.showIfvg, DEFAULTS.showIfvg);
        const cycles = detectAmdCycles(bars, {
            accLength: num(this.inputs.accLength, DEFAULTS.accLength),
            accRangePct: num(this.inputs.accRangePct, DEFAULTS.accRangePct),
            breakout: breakoutOf(this.inputs.breakout),
            maxManipulationBars: num(this.inputs.maxManipulationBars, DEFAULTS.maxManipulationBars),
        });
        const gaps = showFvg || showIfvg
            ? trackAmdGaps(bars, {
                minAtr: num(this.inputs.fvgMinAtr, DEFAULTS.fvgMinAtr),
                skipOverlapping: bool(this.inputs.skipOverlapping, DEFAULTS.skipOverlapping),
                maxLive: num(this.inputs.maxGaps, DEFAULTS.maxGaps),
                keepInverted: showIfvg,
            })
            : [];

        this.ctx.emit(buildAmdCyclesOutput(cycles, gaps, bars.map((bar) => bar.time), {
            maxCycles: num(this.inputs.maxCycles, DEFAULTS.maxCycles),
            showFvg,
            showIfvg,
            accColor: color(this.inputs.accColor, DEFAULTS.accColor),
            manColor: color(this.inputs.manColor, DEFAULTS.manColor),
            fvgBullColor: color(this.inputs.fvgBullColor, DEFAULTS.fvgBullColor),
            fvgBearColor: color(this.inputs.fvgBearColor, DEFAULTS.fvgBearColor),
            ifvgBullColor: color(this.inputs.ifvgBullColor, DEFAULTS.ifvgBullColor),
            ifvgBearColor: color(this.inputs.ifvgBearColor, DEFAULTS.ifvgBearColor),
            boxTextColor: color(this.inputs.boxTextColor, DEFAULTS.boxTextColor),
            labelTextColor: color(this.inputs.labelTextColor, DEFAULTS.labelTextColor),
        }));
        return { cycles, gaps };
    }

    /**
     * Phase changes alert once their bar has closed. The newest bar may still be forming, so
     * only bars before it count, and only those newer than the last closed bar already seen —
     * older history paged in behind the chart never alerts.
     */
    private visit(analysis: AmdCyclesAnalysis, raise: boolean): void {
        const bars = this.ctx?.bars() ?? [];
        const closed = bars.length - 2;
        const events: Array<{ key: string; index: number; title: string; message: string }> = [];
        for (const cycle of analysis.cycles) {
            if (bool(this.inputs.alertAccumulation, DEFAULTS.alertAccumulation)) {
                events.push({
                    key: `acc:${cycle.time}`,
                    index: cycle.index,
                    title: 'Accumulation',
                    message: 'A new accumulation range has formed.',
                });
            }
            const manipulation = cycle.manipulation;
            if (manipulation && bool(this.inputs.alertManipulation, DEFAULTS.alertManipulation)) {
                events.push({
                    key: `man:${manipulation.time}`,
                    index: manipulation.index,
                    title: manipulation.side === 'above' ? 'Manipulation above' : 'Manipulation below',
                    message: `Price broke ${manipulation.side} the accumulation range.`,
                });
            }
        }
        for (const event of events) {
            if (event.index > closed || this.alerted.has(event.key)) continue;
            const time = bars[event.index]!.time;
            if (raise && time <= this.lastClosedTime) continue;
            this.alerted.add(event.key);
            if (raise) this.ctx?.emitAlert?.({ id: event.key, title: event.title, message: event.message, time, barIndex: event.index });
        }
        if (closed >= 0) this.lastClosedTime = Math.max(this.lastClosedTime, bars[closed]!.time);
    }

    private primeAlerts(analysis: AmdCyclesAnalysis): void {
        this.lastClosedTime = Number.NEGATIVE_INFINITY;
        this.visit(analysis, false);
    }

    private raiseAlerts(analysis: AmdCyclesAnalysis): void {
        this.visit(analysis, true);
    }
}

export const amdCyclesDescriptor: NativeIndicatorDescriptor = {
    type: AMD_CYCLES_INDICATOR_TYPE,
    title: 'AMD Cycles',
    shortTitle: 'AMD',
    paneHint: 'price',
    overlay: true,
    multiInstance: true,
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'accLength', title: 'Accumulation length', type: 'int', defval: DEFAULTS.accLength,
            min: 5, max: 500, step: 1, group: 'AMD',
        },
        {
            key: 'accRangePct', title: 'Accumulation max range (%)', type: 'float', defval: DEFAULTS.accRangePct,
            min: 0.01, max: 20, step: 0.05, group: 'AMD',
            tooltip: 'The widest the rolling range may be, as a percentage of its low, to count as accumulation.',
        },
        {
            key: 'breakout', title: 'Breakout type', type: 'string', defval: DEFAULTS.breakout,
            options: Object.keys(BREAKOUT_LABELS), group: 'AMD',
            tooltip: 'Which part of a candle must pass the range edge. Both counts either, which is the wick.',
        },
        {
            key: 'maxManipulationBars', title: 'Max manipulation length (bars)', type: 'int',
            defval: DEFAULTS.maxManipulationBars, min: 1, max: 500, step: 1, group: 'AMD',
            tooltip: 'A manipulation that lasts longer without price returning inside the broken edge is abandoned.',
        },
        {
            key: 'maxCycles', title: 'Cycles shown', type: 'int', defval: DEFAULTS.maxCycles,
            min: 1, max: 100, step: 1, group: 'AMD',
        },
        { key: 'showFvg', title: 'Show FVGs', type: 'bool', defval: DEFAULTS.showFvg, group: 'Fair value gaps' },
        { key: 'showIfvg', title: 'Show inverted FVGs', type: 'bool', defval: DEFAULTS.showIfvg, group: 'Fair value gaps' },
        {
            key: 'fvgMinAtr', title: 'Min gap (ATR)', type: 'float', defval: DEFAULTS.fvgMinAtr,
            min: 0, max: 10, step: 0.1, group: 'Fair value gaps',
            tooltip: 'A gap must be larger than this multiple of the 14-bar ATR.',
        },
        {
            key: 'maxGaps', title: 'Max live gaps', type: 'int', defval: DEFAULTS.maxGaps,
            min: 1, max: 100, step: 1, group: 'Fair value gaps',
        },
        {
            key: 'skipOverlapping', title: 'Filter overlapping gaps', type: 'bool', defval: DEFAULTS.skipOverlapping,
            group: 'Fair value gaps',
            tooltip: 'A new gap lying inside a live gap of the same direction is not drawn, and a broken gap '
                + 'overlapping an inverted one of the same direction is not kept as inverted.',
        },
        { key: 'alertAccumulation', title: 'Alert on accumulation', type: 'bool', defval: DEFAULTS.alertAccumulation, group: 'Alerts' },
        { key: 'alertManipulation', title: 'Alert on manipulation', type: 'bool', defval: DEFAULTS.alertManipulation, group: 'Alerts' },
        { key: 'accColor', title: 'Accumulation', type: 'color', defval: DEFAULTS.accColor, group: 'Style' },
        { key: 'manColor', title: 'Manipulation', type: 'color', defval: DEFAULTS.manColor, group: 'Style' },
        { key: 'fvgBullColor', title: 'Bullish FVG', type: 'color', defval: DEFAULTS.fvgBullColor, group: 'Style' },
        { key: 'fvgBearColor', title: 'Bearish FVG', type: 'color', defval: DEFAULTS.fvgBearColor, group: 'Style' },
        { key: 'ifvgBullColor', title: 'Bullish inverted FVG', type: 'color', defval: DEFAULTS.ifvgBullColor, group: 'Style' },
        { key: 'ifvgBearColor', title: 'Bearish inverted FVG', type: 'color', defval: DEFAULTS.ifvgBearColor, group: 'Style' },
        { key: 'boxTextColor', title: 'Box text', type: 'color', defval: DEFAULTS.boxTextColor, group: 'Style' },
        { key: 'labelTextColor', title: 'Label text', type: 'color', defval: DEFAULTS.labelTextColor, group: 'Style' },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new AmdCyclesIndicator(),
};

/** Register the built-in AMD cycles indicator. Idempotent through the native registry. */
export function registerAmdCycles(): void {
    registerNativeIndicator(amdCyclesDescriptor);
}
