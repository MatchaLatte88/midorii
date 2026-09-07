import type { InputSchema, InputValue } from '../../model/inputs';
import type { DrawingBox, DrawingLine } from '../../model/drawings';
import type { OHLCV } from '../../model/ohlcv';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';
import {
    SILVER_BULLET_DEFAULTS,
    detectSilverBullet,
    type SilverBulletScope,
    type SilverBulletSetup,
    type SilverBulletShow,
    type SilverBulletWindowId,
} from '../../analysis/silverBullet';
import type { FvgSizeUnit } from '../../analysis/fvg';
import { BEARISH, BULLISH, INVALID, VALID } from '../../palette';
import { withAlpha } from '../../color';

/**
 * Silver Bullet setups on the chart — a sweep, a gap, a shift and a retest, inside one hour.
 *
 * The detector is the one in `core/analysis/silverBullet.ts`, which reads its sweeps and gaps
 * from the same two files the Stop Hunt and FVG indicators paint. Nothing is re-detected here:
 * a setup can never sit on a level another indicator disagrees about.
 *
 * A setup is a story with an outcome, so it is drawn as two joined parts rather than one box:
 *
 *   the run-up   the wick that took the liquidity, and the gap the reversal left behind. In
 *                the setup's direction colour, because that half is about which way the market
 *                turned.
 *   the block    risk zone, reward zone and the entry line, from the fill onwards. The same
 *                shape the position drawing tool makes, and deliberately so: a setup the chart
 *                found and a trade planned by hand should not need two visual vocabularies.
 *
 * Colour follows that tool's rule — the stop side takes the loss colour and the target side
 * the profit colour, so a short reads the same way round as a long. Direction colour belongs
 * to the run-up, outcome colour to the block, and the two never mix.
 *
 * Setups price never came back to
 * -------------------------------
 * A setup is confirmed at the structure shift, before anyone knows whether price returns to
 * the gap. Those that it never returned to have no block — there was no trade — and are drawn
 * as the gap plus a dashed line at the price the order was waiting at, running to the bar the
 * order would have come off on. Off by default, because a chart of orders that never filled is
 * not what most people are looking for; on, it is the honest picture of how often this setup
 * asks you to wait for nothing.
 *
 * Opacity lives in the colour, not in a second alpha — the drawing model has one colour per
 * fill and per stroke, and multiplying two alphas is how a box asked for at 0.13 comes out at
 * 0.017.
 */

/** The gap is ground the candles are read against, not a mark. */
const GAP_FILL_ALPHA = 0.14;
const GAP_EDGE_ALPHA = 0.5;
/** The risk and reward zones, which carry the eye and so sit above the gap. */
const ZONE_FILL_ALPHA = 0.055;
const ZONE_EDGE_FILL_ALPHA = 0.2;
const LEVEL_ALPHA = 0.75;
const ENTRY_ALPHA = 0.55;
/** A setup that lost, or one whose order expired, is over. It stays legible and stops
 *  competing for the eye. */
const SPENT = 0.45;

/** The type id `chart.addNativeIndicator()` takes. */
export const SILVER_BULLET_INDICATOR_TYPE = 'silverbullet';

const SCOPE_LABELS: Record<string, SilverBulletScope> = { 'Signal only': 'signal', Everything: 'all' };
const SHOW_LABELS: Record<string, SilverBulletShow> = { 'Taken only': 'taken', 'Including unfilled': 'all' };
const UNIT_LABELS: Record<string, FvgSizeUnit> = { Points: 'points', Percent: 'percent' };

