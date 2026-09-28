import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    SILVER_BULLET_DEFAULTS,
    detectSilverBullet,
    type SilverBulletScope,
    type SilverBulletSetup,
    type SilverBulletWindowId,
} from '../../../src/core/analysis/silverBullet';
import type { FvgSizeUnit } from '../../../src/core/analysis/fvg';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { SILVER_BULLET_INDICATOR_TYPE } from '../../../src/core/native-indicators/silverbullet';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Silver Bullet as a tradable strategy.
 *
 * The detection is not repeated here. `src/core/analysis/silverBullet.ts` stays the single
 * definition of what a setup is and keeps painting on the chart; this file decides what to do
 * about each one, which is the whole difference between an indicator and a strategy.
 *
 * A resting order, not a market order
 * -----------------------------------
 * The detector confirms a setup at the structure shift, before price has come back to the gap.
 * Everything an order needs is known there — the edge it rests at, the stop beyond the sweep's
 * wick, the target — so this places a LIMIT order at that edge and lets the market decide
 * whether it fills. Which is how the setup is actually traded.
 *
 * The alternative is what a detector that only reported filled setups would force: a market
 * order on the bar price touched the edge, filled against the next bar at whatever it opens
 * at. That is worse in two ways, and the second is the one that matters. It pays a worse
 * price, and — because such a list contains only the setups price DID come back to — it never
 * pays for the ones it did not. The account would be charged for the fills and credited with
 * the hindsight.
 *
 * So the order rests, and comes off when the window closes: `maxGapToEntry` bars after the gap
 * formed, which is the same window the detector measures a fill in. A gap price ignored for
 * that long is no longer the level this move left behind, and an order still sitting there
 * would fill days later on a move that has nothing to do with the setup.
 *
 * One at a time
 * -------------
 * A setup that arrives while an order is resting or a position is open is skipped rather than
 * queued. Two overlapping trades from the same rules make the result impossible to attribute,
 * and the detector already keeps only one setup per window occurrence.
 *
 * Stop and target
 * ---------------
 * The stop is the detector's: just beyond the wick that took the liquidity. That price is a
 * fact about the market and does not move with the fill.
 *
 * The target is measured here rather than taken from the detector, because `rrr` is a strategy
 * parameter and has to mean the same thing across every strategy — see RISK_PARAMS. Measured
 * from the entry, which for a resting order is the price it fills at, so the reward-to-risk
 * asked for is the one the trade actually carries.
 */

/** Which detector settings a trader would reach for, minus the ones that describe a drawing.
 *  `rrr` is deliberately absent: it is a strategy-level parameter and comes from RISK_PARAMS,
 *  so the two cannot mean different things in one run. */
