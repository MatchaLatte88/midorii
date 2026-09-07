import { describe, it, expect, vi } from 'vitest';
import { InputController, type InputControllerDeps } from '../src/renderers/native/core/InputController';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';

// ── hover over a price line: the cursor says what can be taken hold of ──
//
// A stop on an open position is a 1px line with a 6px grab zone around it. Without the
// cursor changing there is nothing at all to say it can be dragged, and a press that misses
// by three pixels pans the chart instead — which is what "the stop won't move" looks like
// from the outside. So the wiring itself is asserted here, not just the geometry.

/** Bare-bones event-target stand-in — enough surface for InputController.attach(). */
function fakeElement() {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    return {
        addEventListener(type: string, fn: (e: unknown) => void) {
            (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
        },
        removeEventListener(type: string, fn: (e: unknown) => void) {
            listeners.get(type)?.delete(fn);
        },
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        style: { cursor: '', setProperty() {} } as unknown as CSSStyleDeclaration,
        setPointerCapture() {},
        releasePointerCapture() {},
        fire(type: string, e: Record<string, unknown>) {
            for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
        },
    };
}

function harness(over: Partial<InputControllerDeps>) {
    const cs = new CoordinateSystem();
    cs.setSize(800, 200, 1);
    cs.setBars([1000, 2000, 3000, 4000, 5000]);
    cs.setViewport({ barSpacing: 50, rightOffset: 2 });
    const deps = {
        getCoords: () => cs,
        apply: vi.fn(),
        zoomTo: vi.fn(),
        fling: vi.fn(),
        onPointerMove: vi.fn(),
        onClick: vi.fn(),
        beginPriceScale: vi.fn(),
        priceScaleBy: vi.fn(),
        beginPricePan: () => false,
        pricePanBy: vi.fn(),
        resetPriceScale: vi.fn(),
        dataDblClick: vi.fn(),
        paneSeparatorAt: () => false,
        beginPaneResize: vi.fn(),
        paneResizeBy: vi.fn(),
        resetPaneSize: vi.fn(),
        resetView: vi.fn(),
        ...over,
    } satisfies InputControllerDeps;
    const ctl = new InputController(deps);
    const el = fakeElement();
    ctl.attach(el as unknown as HTMLElement);
    const hover = (x: number, y: number): string => {
        el.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, timeStamp: 0, ctrlKey: false, metaKey: false, shiftKey: false });
        return el.style.cursor;
    };
    return { hover, deps };
}

describe('price-line hover cursor', () => {
    it('shows a vertical-resize cursor over a draggable level', () => {
        const { hover } = harness({ priceLinesCursor: (_x, y) => (y === 100 ? 'ns-resize' : null) });
        expect(hover(400, 100)).toBe('ns-resize');
    });

    it('leaves the cursor alone where there is no price line', () => {
        const { hover } = harness({ priceLinesCursor: () => null });
        expect(hover(400, 50)).toBe('');
    });

    it('lets the price line win over a drawing under the same pixel', () => {
        // Price lines are chrome, painted over every drawing — and they claim a press first,
        // so the cursor has to promise the same thing the press will do.
        const { hover } = harness({
            priceLinesCursor: () => 'pointer',
            drawingsCursor: () => 'move',
        });
        expect(hover(400, 100)).toBe('pointer');
    });

    it('still falls back to the drawings cursor away from any price line', () => {
        const { hover } = harness({
            priceLinesCursor: () => null,
            drawingsCursor: () => 'move',
        });
        expect(hover(400, 100)).toBe('move');
    });
});