const DEFAULTS = {
    useLondon: SILVER_BULLET_DEFAULTS.windows.includes('london'),
    useAm: SILVER_BULLET_DEFAULTS.windows.includes('am'),
    usePm: SILVER_BULLET_DEFAULTS.windows.includes('pm'),
    scope: 'Signal only',
    strength: SILVER_BULLET_DEFAULTS.strength,
    confirmBars: SILVER_BULLET_DEFAULTS.confirmBars,
    maxSweepToGap: SILVER_BULLET_DEFAULTS.maxSweepToGap,
    maxGapToEntry: SILVER_BULLET_DEFAULTS.maxGapToEntry,
    minGapSize: SILVER_BULLET_DEFAULTS.minGapSize,
    minGapSizeUnit: 'Points',
    mergeWick: SILVER_BULLET_DEFAULTS.mergeWick,
    rrr: SILVER_BULLET_DEFAULTS.rrr,
    show: 'Taken only',
    lookback: SILVER_BULLET_DEFAULTS.lookback,
    bullColor: BULLISH,
    bearColor: BEARISH,
    profitColor: VALID,
    lossColor: INVALID,
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
 * Throws on anything else rather than falling back to a default — see the same note on `fvg`'s
 * `choice()`.
 */
function choice<T>(v: InputValue | undefined, labels: Record<string, T>, key: string): T {
    const hit = typeof v === 'string' ? labels[v] : undefined;
    if (hit === undefined) throw new Error(`silverbullet indicator: unknown ${key} "${String(v)}"`);
    return hit;
}

/** The three hour toggles, translated into the detector's `windows` list. */
function windowsOf(inputs: Record<string, InputValue>): SilverBulletWindowId[] {
    const out: SilverBulletWindowId[] = [];
    if (bool(inputs.useLondon, DEFAULTS.useLondon)) out.push('london');
    if (bool(inputs.useAm, DEFAULTS.useAm)) out.push('am');
    if (bool(inputs.usePm, DEFAULTS.usePm)) out.push('pm');
    return out;
}

/** How the setups are painted. None of it changes what a setup is. */
export interface SilverBulletViewOptions {
    /** The run-up of a setup that follows a low being swept. */
    bullColor: string;
    /** …and one that follows a high being swept. */
    bearColor: string;
    /** The reward zone, whichever way the trade points. */
    profitColor: string;
    /** The risk zone. */
    lossColor: string;
}

/** A line at one price across one stretch of time. */
function level(id: string, x1: number, x2: number, y: number, ink: string, style: 'solid' | 'dashed', width = 1): DrawingLine {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        x1, y1: y, x2, y2: y, extend: 'none', color: ink,
        invisible: false, width, style, arrowLeft: false, arrowRight: false,
    };
}

/** A rectangle between two prices. `bgColorTo` is set on the zones so the wash is strongest at
 *  the entry edge — the level the zone is measured from — and fades towards the level it ends
 *  at, which is what the gradient exists for. */
