import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    RANGE_FAKEOUT_DEFAULTS,
    detectRangeFakeouts,
    rangeFakeoutTarget,
    type FakeoutGapSide,
    type RangeFakeoutSetup,
} from '../../../src/core/analysis/rangeFakeout';
import { RANGE_FAKEOUT_INDICATOR_TYPE } from '../../../src/core/native-indicators/range-fakeout';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Range fakeouts as an executable strategy: against the breakout, on the next open after the
 * close through the range middle, with the stop beyond the fakeout's extreme.
 */

type TargetMode = 'fixed' | 'range';

/** The shared risk fields, preset to the tested configuration: 1.5R and no leverage ceiling. */
const FAKEOUT_RISK_PARAMS: readonly StrategyParam[] = RISK_PARAMS.map((param): StrategyParam => {
    if (param.key === 'capLeverage') return { ...param, default: false };
    if (param.key !== 'rrr') return param;
    return {
        ...param,
        default: RANGE_FAKEOUT_DEFAULTS.rrr,
        hint: 'The target as a multiple of the distance from entry to stop. With the range '
            + 'target it is used only when the far range edge is no longer ahead of the entry.',
    };
});

const MODEL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'minBars',
        label: 'Range min bars',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.minBars,
        min: 5,
        max: 300,
        step: 1,
        hint: 'Shortest run of bars that may count as a range.',
    },
    {
        key: 'compression',
        label: 'Range compression',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.compression,
        min: 0.1,
        max: 3,
        step: 0.05,
        hint: 'Height limit as a multiple of ATR × √length. Lower finds tighter ranges.',
    },
    {
        key: 'minTouches',
        label: 'Touches per edge',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.minTouches,
        min: 1,
        max: 10,
        step: 1,
        hint: 'Separate visits each edge needs before the range counts.',
    },
    {
        key: 'maxFakeoutBars',
        label: 'Fakeout window',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.maxFakeoutBars,
        min: 1,
        max: 200,
        step: 1,
        hint: 'Bars after the breakout close in which price must close back through the range middle.',
    },
    {
        key: 'gapSide',
        label: 'Gap direction',
        type: 'select',
        default: RANGE_FAKEOUT_DEFAULTS.gapSide,
        options: [
            { value: 'any', label: 'Either' },
            { value: 'breakout', label: 'With the breakout' },
            { value: 'reversal', label: 'Against the breakout' },
        ],
        hint: 'Which fair value gap beyond the broken edge counts: the impulse out of the range, '
            + 'the snap back into it, or either.',
    },
    {
        key: 'minGapAtr',
        label: 'Min gap (ATR)',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.minGapAtr,
        min: 0,
        max: 10,
        step: 0.05,
        hint: 'Smallest gap as a multiple of the 14-bar ATR. 0 accepts any gap.',
    },
    {
        key: 'targetMode',
        label: 'Target',
        type: 'select',
        default: RANGE_FAKEOUT_DEFAULTS.targetMode,
        options: [
            { value: 'fixed', label: 'Fixed reward : risk' },
            { value: 'range', label: 'Far range edge' },
        ],
        hint: 'Far range edge targets the range low for a short and its high for a long.',
    },
    {
        key: 'minEdgeReward',
        label: 'Min reward : risk to the edge',
        type: 'number',
        default: RANGE_FAKEOUT_DEFAULTS.minEdgeReward,
        min: 0,
        max: 10,
        step: 0.1,
        hint: 'Far range edge only. Skips a setup whose far edge offers less than this multiple of '
            + 'the risk; 0 takes every setup.',
    },
];

const DETECTION_KEYS = ['minBars', 'compression', 'minTouches', 'maxFakeoutBars', 'gapSide', 'minGapAtr'] as const;

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`rangefakeout: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`rangefakeout: ${key} must be a string`);
    return value;
}

export const RANGE_FAKEOUT_STRATEGY: StrategySpec = {
    id: 'rangefakeout',
    name: 'Range Fakeout',
    description: 'A range breaks on a close, leaves a fair value gap beyond its edge and is closed '
        + 'back through its middle; traded against the breakout with the stop beyond the fakeout.',
    indicator: RANGE_FAKEOUT_INDICATOR_TYPE,
    indicatorName: 'Range Fakeout',
    timeframe: RANGE_FAKEOUT_DEFAULTS.timeframe,
    rules: {
        conditions: [
            'A compressed range with the required touches on both edges ends with a close beyond one edge.',
            'Between that breakout and the confirmation, a fair value gap of the chosen direction and size '
                + 'completes and reaches beyond the broken edge.',
            'Within the fakeout window, a close lands past the range middle on the far side. Only the first '
                + 'such close counts; without a qualifying gap by then there is no trade.',
            'With the far-edge target, the edge offers at least the minimum reward-to-risk; otherwise the '
                + 'setup is skipped.',
            'Only one order or position is active; a setup arriving during one is skipped.',
        ],
        entry: 'Against the breakout: a market order on the close through the middle, filling at the '
            + 'next open.',
        stop: 'At the furthest price beyond the broken edge from the breakout to the confirmation.',
        target: 'By default the distance from the confirmation close to the stop multiplied by the '
            + 'reward-to-risk. Optionally the far range edge — the low for a short, the high for a long — '
            + 'falling back to that multiple when the edge no longer lies ahead of the entry.',
        size: 'Derived from the chosen cash or equity risk divided by the distance from the '
            + 'confirmation close to the stop, capped by the leverage ceiling.',
    },
    params: [...FAKEOUT_RISK_PARAMS, ...MODEL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const targetMode = stringOf(params, 'targetMode') as TargetMode;
        const rrr = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const cap = leverageCap(params);
        const minEdgeReward = numberOf(params, 'minEdgeReward');

        const detected = cached(cache, detectionCacheKey('rangefakeout', params, DETECTION_KEYS), () => (
            detectRangeFakeouts(bars, {
                range: {
                    minBars: numberOf(params, 'minBars'),
                    compression: numberOf(params, 'compression'),
                    minTouches: numberOf(params, 'minTouches'),
                },
                maxFakeoutBars: numberOf(params, 'maxFakeoutBars'),
                gapSide: stringOf(params, 'gapSide') as FakeoutGapSide,
                minGapAtr: numberOf(params, 'minGapAtr'),
            })
        ));

        return {
            params,
            events: { setups: detected },

            onBar(ctx) {
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;
                const setup = ctx.events<RangeFakeoutSetup>('setups')[0];
                if (!setup) return;
                const target = rangeFakeoutTarget(setup, targetMode, rrr, minEdgeReward);
                if (target === null) return;
                const size = positionSize(ctx.equity, setup.close, setup.extreme, riskMode, riskValue, cap);
                if (size == null) return;
                ctx.order({
                    side: setup.direction === 'bull' ? 'buy' : 'sell',
                    type: 'market',
                    size,
                    bracket: { stopLoss: setup.extreme, takeProfit: target },
                    tag: `fakeout:${setup.breakTime}`,
                });
            },
        };
    },
};
