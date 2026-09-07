import { parseRgb, withAlpha } from '../../../core/color';
import type { VelaTheme } from '../../../core/options';
import type { CoordinateSystem } from '../core/CoordinateSystem';
import { blobAccentColor } from '../core/chartConfig';
import { percentScaleFor, type SceneGraph } from '../core/SceneGraph';
import { paneAxisTicks, timeTicks } from '../chrome/ticks';
import { tzOffsetMs } from '../chrome/tz';

/**
 * The two ambient blobs, as fractions of the data area — a proportional translation of
 * the CSS `radial-gradient(ellipse <w> <h> at <x> <y>, …)` pair they came from, so a
 * narrow pane and a wide one get the same look instead of the same pixel radii. Each
 * center sits just OUTSIDE its corner: what shows is the shoulder of the wash bleeding
 * in, never a circle floating in the plot.
 */
const BLOB_GEOMETRY = [
    { cx: 0.12, cy: -0.08, rx: 0.78, ry: 1.0 },
    { cx: 1.04, cy: 1.08, rx: 0.66, ry: 0.89 },
] as const;

/** Where the wash has faded to nothing, as a fraction of the radius (CSS: `transparent 65%`). */
const BLOB_FADE_STOP = 0.65;

/** Clip one time-band rectangle to its permitted horizontal paint interval. */
export function clipHighlightRect(x1: number, x2: number, left: number, right: number): { x: number; width: number } | null {
    const x = Math.max(left, x1);
    const end = Math.min(right, x2);
    return end > x ? { x, width: end - x } : null;
}

/**
 * The logical SLOT boundary a session-band edge lands on. Bars belong to a band by
 * their open time (`[from, to)` semantics), so an edge must sit BETWEEN the last bar
 * inside and the first bar outside — never through a candle body. `logical` is the
 * edge timestamp's fractional bar index: an exact bar open (integer) yields that bar's
 * own slot start; a timestamp between opens (a gap, or mid-bar) yields the boundary
 * before the next bar — which is the same pixel from either side, so adjacent bands
 * meet seamlessly across barless stretches like a maintenance halt.
 */
export function bandEdgeSlot(logical: number): number {
    return Math.ceil(logical) - 0.5;
}

/**
 * The backdrop layer (L-2): session highlights + the axis gridlines, on their own
 * canvas at the very BOTTOM of the canvas pile. The grid used to be painted inside the
 * data canvas, but SDK layer canvases can slot BELOW that canvas (an indicator
 * restacked behind the candles takes its layer canvas along) — and nothing may ever
 * paint under the grid. Keeping the grid on the bottom-most canvas makes that
 * invariant structural instead of hoping every layer stays above it. Repainted on
 * data frames only, from the same scene/coords the geometry backend reads.
 */
