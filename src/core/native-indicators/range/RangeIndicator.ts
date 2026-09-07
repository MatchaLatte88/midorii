import type { InputSchema, InputValue } from '../../model/inputs';
import type { DrawingBox, DrawingLine } from '../../model/drawings';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';
import { RANGE_DEFAULTS, detectRanges, type Range } from '../../analysis/range';
import { BEARISH, BULLISH, INFO } from '../../palette';
import { withAlpha } from '../../color';

/**
 * Every range on the chart — where the market stopped going anywhere, and how it left.
 *
 * Four marks, and each one answers a different question:
 *
 *   the box      the stretch itself, from the first bar inside it to the last. Unlike a gap, a
 *                range does not run to the right edge: it happened over a definite number of
 *                bars, and its width is the readable part of it.
 *   equilibrium  the midpoint, dashed. The line premium and discount split on, and the level a
 *                range gets traded back to more than any other.
 *   the tail     for a range still running at the right edge, both edges continue dashed to the
 *                edge of the pane. The box says where it has been; the tail says the levels are
 *                still live.
 *   the break    from the edge that gave way to the close that broke it. Its height is how
 *                decisively the bar left, which is the one thing about a breakout visible
 *                before anything else happens.
 *
 * The box keeps one colour whatever happened afterwards. Colouring a range by the way it
 * eventually broke would paint a reading onto bars that did not have it yet, which is the
 * visual form of the look-ahead the detector is careful to avoid.
 *
 * Only the two PRICE edges are drawn, never a full rectangle: the top and the bottom are the
 * levels anyone trades against, and vertical sides would give a range two more edges that mean
 * nothing. So the box is a fill with no border, and the edges are lines over it.
 *
 * Opacity lives in the colour, not in a second alpha — the drawing model has one colour per
 * fill and per stroke, and multiplying two alphas is how a box asked for at 0.1 comes out at
 * 0.01.
 */

/** The stretch itself. Faint: it is the ground the candles are read against, not a mark. */
const FILL_ALPHA = 0.1;
const EDGE_ALPHA = 0.55;
const MIDDLE_ALPHA = 0.3;
/** The live continuation of a range that has not ended — present, but quieter than the box. */
const TAIL_ALPHA = 0.4;
const BREAK_FILL_ALPHA = 0.3;
const BREAK_EDGE_ALPHA = 0.9;

/** The type id `chart.addNativeIndicator()` takes. */
export const RANGE_INDICATOR_TYPE = 'range';

const DEFAULTS = {
    ...RANGE_DEFAULTS,
    color: INFO,
    bullColor: BULLISH,
    bearColor: BEARISH,
} as const;

function num(v: InputValue | undefined, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function color(v: InputValue | undefined, fallback: string): string {
    return typeof v === 'string' && v !== '' ? v : fallback;
}

/** How the ranges are painted. None of it changes what a range is. */
export interface RangeViewOptions {
    /** Box, edges, equilibrium and tail. Neutral on purpose — see the header. */
    color: string;
    /** The mark on a bar that closed above the range. */
    bullColor: string;
    /** …and below it. */
    bearColor: string;
}

/** A line at one price across one stretch of time. */
function edge(id: string, x1: number, x2: number, y: number, ink: string, style: 'solid' | 'dashed', extend: 'none' | 'right'): DrawingLine {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        x1, y1: y, x2, y2: y, extend, color: ink,
        invisible: false, width: 1, style, arrowLeft: false, arrowRight: false,
    };
}

/** A filled rectangle with no border of its own — every edge this indicator draws is a line. */
function area(id: string, left: number, right: number, a: number, b: number, bgColor: string): DrawingBox {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        left, right, top: Math.max(a, b), bottom: Math.min(a, b),
        extend: 'none', bgColor, borderWidth: 0, borderStyle: 'solid',
        textSize: 'auto', hAlign: 'center', vAlign: 'center',
        wrap: false, fontFamily: 'default', bold: false, italic: false,
    };
}

