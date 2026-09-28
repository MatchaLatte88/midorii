import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    OPENING_RANGE_DEFAULTS,
    detectOpeningRanges,
    type OpeningRange,
    type OpeningRangeSessionId,
} from '../../../src/core/analysis/openingRange';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Relative Volume ORB — Opening Range Breakout as the research that survives contact with a
 * backtest defines it, named for the one ingredient that separates it from every other
 * variant of the pattern.
 *
 * Which version this is, and why
 * ------------------------------
 * ORB is old and has as many variants as it has authors. The one implemented here is the
 * 5-minute ORB of Zarattini, Barbon & Aziz, *A Profitable Day Trading Strategy For The U.S.
 * Equity Market* (SSRN 4729284, February 2024), because it is the only version in the public
 * literature that states every rule, was tested over 7,000 stocks and eight years, and — this
 * is the part that matters — reports what the same rules do WITHOUT its key filter. That
 * comparison is the reason to prefer it:
 *
 *   ORB on everything that met the liquidity filters   3.2% a year, Sharpe 0.48
 *   the same rules, only on unusually active openings  41.6% a year, Sharpe 2.81
 *
 * The rules did almost nothing. Trading them only where the opening range drew unusual volume
 * did nearly all of it. Their own timeframe comparison points the same way — Sharpe 2.81 at 5
 * minutes against 1.43 at 15, 0.21 at 30 and 0.40 at 60 — so the defaults below are the
 * 5-minute range and a relative-volume floor at 100%, and the floor is the first thing worth
 * sweeping.
 *
 * The earlier paper by two of the same authors (SSRN 4416622) trades QQQ this way with a 10R
 * target and no volume filter. It is the better-known one and it is the weaker result: an
 * independent replication puts it at break-even around 2.2 cents a share of slippage. Its one
 * idea worth keeping is the profit target, which is why `useTarget` exists and why it is off.
 *
 * What does not carry over, and is not faked
 * ------------------------------------------
 * The published portfolio traded the top 20 stocks by relative volume each day, ranked across
 * the whole US market. A run here sees one instrument, so that ranking is not available and is
 * not approximated — a "top 20" computed against a single symbol's own history would be the
 * relative-volume filter under a second name, reported as if it were the cross-sectional
 * selection that did the work. What is here is the part that is genuinely per-instrument: the
 * range, the direction rule, the ATR stop, the close-out, and the relative-volume floor
 * measured against the same instrument's own recent openings.
 *
 * So the honest reading of a result from this file: it is the paper's rules on one symbol,
 * without the stock selection. On an index or a future — where there is nothing to select
 * from anyway — that is the whole strategy. On a single stock it is a component of it.
 *
 * The direction rule is the strategy
 * ----------------------------------
 * A breakout out of the range is not traded on its own. If the opening range closed BELOW its
 * open, only a short is allowed, however far price later breaks above the range high. The
 * range's own close is read as the imbalance the session opened with, and a break the other
 * way is the market disagreeing with it. Dropping this rule turns the strategy into a plain
 * two-sided breakout, which is what the literature finds does not work.
 *
 * Getting flat is a decision made a bar early
 * -------------------------------------------
 * The position comes off at the session close. An order in this engine never fills on the bar
 * that placed it, so asking to close on the last bar of the session would fill on the next one
 * — the next morning, across the gap the strategy exists to avoid holding. So the close is
 * ordered on the second-to-last bar and fills on the last, which is both correct here and what
 * closing "at the bell" means in practice. The entry order is cancelled on the same bar for
 * the same reason: one that filled on the final bar would leave a position nothing could exit.
 */

const SESSION_OPTIONS = [
    { value: 'nyse', label: 'US cash (09:30 New York)' },
    { value: 'utc', label: 'UTC day (00:00)' },
] as const;

