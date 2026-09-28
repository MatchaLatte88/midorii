import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    AW_REVERSAL_DEFAULTS,
    detectAwReversals,
    type AwHtfMode,
    type AwReversalSetup,
    type AwSession,
} from '../../../src/core/analysis/awReversal';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

type EntryMode = 'retest' | 'reference';
type TargetMode = 'liquidity' | 'fixed';

/** The public model uses 1R when no opposite liquidity is available. */
const AW_RISK_PARAMS: readonly StrategyParam[] = RISK_PARAMS.map((param) => (
    param.key === 'rrr'
        ? {
            ...param,
            label: 'Fixed / fallback reward : risk',
            default: 1,
            hint: 'The fixed target multiple, and the fallback when Opposite liquidity is '
                + 'selected but no untouched level remains beyond the entry.',
        }
        : param
));

const HTF_OPTIONS = [
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: '360', label: '6 hours' },
    { value: '1440', label: '1 day' },
    { value: '10080', label: '1 week' },
] as const;

const MODEL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'entryMode',
        label: 'Entry variant',
        type: 'select',
        variant: 'badges',
        default: 'retest',
        options: [
            { value: 'retest', label: 'Retest limit' },
            { value: 'reference', label: 'Reference next open' },
        ],
        hint: 'Retest limit rests at the gap edge before price returns. Reference next open '
            + 'keeps the source script\'s same-candle trigger, then fills at the next available '
            + 'open because Midorii never fills an order on the bar that created it.',
    },
    {
        key: 'sessions',
        label: 'Entry sessions',
        type: 'multi',
        default: [...AW_REVERSAL_DEFAULTS.sessions],
        options: [
            { value: 'asia', label: 'Asia 20:00–02:00' },
            { value: 'london', label: 'London 02:00–08:00' },
            { value: 'nyam', label: 'NY AM 08:00–12:00' },
            { value: 'nypm', label: 'NY PM 12:00–16:00' },
        ],
        hint: 'Entry hours on the New York clock. Named time follows the US clock change; '
            + 'all structural detection continues outside the selected sessions.',
    },
    {
        key: 'swingLength',
        label: 'Swing length',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.swingLength,
        min: 2,
        max: 50,
        step: 1,
        hint: 'Bars required on each side of a chart-timeframe pivot. The pivot becomes usable '
            + 'only after the right-hand bars have closed.',
    },
    {
        key: 'maxLiquidity',
        label: 'Liquidity levels per side',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.maxLiquidity,
        min: 5,
        max: 40,
        step: 1,
        hint: 'How many recent highs and lows remain eligible as opposite-side targets.',
    },
    {
        key: 'useHtfLiquidity',
        label: 'Higher-timeframe liquidity',
        type: 'bool',
        default: AW_REVERSAL_DEFAULTS.useHtfLiquidity,
        hint: 'Add confirmed higher-timeframe swing highs and lows to the target pool. They do '
            + 'not change which chart-timeframe swing is swept to start a setup.',
    },
    {
        key: 'htfMode',
        label: 'Higher timeframe',
        type: 'select',
        default: AW_REVERSAL_DEFAULTS.htfMode,
        options: [
            { value: 'auto', label: 'Automatic pairing' },
            { value: 'manual', label: 'Manual' },
        ],
        hint: 'Automatic pairing follows the reference ladder from 1m→15m through 4h→1w. '
            + 'Manual uses the timeframe selected below.',
    },
    {
        key: 'htfMinutes',
        label: 'Manual higher timeframe',
        type: 'select',
        default: String(AW_REVERSAL_DEFAULTS.htfMinutes),
        options: HTF_OPTIONS,
        hint: 'Used only with Manual. It must be above the backtest or bot timeframe.',
    },
    {
        key: 'htfPivotStrength',
        label: 'Higher-timeframe pivot strength',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.htfPivotStrength,
        min: 1,
        max: 10,
        step: 1,
        hint: 'Bars required on each side of a higher-timeframe target pivot.',
    },
    {
        key: 'usePreviousDay',
        label: 'Previous-day high / low',
        type: 'bool',
        default: AW_REVERSAL_DEFAULTS.usePreviousDay,
        hint: 'Add the completed New York calendar day\'s high and low to the target pool.',
    },
    {
        key: 'atrLength',
        label: 'ATR length',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.atrLength,
        min: 1,
        max: 200,
        step: 1,
        hint: 'Wilder ATR on the execution timeframe, used to judge the displacement body.',
    },
    {
        key: 'displacementAtr',
        label: 'Displacement body (ATR)',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.displacementAtr,
        min: 0.1,
        max: 20,
        step: 0.1,
        hint: 'The structure-breaking candle body must be at least this many ATRs.',
    },
    {
        key: 'maxSweepToShift',
        label: 'Sweep → shift',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.maxSweepToShift,
        min: 3,
        max: 500,
        step: 1,
        hint: 'Last bar on which displacement may close through the captured neckline.',
    },
    {
        key: 'fvgSearchWindow',
        label: 'FVG search window',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.fvgSearchWindow,
        min: 0,
        max: 5,
        step: 1,
        hint: 'Extra bars after the shift that may complete the three-candle gap. The two '
            + 'left-hand candles needed to define a gap are accounted for automatically.',
    },
    {
        key: 'maxShiftToEntry',
        label: 'Shift → entry',
        type: 'number',
        default: AW_REVERSAL_DEFAULTS.maxShiftToEntry,
        min: 3,
        max: 500,
        step: 1,
        hint: 'How many bars a formed gap remains eligible for an entry.',
    },
    {
        key: 'targetMode',
        label: 'Target',
        type: 'select',
        default: 'liquidity',
        options: [
            { value: 'liquidity', label: 'Opposite liquidity' },
            { value: 'fixed', label: 'Fixed reward : risk' },
        ],
        hint: 'Opposite liquidity uses the nearest untouched high for a long or low for a '
            + 'short. The shared reward-to-risk setting is used when none exists.',
    },
];

