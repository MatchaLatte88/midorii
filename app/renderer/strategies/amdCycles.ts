import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    AMD_CYCLE_DEFAULTS,
    detectAmdCycles,
    trackAmdGaps,
    type AmdBreakout,
    type AmdCycle,
    type AmdGap,
} from '../../../src/core/analysis/amdCycles';
import { AMD_CYCLES_INDICATOR_TYPE } from '../../../src/core/native-indicators/amd-cycles';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * AMD cycles as an executable strategy.
 *
 * The chart study describes the phases and stops there. This file decides the trade: against
 * the manipulation, once price has returned inside the broken edge, with the stop beyond the
 * manipulation's extreme. Two entries share those rules — a market order on the return itself,
 * or a limit at the first fair value gap the distribution leaves behind.
 */

type EntryMode = 'distribution' | 'fvg';
type TargetMode = 'fixed' | 'range';

/** With the range target the shared reward field is the fallback, not the target itself. */
const AMD_RISK_PARAMS: readonly StrategyParam[] = RISK_PARAMS.map((param) => (
    param.key === 'rrr'
        ? {
            ...param,
            hint: 'The target as a multiple of the distance from entry to stop. With the range '
                + 'target it is used only when the opposite range edge is no longer ahead of the entry.',
        }
        : param
));

const MODEL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'entryMode',
        label: 'Entry',
        type: 'select',
        variant: 'badges',
        default: 'distribution',
        options: [
            { value: 'distribution', label: 'Distribution start' },
            { value: 'fvg', label: 'FVG retest' },
        ],
        hint: 'Distribution start sends a market order on the close that returns inside the range '
            + 'and fills at the next open. FVG retest waits for the first fair value gap in the trade '
            + 'direction and rests a limit at its near edge.',
    },
    {
        key: 'accLength',
        label: 'Accumulation length',
        type: 'number',
        default: AMD_CYCLE_DEFAULTS.accLength,
        min: 5,
        max: 500,
        step: 1,
        hint: 'Bars in the rolling window that must stay narrow. Also the pause after a distribution '
            + 'before the next accumulation is looked for.',
    },
    {
        key: 'accRangePct',
        label: 'Accumulation max range (%)',
        type: 'number',
        default: AMD_CYCLE_DEFAULTS.accRangePct,
        min: 0.01,
        max: 20,
        step: 0.05,
        hint: 'The widest the rolling range may be, as a percentage of its low.',
    },
    {
        key: 'breakout',
        label: 'Breakout type',
        type: 'select',
        default: AMD_CYCLE_DEFAULTS.breakout,
        options: [
            { value: 'wicks', label: 'Wicks' },
            { value: 'bodies', label: 'Bodies' },
            { value: 'both', label: 'Both' },
        ],
        hint: 'Which part of a candle must pass a range edge to start the manipulation, and pass '
            + 'back to start the distribution. Both counts either, which is the wick.',
    },
    {
        key: 'maxManipulationBars',
        label: 'Max manipulation length',
        type: 'number',
        default: AMD_CYCLE_DEFAULTS.maxManipulationBars,
        min: 1,
        max: 500,
        step: 1,
        hint: 'Bars a manipulation may last without returning inside the broken edge before the '
            + 'cycle is abandoned and nothing is traded.',
    },
    {
        key: 'targetMode',
        label: 'Target',
        type: 'select',
        default: 'fixed',
        options: [
            { value: 'fixed', label: 'Fixed reward : risk' },
            { value: 'range', label: 'Opposite range edge' },
        ],
        hint: 'Opposite range edge targets the accumulation low for a short and its high for a long.',
    },
    {
        key: 'fvgMinAtr',
        label: 'Min gap (ATR)',
        type: 'number',
        default: AMD_CYCLE_DEFAULTS.fvgMinAtr,
        min: 0,
        max: 10,
        step: 0.1,
        hint: 'FVG retest only. The gap must be larger than this multiple of the 14-bar ATR.',
    },
    {
        key: 'skipOverlapping',
        label: 'Filter overlapping gaps',
        type: 'bool',
        default: AMD_CYCLE_DEFAULTS.skipOverlapping,
        hint: 'FVG retest only. A new gap lying inside a live gap of the same direction does not count.',
    },
    {
        key: 'fvgWindow',
        label: 'Gap search window',
        type: 'number',
        default: 10,
        min: 0,
        max: 200,
        step: 1,
        hint: 'FVG retest only. Bars after the distribution start in which the gap must complete; '
            + '0 accepts only a gap completed by the return candle itself.',
    },
    {
        key: 'orderExpiryBars',
        label: 'Order rests for',
        type: 'number',
        default: 10,
        min: 1,
        max: 500,
        step: 1,
        hint: 'FVG retest only. Bars the limit waits at the gap edge before it is cancelled.',
    },
];

