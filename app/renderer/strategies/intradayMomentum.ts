import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    INTRADAY_WINDOWS_DEFAULTS,
    detectIntradayWindows,
    type DayBoundaryId,
    type IntradayWindows,
} from '../../../src/core/analysis/intradayWindows';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * Intraday Session Momentum — the early part of a day used to bet on its last part.
 *
 * What this implements
 * --------------------
 * Shen, Urquhart & Wang, *Bitcoin intraday time-series momentum* (Financial Review, 2022),
 * which carries Gao, Han, Li & Zhou's equity finding into a market that never closes. Two
 * signals, and they point in opposite directions — that is not a quirk, it is the result:
 *
 *   signal   the move from the previous day's close to mid-morning predicts the last window
 *            POSITIVELY. Momentum. Annualised 7.8% in the paper.
 *   confirm  the window immediately before the last one predicts it NEGATIVELY. A reversal,
 *            not momentum at all — and the stronger of the two, at 17.3%.
 *   both     long only when the day trended up early AND gave some of it back just before the
 *            close; short on the mirror image. 16.7%, and the default here because it is the
 *            only one of the three that requires the two independent effects to agree.
 *
 * The benchmark those beat is an always-long position in the same window, at 6.5%.
 *
 * The honest problem with it
 * --------------------------
 * The paper's own break-even transaction costs are 3, 7 and 10 basis points for the three
 * strategies, against the 25 bp Bitstamp charged over its sample. On those numbers the edge
 * does not survive its own fees, and the paper says so. It then argues the case back with
 * leverage, which does not obviously work: fees and profits both scale with notional, so
 * break-even costs measured in basis points of notional should not move with leverage at all.
 *
 * What HAS changed is the fee: a perpetual on a major venue is around 4.5 bp taker today,
 * roughly a fifth of the paper's assumption. That was the reason to measure it again rather
 * than to trust it — and measuring it settles the question in the other direction.
 *
 * Measured on BTCUSDT 5m, 2022-2025 (420k bars, 1,460 days), the direction of every published
 * finding reproduces and the SIZE of it does not:
 *
 *   default windows, both signals agreeing   54.0% hit rate, +0.86 bp per trade
 *   the same, traded at 4.5 bp taker fees    -51.9% over four years, negative every year
 *
 * Under 1 bp of edge against 9 bp of round-trip cost is not marginal, it is hopeless, and no
 * window length or day boundary tried rescues it. The paper's own break-even was around 10 bp
 * per trade — an order of magnitude above what this market now pays out — so the honest
 * reading is that the effect has decayed, not merely that fees ate it.
 *
 * The strategy is kept because the measurement is worth being able to repeat, and because the
 * two directional findings DID hold up and are reusable: cutting the day at the CME close
 * beats cutting it at UTC midnight, and the early window only predicts anything when it ends
 * mid-morning New York — 10:00 is the single window out of six tried with positive
 * predictability, which is exactly the paper's claim that the flow, not the clock, is what
 * makes a window informative. Anyone building on this should start from those two facts and
 * not from the returns.
 *
 * Why the windows are settings and not constants
 * ----------------------------------------------
 * The same paper finds the predictability is strongest when the early window is the one with
 * the highest volume or volatility, and it picks each exchange's opening from where volume
 * actually spikes. In other words the window is not a constant of the market, it is a property
 * of where the flow is — which moves as venues and participants change. So every boundary is a
 * parameter, including where the day is cut, and the interesting question is not what the
 * defaults do but what a sweep over them says. `mode` and the stop deliberately sit outside
 * `detectionKeys` so a sweep over the windows and one over how they are traded stay cheap.
 *
 * Sizing, with and without a stop
 * -------------------------------
 * The paper holds a directional position for a fixed window and exits on the clock; it has no
 * stop, and with none there is no risk distance to divide by. So `stopAtrPct` at 0 — the
 * default, and the faithful reading — sizes the position at the leverage ceiling, and
 * `maxLeverage` is the size control. Above 0 there is a real stop a fixed share of the daily
 * ATR from the fill, and sizing goes back to the usual risk-per-trade rule every other strategy
 * uses.
 */

const BOUNDARY_OPTIONS = [
    { value: 'cme', label: 'CME close (17:00 New York)' },
    { value: 'utc', label: 'UTC midnight' },
] as const;

const MODE_OPTIONS = [
    { value: 'both', label: 'Both must agree' },
    { value: 'signal', label: 'Early move only' },
    { value: 'confirm', label: 'Late reversal only' },
] as const;

