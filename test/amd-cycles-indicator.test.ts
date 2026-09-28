import { describe, expect, it } from 'vitest';
import type { DataControl } from '../src/core/DataControl';
import { detectAmdCycles, type AmdGap } from '../src/core/analysis/amdCycles';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { NativeIndicatorContext } from '../src/core/native-indicators';
import { amdCyclesDescriptor, buildAmdCyclesOutput } from '../src/core/native-indicators/amd-cycles';
import type { EngineAlert } from '../src/core/ports/ScriptingEngine';

const MINUTE = 60_000;
type Row = [number, number, number, number];

const FLAT: Row = [100, 100.2, 99.9, 100.1];
const LOW_FLAT: Row = [99.1, 99.3, 98.9, 99.1];
const ROWS: Row[] = [
    ...Array.from({ length: 6 }, () => FLAT),
    [100.1, 100.8, 100, 100.6],
    [100.6, 100.9, 100.4, 100.5],
    [100.5, 100.6, 100, 100.1],
    [100.1, 100.15, 99.5, 99.6],
    [99.6, 99.7, 99, 99.1],
    ...Array.from({ length: 5 }, () => LOW_FLAT),
    [99.1, 99.2, 98.5, 98.6],
    ...Array.from({ length: 5 }, (): Row => [98.6, 98.8, 98.4, 98.6]),
];
const SERIES: OHLCV[] = ROWS.map(([open, high, low, close], index) => ({
    time: Date.parse('2024-01-02T14:00:00Z') + index * MINUTE,
    open,
    high,
    low,
    close,
    volume: 1,
}));
const TIMES = SERIES.map((bar) => bar.time);
const OPTS = { accLength: 5, accRangePct: 0.5, breakout: 'wicks' as const, maxManipulationBars: 3 };

const VIEW = {
    maxCycles: 5,
    showFvg: true,
    showIfvg: false,
    accColor: '#888888',
    manColor: '#e0b400',
    fvgBullColor: '#00aa88',
    fvgBearColor: '#ee3344',
    ifvgBullColor: '#00cc88',
    ifvgBearColor: '#ff4455',
    boxTextColor: '#ffffff',
    labelTextColor: '#ffffff',
};

function gap(overrides: Partial<AmdGap>): AmdGap {
    return {
        direction: 'bull',
        top: 101,
        bottom: 100,
        startIndex: 2,
        startTime: TIMES[2]!,
        index: 4,
        time: TIMES[4]!,
        brokenIndex: null,
        inverted: false,
        endIndex: null,
        ...overrides,
    };
}

describe('AMD cycles native indicator', () => {
    const cycles = detectAmdCycles(SERIES, OPTS);

    it('boxes every recent range and each manipulation that was not abandoned', () => {
        const out = buildAmdCyclesOutput(cycles, [], TIMES, VIEW);
        const ids = out.boxes!.map((b) => b.id);

        // Three ranges: the second one's manipulation was abandoned, the third is still accumulating.
        expect(cycles.map((c) => c.index)).toEqual([4, 15, 21]);
        expect(ids.filter((id) => id.startsWith('amd_acc_'))).toHaveLength(3);
        expect(ids.filter((id) => id.startsWith('amd_man_'))).toHaveLength(1);

        const manipulation = out.boxes!.find((b) => b.id.startsWith('amd_man_'))!;
        // Five bars past the return candle, like a live manipulation box.
        expect(manipulation).toMatchObject({ left: TIMES[6], right: TIMES[13], top: 100.9, bottom: 100.2 });
        expect(out.labels).toEqual([expect.objectContaining({
            text: 'Manipulation', style: 'label_left', x: TIMES[13], y: (100.9 + 100.2) / 2,
        })]);

        const latestOnly = buildAmdCyclesOutput(cycles, [], TIMES, { ...VIEW, maxCycles: 1 });
        expect(latestOnly.boxes!.filter((b) => b.id.startsWith('amd_acc_'))).toEqual([
            expect.objectContaining({ left: TIMES[17] }),
        ]);
    });

    it('draws live gaps to five bars past the newest bar, inverted ones only when asked', () => {
        const gaps = [
            gap({}),
            gap({ index: 5, time: TIMES[5]!, brokenIndex: 7, inverted: true }),
            gap({ index: 6, time: TIMES[6]!, brokenIndex: 7, endIndex: 7 }),
        ];
        const lastPlusFive = TIMES[TIMES.length - 1]! + 5 * MINUTE;

        const plain = buildAmdCyclesOutput([], gaps, TIMES, VIEW).boxes!;
        expect(plain).toEqual([expect.objectContaining({ text: 'FVG', right: lastPlusFive, top: 101, bottom: 100 })]);

        const inverted = buildAmdCyclesOutput([], gaps, TIMES, { ...VIEW, showIfvg: true }).boxes!;
        expect(inverted.map((b) => b.text)).toEqual(['FVG', 'IFVG']);
        // A broken bullish gap resists from above and takes the bearish inverted colour.
        expect(inverted[1]!.bgColor).toBe('rgba(255,68,85,0.2)');
    });

    it('alerts on a phase change once its bar has closed, never for history', () => {
        const alerts: EngineAlert[] = [];
        const context = (bars: () => readonly OHLCV[]): NativeIndicatorContext => ({
            symbol: 'NQ',
            timeframe: '1',
            live: true,
            bars,
            data: {} as DataControl,
            emit: () => undefined,
            emitAlert: (alert) => alerts.push(alert),
            pushData: () => undefined,
            setStatus: () => undefined,
        });
        const inputs = { accLength: 5, accRangePct: 0.5, breakout: 'Wicks', maxManipulationBars: 3 };

        const loaded = amdCyclesDescriptor.create();
        loaded.start(context(() => SERIES), inputs);
        loaded.onBars();
        expect(alerts).toEqual([]);

        let visible = SERIES.slice(0, 7); // the breakout bar is still forming
        const live = amdCyclesDescriptor.create();
        live.start(context(() => visible), inputs);
        live.onBars();
        expect(alerts).toEqual([]);

        visible = SERIES.slice(0, 8);
        live.onBars();
        live.onBars();
        expect(alerts).toEqual([expect.objectContaining({
            title: 'Manipulation above', message: 'Price broke above the accumulation range.', time: TIMES[6], barIndex: 6,
        })]);
    });

    it('is a price overlay with the settings of the study', () => {
        expect(amdCyclesDescriptor).toMatchObject({ type: 'amd-cycles', paneHint: 'price', overlay: true });
        expect(amdCyclesDescriptor.inputsSchema().map((input) => input.key)).toEqual(expect.arrayContaining([
            'accLength', 'accRangePct', 'breakout', 'maxManipulationBars', 'maxCycles',
            'showFvg', 'showIfvg', 'fvgMinAtr', 'maxGaps', 'skipOverlapping',
            'alertAccumulation', 'alertManipulation',
        ]));
    });
});
