import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    PHASE_OSCILLATOR_DEFAULTS,
    detectPhaseOscillator,
    type PhaseOscillatorCross,
} from '../../../src/core/analysis/phaseOscillator';
import type { BarClock } from '../../../src/core/analysis/barClock';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Phase-Oscillator ±100 Cross — the morning's first commitment, held until the market says
 * the opposite or the clock runs out.
 *
 * What this implements
 * --------------------
 * The outright-futures version of a sleeve measured on index options: a long the moment
 * Saty's phase oscillator crosses above +100 on a completed bar in the morning window, a
 * short when it crosses below −100, out on the opposite cross or on the clock. The published
 * measurement is one NQ contract from 2022 to September 2026 — 242 trades, 64% winners,
 * profit factor 2.19 — and the same signal on ES, which was parked there over a missing hour
 * in the data rather than over anything the strategy did.
 *
 * The original trades same-day index options. That version cannot be run here and is not
 * approximated: it needs an option chain, minute quotes on the premium, and an exit that
 * fires at a dollar gain on a contract. What carries over is the signal and the two exits,
 * which is exactly what the outright-futures translation is.
 *
 * A strategy with no stop, and why that is the measurement
 * -------------------------------------------------------
 * There is no stop. That is not an omission — the source reports that six stop-loss and
 * time-stop variants were tested on this sleeve and every one of them gave back profit, so
 * none was kept. The sleeve lives on a handful of very large winners; a stop cuts exactly
 * those. Sizing therefore has no risk distance to divide by, and Max leverage becomes the
 * size control, as it is for any strategy here that exits on the clock rather than at a
 * price.
 *
 * That has a consequence worth saying plainly: the loss on one trade is bounded only by how
 * far the market travels before the opposite cross or the close. A run of this against a
 * funded account's trailing limit is the interesting question, not the profit factor.
 *
 * The opposite cross is an exit and an entry at once
 * --------------------------------------------------
 * The two rules — cross up, buy; cross down, sell — do not stop applying because a position
 * is open. A cross that closes a long inside the morning window is also that window's signal
 * to be short, so the position reverses in ONE order sized to close the old trade and open
 * the new one. Splitting it into a close and an entry would leave two market orders racing
 * for the same bar's open, and the broker would net them in whatever sequence they were
 * matched.
 *
 * After the window closes, the same cross is exit-only: it ends the trade and nothing takes
 * its place, because the strategy has one morning in which it is allowed to have an opinion.
 *
 * Getting flat is ordered a bar early
 * -----------------------------------
 * An order never fills on the bar that placed it, so the close is ordered on the bar that
 * COMPLETES at the exit time and fills at the next bar's open — which is the exit time. That
 * is what makes the setting read as a wall clock instead of as a bar offset, and it is why
 * the windows in this file are matched against bar closes rather than bar opens.
 *
 * Where the timeframe comes in
 * ----------------------------
 * The measured version reads 10-minute bars, and the oscillator's averages are the chart's
 * own, so a run on another timeframe is a different signal wearing the same name. Nothing
 * here resamples: the bars a run is given are the bars the oscillator is built on, so the
 * timeframe is chosen where every other chart decision is, and 10m is what reproduces the
 * published figures.
 */