function area(id: string, left: number, right: number, a: number, b: number, opts: {
    bgColor?: string; bgColorTo?: string; borderColor?: string; borderStyle?: 'solid' | 'dashed';
    extend?: 'none' | 'right'; text?: string; textColor?: string; hAlign?: 'left' | 'center'; vAlign?: 'top' | 'center' | 'bottom';
}): DrawingBox {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        left, right, top: Math.max(a, b), bottom: Math.min(a, b),
        extend: opts.extend ?? 'none',
        bgColor: opts.bgColor,
        bgColorTo: opts.bgColorTo,
        borderColor: opts.borderColor,
        borderWidth: opts.borderColor === undefined ? 0 : 1,
        borderStyle: opts.borderStyle ?? 'solid',
        text: opts.text,
        textColor: opts.textColor,
        textSize: 'auto',
        hAlign: opts.hAlign ?? 'center',
        vAlign: opts.vAlign ?? 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

/** The bar time at `index`, extrapolated past the last bar with its own spacing — the same
 *  technique `fvg`'s `capTime` uses, and for the same reason: a mark near the right edge must
 *  still be placeable a few bars past the last one loaded. */
function timeAt(times: readonly number[], index: number): number {
    if (times.length === 0) return 0;
    const last = times.length - 1;
    if (index <= last) return times[index]!;
    const spacing = times.length > 1 ? times[last]! - times[last - 1]! : 0;
    return times[last]! + (index - last) * spacing;
}

/**
 * Setups → chart geometry. `times` is the bar array the setups were detected in — see
 * {@link timeAt}.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildSilverBulletOutput(setups: readonly SilverBulletSetup[], times: readonly number[], view: SilverBulletViewOptions): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    if (times.length === 0) return { boxes, lines };

    const lastTime = times[times.length - 1]!;

    for (const setup of setups) {
        const ink = setup.direction === 'bull' ? view.bullColor : view.bearColor;
        const spent = setup.outcome === 'stop' || setup.outcome === 'expired';
        const dim = (alpha: number): number => (spent ? alpha * SPENT : alpha);
        const id = `sb_${setup.direction}_${setup.index}`;

        /* The gap stops where the trade began: past the fill it is no longer a level being
         * waited for. An order that never filled keeps its gap to the bar it came off on. */
        const gapRight = setup.fillTime ?? Math.min(setup.expiryTime, timeAt(times, setup.expiryIndex));
        boxes.push(area(`${id}_gap`, timeAt(times, setup.gapStartIndex), gapRight, setup.gapTop, setup.gapBottom, {
            bgColor: withAlpha(ink, dim(GAP_FILL_ALPHA)),
            borderColor: withAlpha(ink, dim(GAP_EDGE_ALPHA)),
        }));

        /* The wick that took the liquidity — where the whole setup started, and the price the
         * stop is measured from. */
        lines.push(level(`${id}_sweep`, setup.sweepTime, timeAt(times, setup.sweepIndex + 1), setup.sweepExtreme, withAlpha(ink, dim(LEVEL_ALPHA)), 'solid', 2));

        if (setup.fillTime === null) {
            /* No block: nothing was traded. What there is to show is the price the order was
             * waiting at and how long it waited. */
            lines.push(level(`${id}_resting`, setup.time, timeAt(times, setup.expiryIndex), setup.entryPrice, withAlpha(ink, dim(ENTRY_ALPHA)), 'dashed'));
            continue;
        }

        // The block ends where the trade ended; one still running carries on to the right edge.
        const open = setup.outcomeTime === null;
        const blockRight = setup.outcomeTime ?? lastTime;
        const extend = open ? 'right' : 'none';
        const long = setup.direction === 'bull';

        boxes.push(area(`${id}_risk`, setup.fillTime, blockRight, setup.entryPrice, setup.stop, {
            // Strongest at the entry: for a long the stop is below, so the wash grows downward.
            bgColor: withAlpha(view.lossColor, dim(long ? ZONE_FILL_ALPHA : ZONE_EDGE_FILL_ALPHA)),
            bgColorTo: withAlpha(view.lossColor, dim(long ? ZONE_EDGE_FILL_ALPHA : ZONE_FILL_ALPHA)),
            extend,
        }));
        boxes.push(area(`${id}_reward`, setup.fillTime, blockRight, setup.entryPrice, setup.target, {
            bgColor: withAlpha(view.profitColor, dim(long ? ZONE_EDGE_FILL_ALPHA : ZONE_FILL_ALPHA)),
            bgColorTo: withAlpha(view.profitColor, dim(long ? ZONE_FILL_ALPHA : ZONE_EDGE_FILL_ALPHA)),
            extend,
            text: `${setup.windowLabel} · ${setup.rrr}R`,
            textColor: withAlpha(view.profitColor, dim(1)),
            hAlign: 'left',
            vAlign: long ? 'top' : 'bottom',
        }));

        lines.push(level(`${id}_stop`, setup.fillTime, blockRight, setup.stop, withAlpha(view.lossColor, dim(LEVEL_ALPHA)), 'solid'));
        lines.push(level(`${id}_target`, setup.fillTime, blockRight, setup.target, withAlpha(view.profitColor, dim(LEVEL_ALPHA)), 'solid'));
        // The entry is where the trade started, so it is dashed rather than solid.
        lines.push(level(`${id}_entry`, setup.fillTime, blockRight, setup.entryPrice, withAlpha(ink, dim(ENTRY_ALPHA)), 'dashed'));
    }

    return { boxes, lines };
}

class SilverBulletIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    /** Every new bar can arm a setup, fill one, or resolve one. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* setups are read off the bar array, not off what is on screen */
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
        const bars: readonly OHLCV[] = this.ctx.bars();
        const setups = detectSilverBullet(bars, {
            windows: windowsOf(this.inputs),
            scope: choice(this.inputs.scope, SCOPE_LABELS, 'scope'),
            strength: num(this.inputs.strength, DEFAULTS.strength),
            confirmBars: num(this.inputs.confirmBars, DEFAULTS.confirmBars),
            maxSweepToGap: num(this.inputs.maxSweepToGap, DEFAULTS.maxSweepToGap),
            maxGapToEntry: num(this.inputs.maxGapToEntry, DEFAULTS.maxGapToEntry),
            minGapSize: num(this.inputs.minGapSize, DEFAULTS.minGapSize),
            minGapSizeUnit: choice(this.inputs.minGapSizeUnit, UNIT_LABELS, 'minGapSizeUnit'),
            mergeWick: num(this.inputs.mergeWick, DEFAULTS.mergeWick),
            rrr: num(this.inputs.rrr, DEFAULTS.rrr),
            show: choice(this.inputs.show, SHOW_LABELS, 'show'),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
        });

        this.ctx.emit(buildSilverBulletOutput(setups, bars.map((b) => b.time), {
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
            profitColor: color(this.inputs.profitColor, DEFAULTS.profitColor),
            lossColor: color(this.inputs.lossColor, DEFAULTS.lossColor),
        }));
    }
}

