import type { OHLCV } from '../../../src/core/model/ohlcv';
import {
    VWAP_BANDS_DEFAULTS,
    detectVwapBands,
    type VwapSessionId,
    type VwapSource,
} from '../../../src/core/analysis/vwapBands';
import type { BarClock } from '../../../src/core/analysis/barClock';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import { RISK_PARAMS, leverageCap, positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { cached, detectionCacheKey, type DetectionCache } from './detection';
import type { StrategyParam, StrategyParams, StrategySpec } from './types';

/**
 * VWAP Reversion — fades a session that has run a long way from its own average price, and
 * gets out when it comes back to it.
 *
 * Where this one comes from, and what that is worth
 * -------------------------------------------------
 * Nowhere published. This is the one strategy in the library with no paper behind it, and the
 * difference matters enough to say first: the opening range follows Zarattini, Barbon & Aziz,
 * the intraday momentum sleeve follows Gao, Han, Li & Zhou, and each of those carries figures
 * somebody else measured and can be checked against. This does not. It is desk practice —
 * price extends from the session VWAP, the extension fades, the average is the target — written
 * up consistently across trading education material and platform documentation, and nowhere
 * that states a rule set and reports what it did.
 *
 * So every default below is a starting point for a sweep, not a published figure, and a result
 * from this file is a measurement being made here for the first time rather than a replication
 * of one. `entrySigmas` is the setting the whole thing turns on and the first one to sweep.
 *
 * What the sources describe and this cannot do
 * --------------------------------------------
 * The version desks actually trade takes the band as a location and then asks the tape whether
 * the move is exhausted there: delta diverging from price, volume tapering, absorption at the
 * level. None of that is available from OHLCV bars — it needs each print's side, which means
 * tick data with a bid and an ask. It is therefore not approximated: there is no OHLCV proxy
 * for absorption, and inventing one would report a filter that was never applied.
 *
 * What is left is the location without the confirmation, which is a weaker strategy than the
 * one described, and is the honest translation of it rather than a faithful one.
 *
 * The trend filter that is missing, and what stands in for it
 * -----------------------------------------------------------
 * Every description of this pattern says the same thing about when it fails: on a day that
 * trends, fading each extension in turn is a way to lose money all session. The usual answer is
 * an ADX floor or a "rotational day" filter. There is no ADX in this codebase and no evidence
 * anywhere for what its threshold should be, so rather than invent a number and present it as a
 * filter, the exposure to that day is capped directly: `maxEntries` limits how many times one
 * session may be faded. That is a risk control and not an edge, and it is worth reading as one.
 *
 * A market order on the close beyond the band, not a limit resting at it
 * ----------------------------------------------------------------------
 * The band is not a fixed level. Sigma accumulates through the session, so the 2-sigma line is
 * in a different place on every bar, and an order resting at "the band" would be an order that
 * has to be moved every minute — a different trade from the one described, and one that fills
 * thousands of cancelled orders into a run. So the signal is the bar that CLOSES beyond the
 * band, having closed inside it on the bar before, and the entry is a market order filling at
 * the next bar's open. It pays the snap-back rather than catching it, which is the cost of
 * having a rule that a person could actually have followed.
 *
 * The crossing rule is the same one the phase oscillator uses: staying beyond the band is not
 * a crossing, so one long stretch of extended market fires once rather than on every bar of it.
 *
 * The target is the VWAP as it stood on the signal bar
 * ----------------------------------------------------
 * The thesis is a return to fair value, so the target is the VWAP itself rather than a tick
 * count or a multiple of the risk — which is why the shared Reward : risk setting is unused
 * here, and why switching a ratio target on would be a different strategy.
 *
 * The VWAP moves, though, and the bracket attached to a fill takes a level. Tracking it would
 * mean cancelling and re-placing the target every bar. It is frozen at the signal bar's VWAP
 * instead, which is a small approximation and a stated one: a session VWAP has the whole
 * session's volume behind it by the time these entries are allowed, so by mid-morning it moves
 * in fractions of a point per minute. It is also the conservative side of the approximation —
 * when the VWAP drifts toward an extended price, the real target comes to meet the trade and
 * the frozen one does not.
 *
 * The stop is a level, and so it costs what the market does
 * ---------------------------------------------------------
 * Both bracket legs are absolute prices rather than distances from the fill, because both are
 * facts about the session rather than about the fill — the same choice the time-based range
 * makes for its cell open. The consequence is the same one: a gap through the level between the
 * signal and the next bar's open costs more than the trade was sized to risk, instead of
 * quietly moving the level the setup was built on.
 */

const SESSION_OPTIONS = [
    { value: 'nyse', label: 'US cash (09:30 New York)' },
    { value: 'utc', label: 'UTC day (00:00)' },
] as const;

const SOURCE_OPTIONS = [
    { value: 'HLC3', label: 'Typical price (H+L+C)/3' },
    { value: 'OHLC4', label: 'Average price (O+H+L+C)/4' },
    { value: 'Close', label: 'Close' },
] as const;

/** What the average and its bands are measured from — everything the detector takes. */
const MEASUREMENT_PARAMS: readonly StrategyParam[] = [
    {
        key: 'session',
        label: 'Session',
        type: 'select',
        default: VWAP_BANDS_DEFAULTS.session,
        hint: 'Where the average resets. A VWAP is the average price paid since the market '
            + 'opened, so it starts again at the open — 09:30 to 16:00 New York for equities '
            + 'and index futures, following the US clock change rather than a fixed UTC hour. A '
            + 'market that never opens has no such moment, so crypto gets the UTC day. Every '
            + 'clock setting below is read on the session\'s own zone.',
        options: SESSION_OPTIONS,
    },
    {
        key: 'source',
        label: 'Price per bar',
        type: 'select',
        default: VWAP_BANDS_DEFAULTS.source,
        hint: 'Which price of each bar goes into the average, weighted by that bar\'s volume. '
            + 'The typical price is the convention and what the chart\'s own VWAP defaults to.',
        options: SOURCE_OPTIONS,
    },
];

/** What is done about a market that has run — none of it changes the average itself. */
const TRADE_PARAMS: readonly StrategyParam[] = [
    {
        key: 'entrySigmas',
        label: 'Fade at (standard deviations)',
        type: 'number',
        default: 2,
        min: 0.25,
        max: 10,
        step: 0.25,
        hint: 'How far from the VWAP the market has to close before it is faded, measured in '
            + 'the session\'s own volume-weighted standard deviations. This is the setting the '
            + 'strategy turns on and the first one worth sweeping: lower takes many more trades '
            + 'at worse locations, higher takes very few. 2 is the number every description of '
            + 'this pattern uses and none of them measured.',
    },
    {
        key: 'stopSigmas',
        label: 'Stop, beyond the band (standard deviations)',
        type: 'number',
        default: 1,
        min: 0.1,
        max: 10,
        step: 0.25,
        hint: 'How much further the market may run before the trade is wrong, again in the '
            + 'session\'s own deviations — a stop at 2 + 1 sits on the 3-sigma line. Stated in '
            + 'sigmas rather than points so the same setting means the same thing on a quiet '
            + 'session and a violent one.',
    },
    {
        key: 'warmupMinutes',
        label: 'No entries for (minutes after the open)',
        type: 'number',
        default: 15,
        min: 0,
        max: 720,
        step: 5,
        hint: 'How long the session runs before a signal counts. Over the first minutes the '
            + 'average has almost no volume behind it and the deviation around it is tiny, so '
            + 'ordinary movement reads as an extreme and every early bar looks like a signal. '
            + 'Measured as elapsed time from the session\'s first bar, not as a bar count.',
    },
    {
        key: 'lastEntryMin',
        label: 'Entries until',
        type: 'time',
        default: 15 * 60,
        hint: 'Latest bar CLOSE that may open a trade, inclusive, on the session\'s own clock. '
            + 'Stated as a close rather than an open so it means the same thing on any '
            + 'timeframe: the ticket goes in one bar later, at that bar\'s open. A trade needs '
            + 'room to come back to the average before the position is closed on the clock.',
    },
    {
        key: 'flatMin',
        label: 'Flat at',
        type: 'time',
        default: 15 * 60 + 55,
        hint: 'When an unclosed position comes off, on the session\'s own clock. The close is '
            + 'ordered on the bar completing at this time and fills at the next bar\'s open, so '
            + 'the fill lands on the clock. Nothing is ever carried into the next session, '
            + 'whatever this is set to: the average the trade was measured against does not '
            + 'survive the close.',
    },
    {
        key: 'maxEntries',
        label: 'Trades per session',
        type: 'number',
        default: 2,
        min: 1,
        max: 20,
        step: 1,
        hint: 'How many times one session may be faded. This is the cap that stands in for the '
            + 'trend filter this strategy does not have — on a day that runs one way all '
            + 'session, fading each extension in turn is how this pattern loses money, and the '
            + 'count is what bounds that. Raising it is not a way to find more edge.',
    },
];

/**
 * The settings that change the AVERAGE, rather than what is done about a market away from it.
 *
 * Everything else is out, and `entrySigmas` most deliberately: the detector reports the
 * deviation at every bar and this file does the comparing, so a sweep of the one setting most
 * worth sweeping reuses a single detection across every level of it.
 */
const DETECTION_KEYS = ['session', 'source'] as const;

/** What the strategy remembers between bars: which session it is in, and how much of that
 *  session's allowance it has spent. */
interface SessionState {
    day: string;
    entries: number;
}

function numberOf(params: StrategyParams, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`vwapreversion: ${key} must be a number`);
    return value;
}

