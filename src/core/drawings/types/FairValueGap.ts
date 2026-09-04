import { Drawing, type AnchorSlot, type SerializedDrawing } from '../Drawing';
import type { DrawingPoint, Projector } from '../geometry';
import type { SettingsSchema } from '../schema';
import { LINE_FIELDS } from '../schema';
import { handleAt, pointInBox } from '../hittest';
import { BEARISH, BULLISH } from '../../palette';

/**
 * A fair value gap (FVG, "imbalance") is a stretch of price the market moved through so fast
 * that no two-sided auction happened there. It is read off three consecutive bars:
 *
 *   bullish   bars[i].low  > bars[i-2].high   gap = [high(i-2), low(i)]
 *   bearish   bars[i].high < bars[i-2].low    gap = [high(i),  low(i-2)]
 *
 * The middle bar is the impulse; the gap is the part of its range the neighbours never traded
 * into. A gap is filled once price crosses the whole zone again — the bar that creates a zone
 * can never fill it, however far its own wick runs.
 *
 * The tool does not ask the user to drag a box around an imbalance — it asks the market where
 * the imbalance is, so the detector runs here rather than the shape being placed by hand.
 */

/** The bar fields the detector reads. Nothing else about a bar matters to a gap. */
export interface FvgBar {
    time: number;
    high: number;
    low: number;
}

/** One detected gap. Indices are positions in the array that was passed in, so a zone must be
 *  turned into (time, price) anchors — see {@link zoneAnchors} — before anything holds on to it. */
export interface FvgZone {
    direction: 'bull' | 'bear';
    top: number;
    bottom: number;
    /** Height in price — the tie-breaker when boxes overlap (the smallest one wins the click). */
    size: number;
    /** Where the zone begins on the chart (bar i-2). For drawing. */
    startIndex: number;
    /** The bar that confirms it (bar i). Nothing before this bar could know the zone exists. */
    index: number;
    /** The bar that filled it, or null while it is still open. */
    mitigatedIndex: number | null;
}

/** How a size threshold is read: against the price level the zone sits at, or raw. */
export type FvgSizeUnit = 'percent' | 'points';

export interface FvgDetectOptions {
    /** How wide a traded strip may be before it counts as a real separation between two stacked
     *  gaps. Below it, neighbouring gaps of the same direction merge into one zone. 0 keeps every
     *  gap separate. */
    mergeWick?: number;
    /** How to read {@link FvgDetectOptions.mergeWick}. */
    sizeUnit?: FvgSizeUnit;
}

/**
 * Every three-bar gap in `bars`, stacked runs joined up, each closed on the first later bar that
 * crossed it. Ascending by confirming bar.
 */
export function detectFairValueGaps(bars: readonly FvgBar[], opts: FvgDetectOptions = {}): FvgZone[] {
    const zones = mergeGaps(findGaps(bars), opts.mergeWick ?? 0, opts.sizeUnit ?? 'percent');
    applyMitigation(bars, zones);
    return zones;
}

/** Every three-bar gap, in the order they formed, with no opinion about what happened next. */
function findGaps(bars: readonly FvgBar[]): FvgZone[] {
    const gaps: FvgZone[] = [];
    for (let i = 2; i < bars.length; i += 1) {
        const bar = bars[i]!;
        const left = bars[i - 2]!;
        let direction: 'bull' | 'bear';
        let bottom: number;
        let top: number;
        if (bar.low > left.high) {
            direction = 'bull';
            bottom = left.high;
            top = bar.low;
        } else if (bar.high < left.low) {
            direction = 'bear';
            bottom = bar.high;
            top = left.low;
        } else continue;
        gaps.push({ direction, top, bottom, size: top - bottom, startIndex: i - 2, index: i, mitigatedIndex: null });
    }
    return gaps;
}

/**
 * Joins runs of gaps separated only by strips too thin to count as a separation. Zones that do
 * not merge come back untouched.
 *
 * A run is per direction and has to be unbroken in TIME as well as in price: a gap can only
 * extend the run whose bars its own overlap. Two gaps that merely happen to sit at the same
 * prices are not one imbalance, they are two, months apart.
 */
function mergeGaps(gaps: FvgZone[], mergeWick: number, unit: FvgSizeUnit): FvgZone[] {
    if (!(mergeWick > 0)) return gaps;
    const out: FvgZone[] = [];
    const runs: { bull: FvgZone | null; bear: FvgZone | null } = { bull: null, bear: null };
    for (const gap of gaps) {
        const run = runs[gap.direction];
        const strip = run === null ? null : stripBetween(run, gap);
        const joins = run !== null && strip !== null && gap.startIndex <= run.index && !bigEnough(strip.top, strip.bottom, mergeWick, unit);
        if (!joins) {
            const fresh = { ...gap };
            runs[gap.direction] = fresh;
            out.push(fresh);
            continue;
        }
        run.top = Math.max(run.top, gap.top);
        run.bottom = Math.min(run.bottom, gap.bottom);
        run.size = run.top - run.bottom;
        if (gap.startIndex < run.startIndex) run.startIndex = gap.startIndex;
        // Confirmation must be the LATEST of the run: nothing could know its extent earlier.
        if (gap.index > run.index) run.index = gap.index;
    }
    // Runs of the two directions interleave, so extending one can leave the array out of order —
    // and applyMitigation walks it expecting to meet zones in the order they were confirmed.
    return out.sort((a, b) => a.index - b.index);
}

