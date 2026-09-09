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

/**
 * The axis chip's height — the small box a price line stamps against the price scale.
 *
 * Shorter than {@link TAG_HEIGHT}: the plot-side tag carries a title and reads as a badge,
 * this one carries a number and has to sit in a scale where the last price already does.
 */
export const AXIS_TAG_HEIGHT = 16;

/**
 * Push overlapping axis chips apart, keeping each as near its own line as it can be.
 *
 * Two levels a few pixels apart stamp two chips on the same few pixels of the scale, and the
 * one underneath is simply not readable — the exact case a bid and its ask make on every
 * forex chart, where the whole distance between them is the spread. It happens to a stop
 * dragged up against its entry too; this is one answer to both.
 *
 * Nudged, never hidden. A chip that vanished would leave a line whose price the scale does
 * not say, and the reading that a level has been dropped is worse than one sitting a few
 * pixels off. Overlapping chips are moved as a GROUP, centred on where they wanted to be, so
 * the error is shared out rather than piled onto whichever happened to be second — two chips
 * that collide each give way by half, and neither is the one that looks right.
 *
 * @param desired  Where each chip's centre wants to be, in the caller's order.
 * @param height   A chip's full height; chips closer than this collide.
 * @param top      Upper bound for a chip's centre.
 * @param bottom   Lower bound for a chip's centre.
 * @returns        Where each chip's centre should go, in the SAME order as `desired`.
 */
export function declutterAxisTags(
    desired: readonly number[],
    height: number = AXIS_TAG_HEIGHT,
    top = -Infinity,
    bottom = Infinity,
): number[] {
    if (desired.length < 2) return [...desired];

    // Resolved top-down, so a chip's neighbours are the ones next to it on screen rather
    // than the ones next to it in whatever order the caller collected them.
    const order = desired.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);

    /** A run of chips pushed into one another: what its members asked for, and how many. */
    interface Cluster { sum: number; count: number }
    /** Where a settled run starts — centred on the mean of what its members wanted. */
    const startOf = (c: Cluster): number => c.sum / c.count - ((c.count - 1) * height) / 2;
    const endOf = (c: Cluster): number => startOf(c) + (c.count - 1) * height;

    const clusters: Cluster[] = [];
    for (const { y } of order) {
        clusters.push({ sum: y, count: 1 });
        /* Absorbing a chip moves the run's centre upward, which can push it into the run
         * above — which moves THAT one in turn. So this collapses until the whole stack is
         * settled: checking only the pair just joined leaves chips overlapping two runs up.
         */
        while (clusters.length >= 2) {
            const last = clusters[clusters.length - 1]!;
            const above = clusters[clusters.length - 2]!;
            if (startOf(last) - endOf(above) >= height) break;
            above.sum += last.sum;
            above.count += last.count;
            clusters.pop();
        }
    }

    const out = new Array<number>(desired.length);
    let placed = 0;
    for (const cluster of clusters) {
        /* Held inside the pane. Bottom first and top second means a run taller than the pane
         * hangs off the bottom rather than the top — the numbers at least start where they
         * can be read. A pane too short for every chip stacks them at the top; that is a
         * chart with more levels than pixels, and no arrangement of it reads well. */
        let y = startOf(cluster);
        if (y + (cluster.count - 1) * height > bottom) y = bottom - (cluster.count - 1) * height;
        if (y < top) y = top;
        for (let k = 0; k < cluster.count; k++, placed++) out[order[placed]!.i] = y + k * height;
    }
    return out;
}