const WINDOW_PARAMS: readonly StrategyParam[] = [
    {
        key: 'boundary',
        label: 'Day ends at',
        type: 'select',
        default: INTRADAY_WINDOWS_DEFAULTS.boundary,
        hint: 'Where one trading day stops and the next starts. This is the most consequential '
            + 'setting here — every window is measured from it. 17:00 New York is the hour CME '
            + 'Bitcoin futures pause for and what the research uses; UTC midnight is where daily '
            + 'crypto candles are cut everywhere else. Which one is right is an empirical '
            + 'question, so it is worth running both.',
        options: BOUNDARY_OPTIONS,
    },
    {
        key: 'signalEndMin',
        label: 'Early window ends at',
        type: 'number',
        default: INTRADAY_WINDOWS_DEFAULTS.signalEndMin,
        min: 0,
        max: 1439,
        step: 30,
        hint: 'Minutes past local midnight, in the day boundary\'s own zone, where the early '
            + 'window ends. 600 is 10:00 — half an hour after the US cash open, which is where '
            + 'the research puts it. Everything from the previous close up to this point is one '
            + 'number: what happened before the day could be acted on.',
    },
    {
        key: 'tradeMinutes',
        label: 'Traded window',
        type: 'number',
        default: INTRADAY_WINDOWS_DEFAULTS.tradeMinutes,
        min: 5,
        max: 720,
        step: 30,
        hint: 'How many minutes at the end of the day are traded. 30 is the research figure. It '
            + 'must cover at least two chart bars, since a position cannot be opened and closed '
            + 'on the same one.',
    },
    {
        key: 'confirmMinutes',
        label: 'Late window',
        type: 'number',
        default: INTRADAY_WINDOWS_DEFAULTS.confirmMinutes,
        min: 0,
        max: 720,
        step: 30,
        hint: 'How many minutes immediately before the traded window form the second signal. '
            + 'This one predicts the traded window NEGATIVELY — it is a reversal, and in the '
            + 'research the stronger of the two effects. 0 switches it off, which also disables '
            + 'the modes that read it.',
    },
    {
        key: 'mode',
        label: 'Signal',
        type: 'select',
        default: 'both',
        hint: 'Which of the two effects has to speak. "Both must agree" takes a position only '
            + 'when the early move and the late reversal point the same way, which is the '
            + 'strictest reading and takes the fewest trades. The other two trade one effect on '
            + 'its own.',
        options: MODE_OPTIONS,
    },
    {
        key: 'stopAtrPct',
        label: 'Stop, as % of daily ATR',
        type: 'number',
        default: 0,
        min: 0,
        max: 200,
        step: 5,
        hint: 'How far a stop sits from the fill, as a percentage of the average daily range. 0 '
            + 'is the researched strategy, which has no stop at all: it holds the window out and '
            + 'exits on the clock, and the position is then sized at the leverage ceiling rather '
            + 'than off a risk distance that does not exist. Above 0 there is a real stop and '
            + 'the usual risk-per-trade sizing applies.',
    },
    {
        key: 'atrDays',
        label: 'ATR days',
        type: 'number',
        default: INTRADAY_WINDOWS_DEFAULTS.atrDays,
        min: 1,
        max: 200,
        step: 1,
        hint: 'How many previous days the daily ATR averages over, for the stop above. Read from '
            + 'the days before this one, never including today.',
    },
];

/** The settings that change which days EXIST and what the windows measure. `mode` and
 *  `stopAtrPct` are out: they change what is done with a day, not what the day was. */
const DETECTION_KEYS = ['boundary', 'signalEndMin', 'tradeMinutes', 'confirmMinutes', 'atrDays'] as const;

type SignalMode = 'both' | 'signal' | 'confirm';

