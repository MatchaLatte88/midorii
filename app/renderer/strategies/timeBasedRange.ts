import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    TIME_BASED_RANGE_DEFAULTS,
    detectTimeBasedRange,
    type TimeBasedRangeSetup,
} from '../../../src/core/analysis/timeBasedRange';
import type { BarClock } from '../../../src/core/analysis/barClock';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * TBR9 Cell Continuation — an hour that stayed quiet against its own forecast, and the first
 * thing that breaks it.
 *
 * What this implements
 * --------------------
 * The outright-futures version of a sleeve measured on index options. Before the cell hour
 * opens, walls are placed a quarter of a standard deviation either side of the 07:00 open,
 * where that deviation is what the last twenty mornings actually did. If the whole cell hour
 * stays inside those walls, the first bar of the NEXT hour to touch one sets the direction.
 * The 07:00 open is the stop, and the position comes off at 11:00 whatever it is doing.
 *
 * The published NQ measurement is 358 trades from 2022 to August 2026 at a 32% win rate and
 * a profit factor of 1.76; ES is the same signal, weaker. A 32% win rate is not a flaw in the
 * translation — it is what the strategy is. It loses small, often, against the few sessions
 * that keep going all morning, and the source records that a 30-minute time stop and
 * percentage stops were both tested and rejected for cutting exactly those.
 *
 * The detection is in the chart core; see `analysis/timeBasedRange.ts` for why the walls are
 * a forecast rather than the cell hour own high and low, which is the part that makes this
 * more than an opening-range break.
 *
 * The one rule the source does not settle
 * ---------------------------------------
 * On options, the ticket waits for the 08:30 Central cash open plus a minute, because there
 * are no quotes on a same-day index option before the cash session. The trigger hour starts
 * at 08:00, so a signal at 08:05 waits twenty-five minutes to be filled. On outright futures
 * that reason disappears — the contract has been trading all night — and the futures
 * translation is stated only as "entry at the open of the bar after the signal".
 *
 * Which of the two was measured is not said anywhere, and twenty-five minutes of a trending
 * morning is not a rounding difference. So it is a setting: `Earliest entry` at 00:00 takes
 * the signal immediately, which is the futures reading, and 08:30 reproduces the options
 * one. Run both before trusting either.
 *
 * While a ticket waits, the cancel rule from the source applies: a bar closing back through
 * the 07:00 open before the entry kills it. That is checked on the signal bar too — its close
 * is the last thing known before the fill, and a signal whose own bar closed back through the
 * open is a wall touched by a wick and given straight back.
 */

const CELL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'cellStartMin',
        label: 'Cell opens',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.cellStartMin,
        hint: 'Start of the quiet hour, on a Central-Time clock. Its opening price anchors the '
            + 'walls and is where the trade is wrong, so moving this moves the whole setup.',
    },
    {
        key: 'cellEndMin',
        label: 'Cell closes',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.cellEndMin,
        hint: 'End of the quiet hour and start of the trigger window. Every bar between the two '
            + 'must stay strictly inside the walls or the session is passed over.',
    },
    {
        key: 'triggerEndMin',
        label: 'Trigger until',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.triggerEndMin,
        hint: 'End of the window a wall may be touched in. A session that has not broken out by '
            + 'then is not traded at all — a later break is a different move.',
    },
    {
        key: 'entryFromMin',
        label: 'Earliest entry',
        type: 'time',
        default: 0,
        hint: 'The clock time before which no ticket is sent. 00:00 takes the signal at the next '
            + 'bar open, which is the outright-futures reading. 08:30 holds it to the US cash '
            + 'open, which is what the options version of this sleeve has to do because there '
            + 'are no quotes before it. The source does not say which was measured on futures, '
            + 'so the two are worth running against each other.',
    },
    {
        key: 'exitMin',
        label: 'Flat at',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.returnEndMin,
        hint: 'When the position comes off, on a Central-Time clock. The close is ordered on the '
            + 'bar completing at this time and fills at the next bar open, so the fill lands on '
            + 'the clock. It matches the end of the morning window sigma is measured over, so '
            + 'the yardstick and the holding period are the same stretch of day.',
    },
    {
        key: 'returnEndMin',
        label: 'Morning return to',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.returnEndMin,
        hint: 'The close each previous session is measured to when building sigma, against that '
            + 'session own cell open. This is the forecast the walls are made of, so it decides '
            + 'how wide they sit.',
    },
    {
        key: 'sigmaDays',
        label: 'Sigma sessions',
        type: 'number',
        default: TIME_BASED_RANGE_DEFAULTS.sigmaDays,
        min: 2,
        max: 250,
        step: 1,
        hint: 'How many previous sessions the forecast averages over. Sessions with no morning '
            + 'on record — holidays, halts — are skipped rather than counted as flat, so this is '
            + 'twenty that traded and not twenty calendar days.',
    },
    {
        key: 'bandSigma',
        label: 'Wall distance, in sigma',
        type: 'number',
        default: TIME_BASED_RANGE_DEFAULTS.bandSigma,
        min: 0.05,
        max: 3,
        step: 0.05,
        hint: 'How far the walls sit from the cell open, as a multiple of the forecast. Lower '
            + 'walls are touched more often, so the cell hour is quiet less often and the few '
            + 'sessions that qualify break out harder. This is the setting that decides how many '
            + 'trades there are.',
    },
];

