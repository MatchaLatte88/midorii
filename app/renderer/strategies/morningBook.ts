import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    detectMorningBook,
    type MorningBookSignal,
} from '../../../src/core/analysis/morningBook';
import { PHASE_OSCILLATOR_DEFAULTS } from '../../../src/core/analysis/phaseOscillator';
import type { PhaseOscillatorCross } from '../../../src/core/analysis/phaseOscillator';
import { TIME_BASED_RANGE_DEFAULTS } from '../../../src/core/analysis/timeBasedRange';
import type { BarClock } from '../../../src/core/analysis/barClock';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Morning Book, First Signal Wins — the cell continuation and the phase oscillator sharing one
 * seat.
 *
 * What this implements
 * --------------------
 * The outright-futures version of the strongest sleeve in the book it comes from: 500 trades
 * on NQ from 2022 to August 2026, 41% winners, profit factor 1.94, and positive in every
 * window its authors measured. It is not a third signal. It is the two sleeves already in this
 * folder — {@link ./timeBasedRange.ts} and {@link ./phaseOscillator.ts} — with a rule about
 * which of them gets to trade.
 *
 * Run those two side by side and they double up on the mornings they agree, which are the
 * mornings a directional move is obvious, and double the loss when the move is a fake. The
 * book is the fix: one seat, taken by whichever engine speaks first, and the other engine is
 * done for the day whatever it sees afterwards. A tie goes to the oscillator.
 *
 * The seat is taken by the signal, not by the trade. An engine whose signal is later refused
 * — the cell break that closed back through its own open — has still spent the morning. That
 * is the published rule and it is the pessimistic reading: it costs trades rather than
 * inventing them.
 *
 * Each component keeps its own exits
 * ----------------------------------
 * There is no book-level stop or target, and that is deliberate rather than unfinished: the
 * source records that a book-level stop was tested afterwards and failed, which is why this
 * sleeve carries a FOLLOW-UP rather than a clean verdict. So a cell trade is stopped at the
 * 07:00 open and flat at 11:00, an oscillator trade has no stop at all and comes off at the
 * opposite cross or at 14:50, and the book itself adds nothing to either.
 *
 * A consequence worth stating, because it will bite: which engine won decides how the
 * position was sized, and the two read `Max leverage` completely differently. For a cell
 * trade it is a CEILING on a size that risk and the stop distance already decided, so raising
 * it usually changes nothing. For an oscillator trade there is no stop and therefore no risk
 * distance, so it IS the size — at 100 an oscillator trade is a hundred times the account,
 * and two bad ones in a row end the run while every cell trade in the same run looks
 * perfectly sized.
 *
 * So set `Max leverage` for the oscillator half and let it cap the cell half, not the other
 * way round. That the same number means two things here is the honest translation of two
 * sleeves with different risk shapes; it is not a bug, and it is not comfortable either.
 *
 * Two timeframes, one series
 * --------------------------
 * The run needs the finer of the two timeframes — minutes, for the cell — and the oscillator's
 * bars are folded out of them. `Oscillator timeframe` says how long those are; it has to
 * divide evenly into the chart's own bars, and asking for something that does not is refused
 * rather than rounded.
 */

