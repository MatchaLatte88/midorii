// The ambient background blobs on the backdrop canvas (BackdropRenderer.drawBlobs) —
// what gets painted, when, and with which gradient stops. A recording 2d-context stub
// stands in for the canvas: the tests assert the paint CALLS, not pixels.
import { describe, expect, it } from 'vitest';
import { BackdropRenderer } from '../src/renderers/native/backdrop/BackdropRenderer';
import { defaultChartStyle, type ChartStyle } from '../src/renderers/native/core/chartConfig';
import type { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import type { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import type { VelaTheme } from '../src/core/options';
import { DARK_THEME } from '../src/core/theme';

interface Stop {
    offset: number;
    color: string;
}
interface Fill {
    stops: Stop[];
    /** The rect in the gradient's own (scaled) space, plus the transform that produced it. */
    rect: { x: number; y: number; w: number; h: number };
    translate: { x: number; y: number };
    scale: { x: number; y: number };
}

/** A 2d context that records the gradient fills, ignoring everything else. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; fills: Fill[] } {
    const fills: Fill[] = [];
    let stops: Stop[] = [];
    let translate = { x: 0, y: 0 };
    let scale = { x: 1, y: 1 };
    const ctx = {
        fillStyle: '' as unknown,
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        setTransform: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        translate: (x: number, y: number) => { translate = { x, y }; },
        scale: (x: number, y: number) => { scale = { x, y }; },
        createRadialGradient: () => {
            stops = [];
            const grad = { addColorStop: (offset: number, color: string) => { stops.push({ offset, color }); } };
            return grad as unknown as CanvasGradient;
        },
        fillRect: (x: number, y: number, w: number, h: number) => {
            fills.push({ stops: [...stops], rect: { x, y, w, h }, translate, scale });
        },
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

const W = 800;
const H = 600;

/** Mount a renderer over the recording context; `barCount` 0 means "no data yet". */
function setup(style: ChartStyle, barCount = 0): { renderer: BackdropRenderer; fills: Fill[]; scene: SceneGraph; coords: CoordinateSystem; theme: VelaTheme } {
    const { ctx, fills } = recordingCtx();
    const canvas = { width: W, height: H, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const renderer = new BackdropRenderer();
    renderer.mount(canvas);
    const coords = {
        dpr: 1,
        width: W,
        height: H,
        barCount,
        visibleLogicalRange: () => ({ from: 0, to: 0 }),
    } as unknown as CoordinateSystem;
    const scene = { style } as unknown as SceneGraph;
    return { renderer, fills, scene, coords, theme: DARK_THEME };
}

describe('BackdropRenderer — ambient blobs', () => {
    it('paints both blobs before any bars exist (they are cosmetic, not data)', () => {
        const { renderer, fills, scene, coords, theme } = setup(defaultChartStyle(), 0);
        renderer.render(scene, coords, theme, 1);
        expect(fills).toHaveLength(2);
    });

    it('anchors each blob outside its own corner and covers the whole data area', () => {
        const { renderer, fills, scene, coords, theme } = setup(defaultChartStyle());
        renderer.render(scene, coords, theme, 1);
        const [tl, br] = fills;
        // Top-left: center above and left of the plot's own top-left corner.
        expect(tl!.translate.x).toBeCloseTo(0.12 * W);
        expect(tl!.translate.y).toBeCloseTo(-0.08 * H);
        // Bottom-right: center past the opposite corner.
        expect(br!.translate.x).toBeCloseTo(1.04 * W);
        expect(br!.translate.y).toBeCloseTo(1.08 * H);
        // Each fill rect maps back to exactly (0,0,W,H) in screen space.
        for (const f of fills) {
            expect(f.rect.x * f.scale.x + f.translate.x).toBeCloseTo(0);
            expect(f.rect.y * f.scale.y + f.translate.y).toBeCloseTo(0);
            expect(f.rect.w * f.scale.x).toBeCloseTo(W);
            expect(f.rect.h * f.scale.y).toBeCloseTo(H);
        }
    });

    it('fades to the SAME color at alpha 0, so no gray cast bleeds through the falloff', () => {
        const { renderer, fills, scene, coords, theme } = setup(defaultChartStyle());
        renderer.render(scene, coords, theme, 1);
        expect(fills[0]!.stops).toEqual([
            { offset: 0, color: 'rgba(41,98,255,0.14)' },
            { offset: 0.65, color: 'rgba(41,98,255,0)' },
            { offset: 1, color: 'rgba(41,98,255,0)' },
        ]);
    });

    it('inherits the theme accent when the blob has no color of its own', () => {
        const { renderer, fills, scene, coords } = setup(defaultChartStyle());
        renderer.render(scene, coords, { ...DARK_THEME, accent: '#0369a1' }, 1);
        expect(fills[0]!.stops[0]!.color).toBe('rgba(3,105,161,0.14)');
        expect(fills[1]!.stops[0]!.color).toBe('rgba(3,105,161,0.11)');
    });

    it('uses a pinned color instead of the accent', () => {
        const style = defaultChartStyle();
        style.blobs.topLeft.color = 'rgba(255,0,0,0.2)';
        const { renderer, fills, scene, coords } = setup(style);
        renderer.render(scene, coords, { ...DARK_THEME, accent: '#0369a1' }, 1);
        expect(fills[0]!.stops[0]!.color).toBe('rgba(255,0,0,0.2)');
        expect(fills[1]!.stops[0]!.color).toBe('rgba(3,105,161,0.11)'); // the other still inherits
    });

    it('falls back to clear black when the color cannot be re-emitted at alpha 0', () => {
        const style = defaultChartStyle();
        style.blobs.topLeft.color = 'rebeccapurple'; // named CSS color: unparseable here
        style.blobs.bottomRight.visible = false;
        const { renderer, fills, scene, coords, theme } = setup(style);
        renderer.render(scene, coords, theme, 1);
        // The outer stops must NOT echo the opaque color back — that would flood the pane.
        expect(fills[0]!.stops).toEqual([
            { offset: 0, color: 'rebeccapurple' },
            { offset: 0.65, color: 'rgba(0,0,0,0)' },
            { offset: 1, color: 'rgba(0,0,0,0)' },
        ]);
    });

    it('skips a blob that is switched off, and paints nothing when both are', () => {
        const one = defaultChartStyle();
        one.blobs.topLeft.visible = false;
        const a = setup(one);
        a.renderer.render(a.scene, a.coords, a.theme, 1);
        expect(a.fills).toHaveLength(1);
        // The single fill is the bottom-right one — its own strength, not the top-left's.
        expect(a.fills[0]!.stops[0]!.color).toBe('rgba(41,98,255,0.11)');

        const none = defaultChartStyle();
        none.blobs.topLeft.visible = false;
        none.blobs.bottomRight.visible = false;
        const b = setup(none);
        b.renderer.render(b.scene, b.coords, b.theme, 1);
        expect(b.fills).toHaveLength(0);
    });

    it('paints nothing when the data area has collapsed to zero', () => {
        const { renderer, fills, scene, theme } = setup(defaultChartStyle());
        const coords = { dpr: 1, width: 0, height: 0, barCount: 0, visibleLogicalRange: () => ({ from: 0, to: 0 }) } as unknown as CoordinateSystem;
        renderer.render(scene, coords, theme, 1);
        expect(fills).toHaveLength(0);
    });
});