/** The traded strip between two zones — the stretch of price that lies between them and did
 *  therefore change hands. Empty when they overlap or touch. */
function stripBetween(a: FvgZone, b: FvgZone): { top: number; bottom: number } {
    if (a.bottom > b.top) return { top: a.bottom, bottom: b.top };
    if (b.bottom > a.top) return { top: b.bottom, bottom: a.top };
    // A percentage still needs a real price to measure against, so an empty strip sits at the
    // edge the two share rather than at zero.
    const price = Math.max(a.bottom, b.bottom);
    return { top: price, bottom: price };
}

/** Whether a span clears a threshold, in whichever unit was asked for. */
function bigEnough(top: number, bottom: number, minSize: number, unit: FvgSizeUnit): boolean {
    const height = top - bottom;
    if (unit === 'points') return height >= minSize;
    const mid = (top + bottom) / 2;
    if (!(mid > 0)) return false; // a percentage of nothing is not a filter that can be applied
    return (height / mid) * 100 >= minSize;
}

/**
 * Walks the bars once and closes each zone on the first bar AFTER its own that crosses it
 * completely. Zones must be ordered by `index`, which {@link mergeGaps} guarantees.
 */
function applyMitigation(bars: readonly FvgBar[], zones: FvgZone[]): void {
    const open: FvgZone[] = [];
    let next = 0;
    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]!;
        // Closing runs before opening, which is what keeps a bar from filling the zone it creates.
        for (let k = open.length - 1; k >= 0; k -= 1) {
            const zone = open[k]!;
            const crossed = zone.direction === 'bull' ? bar.low <= zone.bottom : bar.high >= zone.top;
            if (!crossed) continue;
            zone.mitigatedIndex = i;
            open.splice(k, 1);
        }
        while (next < zones.length && zones[next]!.index <= i) open.push(zones[next++]!);
    }
}

/**
 * The fair value gap under a point, or null.
 *
 * A click has to land inside the box as it is drawn: within the gap's two prices, at or after
 * the bar it starts on, and not past the bar that filled it. An unfilled gap runs on to the
 * right edge, so it has no upper time bound.
 *
 * Where boxes overlap — and they do, constantly, since a strong move leaves gaps on top of each
 * other — the SMALLEST wins. The big one stays reachable everywhere the small one is not,
 * whereas a nested gap picked by any other rule could never be clicked at all.
 *
 * @param priceTolerance slack in price, so a gap a few pixels tall is still clickable
 */
export function zoneAt(
    bars: readonly FvgBar[],
    at: { time: number; price: number },
    priceTolerance = 0,
    opts: FvgDetectOptions = {},
): FvgZone | null {
    if (bars.length < 3) return null;
    let best: FvgZone | null = null;
    for (const zone of detectFairValueGaps(bars, opts)) {
        if (at.price < zone.bottom - priceTolerance) continue;
        if (at.price > zone.top + priceTolerance) continue;
        if (at.time < bars[zone.startIndex]!.time) continue;
        if (zone.mitigatedIndex !== null && at.time > bars[zone.mitigatedIndex]!.time) continue;
        if (best === null || zone.size < best.size) best = zone;
    }
    return best;
}

/**
 * The two anchors a zone becomes: top-left and bottom-right.
 *
 * The right edge is where the gap ended — the bar that filled it — or, for one still open, the
 * last bar available. A drawing stores fixed anchors, so an open gap cannot keep growing with
 * the chart; it is frozen at the moment it was marked, and the handle is there to drag it on.
 */
export function zoneAnchors(zone: FvgZone, bars: readonly FvgBar[]): [DrawingPoint, DrawingPoint] {
    const right = zone.mitigatedIndex ?? bars.length - 1;
    return [
        { time: bars[zone.startIndex]!.time, price: zone.top },
        { time: bars[right]!.time, price: zone.bottom },
    ];
}

/** The midpoint's dash — finer than any stroke the settings offer, so it never reads as one of
 *  the two edges. Consumed by the painter. */
export const FVG_MIDPOINT_DASH: readonly number[] = [2, 4];

/**
 * The fair value gap **drawing tool**: one click marks the imbalance under the pointer.
 *
 * This is the only tool whose gesture collects fewer points than the drawing keeps — the gap
 * supplies its own shape, so {@link FairValueGap.onPlaced} resolves the click into the zone's
 * two corners. A click that found no imbalance places nothing and leaves the tool armed.
 *
 * The detector runs over the bars the chart is currently showing, independently of whether any
 * FVG indicator is switched on: a tool that could only mark what an indicator happened to be
 * configured to show would be a tool that silently does nothing. Filled gaps are markable too —
 * a gap that is over is exactly the kind of thing someone annotates by hand.
 */
export class FairValueGap extends Drawing {
    readonly type = 'fvg' as const;

