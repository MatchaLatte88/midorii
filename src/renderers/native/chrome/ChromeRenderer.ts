import type { VelaTheme } from '../../../core/options';
import type { IndicatorModel } from '../../../core/model/indicator';
import type { OHLCV } from '../../../core/model/ohlcv';
import type { LineStyle } from '../../../core/model/series';
import type { PriceLine } from '../../../core/model/scene';
import type { CoordinateSystem } from '../core/CoordinateSystem';
import type { SceneGraph, PaneNode } from '../core/SceneGraph';
import { percentScaleFor } from '../core/SceneGraph';
// Re-exported so existing importers (crosshair) can keep sourcing it from here.
export { percentScaleFor } from '../core/SceneGraph';
import { DrawingSceneRenderer, modelDrawingSet, type DrawingSet } from '../../shared/DrawingSceneRenderer';
import { renderTradeMarkers } from '../../shared/trade-markers';
import type { TradeExecution } from '../../../core/model/trades';
import { paneAxisTicks, formatAxisValue, timeTicks } from './ticks';
import { axisColumnX, PANE_SEPARATOR_PX } from './axisLayout';
import {
    priceLineActionRect, priceLineHitAt, priceLineTagRect, priceLineTagSegments,
    declutterAxisTags, AXIS_TAG_HEIGHT, TAG_PAD, TAG_RADIUS, BRACKET_GRIP_WIDTH,
    BRACKET_SEGMENT_GAP, BRACKET_TIP_WIDTH, type PriceLineHit, type Rect,
} from './priceLineTags';
import { parseColor } from '../backend/gl/color';
import { DARK_THEME } from '../../../core/theme';
import { tzOffsetMs } from './tz';

/**
 * Renderer-owned chrome layer (canvas2d) on its own canvas, stacked above the
 * geometry layer (L0) and below the cursor layer (L2). It draws the per-pane price
 * axes + labels, the time axis + labels, the current-price line + chip, and the
 * strategy trade markers. Pine drawings do NOT paint here: they prepaint into
 * interleave slices (IndicatorDrawingSlices) the geometry backend composites at
 * their model's z slot — this layer only keeps the shared DrawingSceneRenderer to
 * compute the drawing price-range that folds into autoscale (`paneDrawingsRange`).
 */

/**
 * One price line's chip against the price scale, held back until every one of them is
 * known so they can be laid out without landing on each other. `y` is where the chip
 * WANTS to be — its line — which is not always where it ends up.
 */
interface AxisChip {
    pane: PaneNode;
    y: number;
    text: string;
    color: string;
    ink: string;
}