const DETECTION_KEYS = [
    'accLength', 'accRangePct', 'breakout', 'maxManipulationBars', 'fvgMinAtr', 'skipOverlapping',
] as const;

/** One tradeable return, known from `index` on. */
interface AmdCycleSetup {
    direction: 'bull' | 'bear';
    cycleTime: number;
    entryPrice: number;
    stop: number;
    target: number;
    /** The last bar a resting limit may fill on; null for a market entry. */
    expiryIndex: number | null;
    index: number;
    time: number;
}

interface Resting {
    orderId: number;
    expiryIndex: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`amdcycles: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`amdcycles: ${key} must be a string`);
    return value;
}

function boolOf(params: StrategyParams, key: string): boolean {
    const value = params[key];
    if (typeof value !== 'boolean') throw new Error(`amdcycles: ${key} must be true or false`);
    return value;
}

export const AMD_CYCLES_STRATEGY: StrategySpec = {
    id: 'amdcycles',
    name: 'AMD Cycles',
    description: 'A narrow accumulation, a breakout on one side and the return inside it, traded '
        + 'against the breakout with the stop beyond its extreme.',
    indicator: AMD_CYCLES_INDICATOR_TYPE,
    indicatorName: 'AMD Cycles',
    rules: {
        conditions: [
            'The rolling range over the accumulation length spans at most the chosen percentage of '
                + 'its low, and begins after the previous accumulation ended.',
            'Price trades beyond one edge of that range — the manipulation — and returns inside the '
                + 'broken edge before the maximum manipulation length has passed.',
            'After a return, the next accumulation is looked for only once the accumulation length '
                + 'has passed again.',
            'FVG retest also needs a fair value gap in the trade direction within the search window, '
                + 'with price not having reached the stop before the gap completed.',
            'Only one order or position is active; a setup arriving during one is skipped.',
        ],
        entry: 'Against the manipulation. Distribution start: a market order on the close that '
            + 'returns inside the range, filling at the next open. FVG retest: a limit at the near '
            + 'edge of the first qualifying gap, cancelled when its resting window is spent.',
        stop: 'At the furthest price the manipulation reached beyond the broken edge, up to the '
            + 'return candle.',
        target: 'The distance from the planned entry to the stop multiplied by the reward-to-risk, '
            + 'or the opposite edge of the accumulation range while it still lies ahead of the entry.',
        size: 'Derived from the chosen cash or equity risk divided by the distance from the planned '
            + 'entry to the stop, capped by the leverage ceiling.',
    },
    params: [...AMD_RISK_PARAMS, ...MODEL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const entryMode = stringOf(params, 'entryMode') as EntryMode;
        const targetMode = stringOf(params, 'targetMode') as TargetMode;
        const rrr = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const cap = leverageCap(params);
        const fvgWindow = numberOf(params, 'fvgWindow');
        const orderExpiryBars = numberOf(params, 'orderExpiryBars');

        /* Gaps are tracked the way the chart study tracks them by default — fifteen live at
         * once, broken gaps not kept as inverted — so the gap a retest uses is one it draws. */
        const detection = cached(cache, detectionCacheKey('amdcycles', params, DETECTION_KEYS), () => ({
            cycles: detectAmdCycles(bars, {
                accLength: numberOf(params, 'accLength'),
                accRangePct: numberOf(params, 'accRangePct'),
                breakout: stringOf(params, 'breakout') as AmdBreakout,
                maxManipulationBars: numberOf(params, 'maxManipulationBars'),
            }),
            gaps: trackAmdGaps(bars, {
                minAtr: numberOf(params, 'fvgMinAtr'),
                skipOverlapping: boolOf(params, 'skipOverlapping'),
                maxLive: AMD_CYCLE_DEFAULTS.maxLiveGaps,
                keepInverted: false,
            }),
        }));

        const targetFor = (cycle: AmdCycle, short: boolean, entry: number, stop: number): number => {
            const risk = Math.abs(entry - stop);
            const fixed = short ? entry - risk * rrr : entry + risk * rrr;
            if (targetMode !== 'range') return fixed;
            const edge = short ? cycle.accBottom : cycle.accTop;
            return (short ? edge < entry : edge > entry) ? edge : fixed;
        };

        const setups: AmdCycleSetup[] = [];
        for (const cycle of detection.cycles) {
            const manipulation = cycle.manipulation;
            const returnIndex = cycle.distributionIndex;
            if (manipulation === null || returnIndex === null) continue;
            const short = manipulation.side === 'above';
            const stop = manipulation.extreme;
            const base = { direction: short ? 'bear' as const : 'bull' as const, cycleTime: cycle.time, stop };

            if (entryMode === 'distribution') {
                const entry = bars[returnIndex]!.close;
                if (short ? !(stop > entry) : !(stop < entry)) continue;
                setups.push({
                    ...base,
                    entryPrice: entry,
                    target: targetFor(cycle, short, entry, stop),
                    expiryIndex: null,
                    index: returnIndex,
                    time: bars[returnIndex]!.time,
                });
                continue;
            }

            const gap = firstGap(detection.gaps, short ? 'bear' : 'bull', returnIndex, returnIndex + fvgWindow);
            if (!gap) continue;
            const entry = short ? gap.bottom : gap.top;
            if (short ? !(stop > entry) : !(stop < entry)) continue;
            if (reachedStop(bars, returnIndex + 1, gap.index, short, stop)) continue;
            setups.push({
                ...base,
                entryPrice: entry,
                target: targetFor(cycle, short, entry, stop),
                expiryIndex: gap.index + orderExpiryBars,
                index: gap.index,
                time: gap.time,
            });
        }

        type Context = Parameters<RunnableStrategy<StrategyParams>['onBar']>[0];
        const place = (ctx: Context, setup: AmdCycleSetup) => {
            const size = positionSize(ctx.equity, setup.entryPrice, setup.stop, riskMode, riskValue, cap);
            if (size == null) return null;
            return ctx.order({
                side: setup.direction === 'bull' ? 'buy' : 'sell',
                size,
                ...(setup.expiryIndex === null
                    ? { type: 'market' as const }
                    : { type: 'limit' as const, limitPrice: setup.entryPrice }),
                bracket: { stopLoss: setup.stop, takeProfit: setup.target },
                tag: `amd-cycle:${setup.cycleTime}`,
            });
        };

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
                const setup = ctx.events<AmdCycleSetup>('setups')[0];
                if (!setup) return;
                const order = place(ctx, setup);
                if (order && setup.expiryIndex !== null) {
                    ctx.state.resting = { orderId: order.id, expiryIndex: setup.expiryIndex } satisfies Resting;
                }
            },
        };
    },
};

/** The first tracked gap of a direction completed within an inclusive bar range. */
function firstGap(gaps: readonly AmdGap[], direction: 'bull' | 'bear', from: number, to: number): AmdGap | null {
    for (const gap of gaps) {
        if (gap.index > to) return null;
        if (gap.index >= from && gap.direction === direction) return gap;
    }
    return null;
}

function reachedStop(bars: readonly OHLCV[], from: number, to: number, short: boolean, stop: number): boolean {
    for (let i = from; i <= to; i += 1) {
        if (short ? bars[i]!.high >= stop : bars[i]!.low <= stop) return true;
    }
    return false;
}
