import { describe, expect, it } from 'vitest';
import { buildStrategy, resolveStrategyParams, strategyCatalog } from '../app/renderer/strategies';
import { runBacktest } from '../shared/engine/backtest';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

/** Wide bars first, so no range qualifies until the story starts. */
const WARMUP: Row[] = Array.from({ length: 14 }, (): Row => [100, 101.5, 98.5, 100]);
const FLAT: Row = [100, 100.2, 99.9, 100.1];

/** Range 99.9–100.2, breakout above at +6 (extreme 100.9), return at +8 closing 100.1. */
const CYCLE: Row[] = [
    ...Array.from({ length: 6 }, () => FLAT),
    [100.1, 100.8, 100, 100.6],
    [100.6, 100.9, 100.4, 100.5],
    [100.5, 100.6, 100, 100.1],
];

function series(after: readonly Row[]): OHLCV[] {
    return [...WARMUP, ...CYCLE, ...after].map(([open, high, low, close], index) => ({
        time: Date.parse('2024-01-02T14:00:00Z') + index * MINUTE,
        open,
        high,
        low,
        close,
        volume: 1,
    }));
}

const RETURN = WARMUP.length + 8;
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };
const PARAMS = {
    accLength: 5,
    accRangePct: 0.5,
    breakout: 'wicks',
    maxManipulationBars: 3,
    fvgMinAtr: 0,
    rrr: 1,
    capLeverage: false,
};

const DOWN: Row[] = [
    [100.1, 100.15, 99.5, 99.6],
    [99.6, 99.7, 99, 99.1],
    ...Array.from({ length: 8 }, (): Row => [99.1, 99.3, 98.9, 99.1]),
];

function run(bars: OHLCV[], params: Record<string, unknown>) {
    return runBacktest({ bars, strategy: buildStrategy('amdcycles', { ...PARAMS, ...params }, bars), broker: FREE });
}

describe('AMD cycles strategy', () => {
    it('sells the return at the next open, stop at the manipulation extreme', () => {
        const bars = series(DOWN);
        const result = run(bars, {});

        const entry = result.orders.find((order) => order.tag?.startsWith('amd-cycle:'))!;
        expect(entry).toMatchObject({ side: 'sell', type: 'market', status: 'filled', fillPrice: 100.1 });
        expect(entry.placedAt).toBe(bars[RETURN]!.time);

        const trade = result.trades[0] as { side: string; entryPrice: number; exitPrice: number };
        // Risk 0.8 from the return close 100.1 to 100.9, so 1R sits at 99.3.
        expect(trade).toMatchObject({ side: 'short', entryPrice: 100.1 });
        expect(trade.exitPrice).toBeCloseTo(99.3, 10);
    });

    it('targets the opposite range edge when asked', () => {
        const trade = run(series(DOWN), { targetMode: 'range' }).trades[0] as { exitPrice: number };
        expect(trade.exitPrice).toBe(99.9);
    });

    it('rests a limit at the first gap after the return and trades it on the retest', () => {
        // The return leaves a bearish gap at +9 between 100.4 (low at +7) and 100.15.
        const bars = series([
            [100.1, 100.15, 99.5, 99.6],
            [99.6, 99.7, 99, 99.1],
            [99.6, 100.2, 99.5, 99.9], // retest fills the limit
            [99.9, 100, 99.2, 99.3], // 1R from 100.15 with the stop at 100.9 is 99.4
            ...Array.from({ length: 6 }, (): Row => [99.3, 99.4, 99.2, 99.3]),
        ]);
        const result = run(bars, { entryMode: 'fvg' });

        const entry = result.orders.find((order) => order.tag?.startsWith('amd-cycle:'))!;
        expect(entry).toMatchObject({ side: 'sell', type: 'limit', limitPrice: 100.15, status: 'filled' });
        expect(entry.placedAt).toBe(bars[RETURN + 1]!.time);
        const trade = result.trades[0] as { entryPrice: number; exitPrice: number };
        expect(trade.entryPrice).toBe(100.15);
        expect(trade.exitPrice).toBeCloseTo(99.4, 10);
    });

    it('cancels an unfilled retest when its resting window is spent', () => {
        const result = run(series(DOWN), { entryMode: 'fvg', orderExpiryBars: 3 });
        const entry = result.orders.find((order) => order.tag?.startsWith('amd-cycle:'))!;
        expect(entry.status).toBe('cancelled');
        expect(result.trades).toHaveLength(0);
    });

    it('skips a gap that completes after price already reached the stop', () => {
        const after = (firstHigh: number): Row[] => [
            [100.1, firstHigh, 100.6, 100.7],
            [100.7, 100.8, 100, 100.1],
            [100.1, 100.3, 99.5, 99.6], // bearish gap between 100.3 and 100.6
            ...Array.from({ length: 6 }, (): Row => [99.6, 99.7, 99.5, 99.6]),
        ];
        const tagged = (high: number) => run(series(after(high)), { entryMode: 'fvg' }).orders
            .filter((order) => order.tag?.startsWith('amd-cycle:'));

        expect(tagged(100.85)).toHaveLength(1);
        expect(tagged(101)).toHaveLength(0);
    });

    it('publishes the same detector as a chart indicator and validates its choices', () => {
        const entry = strategyCatalog().find((strategy) => strategy.id === 'amdcycles')!;
        expect(entry).toMatchObject({ indicator: 'amd-cycles', indicatorName: 'AMD Cycles' });

        expect(resolveStrategyParams('amdcycles', {})).toMatchObject({
            entryMode: 'distribution', targetMode: 'fixed', breakout: 'both', accLength: 50, rrr: 2,
        });
        expect(() => resolveStrategyParams('amdcycles', { entryMode: 'breakout' })).toThrow(/not one of/);
    });
});
