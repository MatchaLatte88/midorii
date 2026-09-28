import { describe, expect, it } from 'vitest';
import { buildStrategy, resolveStrategyParams, strategyCatalog } from '../app/renderer/strategies';
import { runBacktest } from '../shared/engine/backtest';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;

function fixture(fill = true): OHLCV[] {
    const start = Date.parse('2024-01-02T00:00:00Z');
    const rows: Array<[number, number, number, number]> = Array.from(
        { length: 76 },
        () => [100, 101, 99, 100],
    );

    rows[19] = [100, 103, 99, 102];
    rows[20] = [102, 106, 101, 105]; // key high / reference high
    rows[21] = [105, 105, 100, 101];
    rows[39] = [100, 102, 100, 101];
    rows[40] = [101, 102, 98, 100]; // internal low / reference low
    rows[41] = [100, 102, 99, 101];
    rows[64] = [102, 105, 101, 104];
    rows[65] = [105, 107, 103, 105.5]; // strict sweep / Model 1
    rows[66] = [105.5, 105.7, 97, 97.5]; // shift
    rows[67] = fill ? [99, 105.2, 97, 98.5] : [99, 104, 97, 98.5];
    for (let i = 68; i < rows.length; i += 1) rows[i] = [99, 104, 97, 99];

    return rows.map(([open, high, low, close], index) => ({
        time: start + index * MINUTE,
        open,
        high,
        low,
        close,
        volume: 1,
    }));
}

const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };
const PARAMS = {
    referenceMinutes: '60',
    referenceAnchorMin: 0,
    zone: 'UTC',
    keySources: ['swing'],
    keyStrength: 1,
    internalStrength: 1,
    maxSweepToShift: 4,
    orderExpiryBars: 3,
    stopBuffer: 0,
    rrr: 2,
    capLeverage: false,
};

describe('CRT strategy', () => {
    it('rests at Model 1 and exits at the opposite reference edge', () => {
        const series = fixture();
        const result = runBacktest({
            bars: series,
            strategy: buildStrategy('crt', PARAMS, series),
            broker: FREE,
        });

        const entry = result.orders.find((order) => order.tag?.startsWith('crt:'))!;
        expect(entry).toMatchObject({
            side: 'sell',
            type: 'limit',
            limitPrice: 105,
            fillPrice: 105,
            status: 'filled',
        });

        expect(result.trades).toHaveLength(1);
        const trade = result.trades[0] as { side: string; entryPrice: number; exitPrice: number };
        expect(trade).toMatchObject({ side: 'short', entryPrice: 105, exitPrice: 98 });
    });

    it('cancels an unfilled retest when its bar window is spent', () => {
        const series = fixture(false);
        const result = runBacktest({
            bars: series,
            strategy: buildStrategy('crt', PARAMS, series),
            broker: FREE,
        });

        const entry = result.orders.find((order) => order.tag?.startsWith('crt:'))!;
        expect(entry.status).toBe('cancelled');
        expect(result.trades).toHaveLength(0);
    });

    it('filters a range whose opposite edge does not offer the requested reward', () => {
        const series = fixture();
        const result = runBacktest({
            bars: series,
            strategy: buildStrategy('crt', { ...PARAMS, rrr: 4 }, series),
            broker: FREE,
        });
        expect(result.orders).toHaveLength(0);
    });

    it('publishes the same detector as a chart indicator', () => {
        const entry = strategyCatalog().find((strategy) => strategy.id === 'crt')!;
        expect(entry.indicator).toBe('crt');
        expect(entry.indicatorName).toBe('Candle Range Theory');
        expect(entry.rules!.target).toMatch(/opposite edge/i);
    });

    it('validates the higher-timeframe and key-level settings at the form boundary', () => {
        const resolved = resolveStrategyParams('crt', {});
        expect(resolved.referenceMinutes).toBe('240');
        expect(resolved.referenceAnchorMin).toBe(60);
        expect(resolved.keySources).toEqual(['swing']);

        expect(() => resolveStrategyParams('crt', { referenceMinutes: '10' })).toThrow(/not one of/);
        expect(() => resolveStrategyParams('crt', { keySources: ['gap'] })).toThrow(/not one of/);
    });
});
