import type { InputSchema, InputValue } from '../../model/inputs';
import type { DrawingBox, DrawingLine } from '../../model/drawings';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '../NativeIndicator';
import { registerNativeIndicator } from '../NativeIndicator';
import { STOPHUNT_DEFAULTS, detectStopHunts, type HuntSource, type StopHunt, type StopHuntShow } from '../../analysis/stophunt';
import type { SessionPreset } from '../../analysis/tradingSessions';
import { BEARISH, BULLISH } from '../../palette';
import { withAlpha } from '../../color';

/**
 * Every stop hunt on the chart — liquidity taken above a high or below a low, and given back.
 *
 * The detector is the one in `core/analysis/stophunt.ts`. Three moments, three marks, because
 * drawing a hunt as one box would throw away the two that make it readable:
 *
 *   the level   from where it formed to where it was run, dashed — how long that liquidity
 *               sat there in plain sight before someone took it.
 *   the raid    level to wick extreme, over the one bar that breached it. The actual hunt: the
 *               prices that only ever traded to fill stops resting behind the level.
 *   the window  from the breaching bar to the confirming one, drawn faint. Empty when the
 *               breaching bar itself closed back inside, and that is the point — its width is
 *               how long a trader spent not yet knowing whether this was a hunt or a break.
 *
 * A failed hunt — price later closed back through and the reclaim did not hold — keeps every
 * mark at reduced strength with a dashed read, the same vocabulary the range and FVG
 * indicators use for something that is over. It happened, and the marks already stop where it
 * ended.
 *
 * Opacity lives in the colour, not in a second alpha, for the reason the range indicator's
 * header gives: the drawing model has one colour per fill and per stroke.
 */

const LEVEL_ALPHA = 0.45;
const SPENT_LEVEL_ALPHA = 0.22;
const RAID_ALPHA = 0.22;
const SPENT_RAID_ALPHA = 0.1;
const WINDOW_ALPHA = 0.07;
const SPENT_WINDOW_ALPHA = 0.035;
const EDGE_ALPHA = 0.7;
const SPENT_EDGE_ALPHA = 0.4;

/** The type id `chart.addNativeIndicator()` takes. */
export const STOPHUNT_INDICATOR_TYPE = 'stophunt';

const SESSION_PRESET_LABELS: Record<string, SessionPreset> = { Futures: 'futures', Forex: 'forex' };
const SHOW_LABELS: Record<string, StopHuntShow> = { 'Including failed': 'all', 'Held only': 'active' };

const DEFAULTS = {
    useSwing: STOPHUNT_DEFAULTS.sources.includes('swing'),
    useEqualHighsLows: STOPHUNT_DEFAULTS.sources.includes('equal'),
    useSessions: STOPHUNT_DEFAULTS.sources.includes('session'),
    strength: STOPHUNT_DEFAULTS.strength,
    confirmBars: STOPHUNT_DEFAULTS.confirmBars,
    equalTolerance: STOPHUNT_DEFAULTS.equalTolerance,
    sessionPreset: 'Futures',
    minWick: STOPHUNT_DEFAULTS.minWick,
    holdBars: STOPHUNT_DEFAULTS.holdBars,
    show: 'Including failed',
    lookback: STOPHUNT_DEFAULTS.lookback,
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
 * Throws on anything else rather than falling back to a default — see the same note on
 * `fvg`'s `choice()`.
 */
function choice<T>(v: InputValue | undefined, labels: Record<string, T>, key: string): T {
    const hit = typeof v === 'string' ? labels[v] : undefined;
    if (hit === undefined) throw new Error(`stophunt indicator: unknown ${key} "${String(v)}"`);
    return hit;
}

/** The three source toggles, translated into the detector's `sources` list. */
function sourcesOf(inputs: Record<string, InputValue>): HuntSource[] {
    const out: HuntSource[] = [];
    if (bool(inputs.useSwing, DEFAULTS.useSwing)) out.push('swing');
    if (bool(inputs.useEqualHighsLows, DEFAULTS.useEqualHighsLows)) out.push('equal');
    if (bool(inputs.useSessions, DEFAULTS.useSessions)) out.push('session');
    return out;
}

/** How the hunts are painted. None of it changes what a hunt is. */
export interface StopHuntViewOptions {
    /** The mark on a hunt that took buy-side liquidity and turned down. */
    bearColor: string;
    /** …and one that took sell-side liquidity and turned up. */
    bullColor: string;
}

/** A line at one price across one stretch of time. */
function edge(id: string, x1: number, x2: number, y: number, ink: string, style: 'solid' | 'dashed'): DrawingLine {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        x1, y1: y, x2, y2: y, extend: 'none', color: ink,
        invisible: false, width: 1, style, arrowLeft: false, arrowRight: false,
    };
}

