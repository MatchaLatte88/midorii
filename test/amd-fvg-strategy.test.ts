import { describe, expect, it } from 'vitest';
import { buildStrategy, resolveStrategyParams, strategyCatalog } from '../app/renderer/strategies';
import type { StrategyParams } from '../app/renderer/strategies';
import { detectAmdFvg, type AmdFvgCandidate } from '../src/core/analysis/amdFvg';
import { runBacktest, type BacktestContext } from '../shared/engine/backtest';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
type Row = [number, number, number, number];

const ROWS: Row[] = [
    ...Array.from({ length: 10 }, (): Row => [100, 100.2, 99.9, 100.1]),
    [100.1, 100.8, 100, 100.6],
    [100.6, 100.9, 100.4, 100.5],
    [100.5, 100.5, 99.7, 99.8],
    [99.8, 99.9, 99.2, 99.3], // signal close
    [99.3, 99.4, 98.9, 99], // fill at this open; a second candidate of the same accumulation
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

const DETECTION = { accLength: 5, accWidthPct: 0.5, maxSearch: 5, fvgAtr: 0.1, atrLength: 3 };
const PARAMS = { ...DETECTION, atrMult: 1, rrr: 1, capLeverage: false };
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

describe('AMD FVG strategy', () => {
    it('enters at the next open and measures stop and target from that fill', () => {
        const result = runBacktest({ bars: SERIES, strategy: buildStrategy('amdfvg', PARAMS, SERIES), broker: FREE });
        const signalAtr = detectAmdFvg(SERIES, DETECTION)[0]!.atr;

        const entries = result.orders.filter((order) => order.tag?.startsWith('amd:'));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            side: 'sell',
            type: 'market',
            status: 'filled',
            fillPrice: 99.3,
            tag: `amd:${SERIES[9]!.time}`,
        });

        expect(result.trades).toHaveLength(1);
        const trade = result.trades[0] as { side: string; entryPrice: number; exitPrice: number };
        expect(trade.side).toBe('short');
        expect(trade.entryPrice).toBe(99.3);
        expect(trade.exitPrice).toBeCloseTo(99.3 - signalAtr, 10);
    });

    it('skips a setup while a position is on, then trades a later candle of it once', () => {
        const strategy = buildStrategy('amdfvg', PARAMS, SERIES);
        const base = detectAmdFvg(SERIES, DETECTION)[0]!;
        const episode = (index: number): AmdFvgCandidate => ({ ...base, accEndIndex: 42, index });
        const state: Record<string, unknown> = {};
        const placed: unknown[] = [];
        const bar = (isFlat: boolean, arriving: AmdFvgCandidate[], index = arriving[0]?.index ?? 0) => strategy.onBar({
            index,
            isFlat,
            pendingOrders: [],
            state,
            equity: 10_000,
            events: () => arriving,
            order: (spec: unknown) => {
                placed.push(spec);
                return { id: placed.length };
            },
        } as unknown as BacktestContext<StrategyParams>);

        bar(false, [episode(20)]);
        expect(placed).toHaveLength(0);

        bar(true, [episode(21)]);
        expect(placed).toEqual([{
            side: 'sell',
            type: 'market',
            size: expect.any(Number),
            bracket: { stopDistance: base.atr, targetDistance: base.atr },
            tag: `amd:${base.accEndTime}`,
        }]);

        bar(true, [episode(22)]);
        expect(placed).toHaveLength(1);

        // A bot trims its history only once the strategy's store holds nothing again.
        bar(false, [], 42 + PARAMS.maxSearch);
        expect(state.spentEpisode).toBe(42);
        bar(false, [], 43 + PARAMS.maxSearch);
        expect(Object.values(state).every((value) => value == null)).toBe(true);
    });

    it('publishes the same detector as a chart indicator', () => {
        const entry = strategyCatalog().find((strategy) => strategy.id === 'amdfvg')!;
        expect(entry.indicator).toBe('amd-fvg');
        expect(entry.indicatorName).toBe('AMD FVG Setup');
        expect(entry.detectionKeys).not.toContain('atrMult');
    });

    it('defaults to the New York session and validates the session list', () => {
        const resolved = resolveStrategyParams('amdfvg', {});
        expect(resolved).toMatchObject({ sessions: ['newyork'], accLength: 30, atrMult: 2, rrr: 2 });
        expect(() => resolveStrategyParams('amdfvg', { sessions: ['frankfurt'] })).toThrow(/not one of/);
    });
});