/** What the strategy remembers between bars: the bar the open position comes off on. */
interface OpenTrade {
    exitIndex: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`intradaymomentum: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`intradaymomentum: ${key} must be a string`);
    return value;
}

/**
 * Which way to trade a day, or null to stand aside.
 *
 * The sign convention is the whole strategy: the early move is followed, the late one is
 * faded. A version that treated both as momentum would be trading against the stronger of the
 * two published effects.
 */
function directionOf(day: IntradayWindows, mode: SignalMode): 'long' | 'short' | null {
    const early = day.signalReturn;
    const late = day.confirmReturn;

    if (mode === 'signal') {
        if (early == null || early === 0) return null;
        return early > 0 ? 'long' : 'short';
    }
    if (mode === 'confirm') {
        if (late == null || late === 0) return null;
        // Faded, not followed.
        return late < 0 ? 'long' : 'short';
    }
    if (early == null || late == null || early === 0 || late === 0) return null;
    if (early > 0 && late < 0) return 'long';
    if (early < 0 && late > 0) return 'short';
    // The two disagree, which the research reads as no position rather than a weaker one.
    return null;
}

export const INTRADAY_MOMENTUM_STRATEGY: StrategySpec = {
    id: 'intradaymomentum',
    name: 'Intraday Session Momentum',
    description: 'Bets the last window of the day on what the day did earlier: the early move '
        + 'followed, the window just before the close faded. Enters at market, exits on the '
        + 'clock.',
    rules: {
        conditions: [
            'The trading day has a complete traded window, and at least one bar before it to '
            + 'act on.',
            'The early window — from the previous day\'s close to mid-morning — is complete and '
            + 'moved one way or the other.',
            'The late window, immediately before the traded one, is complete. On the default '
            + 'setting both windows have to point the same way, the early one up and the late '
            + 'one down for a long; a day where they disagree is not traded.',
            'One position per day: it is opened once and not re-entered after it closes.',
        ],
        entry: 'A market order on the last bar before the traded window, filling at that '
            + 'window\'s opening price. There is no level to rest an order at — the decision is '
            + 'about a stretch of time, not a price, so the position simply goes on when the '
            + 'window opens.',
        stop: 'None by default, which is the researched strategy: the trade is a bet on one '
            + 'window and the clock ends it. A stop a fixed share of the daily ATR from the fill '
            + 'can be switched on, and is then measured from the actual fill rather than from a '
            + 'planned price.',
        target: 'The end of the traded window, on the clock rather than at a price. The '
            + 'reward-to-risk setting is therefore unused here — there is no price target to '
            + 'place, and inventing one would be a different strategy from the one measured.',
        size: 'With no stop there is no risk distance to divide by, so the position is sized at '
            + 'the leverage ceiling and Max leverage is the size control. With a stop switched '
            + 'on, sizing returns to the usual rule: risk per trade divided by the distance to '
            + 'the stop.',
    },
    params: [...RISK_PARAMS, ...WINDOW_PARAMS],
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
        const stopAtrPct = numberOf(params, 'stopAtrPct');
        const mode = stringOf(params, 'mode') as SignalMode;
        const confirmMinutes = numberOf(params, 'confirmMinutes');

        /* Said out loud rather than silently taking no trades: with no late window there is no
         * second signal, and both modes that read one would stand aside on every single day. */
        if (confirmMinutes === 0 && mode !== 'signal') {
            throw new Error(
                `intradaymomentum: mode "${mode}" reads the late window, but Late window is 0. `
                + 'Give it a length, or switch the signal to "Early move only".',
            );
        }

        const days = cached(cache, detectionCacheKey('intradaymomentum', params, DETECTION_KEYS), () => (
            detectIntradayWindows(bars, {
                boundary: stringOf(params, 'boundary') as DayBoundaryId,
                signalEndMin: numberOf(params, 'signalEndMin'),
                tradeMinutes: numberOf(params, 'tradeMinutes'),
                confirmMinutes,
                atrDays: numberOf(params, 'atrDays'),
            })
        ));

        return {
            params,
            events: { windows: days },

            onBar(ctx) {
                const open = ctx.state.trade as OpenTrade | undefined;
                if (open) {
                    if (ctx.index < open.exitIndex) return;
                    /* Ordered one bar before the window ends so it fills on the last one — an
                     * order never fills on the bar that placed it, and a close asked for on the
                     * final bar would fill tomorrow. A stop may already have ended the trade. */
                    if (!ctx.isFlat) ctx.close('window-close');
                    ctx.state.trade = undefined;
                }

                const arriving = ctx.events<IntradayWindows>('windows');
                if (arriving.length === 0) return;
                const day = arriving[0]!;

                /* The window has to hold at least two bars: one to open the position on and a
                 * later one to close it. A single-bar window would leave a position that
                 * nothing in this day could exit. */
                if (day.tradeEndIndex <= day.tradeStartIndex) return;

                const direction = directionOf(day, mode);
                if (direction == null) return;

                const long = direction === 'long';
                const price = ctx.bar.close;
                if (!(price > 0)) return;

                let size: number | null;
                let stopDistance: number | null = null;

                if (stopAtrPct > 0) {
                    if (day.atr == null) return;
                    stopDistance = day.atr * (stopAtrPct / 100);
                    if (!(stopDistance > 0)) return;
                    /* Sized off this bar's close, which is the last price known before the
                     * market order goes in — the same information a person would have. */
                    size = positionSize(
                        ctx.equity,
                        price,
                        long ? price - stopDistance : price + stopDistance,
                        riskMode,
                        riskValue,
                        cap,
                    );
                } else {
                    // No stop, so no risk distance: the ceiling is the size.
                    size = ctx.equity > 0 ? (ctx.equity * maxLeverage) / price : null;
                }
                if (size == null || !(size > 0)) return;

                ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'market',
                    size,
                    bracket: stopDistance == null ? null : { stopDistance },
                    tag: day.day,
                });
                ctx.state.trade = { exitIndex: day.tradeEndIndex - 1 } satisfies OpenTrade;
            },
        };
    },
};