/** A filled rectangle with no border of its own. */
function area(id: string, left: number, right: number, a: number, b: number, bgColor: string): DrawingBox {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        left, right, top: Math.max(a, b), bottom: Math.min(a, b),
        extend: 'none', bgColor, borderWidth: 0, borderStyle: 'solid',
        textSize: 'auto', hAlign: 'center', vAlign: 'center',
        wrap: false, fontFamily: 'default', bold: false, italic: false,
    };
}

/** The bar time at `index`, extrapolated past the last bar with its own spacing — the same
 *  technique `fvg`'s `capTime` uses, for the same reason: a mark near the right edge must
 *  still be placeable a few bars past the last one loaded. */
function timeAt(times: readonly number[], index: number): number {
    if (times.length === 0) return 0;
    const last = times.length - 1;
    if (index <= last) return times[index]!;
    const spacing = times.length > 1 ? times[last]! - times[last - 1]! : 0;
    return times[last]! + (index - last) * spacing;
}

/**
 * Hunts → chart geometry. `times` is the bar array the hunts were detected in — see
 * {@link timeAt}.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildStopHuntOutput(hunts: readonly StopHunt[], times: readonly number[], view: StopHuntViewOptions): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];

    for (const h of hunts) {
        const failed = h.invalidatedIndex !== null;
        const ink = h.direction === 'bull' ? view.bullColor : view.bearColor;
        const id = `stophunt_${h.side}_${h.levelIndex}_${h.sweepIndex}`;

        const top = Math.max(h.level, h.extreme);
        const bottom = Math.min(h.level, h.extreme);
        const raidRight = timeAt(times, h.sweepIndex + 1);
        const windowRight = h.index > h.sweepIndex ? timeAt(times, h.index + 1) : raidRight;

        // The level itself: how long the liquidity sat there in plain sight.
        if (h.sweepTime > h.levelTime) {
            lines.push(edge(`${id}_level`, h.levelTime, h.sweepTime, h.level, withAlpha(ink, failed ? SPENT_LEVEL_ALPHA : LEVEL_ALPHA), 'dashed'));
        }

        // The window: bars spent not yet knowing whether this was a hunt or a break.
        if (windowRight > raidRight) {
            boxes.push(area(`${id}_window`, raidRight, windowRight, top, bottom, withAlpha(ink, failed ? SPENT_WINDOW_ALPHA : WINDOW_ALPHA)));
        }

        // The raid: the one bar that only ever traded to fill the stops behind the level.
        boxes.push(area(`${id}_raid`, h.sweepTime, raidRight, top, bottom, withAlpha(ink, failed ? SPENT_RAID_ALPHA : RAID_ALPHA)));

        /* The read: the price anyone actually trades against, drawn solid across the raid and
         * the window both — the one mark that says where the hunt happened. */
        lines.push(edge(`${id}_edge`, h.sweepTime, windowRight, h.level, withAlpha(ink, failed ? SPENT_EDGE_ALPHA : EDGE_ALPHA), failed ? 'dashed' : 'solid'));
    }

    return { boxes, lines };
}

class StopHuntIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private inputs: Record<string, InputValue> = { ...DEFAULTS };

    start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
        this.ctx = ctx;
        this.inputs = { ...DEFAULTS, ...inputs };
        this.emit();
    }

    /** Every new bar can open a level, sweep one, confirm a reclaim, or invalidate one. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* hunts are read off the bar array, not off what is on screen */
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
        const bars = this.ctx.bars();
        const hunts = detectStopHunts(bars, {
            sources: sourcesOf(this.inputs),
            strength: num(this.inputs.strength, DEFAULTS.strength),
            confirmBars: num(this.inputs.confirmBars, DEFAULTS.confirmBars),
            equalTolerance: num(this.inputs.equalTolerance, DEFAULTS.equalTolerance),
            sessionPreset: choice(this.inputs.sessionPreset, SESSION_PRESET_LABELS, 'sessionPreset'),
            minWick: num(this.inputs.minWick, DEFAULTS.minWick),
            holdBars: num(this.inputs.holdBars, DEFAULTS.holdBars),
            show: choice(this.inputs.show, SHOW_LABELS, 'show'),
            lookback: num(this.inputs.lookback, DEFAULTS.lookback),
        });
        this.ctx.emit(buildStopHuntOutput(hunts, bars.map((b) => b.time), {
            bullColor: color(this.inputs.bullColor, DEFAULTS.bullColor),
            bearColor: color(this.inputs.bearColor, DEFAULTS.bearColor),
        }));
    }
}

