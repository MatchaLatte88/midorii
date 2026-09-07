import { Drawing, type AnchorSlot, type SerializedDrawing } from '../Drawing';
import type { DrawingPoint, Projector } from '../geometry';
import type { SettingsSchema } from '../schema';
import { LINE_FIELDS } from '../schema';
import { handleAt, pointInBox } from '../hittest';
import { BEARISH, BULLISH } from '../../palette';
import { detectFairValueGaps, type FvgBar, type FvgDetectOptions, type FvgZone } from '../../analysis/fvg';

/* The detector itself lives in core/analysis, because the FVG indicator paints from the same
 * one — two of them would put the tool and the indicator on different levels for the same
 * market. Re-exported here so the drawings barrel keeps the surface it always had. */
export { detectFairValueGaps };
export type { FvgBar, FvgZone, FvgSizeUnit, FvgDetectOptions, FvgMitigation, FvgShow } from '../../analysis/fvg';

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
    // 'all': a gap that is over is exactly the kind of thing someone annotates by hand, and
    // zoneAnchors already ends its box where it was filled.
    for (const zone of detectFairValueGaps(bars, { ...opts, show: 'all' })) {
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
        return raw.length >= 3 ? raw.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })) : null;
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
