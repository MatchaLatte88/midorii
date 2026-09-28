import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    CRT_DEFAULTS,
    detectCrt,
    type CrtSetup,
} from '../../../src/core/analysis/crt';
import type { HuntSource } from '../../../src/core/analysis/stophunt';
import type { SessionPreset } from '../../../src/core/analysis/tradingSessions';
import { CRT_INDICATOR_TYPE } from '../../../src/core/native-indicators/crt';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Candle Range Theory as an executable strategy.
 *
 * The detector owns the market story — reference range, key level, strict sweep, internal
 * structure break and Model 1 candle — and the native indicator paints that same result. This
 * file contributes the account decisions: whether the range offers enough reward, how large the
 * position is, and the resting order with its bracket.
 *
 * The execution timeframe is the timeframe selected by the backtest or bot. `referenceMinutes`
 * is therefore only the higher timeframe; asking for H4 while running 15m is the H4 → 15m pair.
 */

const REFERENCE_OPTIONS = [
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: '1440', label: '1 day' },
] as const;

const ZONE_OPTIONS = [
    { value: 'America/New_York', label: 'New York' },
    { value: 'America/Chicago', label: 'Chicago' },
    { value: 'Europe/London', label: 'London' },
    { value: 'UTC', label: 'UTC' },
] as const;

/** The shared reward field means a floor here: the target remains the opposite range edge. */
const CRT_RISK_PARAMS: readonly StrategyParam[] = RISK_PARAMS.map((param) => (
    param.key === 'rrr'
        ? {
            ...param,
            label: 'Minimum reward : risk',
            hint: 'The target stays at the opposite edge of the reference candle. A setup is '
                + 'skipped when that edge does not offer at least this much reward for the '
                + 'distance from the Model 1 entry to the sweep stop.',
        }
        : param
));

const CRT_PARAMS: readonly StrategyParam[] = [
    {
        key: 'referenceMinutes',
        label: 'Reference timeframe',
        type: 'select',
        default: String(CRT_DEFAULTS.referenceMinutes),
        options: REFERENCE_OPTIONS,
        hint: 'The higher-timeframe candle that supplies C/H and C/L. The current backtest or '
            + 'bot timeframe is the lower execution timeframe and must be smaller than this.',
    },
    {
        key: 'referenceAnchorMin',
        label: 'Reference grid starts',
        type: 'time',
        default: CRT_DEFAULTS.referenceAnchorMin,
        hint: 'The wall-clock start of the higher-timeframe grid. 01:00 makes four-hour '
            + 'candles start at 01:00, 05:00, 09:00 and so on in the selected clock.',
    },
    {
        key: 'zone',
        label: 'Reference clock',
        type: 'select',
        default: CRT_DEFAULTS.zone,
        options: ZONE_OPTIONS,
        hint: 'The clock that aligns the reference candles. Named clocks follow daylight-saving '
            + 'changes; they are not fixed UTC offsets.',
    },
    {
        key: 'keySources',
        label: 'Key levels',
        type: 'multi',
        default: [...CRT_DEFAULTS.keySources],
        options: [
            { value: 'swing', label: 'Swings' },
            { value: 'equal', label: 'Equal highs/lows' },
            { value: 'session', label: 'Session highs/lows' },
        ],
        hint: 'Which already-confirmed liquidity may sit outside the reference range and be '
            + 'swept. The sweep itself is strict: one candle must wick through and close back.',
    },
    {
        key: 'keyStrength',
        label: 'Key swing strength',
        type: 'number',
        default: CRT_DEFAULTS.keyStrength,
        min: 1,
        max: 50,
        step: 1,
        hint: 'Bars required on either side of a swing used as the external key level. Larger '
            + 'finds fewer, more established levels and confirms them later.',
    },
    {
        key: 'equalTolerance',
        label: 'Equal within (%)',
        type: 'number',
        default: CRT_DEFAULTS.equalTolerance,
        min: 0,
        max: 10,
        step: 0.01,
        hint: 'How far two swings may differ and still be one equal-high/low key level. Only '
            + 'used when Equal highs/lows is selected.',
    },
    {
        key: 'sessionPreset',
        label: 'Session levels',
        type: 'select',
        default: CRT_DEFAULTS.sessionPreset,
        options: [
            { value: 'futures', label: 'Futures' },
            { value: 'forex', label: 'Forex' },
        ],
        hint: 'Which desk hours produce completed-session highs and lows. Only used when '
            + 'Session highs/lows is selected.',
    },
    {
        key: 'internalStrength',
        label: 'Internal swing strength',
        type: 'number',
        default: CRT_DEFAULTS.internalStrength,
        min: 1,
        max: 20,
        step: 1,
        hint: 'Bars on either side of the internal swing that displacement must close through. '
            + 'The swing must already be confirmed when the sweep happens.',
    },
    {
        key: 'maxSweepToShift',
        label: 'Sweep → shift',
        type: 'number',
        default: CRT_DEFAULTS.maxSweepToShift,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many execution bars the directional structure break may lag the sweep. A '
            + 'close back beyond the swept key invalidates the sequence sooner.',
    },
    {
        key: 'orderExpiryBars',
        label: 'Order rests for',
        type: 'number',
        default: CRT_DEFAULTS.orderExpiryBars,
        min: 1,
        max: 500,
        step: 1,
        hint: 'How many execution bars the limit waits at the Model 1 candle open after the '
            + 'structure shift. The order is cancelled when that window is spent.',
    },
    {
        key: 'stopBuffer',
        label: 'Stop buffer (points)',
        type: 'number',
        default: CRT_DEFAULTS.stopBuffer,
        min: 0,
        max: 1e6,
        step: 0.01,
        hint: 'Raw price distance beyond the sweep extreme. Set this to the instrument tick '
            + 'when the stop should sit one tick beyond it; 0 uses the exact extreme.',
    },
];

