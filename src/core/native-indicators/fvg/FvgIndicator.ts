import type { InputSchema, InputValue } from '../../model/inputs';
import type { OHLCV } from '../../model/ohlcv';
import type { DrawingBox, DrawingLine } from '../../model/drawings';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';
import {
    detectFairValueGaps,
    type FvgMitigation,
    type FvgShow,
    type FvgSizeUnit,
    type FvgWindow,
    type FvgZone,
} from '../../analysis/fvg';
import { computeSessionWindows } from '../../analysis/tradingSessions';
import { BEARISH, BULLISH } from '../../palette';
import { withAlpha } from '../../color';

/**
 * Every fair value gap on the chart — the stretches price moved through without an auction.
 *
 * The detector is the one in `core/analysis/fvg.ts`, which the FVG drawing tool reads from
 * too: a second one that drifted would put a hand-marked gap and a painted one on different
 * levels for the same market.
 *
 * One box per zone, and the box ends where the zone did. A gap that is still open runs to the
 * right edge, because that is exactly what it is — a level still standing. A filled one stops
 * at the bar that filled it and is drawn faint and dashed, so the chart says what applied when,
 * rather than painting today's reading over bars that never had it.
 *
 * The midpoint line is drawn only under the `'ce'` rule. Consequent encroachment is where that
 * setting ends a zone, and a dashed line across the middle of every box under the other three
 * rules would be a level nothing in the indicator acts on.
 *
 * First presented gap
 * -------------------
 * Optional, and off by default: instead of every imbalance, only the FIRST gap confirmed in
 * each trading session — Asia, London, New York, any combination of the three. It is the one
 * gap a session-based desk actually trades, and on a low timeframe it is the difference
 * between three boxes a day and eighty.
 *
 * The sessions are the futures preset from `core/analysis/tradingSessions.ts`, which is the
 * one whose three desks carry exactly these names, each read against its own time zone so the
 * windows survive the three weeks a year the clocks disagree.
 *
 * Switching the mode on with no session ticked draws nothing, and that is the honest answer:
 * "the first gap of no session" is an empty set, not "every gap".
 *
 * Opacity lives in the colour, not in a second alpha — the drawing model has one colour per
 * fill and per stroke, and multiplying two alphas is how a box asked for at 0.13 comes out at
 * 0.017.
 */

/** The zone itself, faint: it is ground the candles are read against, not a mark. */
const FILL_ALPHA = 0.13;
const EDGE_ALPHA = 0.5;
/** A gap that has been filled is over. It stays legible, and stops competing for the eye. */
const SPENT_FILL_ALPHA = 0.06;
const SPENT_EDGE_ALPHA = 0.34;

/** The type id `chart.addNativeIndicator()` takes. */
export const FVG_INDICATOR_TYPE = 'fvg';

const MITIGATION_LABELS: Record<string, FvgMitigation> = {
    'Fully crossed': 'full',
    'Midpoint (CE)': 'ce',
    'First touch': 'touch',
    'Closed beyond': 'break',
};

const SHOW_LABELS: Record<string, FvgShow> = {
    'Unfilled only': 'open',
    'Including filled': 'all',
};

const UNIT_LABELS: Record<string, FvgSizeUnit> = {
    Percent: 'percent',
    Points: 'points',
};

/** The session each toggle stands for, named as {@link computeSessionWindows} names it. */
const SESSION_NAMES = {
    sessionAsia: 'Asia',
    sessionLondon: 'London',
    sessionNewYork: 'New York',
} as const;

const DEFAULTS = {
    mitigation: 'First touch',
    show: 'Unfilled only',
    firstPresented: false,
    sessionAsia: true,
    sessionLondon: true,
    sessionNewYork: true,
    minSize: 0,
    minSizeUnit: 'Points',
    mergeWick: 0,
    lookback: 0,
    boxWidth: 10,
    bullColor: BULLISH,
    bearColor: BEARISH,
} as const;