/** What the range is measured over, as against what is done about it. */
const RANGE_PARAMS: readonly StrategyParam[] = [
    {
        key: 'session',
        label: 'Session',
        type: 'select',
        default: OPENING_RANGE_DEFAULTS.session,
        hint: 'Which opening the range is measured from. The US cash session is 09:30 to 16:00 '
            + 'New York and follows the US clock change rather than a fixed UTC hour — it is the '
            + 'open equities, index futures and their ETFs actually trade around. A market that '
            + 'never closes has no opening, so crypto gets the UTC day, which is where its daily '
            + 'candles are cut.',
        options: SESSION_OPTIONS,
    },
    {
        key: 'rangeMinutes',
        label: 'Opening range',
        type: 'number',
        default: OPENING_RANGE_DEFAULTS.rangeMinutes,
        min: 1,
        max: 240,
        step: 5,
        hint: 'How many minutes after the open the range covers. 5 is what the research finds '
            + 'best by a wide margin — 15, 30 and 60 were all far weaker over the same eight '
            + 'years. It must be a whole number of chart bars: a 5-minute range cannot be built '
            + 'on a 15m chart, and asking for one is refused rather than rounded.',
    },
    {
        key: 'atrStopPct',
        label: 'Stop, as % of daily ATR',
        type: 'number',
        default: 10,
        min: 0.1,
        max: 200,
        step: 1,
        hint: 'How far the stop sits from the fill, as a percentage of the average daily range. '
            + 'A fixed fraction of ATR rather than a fixed price keeps the same stop meaning the '
            + 'same thing on a quiet day and a violent one. 10% is the published figure; it is '
            + 'tight, which is the point — it buys a large position on a day that trends.',
    },
    {
        key: 'atrDays',
        label: 'ATR days',
        type: 'number',
        default: OPENING_RANGE_DEFAULTS.atrDays,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many previous sessions the daily ATR averages over. Read from the sessions '
            + 'before this one, never including today.',
    },
    {
        key: 'minRelVolume',
        label: 'Min relative volume',
        type: 'number',
        default: 100,
        min: 0,
        max: 5000,
        step: 25,
        hint: 'How much volume the opening range must trade, as a percentage of what the same '
            + 'minutes traded on recent sessions. 100 means an ordinary opening and is the '
            + 'published floor; below it the researched edge is gone, and above it the average '
            + 'trade improves while the number of trades falls. This is the single setting that '
            + 'separates the profitable version from the flat one — sweep it first. 0 switches '
            + 'the filter off, which is the strategy the same paper measures at 3.2% a year.',
    },
    {
        key: 'relVolumeDays',
        label: 'Relative volume days',
        type: 'number',
        default: OPENING_RANGE_DEFAULTS.relVolumeDays,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many previous sessions the opening volume is compared against.',
    },
    {
        key: 'useTarget',
        label: 'Take profit at reward : risk',
        type: 'bool',
        default: false,
        hint: 'Off, the trade is held to the session close whatever it is doing, which is what '
            + 'the research this follows does — the strategy earns its money on the few days '
            + 'that trend all day, and a target cuts exactly those short. On, the Reward : risk '
            + 'above becomes a real target and whichever comes first ends the trade.',
    },
];

/**
 * The settings that change which ranges EXIST, and how the numbers attached to them are
 * measured. Everything the detector takes, and nothing else.
 *
 * `minRelVolume` is deliberately not among them even though it decides which ranges get
 * traded. The detector reports every range with its relative volume attached and this file
 * does the comparing, so a sweep of the floor — the setting most worth sweeping — reuses one
 * detection across every level of it. `atrStopPct` is out for the ordinary reason: it changes
 * the stop, not the setups.
 */
const DETECTION_KEYS = ['session', 'rangeMinutes', 'atrDays', 'relVolumeDays'] as const;