export const stopHuntDescriptor: NativeIndicatorDescriptor = {
    type: STOPHUNT_INDICATOR_TYPE,
    title: 'Stop Hunts',
    shortTitle: 'Stop Hunt',
    paneHint: 'price',
    overlay: true,
    // Two instances is how a swing-only and a session-only reading sit on one chart.
    multiInstance: true,
    /* Hunts are context the candles are read against, spread over the whole history —
     * folding them into the scale would zoom the chart out to whatever wick reached furthest. */
    autoscaleDrawings: false,
    inputsSchema: (): InputSchema[] => [
        {
            key: 'useSwing',
            title: 'Swings',
            type: 'bool',
            defval: DEFAULTS.useSwing,
            tooltip: 'Watch fractal swing highs and lows. The universal case — every timeframe has them.',
        },
        {
            key: 'useEqualHighsLows',
            title: 'Equal highs/lows',
            type: 'bool',
            defval: DEFAULTS.useEqualHighsLows,
            tooltip: 'Watch clusters of swings at the same price. The real stop cluster: one obvious '
                + 'line with several visits stacked behind it, and far rarer than a single swing.',
        },
        {
            key: 'useSessions',
            title: 'Session highs/lows',
            type: 'bool',
            defval: DEFAULTS.useSessions,
            tooltip: 'Watch the high and low of each completed trading session. Few, watched by an '
                + 'entire desk, and the reason the Asia range gets run at the London open.',
        },
        {
            key: 'strength',
            title: 'Swing strength',
            type: 'int',
            defval: DEFAULTS.strength,
            min: 1,
            max: 50,
            step: 1,
            tooltip: 'How many bars either side must be lower for a high to count as a swing. Larger '
                + 'finds fewer and more significant levels — and takes that many more bars before one '
                + 'is known, because the right-hand side has to close first.',
        },
        {
            key: 'confirmBars',
            title: 'Reclaim within',
            type: 'int',
            defval: DEFAULTS.confirmBars,
            min: 1,
            max: 100,
            step: 1,
            tooltip: 'How many bars price has to close back inside within, counted from the bar that '
                + 'breached the level. 1 is the strict reading: wick through and body back on one '
                + 'candle. Higher catches slower hunts and confirms them that much later.',
        },
        {
            key: 'equalTolerance',
            title: 'Equal within',
            type: 'float',
            defval: DEFAULTS.equalTolerance,
            min: 0,
            max: 10,
            step: 0.01,
            tooltip: 'How far apart two swings may be and still count as the same level, as a '
                + 'percentage of price. Only used by the Equal highs/lows source. 0 demands an exact match.',
        },
        {
            key: 'sessionPreset',
            title: 'Sessions',
            type: 'string',
            defval: DEFAULTS.sessionPreset,
            options: Object.keys(SESSION_PRESET_LABELS),
            tooltip: 'Which desk’s sessions provide the session source. Only used by Session highs/lows.',
        },
        {
            key: 'minWick',
            title: 'Min penetration',
            type: 'float',
            defval: DEFAULTS.minWick,
            min: 0,
            max: 100,
            step: 0.01,
            tooltip: 'How far past the level the wick must reach, as a percentage of price. Filters out '
                + 'bars that grazed the level by a tick without reaching the stops behind it. 0 counts '
                + 'any breach.',
        },
        {
            key: 'holdBars',
            title: 'Must hold for',
            type: 'int',
            defval: DEFAULTS.holdBars,
            min: 0,
            max: 500,
            step: 1,
            tooltip: 'How many bars after the reclaim price still has to respect the level. Closing back '
                + 'through it inside this window means the hunt failed; doing so long afterwards means '
                + 'nothing. 0 keeps every hunt on trial forever, which marks almost all of them failed.',
        },
        {
            key: 'show',
            title: 'Show',
            type: 'string',
            defval: DEFAULTS.show,
            options: Object.keys(SHOW_LABELS),
            tooltip: 'Whether hunts price later closed back through stay on the chart. Those are the '
                + 'ones that failed — the reclaim did not hold and the level broke after all.',
        },
        {
            key: 'lookback',
            title: 'Last bars',
            type: 'int',
            defval: DEFAULTS.lookback,
            min: 0,
            max: 5000,
            step: 10,
            tooltip: 'Only show hunts confirmed within this many of the most recent bars, counted back '
                + 'from the newest one. 0 means no limit.',
        },
        {
            key: 'bullColor',
            title: 'Bull',
            type: 'color',
            defval: DEFAULTS.bullColor,
            tooltip: 'Colour for a low that was run and reclaimed — sell-side liquidity taken, price expected up.',
        },
        {
            key: 'bearColor',
            title: 'Bear',
            type: 'color',
            defval: DEFAULTS.bearColor,
            tooltip: 'Colour for a high that was run and reclaimed — buy-side liquidity taken, price expected down.',
        },
    ],
    defaultInputs: (): Record<string, InputValue> => ({ ...DEFAULTS }),
    create: () => new StopHuntIndicator(),
};

/** Register the built-in stop hunt indicator (idempotent). Called by the composition root. */
export function registerStopHunt(): void {
    registerNativeIndicator(stopHuntDescriptor);
}
