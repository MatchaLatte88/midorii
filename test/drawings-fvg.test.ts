import { describe, it, expect } from 'vitest';
import {
    createDrawing,
    deserializeDrawing,
    getDrawingType,
    buildToolbar,
    detectFairValueGaps,
    zoneAt,
    zoneAnchors,
    FairValueGap,
    type FvgBar,
    type Projector,
} from '../src/core/drawings';
import { BEARISH, BULLISH } from '../src/core/palette';

const HR = 3600_000;

/** Bars from `[high, low]` pairs, one per hour from t=0. */
function bars(rows: Array<[high: number, low: number]>): FvgBar[] {
    return rows.map(([high, low], i) => ({ time: i * HR, high, low }));
}

/** Linear projector (x = time/HR, y = 1000 − price) serving `data` through barsInRange. */
function fakeProjector(data: FvgBar[]): Projector {
    return {
        xOf: (t) => t / HR,
        yOf: (price) => 1000 - price,
        pxToPoint: (x, y) => ({ time: x * HR, price: 1000 - y }),
        paneIdAtY: () => 'price',
        barsInRange: (from, to) =>
            data
                .filter((b) => b.time >= Math.min(from, to) && b.time <= Math.max(from, to))
                .map((b) => ({ time: b.time, open: b.low, high: b.high, low: b.low, close: b.high })),
        width: 500,
        height: 1000,
    };
}

/** A bullish three-bar gap [100, 120] formed at bar 2, with quiet bars either side. */
const BULL_GAP = bars([
    [100, 90], // bar 0 — the gap's top edge is this high
    [130, 95], // bar 1 — the impulse
    [140, 120], // bar 2 — its low clears bar 0's high → gap [100, 120]
    [145, 125],
    [150, 130],
]);

describe('drawings/fvg detector', () => {
    it('reads a bullish gap off three bars, drawn from bar i-2 and confirmed at bar i', () => {
        const [zone, ...rest] = detectFairValueGaps(BULL_GAP);
        expect(rest).toHaveLength(0);
        expect(zone).toMatchObject({ direction: 'bull', bottom: 100, top: 120, size: 20, startIndex: 0, index: 2 });
        expect(zone!.mitigatedIndex).toBeNull(); // price never came back down into it
    });

    it('reads a bearish gap the other way round', () => {
        const zones = detectFairValueGaps(bars([[100, 90], [95, 60], [80, 50]]));
        expect(zones).toHaveLength(1);
        expect(zones[0]).toMatchObject({ direction: 'bear', bottom: 80, top: 90, startIndex: 0, index: 2 });
    });

    it('finds nothing when the neighbours traded through the impulse', () => {
        expect(detectFairValueGaps(bars([[100, 90], [130, 95], [140, 99]]))).toHaveLength(0);
        expect(detectFairValueGaps(bars([[100, 90]]))).toHaveLength(0); // fewer than three bars
    });

    it('closes a zone on the first LATER bar that crosses it, never on its own confirming bar', () => {
        // Bar 2 confirms the gap and its own low (120) sits at the top edge — that must not fill it.
        const zones = detectFairValueGaps([...BULL_GAP, { time: 5 * HR, high: 135, low: 99 }]);
        expect(zones[0]!.mitigatedIndex).toBe(5); // the bar that came back through the whole zone
    });

    it('a bar that only reaches INTO the zone leaves it open (a gap dies when it is fully crossed)', () => {
        const zones = detectFairValueGaps([...BULL_GAP, { time: 5 * HR, high: 135, low: 110 }]);
        expect(zones[0]!.mitigatedIndex).toBeNull();
    });

    it('merges stacked gaps of one direction, but only when their bars run together', () => {
        // Two bullish gaps one bar apart: [100,120] at bars 0-2 and [110,125] at bars 1-3. They
        // overlap, so the strip between them is empty and any merge setting joins them.
        const stacked = bars([[100, 90], [110, 95], [140, 120], [150, 125], [150, 130]]);
        expect(detectFairValueGaps(stacked)).toHaveLength(2); // mergeWick 0 → every gap on its own
        const merged = detectFairValueGaps(stacked, { mergeWick: 1, sizeUnit: 'points' });
        expect(merged).toHaveLength(1);
        // The run spans both, starts where the first starts, and is confirmed where the last is.
        expect(merged[0]).toMatchObject({ bottom: 100, top: 125, startIndex: 0, index: 3 });
    });

    it('does not merge two gaps at the same prices that are months apart', () => {
        const early = bars([[100, 90], [130, 95], [140, 120]]);
        const late: FvgBar[] = [
            ...early,
            ...[[100, 90], [130, 95], [140, 120]].map(([high, low], i) => ({ time: (100 + i) * HR, high: high!, low: low! })),
        ];
        // Their bar spans do not overlap, so a generous merge setting still leaves two zones.
        expect(detectFairValueGaps(late, { mergeWick: 100, sizeUnit: 'points' })).toHaveLength(2);
    });
});