    /** Click slack in pixels, converted to price at the click — a gap a few pixels tall has to
     *  stay clickable. */
    private static readonly PICK_TOLERANCE_PX = 4;
    /** How far past the plot edges bars are read, as a multiple of the plot width: the three
     *  bars that form a gap can start left of the viewport, and the bar that filled it can sit
     *  right of it. */
    private static readonly LOOKAROUND = 1;

    /** The dashed midpoint line — consequent encroachment. */
    showMidline!: boolean;

    constructor(init: Partial<SerializedDrawing> & { paneId: string }) {
        super(init);
        if (this.showMidline === undefined) this.showMidline = true;
    }

    anchorSchema(): { min: number; max: number; slots: AnchorSlot[] } {
        // One click picks the gap; onPlaced replaces it with the zone's two corners, which are
        // what the two slots below give handles to afterwards.
        return { min: 1, max: 1, slots: [{ role: 'top', free: 'both' }, { role: 'bottom', free: 'both' }] };
    }

    /**
     * Resolve the click into the gap under it. Returns false when there is none, which abandons
     * the placement — marking an imbalance that is not there would be a box the market never drew.
     */
    override onPlaced(proj: Projector): boolean {
        const at = this.anchors[0];
        if (!at) return false;
        const bars = this.barsAround(proj);
        if (!bars) return false;
        const zone = zoneAt(bars, at, this.priceSlack(proj, at));
        if (!zone) return false;
        this.anchors = zoneAnchors(zone, bars);
        // Colour says which way the imbalance points — the one thing the box itself cannot show.
        this.style.lineColor = zone.direction === 'bull' ? BULLISH : BEARISH;
        return true;
    }

    /** The bars the detector runs over: the plot's own time span, widened by a screen on each
     *  side. Null when the renderer exposes no series (the tool then places nothing). */
    private barsAround(proj: Projector): FvgBar[] | null {
        if (!proj.barsInRange) return null;
        const pad = proj.width * FairValueGap.LOOKAROUND;
        const from = proj.pxToPoint(-pad, 0, this.paneId).time;
        const to = proj.pxToPoint(proj.width + pad, 0, this.paneId).time;
        const raw = proj.barsInRange(from, to);
        return raw.length >= 3 ? raw.map((b) => ({ time: b.time, high: b.high, low: b.low })) : null;
    }

    /** The pick tolerance in price: half the price span of the tolerance in pixels, at the click. */
    private priceSlack(proj: Projector, at: DrawingPoint): number {
        const y = proj.yOf(at.price, this.paneId);
        if (y == null) return 0;
        const above = proj.pxToPoint(0, y - FairValueGap.PICK_TOLERANCE_PX, this.paneId).price;
        const below = proj.pxToPoint(0, y + FairValueGap.PICK_TOLERANCE_PX, this.paneId).price;
        return Math.abs(above - below) / 2;
    }

    /** Pixel rect of the marked zone, or null while it is unresolvable. */
    rect(proj: Projector): { x1: number; y1: number; x2: number; y2: number } | null {
        const a = this.anchors[0];
        const b = this.anchors[1];
        if (!a || !b) return null;
        const ya = proj.yOf(a.price, this.paneId);
        const yb = proj.yOf(b.price, this.paneId);
        if (ya == null || yb == null) return null;
        return { x1: proj.xOf(a.time), y1: ya, x2: proj.xOf(b.time), y2: yb };
    }

    hitTest(px: number, py: number, proj: Projector, tol: number): boolean {
        const r = this.rect(proj);
        if (!r) return false;
        // A marked gap is a filled zone: clicking anywhere inside it — or within the tolerance of
        // an edge, which is all a gap a few pixels tall has — picks it up.
        return pointInBox(px, py, r.x1, r.y1, r.x2, r.y2, tol);
    }

    handlePoints(proj: Projector): Array<[number, number]> {
        const r = this.rect(proj);
        return r ? [[r.x1, r.y1], [r.x2, r.y2]] : [];
    }

    hitHandle(px: number, py: number, proj: Projector, tol: number): number {
        return handleAt(px, py, this.handlePoints(proj), tol + 3);
    }

    bounds(proj: Projector): { x: number; y: number; w: number; h: number } | null {
        const r = this.rect(proj);
        if (!r) return null;
        return { x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) };
    }

    priceRange(): { min: number; max: number } | null {
        const a = this.anchors[0];
        const b = this.anchors[1];
        if (!a || !b) return null;
        return { min: Math.min(a.price, b.price), max: Math.max(a.price, b.price) };
    }

    schema(): SettingsSchema {
        return {
            fields: [
                ...LINE_FIELDS.map((f) => ({ ...f, label: f.label.replace('Line', 'Edge') })),
                { path: 'showMidline', label: 'Show midpoint', kind: 'boolean', group: 'line' },
            ],
        };
    }

    protected override writeProps(): Record<string, unknown> {
        return { showMidline: this.showMidline };
    }

    protected override readProps(props: Record<string, unknown>): void {
        if (typeof props.showMidline === 'boolean') this.showMidline = props.showMidline;
    }
}
