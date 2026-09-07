import { registerNativeIndicator } from '../../../src';
import { DEFAULT_POSITION_STYLE, normalizeStyle, withAlpha, type PositionStyle } from '../trading/positionStyle';
import type {
    DrawingBox, DrawingLabel, DrawingLine, NativeIndicator, NativeIndicatorContext,
    NativeIndicatorOutput, PriceLine,
} from '../../../src';

/** The native-indicator type id the replay chart mounts. */
export const REPLAY_INDICATOR_TYPE = 'replay-position';

/** The same visuals on a live chart, under a type of its own — see {@link registerTradeIndicator}. */
export const TRADE_INDICATOR_TYPE = 'trade-position';

/** The visual half of the replay state — what the chart needs, nothing else. */
export interface ReplayVisualState {
    positions: Array<{
        id: number;
        side: 'buy' | 'sell';
        entryPrice: number;
        entryTime: number;
        stopPrice: number | null;
        targetPrice: number | null;
        /** Units held — the tag says what is on, not just which way. */
        size: number;
        /** Money on the table right now, and what the two levels are worth if they trade. */
        openPnl: number;
        stopPnl: number | null;
        targetPnl: number | null;
        /**
         * The same four numbers in R — the trade's own unit, fixed at the risk it opened with.
         * Null when it opened without a stop, since there is then no R to be measured in.
         */
        openR: number | null;
        stopR: number | null;
        targetR: number | null;
    }>;
    orders: Array<{
        id: number;
        side: 'buy' | 'sell';
        price: number;
        tag: string | null;
    }>;
    /**
     * Every order that has actually filled, in execution order.
     *
     * Positions and orders are what the account HOLDS, and both vanish the moment a trade is
     * done; these are what it DID, and they stay. Optional because a caller that never sends
     * them — an older state payload, a test about position geometry — is not a caller that
     * wants the marks erased from under it.
     */
    fills?: Array<{
        /** The filled order's id — unique per account, so the mark has a stable drawing id. */
        id: number;
        /** When it filled. Mid-bar fills sit mid-bar: the chart maps a time, not a bar. */
        time: number;
        price: number;
        side: 'buy' | 'sell';
    }>;
}

const EMPTY_STATE: ReplayVisualState = { positions: [], orders: [] };

/* Line ids double as the address the chart hands back when one is dragged or its button is
 * pressed, so they are built in one place and read back in another. */
export const entryLineId = (positionId: number): string => `pos_${positionId}_entry_lvl`;
export const stopLineId = (positionId: number): string => `pos_${positionId}_sl`;
export const targetLineId = (positionId: number): string => `pos_${positionId}_tp`;

/** `pos_12_sl` → what it is about. Null for anything that is not a position level. */
export function readLineId(id: string): { positionId: number; level: 'entry' | 'stop' | 'target' } | null {
    const m = /^pos_(\d+)_(entry_lvl|sl|tp)$/.exec(id);
    if (!m) return null;
    const level = m[2] === 'sl' ? 'stop' : m[2] === 'tp' ? 'target' : 'entry';
    return { positionId: Number(m[1]), level };
}

/** `+$224.93` / `−$820.13` — signed, because the sign is the whole point. */
function money(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return '';
    const sign = n < 0 ? '−' : '+';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** `+0.37R`, or nothing at all when the trade opened without a stop to measure against. */
function rMultiple(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return '';
    return `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}R`;
}

/** Units, without trailing zeros — `1`, `0.25`, `0.0625`. */
function formatSize(n: number): string {
    if (!Number.isFinite(n)) return '0';
    return n >= 100 ? n.toFixed(2) : String(Number(n.toPrecision(4)));
}

/* The neutral greys are not the position's own colours and are not settings: a resting order
 * is not a position, and the tag on a flat entry says "nothing either way" — see `pnlColor`. */
const NEUTRAL_COLOR = '#b2b5be';
const ORDER_COLOR = '#787b86';

/* A fill is a fact about an ORDER — which way it went — and it goes on being that fact long
 * after the position it opened has closed. So it is not painted in the position's colours, and
 * for the same reason as the two greys above it is not a setting: bought and sold are not a
 * matter of taste. */
const FILL_BUY_COLOR = '#089981';
const FILL_SELL_COLOR = '#f23645';

/**
 * The colour a figure gets for being what it is: green in profit, red in loss, and neutral at
 * exactly nothing — because a position that has not moved has not gone either way, and calling
 * that green would be the first lie in a long series of them.
 */
function pnlColor(n: number | null, style: PositionStyle): string {
    if (n == null || !Number.isFinite(n) || n === 0) return NEUTRAL_COLOR;
    return n > 0 ? style.targetColor : style.stopColor;
}

/**
 * One of the two areas a position spans, from its entry out to a level.
 *
 * The fill is strongest AT THE LEVEL and fades towards the entry, which is the direction the
 * area actually means something in: how far this is from where the trade is wrong (or done).
 * Which end that is follows from where the level sits, so a short's risk zone shades upwards
 * and a long's downwards without either being spelled out anywhere.
 *
 * Box defaults are all written out — the neutral model has no partials.
 */
function zone(id: string, left: number, right: number, entryPrice: number, levelPrice: number, color: string, style: PositionStyle): DrawingBox {
    const strong = withAlpha(color, style.zoneOpacity);
    const faded = withAlpha(color, 0);
    const levelOnTop = levelPrice > entryPrice;
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        left, right, top: Math.max(entryPrice, levelPrice), bottom: Math.min(entryPrice, levelPrice),
        extend: style.extendRight ? 'right' : 'none',
        bgColor: style.zoneGradient ? (levelOnTop ? strong : faded) : strong,
        ...(style.zoneGradient ? { bgColorTo: levelOnTop ? faded : strong } : {}),
        borderWidth: 0, borderStyle: 'solid',
        textSize: 'auto', hAlign: 'center', vAlign: 'center',
        wrap: false, fontFamily: 'default', bold: false, italic: false,
    };
}