/** What the oscillator is built from, and when it is allowed to speak. */
const SIGNAL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'emaLength',
        label: 'EMA length',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.emaLength,
        min: 2,
        max: 200,
        step: 1,
        hint: 'The moving average the distance from the mean is measured against. 21 is Saty '
            + 'published setting and what the measured sleeve uses.',
    },
    {
        key: 'atrLength',
        label: 'ATR length',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.atrLength,
        min: 2,
        max: 200,
        step: 1,
        hint: 'How many bars the Wilder average true range covers. This is the chart timeframe '
            + 'ATR, not a daily one — on 10-minute bars it is 14 ten-minute ranges.',
    },
    {
        key: 'atrMultiple',
        label: 'ATRs per 100',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.atrMultiple,
        min: 0.5,
        max: 20,
        step: 0.5,
        hint: 'How many average ranges from the mean a reading of 100 stands for. It sets the '
            + 'scale of the whole oscillator, so raising it makes every level harder to reach '
            + 'and takes fewer trades.',
    },
    {
        key: 'smoothing',
        label: 'Smoothing',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.smoothing,
        min: 1,
        max: 50,
        step: 1,
        hint: 'Length of the EMA applied to the finished oscillator. 1 switches smoothing off '
            + 'and makes the crossings noticeably more frequent.',
    },
    {
        key: 'level',
        label: 'Cross level',
        type: 'number',
        default: PHASE_OSCILLATOR_DEFAULTS.level,
        min: 10,
        max: 500,
        step: 10,
        hint: 'The reading whose crossing is the signal, taken plus and minus. 100 is the '
            + 'oscillator own "extended" mark and the level the sleeve was measured at.',
    },
    {
        key: 'fromMin',
        label: 'Signals from',
        type: 'time',
        default: PHASE_OSCILLATOR_DEFAULTS.fromMin,
        hint: 'Earliest bar CLOSE that may fire an entry, on a Central-Time clock. Stated as a '
            + 'close rather than an open so it means the same thing on any timeframe: the '
            + 'first ticket goes in one bar later, at that bar open.',
    },
    {
        key: 'toMin',
        label: 'Signals until',
        type: 'time',
        default: PHASE_OSCILLATOR_DEFAULTS.toMin,
        hint: 'Latest bar close that may fire an entry, inclusive. After it, a cross can still '
            + 'close an open position but can no longer open one.',
    },
    {
        key: 'exitMin',
        label: 'Flat at',
        type: 'time',
        default: 14 * 60 + 50,
        hint: 'When an unclosed position comes off, on a Central-Time clock. The close is '
            + 'ordered on the bar completing at this time and fills at the next bar open, so '
            + 'the fill lands on the clock. 14:50 leaves room before the 14:55 expiry close '
            + 'the options version of this sleeve is bound by.',
    },
];

/**
 * The settings that change which crossings EXIST. `exitMin` is not among them: it changes
 * when a trade ends, not whether the market crossed anything, so a sweep of it reuses one
 * detection.
 */
const DETECTION_KEYS = [
    'emaLength', 'atrLength', 'atrMultiple', 'smoothing', 'level', 'fromMin', 'toMin',
] as const;

/** What the strategy remembers between bars: the trade it has on, and the session it belongs
 *  to. Cleared the moment a close is ordered, so the order is never placed twice. */
interface OpenTrade {
    day: string;
    direction: 'long' | 'short';
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`phaseoscillator: ${key} must be a number`);
    return value;
}

/** Contracts for a strategy with no stop: everything the leverage ceiling allows. */
function ceilingSize(equity: number, price: number, maxLeverage: number): number | null {
    if (!(equity > 0) || !(price > 0)) return null;
    const size = (equity * maxLeverage) / price;
    return size > 0 ? size : null;
}