describe('drawings/fvg pick', () => {
    it('answers the gap under a point, and null outside it', () => {
        expect(zoneAt(BULL_GAP, { time: 0, price: 110 })).toMatchObject({ bottom: 100, top: 120 });
        expect(zoneAt(BULL_GAP, { time: 0, price: 135 })).toBeNull(); // above the zone
        expect(zoneAt(BULL_GAP, { time: -HR, price: 110 })).toBeNull(); // before the bar it starts on
    });

    it('takes the tolerance as slack in price, so a gap a few pixels tall stays clickable', () => {
        expect(zoneAt(BULL_GAP, { time: 0, price: 122 })).toBeNull();
        expect(zoneAt(BULL_GAP, { time: 0, price: 122 }, 5)).toMatchObject({ top: 120 });
    });

    it('picks the SMALLEST of overlapping zones — the big one stays reachable elsewhere', () => {
        // A wide bullish gap [100,200] over bars 0-2, and a bearish [160,200] sitting inside its
        // upper half from bar 2 on — price came back down without ever crossing the big one.
        const nested = bars([[100, 90], [220, 95], [230, 200], [210, 140], [160, 130], [155, 145]]);
        const zones = detectFairValueGaps(nested);
        expect(zones.map((z) => z.size)).toEqual([100, 40]);
        const hit = zoneAt(nested, { time: 4 * HR, price: 180 })!;
        expect(hit).toMatchObject({ direction: 'bear', bottom: 160, top: 200 });
        // The wide one stays reachable everywhere the narrow one is not.
        expect(zoneAt(nested, { time: 4 * HR, price: 120 })).toMatchObject({ size: 100 });
    });

    it('turns a zone into top-left / bottom-right anchors, an open one ending at the last bar', () => {
        const open = zoneAt(BULL_GAP, { time: 0, price: 110 })!;
        expect(zoneAnchors(open, BULL_GAP)).toEqual([
            { time: 0, price: 120 },
            { time: 4 * HR, price: 100 }, // still open → runs to the last bar loaded
        ]);
        const filledBars = [...BULL_GAP, { time: 5 * HR, high: 135, low: 99 }];
        const filled = zoneAt(filledBars, { time: 0, price: 110 })!;
        expect(zoneAnchors(filled, filledBars)[1]!.time).toBe(5 * HR); // stops where it was filled
    });
});

describe('drawings/FairValueGap tool', () => {
    it('registers in the measure group as a one-click pick tool', () => {
        const meta = getDrawingType('fvg')!;
        expect(meta.group).toBe('measure');
        expect(meta.label).toBe('Fair Value Gap');
        expect(meta.placementHint).toBeTruthy(); // armed-tool prompt at the bottom of the chart
        const d = createDrawing('fvg', { paneId: 'price' })! as FairValueGap;
        expect(d).toBeInstanceOf(FairValueGap);
        expect(d.placementMode()).toBe('click');
        // One click places it; the two slots are the corner handles onPlaced leaves behind.
        expect(d.anchorSchema()).toMatchObject({ min: 1, max: 1 });
        expect(d.anchorSchema().slots).toHaveLength(2);
        expect(d.showMidline).toBe(true);
    });

    it('appears under the Measurements section of the toolbar', () => {
        const { definition } = buildToolbar(true);
        const measure = definition.groups.find((g) => g.id === 'measurements');
        expect(measure?.sections?.find((s) => s.label === 'Measurements')?.tools.map((t) => t.type)).toContain('fvg');
    });

    it('resolves the click into the gap under it, and colors the box by direction', () => {
        const proj = fakeProjector(BULL_GAP);
        const d = createDrawing('fvg', { paneId: 'price', anchors: [{ time: HR, price: 110 }] })! as FairValueGap;
        expect(d.onPlaced(proj)).toBe(true);
        expect(d.anchors).toEqual([
            { time: 0, price: 120 },
            { time: 4 * HR, price: 100 },
        ]);
        expect(d.style.lineColor).toBe(BULLISH);

        const bearBars = bars([[100, 90], [95, 60], [80, 50], [82, 55]]);
        const bear = createDrawing('fvg', { paneId: 'price', anchors: [{ time: HR, price: 85 }] })! as FairValueGap;
        expect(bear.onPlaced(fakeProjector(bearBars))).toBe(true);
        expect(bear.style.lineColor).toBe(BEARISH);
    });

    it('abandons the placement when the click found no imbalance', () => {
        const proj = fakeProjector(BULL_GAP);
        const d = createDrawing('fvg', { paneId: 'price', anchors: [{ time: HR, price: 200 }] })! as FairValueGap;
        expect(d.onPlaced(proj)).toBe(false);
        // A renderer without series access can place nothing at all rather than guessing a box.
        const blind = createDrawing('fvg', { paneId: 'price', anchors: [{ time: HR, price: 110 }] })! as FairValueGap;
        expect(blind.onPlaced({ ...proj, barsInRange: undefined })).toBe(false);
    });

    it('is grabbable anywhere inside the marked zone, and round-trips its midpoint toggle', () => {
        const proj = fakeProjector(BULL_GAP);
        const d = createDrawing('fvg', { paneId: 'price', anchors: [{ time: 0, price: 120 }, { time: 4 * HR, price: 100 }] })! as FairValueGap;
        expect(d.hitTest(2, 890, proj, 3)).toBe(true); // inside (x=2h, price 110)
        expect(d.hitTest(2, 800, proj, 3)).toBe(false); // above the zone
        expect(d.bounds(proj)).toEqual({ x: 0, y: 880, w: 4, h: 20 });
        expect(d.priceRange()).toEqual({ min: 100, max: 120 });

        d.applySettings({ showMidline: false });
        const back = deserializeDrawing(d.serialize())! as FairValueGap;
        expect(back.showMidline).toBe(false);
        expect(back.anchors).toEqual(d.anchors);
    });
});