const DETECTION_KEYS = [
    'referenceMinutes', 'referenceAnchorMin', 'zone', 'keySources', 'keyStrength',
    'equalTolerance', 'sessionPreset', 'internalStrength', 'maxSweepToShift',
    'orderExpiryBars', 'stopBuffer',
] as const;

interface Resting {
    orderId: number;
    expiryIndex: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`crt: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`crt: ${key} must be a string`);
    return value;
}

export const CRT_STRATEGY: StrategySpec = {
    id: 'crt',
    name: 'Candle Range Theory',
    description: 'A higher-timeframe candle range, an external-liquidity sweep, Model 1 '
        + 'displacement and a limit retest targeting the opposite range edge.',
    indicator: CRT_INDICATOR_TYPE,
    indicatorName: 'Candle Range Theory',
    rules: {
        conditions: [
            'The latest completed higher-timeframe candle defines C/H and C/L.',
            'A confirmed swing, equal high/low or session level sits outside that range.',
            'One execution candle wicks through that key and closes back inside — the strict '
                + 'Turtle Soup sweep.',
            'Price then closes through the latest confirmed internal swing without first '
                + 'closing back beyond the swept key.',
            'The opposite range edge offers at least the requested minimum reward-to-risk.',
            'Only one setup from a reference candle is used, and a new one is skipped while '
                + 'an order or position is already active.',
        ],
        entry: 'A limit order at the open of Model 1 — the last candle opposing the trade '
            + 'between the sweep and the structure-breaking displacement. It rests only for '
            + 'the configured number of execution bars.',
        stop: 'At the sweep wick extreme plus the configured raw-price buffer. Set that buffer '
            + 'to the instrument tick to place the stop one tick beyond the sweep.',
        target: 'The opposite edge of the completed reference candle: C/L for a short and C/H '
            + 'for a long. The edge is fixed before the sweep and never selected afterwards.',
        size: 'Derived from account equity, the chosen risk per trade and the distance from '
            + 'the Model 1 entry to the sweep stop, capped by the leverage ceiling.',
    },
    params: [...CRT_RISK_PARAMS, ...CRT_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const keySources = params.keySources;
        if (!Array.isArray(keySources)) throw new Error('crt: keySources must be a list');

        const minimumRewardRisk = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const cap = leverageCap(params);

        const all = cached(cache, detectionCacheKey('crt', params, DETECTION_KEYS), () => (
            detectCrt(bars, {
                referenceMinutes: Number(stringOf(params, 'referenceMinutes')),
                referenceAnchorMin: numberOf(params, 'referenceAnchorMin'),
                zone: stringOf(params, 'zone'),
                keySources: keySources as readonly HuntSource[],
                keyStrength: numberOf(params, 'keyStrength'),
                equalTolerance: numberOf(params, 'equalTolerance'),
                sessionPreset: stringOf(params, 'sessionPreset') as SessionPreset,
                internalStrength: numberOf(params, 'internalStrength'),
                maxSweepToShift: numberOf(params, 'maxSweepToShift'),
                orderExpiryBars: numberOf(params, 'orderExpiryBars'),
                stopBuffer: numberOf(params, 'stopBuffer'),
            })
        ));
        const setups = all.filter((setup) => setup.rewardRisk >= minimumRewardRisk);

        return {
            params,
            events: { setups },

            onBar(ctx) {
                const resting = ctx.state.resting as Resting | undefined;
                if (resting) {
                    const live = ctx.pendingOrders.some((order) => order.id === resting.orderId);
                    if (!live) {
                        ctx.state.resting = undefined;
                    } else if (ctx.index >= resting.expiryIndex) {
                        // This bar already had its chance to fill before onBar runs.
                        ctx.cancel(resting.orderId);
                        ctx.state.resting = undefined;
                    }
                }

                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                const arriving = ctx.events<CrtSetup>('setups');
                if (arriving.length === 0) return;
                const setup = arriving[0]!;

                const size = positionSize(
                    ctx.equity,
                    setup.entryPrice,
                    setup.stop,
                    riskMode,
                    riskValue,
                    cap,
                );
                if (size == null) return;

                const order = ctx.order({
                    side: setup.direction === 'bull' ? 'buy' : 'sell',
                    type: 'limit',
                    size,
                    limitPrice: setup.entryPrice,
                    bracket: { stopLoss: setup.stop, takeProfit: setup.target },
                    tag: `crt:${setup.referenceStartTime}`,
                });
                ctx.state.resting = { orderId: order.id, expiryIndex: setup.expiryIndex } satisfies Resting;
            },
        };
    },
};