export class ChromeRenderer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    // The color for axis tick labels — the host-passed surface text, set each frame in render().
    private axisTextColor = DARK_THEME.textColor;
    // Shared Pine-drawing renderer, used here for autoscale geometry only; widthCache persists.
    private readonly drawScene = new DrawingSceneRenderer({ timeToLogical: () => 0, barAt: () => null, theme: {} as VelaTheme });

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    /** Wire the drawing coordinate resolvers + theme (call once per frame before use). */
    prepare(scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme): void {
        this.drawScene.setDeps({
            timeToLogical: (ms) => coords.timeToLogical(ms),
            barAt: (logical) => {
                const b = scene.bars[Math.round(logical)];
                return b ? { high: b.high, low: b.low } : null;
            },
            theme,
        });
    }

    /**
     * Visible Pine-drawing price range for a pane (folds into autoscale): the pane's
     * own (non-overlay) drawings, plus force_overlay drawings when it's the price pane.
     * Requires `prepare()` to have wired the resolvers for this frame.
     */
    paneDrawingsRange(ownModels: IndicatorModel[], scene: SceneGraph, isPricePane: boolean, vr: { from: number; to: number }): { min: number; max: number } | null {
        let dr: { min: number; max: number } | null = null;
        // An indicator may opt its drawings out of the scale entirely — see IndicatorModel.
        const folds = (m: IndicatorModel): boolean => m.autoscaleDrawings !== false;
        for (const m of ownModels) if (folds(m)) dr = unionRange(dr, this.drawingsRange(modelDrawingSet(m, false), vr, scene.offsetOf(m.id)));
        if (isPricePane) for (const m of scene.indicators.values()) if (folds(m)) dr = unionRange(dr, this.drawingsRange(modelDrawingSet(m, true), vr, scene.offsetOf(m.id)));
        return dr;
    }

    /** Clear the chrome canvas and draw drawings + axes + current-price line.
     *  `surface` (background + text) paints the axis-scale gutters — the host passes the live
     *  chart background so the scales read as part of the plot, with contrast-corrected text.
     *  Falls back to the theme's own colors when no surface is supplied. */
    render(scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, surface?: { background: string; textColor: string }): void {
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return;

        const dpr = coords.dpr;
        const fullW = canvas.width / dpr;
        const fullH = canvas.height / dpr;
        const dataW = coords.width;
        const dataH = coords.height;
        // The gutters (and their labels) use the surface the host passes (the live chart
        // background); everything data-side keeps the live theme.
        this.axisTextColor = surface?.textColor ?? theme.textColor;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, fullW, fullH);
        // Paint the price-axis (right) + time-axis (bottom) gutters opaquely so drawings or
        // series pixels beneath never bleed into the scales. Data/drawings stay clear of
        // these strips, so this only ever covers the axis areas.
        if (surface && (fullW > dataW || fullH > dataH)) {
            ctx.fillStyle = surface.background;
            if (fullW > dataW) ctx.fillRect(dataW, 0, fullW - dataW, fullH);
            if (fullH > dataH) ctx.fillRect(0, dataH, dataW, fullH - dataH);
        }
        ctx.font = `${scene.style.fontSize}px ${theme.fontFamily}`;
        ctx.textBaseline = 'middle';

        const panes = scene.orderedPanes();
        if (coords.barCount === 0) {
            // A market switch (timeframe/symbol) clears the series while the new bars
            // load, and any chrome frame in that window (crosshair move, resize) lands
            // here. The pane SEPARATORS are structural — they depend on pane bounds
            // alone, not bars — so they must survive the empty frame, or the stacked
            // panes read as one undivided plot until the load completes.
            this.drawPaneSeparators(ctx, scene, theme, fullW, panes);
            return;
        }
        const pricePane = panes.find((p) => p.kind === 'price') ?? null;

        // Pine drawings paint through the interleave slices at their model's z slot
        // (IndicatorDrawingSlices), NOT here — the chrome stays axes + markers + chips.

        // ── Strategy trade markers — always the PRICE pane, whatever pane the strategy's
        //    plots landed on (a fill price only means something on the price scale), above
        //    the drawings. Hiding the indicator removes its model, and the markers with it. ──
        if (pricePane && !pricePane.collapsed && scene.tradeMarkers.visible) {
            for (const m of scene.indicators.values()) {
                if (m.trades?.length) this.renderTrades(ctx, coords, scene, theme, m.trades, pricePane, dataW);
            }
        }

        // ── axes + current-price line + countdown ──
        this.drawPriceAxes(ctx, scene, coords, theme, dataW, panes);
        this.drawMergedScaleColumns(ctx, scene, coords, dataW);
        this.drawPaneSeparators(ctx, scene, theme, fullW, panes);
        this.drawPriceLineAndCountdown(ctx, scene, coords, theme, dataW, pricePane);
        this.drawPriceLineTags(ctx, scene, coords, theme, dataW, panes);
        this.drawTimeAxis(ctx, scene, coords, theme, dataW, dataH, fullH);
    }

    destroy(): void {
        this.canvas = null;
        this.ctx = null;
    }

    private drawingsRange(set: DrawingSet, vr: { from: number; to: number }, indexOffset = 0): { min: number; max: number } | null {
        this.drawScene.setSet(set, indexOffset);
        if (this.drawScene.isEmpty()) return null;
        const r = this.drawScene.priceRange(vr.from, vr.to);
        return r ? { min: r.min, max: r.max } : null;
    }

    private renderTrades(
        ctx: CanvasRenderingContext2D,
        coords: CoordinateSystem,
        scene: SceneGraph,
        theme: VelaTheme,
        trades: readonly TradeExecution[],
        pane: PaneNode,
        dataW: number,
    ): void {
        ctx.save();
        ctx.translate(0, pane.bounds.top); // pane-relative space, clipped like the drawings
        ctx.beginPath();
        ctx.rect(0, 0, dataW, pane.bounds.height);
        ctx.clip();
        renderTradeMarkers(
            ctx,
            trades,
            scene.tradeMarkers,
            {
                timeToLogical: (ms) => coords.timeToLogical(ms),
                barAt: (logical) => {
                    const b = scene.bars[Math.round(logical)];
                    return b ? { high: b.high, low: b.low } : null;
                },
            },
            (logical) => coords.logicalToX(logical),
            (price) => coords.priceToY(price, pane.scale, pane.bounds) - pane.bounds.top,
            { fontSize: scene.style.fontSize, fontFamily: theme.fontFamily, color: theme.textColor },
            dataW,
            // Half the candle BODY width (bodies take ~0.8 of the pitch), so the
            // fill-price ticks hug the bar's edges at every zoom.
            Math.max(1.5, coords.bodySpacing() * 0.4),
        );
        ctx.restore();
    }

    // ── axes ──
    private drawPriceAxes(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, panes: PaneNode[]): void {
        ctx.strokeStyle = scene.style.borderColor ?? theme.borderColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dataW + 0.5, 0);
        ctx.lineTo(dataW + 0.5, coords.height);
        ctx.stroke();
        if (!scene.showAxisLabels) return;
        ctx.fillStyle = this.axisTextColor;
        ctx.textAlign = 'left';
        for (const pane of panes) {
            if (pane.collapsed) continue; // collapsed strip: legend only, no scale numbers
            const pct = percentScaleFor(scene, pane);
            for (const t of paneAxisTicks(pane.scale, pane.bounds.height, pct, scene.priceMintick, pane.axisFormat)) {
                const y = coords.priceToY(t.price, pane.scale, pane.bounds);
                if (y < pane.bounds.top + 6 || y > pane.bounds.top + pane.bounds.height - 4) continue;
                ctx.fillText(t.label, dataW + 6, y);
            }
            // A paneAxis-overridden pane labels its bands instead of prices (a
            // categorical axis) — same column, same typography as the price ticks.
            if (pane.axisBands) {
                for (const b of pane.axisBands) {
                    const y = pane.bounds.top + b.frac * pane.bounds.height;
                    if (y < pane.bounds.top + 6 || y > pane.bounds.top + pane.bounds.height - 4) continue;
                    ctx.fillText(b.label, dataW + 6, y);
                }
            }
        }
        ctx.textAlign = 'start';
    }

    /**
     * The horizontal divider at each stacked pane's top edge, spanning the FULL width (data area
     * + right-hand scale gutter) as one continuous line. Drawn on the chrome layer, above the data
     * canvas, so series/candles never overpaint it — the line reads at a uniform thickness across
     * the whole width. Its draggable hit-zone (input) and hover highlight (crosshair layer) match
     * this same full span.
     */
    private drawPaneSeparators(ctx: CanvasRenderingContext2D, scene: SceneGraph, theme: VelaTheme, fullW: number, panes: PaneNode[]): void {
        ctx.fillStyle = scene.style.separatorColor ?? theme.borderColor;
        for (const pane of panes) {
            if (pane.order <= 0) continue; // no separator above the topmost (price) pane
            ctx.fillRect(0, Math.round(pane.bounds.top) - 1, fullW, PANE_SEPARATOR_PX);
        }
    }

    /**
     * Draw an axis column per merged (own-scale) indicator, to the right of each pane's
     * master scale — tick labels in the chart's axis text color. Columns are told apart by
     * spacing alone (no divider line), and a collapsed pane's columns are skipped entirely.
     * This is what makes a merged indicator readable on its own values while sharing the pane.
     */
    private drawMergedScaleColumns(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, dataW: number): void {
        if (!scene.showAxisLabels) return;
        ctx.textAlign = 'left';
        // A merged column reads with the same axis text color as the master scale (from the
        // chart's settings) — no per-indicator tint, so the gutter stays uniform.
        ctx.fillStyle = this.axisTextColor;
        for (const pane of scene.orderedPanes()) {
            if (pane.collapsed) continue; // collapsed strip: legend only, no scale numbers
            const merged = scene.ownScaleIndicatorsForPane(pane.id);
            merged.forEach((model, k) => {
                const sc = scene.indicatorScales.get(model.id)?.scale;
                if (!sc) return;
                const x = axisColumnX(dataW, k + 1); // column 0 is the master scale
                for (const t of paneAxisTicks(sc, pane.bounds.height, undefined, scene.priceMintick)) {
                    const y = coords.priceToY(t.price, sc, pane.bounds);
                    if (y < pane.bounds.top + 6 || y > pane.bounds.top + pane.bounds.height - 4) continue;
                    ctx.fillText(t.label, x + 5, y);
                }
            });
        }
        ctx.textAlign = 'start';
    }

    /**
     * The latest-price chrome on the price pane, all colored with the price element's own
     * color (candle/bar up-down, line, area, or baseline side) and white text:
     *  - the dashed current-price LINE (`showPriceLine`) — fully independent of the label,
     *  - the last-price LABEL chip (`showPriceLabel`),
     *  - the countdown-to-bar-close chip (`showCountdown`).
     * When the label and countdown are both on they merge into one stacked block (countdown
     * under the label, text flushed left); a lone label or countdown is centered on the
     * price level with centered text. The countdown ticks once per second (repaint scheduled).
     */
    private drawPriceLineAndCountdown(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, pricePane: PaneNode | null): void {
        const n = scene.bars.length;
        // A hidden price series takes its current-price line/label/countdown down with it —
        // as does a hidden price PANE (collapsed, or zero-height while a study pane is maximized).
        if (!pricePane || n === 0 || scene.candlesHidden || pricePane.collapsed || pricePane.bounds.height <= 0) return;
        const last = scene.bars[n - 1]!;
        const y = coords.priceToY(last.close, pricePane.scale, pricePane.bounds);
        if (y < pricePane.bounds.top || y > pricePane.bounds.top + pricePane.bounds.height) return;
        const color = this.priceElementColor(scene, coords, theme, last);

        // ── dashed line (independent of the label) ──
        if (scene.showPriceLine) {
            const yy = Math.round(y) + 0.5;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            setDash(ctx, 'dotted');
            ctx.beginPath();
            ctx.moveTo(0, yy);
            ctx.lineTo(dataW, yy);
            ctx.stroke();
            setDash(ctx, 'solid');
        }

        // ── axis chips: last-price label and/or countdown ──
        const interval = coords.barInterval;
        const showCountdown = scene.showCountdown && interval > 0;
        const showLabel = scene.showPriceLabel;
        if (!showLabel && !showCountdown) return;

        const priceText = formatAxisValue(pricePane.scale, pricePane.bounds.height, last.close, percentScaleFor(scene, pricePane), scene.priceMintick);
        const cdText = showCountdown ? formatCountdown(last.time + interval - Date.now()) : '';
        const PAD = 8;
        const x = dataW + 1;
        // Text color chosen for contrast against the chip's own color (so a white candle
        // color yields dark text, a dark color yields light text).
        const textColor = tagTextColor(color, theme.background);
        ctx.textBaseline = 'middle';

        if (showLabel && showCountdown) {
            // Merged block: label row on top (centered on the price line), countdown row
            // under it. Same width, text flushed left.
            const w = Math.max(ctx.measureText(priceText).width, ctx.measureText(cdText).width) + PAD;
            const top = y - 8;
            const tx = x + PAD / 2;
            ctx.fillStyle = color;
            ctx.fillRect(x, top, w, 32);
            ctx.fillStyle = textColor;
            ctx.textAlign = 'left';
            ctx.fillText(priceText, tx, top + 8);
            ctx.fillText(cdText, tx, top + 24);
            ctx.textAlign = 'start';
            return;
        }

        // Lone label or countdown — centered on the price level, text centered.
        const text = showLabel ? priceText : cdText;
        const w = ctx.measureText(text).width + PAD;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 8, w, 16);
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.fillText(text, x + w / 2, y);
        ctx.textAlign = 'start';
    }

    /**
     * Tags for the price lines that carry a title: a chip riding each line at the right edge of
     * the plot, and optionally a chip of its own price against the axis.
     *
     * A price line is usually a level someone is watching — a stop, a target, an order resting
     * somewhere — and a level nobody can read the meaning of is a line. The chip is filled in
     * the line's own colour so the two are obviously the same thing, and the text takes
     * whichever of black/white survives that fill.
     *
     * Drawn in the chrome pass rather than with the line itself: these ride OVER the candles
     * and over every indicator, which is the only place a level's own numbers are legible.
     */
    private drawPriceLineTags(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, panes: readonly PaneNode[]): void {
        ctx.font = this.tagFont(theme);
        ctx.textBaseline = 'middle';
        const chips: AxisChip[] = [];
        for (const model of scene.indicators.values()) {
            for (const pl of model.priceLines) {
                if (!pl.title && !pl.axisTag && !pl.action) continue;
                const pane = panes.find((p) => p.id === pl.paneId);
                if (!pane || pane.collapsed || pane.bounds.height <= 0) continue;
                const y = coords.priceToY(pl.price, pane.scale, pane.bounds);
                if (y < pane.bounds.top || y > pane.bounds.top + pane.bounds.height) continue;
                const color = pl.color ?? theme.textColor;
                const ink = tagTextColor(color, theme.background);
                let tagRect: Rect | undefined;
                if (pl.title) {
                    const tag = pl.titleColor ?? color;
                    tagRect = priceLineTagRect(ctx, pl.title, !!pl.action, dataW, y, pl.tagStyle);
                    if (pl.tagStyle === 'bracket') this.drawBracketTag(ctx, tagRect, pl.title, tag, theme.background, y);
                    else {
                        ctx.fillStyle = tag;
                        roundRect(ctx, tagRect.x, tagRect.y, tagRect.width, tagRect.height, TAG_RADIUS);
                        ctx.fill();
                        ctx.fillStyle = tagTextColor(tag, theme.background);
                        ctx.textAlign = 'left';
                        ctx.fillText(pl.title, tagRect.x + TAG_PAD, y);
                        ctx.textAlign = 'start';
                    }
                }
                if (pl.action === 'close') {
                    const actionColor = pl.tagStyle === 'bracket' ? (pl.titleColor ?? color) : theme.downColor;
                    const b = priceLineActionRect(dataW, y, pl.tagStyle === 'bracket' ? tagRect : undefined);
                    const cx = b.x + b.width / 2;
                    /* Filled badges keep the universal down-colour warning. A trading bracket
                     * treats the ring as part of its level, so its outline follows the bracket. */
                    ctx.fillStyle = theme.background;
                    ctx.beginPath();
                    ctx.arc(cx, y, b.width / 2 - 1, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = actionColor;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    // The glyph is drawn, not typed: an ✕ from the font sits differently in
                    // every family, and this one has to look centred in a 9px circle.
                    ctx.strokeStyle = actionColor;
                    ctx.lineWidth = 1.5;
                    const arm = b.width / 2 - 6;
                    ctx.beginPath();
                    ctx.moveTo(cx - arm, y - arm);
                    ctx.lineTo(cx + arm, y + arm);
                    ctx.moveTo(cx + arm, y - arm);
                    ctx.lineTo(cx - arm, y + arm);
                    ctx.stroke();
                }
                if (pl.axisTag) {
                    /* Collected rather than drawn: two levels a few pixels apart stamp two
                     * chips on the same few pixels of the scale, and neither is readable.
                     * They are laid out together once every one of them is known — see
                     * `drawAxisChips`. */
                    chips.push({
                        pane,
                        y,
                        text: formatAxisValue(pane.scale, pane.bounds.height, pl.price, percentScaleFor(scene, pane), scene.priceMintick),
                        color,
                        ink,
                    });
                }
            }
        }
        this.drawAxisChips(ctx, chips, dataW);
        this.drawPriceLineDrag(ctx, scene, coords, theme, dataW, panes);
        ctx.textBaseline = 'alphabetic';
    }

    /** The chart-side treatment used by trade brackets: outlined, segmented, and handle-like. */
    private drawBracketTag(
        ctx: CanvasRenderingContext2D,
        r: Rect,
        title: string,
        color: string,
        background: string,
        y: number,
    ): void {
        const right = r.x + r.width;
        const bottom = r.y + r.height;
        ctx.fillStyle = background;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(r.x + 4, r.y);
        ctx.lineTo(right - BRACKET_TIP_WIDTH, r.y);
        ctx.lineTo(right, y);
        ctx.lineTo(right - BRACKET_TIP_WIDTH, bottom);
        ctx.lineTo(r.x + 4, bottom);
        ctx.quadraticCurveTo(r.x, bottom, r.x, bottom - 4);
        ctx.lineTo(r.x, r.y + 4);
        ctx.quadraticCurveTo(r.x, r.y, r.x + 4, r.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        /* Six small dots make the tag read as a handle without adding another icon. */
        ctx.fillStyle = color;
        const gripX = r.x + TAG_PAD - 2;
        for (const dx of [0, 4]) {
            for (const dy of [-4, 0, 4]) {
                ctx.beginPath();
                ctx.arc(gripX + dx, y + dy, 1, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const segments = priceLineTagSegments(title);
        let x = r.x + TAG_PAD + BRACKET_GRIP_WIDTH;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.textAlign = 'left';
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            ctx.fillText(segment, x, y);
            x += ctx.measureText(segment).width;
            if (i === segments.length - 1) continue;
            x += BRACKET_SEGMENT_GAP;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, r.y + 5);
            ctx.lineTo(Math.round(x) + 0.5, bottom - 5);
            ctx.stroke();
            ctx.restore();
            x += BRACKET_SEGMENT_GAP + 1;
        }
        ctx.textAlign = 'start';
    }

    /**
     * The price lines' own chips against the scale, spread apart where they would collide.
     *
     * Laid out per pane, because that is the box they have to stay inside and the scale they
     * were measured against. Within one pane a chip is nudged off its line rather than
     * dropped: a level whose price the scale does not say reads as a level that is no longer
     * there, which is worse than one sitting a few pixels high.
     */
    private drawAxisChips(ctx: CanvasRenderingContext2D, chips: readonly AxisChip[], dataW: number): void {
        if (chips.length === 0) return;
        const byPane = new Map<PaneNode, AxisChip[]>();
        for (const chip of chips) {
            const group = byPane.get(chip.pane);
            if (group) group.push(chip);
            else byPane.set(chip.pane, [chip]);
        }

        const half = AXIS_TAG_HEIGHT / 2;
        for (const [pane, group] of byPane) {
            // Bounds on the chip's CENTRE, so the whole box stays inside the pane.
            const ys = declutterAxisTags(
                group.map((c) => c.y),
                AXIS_TAG_HEIGHT,
                pane.bounds.top + half,
                pane.bounds.top + pane.bounds.height - half,
            );
            for (let i = 0; i < group.length; i++) {
                const chip = group[i]!;
                const y = ys[i]!;
                const w = ctx.measureText(chip.text).width + 8;
                ctx.fillStyle = chip.color;
                ctx.fillRect(dataW + 1, y - half, w, AXIS_TAG_HEIGHT);
                ctx.fillStyle = chip.ink;
                ctx.textAlign = 'center';
                ctx.fillText(chip.text, dataW + 1 + w / 2, y);
                ctx.textAlign = 'start';
            }
        }
    }

    /** The font the tags are set in — one definition, so measuring and painting agree. */
    private tagFont(theme: VelaTheme): string {
        return `11px ${theme.fontFamily}`;
    }

    /**
     * The line being dragged, drawn where the cursor is holding it.
     *
     * The published line stays where it is: until its owner accepts the drop, the level HAS not
     * moved, and drawing only the new position would claim otherwise. So both are on screen —
     * the old one where the stop still is, this one where it would go.
     */
    private drawPriceLineDrag(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, panes: readonly PaneNode[]): void {
        const drag = scene.priceLineDrag;
        if (!drag) return;
        const pane = panes.find((p) => p.id === drag.paneId);
        if (!pane || pane.bounds.height <= 0) return;
        const line = this.findPriceLine(scene, drag.id);
        if (!line) return;
        const y = Math.round(coords.priceToY(drag.price, pane.scale, pane.bounds)) + 0.5;
        const color = line.color ?? theme.textColor;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = line.width ?? 1;
        setDash(ctx, 'solid');
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(dataW, y);
        ctx.stroke();
        const text = formatAxisValue(pane.scale, pane.bounds.height, drag.price, percentScaleFor(scene, pane), scene.priceMintick);
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle = color;
        ctx.fillRect(dataW + 1, y - 8, w, 16);
        ctx.fillStyle = tagTextColor(color, theme.background);
        ctx.textAlign = 'center';
        ctx.fillText(text, dataW + 1 + w / 2, y);
        ctx.restore();
        ctx.textAlign = 'start';
    }

    /** One price line by id, across every mounted model. */
    private findPriceLine(scene: SceneGraph, id: string): PriceLine | null {
        for (const model of scene.indicators.values()) {
            for (const pl of model.priceLines) if (pl.id === id) return pl;
        }
        return null;
    }

    /**
     * What the pointer has hold of on a price line, measured with the font the tag is PAINTED
     * in — which is why this lives here and not in the input layer.
     */
    hitPriceLine(x: number, y: number, line: PriceLine, lineY: number, dataW: number, theme: VelaTheme): PriceLineHit | null {
        const ctx = this.ctx;
        if (!ctx) return null;
        ctx.font = this.tagFont(theme);
        return priceLineHitAt(x, y, line, lineY, dataW, ctx);
    }

    /**
     * The color of the latest price element for the active chart style — matches how the
     * series itself is drawn: candle/bar body up-down, the line/area line color, or the
     * baseline side (above/below the baseline price).
     */
    private priceElementColor(scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, last: OHLCV): string {
        const st = scene.style;
        switch (scene.priceStyle) {
            case 'bars':
                return last.close >= last.open ? (st.bars.upColor ?? theme.upColor) : (st.bars.downColor ?? theme.downColor);
            case 'line':
                return st.line.color ?? theme.upColor;
            case 'area':
                return st.area.lineColor ?? theme.upColor;
            case 'baseline': {
                const i0 = Math.max(0, Math.floor(coords.visibleLogicalRange().from));
                const baseline = scene.baselineValue ?? scene.bars[i0]?.close ?? 0;
                return last.close >= baseline ? (st.baseline.topLineColor ?? theme.upColor) : (st.baseline.bottomLineColor ?? theme.downColor);
            }
            default: // 'candles'
                return last.close >= last.open ? theme.upColor : theme.downColor;
        }
    }

    private drawTimeAxis(ctx: CanvasRenderingContext2D, scene: SceneGraph, coords: CoordinateSystem, theme: VelaTheme, dataW: number, dataH: number, fullH: number): void {
        ctx.strokeStyle = scene.style.borderColor ?? theme.borderColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, dataH + 0.5);
        ctx.lineTo(dataW, dataH + 0.5);
        ctx.stroke();
        if (!scene.showAxisLabels) return;
        ctx.fillStyle = this.axisTextColor;
        ctx.textAlign = 'center';
        const y = dataH + (fullH - dataH) / 2;
        const tr = coords.visibleTimeRange();
        const offset = tzOffsetMs((tr.from + tr.to) / 2, scene.timezone);
        // Width-adaptive density so a narrow surface — a phone, a multi-chart cell —
        // asks for fewer ticks instead of cramming the default eight. The floor of 3
        // keeps a narrow axis populated (a too-small target snaps the ladder to a huge
        // step whose few ticks can all miss the frame); the collision pass below is
        // what actually prevents overlap.
        const target = Math.max(3, Math.min(8, Math.floor(dataW / 64)));
        const ticks = timeTicks(tr.from, tr.to, target, offset)
            .map((tick) => ({ ...tick, x: coords.timeToX(tick.time), half: ctx.measureText(tick.label).width / 2 }))
            .filter((tick) => tick.x >= 20 && tick.x <= dataW - 20);
        // Measured collision pass on top: label pitch in PIXELS isn't uniform (bar-index
        // mapping, session gaps), so overlapping labels are SKIPPED, majors placed first
        // (a date beats the 12:00 beside it).
        const GAP = 12; // min px between neighboring labels
        const placed: Array<{ l: number; r: number }> = [];
        const put = (tick: { x: number; half: number; label: string }): void => {
            const l = tick.x - tick.half;
            const r = tick.x + tick.half;
            if (!placed.every((p) => r + GAP <= p.l || l - GAP >= p.r)) return;
            placed.push({ l, r });
            ctx.fillText(tick.label, tick.x, y);
        };
        for (const tick of ticks) if (tick.major) put(tick);
        for (const tick of ticks) if (!tick.major) put(tick);
        ctx.textAlign = 'start';
    }
}


function unionRange(a: { min: number; max: number } | null, b: { min: number; max: number } | null): { min: number; max: number } | null {
    if (!a) return b;
    if (!b) return a;
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
}

/** Begin a rounded-rectangle path (arcTo-based, no `ctx.roundRect` dependency). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function setDash(ctx: CanvasRenderingContext2D, style: LineStyle): void {
    if (style === 'dashed') ctx.setLineDash([6, 4]);
    else if (style === 'dotted') ctx.setLineDash([2, 3]);
    else ctx.setLineDash([]);
}

/**
 * White or black text for a colored price tag, biased toward white so saturated brand
 * colors (the default candle green / red sit at L≈0.22–0.24) read as white,
 * while genuinely light colors (a white or pale candle color) still get dark text. Uses
 * relative luminance with a flip point of 0.4 — higher than `readableText`'s WCAG crossover
 * (~0.18) which perceptually over-picks black on mid-tone fills. Translucent `bg` is
 * composited over `over` first so the choice reflects what's actually seen.
 */
function tagTextColor(bg: string, over: string): string {
    const [r, g, b, a] = parseColor(bg);
    let R = r;
    let G = g;
    let B = b;
    if (a < 1) {
        const [or, og, ob] = parseColor(over);
        R = r * a + or * (1 - a);
        G = g * a + og * (1 - a);
        B = b * a + ob * (1 - a);
    }
    const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
    return L >= 0.4 ? '#000000' : '#ffffff';
}

/** `M:SS` (or `H:MM:SS` past an hour) for the ms remaining until the bar closes; clamped at 0. */
function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = (v: number): string => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