const DETECTOR_PARAMS: readonly StrategyParam[] = [
    {
        key: 'windows',
        label: 'Hours',
        type: 'multi',
        default: [...SILVER_BULLET_DEFAULTS.windows],
        hint: 'Which Silver Bullet hours count, in New York local time — 03:00, 10:00 and 14:00. '
            + 'They follow the US clock change rather than a fixed UTC hour.',
        options: [
            { value: 'london', label: 'London' },
            { value: 'am', label: 'NY AM' },
            { value: 'pm', label: 'NY PM' },
        ],
    },
    {
        key: 'scope',
        label: 'Inside the hour',
        type: 'select',
        default: SILVER_BULLET_DEFAULTS.scope,
        hint: 'How much of the setup has to fall inside the hour. The signal — the structure '
            + 'shift, where the order goes in — always does; "Everything" also demands the sweep '
            + 'and the gap, which is far stricter because the sweep often happens before the '
            + 'window opens.',
        options: [
            { value: 'signal', label: 'Signal only' },
            { value: 'all', label: 'Everything' },
        ],
    },
    {
        key: 'strength',
        label: 'Swing strength',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.strength,
        min: 1,
        max: 50,
        step: 1,
        hint: 'How many bars either side must be lower for a high to count as liquidity worth '
            + 'sweeping. Larger finds fewer and more significant levels.',
    },
    {
        key: 'confirmBars',
        label: 'Reclaim within',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.confirmBars,
        min: 1,
        max: 100,
        step: 1,
        hint: 'How many bars price has to close back inside the swept level within, counted from '
            + 'the bar that breached it. 1 demands wick through and body back on one candle.',
    },
    {
        key: 'maxSweepToGap',
        label: 'Sweep → gap',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.maxSweepToGap,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many bars the gap may lag the sweep by. The two belong to one move, so a gap '
            + 'that shows up much later is a different move that happens to point the same way.',
    },
    {
        key: 'maxGapToEntry',
        label: 'Order rests for',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.maxGapToEntry,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many bars the limit order waits at the gap edge before it is cancelled, '
            + 'counted from the bar the gap formed on.',
    },
    {
        key: 'minGapSize',
        label: 'Min gap size',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.minGapSize,
        min: 0,
        max: 1e6,
        step: 0.5,
        hint: 'Ignore gaps thinner than this. A gap too small to hold a stop is not a setup, '
            + 'whatever else lines up around it. 0 keeps every one of them.',
    },
    {
        key: 'minGapSizeUnit',
        label: 'Measured in',
        type: 'select',
        default: SILVER_BULLET_DEFAULTS.minGapSizeUnit,
        hint: 'How the minimum size and the merge width are read. Points are the raw distance the '
            + 'instrument is quoted in — what you size a stop in; percent keeps its meaning as '
            + 'price moves.',
        options: [
            { value: 'points', label: 'Points' },
            { value: 'percent', label: 'Percent' },
        ],
    },
    {
        key: 'mergeWick',
        label: 'Merge stacked gaps',
        type: 'number',
        default: SILVER_BULLET_DEFAULTS.mergeWick,
        min: 0,
        max: 1e6,
        step: 0.5,
        hint: 'How wide a traded strip may be before two gaps left by the same impulse count as '
            + 'separate zones. An impulse rarely leaves one gap; merging them reads the run as the '
            + 'single imbalance a trader sees. 0 keeps every gap apart.',
    },
];

/**
 * The settings that change which setups EXIST.
 *
 * Everything the detector takes, and nothing else — which is what lets a sweep over the
 * risk or the reward-to-risk reuse one detection across every one of its combinations.
 *
 * `rrr` is deliberately not among them, even though the detector accepts one. It reaches
 * only `setup.target` and the outcome fields, and this strategy reads neither: the target
 * is measured here, from the price the order actually filled at (see the header). To keep
 * that true by construction rather than by memory, the detector is handed a fixed 1 below.
 */
const DETECTION_KEYS = [
    'windows', 'scope', 'strength', 'confirmBars',
    'maxSweepToGap', 'maxGapToEntry', 'minGapSize', 'minGapSizeUnit', 'mergeWick',
] as const;

