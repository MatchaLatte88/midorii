import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    RSI_DIP_DEFAULTS,
    detectRsiDip,
    type RsiDipSignal,
} from '../../../src/core/analysis/rsiDip';
import type { BarClock } from '../../../src/core/analysis/barClock';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * RSI(2) Dip, two-session hold — buy the oversold pullback inside an uptrend, hold it two
 * sessions, sell on the clock.
 *
 * What this implements
 * --------------------
 * The outright-futures version of a sleeve measured on index-ETF calls: RSI(2) below 10 with
 * the close above its 200-day average, bought the next morning and sold at 14:50 on the second
 * session after entry. Long only — it is a dip-buying strategy, and the published version
 * never takes the mirror image.
 *
 * The published ES measurement is 48 trades from 2022 to September 2026, 62% winners, profit
 * factor 1.99. That is roughly ten trades a year, which is the first thing to know about it:
 * no amount of profit factor makes thirteen trades in a year mean much, and the source itself
 * ranks this sleeve provisional and notes that the wide-universe version of it lost money.
 *
 * The part that does not translate cleanly, stated plainly
 * -------------------------------------------------------
 * The original reads the signal off an ETF and trades the future that tracks it — SPY into ES,
 * QQQ into NQ, IWM into RTY. A backtest here sees ONE instrument, so there is no second symbol
 * to read the signal from, and the cross-symbol version is not faked: what this does is fold
 * the future's own cash-session bars into daily ones and read RSI(2) and the 200-day average
 * off those.
 *
 * That is deliberately not the same thing, and the difference is worth knowing before
 * comparing a result to the published one. The cash-hours fold removes the biggest source of
 * error — a 23-hour daily bar contains an overnight the ETF never traded — but the future and
 * the ETF still part company over dividends, over the basis, and, for a 200-day average
 * especially, over the ratio adjustment that splices a continuous contract together. Feeding
 * this the ETF's own bars is what removes the approximation; running it on the future is an
 * approximation that knows it is one.
 *
 * Sessions, not days, and no half-day calendar
 * --------------------------------------------
 * The hold is counted in sessions the data actually has, so a weekend or a holiday costs
 * nothing. The published rule closes at 11:50 instead of 14:50 on a half day; there is no
 * holiday calendar here, so a half day is handled by the backstop rather than by the rule —
 * the position comes off when the next session arrives. That is later than the sleeve would
 * have, on a handful of sessions a year.
 */

const SIGNAL_PARAMS: readonly StrategyParam[] = [
    {
        key: 'rsiLength',
        label: 'RSI length',
        type: 'number',
        default: RSI_DIP_DEFAULTS.rsiLength,
        min: 2,
        max: 50,
        step: 1,
        hint: 'How many daily bars the RSI covers. 2 is the published setting and the reason '
            + 'the signal is frequent enough to be worth a filter — two down days drive it into '
            + 'the teens.',
    },
    {
        key: 'rsiThreshold',
        label: 'RSI below',
        type: 'number',
        default: RSI_DIP_DEFAULTS.rsiThreshold,
        min: 1,
        max: 50,
        step: 1,
        hint: 'How deep the dip has to be. Lower takes fewer and deeper pullbacks.',
    },
    {
        key: 'smaLength',
        label: 'Trend average',
        type: 'number',
        default: RSI_DIP_DEFAULTS.smaLength,
        min: 5,
        max: 500,
        step: 5,
        hint: 'Length of the simple moving average the close has to be above. This is the half '
            + 'of the signal that separates a pullback from a market going down, and without it '
            + 'the strategy buys the collapses too.',
    },
    {
        key: 'sessionFromMin',
        label: 'Cash session from',
        type: 'time',
        default: RSI_DIP_DEFAULTS.sessionFromMin,
        hint: 'Start of the window each daily bar is folded from, on a Central-Time clock. It is '
            + 'the cash session rather than the whole 23-hour day, because the signal this '
            + 'reproduces was read off an ETF that only traded those hours.',
    },
    {
        key: 'sessionToMin',
        label: 'Cash session until',
        type: 'time',
        default: RSI_DIP_DEFAULTS.sessionToMin,
        hint: 'End of that window, exclusive. Its last bar is where the signal becomes known.',
    },
    {
        key: 'entryMin',
        label: 'Entry at',
        type: 'time',
        default: 9 * 60 + 1,
        hint: 'When the ticket goes in on the session after the signal. 09:01 Central is the '
            + 'published figure — half an hour into the cash session, which is where the ETF '
            + 'options the original traded have a spread worth crossing. On futures an earlier '
            + 'time is defensible; the source does not say which was measured.',
    },
    {
        key: 'holdSessions',
        label: 'Sessions held',
        type: 'number',
        default: 2,
        min: 1,
        max: 20,
        step: 1,
        hint: 'How many sessions after the entry one the position comes off. 2 is the published '
            + 'hold. Counted in sessions the data has, so weekends and holidays cost nothing.',
    },
    {
        key: 'exitMin',
        label: 'Flat at',
        type: 'time',
        default: 14 * 60 + 50,
        hint: 'When it comes off on that session. The close is ordered on the bar completing at '
            + 'this time and fills at the next bar open.',
    },
];

/** What changes which dips EXIST. The entry time, the hold and the exit change what is done
 *  with one. */
