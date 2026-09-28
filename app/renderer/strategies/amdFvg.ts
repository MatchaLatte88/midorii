import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    AMD_FVG_DEFAULTS,
    detectAmdFvg,
    type AmdFvgCandidate,
    type AmdSession,
} from '../../../src/core/analysis/amdFvg';
import { AMD_FVG_INDICATOR_TYPE } from '../../../src/core/native-indicators/amd-fvg';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * The AMD FVG setup as an executable strategy.
 *
 * The chart study blocks new signals while its own simulated trade runs. Here the real
 * position takes that role: a candidate arriving while a position or order is active is
 * skipped without spending its accumulation, so a later candidate of the same episode can
 * still trade — the same rule the study applies to its simulated trade.
 *
 * The reference acts on the close of the gap candle. Midorii fills that order at the next
 * open, so stop and target are distances from the fill rather than prices from the close.
 */

const MODEL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'sessions',
        label: 'Sessions',
        type: 'multi',
        default: [...AMD_FVG_DEFAULTS.sessions],
        options: [
            { value: 'sydney', label: 'Sydney 17:00–02:00' },
            { value: 'tokyo', label: 'Tokyo 19:00–04:00' },
            { value: 'london', label: 'London 03:00–12:00' },
            { value: 'newyork', label: 'New York 08:00–17:00' },
        ],
        hint: 'Hours on the New York clock, following its daylight-saving changes. Only bars '
            + 'opening inside an enabled session can accumulate, sweep or trigger.',
    },
    {
        key: 'accLength',
        label: 'Accumulation length',
        type: 'number',
        default: AMD_FVG_DEFAULTS.accLength,
        min: 5,
        max: 500,
        step: 1,
        hint: 'Bars in the rolling window whose high-low range must stay narrow.',
    },
    {
        key: 'accWidthPct',
        label: 'Accumulation range max (%)',
        type: 'number',
        default: AMD_FVG_DEFAULTS.accWidthPct,
        min: 0.01,
        max: 20,
        step: 0.01,
        hint: 'The widest the accumulation range may be, as a percentage of its low.',
    },
    {
        key: 'maxSearch',
        label: 'Search window',
        type: 'number',
        default: AMD_FVG_DEFAULTS.maxSearch,
        min: 1,
        max: 200,
        step: 1,
        hint: 'Bars after the last accumulation bar in which the sweep and the gap must both occur.',
    },
    {
        key: 'fvgAtr',
        label: 'Min FVG gap (ATR)',
        type: 'number',
        default: AMD_FVG_DEFAULTS.fvgAtr,
        min: 0,
        max: 10,
        step: 0.05,
        hint: 'The gap must be larger than this multiple of ATR. 0 accepts any gap.',
    },
    {
        key: 'atrLength',
        label: 'ATR length',
        type: 'number',
        default: AMD_FVG_DEFAULTS.atrLength,
        min: 1,
        max: 200,
        step: 1,
        hint: 'Wilder ATR on the execution timeframe, used for the gap filter and the stop.',
    },
    {
        key: 'atrMult',
        label: 'ATR stop multiplier',
        type: 'number',
        default: AMD_FVG_DEFAULTS.atrMult,
        min: 0.1,
        max: 20,
        step: 0.1,
        hint: 'The stop distance as a multiple of the ATR on the signal candle.',
    },
];

const DETECTION_KEYS = [
    'sessions', 'accLength', 'accWidthPct', 'maxSearch', 'fvgAtr', 'atrLength',
] as const;

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`amdfvg: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`amdfvg: ${key} must be a string`);
    return value;
}

export const AMD_FVG_STRATEGY: StrategySpec = {
    id: 'amdfvg',
    name: 'AMD FVG Setup',
    description: 'A tight accumulation range, a sweep of one edge and an ATR-sized fair value '
        + 'gap back into the range, traded at the next open with an ATR stop.',
    indicator: AMD_FVG_INDICATOR_TYPE,
    indicatorName: 'AMD FVG Setup',
    rules: {
        conditions: [
            'The rolling range over the accumulation length is no wider than the chosen '
                + 'percentage of its low, on a bar inside an enabled session.',
            'Within the search window after the last accumulation bar, price trades beyond one '
                + 'edge of that range. The first edge broken decides the direction.',
            'A three-candle fair value gap against the break, larger than the chosen ATR '
                + 'multiple, completes on a candle that closes back inside the range.',
            'Nothing is open. A setup completing while a position or order is active is skipped, '
                + 'but a later qualifying candle of the same accumulation may still trade inside '
                + 'the window. Each accumulation trades at most once.',
        ],
        entry: 'A market order on the close of the candle that completes the gap, filling at the '
            + 'next bar open because Midorii never fills an order on the bar that created it.',
        stop: 'The chosen multiple of ATR on the signal candle, measured from the price the order '
            + 'actually filled at, so a jump to the next open does not change the sized risk.',
        target: 'The stop distance multiplied by the reward-to-risk, measured from the same fill.',
        size: 'Derived from the chosen cash or equity risk divided by the ATR stop distance, capped '
            + 'by the leverage ceiling.',
    },
    params: [...RISK_PARAMS, ...MODEL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const sessions = params.sessions;
        if (!Array.isArray(sessions)) throw new Error('amdfvg: sessions must be a list');

        const rrr = numberOf(params, 'rrr');
        const atrMult = numberOf(params, 'atrMult');
        const maxSearch = numberOf(params, 'maxSearch');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const cap = leverageCap(params);
        const candidates = cached(cache, detectionCacheKey('amdfvg', params, DETECTION_KEYS), () => (
            detectAmdFvg(bars, {
                accLength: numberOf(params, 'accLength'),
                accWidthPct: numberOf(params, 'accWidthPct'),
                maxSearch,
                fvgAtr: numberOf(params, 'fvgAtr'),
                atrLength: numberOf(params, 'atrLength'),
                sessions: sessions as readonly AmdSession[],
            })
        ));

        return {
            params,
            events: { candidates },

            onBar(ctx) {
                /* Past its search window an accumulation has no candidates left, so the key is
                 * dropped — a bot only trims its history once this store is empty again. */
                const spent = ctx.state.spentEpisode as number | undefined;
                if (spent !== undefined && ctx.index > spent + maxSearch) ctx.state.spentEpisode = undefined;

                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;
                const next = ctx.events<AmdFvgCandidate>('candidates').find((c) => c.accEndIndex !== spent);
                if (!next) return;

                const stopDistance = next.atr * atrMult;
                if (!(stopDistance > 0)) return;
                const long = next.direction === 'bull';
                const size = positionSize(
                    ctx.equity,
                    next.close,
                    long ? next.close - stopDistance : next.close + stopDistance,
                    riskMode,
                    riskValue,
                    cap,
                );
                if (size == null) return;

                ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'market',
                    size,
                    bracket: { stopDistance, targetDistance: stopDistance * rrr },
                    tag: `amd:${next.accEndTime}`,
                });
                ctx.state.spentEpisode = next.accEndIndex;
            },
        };
    },
};