function stringOf(params: StrategyParams, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`vwapreversion: ${key} must be a string`);
    return value;
}

export const VWAP_REVERSION_STRATEGY: StrategySpec = {
    id: 'vwapreversion',
    name: 'VWAP Reversion',
    description: 'Fades a session that has closed a set number of standard deviations from its '
        + 'own volume-weighted average price, and targets that average. Stop a further fraction '
        + 'of a deviation beyond the band, flat by the close.',
    rules: {
        conditions: [
            'The bar closed beyond the band — more than the set number of the session\'s own '
            + 'volume-weighted standard deviations from its VWAP — having closed inside it on '
            + 'the bar before. Staying beyond the band is not a crossing, so one extended '
            + 'stretch of market fires once rather than on every bar of it.',
            'Both bars belong to the same session. The average and its deviation reset at the '
            + 'open, so a bar compared against yesterday\'s would be compared against a '
            + 'different number under the same name.',
            'The session has run for the warm-up period, and the bar closed at or before the '
            + 'last entry time — both read on the session\'s own clock.',
            'The session has entries left. The count is a cap on how often one day may be '
            + 'faded, and it is the only thing standing in for the trend filter this strategy '
            + 'does not have.',
            'Nothing is already on: one position at a time, and a signal arriving during a '
            + 'trade is passed over rather than queued.',
        ],
        entry: 'A market order on the bar that closed beyond the band, filling at the next '
            + 'bar\'s open. Never a limit resting at the band: sigma accumulates through the '
            + 'session, so the band sits somewhere new on every bar, and an order resting at a '
            + 'level that moves is a different trade from this one.',
        stop: 'The band the entry came from, a further `stopSigmas` deviations out — a 2-sigma '
            + 'entry with a 1-sigma stop is stopped on the 3-sigma line. A price rather than a '
            + 'distance, because it is a fact about the session and not about the fill, so a '
            + 'gap into the trade costs more than planned instead of quietly moving the level '
            + 'the setup was built on.',
        target: 'The VWAP, as it stood on the signal bar. The thesis is a return to fair value, '
            + 'so the target is that value and not a multiple of the risk — the shared Reward : '
            + 'risk setting is therefore unused here. The level is frozen at the signal rather '
            + 'than tracked, which is the conservative side of that approximation: a VWAP '
            + 'drifting toward an extended price would come to meet the trade.',
        size: 'Derived, never set: the risk per trade divided by the distance from the signal '
            + 'bar\'s close to the stop, capped by the leverage ceiling. Sized off the close '
            + 'the order is sent on rather than off the band, because that is the price a '
            + 'person placing it can see.',
    },
    params: [...RISK_PARAMS, ...MEASUREMENT_PARAMS, ...TRADE_PARAMS],
    detectionKeys: DETECTION_KEYS,

    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams> {
        const riskMode = stringOf(params, 'riskMode') as RiskMode;
        const riskValue = numberOf(params, 'riskValue');
        /* Null when the notional ceiling is switched off: the size is then whatever the
         * risk asks for, and being stopped out costs exactly what was typed in. */
        const cap = leverageCap(params);

        const entrySigmas = numberOf(params, 'entrySigmas');
        const stopSigmas = numberOf(params, 'stopSigmas');
        const warmupMinutes = numberOf(params, 'warmupMinutes');
        const lastEntryMin = numberOf(params, 'lastEntryMin');
        const flatMin = numberOf(params, 'flatMin');
        const maxEntries = numberOf(params, 'maxEntries');

        const bands = cached(cache, detectionCacheKey('vwapreversion', params, DETECTION_KEYS), () => (
            detectVwapBands(bars, {
                session: stringOf(params, 'session') as VwapSessionId,
                source: stringOf(params, 'source') as VwapSource,
            })
        ));

        const { vwap, sigma, sinceOpen, day } = bands;
        const clock: BarClock = bands.clock;

        /* Said out loud rather than absorbed, and split into the two things that produce the
         * same empty result for opposite reasons — one is the wrong session for these bars,
         * the other is data a VWAP cannot be built from at all. Either way the run would
         * otherwise report "no trades" for a strategy that was configured correctly. */
        if (bars.length > 0 && day.every((d) => d == null)) {
            throw new Error(
                `vwapreversion: none of these bars fall inside the ${stringOf(params, 'session')} `
                + 'session, so there is no average to measure against. Check the session setting '
                + 'against the market these bars come from.',
            );
        }
        if (bars.length > 0 && vwap.every((v) => v == null)) {
            throw new Error(
                'vwapreversion: these bars carry no volume, so there is no volume-weighted '
                + 'average price to fade. This strategy cannot be run on them.',
            );
        }

        return {
            params,
            series: { vwap, sigma },

            onBar(ctx) {
                const i = ctx.index;
                const today = day[i];

                /* A trade is on. The only decision left is the clock — the stop and the target
                 * are already resting, and a second opinion about the same position would be
                 * placing orders against protection that is doing its job.
                 *
                 * Two of the three ways out are backstops rather than rules. Bars outside the
                 * window end it because the average the trade was measured against has stopped
                 * being measured; a changed day ends it because bars that are ALL inside the
                 * window — an RTH-only export, where nothing ever reads as outside — would
                 * otherwise roll a position into the next session on the strength of a level
                 * that belongs to the last one. */
                if (!ctx.isFlat) {
                    const held = ctx.state.session as SessionState | undefined;
                    const outside = today == null;
                    const nextSession = !outside && held != null && held.day !== today;
                    if (outside || nextSession) {
                        ctx.close('session-end');
                        return;
                    }
                    if (clock.closeMinutes[i]! >= flatMin) ctx.close('flat-at');
                    return;
                }

                if (today == null) return;

                let session = ctx.state.session as SessionState | undefined;
                if (!session || session.day !== today) {
                    session = { day: today, entries: 0 };
                    ctx.state.session = session;
                }
                if (session.entries >= maxEntries) return;

                if (sinceOpen[i]! < warmupMinutes) return;
                if (clock.closeMinutes[i]! > lastEntryMin) return;
                // The previous bar has to be this session's, or the two are measured against
                // different averages — see the conditions.
                if (i === 0 || day[i - 1] !== today) return;

                const mean = ctx.value('vwap');
                const dev = ctx.value('sigma');
                const prevMean = ctx.value('vwap', 1);
                const prevDev = ctx.value('sigma', 1);
                if (mean == null || dev == null || prevMean == null || prevDev == null) return;
                if (!(dev > 0) || !(prevDev > 0)) return;

                const history = ctx.history(2);
                if (history.length < 2) return;
                const prevClose = history[0]!.close;
                const close = ctx.bar.close;

                const z = (close - mean) / dev;
                const prevZ = (prevClose - prevMean) / prevDev;

                /* Crossed out of the band on this bar. A bar that was already beyond it says
                 * nothing new, which is what keeps one extended stretch to a single signal. */
                const long = prevZ >= -entrySigmas && z < -entrySigmas;
                const short = prevZ <= entrySigmas && z > entrySigmas;
                if (!long && !short) return;

                const band = long ? mean - entrySigmas * dev : mean + entrySigmas * dev;
                const stopPrice = long ? band - stopSigmas * dev : band + stopSigmas * dev;

                /* The bar ran straight through where the stop would go. There is no risk
                 * distance left to size against, and a position opened here would be beyond its
                 * own stop before it existed. */
                const risk = long ? close - stopPrice : stopPrice - close;
                if (!(risk > 0)) return;

                const size = positionSize(ctx.equity, close, stopPrice, riskMode, riskValue, cap);
                if (size == null) return;

                ctx.order({
                    side: long ? 'buy' : 'sell',
                    type: 'market',
                    size,
                    // Levels, not distances — see the header.
                    bracket: { stopLoss: stopPrice, takeProfit: mean },
                    tag: today,
                });
                session.entries += 1;
            },
        };
    },
};