/** What the strategy remembers between bars: the one trade this session gets. */
interface SessionState {
    /** The entry order waiting at the range edge. */
    orderId: number;
    /** The bar to cancel it on and to order the close from — one before the session's last. */
    flatIndex: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`openingrange: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`openingrange: ${key} must be a string`);
    return value;
}

function boolOf(params: StrategyParams, key: string): boolean {
    const value = params[key];
    if (typeof value !== 'boolean') throw new Error(`openingrange: ${key} must be true or false`);
    return value;
}

export const OPENING_RANGE_STRATEGY: StrategySpec = {
    id: 'openingrange',
    name: 'Relative Volume ORB',
    description: 'Trades the break of the session\'s first minutes, in the direction those '
        + 'minutes closed, and only when they drew unusual volume. Stop a fraction of the daily '
        + 'ATR away, flat by the close.',
    rules: {
        conditions: [
            'The session\'s opening range is complete, and it closed away from where it opened '
            + '— a doji says nothing about direction and is not traded.',
            'The opening range traded at least the relative volume asked for, measured against '
            + 'the same minutes on the previous sessions. This is the filter the researched edge '
            + 'lives in, not a refinement of it.',
            'There is a daily ATR from earlier sessions to size the stop against, which there is '
            + 'not for the first sessions in the data.',
            'The session has room left to enter and get flat again before it closes.',
            'One trade per session: the day\'s order is placed once and not replaced, whether it '
            + 'fills, stops out or expires unfilled.',
        ],
        entry: 'A stop order at the edge the range closed towards — its high going long, its low '
            + 'going short — placed when the range completes and cancelled unfilled at the close. '
            + 'The direction is the range\'s own, never the breakout\'s: a range that closed lower '
            + 'is only ever traded short, however far price later breaks above it.',
        stop: 'A fixed fraction of the daily ATR, measured from the price the order actually '
            + 'filled at rather than from the trigger, so a gap straight through the level does '
            + 'not quietly widen the risk it was sized for.',
        target: 'The session close — the position comes off at the bell whatever it is doing. A '
            + 'reward-to-risk target can be switched on, and then whichever comes first ends the '
            + 'trade; it is off by default because the research this follows finds a target costs '
            + 'more on the trending days than it saves on the rest.',
        size: 'Derived, never set: the risk per trade divided by the distance to the stop, capped '
            + 'by the leverage ceiling. The stop being a fixed share of the daily ATR, a more '
            + 'volatile day buys a smaller position rather than a bigger loss.',
    },
    params: [...RISK_PARAMS, ...RANGE_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const rrr = numberOf(params, 'rrr');
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        /* Null when the notional ceiling is switched off: the size is then whatever the
         * risk asks for, and being stopped out costs exactly what was typed in. */
        const cap = leverageCap(params);

        const atrStopPct = numberOf(params, 'atrStopPct');
        const minRelVolume = numberOf(params, 'minRelVolume');
        const useTarget = boolOf(params, 'useTarget');

        const ranges = cached(cache, detectionCacheKey('openingrange', params, DETECTION_KEYS), () => (
            detectOpeningRanges(bars, {
                session: stringOf(params, 'session') as OpeningRangeSessionId,
                rangeMinutes: numberOf(params, 'rangeMinutes'),
                atrDays: numberOf(params, 'atrDays'),
                relVolumeDays: numberOf(params, 'relVolumeDays'),
            })
        ));

        /* Said out loud rather than absorbed. Without volume every range's relative volume is
         * null, so the filter would reject every setup and the run would report "no trades" for
         * a strategy that was configured correctly and handed the wrong data. */
        if (minRelVolume > 0 && ranges.length > 0 && ranges.every((r) => r.volume == null)) {
            throw new Error(
                'openingrange: these bars carry no volume, so relative volume cannot be measured. '
                + 'Set Min relative volume to 0 to trade the ranges anyway — that is the version '
                + 'the research measures at 3.2% a year.',
            );
        }

        return {
            params,
            events: { ranges },

            onBar(ctx) {
                const session = ctx.state.session as SessionState | undefined;
                if (session) {
                    // Still mid-session: the day already had its one order.
                    if (ctx.index < session.flatIndex) return;

                    /* The close is ordered here, one bar early, so it fills on the session's
                     * last bar instead of the next morning — see the header. The entry goes at
                     * the same moment: one that filled on the final bar would leave a position
                     * with nothing left to exit it. */
                    ctx.cancel(session.orderId);
                    if (!ctx.isFlat) ctx.close('session-close');
                    ctx.state.session = undefined;
                }

                const arriving = ctx.events<OpeningRange>('ranges');
                if (arriving.length === 0) return;
                const range = arriving[0]!;

                // A range that closed where it opened points nowhere.
                if (range.direction == null || range.trigger == null) return;
                // No ATR yet: the stop has no width, so there is no trade to size.
                if (range.atr == null) return;

                if (minRelVolume > 0) {
                    // Null is "not enough sessions to say", which is not the same as "quiet".
                    if (range.relativeVolume == null) return;
                    if (range.relativeVolume * 100 < minRelVolume) return;
                }

                /* Nowhere to get flat. A session with one bar left after the range could fill an
                 * entry it could never exit, and the position would run into the next day. */
                const flatIndex = range.sessionEndIndex - 1;
                if (flatIndex <= range.index) return;

                const stopDistance = range.atr * (atrStopPct / 100);
                if (!(stopDistance > 0)) return;

                const long = range.direction === 'long';
                const trigger = range.trigger;
                /* Sized off the trigger, which is where the order is, not where it will fill —
                 * the fill is unknown until it happens, and this is the same information a
                 * person placing the order has. The bracket below is what keeps the risk true
                 * when the two differ. */
                const size = positionSize(
                    ctx.equity,
                    trigger,
                    long ? trigger - stopDistance : trigger + stopDistance,
                    riskMode,
                    riskValue,
                    cap,
                );
                if (size == null) return;

                const order = ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'stop',
                    size,
                    stopPrice: trigger,
                    /* Distances, not prices: measured from the fill, so a gap through the
                     * trigger costs what the trade was sized to risk instead of more. */
                    bracket: useTarget
                        ? { stopDistance, targetDistance: stopDistance * rrr }
                        : { stopDistance },
                    tag: range.day,
                });
                ctx.state.session = { orderId: order.id, flatIndex } satisfies SessionState;
            },
        };
    },
};
