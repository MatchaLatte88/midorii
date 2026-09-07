/**
 * Where a price line's tag and its button sit, and what a pointer at (x, y) has hold of.
 *
 * Geometry only, in one place, because the chrome PAINTS these and the input layer HITS them:
 * a button that liquidates a position must be exactly where it looks like it is, and two copies
 * of "20px in from the right edge" is how that stops being true. Pure arithmetic — no canvas
 * state beyond measuring a string — so the answers can be asserted without a chart.
 */
import type { PriceLine } from '../../../core/model/scene';

/** Tag box: height, inner padding, corner radius. */
export const TAG_HEIGHT = 20;
export const TAG_PAD = 8;
/** Half the height — a stadium, so the tag reads as a badge rather than as a button. */
export const TAG_RADIUS = TAG_HEIGHT / 2;
/** How far the tags are held off the plot's right edge. */
export const TAG_INSET = 6;
/** The round action button, and the gap between it and the tag. */
export const ACTION_SIZE = 20;
export const ACTION_GAP = 4;
/**
 * How close the pointer has to come to a line to take hold of it.
 *
 * Generous compared to a drawing's tolerance: this is a stop being moved on a live position,
 * where missing by two pixels and panning the chart instead is a worse outcome than grabbing a
 * line the user did not mean — that one is undone by dropping it back.
 */
export const GRAB_TOLERANCE = 6;
/**
 * How far a spawn drag has to travel before it counts as one rather than as a click.
 *
 * A `dragSpawns` line hands back a price that becomes a live stop or target, so a press that
 * barely moved cannot be allowed to place one: it would sit against the line it came from, and
 * a stop against its own entry is a position that closes itself. Well clear of the click slop
 * the pan gesture uses, and small enough that a deliberate pull is never swallowed.
 */
export const SPAWN_MIN_TRAVEL = 10;

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Whether a point is inside a rectangle. */
export function inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/**
 * The action button's box: against the plot's right edge, centred on the line.
 *
 * It comes first because the tag is laid out against it — the button keeps its place whatever
 * the tag says, so a number that grows by a digit never moves the button out from under a
 * finger that was already reaching for it.
 */
export function priceLineActionRect(dataW: number, y: number): Rect {
    return {
        x: dataW - TAG_INSET - ACTION_SIZE,
        y: y - ACTION_SIZE / 2,
        width: ACTION_SIZE,
        height: ACTION_SIZE,
    };
}

/** The tag's box: right-aligned, before the button when there is one. */
export function priceLineTagRect(measure: { measureText(s: string): { width: number } }, title: string, hasAction: boolean, dataW: number, y: number): Rect {
    const width = measure.measureText(title).width + TAG_PAD * 2;
    const right = hasAction ? priceLineActionRect(dataW, y).x - ACTION_GAP : dataW - TAG_INSET;
    return { x: right - width, y: y - TAG_HEIGHT / 2, width, height: TAG_HEIGHT };
}

/** What a pointer is over: the line's body, its tag (also a handle), or its button. */
export type PriceLineHit = 'line' | 'tag' | 'action';

/**
 * What the pointer at (x, y) has hold of on ONE line, or null.
 *
 * The tag counts as part of the line, and deliberately so: a line only a few pixels from
 * another one is hard to hit, and the tag is the wide, obvious thing next to it. The button
 * wins over both — it is drawn on top, so it has to be hit first.
 *
 * A line that spawns levels is grabbed exactly like one that moves: which of the two a press
 * turns into is the renderer's business, not the geometry's.
 */
export function priceLineHitAt(
    x: number,
    y: number,
    line: PriceLine,
    lineY: number,
    dataW: number,
    measure: { measureText(s: string): { width: number } },
): PriceLineHit | null {
    if (line.action && inRect(x, y, priceLineActionRect(dataW, lineY))) return 'action';
    if (line.title && inRect(x, y, priceLineTagRect(measure, line.title, !!line.action, dataW, lineY))) return 'tag';
    if ((line.draggable || line.dragSpawns) && x <= dataW && Math.abs(y - lineY) <= GRAB_TOLERANCE) return 'line';
    return null;
}
