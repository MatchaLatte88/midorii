import { describe, expect, it } from 'vitest';
import type { DataControl } from '../src/core/DataControl';
import { detectAmdFvg, selectAmdFvgSignals } from '../src/core/analysis/amdFvg';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { NativeIndicatorContext } from '../src/core/native-indicators';
import { amdFvgDescriptor, buildAmdFvgOutput } from '../src/core/native-indicators/amd-fvg';
import type { EngineAlert } from '../src/core/ports/ScriptingEngine';

const MINUTE = 60_000;
type Row = [number, number, number, number];

const ROWS: Row[] = [
    ...Array.from({ length: 10 }, (): Row => [100, 100.2, 99.9, 100.1]),
    [100.1, 100.8, 100, 100.6],
    [100.6, 100.9, 100.4, 100.5],
    [100.5, 100.5, 99.7, 99.8],
    [99.8, 99.9, 99.2, 99.3],
    [99.3, 99.4, 98.9, 99],
    [99, 99.1, 98, 98.2], // reaches the 1R target
    ...Array.from({ length: 4 }, (): Row => [98.2, 98.4, 98, 98.2]),
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

const VIEW = {
    accColor: '#888888',
    bearColor: '#ee3344',
    bullColor: '#00aa88',
    profitColor: '#00cc88',
    lossColor: '#ff4455',
    fvgColor: '#ffffff',
    sessionColor: '#2962ff',
    labelOffset: 1,
};

describe('AMD FVG native indicator', () => {
    const candidates = detectAmdFvg(SERIES, { accLength: 5, accWidthPct: 0.5, maxSearch: 5, fvgAtr: 0.1, atrLength: 3 });
    const signals = selectAmdFvgSignals(candidates, SERIES, 1, 1);

    it('draws one pattern and trade per accumulation, as the gating selected', () => {
        expect(candidates).toHaveLength(2);
        expect(signals).toHaveLength(1);
        expect(signals[0]).toMatchObject({ index: 13, outcome: 'target', exitIndex: 15 });

        const out = buildAmdFvgOutput(signals, TIMES, null, VIEW);
        const box = (suffix: string) => out.boxes!.find((b) => b.id.endsWith(suffix))!;

        expect(box('_acc')).toMatchObject({ left: TIMES[5], right: TIMES[9], top: 100.2, bottom: 99.9 });
        expect(box('_manipulation')).toMatchObject({ left: TIMES[9], right: TIMES[11], top: 100.9, bottom: 100.2 });
        expect(box('_fvg')).toMatchObject({ left: TIMES[11], right: TIMES[13], top: 100.4, bottom: 99.9, borderStyle: 'dotted' });

        const signal = signals[0]!;
        // The trade boxes end on the exit bar and are measured from the signal close.
        expect(box('_target')).toMatchObject({ left: TIMES[13], right: TIMES[15], top: 99.3, bottom: signal.target });
        expect(box('_stop')).toMatchObject({ left: TIMES[13], right: TIMES[15], top: signal.stop, bottom: 99.3 });
        expect(signal.stop - 99.3).toBeCloseTo(signal.atr, 10);

        expect(out.labels).toHaveLength(1);
        expect(out.labels![0]).toMatchObject({ text: 'AMD Bearish', style: 'label_down', x: TIMES[13] });
        expect(out.labels![0]!.y).toBeCloseTo(99.9 + signal.atr, 10);
        expect(out.backgrounds).toEqual([]);
    });

    it('washes each run of session bars across whole candle slots', () => {
        const out = buildAmdFvgOutput([], [0, 10, 20, 30, 40], [false, true, true, false, true], VIEW);
        expect(out.backgrounds!.map((bg) => [bg.from, bg.to])).toEqual([[5, 25], [35, 45]]);
    });

    it('alerts once for a signal that forms after loading, never for history', () => {
        const inputs = { accLength: 5, accWidthPct: 0.5, maxSearch: 5, fvgAtr: 0.1, atrLength: 3, atrMult: 1, rrr: 1 };
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

        const loaded = amdFvgDescriptor.create();
        loaded.start(context(() => SERIES), inputs);
        loaded.onBars();
        expect(alerts).toEqual([]);

        let visible = SERIES.slice(0, 13);
        const live = amdFvgDescriptor.create();
        live.start(context(() => visible), inputs);
        visible = SERIES.slice(0, 14);
        live.onBars();
        live.onBars();
        expect(alerts).toEqual([expect.objectContaining({ title: 'Bearish AMD Signal', message: expect.stringMatching(/bearish gap/), time: TIMES[13], barIndex: 13 })]);
    });

    it('is a price overlay with the source settings', () => {
        expect(amdFvgDescriptor).toMatchObject({ type: 'amd-fvg', paneHint: 'price', overlay: true });
        expect(amdFvgDescriptor.inputsSchema().map((input) => input.key)).toEqual(expect.arrayContaining([
            'accLength', 'accWidthPct', 'maxSearch', 'fvgAtr', 'atrLength', 'atrMult', 'rrr',
            'useSydney', 'useTokyo', 'useLondon', 'useNewYork', 'showSessions',
        ]));
    });
});