export const silverBulletDescriptor: NativeIndicatorDescriptor = {
    type: SILVER_BULLET_INDICATOR_TYPE,
    title: 'Silver Bullet',
    shortTitle: 'Silver Bullet',
    paneHint: 'price',
    overlay: true,
    // Two instances is how one reading of the London hour and one of the AM sit on one chart.
    multiInstance: true,
    /* A setup carries a stop and a target that can sit far from the candles around it — folding
     * them into the scale would zoom the chart out to whichever target reached furthest. */
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'useLondon',
            title: 'London 03:00',
            type: 'bool',
            defval: DEFAULTS.useLondon,
            tooltip: 'The London open hour, 03:00-04:00 New York time.',
        },
        {
            key: 'useAm',
            title: 'NY AM 10:00',
            type: 'bool',
            defval: DEFAULTS.useAm,
            tooltip: 'The New York morning hour, 10:00-11:00 New York time — the one most people mean.',
        },
        {
            key: 'usePm',
            title: 'NY PM 14:00',
            type: 'bool',
            defval: DEFAULTS.usePm,
            tooltip: 'The New York afternoon hour, 14:00-15:00 New York time.',
        },
        {
            key: 'scope',
            title: 'Inside the hour',
            type: 'string',
            defval: DEFAULTS.scope,
            options: Object.keys(SCOPE_LABELS),
            tooltip: 'How much of the setup has to fall inside the hour. The signal — the structure '
                + 'shift, where the order goes in — always does; "Everything" also demands the sweep '
                + 'and the gap, which is far stricter because the sweep often happens before the '
                + 'window opens.',
        },
        {
            key: 'strength',
            title: 'Swing strength',
            type: 'int',
            defval: DEFAULTS.strength,
            min: 1,
            max: 50,
            step: 1,
            tooltip: 'How many bars either side must be lower for a high to count as liquidity worth '
                + 'sweeping. Larger finds fewer and more significant levels.',
        },
        {
            key: 'confirmBars',
            title: 'Reclaim within',
            type: 'int',
            defval: DEFAULTS.confirmBars,
            min: 1,
            max: 100,
            step: 1,
            tooltip: 'How many bars price has to close back inside the swept level within, counted '
                + 'from the bar that breached it. 1 demands wick through and body back on one candle.',
        },
        {
            key: 'maxSweepToGap',
            title: 'Sweep → gap',
            type: 'int',
            defval: DEFAULTS.maxSweepToGap,
            min: 1,
            max: 200,
            step: 1,
            tooltip: 'How many bars the gap may lag the sweep by. The two belong to one move, so a '
                + 'gap that shows up much later is a different move that happens to point the same way.',
        },
        {
            key: 'maxGapToEntry',
            title: 'Gap → entry',
            type: 'int',
            defval: DEFAULTS.maxGapToEntry,
            min: 1,
            max: 200,
            step: 1,
            tooltip: 'How long the order rests at the gap edge before it comes off. A gap price '
                + 'ignores for this long is no longer the level that was left behind by this move.',
        },
        {
            key: 'minGapSize',
            title: 'Min gap size',
            type: 'float',
            defval: DEFAULTS.minGapSize,
            min: 0,
            max: 1e6,
            step: 0.5,
            tooltip: 'Ignore gaps thinner than this. A gap too small to hold a stop is not a setup, '
                + 'whatever else lines up around it. 0 keeps every one of them.',
        },
        {
            key: 'minGapSizeUnit',
            title: 'Measured in',
            type: 'string',
            defval: DEFAULTS.minGapSizeUnit,
            options: Object.keys(UNIT_LABELS),
            tooltip: 'How the minimum size and the merge width are read. Points are the raw distance '
                + 'the instrument is quoted in — what you size a stop in; percent keeps its meaning '
                + 'as price moves.',
        },
        {
            key: 'mergeWick',
            title: 'Merge stacked gaps',
            type: 'float',
            defval: DEFAULTS.mergeWick,
            min: 0,
            max: 1e6,
            step: 0.5,
            tooltip: 'How wide a traded strip may be before two gaps left by the same impulse count '
                + 'as separate zones. An impulse rarely leaves one gap; merging them reads the run as '
                + 'the single imbalance a trader sees. 0 keeps every gap apart.',
        },
        {
            key: 'rrr',
            title: 'Reward : risk',
            type: 'float',
            defval: DEFAULTS.rrr,
            min: 0.1,
            max: 20,
            step: 0.1,
            tooltip: 'Where the target sits, as a multiple of the distance from entry to stop. The '
                + 'stop itself is always just beyond the wick that took the liquidity.',
        },
        {
            key: 'show',
            title: 'Show',
            type: 'string',
            defval: DEFAULTS.show,
            options: Object.keys(SHOW_LABELS),
            tooltip: 'Whether setups price never came back to stay on the chart. They are real — the '
                + 'order rested and expired — and are drawn as the gap plus the price it was waiting '
                + 'at, with no risk or reward zone, because nothing was traded.',
        },
        {
            key: 'lookback',
            title: 'Last bars',
            type: 'int',
            defval: DEFAULTS.lookback,
            min: 0,
            max: 5000,
            step: 10,
            tooltip: 'Only show setups confirmed within this many of the most recent bars, counted '
                + 'back from the newest one. 0 means no limit.',
        },
        {
            key: 'bullColor',
            title: 'Long',
            type: 'color',
            defval: DEFAULTS.bullColor,
            tooltip: 'The run-up of a setup that follows a low being swept — sell-side liquidity '
                + 'taken, price expected up.',
        },
        {
            key: 'bearColor',
            title: 'Short',
            type: 'color',
            defval: DEFAULTS.bearColor,
            tooltip: 'The run-up of a setup that follows a high being swept — buy-side liquidity '
                + 'taken, price expected down.',
        },
        {
            key: 'profitColor',
            title: 'Reward zone',
            type: 'color',
            defval: DEFAULTS.profitColor,
            tooltip: 'Entry to target. Colour means outcome here, not direction, so a short reads '
                + 'the same way round as a long.',
        },
        {
            key: 'lossColor',
            title: 'Risk zone',
            type: 'color',
            defval: DEFAULTS.lossColor,
            tooltip: 'Entry to stop — what the trade costs if the level that was swept holds after all.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new SilverBulletIndicator(),
};

/** Register the built-in Silver Bullet indicator (idempotent). Called by the composition root. */
export function registerSilverBullet(): void {
    registerNativeIndicator(silverBulletDescriptor);
}