const OSCILLATOR_PARAMS: readonly StrategyParam[] = [
    {
        key: 'oscillatorMinutes',
        label: 'Oscillator timeframe',
        type: 'number',
        default: 10,
        min: 1,
        max: 240,
        step: 1,
        hint: 'How long the bars the oscillator is measured on are, in minutes. 10 is the '
            + 'published figure. It must be a whole multiple of the chart\'s own bars — a '
            + '10-minute oscillator cannot be folded out of a 15-minute chart, and asking for '
            + 'one is refused rather than rounded.',
    },
    {
        key: 'emaLength',
        label: 'EMA length',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.emaLength,
        min: 2,
        max: 200,
        step: 1,
        hint: 'The moving average the oscillator measures distance from, on its own timeframe.',
    },
    {
        key: 'atrLength',
        label: 'ATR length',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.atrLength,
        min: 2,
        max: 200,
        step: 1,
        hint: 'Length of the Wilder ATR that distance is measured in, on the oscillator\'s own '
            + 'timeframe rather than a daily one.',
    },
    {
        key: 'atrMultiple',
        label: 'ATRs per 100',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.atrMultiple,
        min: 0.5,
        max: 20,
        step: 0.5,
        hint: 'How many average ranges from the mean a reading of 100 stands for.',
    },
    {
        key: 'smoothing',
        label: 'Smoothing',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.smoothing,
        min: 1,
        max: 50,
        step: 1,
        hint: 'Length of the EMA applied to the finished oscillator. 1 switches it off.',
    },
    {
        key: 'level',
        label: 'Cross level',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.level,
        min: 10,
        max: 500,
        step: 10,
        hint: 'The reading whose crossing is a signal, taken plus and minus.',
    },
    {
        key: 'oscillatorFromMin',
        label: 'Oscillator signals from',
        type: 'time',
        default: PHASE_OSCILLATOR_DEFAULTS.fromMin,
        hint: 'Earliest oscillator bar CLOSE that may take the seat, on a Central-Time clock.',
    },
    {
        key: 'oscillatorToMin',
        label: 'Oscillator signals until',
        type: 'time',
        default: PHASE_OSCILLATOR_DEFAULTS.toMin,
        hint: 'Latest one, inclusive. A later cross can still end an oscillator trade but can '
            + 'no longer start one.',
    },
    {
        key: 'oscillatorExitMin',
        label: 'Oscillator flat at',
        type: 'time',
        default: 14 * 60 + 50,
        hint: 'When an oscillator trade comes off if no opposite cross has ended it.',
    },
];

const CELL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'cellStartMin',
        label: 'Cell opens',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.cellStartMin,
        hint: 'Start of the quiet hour. Its opening price anchors the cell engine\'s walls and '
            + 'is where a cell trade is wrong.',
    },
    {
        key: 'cellEndMin',
        label: 'Cell closes',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.cellEndMin,
        hint: 'End of the quiet hour and start of the window a wall may be touched in.',
    },
    {
        key: 'triggerEndMin',
        label: 'Cell trigger until',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.triggerEndMin,
        hint: 'End of that window. A session that has not broken out by then leaves the seat to '
            + 'the oscillator.',
    },
    {
        key: 'returnEndMin',
        label: 'Morning return to',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.returnEndMin,
        hint: 'The close each previous session is measured to when building the forecast the '
            + 'cell walls are made of.',
    },
    {
        key: 'sigmaDays',
        label: 'Sigma sessions',
        type: 'number',
        default: TIME_BASED_RANGE_DEFAULTS.sigmaDays,
        min: 2,
        max: 250,
        step: 1,
        hint: 'How many previous sessions that forecast averages over.',
    },
    {
        key: 'bandSigma',
        label: 'Wall distance, in sigma',
        type: 'number',
        default: TIME_BASED_RANGE_DEFAULTS.bandSigma,
        min: 0.05,
        max: 3,
        step: 0.05,
        hint: 'How far the cell walls sit from its open. Lower walls are touched more often, so '
            + 'the cell engine takes the seat on more mornings and the oscillator on fewer.',
    },
    {
        key: 'cellEntryFromMin',
        label: 'Cell earliest entry',
        type: 'time',
        default: 0,
        hint: 'The clock time before which a cell ticket is not sent. 00:00 takes it at the next '
            + 'bar open, which is the outright-futures reading; 08:30 holds it to the US cash '
            + 'open, which is what the options version has to do. It does not move the seat: '
            + 'the signal took that when it fired.',
    },
    {
        key: 'cellExitMin',
        label: 'Cell flat at',
        type: 'time',
        default: TIME_BASED_RANGE_DEFAULTS.returnEndMin,
        hint: 'When a cell trade comes off if its stop has not already ended it.',
    },
];

/** Everything that changes which signals EXIST and which engine took the seat. The exits and
 *  the cell entry delay change what is done with a seat, not who holds it. */
const DETECTION_KEYS = [
    'oscillatorMinutes', 'emaLength', 'atrLength', 'atrMultiple', 'smoothing', 'level',
    'oscillatorFromMin', 'oscillatorToMin',
    'cellStartMin', 'cellEndMin', 'triggerEndMin', 'returnEndMin', 'sigmaDays', 'bandSigma',
] as const;

/** The trade on, and which engine it belongs to — the exits differ by engine. */
interface OpenTrade {
    day: string;
    source: 'oscillator' | 'cell';
    direction: 'long' | 'short';
    exitMin: number;
}

