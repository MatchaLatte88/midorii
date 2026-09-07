import { describe, it, expect } from 'vitest';
import { DrawingPainter } from '../src/renderers/native/drawings/DrawingPainter';
import { sliceKeyFor } from '../src/renderers/native/drawings/UserDrawingController';
import { createDrawing, type Projector } from '../src/core/drawings';
import type { VelaTheme } from '../src/core/options';

/** Linear projector: x = time, y = 100 − price, single pane 'price'. */
function fakeProjector(): Projector {
    return {
        xOf: (t) => t,
        yOf: (price, paneId) => (paneId === 'price' ? 100 - price : null),
        pxToPoint: (x, y) => ({ time: x, price: 100 - y }),
        paneIdAtY: () => 'price',
        width: 200,
        height: 100,
    };
}

/** A canvas context that counts `arc()` calls (each selection handle is one arc) and `lineTo()`
 *  ones (a painted line body — handles are arcs only). */
function recordingCtx() {
    let arcs = 0;
    let lines = 0;
    const ctx = {
        globalAlpha: 1,
        setTransform() {},
        clearRect() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {
            lines += 1;
        },
        arcTo() {},
        stroke() {},
        fill() {},
        setLineDash() {},
        arc() {
            arcs += 1;
        },
        fillRect() {},
        strokeRect() {},
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        fillText() {},
        measureText: () => ({ width: 0 }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs: () => arcs, lines: () => lines };
}

const theme = { textColor: '#fff', background: '#131722', fontFamily: 'sans-serif' } as unknown as VelaTheme;
const hline = (id: string, price: number) => createDrawing('hline', { id, paneId: 'price', anchors: [{ time: 10, price }] })!;

describe('DrawingPainter.paintAll handle highlighting', () => {
    it('paints handles for every selected id', () => {
        const drawings = [hline('a', 30), hline('b', 50)];
        const { ctx, arcs } = recordingCtx();
        new DrawingPainter().paintAll(ctx, drawings, fakeProjector(), theme, { selected: new Set(['a', 'b']) });
        expect(arcs()).toBe(2); // one handle per selected hline
    });

    it('paints handles for the hovered and dragged drawings too', () => {
        const drawings = [hline('a', 30), hline('b', 50)];
        const { ctx, arcs } = recordingCtx();
        new DrawingPainter().paintAll(ctx, drawings, fakeProjector(), theme, { hovered: 'a', dragged: 'b' });
        expect(arcs()).toBe(2);
    });

    it('paints no handles when nothing is targeted', () => {
        const drawings = [hline('a', 30), hline('b', 50)];
        const { ctx, arcs } = recordingCtx();
        new DrawingPainter().paintAll(ctx, drawings, fakeProjector(), theme);
        expect(arcs()).toBe(0);
    });

    // Drawings interleaved into the series stack paint their bodies on the backend-composited
    // layers, but their handles have to come back to the top canvas — buried under the candles
    // they'd be unusable.
    it('paintHighlights draws handles alone, for the highlighted ones only', () => {
        const drawings = [hline('a', 30), hline('b', 50)];
        const { ctx, arcs, lines } = recordingCtx();
        new DrawingPainter().paintHighlights(ctx, drawings, fakeProjector(), new Set(['b']));
        expect(arcs()).toBe(1); // b's handle …
        expect(lines()).toBe(0); // … and neither body
    });
});

describe('sliceKeyFor — which interleave layer a drawing paints on', () => {
    // Boundaries: an indicator at -2, the candles at 0, a raised indicator at 5.
    const bounds = [-2, 0, 5];

    it('a drawing over every boundary stays on the top canvas', () => {
        expect(sliceKeyFor(6, bounds)).toBeNull();
        expect(sliceKeyFor(9, [])).toBeNull();
    });

    it('slots a drawing under the first series at-or-above its z', () => {
        expect(sliceKeyFor(1, bounds)).toBe(5); // between the candles and the raised indicator
        expect(sliceKeyFor(-1, bounds)).toBe(0); // under the candles, over the back indicator
        expect(sliceKeyFor(-9, bounds)).toBe(-2); // under everything
    });

    it('a tie paints under the series carrying that z', () => {
        expect(sliceKeyFor(0, bounds)).toBe(0);
        expect(sliceKeyFor(5, bounds)).toBe(5);
    });
});

describe('DrawingPainter.paintAll muted label', () => {
    /** A ctx that records the strings passed to `fillText`. */
    function textCountingCtx() {
        const base = recordingCtx();
        const texts: string[] = [];
        (base.ctx as unknown as Record<string, unknown>).fillText = (s: string) => { texts.push(s); };
        return { ctx: base.ctx, texts: () => texts };
    }

    const label = (id: string) => createDrawing('text', { id, paneId: 'price', anchors: [{ time: 10, price: 50 }], text: { value: 'Buy zone', size: 'normal', hAlign: 'left', vAlign: 'top' } })!;

    it('paints a text label normally', () => {
        const { ctx, texts } = textCountingCtx();
        new DrawingPainter().paintAll(ctx, [label('a')], fakeProjector(), theme);
        expect(texts()).toEqual(['Buy zone']);
    });

    it('leaves the muted label to its inline editor (and only that one)', () => {
        const { ctx, texts } = textCountingCtx();
        new DrawingPainter().paintAll(ctx, [label('a'), label('b')], fakeProjector(), theme, { mutedLabel: 'a' });
        expect(texts()).toEqual(['Buy zone']); // 'b' still painted, 'a' muted
    });

    it('hides the muted label\u2019s drag handle too (typing, not dragging)', () => {
        const { ctx, arcs } = recordingCtx();
        new DrawingPainter().paintAll(ctx, [label('a')], fakeProjector(), theme, { selected: new Set(['a']), mutedLabel: 'a' });
        expect(arcs()).toBe(0);
    });
});

describe('DrawingPainter.paintAll text label frame', () => {
    /** A ctx that records the stroke color of every `stroke()` (the frame is the only stroke here). */
    function strokeRecordingCtx() {
        const base = recordingCtx();
        const strokes: string[] = [];
        const ctx = base.ctx as unknown as Record<string, unknown>;
        ctx.strokeStyle = '';
        ctx.stroke = () => { strokes.push(String(ctx.strokeStyle)); };
        return { ctx: base.ctx, strokes: () => strokes };
    }

    const label = (id: string) => createDrawing('text', { id, paneId: 'price', anchors: [{ time: 10, price: 50 }], text: { value: 'Buy zone', size: 'normal', hAlign: 'left', vAlign: 'top' } })!;
    const frame = (targets: { selected?: ReadonlySet<string>; hovered?: string | null }): string[] => {
        const { ctx, strokes } = strokeRecordingCtx();
        new DrawingPainter().paintAll(ctx, [label('a')], fakeProjector(), theme, targets);
        // Targeting also paints the handle (a hex-colored border); the frame is the themed rgba stroke.
        return strokes().filter((s) => s.startsWith('rgba('));
    };

    it('frames a selected text label, and a hovered one more faintly', () => {
        const selected = frame({ selected: new Set(['a']) });
        const hovered = frame({ hovered: 'a' });
        expect(selected).toHaveLength(1);
        expect(hovered).toHaveLength(1);
        expect(selected[0]).toContain('0.3'); // firm once clicked
        expect(hovered[0]).toContain('0.12'); // a hint under the cursor
    });

    it('leaves an untargeted label unframed', () => {
        expect(frame({})).toEqual([]);
        expect(frame({ selected: new Set(['other']), hovered: 'other' })).toEqual([]);
    });
});

describe('DrawingPainter.paintAll pane separation', () => {
    /** fakeProjector + paneRect: 'price' is a live 100px pane; 'hidden' is zero-height. */
    function paneAwareProjector(): Projector {
        return {
            ...fakeProjector(),
            paneRect: (paneId) => (paneId === 'price' ? { top: 0, height: 100 } : paneId === 'hidden' ? { top: 100, height: 0 } : null),
        };
    }

    /** A ctx that additionally counts `clip()` and `stroke()` calls. */
    function clipCountingCtx() {
        const base = recordingCtx();
        let clips = 0;
        let strokes = 0;
        const ctx = base.ctx as unknown as Record<string, unknown>;
        ctx.clip = () => { clips += 1; };
        ctx.rect = () => {};
        const origStroke = ctx.stroke as () => void;
        ctx.stroke = () => { strokes += 1; origStroke(); };
        return { ctx: base.ctx, arcs: base.arcs, clips: () => clips, strokes: () => strokes };
    }

    it('clips each drawing to its pane rect', () => {
        const drawings = [hline('a', 30), hline('b', 50)];
        const { ctx, clips } = clipCountingCtx();
        new DrawingPainter().paintAll(ctx, drawings, paneAwareProjector(), theme);
        expect(clips()).toBe(2); // one clip per painted drawing
    });

    it('skips drawings on a hidden (zero-height) pane entirely — body and handles', () => {
        const onHidden = createDrawing('hline', { id: 'h', paneId: 'hidden', anchors: [{ time: 10, price: 30 }] })!;
        const { ctx, arcs, strokes } = clipCountingCtx();
        new DrawingPainter().paintAll(ctx, [onHidden], paneAwareProjector(), theme, { selected: new Set(['h']) });
        expect(strokes()).toBe(0); // nothing painted
        expect(arcs()).toBe(0); // no handles either
    });

    it('paints unclipped when the projector exposes no pane geometry (back-compat)', () => {
        const drawings = [hline('a', 30)];
        const { ctx, clips, strokes } = clipCountingCtx();
        new DrawingPainter().paintAll(ctx, drawings, fakeProjector(), theme);
        expect(clips()).toBe(0);
        expect(strokes()).toBeGreaterThan(0);
    });
});

describe('DrawingPainter trendline label follows the line', () => {
    it('rotates the label to the upright segment angle', () => {
        const d = createDrawing('trendline', {
            id: 't',
            paneId: 'price',
            anchors: [
                { time: 0, price: 0 },
                { time: 50, price: 50 },
            ],
            text: { value: 'zone', size: 'normal', hAlign: 'center', vAlign: 'top' },
        })!;
        const { ctx } = recordingCtx();
        const angles: number[] = [];
        (ctx as unknown as Record<string, unknown>).rotate = (a: number) => {
            angles.push(a);
        };
        new DrawingPainter().paintAll(ctx, [d], fakeProjector(), theme);
        expect(angles).toHaveLength(1);
        // projector y = 100 − price: (0,100) → (50,50) is up-right → −π/4
        expect(angles[0]).toBeCloseTo(-Math.PI / 4);
    });

    it('does not rotate a flat text annotation', () => {
        const d = createDrawing('text', {
            id: 'a',
            paneId: 'price',
            anchors: [{ time: 10, price: 50 }],
            text: { value: 'note', size: 'normal', hAlign: 'left', vAlign: 'top' },
        })!;
        const { ctx } = recordingCtx();
        let rotated = 0;
        (ctx as unknown as Record<string, unknown>).rotate = () => {
            rotated += 1;
        };
        new DrawingPainter().paintAll(ctx, [d], fakeProjector(), theme);
        expect(rotated).toBe(0);
    });
});

describe('DrawingPainter position tool readouts', () => {
    /** A roomy projector: y = 500 − price·5, so the zones are tall enough to hold a field. */
    const roomy = (width = 600): Projector => ({
        xOf: (t) => t,
        yOf: (price, paneId) => (paneId === 'price' ? 500 - price * 5 : null),
        pxToPoint: (x, y) => ({ time: x, price: (500 - y) / 5 }),
        paneIdAtY: () => 'price',
        width,
        height: 500,
    });

    /** entry 50 → y 250, stop 40 → y 300, target 80 → y 100; the block spans x 10…400. */
    const position = (zoneStyle: 'solid' | 'gradient' = 'solid') => {
        const d = createDrawing('position', {
            id: 'p',
            paneId: 'price',
            anchors: [{ time: 10, price: 50 }, { time: 400, price: 40 }, { time: 400, price: 80 }],
        })!;
        d.applySettings({ zoneStyle });
        return d;
    };

    /** Records every `fillText` with its position and the color it was written in, plus the
     *  rounded-rect plates (their first arcTo corner) and any gradient stops. */
    function fieldCtx() {
        const base = recordingCtx();
        const texts: Array<{ text: string; x: number; y: number; color: string }> = [];
        const stops: string[] = [];
        const plates: string[] = [];
        const ctx = base.ctx as unknown as Record<string, unknown>;
        let fill = '';
        Object.defineProperty(ctx, 'fillStyle', { get: () => fill, set: (v: unknown) => { fill = typeof v === 'string' ? v : '[gradient]'; } });
        ctx.fillText = (text: string, x: number, y: number) => { texts.push({ text, x, y, color: fill }); };
        ctx.fill = () => { plates.push(fill); };
        ctx.measureText = (str: string) => ({ width: str.length * 6 });
        ctx.createLinearGradient = (_x0: number, y0: number, _x1: number, y1: number) => {
            stops.push(`${y0}->${y1}`);
            return { addColorStop: (o: number, c: string) => { stops.push(`${o} ${c}`); } };
        };
        return { ctx: base.ctx, texts, stops, plates };
    }

    const paint = (width?: number, zoneStyle?: 'solid' | 'gradient') => {
        const h = fieldCtx();
        new DrawingPainter().paintAll(h.ctx, [position(zoneStyle)], roomy(width), theme);
        return h;
    };
    const seg = (texts: Array<{ text: string; x: number; y: number; color: string }>, t: string) => texts.find((v) => v.text === t)!;

    it('lays each field inside the zone its level opens, never over the line itself', () => {
        const { texts } = paint();
        // Reward zone runs y 100 (target) → 250 (entry): the TP field sits inside it.
        expect(seg(texts, 'TP').y).toBeGreaterThan(100);
        expect(seg(texts, 'TP').y).toBeLessThan(250);
        // Risk zone runs y 250 (entry) → 300 (stop): the SL field sits inside that one.
        expect(seg(texts, 'SL').y).toBeGreaterThan(250);
        expect(seg(texts, 'SL').y).toBeLessThan(300);
        // The entry has no zone of its own — its field rides the line, centred on it.
        expect(seg(texts, 'LONG').y).toBe(250.5);
    });

    it('states the level in its own color and the price in the text color', () => {
        const { texts } = paint();
        expect(seg(texts, 'TP').color).toBe(seg(texts, '+60.00%').color); // tag and figure: profit color
        expect(seg(texts, 'TP').color).not.toBe(seg(texts, '80.00').color); // the price is not
        expect(seg(texts, '80.00').color).toBe(theme.textColor);
        expect(seg(texts, 'SL').color).toBe(seg(texts, '−20.00%').color);
        expect(seg(texts, 'SL').color).not.toBe(seg(texts, 'TP').color); // loss color ≠ profit color
    });

    it('puts the risk field on the stop line, opposite the stop field', () => {
        const { texts } = paint();
        expect(seg(texts, 'RISK').y).toBe(seg(texts, 'SL').y); // same row
        expect(seg(texts, 'RISK').x).toBeLessThan(seg(texts, 'SL').x); // left edge vs right edge
        expect(seg(texts, 'RISK').x).toBe(23); // x1 10 + inset 6 + padding 7
    });

    it('drops the risk field a row when it cannot sit beside the stop field', () => {
        const h = fieldCtx();
        const narrow = createDrawing('position', {
            id: 'p',
            paneId: 'price',
            anchors: [{ time: 10, price: 50 }, { time: 120, price: 40 }, { time: 120, price: 80 }],
        })!;
        new DrawingPainter().paintAll(h.ctx, [narrow], roomy(), theme);
        const rows = h.texts;
        expect(seg(rows, 'RISK').y).toBeLessThan(seg(rows, 'SL').y); // moved toward the entry
    });

    it('puts the risk field outside the block when the risk zone is too shallow for a row', () => {
        const h = fieldCtx();
        // entry 50 → y 250, stop 47 → y 265: fifteen pixels of risk zone, no room to stack.
        const flat = createDrawing('position', {
            id: 'p',
            paneId: 'price',
            anchors: [{ time: 10, price: 50 }, { time: 120, price: 47 }, { time: 120, price: 80 }],
        })!;
        new DrawingPainter().paintAll(h.ctx, [flat], roomy(), theme);
        // Below the stop line (y 265) rather than stacked up onto the entry field at y 250.
        expect(seg(h.texts, 'RISK').y).toBeGreaterThan(265);
        expect(seg(h.texts, 'RISK').y).toBeGreaterThan(seg(h.texts, 'SL').y);
    });

    it('backs every field with a fully opaque plate', () => {
        const h = fieldCtx();
        new DrawingPainter().paintAll(h.ctx, [position()], roomy(), theme);
        // A field sits ON the candles it annotates: any alpha below 1 lets a bright wick break
        // up 12px digits, which is exactly what the plate is there to prevent.
        expect(h.plates.filter((c) => c.startsWith('rgba(')).every((c) => c.endsWith(',1)'))).toBe(true);
    });

    it('turns a field out through its own line when its zone is too shallow for it', () => {
        const h = fieldCtx();
        // entry 50 → y 250, target 53 → y 235: fifteen pixels of reward zone.
        const flat = createDrawing('position', {
            id: 'p',
            paneId: 'price',
            anchors: [{ time: 10, price: 50 }, { time: 400, price: 20 }, { time: 400, price: 53 }],
        })!;
        new DrawingPainter().paintAll(h.ctx, [flat], roomy(), theme);
        // Above the target line (y 235), not stacked down onto the entry field at y 250.
        expect(seg(h.texts, 'TP').y).toBeLessThan(235);
    });

    it('leaves the readouts to the overlay pass when the body paints into the series stack', () => {
        // A block whose z sits inside the series stack paints its body on an interleave layer,
        // which is BELOW the candles and is built on data frames — no interaction state, so no
        // hover. Both reasons the readouts must not be painted down there.
        const painter = new DrawingPainter();
        const body = fieldCtx();
        painter.overlays = false;
        painter.paintAll(body.ctx, [position()], roomy(), theme);
        painter.overlays = true;
        expect(body.texts).toEqual([]); // zones and lines only

        const top = fieldCtx();
        painter.paintOverlays(top.ctx, [position()], roomy(), theme);
        expect(top.texts.map((v) => v.text)).toContain('LONG');
    });

    it('honours hover in the overlay pass, which is the only one that sees it', () => {
        const shy = position();
        shy.applySettings({ textOnHover: true });
        const painter = new DrawingPainter();
        const cold = fieldCtx();
        painter.paintOverlays(cold.ctx, [shy], roomy(), theme);
        expect(cold.texts).toEqual([]);
        const warm = fieldCtx();
        painter.paintOverlays(warm.ctx, [shy], roomy(), theme, { hovered: 'p' });
        expect(warm.texts.map((v) => v.text)).toContain('LONG');
    });

    it('holds the readouts back until the block is read, when asked to', () => {
        const shy = position();
        shy.applySettings({ textOnHover: true });
        const painter = new DrawingPainter();
        const cold = fieldCtx();
        painter.paintAll(cold.ctx, [shy], roomy(), theme);
        expect(cold.texts).toEqual([]); // the zones still paint — the numbers don't

        for (const targets of [{ hovered: 'p' }, { dragged: 'p' }, { selected: new Set(['p']) }]) {
            const warm = fieldCtx();
            painter.paintAll(warm.ctx, [shy], roomy(), theme, targets);
            expect(warm.texts.map((v) => v.text)).toContain('LONG');
        }
    });

    it('fades a gradient zone out at the entry, where the two zones meet', () => {
        const { stops } = paint(600, 'gradient');
        // Reward: target y100 → entry y250. Risk: stop y300 → entry y250. Both end transparent.
        expect(stops).toEqual([
            '100->250', '0 rgba(14,203,129,0.3)', '1 rgba(14,203,129,0)',
            '300->250', '0 rgba(246,70,93,0.3)', '1 rgba(246,70,93,0)',
        ]);
    });

    it('draws no gradient when the zones are solid', () => {
        expect(paint().stops).toEqual([]);
    });
});