function line(id: string, x1: number, x2: number, y: number, color: string, style: 'solid' | 'dashed' | 'dotted', extend: 'none' | 'right', width = 1): DrawingLine {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        x1, y1: y, x2, y2: y, extend, color,
        invisible: false, width, style, arrowLeft: false, arrowRight: false,
    };
}

/**
 * The mark left where an order filled: a small cross, on the candle, on the exact point the
 * trade happened — its upright stroke standing on the fill TIME, its crossbar lying on the fill
 * PRICE. Two readings of one event, which is what a fill is: a when and a what for.
 *
 * A point shape rather than a pair of drawn lines, because a cross of lines would be measured
 * in bars and in dollars and would therefore change size with every zoom. This one is painted
 * at a fixed handful of pixels whatever the chart is doing — small enough to leave the candle
 * readable, which is the point of marking the candle at all.
 */
function fillMark(fill: { id: number; time: number; price: number; side: 'buy' | 'sell' }): DrawingLabel {
    return {
        id: `fill_${fill.id}`, paneId: 'price', xloc: 'bar_time', x: fill.time,
        y: fill.price, yloc: 'price', style: 'cross',
        color: fill.side === 'buy' ? FILL_BUY_COLOR : FILL_SELL_COLOR,
        size: 'tiny', textAlign: 'center', fontFamily: 'default', overlay: true,
    };
}

/**
 * Turns the replay account into chart geometry: an open position becomes a risk
 * zone (entry→stop) and a reward zone (entry→target) running from its entry bar
 * to the playhead — or on to the right edge, where the trade is actually going —
 * with the entry line across it and the levels labelled on the price axis; a
 * resting order becomes a dashed line into the future only.
 *
 * `style` decides every colour, stroke and fill; it decides nothing about WHAT is
 * drawn except whether the two areas are drawn at all. Defaulted, so a caller with
 * no opinion — a test, a first frame before storage is read — still gets the
 * shipped look.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildReplayOutput(state: ReplayVisualState, nowTime: number, style: PositionStyle = DEFAULT_POSITION_STYLE): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const labels: DrawingLabel[] = [];
    const priceLines: PriceLine[] = [];
    const reach = style.extendRight ? 'right' as const : 'none' as const;

    for (const p of state.positions) {
        const right = Math.max(nowTime, p.entryTime);
        if (style.zones && p.stopPrice != null) boxes.push(zone(`pos_${p.id}_risk`, p.entryTime, right, p.entryPrice, p.stopPrice, style.stopColor, style));
        if (style.zones && p.targetPrice != null) boxes.push(zone(`pos_${p.id}_reward`, p.entryTime, right, p.entryPrice, p.targetPrice, style.targetColor, style));
        lines.push(line(`pos_${p.id}_entry`, p.entryTime, right, p.entryPrice, style.entryColor, style.entryStyle, reach, style.lineWidth));
        /* Each level says what it is WORTH, not just where it is: a stop at 93,805 is a number
         * you have to do arithmetic on, "−$820 −1.36R" is the thing you were actually deciding
         * about. The price itself goes on the axis, where prices belong. */
        priceLines.push({
            id: entryLineId(p.id),
            paneId: 'price',
            price: p.entryPrice,
            color: style.entryColor,
            lineStyle: 'dotted',
            title: `${p.side === 'buy' ? 'L' : 'S'} ${formatSize(p.size)}  ${money(p.openPnl)}  ${rMultiple(p.openR)}`,
            /* The line stays neutral and so does its price: the entry is where it is. Only the
             * tag moves with the money, because the money is the only part of it that does. */
            titleColor: pnlColor(p.openPnl, style),
            axisTag: true,
            /* The entry never moves — a position opened where it opened — but it is the handle
             * for everything done to the position as a whole: the button closes it, and a drag
             * off the line pulls out whichever of the two levels the drag was heading for. That
             * is the only place a position with no protection at all can be grabbed, and a stop
             * you have to open a panel to set is a stop that does not get set. */
            dragSpawns: true,
            action: 'close',
        });
        if (p.stopPrice != null) {
            priceLines.push({
                id: stopLineId(p.id), paneId: 'price', price: p.stopPrice, color: style.stopColor,
                lineStyle: style.levelStyle, width: style.lineWidth,
                title: `SL  ${money(p.stopPnl)}  ${rMultiple(p.stopR)}`, axisTag: true, draggable: true,
            });
        }
        if (p.targetPrice != null) {
            priceLines.push({
                id: targetLineId(p.id), paneId: 'price', price: p.targetPrice, color: style.targetColor,
                lineStyle: style.levelStyle, width: style.lineWidth,
                title: `TP  ${money(p.targetPnl)}  ${rMultiple(p.targetR)}`, axisTag: true, draggable: true,
            });
        }
    }

    // A resting order has not happened yet: it is only drawn ahead of the playhead.
    for (const o of state.orders) {
        lines.push(line(`ord_${o.id}`, nowTime, nowTime, o.price, ORDER_COLOR, 'dashed', 'right'));
        priceLines.push({
            id: `ord_${o.id}_lvl`, paneId: 'price', price: o.price, color: ORDER_COLOR,
            lineStyle: 'dotted', title: o.tag ?? o.side,
        });
    }

    /* Every fill the account has ever made, not just the open trade's: the marks are the record
     * of what was done, and a record that erased itself as trades closed would be blank exactly
     * when it is read. Switched off wholesale rather than thinned out — see `executions`. */
    if (style.executions) {
        for (const f of state.fills ?? []) labels.push(fillMark(f));
    }

    return { boxes, lines, labels, priceLines };
}