function num(v: InputValue | undefined, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: InputValue | undefined, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function color(v: InputValue | undefined, fallback: string): string {
    return typeof v === 'string' && v !== '' ? v : fallback;
}

/**
 * One of a dropdown's own labels, translated to the detector's term.
 *
 * Throws on anything else rather than falling back to a default: a saved layout carrying a
 * label this build no longer has is a bug worth seeing, and the quiet version of it is zones
 * drawn under a rule nobody chose.
 */
function choice<T>(v: InputValue | undefined, labels: Record<string, T>, key: string): T {
    const hit = typeof v === 'string' ? labels[v] : undefined;
    if (hit === undefined) throw new Error(`fvg indicator: unknown ${key} "${String(v)}"`);
    return hit;
}

/**
 * The bar windows the first-presented mode is switched on for.
 *
 * Read off the raw bars rather than the trimmed ones the detector gets, because a session is a
 * wall-clock question and the timestamp is what answers it.
 */
function sessionWindows(bars: readonly OHLCV[], inputs: Record<string, InputValue>): FvgWindow[] {
    const wanted = new Set<string>();
    if (bool(inputs.sessionAsia, DEFAULTS.sessionAsia)) wanted.add(SESSION_NAMES.sessionAsia);
    if (bool(inputs.sessionLondon, DEFAULTS.sessionLondon)) wanted.add(SESSION_NAMES.sessionLondon);
    if (bool(inputs.sessionNewYork, DEFAULTS.sessionNewYork)) wanted.add(SESSION_NAMES.sessionNewYork);
    if (wanted.size === 0) return [];

    return computeSessionWindows(bars, 'futures')
        .filter((w) => wanted.has(w.name))
        .map((w) => ({ startIndex: w.startIndex, endIndex: w.endIndex }));
}

/** How the zones are painted. None of it changes what a zone is. */
export interface FvgViewOptions {
    /** Gaps left by a move up, which sit below price as support. */
    bullColor: string;
    /** …and by a move down, which sit above it as resistance. */
    bearColor: string;
    /** How many bars wide a box is drawn; 0 runs it to the right edge. */
    boxWidth: number;
    /** The dashed midpoint — consequent encroachment. */
    midline: boolean;
}

/**
 * Zones → chart geometry.
 *
 * Horizontal coordinates are bar TIMES, which the renderer places at the centre of their bar.
 * A box that is capped by width therefore needs a time for a bar that may not exist yet, and
 * the last spacing is carried forward for it — a cap on the newest gap must not silently snap
 * back to the last bar.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildFvgOutput(
    zones: readonly FvgZone[],
    times: readonly number[],
    view: FvgViewOptions,
): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    if (times.length === 0) return { boxes, lines };

    const last = times[times.length - 1]!;
    const spacing = times.length > 1 ? last - times[times.length - 2]! : 0;
    const capTime = (startIndex: number, width: number): number => {
        const i = startIndex + width;
        return i < times.length ? times[i]! : last + (i - (times.length - 1)) * spacing;
    };

    for (const zone of zones) {
        const spent = zone.mitigatedTime !== null;
        /* Whichever comes first: a zone that was filled ends there, and one capped by width
         * ends there. A zone with neither runs on. */
        const limits: number[] = [];
        if (zone.mitigatedTime !== null) limits.push(zone.mitigatedTime);
        if (view.boxWidth > 0) limits.push(capTime(zone.startIndex, view.boxWidth));

        const ink = zone.direction === 'bull' ? view.bullColor : view.bearColor;
        const id = `fvg_${zone.direction}_${zone.index}`;

        boxes.push({
            id,
            paneId: 'price',
            xloc: 'bar_time',
            overlay: true,
            left: zone.startTime,
            right: limits.length > 0 ? Math.min(...limits) : last,
            top: zone.top,
            bottom: zone.bottom,
            extend: limits.length > 0 ? 'none' : 'right',
            bgColor: withAlpha(ink, spent ? SPENT_FILL_ALPHA : FILL_ALPHA),
            borderColor: withAlpha(ink, spent ? SPENT_EDGE_ALPHA : EDGE_ALPHA),
            borderWidth: 1,
            borderStyle: spent ? 'dashed' : 'solid',
            textSize: 'auto',
            hAlign: 'center',
            vAlign: 'center',
            wrap: false,
            fontFamily: 'default',
            bold: false,
            italic: false,
        });

        if (!view.midline || spent) continue;

        const mid = (zone.top + zone.bottom) / 2;
        lines.push({
            id: `${id}_ce`,
            paneId: 'price',
            xloc: 'bar_time',
            overlay: true,
            x1: zone.startTime,
            y1: mid,
            x2: limits.length > 0 ? Math.min(...limits) : last,
            y2: mid,
            extend: limits.length > 0 ? 'none' : 'right',
            color: withAlpha(ink, EDGE_ALPHA),
            invisible: false,
            width: 1,
            style: 'dashed',
            arrowLeft: false,
            arrowRight: false,
        });
    }

    return { boxes, lines };
}

class FvgIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    /** Every new bar can open a zone, close one, or both. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* zones are read off the bar array, not off what is on screen */
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
        const raw = this.ctx.bars();
        const bars = raw.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
        const mitigation = choice(this.inputs.mitigation, MITIGATION_LABELS, 'mitigation');
        /* Off is undefined, not an empty list: no windows at all and windows nobody ticked are
         * different questions, and the detector answers the second one with nothing. */
        const firstIn = bool(this.inputs.firstPresented, DEFAULTS.firstPresented)
            ? sessionWindows(raw, this.inputs)
            : undefined;

        const zones = detectFairValueGaps(bars, {
            mitigation,
            show: choice(this.inputs.show, SHOW_LABELS, 'show'),
            minSize: num(this.inputs.minSize, DEFAULTS.minSize),
            minSizeUnit: choice(this.inputs.minSizeUnit, UNIT_LABELS, 'minSizeUnit'),
            mergeWick: num(this.inputs.mergeWick, DEFAULTS.mergeWick),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
            firstIn,
        });

        this.ctx.emit(buildFvgOutput(zones, bars.map((b) => b.time), {
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
            boxWidth: num(this.inputs.boxWidth, DEFAULTS.boxWidth),
            /* Only while it is the rule in force: under the other three settings a line across
             * the middle of every box would mean nothing. */
            midline: mitigation === 'ce',
        }));
    }
}