/** A cell signal whose ticket is waiting for the earliest entry time. */
interface Waiting {
    day: string;
    direction: 'long' | 'short';
    stop: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`morningbook: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`morningbook: ${key} must be a string`);
    return value;
}

/** Whether a close has given a cell break back — the same cancel rule the cell sleeve uses. */
function gaveItBack(close: number, stop: number, direction: 'long' | 'short'): boolean {
    return direction === 'long' ? close <= stop : close >= stop;
}

export const MORNING_BOOK_STRATEGY: StrategySpec = {
    id: 'morningbook',
    name: 'Morning Book, First Signal Wins',
    description: 'Runs the cell continuation and the phase oscillator over the same morning and '
        + 'gives the single seat to whichever speaks first. Each keeps its own stop and its own '
        + 'closing time; the book adds neither.',
    rules: {
        conditions: [
            'One of the two engines produced a signal: a cell break out of a quiet 07:00 hour, '
            + 'or an oscillator crossing inside the morning window.',
            'It was the FIRST of the two that session. The other engine is finished for the '
            + 'morning whatever it sees afterwards, and a tie on the same bar goes to the '
            + 'oscillator.',
            'The seat is taken by the signal rather than by the trade: a cell break refused for '
            + 'closing back through its own open has still spent the morning.',
            'One position at a time, and one seat per session — there is no second entry after '
            + 'a trade ends.',
        ],
        entry: 'A market order on the bar the winning engine fired, filling at the next bar '
            + 'open. A cell ticket can be held back to a clock time first, which is what the '
            + 'options version of that engine has to do; the oscillator never waits.',
        stop: 'Whatever the winning engine\'s is. The cell engine stops at its 07:00 open, as a '
            + 'price rather than a distance. The oscillator has no stop at all, which is the '
            + 'measurement rather than an omission. The book adds none of its own: one was '
            + 'tested on this sleeve afterwards and failed.',
        target: 'The winning engine\'s own closing time — 11:00 for a cell trade, 14:50 for an '
            + 'oscillator one — or, for the oscillator, the opposite crossing if it comes '
            + 'first. Never a price, so the reward-to-risk setting is unused.',
        size: 'Decided by the engine that won, because they have different risk shapes. A cell '
            + 'trade has a stop, so it is the risk per trade divided by the distance to it, '
            + 'capped by the leverage ceiling. An oscillator trade has no stop and no risk '
            + 'distance, so the ceiling is not a cap on it — it is the whole size. Set Max '
            + 'leverage for that half: a value chosen to leave the cell trades alone will size '
            + 'the oscillator trades at many times the account.',
    },
    params: [...RISK_PARAMS, ...OSCILLATOR_PARAMS, ...CELL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        const maxLeverage = numberOf(params, 'maxLeverage');
        /* Null when the ceiling is switched off: then the size is whatever the risk asks
         * for, and being stopped out costs exactly what was typed in. Only the risk-based
         * branch reads it — a position sized AT the ceiling has no other size to fall back
         * on. See `leverageCap`. */
        const cap = leverageCap(params);

        const cellEntryFromMin = numberOf(params, 'cellEntryFromMin');
        const cellExitMin = numberOf(params, 'cellExitMin');
        const oscillatorExitMin = numberOf(params, 'oscillatorExitMin');
        if (cellEntryFromMin >= cellExitMin) {
            throw new Error(
                `morningbook: Cell earliest entry (${cellEntryFromMin}) is at or after Cell flat `
                + `at (${cellExitMin}), so every cell ticket would be killed by the clock before `
                + 'it could be sent.',
            );
        }

        const detection = cached(cache, detectionCacheKey('morningbook', params, DETECTION_KEYS), () => (
            detectMorningBook(bars, {
                oscillatorStepMs: numberOf(params, 'oscillatorMinutes') * 60_000,
                oscillator: {
                    emaLength: numberOf(params, 'emaLength'),
                    atrLength: numberOf(params, 'atrLength'),
                    atrMultiple: numberOf(params, 'atrMultiple'),
                    smoothing: numberOf(params, 'smoothing'),
                    level: numberOf(params, 'level'),
                    fromMin: numberOf(params, 'oscillatorFromMin'),
                    toMin: numberOf(params, 'oscillatorToMin'),
                    zone: PHASE_OSCILLATOR_DEFAULTS.zone,
                },
                cell: {
                    cellStartMin: numberOf(params, 'cellStartMin'),
                    cellEndMin: numberOf(params, 'cellEndMin'),
                    triggerEndMin: numberOf(params, 'triggerEndMin'),
                    returnEndMin: numberOf(params, 'returnEndMin'),
                    sigmaDays: numberOf(params, 'sigmaDays'),
                    bandSigma: numberOf(params, 'bandSigma'),
                    zone: TIME_BASED_RANGE_DEFAULTS.zone,
                },
            })
        ));

        const clock: BarClock = detection.clock;

        return {
            params,
            events: { signals: detection.signals, crosses: detection.crosses },

            onBar(ctx) {
                const trade = ctx.state.trade as OpenTrade | undefined;

                if (trade) {
                    const late = clock.closeMinutes[ctx.index]! >= trade.exitMin;
                    const nextSession = clock.days[ctx.index] !== trade.day;
                    if (late || nextSession) {
                        if (!ctx.isFlat) ctx.close(late ? 'flat-at' : 'session-end');
                        ctx.state.trade = undefined;
                        return;
                    }

                    /* Only the oscillator's trade answers to a crossing, and only to close.
                     * The book takes no second entry that morning, so there is no reversal
                     * here — that is the one rule the standalone oscillator sleeve has and
                     * this one does not. */
                    if (trade.source === 'oscillator') {
                        const opposite = ctx.events<PhaseOscillatorCross>('crosses')
                            .find((c) => c.direction !== trade.direction);
                        if (opposite) {
                            if (!ctx.isFlat) ctx.close('opposite-cross');
                            ctx.state.trade = undefined;
                        }
                    }
                    return;
                }

                const waiting = ctx.state.waiting as Waiting | undefined;
                if (waiting) {
                    if (clock.days[ctx.index] !== waiting.day) {
                        ctx.state.waiting = undefined;
                    } else if (gaveItBack(ctx.bar.close, waiting.stop, waiting.direction)) {
                        ctx.state.waiting = undefined;
                    } else if (clock.closeMinutes[ctx.index]! >= cellEntryFromMin) {
                        ctx.state.waiting = undefined;
                        send(ctx, waiting.direction, waiting.day, waiting.stop, 'cell');
                    }
                    return;
                }

                const arriving = ctx.events<MorningBookSignal>('signals');
                if (arriving.length === 0) return;
                const signal = arriving[0]!;
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                if (signal.source === 'oscillator') {
                    send(ctx, signal.direction, signal.day, null, 'oscillator');
                    return;
                }

                const stop = signal.stop;
                // A cell signal without a level is not a cell signal; nothing to stop against.
                if (stop == null) return;
                if (gaveItBack(ctx.bar.close, stop, signal.direction)) return;

                if (clock.closeMinutes[ctx.index]! >= cellEntryFromMin) {
                    send(ctx, signal.direction, signal.day, stop, 'cell');
                } else {
                    ctx.state.waiting = { day: signal.day, direction: signal.direction, stop } satisfies Waiting;
                }
            },
        };

        /** Places a ticket for whichever engine won, sized the way that engine sizes. */
        function send(
            ctx: Parameters<RunnableStrategy<StrategyParams>['onBar']>[0],
            direction: 'long' | 'short',
            day: string,
            stop: number | null,
            source: 'oscillator' | 'cell',
        ): void {
            const long = direction === 'long';
            const price = ctx.bar.close;

            const size = stop == null
                // No stop, so no risk distance: the ceiling is the size.
                ? (ctx.equity > 0 && price > 0 ? (ctx.equity * maxLeverage) / price : null)
                : positionSize(ctx.equity, price, stop, riskMode, riskValue, cap);
            if (size == null || !(size > 0)) return;

            ctx.order({
                side: long ? 'buy' : 'sell',
                type: 'market',
                size,
                bracket: stop == null ? null : { stopLoss: stop },
                tag: day,
            });
            ctx.state.trade = {
                day,
                source,
                direction,
                exitMin: source === 'cell' ? cellExitMin : oscillatorExitMin,
            } satisfies OpenTrade;
        }
    },
};