const DETECTION_KEYS = [
    'rsiLength', 'rsiThreshold', 'smaLength', 'sessionFromMin', 'sessionToMin',
] as const;

/** A signal waiting for its entry session, or the trade that came of it. */
interface Waiting {
    signalDay: string;
}

interface OpenTrade {
    entryDay: string;
    /** Sessions seen since the entry one. The exit is due once it reaches the hold. */
    sessionsHeld: number;
    /** The day counted most recently, so one session is not counted twice. */
    lastDay: string;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`rsidip: ${key} must be a number`);
    return value;
}

export const RSI_DIP_STRATEGY: StrategySpec = {
    id: 'rsidip',
    name: 'RSI(2) Dip, Two-Session Hold',
    description: 'Buys the session after RSI(2) closes below 10 while price holds above its '
        + '200-day average, and sells on the clock two sessions later. Long only, no stop.',
    rules: {
        conditions: [
            'On the last completed daily bar, RSI(2) closed below the threshold AND the close '
            + 'was above the 200-day average. Both halves are needed: the first finds a dip, '
            + 'the second says it is a dip and not a decline.',
            'The daily bars are folded from the cash-session window, not from the whole 23-hour '
            + 'day, so the reading is close to the one the cash market it tracks would give.',
            'Both averages have enough history — nothing is read until the 200-day average '
            + 'exists, which takes 200 sessions of data.',
            'Nothing is already on. A signal arriving during a hold is passed over rather than '
            + 'queued, which is the one-position-per-name rule of the original.',
        ],
        entry: 'A market order on the bar completing at the entry time on the session AFTER the '
            + 'signal, filling at the next bar open. Long only — the published sleeve buys dips '
            + 'and never sells rallies.',
        stop: 'None. On the original this is safe by construction, because it buys a call and '
            + 'the premium is the whole risk. On an outright future it is not: the loss is '
            + 'bounded only by where the market is two sessions later, which is the single '
            + 'biggest difference between this translation and the sleeve it comes from.',
        target: 'The clock — 14:50 on the second session after entry. There is no price target '
            + 'and no reward-to-risk, because the trade is a bet on a stretch of time rather '
            + 'than on a level.',
        size: 'With no stop there is no risk distance to divide by, so the position is sized at '
            + 'the leverage ceiling and Max leverage is the size control.',
    },
    params: [...RISK_PARAMS, ...SIGNAL_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const maxLeverage = numberOf(params, 'maxLeverage');
        const entryMin = numberOf(params, 'entryMin');
        const exitMin = numberOf(params, 'exitMin');
        const holdSessions = numberOf(params, 'holdSessions');

        const detection = cached(cache, detectionCacheKey('rsidip', params, DETECTION_KEYS), () => (
            detectRsiDip(bars, {
                rsiLength: numberOf(params, 'rsiLength'),
                rsiThreshold: numberOf(params, 'rsiThreshold'),
                smaLength: numberOf(params, 'smaLength'),
                sessionFromMin: numberOf(params, 'sessionFromMin'),
                sessionToMin: numberOf(params, 'sessionToMin'),
                zone: RSI_DIP_DEFAULTS.zone,
            })
        ));

        const clock: BarClock = detection.clock;

        return {
            params,
            events: { dips: detection.signals },

            onBar(ctx) {
                const day = clock.days[ctx.index]!;
                const trade = ctx.state.trade as OpenTrade | undefined;

                if (trade) {
                    if (day !== trade.lastDay) {
                        trade.sessionsHeld += 1;
                        trade.lastDay = day;
                    }
                    /* Due once the hold is served and the clock has come round. The second
                     * condition is the backstop for a session whose exit bar is missing — a
                     * half day, a halt — where waiting for a time that never arrives would
                     * hold the position indefinitely. */
                    const due = trade.sessionsHeld >= holdSessions;
                    const late = due && clock.closeMinutes[ctx.index]! >= exitMin;
                    const overdue = trade.sessionsHeld > holdSessions;
                    if (late || overdue) {
                        if (!ctx.isFlat) ctx.close(late ? 'flat-at' : 'session-end');
                        ctx.state.trade = undefined;
                    }
                    return;
                }

                const waiting = ctx.state.waiting as Waiting | undefined;
                if (waiting) {
                    // The entry session is the next one, so nothing happens on the signal's own.
                    if (day === waiting.signalDay) return;
                    if (clock.closeMinutes[ctx.index]! < entryMin) return;

                    ctx.state.waiting = undefined;
                    const price = ctx.bar.close;
                    const size = ctx.equity > 0 && price > 0
                        ? (ctx.equity * maxLeverage) / price
                        : null;
                    if (size == null || !(size > 0)) return;

                    ctx.order({ side: 'buy', type: 'market', size, tag: waiting.signalDay });
                    ctx.state.trade = { entryDay: day, sessionsHeld: 0, lastDay: day } satisfies OpenTrade;
                    return;
                }

                const arriving = ctx.events<RsiDipSignal>('dips');
                if (arriving.length === 0) return;
                if (!ctx.isFlat || ctx.pendingOrders.length > 0) return;

                ctx.state.waiting = { signalDay: arriving[0]!.day } satisfies Waiting;
            },
        };
    },
};
