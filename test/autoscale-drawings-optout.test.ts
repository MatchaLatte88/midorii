import { describe, it, expect } from 'vitest';
import { ChromeRenderer } from '../src/renderers/native/chrome/ChromeRenderer';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import type { IndicatorModel } from '../src/core/model/indicator';
import type { DrawingBox } from '../src/core/model/drawings';
import { DARK_THEME } from '../src/core/theme';

/**
 * A box an indicator draws normally expands its pane's scale — the pane has to show what the
 * indicator put there. `autoscaleDrawings: false` opts out, for an indicator whose drawings are
 * context spread across the whole price history rather than the subject of the pane (fair value
 * gaps stand until price fills them, and the oldest sit far below the market).
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function box(top: number, bottom: number): DrawingBox {
    return {
        id: 'b1', paneId: 'price', xloc: 'bar_time', overlay: true,
        left: T0, right: T0 + 3 * MIN, top, bottom,
        extend: 'none', bgColor: '#0f08', borderWidth: 0, borderStyle: 'solid',
        textSize: 'auto', hAlign: 'center', vAlign: 'center',
        wrap: false, fontFamily: 'default', bold: false, italic: false,
    };
}

function model(boxes: DrawingBox[], autoscaleDrawings?: boolean): IndicatorModel {
    return {
        id: 'ind', title: 'Zones', overlay: true, paneHint: 'price', paneId: 'price',
        series: [], fills: [], backgrounds: [], priceLines: [], boxes,
        inputs: [], inputValues: {},
        ...(autoscaleDrawings === false ? { autoscaleDrawings: false } : {}),
    };
}

function harness(m: IndicatorModel): { chrome: ChromeRenderer; scene: SceneGraph } {
    const scene = new SceneGraph();
    scene.ensurePane('price', 'price', 0, 3);
    scene.bars = Array.from({ length: 4 }, (_, i) => ({
        time: T0 + i * MIN, open: 100, high: 101, low: 99, close: 100,
    }));
    scene.indicators.set(m.id, m);
    const coords = new CoordinateSystem();
    coords.setSize(800, 400, 1);
    coords.setBars(scene.bars.map((b) => b.time));
    const chrome = new ChromeRenderer();
    chrome.prepare(scene, coords, DARK_THEME);
    return { chrome, scene };
}

describe('autoscale — an indicator can keep its drawings off the scale', () => {
    const vr = { from: 0, to: 3 };

    it('folds a box in by default, however far it sits from the bars', () => {
        const m = model([box(400, 300)]);
        const { chrome, scene } = harness(m);
        expect(chrome.paneDrawingsRange([m], scene, true, vr)).toEqual({ min: 300, max: 400 });
    });

    it('leaves the scale alone when the indicator opted out', () => {
        const m = model([box(400, 300)], false);
        const { chrome, scene } = harness(m);
        // Null, not a clamped range: the pane scales as if the box were not there at all.
        expect(chrome.paneDrawingsRange([m], scene, true, vr)).toBeNull();
    });

    it('opts out of the price pane pass too, not just its own pane', () => {
        // A force_overlay drawing reaches the price pane through the second loop; the flag has
        // to hold there as well, or an overlay indicator would still yank the axis.
        const m = model([box(400, 300)], false);
        const { chrome, scene } = harness(m);
        expect(chrome.paneDrawingsRange([], scene, true, vr)).toBeNull();
        // The same model without the flag does reach it.
        const on = model([box(400, 300)]);
        const h = harness(on);
        expect(h.chrome.paneDrawingsRange([], h.scene, true, vr)).toEqual({ min: 300, max: 400 });
    });
});