/**
 * The replay account's visuals, mounted as a native indicator.
 *
 * State arrives as JSON through a single string input: `setInput` is the only
 * channel into a running native instance, and `InputValue` is primitives only.
 * Deliberately not a user drawing — that would file every recomputed frame into
 * Vela's undo history alongside the user's own lines.
 */
class ReplayPositionIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private state: ReplayVisualState = EMPTY_STATE;
    private style: PositionStyle = DEFAULT_POSITION_STYLE;

    start(ctx: NativeIndicatorContext, inputs: Record<string, unknown>): void {
        this.ctx = ctx;
        this.apply(inputs);
    }

    /** Every revealed bar re-renders against the new playhead. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* not viewport-dependent */
    }

    setInputs(inputs: Record<string, unknown>): void {
        this.apply(inputs);
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

    private apply(inputs: Record<string, unknown>): void {
        const raw = inputs[STATE_INPUT];
        if (typeof raw === 'string' && raw.length > 0) {
            // A malformed payload must not take the chart down mid-replay; the last
            // good state simply stays on screen.
            try {
                this.state = JSON.parse(raw) as ReplayVisualState;
            } catch {
                /* keep the previous state */
            }
        }
        const rawStyle = inputs[STYLE_INPUT];
        if (typeof rawStyle === 'string' && rawStyle.length > 0) {
            /* Normalized rather than trusted: this arrives from the app's own stored record,
             * and a style that half-parses would paint a position in whatever it happened to
             * be missing. A broken payload leaves the last good style on screen. */
            try {
                this.style = normalizeStyle(JSON.parse(rawStyle));
            } catch {
                /* keep the previous style */
            }
        }
    }

    private emit(): void {
        if (!this.ctx) return;
        const bars = this.ctx.bars();
        const now = bars.length > 0 ? bars[bars.length - 1]!.time : Date.now();
        this.ctx.emit(buildReplayOutput(this.state, now, this.style));
    }
}

/** The single string input carrying the serialized account state. */
export const STATE_INPUT = 'stateJson';

/** The same channel for the drawing style — see {@link PositionStyle}. Its own input rather
 *  than a field on the state: the state is rewritten on every tick and the style almost never,
 *  and one of them being sent is no reason to resend the other. */
export const STYLE_INPUT = 'styleJson';

const registered = new Set<string>();

/** Registers one type once per process (the registry is process-wide). */
function register(type: string, title: string): void {
    if (registered.has(type)) return;
    registered.add(type);
    registerNativeIndicator({
        type,
        title,
        paneHint: 'price',
        overlay: true,
        multiInstance: false,
        // Deliberately empty: both inputs are machinery, not settings anyone edits by hand,
        // so neither appears in the indicator's own dialog. The style IS edited — in the
        // chart settings' Trading tab, through controls that know what a colour is.
        inputsSchema: () => [],
        defaultInputs: () => ({ [STATE_INPUT]: '{}', [STYLE_INPUT]: '{}' }),
        create: () => new ReplayPositionIndicator(),
    });
}

export function registerReplayIndicator(): void {
    register(REPLAY_INDICATOR_TYPE, 'Replay position');
}

/**
 * The same visuals for a LIVE account, under their own type and title.
 *
 * Same drawing, different sentence: on a replay chart the legend row saying
 * "Replay position" is the truth, and on a live chart it would be a claim that the
 * position in front of you is historical.
 */
export function registerTradeIndicator(): void {
    register(TRADE_INDICATOR_TYPE, 'Position');
}