export const fvgDescriptor: NativeIndicatorDescriptor = {
    type: FVG_INDICATOR_TYPE,
    title: 'Fair Value Gaps',
    shortTitle: 'FVG',
    paneHint: 'price',
    overlay: true,
    // Two instances is how a bull-only and a bear-only reading, or two mitigation rules, sit on
    // one chart. Nothing here goes through the keyed native layer, so stacking is safe.
    multiInstance: true,
    /* Zones are context the candles are read against, spread over the whole history — folding
     * them into the scale would zoom the chart out to whatever gap is still standing lowest. */
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'mitigation',
            title: 'Filled when',
            type: 'string',
            defval: DEFAULTS.mitigation,
            options: Object.keys(MITIGATION_LABELS),
            tooltip: 'How far price has to come back before the zone counts as used up. The first three '
                + 'end it as soon as price reaches into it; "Closed beyond" needs a bar to close past it, '
                + 'so a retest leaves the zone standing.',
        },
        {
            key: 'show',
            title: 'Show',
            type: 'string',
            defval: DEFAULTS.show,
            options: Object.keys(SHOW_LABELS),
            tooltip: 'Whether zones that are already filled stay on the chart. Their box stops where they '
                + 'ended, so they mark the stretch they applied on rather than running to the edge.',
        },
        {
            key: 'firstPresented',
            title: 'First presented gap',
            type: 'bool',
            defval: DEFAULTS.firstPresented,
            tooltip: 'Draw only the first gap confirmed in each trading session, instead of every gap. '
                + 'The one a session-based desk trades. The three toggles below pick which sessions '
                + 'count; with none of them ticked this draws nothing.',
        },
        {
            key: 'sessionAsia',
            title: 'Asia',
            type: 'bool',
            defval: DEFAULTS.sessionAsia,
            tooltip: '09:00–15:00 Tokyo. Only used by "First presented gap".',
        },
        {
            key: 'sessionLondon',
            title: 'London',
            type: 'bool',
            defval: DEFAULTS.sessionLondon,
            tooltip: '08:00–16:30 London. Only used by "First presented gap".',
        },
        {
            key: 'sessionNewYork',
            title: 'New York',
            type: 'bool',
            defval: DEFAULTS.sessionNewYork,
            tooltip: '09:30–16:00 New York — the cash session, where the volume is. Only used by '
                + '"First presented gap".',
        },
        {
            key: 'minSize',
            title: 'Min size',
            type: 'float',
            defval: DEFAULTS.minSize,
            min: 0,
            max: 1e6,
            step: 0.05,
            tooltip: 'Ignore zones thinner than this. 0 keeps every one of them.',
        },
        {
            key: 'minSizeUnit',
            title: 'Measured in',
            type: 'string',
            defval: DEFAULTS.minSizeUnit,
            options: Object.keys(UNIT_LABELS),
            tooltip: 'How to read the two sizes it sits between. Percent measures against the price level '
                + 'the zone sits at, so it keeps meaning the same as price moves; points measure the raw '
                + 'distance in whatever the instrument is quoted in.',
        },
        {
            key: 'mergeWick',
            title: 'Merge across',
            type: 'float',
            defval: DEFAULTS.mergeWick,
            min: 0,
            max: 1e6,
            step: 0.01,
            tooltip: 'Treat gaps stacked on top of each other as one zone, as long as the traded strip '
                + 'between them is no wider than this and their bars run together. Read in the same unit '
                + 'as the minimum size. 0 keeps every gap separate.',
        },
        {
            key: 'lookback',
            title: 'Last bars',
            type: 'int',
            defval: DEFAULTS.lookback,
            min: 0,
            max: 5000,
            step: 10,
            tooltip: 'Only show zones confirmed within this many of the most recent bars, counted back '
                + 'from the newest one. 0 means no limit.',
        },
        {
            key: 'boxWidth',
            title: 'Box width',
            type: 'int',
            defval: DEFAULTS.boxWidth,
            min: 0,
            max: 500,
            step: 1,
            tooltip: 'How many bars wide the box is drawn, counted from the bars that formed the gap. '
                + '0 runs it on to the right edge until something ends it.',
        },
        {
            key: 'bullColor',
            title: 'Bull',
            type: 'color',
            defval: DEFAULTS.bullColor,
            tooltip: 'Gaps left by a move up, which sit below price as support.',
        },
        {
            key: 'bearColor',
            title: 'Bear',
            type: 'color',
            defval: DEFAULTS.bearColor,
            tooltip: 'Gaps left by a move down, which sit above price as resistance.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new FvgIndicator(),
};

/** Register the built-in fair value gap indicator (idempotent). Called by the composition root. */
export function registerFvg(): void {
    registerNativeIndicator(fvgDescriptor);
}
