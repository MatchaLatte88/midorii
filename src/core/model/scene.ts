import type { Millis } from './time';
import type { OHLCV } from './ohlcv';
import type { SeriesSpec, LineStyle } from './series';
import type { DrawingLine, DrawingBox, DrawingLabel, DrawingPolyline, DrawingLinefill, DrawingTable } from './drawings';

export type PaneKind = 'price' | 'study';

export interface Pane {
    id: string;
    kind: PaneKind;
    /** Display order, top-to-bottom; the price pane is conventionally order 0. */
    order: number;
    /** Relative height weight among panes (the renderer normalizes). */
    heightWeight?: number;
    title?: string;
}

/** One bar's vertical gradient stop for a gradient `fill()` (color@price). */
export interface FillGradientStop {
    topValue: number;
    bottomValue: number;
    topColor: string;
    bottomColor: string;
}

/** A band fill between two value series (Pine `fill(plot1, plot2, ...)`). */
export interface Fill {
    id: string;
    paneId: string;
    /** RESOLVED series ids (the orchestrator resolves Pine plot refs to ids). */
    fromSeriesId: string;
    toSeriesId: string;
    /** Flat band color (no per-bar variation). */
    color?: string;
    /** Per-bar solid color (conditional fills), aligned to the anchor points by index. */
    colors?: Array<string | null>;
    /** Per-bar vertical gradient (gradient-fill overload), aligned by index. */
    gradient?: Array<FillGradientStop | null>;
    /** `force_overlay` → render on the price pane regardless of the indicator's pane. */
    overlay?: boolean;
}

/** A vertical background tint over a time span (Pine `bgcolor()` / session bands). */
export interface Background {
    id: string;
    paneId: string;
    /** Inclusive start, epoch ms. */
    from: Millis;
    /** Exclusive end, epoch ms. */
    to: Millis;
    color: string;
    /** `force_overlay` → render on the price pane regardless of the indicator's pane. */
    overlay?: boolean;
}

/** A horizontal price line (Pine `hline()`). */
export interface PriceLine {
    id: string;
    paneId: string;
    price: number;
    color?: string;
    lineStyle?: LineStyle;
    width?: number;
    /** Drawn as a tag riding the line at the right edge of the plot. Empty ⇒ no tag. */
    title?: string;
    /**
     * Visual treatment for the plot-side tag.
     *
     * `bracket` is the outlined, segmented trading treatment. The default stays the compact
     * filled badge used by ordinary indicator and alert price lines.
     */
    tagStyle?: 'bracket';
    /**
     * The tag's own colour, where it should differ from the line's.
     *
     * A level and what that level is currently WORTH are two different facts, and they do not
     * always agree: an entry sits where it sits — one neutral line, one neutral price on the
     * axis — while the money on it is up one minute and down the next. Colouring the line by
     * the second fact would repaint a level that never moved. Defaults to `color`.
     */
    titleColor?: string;
    /**
     * The line can be taken hold of and moved.
     *
     * Nothing moves in the chart's own state: the host is told where it was dropped
     * (`priceline:moved`) and decides what that means — a level belonging to an account or an
     * order is that owner's to change, and a line that moved itself would be telling the truth
     * about nothing. While the drag is live the line follows the cursor as a preview.
     */
    draggable?: boolean;
    /**
     * A drag on the line PULLS A NEW LEVEL OUT of it instead of moving it.
     *
     * The line itself never budges — it is the source, not the thing being placed. What the
     * drag reports (`priceline:spawned`) is a bare price, and its owner decides what came out:
     * a position's entry is one line that yields both a stop and a target, told apart by
     * nothing more than which way the drag went, because that is the only thing the person
     * doing it was thinking about.
     *
     * The preview is the same one a move draws: the source stays put and a second line follows
     * the cursor, which is already the truth for both gestures.
     *
     * A press that goes nowhere is a click, not a level — see the renderer's travel floor. That
     * matters more here than anywhere else: a stop spawned two pixels off an entry is a
     * position closing itself the moment the drag ends.
     */
    dragSpawns?: boolean;
    /**
     * A button on the tag. `close` draws an ✕ and reports `priceline:action` when pressed —
     * for the one destructive thing a level's owner usually offers (flatten, cancel).
     */
    action?: 'close';
    /** Also chip the line's own price against the price axis, the way the last price is. */
    axisTag?: boolean;
    /**
     * The tag itself is the thing to interact with — as opposed to a draggable level, whose
     * interaction is the drag. Right-clicking or double-clicking it then reports through
     * `priceline:contextmenu` / `priceline:dblclick` instead of falling through to the
     * chart's own context menu / double-click, the same way a right-click or double-click
     * over a DRAWING is claimed instead of opening the chart's. Absent/false ⇒ the tag has
     * no such claim: a right-click or double-click over it behaves exactly as if it were
     * not there (this is what every existing price line — a position's entry/stop/target,
     * a resting order — keeps by staying unset).
     */
    interactiveTag?: boolean;
}

/**
 * The renderer-neutral, full description of what to draw. In the engine-owned
 * design the orchestrator usually drives the renderer per-indicator
 * (`mountIndicator`), but `Scene` is the conceptual aggregate the reconciler
 * diffs against.
 */
export interface Scene {
    bars: OHLCV[];
    panes: Pane[];
    series: SeriesSpec[];
    fills: Fill[];
    backgrounds: Background[];
    priceLines: PriceLine[];
    lines?: DrawingLine[];
    boxes?: DrawingBox[];
    labels?: DrawingLabel[];
    polylines?: DrawingPolyline[];
    linefills?: DrawingLinefill[];
    tables?: DrawingTable[];
}