/**
 * Ranges → chart geometry.
 *
 * Horizontal coordinates are bar TIMES, which the renderer places at the centre of their bar —
 * so a mark that covers "one candle" spans from one bar's time to the next one's. The break
 * mark therefore runs from the last bar inside the range to the bar that broke it, meeting the
 * box exactly where the box ends.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildRangeOutput(ranges: readonly Range[], view: RangeViewOptions): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];

    const fill = withAlpha(view.color, FILL_ALPHA);
    const edgeInk = withAlpha(view.color, EDGE_ALPHA);
    const middleInk = withAlpha(view.color, MIDDLE_ALPHA);
    const tailInk = withAlpha(view.color, TAIL_ALPHA);

    for (const range of ranges) {
        const id = `range_${range.startIndex}`;
        boxes.push(area(`${id}_box`, range.startTime, range.endTime, range.top, range.bottom, fill));

        // The two prices anyone trades against.
        lines.push(edge(`${id}_top`, range.startTime, range.endTime, range.top, edgeInk, 'solid', 'none'));
        lines.push(edge(`${id}_bottom`, range.startTime, range.endTime, range.bottom, edgeInk, 'solid', 'none'));

        /* Equilibrium runs on with the range: while it is still live the midpoint is still the
         * level being traded back to, so it reaches the right edge with the tail. */
        lines.push(edge(`${id}_mid`, range.startTime, range.endTime, range.middle, middleInk, 'dashed', range.active ? 'right' : 'none'));

        if (range.active) {
            // Still running: the levels continue, dashed, past the last bar.
            lines.push(edge(`${id}_tail_top`, range.endTime, range.endTime, range.top, tailInk, 'dashed', 'right'));
            lines.push(edge(`${id}_tail_bottom`, range.endTime, range.endTime, range.bottom, tailInk, 'dashed', 'right'));
        }

        if (range.breakIndex == null || range.breakClose == null || range.breakDirection == null) continue;

        /* The break: from the edge that gave way to the close that broke it. */
        const up = range.breakDirection === 'up';
        const breakInk = up ? view.bullColor : view.bearColor;
        const from = up ? range.top : range.bottom;
        const left = range.endTime;
        const right = range.breakTime!;
        boxes.push(area(`${id}_break`, left, right, from, range.breakClose, withAlpha(breakInk, BREAK_FILL_ALPHA)));
        // The close is the price that settled it, so it gets the solid line.
        lines.push(edge(`${id}_break_close`, left, right, range.breakClose, withAlpha(breakInk, BREAK_EDGE_ALPHA), 'solid', 'none'));
    }

    return { boxes, lines };
}

class RangeIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    /** Every new bar can extend a range, break one, or start one. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* ranges are read off the bar array, not off what is on screen */
    }

    setInputs(inputs: Record<string, InputValue>): void {
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    suspend(): void {
        /* nothing running between frames */
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.ctx = null;
    }

    private emit(): void {
        if (!this.ctx) return;
        const ranges = detectRanges(this.ctx.bars(), {
            minBars: num(this.inputs.minBars, DEFAULTS.minBars),
            maxBars: num(this.inputs.maxBars, DEFAULTS.maxBars),
            compression: num(this.inputs.compression, DEFAULTS.compression),
            atrPeriod: num(this.inputs.atrPeriod, DEFAULTS.atrPeriod),
            minTouches: num(this.inputs.minTouches, DEFAULTS.minTouches),
            touchZone: num(this.inputs.touchZone, DEFAULTS.touchZone),
            breakBuffer: num(this.inputs.breakBuffer, DEFAULTS.breakBuffer),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
        });
        this.ctx.emit(buildRangeOutput(ranges, {
            color: color(this.inputs.color, DEFAULTS.color),
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
        }));
    }
}

