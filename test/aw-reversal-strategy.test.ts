import { describe, expect, it } from 'vitest';
import { detectAwReversals } from '../src/core/analysis/awReversal';
import { buildStrategy } from '../app/renderer/strategies';
import { runBacktest } from '../shared/engine/backtest';
import { NO_COSTS, resetOrderIds } from '../shared/engine/broker';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
const START = Date.parse('2024-01-02T13:00:00Z'); // 08:00 New York in winter.

function bar(index: number, values: readonly [number, number, number, number]): OHLCV {
    const [open, high, low, close] = values;
    return { time: START + index * 5 * MINUTE, open, high, low, close, volume: 100 };
}

/**
 * Swing high 110 confirms at 4; swing low 95 confirms at 7; bar 8 sweeps the low.
 * Bar 10 closes through 110 with displacement and leaves a bullish 104–105 gap.
 * The reference trigger fires immediately; the executable retest reaches 105 on bar 12.
 */
const VALUES: Array<readonly [number, number, number, number]> = [
    [100, 101, 99, 100],
    [100, 104, 100, 103],
    [103, 110, 102, 105],
    [105, 106, 100, 102],
    [102, 105, 99, 100],
    [100, 103, 95, 98],
    [98, 102, 96, 100],
    [100, 104, 97, 103],
    [97, 104, 94, 96],
    [96, 104, 96, 102],
    [105, 113, 105, 112],
    [112, 114, 106, 113],
    [113, 115, 104, 110],
    [110, 117, 109, 116],
];

const BARS: OHLCV[] = VALUES.map((values, index) => bar(index, values));

const DETECTOR_OPTIONS = {
    swingLength: 2,
    maxLiquidity: 15,
    useHtfLiquidity: false,
    usePreviousDay: false,
    atrLength: 1,
    displacementAtr: 0.1,
    maxSweepToShift: 6,
    fvgSearchWindow: 0,
    maxShiftToEntry: 3,
    sessions: ['nyam'] as const,
};

const STRATEGY_PARAMS = {
    riskMode: 'fixed',
    riskValue: 110,
    capLeverage: false,
    rrr: 1,
    breakEvenAtR: 0,
    trailAtR: 0,
    trailR: 1,
    targetMode: 'fixed',
    sessions: ['nyam'],
    swingLength: 2,
    maxLiquidity: 15,
    useHtfLiquidity: false,
    htfMode: 'auto',
    htfMinutes: '60',
    htfPivotStrength: 2,
    usePreviousDay: false,
    atrLength: 1,
    displacementAtr: 0.1,
    maxSweepToShift: 6,
    fvgSearchWindow: 0,
    maxShiftToEntry: 3,
};

function run(entryMode: 'retest' | 'reference') {
    resetOrderIds();
    return runBacktest({
        bars: BARS,
        strategy: buildStrategy('awreversal', { ...STRATEGY_PARAMS, entryMode }, BARS),
        broker: { balance: 10_000, costs: NO_COSTS },
    });
}

describe('AW liquidity-reversal detector', () => {
    it('reports the formation and the reference same-candle trigger as separate timelines', () => {
        const found = detectAwReversals(BARS, DETECTOR_OPTIONS);

        expect(found.formations).toHaveLength(1);
        expect(found.formations[0]).toMatchObject({
            direction: 'bull',
            sweepIndex: 8,
            neckline: 110,
            shiftIndex: 10,
            formationIndex: 10,
            index: 10,
            fvgBottom: 104,
            fvgTop: 105,
            entryPrice: 105,
            stop: 94,
            expiryIndex: 13,
        });
        expect(found.referenceEntries).toHaveLength(1);
        expect(found.referenceEntries[0]).toMatchObject({ formationIndex: 10, index: 10 });
    });

    it('mirrors the same sequence for a bearish reversal', () => {
        const mirrored = BARS.map((item) => ({
            ...item,
            open: 200 - item.open,
            high: 200 - item.low,
            low: 200 - item.high,
            close: 200 - item.close,
        }));
        const [setup] = detectAwReversals(mirrored, DETECTOR_OPTIONS).formations;
        expect(setup).toMatchObject({
            direction: 'bear',
            entryPrice: 95,
            stop: 106,
            fvgBottom: 95,
            fvgTop: 96,
        });
    });

    it('keeps structure detection running when every entry session is disabled', () => {
        const found = detectAwReversals(BARS, { ...DETECTOR_OPTIONS, sessions: [] });
        expect(found.formations).toHaveLength(1);
        expect(found.referenceEntries).toHaveLength(0);
    });

    it('uses a completed previous-day high as opposite liquidity', () => {
        const previous = [
            { time: Date.parse('2024-01-01T20:00:00Z'), open: 100, high: 130, low: 90, close: 105 },
            { time: Date.parse('2024-01-01T20:05:00Z'), open: 105, high: 125, low: 91, close: 100 },
        ];
        const bars = [...previous, ...BARS];
        const [setup] = detectAwReversals(bars, {
            ...DETECTOR_OPTIONS,
            usePreviousDay: true,
        }).formations;
        expect(setup?.liquidityTarget).toBe(130);
    });

    it('does not reveal a formation before its gap candle closes', () => {
        expect(detectAwReversals(BARS.slice(0, 10), DETECTOR_OPTIONS).formations).toHaveLength(0);
        expect(detectAwReversals(BARS.slice(0, 11), DETECTOR_OPTIONS).formations[0]?.index).toBe(10);
    });
});

describe('AW liquidity-reversal entry variants', () => {
    it('rests the executable variant at the gap and fills only on the later retest', () => {
        const result = run('retest');
        const entry = result.orders.find((order) => order.tag?.startsWith('aw:retest:'));

        expect(entry).toMatchObject({
            type: 'limit',
            limitPrice: 105,
            fillPrice: 105,
            filledAt: BARS[12]!.time,
            size: 10,
        });
        expect(entry?.bracket).toEqual({ stopLoss: 94, takeProfit: 116 });
        expect(result.trades).toHaveLength(1);
    });

    it('places the reference variant on the formation close and fills at the next open', () => {
        const result = run('reference');
        const entry = result.orders.find((order) => order.tag?.startsWith('aw:reference:'));

        expect(entry).toMatchObject({
            type: 'market',
            fillPrice: 112,
            filledAt: BARS[11]!.time,
            size: 10,
        });
        expect(entry?.bracket).toEqual({ stopLoss: 94, takeProfit: 116 });
        expect(result.trades).toHaveLength(1);
    });
});