export const PHASE_OSCILLATOR_STRATEGY: StrategySpec = {
    id: 'phaseoscillator',
    name: 'Phase-Oscillator ±100 Cross',
    description: 'Buys the morning bar that closes with Saty phase oscillator crossing above '
        + '+100 and sells the one that crosses below −100. No stop: the trade ends on the '
        + 'opposite cross, or on the clock.',
    rules: {
        conditions: [
            'A completed bar whose oscillator crossed the level, having been on the other side '
            + 'of it on the bar before. Staying beyond the level is not a crossing, so one '
            + 'extended stretch of market fires once rather than on every bar of it.',
            'The bar closed inside the morning signal window, read on a Central-Time clock. A '
            + 'cross outside the window can still end a trade but cannot start one.',
            'Both averages have warmed up — the oscillator does not exist over the first bars '
            + 'of the data, and a crossing cannot be read from a value that is not there.',
            'One position at a time. A cross in the direction already held adds nothing.',
        ],
        entry: 'A market order on the bar that completed the crossing, filling at the next bar '
            + 'open. Where the cross reverses a position and the window is still open, one '
            + 'order does both jobs: it is sized to close the trade that is on and open the '
            + 'opposite one, so a reversal is a single fill rather than two racing for the same '
            + 'open.',
        stop: 'None, and that is the measurement rather than an omission: six stop and '
            + 'time-stop variants were tested on the sleeve this follows and every one gave '
            + 'back profit, because the result lives on a few very large winners. The loss on a '
            + 'trade is therefore bounded only by the opposite cross or the clock.',
        target: 'The opposite cross, or the flat-at time, whichever comes first — never a '
            + 'price. The reward-to-risk setting is unused here: with no stop there is no risk '
            + 'distance to take a multiple of, and inventing one would be a different strategy '
            + 'from the one measured.',
        size: 'With no stop there is no risk distance to divide by, so the position is sized at '
            + 'the leverage ceiling and Max leverage is the size control. Risk per trade does '
            + 'not enter into it.',
    },
    params: [...RISK_PARAMS, ...SIGNAL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const maxLeverage = numberOf(params, 'maxLeverage');
        const exitMin = numberOf(params, 'exitMin');

        const detection = cached(cache, detectionCacheKey('phaseoscillator', params, DETECTION_KEYS), () => (
            detectPhaseOscillator(bars, {
                emaLength: numberOf(params, 'emaLength'),
                atrLength: numberOf(params, 'atrLength'),
                atrMultiple: numberOf(params, 'atrMultiple'),
                smoothing: numberOf(params, 'smoothing'),
                level: numberOf(params, 'level'),
                fromMin: numberOf(params, 'fromMin'),
                toMin: numberOf(params, 'toMin'),
                zone: PHASE_OSCILLATOR_DEFAULTS.zone,
            })
        ));

        const clock: BarClock = detection.clock;

        return {
            params,
            events: { crosses: detection.crosses },

            onBar(ctx) {
                const trade = ctx.state.trade as OpenTrade | undefined;

                if (trade) {
                    /* Two ways the clock ends a trade. The second is a backstop rather than a
                     * rule: a session whose exit bar is missing from the data would otherwise
                     * carry the position into the next one, which this strategy never holds. */
                    const late = clock.closeMinutes[ctx.index]! >= exitMin;
                    const nextSession = clock.days[ctx.index] !== trade.day;
                    if (late || nextSession) {
                        if (!ctx.isFlat) ctx.close(late ? 'flat-at' : 'session-end');
                        ctx.state.trade = undefined;
                        return;
                    }
                }

                const arriving = ctx.events<PhaseOscillatorCross>('crosses');
                if (arriving.length === 0) return;
                // One bar cannot cross both levels: the last one is the only one there is.
                const cross = arriving[arriving.length - 1]!;
                const long = cross.direction === 'long';

                if (trade) {
                    // A cross the way the position already points says nothing new.
                    if (trade.direction === cross.direction) return;

                    if (!cross.inEntryWindow) {
                        if (!ctx.isFlat) ctx.close('opposite-cross');
                        ctx.state.trade = undefined;
                        return;
                    }

                    /* Inside the window the same cross is also the signal to be the other way
                     * round, so one order closes what is on and opens the opposite — see the
                     * header for why this is not a close followed by an entry. */
                    const held = Math.abs(ctx.position?.size ?? 0);
                    const fresh = ceilingSize(ctx.equity, ctx.bar.close, maxLeverage);
                    if (fresh == null) {
                        if (!ctx.isFlat) ctx.close('opposite-cross');
                        ctx.state.trade = undefined;
                        return;
                    }

                    ctx.order({
                        side: long ? 'buy' : 'sell',
                        type: 'market',
                        size: held + fresh,
                        tag: cross.day,
                    });
                    ctx.state.trade = { day: cross.day, direction: cross.direction } satisfies OpenTrade;
                    return;
                }

                // Nothing on, and nothing on its way in: a fresh signal can be taken.
                if (!cross.inEntryWindow) return;
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                const size = ceilingSize(ctx.equity, ctx.bar.close, maxLeverage);
                if (size == null) return;

                ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'market',
                    size,
                    tag: cross.day,
                });
                ctx.state.trade = { day: cross.day, direction: cross.direction } satisfies OpenTrade;
            },
        };
    },
};