export const rangeDescriptor: NativeIndicatorDescriptor = {
    type: RANGE_INDICATOR_TYPE,
    title: 'Ranges',
    shortTitle: 'Range',
    paneHint: 'price',
    overlay: true,
    // Two instances is how a short-and-tight and a long-and-loose reading sit on one chart.
    multiInstance: true,
    /* Ranges are context the candles are read against, spread over the whole history — folding
     * them into the scale would zoom the chart out to whatever range sits furthest away. */
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'minBars',
            title: 'Min length',
            type: 'int',
            defval: DEFAULTS.minBars,
            min: 2,
            max: 1000,
            step: 1,
            tooltip: 'How many bars a quiet stretch must last before it counts as a range. Counted in '
                + 'bars rather than hours, so the same setting means a proportionate stretch on every '
                + 'timeframe. Lower finds more and shorter consolidations.',
        },
        {
            key: 'maxBars',
            title: 'Max length',
            type: 'int',
            defval: DEFAULTS.maxBars,
            min: 10,
            max: 5000,
            step: 10,
            tooltip: 'The longest a range may run. This is the blunt guard against a level that belongs '
                + 'to a much higher timeframe covering the whole chart — an hourly range is 1200 bars on '
                + 'a 1m chart, and is cut off long before it can be drawn.',
        },
        {
            key: 'compression',
            title: 'Compression',
            type: 'float',
            defval: DEFAULTS.compression,
            min: 0.05,
            max: 3,
            step: 0.05,
            tooltip: 'How narrow the span has to be, measured against how far this market normally '
                + 'travels in the same number of bars. 0.6 means at most 60% of that. Because the '
                + 'comparison scales with volatility and length, one setting means the same thing on 1m '
                + 'and on 4h. Lower finds fewer and tighter ranges.',
        },
        {
            key: 'atrPeriod',
            title: 'Volatility over',
            type: 'int',
            defval: DEFAULTS.atrPeriod,
            min: 2,
            max: 200,
            step: 1,
            tooltip: 'How many bars the reference volatility is averaged over. It is read from the bars '
                + 'before a range, never from inside it — inside, a range would be compared against its '
                + 'own calm and every one of them would pass.',
        },
        {
            key: 'minTouches',
            title: 'Touches per side',
            type: 'int',
            defval: DEFAULTS.minTouches,
            min: 1,
            max: 10,
            step: 1,
            tooltip: 'How many separate times price has to come back to each edge. This is what separates '
                + 'a two-sided range from a narrow diagonal drift. 1 is no filter at all — both edges are '
                + 'touched by definition — and 3 or more is rare.',
        },
        {
            key: 'touchZone',
            title: 'Edge zone',
            type: 'float',
            defval: DEFAULTS.touchZone,
            min: 1,
            max: 50,
            step: 1,
            tooltip: 'How close to an edge counts as reaching it, as a percentage of the range height. '
                + 'Price rarely stops at the exact same tick twice, so demanding the extreme itself would '
                + 'find almost no touches.',
        },
        {
            key: 'breakBuffer',
            title: 'Breakout buffer',
            type: 'float',
            defval: DEFAULTS.breakBuffer,
            min: 0,
            max: 50,
            step: 1,
            tooltip: 'How far past an edge a bar must close to end the range, as a percentage of its '
                + 'height. 0 already demands a close beyond the extreme of every bar so far. Raising it '
                + 'keeps ranges alive through false breaks, but they then tend to end by widening instead '
                + '— at 25% only about a third still end on a clean break.',
        },
        {
            key: 'lookback',
            title: 'Last bars',
            type: 'int',
            defval: DEFAULTS.lookback,
            min: 0,
            max: 5000,
            step: 10,
            tooltip: 'Only show ranges confirmed within this many of the most recent bars, counted back '
                + 'from the newest one. 0 means no limit.',
        },
        {
            key: 'color',
            title: 'Range',
            type: 'color',
            defval: DEFAULTS.color,
            tooltip: 'Colour of the box, its edges and the equilibrium. Neutral on purpose: which way a '
                + 'range breaks is not known while it is forming, and colouring it by the outcome would '
                + 'put a reading on the chart that nobody had at the time.',
        },
        {
            key: 'bullColor',
            title: 'Break up',
            type: 'color',
            defval: DEFAULTS.bullColor,
            tooltip: 'Colour of the mark on the bar that closed above the range.',
        },
        {
            key: 'bearColor',
            title: 'Break down',
            type: 'color',
            defval: DEFAULTS.bearColor,
            tooltip: 'Colour of the mark on the bar that closed below the range.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new RangeIndicator(),
};

/** Register the built-in range indicator (idempotent). Called by the composition root. */
export function registerRange(): void {
    registerNativeIndicator(rangeDescriptor);
}