export class BackdropRenderer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    destroy(): void {
        this.canvas = null;
        this.ctx = null;
    }

    /** Paint one frame: highlight bands first, gridlines on top (the order they had inside
     *  the data canvas). `gridAlpha` fades the gridlines as a reveal-under layer opens. */
    render(scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, gridAlpha: number): void {
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return;

        const dpr = coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

        // Cosmetic, not data — painted BEFORE the bar gate below, so a chart with no bars
        // yet (first load, an empty symbol) still shows the tinted surface rather than
        // flashing flat background until the first candle lands.
        this.drawBlobs(ctx, scene, coords, theme);

        // Same gate as the geometry backend: no grid before data reaches the view.
        const n = coords.barCount;
        if (n === 0) return;
        const vr = coords.visibleLogicalRange();
        if (Math.min(n - 1, Math.ceil(vr.to)) < Math.max(0, Math.floor(vr.from))) return;

        this.drawHighlights(ctx, scene, coords);
        this.drawGrid(ctx, scene, coords, theme, coords.width, gridAlpha);
    }

    /** The ambient corner washes, under everything else on this canvas. Confined to the DATA
     *  area (`coords.width/height`): the axis gutters are repainted opaque by the chrome layer,
     *  so a blob running under them would be covered anyway — and clipping there keeps the
     *  geometry keyed to what is actually visible. */
    private drawBlobs(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme): void {
        const blobs = scene.style.blobs;
        if (!blobs.topLeft.visible && !blobs.bottomRight.visible) return;
        const w = coords.width;
        const h = coords.height;
        if (w <= 0 || h <= 0) return;
        const order = ['topLeft', 'bottomRight'] as const;
        for (let i = 0; i < BLOB_GEOMETRY.length; i++) {
            const which = order[i]!;
            const layer = blobs[which];
            if (!layer.visible) continue;
            const g = BLOB_GEOMETRY[i]!;
            this.drawBlob(ctx, w, h, g.cx * w, g.cy * h, g.rx * w, g.ry * h, layer.color ?? blobAccentColor(theme, which));
        }
    }

    /** One elliptical wash. `createRadialGradient` only makes circles, so the ellipse comes
     *  from scaling the axes around the blob's center and painting a unit-radius gradient in
     *  that space (the fill rect is mapped back through the same scale). The outer stop is the
     *  SAME color at alpha 0, not `transparent` — canvas interpolates gradients in premultiplied
     *  RGBA, and fading to `rgba(0,0,0,0)` would drag a gray cast through the falloff. */
    private drawBlob(ctx: CanvasRenderingContext2D, w: number, h: number, cx: number, cy: number, rx: number, ry: number, color: string): void {
        if (rx <= 0 || ry <= 0) return;
        // An unparseable color (a named CSS color, `currentColor`) cannot be re-emitted at
        // alpha 0 — withAlpha hands it back unchanged, which would make the "faded" stop
        // opaque and flood the pane. Fall back to clear black there instead.
        const clear = parseRgb(color) ? withAlpha(color, 0) : 'rgba(0,0,0,0)';
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx, ry);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, color);
        grad.addColorStop(BLOB_FADE_STOP, clear);
        grad.addColorStop(1, clear);
        ctx.fillStyle = grad;
        ctx.fillRect(-cx / rx, -cy / ry, w / rx, h / ry);
        ctx.restore();
    }

    /** Renderer-owned session highlight bands: full-height (all panes), behind the grid.
     *  Session-zone washes paint first (edges snapped to bar-slot boundaries so a band
     *  never cuts a candle in two), host highlights on top (continuous time mapping —
     *  hosts may paint sub-bar spans). */
    private drawHighlights(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem): void {
        const sessions = scene.sessionHighlightBands();
        if (sessions.length > 0) {
            // Calendar windows may extend beyond loaded candles (the tracker fetches ahead
            // for live charts). Paint only the occupied bar slots: no wash before history,
            // and none in right-side whitespace beyond the current bar.
            const left = Math.max(0, coords.logicalToX(-0.5));
            const right = Math.min(coords.width, coords.logicalToX(coords.barCount - 0.5));
            this.drawHighlightSet(ctx, sessions, coords, left, right, true);
        }
        this.drawHighlightSet(ctx, scene.highlights, coords, 0, coords.width, false);
    }

    private drawHighlightSet(ctx: CanvasRenderingContext2D, bands: ReturnType<SceneGraph['sessionHighlightBands']>, coords: CoordinateSystem, left: number, right: number, snapToSlots: boolean): void {
        const edgeX = (ms: number): number => (snapToSlots ? coords.logicalToX(bandEdgeSlot(coords.timeToLogical(ms))) : coords.timeToX(ms));
        for (const band of bands) {
            const rect = clipHighlightRect(edgeX(band.from), edgeX(band.to), left, right);
            if (!rect) continue;
            ctx.fillStyle = band.color;
            ctx.fillRect(rect.x, 0, rect.width, coords.height);
        }
    }

    // ── grid ── vert/horz gate on `scene.showGrid` AND their own per-axis visibility
    // (style); each uses its own color. Pane separators are drawn on the chrome layer
    // (full-width, above the data) so series never overpaint them.
    private drawGrid(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, gridAlpha: number): void {
        const panes = scene.orderedPanes();
        const { gridVert, gridHorz } = scene.style;
        const vertColor = gridVert.color ?? theme.gridColor;
        const horzColor = gridHorz.color ?? theme.gridColor;
        ctx.lineWidth = 1;
        if (scene.showGrid && gridVert.visible) {
            ctx.globalAlpha = gridAlpha; // fade the grid out as a reveal-under style opens up
            ctx.strokeStyle = vertColor;
            const tr = coords.visibleTimeRange();
            const offset = tzOffsetMs((tr.from + tr.to) / 2, scene.timezone);
            ctx.beginPath();
            for (const tick of timeTicks(tr.from, tr.to, 8, offset)) {
                const x = Math.round(coords.timeToX(tick.time)) + 0.5;
                if (x < 0 || x > dataW) continue;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, coords.height);
            }
            ctx.stroke();
        }
        for (const pane of panes) {
            if (scene.showGrid && gridHorz.visible && !pane.collapsed) {
                ctx.globalAlpha = gridAlpha; // fade horizontal gridlines so they don't show through fading candles
                ctx.strokeStyle = horzColor;
                const pct = percentScaleFor(scene, pane);
                ctx.beginPath();
                for (const t of paneAxisTicks(pane.scale, pane.bounds.height, pct, undefined, pane.axisFormat)) {
                    const y = Math.round(coords.priceToY(t.price, pane.scale, pane.bounds)) + 0.5;
                    if (y < pane.bounds.top || y > pane.bounds.top + pane.bounds.height) continue;
                    ctx.moveTo(0, y);
                    ctx.lineTo(dataW, y);
                }
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }
}
