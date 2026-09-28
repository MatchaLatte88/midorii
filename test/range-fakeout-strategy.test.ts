import { describe, expect, it } from 'vitest';
import { buildStrategy, resolveStrategyParams, strategyCatalog } from '../app/renderer/strategies';
import { runBacktest } from '../shared/engine/backtest';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

const ROWS: Row[] = [
    ...Array.from({ length: 16 }, (_, k): Row => [70 + k, 72 + k, 69 + k, 71 + k]),
    ...Array.from({ length: 10 }, (_, k): Row => (k % 2 === 0 ? [99.6, 101, 99.4, 100.6] : [100.4, 100.6, 99, 99.4])),
    [100.6, 101.6, 100.5, 101.4],
    [101.4, 101.6, 101.3, 101.5],
    [101.5, 101.55, 100.3, 100.4],
    [100.4, 101.2, 99.8, 99.95], // confirmation: close under the middle after a gap back
    [99.95, 100.1, 99.5, 99.6], // entry at this open
    [99.6, 99.7, 98.9, 99.1], // range low reached
    ...Array.from({ length: 5 }, (): Row => [99.1, 99.3, 98.9, 99.1]),
];
const SERIES: OHLCV[] = ROWS.map(([open, high, low, close], index) => ({
    time: Date.parse('2024-01-02T14:00:00Z') + index * MINUTE, open, high, low, close, volume: 1,
}));
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

function run(params: Record<string, unknown>) {
    const strategy = buildStrategy('rangefakeout', { minBars: 5, capLeverage: false, ...params }, SERIES);
    return runBacktest({ bars: SERIES, strategy, broker: FREE });
}

describe('range fakeout strategy', () => {
    it('sells the next open and targets the range low, stop beyond the fakeout', () => {
        const result = run({ targetMode: 'range' });
        const entry = result.orders.find((order) => order.tag?.startsWith('fakeout:'))!;
        expect(entry).toMatchObject({ side: 'sell', type: 'market', status: 'filled', fillPrice: 99.95 });
        expect(entry.placedAt).toBe(SERIES[29]!.time);
        expect(result.trades).toHaveLength(1);
        expect(result.trades[0]).toMatchObject({ side: 'short', entryPrice: 99.95, exitPrice: 99 });
    });

    it('skips a setup whose range edge offers too little, and can use a fixed target instead', () => {
        expect(run({ targetMode: 'range', minEdgeReward: 0.6 }).orders).toHaveLength(0);
        const fixed = run({ minEdgeReward: 0.6, targetMode: 'fixed', rrr: 0.5 });
        expect((fixed.trades[0] as { exitPrice: number }).exitPrice).toBeCloseTo(99.95 - 0.5 * 1.65, 10);
    });

    it('defaults to the tested configuration: 15m, 1.5R, gap back into the range, no leverage cap', () => {
        expect(resolveStrategyParams('rangefakeout', {})).toMatchObject({
            riskMode: 'percent', riskValue: 1, capLeverage: false, rrr: 1.5,
            minBars: 12, compression: 0.8, minTouches: 2, maxFakeoutBars: 10,
            gapSide: 'reversal', minGapAtr: 0, targetMode: 'fixed',
        });
        const defaults = run({ minBars: 5 });
        // 1.5R from the confirmation close 99.95 with the stop at 101.6.
        expect(defaults.openPosition).toMatchObject({ stopLoss: 101.6 });
        expect(defaults.openPosition!.takeProfit).toBeCloseTo(99.95 - 1.5 * 1.65, 10);
        expect(() => resolveStrategyParams('rangefakeout', { gapSide: 'inside' })).toThrow(/not one of/);
        const entry = strategyCatalog().find((strategy) => strategy.id === 'rangefakeout')!;
        expect(entry).toMatchObject({ indicator: 'range-fakeout', indicatorName: 'Range Fakeout', timeframe: '15' });
    });
});