/** What the strategy remembers between bars: the order waiting at the gap edge. */
interface Resting {
    orderId: number;
    /** The last bar it may fill on. */
    expiryIndex: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`silverbullet: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`silverbullet: ${key} must be a string`);
    return value;
}

export const SILVER_BULLET_STRATEGY: StrategySpec = {
    id: 'silverbullet',
    name: 'Silver Bullet',
    description: 'Sweep, gap, structure shift and retest, inside one of the three hours. Rests a '
        + 'limit order at the gap edge and exits at a fixed reward-to-risk.',
    indicator: SILVER_BULLET_INDICATOR_TYPE,
    indicatorName: 'Silver Bullet',
    /* The four answers that make this a strategy and not the indicator it reads. The
     * indicator marks the same setups on the chart and stops there; everything below is
     * what this file adds, and all of it is settable. */
    rules: {
        conditions: [
            'A swing high or low is run and given back — the sweep.',
            'The move away leaves a fair value gap behind it.',
            'A close undoes the last candle opposing that move — the structure shift.',
            'All of it falls inside the London, New York morning or New York afternoon hour, '
            + 'read on a New York clock.',
            'Nothing else is open: a setup arriving while an order rests or a position is on '
            + 'is skipped rather than queued.',
        ],
        entry: 'A limit order resting at the near edge of the gap, placed on the bar the '
            + 'structure shifted and cancelled if price has not come back within the window. '
            + 'Never a market order on the setup bar — that would pay a price nobody could get.',
        stop: 'Just beyond the wick that took the liquidity. A fact about the market, so it '
            + 'does not move with the fill.',
        target: 'The distance from the fill to the stop, multiplied by the reward-to-risk. '
            + 'Measured from the price the order actually filled at, so the ratio asked for is '
            + 'the one the trade carries.',
        size: 'Derived, never set: the risk per trade divided by the distance to the stop, '
            + 'capped by the leverage ceiling. A wider stop buys a smaller position rather '
            + 'than a bigger loss.',
    },
    params: [...RISK_PARAMS, ...DETECTOR_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const windows = params.windows;
        if (!Array.isArray(windows)) throw new Error('silverbullet: windows must be a list');

        const rrr = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        /* Null when the notional ceiling is switched off: the size is then whatever the
         * risk asks for, and being stopped out costs exactly what was typed in. */
        const cap = leverageCap(params);

        /* `show: 'all'` is what makes the run honest: the setups price never came back to are
         * exactly the ones a strategy pays for by having its order sit there, and a list
         * without them would be a list of trades that were always going to happen.
         *
         * Detected once per set of detector settings when a sweep hands a cache in, which
         * is what makes sweeping the risk or the reward affordable — see DETECTION_KEYS for
         * why `rrr` is fixed at 1 here rather than passed through. */
        const setups = cached(cache, detectionCacheKey('silverbullet', params, DETECTION_KEYS), () => (
            detectSilverBullet(bars, {
                windows: windows as readonly SilverBulletWindowId[],
                scope: stringOf(params, 'scope') as SilverBulletScope,
                strength: numberOf(params, 'strength'),
                confirmBars: numberOf(params, 'confirmBars'),
                maxSweepToGap: numberOf(params, 'maxSweepToGap'),
                maxGapToEntry: numberOf(params, 'maxGapToEntry'),
                minGapSize: numberOf(params, 'minGapSize'),
                minGapSizeUnit: stringOf(params, 'minGapSizeUnit') as FvgSizeUnit,
                mergeWick: numberOf(params, 'mergeWick'),
                rrr: 1,
                show: 'all',
            })
        ));

        return {
            params,
            events: { setups },

            onBar(ctx) {
                const resting = ctx.state.resting as Resting | undefined;
                if (resting) {
                    const live = ctx.pendingOrders.some((o) => o.id === resting.orderId);
                    if (!live) {
                        // It filled, or a bracket leg retired it. Either way it is not waiting.
                        ctx.state.resting = undefined;
                    } else if (ctx.index >= resting.expiryIndex) {
                        /* This bar has already been offered to the order, so the window is
                         * genuinely spent — the gap is no longer the level this move left. */
                        ctx.cancel(resting.orderId);
                        ctx.state.resting = undefined;
                    }
                }

                // One at a time: see the header.
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                const arriving = ctx.events<SilverBulletSetup>('setups');
                if (arriving.length === 0) return;
                const setup = arriving[0]!;

                const size = positionSize(ctx.equity, setup.entryPrice, setup.stop, riskMode, riskValue, cap);
                if (size == null) return;

                const long = setup.direction === 'bull';
                const distance = Math.abs(setup.entryPrice - setup.stop);
                const target = long ? setup.entryPrice + distance * rrr : setup.entryPrice - distance * rrr;

                const order = ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'limit',
                    size,
                    limitPrice: setup.entryPrice,
                    /* Attached the moment it fills, never before: a stop and a target resting
                     * against a position that does not exist yet would cancel themselves. */
                    bracket: { stopLoss: setup.stop, takeProfit: target },
                    tag: setup.window,
                });
                ctx.state.resting = { orderId: order.id, expiryIndex: setup.expiryIndex } satisfies Resting;
            },
        };
    },
};