const DETECTION_KEYS = [
    'sessions', 'swingLength', 'maxLiquidity', 'useHtfLiquidity', 'htfMode', 'htfMinutes',
    'htfPivotStrength', 'usePreviousDay', 'atrLength', 'displacementAtr',
    'maxSweepToShift', 'fvgSearchWindow', 'maxShiftToEntry',
] as const;

interface ArmedRetest {
    setup: AwReversalSetup;
    orderId: number | null;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`awreversal: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`awreversal: ${key} must be a string`);
    return value;
}

function boolOf(params: StrategyParams, key: string): boolean {
    const value = params[key];
    if (typeof value !== 'boolean') throw new Error(`awreversal: ${key} must be true or false`);
    return value;
}

export const AW_REVERSAL_STRATEGY: StrategySpec = {
    id: 'awreversal',
    name: 'AW Liquidity Reversal',
    description: 'A swing-liquidity sweep, displacement through the captured neckline and '
        + 'fair value gap, with both a resting-retest and reference next-open entry.',
    rules: {
        conditions: [
            'A confirmed chart-timeframe swing is wicked through and the candle closes back '
                + 'inside it.',
            'A directional body at least the chosen ATR multiple closes through the last '
                + 'opposing swing captured when the sweep occurred.',
            'A matching three-candle fair value gap forms inside the search window.',
            'The entry occurs inside an enabled New York session before the setup expires and '
                + 'before price closes beyond the swept wick.',
            'Only one order or position is active; overlapping setups are skipped.',
        ],
        entry: 'Retest limit rests at the near edge of the formed gap and fills only on a '
            + 'later return. Reference next open triggers on the source model\'s touch — '
            + 'including the formation candle itself — and fills at the following bar open.',
        stop: 'At the wick extreme that swept the initiating swing. A close beyond that level '
            + 'invalidates an unfilled setup.',
        target: 'The nearest untaken opposite-side swing, higher-timeframe swing or previous-day '
            + 'level; when none remains, a fixed multiple of the entry-to-stop risk.',
        size: 'Derived from the chosen cash or equity risk divided by the distance from the gap '
            + 'edge to the sweep stop, capped by the leverage ceiling.',
    },
    params: [...AW_RISK_PARAMS, ...MODEL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const sessions = params.sessions;
        if (!Array.isArray(sessions)) throw new Error('awreversal: sessions must be a list');

        const entryMode = stringOf(params, 'entryMode') as EntryMode;
        const targetMode = stringOf(params, 'targetMode') as TargetMode;
        const rrr = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const cap = leverageCap(params);
        const detection = cached(cache, detectionCacheKey('awreversal', params, DETECTION_KEYS), () => (
            detectAwReversals(bars, {
                swingLength: numberOf(params, 'swingLength'),
                maxLiquidity: numberOf(params, 'maxLiquidity'),
                useHtfLiquidity: boolOf(params, 'useHtfLiquidity'),
                htfMode: stringOf(params, 'htfMode') as AwHtfMode,
                htfMinutes: Number(stringOf(params, 'htfMinutes')),
                htfPivotStrength: numberOf(params, 'htfPivotStrength'),
                usePreviousDay: boolOf(params, 'usePreviousDay'),
                atrLength: numberOf(params, 'atrLength'),
                displacementAtr: numberOf(params, 'displacementAtr'),
                maxSweepToShift: numberOf(params, 'maxSweepToShift'),
                fvgSearchWindow: numberOf(params, 'fvgSearchWindow'),
                maxShiftToEntry: numberOf(params, 'maxShiftToEntry'),
                sessions: sessions as readonly AwSession[],
            })
        ));

        const targetFor = (setup: AwReversalSetup): number => {
            const risk = Math.abs(setup.entryPrice - setup.stop);
            const fixed = setup.direction === 'bull'
                ? setup.entryPrice + risk * rrr
                : setup.entryPrice - risk * rrr;
            if (targetMode !== 'liquidity' || setup.liquidityTarget == null) return fixed;
            const valid = setup.direction === 'bull'
                ? setup.liquidityTarget > setup.entryPrice
                : setup.liquidityTarget < setup.entryPrice;
            return valid ? setup.liquidityTarget : fixed;
        };

        type Context = Parameters<RunnableStrategy<StrategyParams>['onBar']>[0];
        const place = (ctx: Context, setup: AwReversalSetup, type: 'market' | 'limit') => {
            const size = positionSize(ctx.equity, setup.entryPrice, setup.stop, riskMode, riskValue, cap);
            if (size == null) return null;
            return ctx.order({
                side: setup.direction === 'bull' ? 'buy' : 'sell',
                type,
                size,
                ...(type === 'limit' ? { limitPrice: setup.entryPrice } : {}),
                bracket: { stopLoss: setup.stop, takeProfit: targetFor(setup) },
                tag: `aw:${entryMode}:${setup.formationTime}`,
            });
        };

        if (entryMode === 'reference') {
            return {
                params,
                events: { setups: detection.referenceEntries },
                onBar(ctx) {
                    if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;
                    const setup = ctx.events<AwReversalSetup>('setups')[0];
                    if (setup) place(ctx, setup, 'market');
                },
            };
        }

        return {
            params,
            series: { nextSessionAllowed: detection.nextSessionAllowed },
            events: { setups: detection.formations },
            onBar(ctx) {
                let armed = ctx.state.awRetest as ArmedRetest | undefined;
                if (armed) {
                    const live = armed.orderId != null
                        && ctx.pendingOrders.some((order) => order.id === armed!.orderId);
                    if (armed.orderId != null && !live) {
                        // Filled or refused: either way this setup has spent its one attempt.
                        ctx.state.awRetest = undefined;
                        armed = undefined;
                    } else {
                        const invalid = armed.setup.direction === 'bull'
                            ? ctx.bar.close < armed.setup.stop
                            : ctx.bar.close > armed.setup.stop;
                        if (invalid || ctx.index >= armed.setup.expiryIndex) {
                            if (live && armed.orderId != null) ctx.cancel(armed.orderId);
                            ctx.state.awRetest = undefined;
                            return;
                        }

                        const allowed = ctx.value('nextSessionAllowed') === 1;
                        if (live && !allowed && armed.orderId != null) {
                            ctx.cancel(armed.orderId);
                            armed.orderId = null;
                        } else if (!live && allowed && ctx.isFlat && ctx.pendingOrders.length === 0) {
                            const order = place(ctx, armed.setup, 'limit');
                            armed.orderId = order?.id ?? null;
                        }
                        return;
                    }
                }

                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;
                const setup = ctx.events<AwReversalSetup>('setups')[0];
                if (!setup) return;
                armed = { setup, orderId: null };
                ctx.state.awRetest = armed;
                if (ctx.value('nextSessionAllowed') === 1) {
                    const order = place(ctx, setup, 'limit');
                    armed.orderId = order?.id ?? null;
                }
            },
        };
    },
};