/** The settings that change which sessions ARE setups. `entryFromMin` and `exitMin` change
 *  what is done with one, so a sweep of either reuses one detection. */
const DETECTION_KEYS = [
    'cellStartMin', 'cellEndMin', 'triggerEndMin', 'returnEndMin', 'sigmaDays', 'bandSigma',
] as const;

/** A signal whose ticket is not allowed out yet, and everything needed to place or kill it. */
interface Waiting {
    day: string;
    direction: 'long' | 'short';
    cellOpen: number;
}

/** What the strategy remembers while a position is on. */
interface OpenTrade {
    day: string;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`tbr9: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`tbr9: ${key} must be a string`);
    return value;
}

/** Whether a close has given the break back — the cancel rule, and the reason a wick that
 *  touched a wall and closed back inside is not traded. */
function gaveItBack(close: number, cellOpen: number, direction: 'long' | 'short'): boolean {
    return direction === 'long' ? close <= cellOpen : close >= cellOpen;
}

export const TIME_BASED_RANGE_STRATEGY: StrategySpec = {
    id: 'tbr9',
    name: 'TBR9 Cell Continuation',
    description: 'Fences off the 07:00 hour with walls set from the last twenty mornings. If '
        + 'that hour stays inside them, trades the first touch of a wall in the hour after, '
        + 'stopped at the 07:00 open and flat at 11:00.',
    rules: {
        conditions: [
            'Twenty previous sessions have a morning on record, so there is a forecast to place '
            + 'the walls with. Sessions without one are skipped rather than counted as flat.',
            'The session has a cell hour, and every bar of it stayed strictly inside the walls. '
            + 'A cell bar that so much as reaches a wall ends the session.',
            'A bar in the trigger window touched one wall and not the other. A bar that reached '
            + 'both is passed over: which came first is what a bar cannot say, and here the '
            + 'direction is the whole trade.',
            'The signal bar did not close back through the cell open, and neither did any bar '
            + 'while the ticket waited for the earliest entry time.',
            'One trade per session, taken once and not re-entered after it ends.',
        ],
        entry: 'A market order placed on the signal bar — or on the first bar completing at or '
            + 'after the earliest entry time, when one is set — filling at the next bar open. '
            + 'There is no level to rest an order at: the wall has already been touched, and an '
            + 'order back at it would be waiting for the move to fail.',
        stop: 'The cell open, as a price rather than a distance. It is a fact about the session '
            + 'and not about the fill, so a gap into the trade costs more than planned instead '
            + 'of quietly moving the level the setup was built on.',
        target: 'The flat-at time, on the clock rather than at a price — the same end of the '
            + 'morning the forecast is measured over. The reward-to-risk setting is unused: a '
            + 'target was tested on the sleeve this follows and rejected for cutting the few '
            + 'sessions that carry the result.',
        size: 'Derived, never set: the risk per trade divided by the distance from the expected '
            + 'fill to the cell open, capped by the leverage ceiling. A break that has already '
            + 'travelled far from the open therefore buys a smaller position.',
    },
    params: [...RISK_PARAMS, ...CELL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        /* Null when the notional ceiling is switched off: the size is then whatever the
         * risk asks for, and being stopped out costs exactly what was typed in. */
        const cap = leverageCap(params);
        const entryFromMin = numberOf(params, 'entryFromMin');
        const exitMin = numberOf(params, 'exitMin');

        const cellEndMin = numberOf(params, 'cellEndMin');
        const triggerEndMin = numberOf(params, 'triggerEndMin');
        if (entryFromMin >= exitMin) {
            throw new Error(
                `tbr9: Earliest entry (${entryFromMin}) is at or after Flat at (${exitMin}), so `
                + 'every ticket would be killed by the clock before it could be sent.',
            );
        }

        const detection = cached(cache, detectionCacheKey('tbr9', params, DETECTION_KEYS), () => (
            detectTimeBasedRange(bars, {
                cellStartMin: numberOf(params, 'cellStartMin'),
                cellEndMin,
                triggerEndMin,
                returnEndMin: numberOf(params, 'returnEndMin'),
                sigmaDays: numberOf(params, 'sigmaDays'),
                bandSigma: numberOf(params, 'bandSigma'),
                zone: TIME_BASED_RANGE_DEFAULTS.zone,
            })
        ));

        const clock: BarClock = detection.clock;

        /** Places the ticket, or returns false where there is no honest size for it. */
        const send = (
            ctx: Parameters<RunnableStrategy<StrategyParams>['onBar']>[0],
            signal: Waiting,
        ): boolean => {
            const long = signal.direction === 'long';
            const price = ctx.bar.close;
            /* Sized off this bar close, the last price known before the order goes in — the
             * same information a person placing it would have. */
            const size = positionSize(
                ctx.equity, price, signal.cellOpen, riskMode, riskValue, cap,
            );
            if (size == null) return false;

            ctx.order({
                side: long ? 'buy' : 'sell',
                type: 'market',
                size,
                bracket: { stopLoss: signal.cellOpen },
                tag: signal.day,
            });
            ctx.state.trade = { day: signal.day } satisfies OpenTrade;
            return true;
        };

        return {
            params,
            events: { setups: detection.setups },

            onBar(ctx) {
                const trade = ctx.state.trade as OpenTrade | undefined;

                if (trade) {
                    /* The stop may already have ended it. The session backstop is for data
                     * missing the exit bar, which would otherwise carry a position overnight. */
                    const late = clock.closeMinutes[ctx.index]! >= exitMin;
                    const nextSession = clock.days[ctx.index] !== trade.day;
                    if (late || nextSession) {
                        if (!ctx.isFlat) ctx.close(late ? 'flat-at' : 'session-end');
                        ctx.state.trade = undefined;
                    }
                    return;
                }

                const waiting = ctx.state.waiting as Waiting | undefined;
                if (waiting) {
                    // A new session arrived without the ticket ever going out: it expired.
                    if (clock.days[ctx.index] !== waiting.day) {
                        ctx.state.waiting = undefined;
                    } else if (gaveItBack(ctx.bar.close, waiting.cellOpen, waiting.direction)) {
                        ctx.state.waiting = undefined;
                    } else if (clock.closeMinutes[ctx.index]! >= entryFromMin) {
                        ctx.state.waiting = undefined;
                        send(ctx, waiting);
                    }
                    return;
                }

                const arriving = ctx.events<TimeBasedRangeSetup>('setups');
                if (arriving.length === 0) return;
                const setup = arriving[0]!;
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                const signal: Waiting = {
                    day: setup.day,
                    direction: setup.direction,
                    cellOpen: setup.cellOpen,
                };
                // The wall was touched and given straight back: there is nothing to continue.
                if (gaveItBack(ctx.bar.close, signal.cellOpen, signal.direction)) return;

                if (clock.closeMinutes[ctx.index]! >= entryFromMin) send(ctx, signal);
                else ctx.state.waiting = signal;
            },
        };
    },
};
