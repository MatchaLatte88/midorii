import type { OHLCV } from '../model/ohlcv';
import { closes, rsi, sma } from '../native-indicators/classics/math';
import { sessionBars } from './aggregate';
import { readBarClock, type BarClock } from './barClock';

/**
 * The oversold dip inside an uptrend: RSI(2) below 10 while the close holds above its 200-day
 * average.
 *
 * The idea, and the reason both halves are needed
 * ----------------------------------------------
 * A 2-period RSI is a very fast gauge — two bars of selling drive it into the teens — so on
 * its own it marks every pullback and every collapse alike, and buying the collapses is what
 * ruins the strategy. The 200-day average is the filter that separates them: below it, a deep
 * oversold reading is a market going down, not a market dipping. Both conditions are read on
 * the same completed daily bar, so the signal is known at that session's close and acted on
 * the next morning.
 *
 * Daily bars are session bars, not calendar days
 * ----------------------------------------------
 * This matters more here than anywhere else in this folder. The published sleeve reads the
 * signal off an ETF — SPY, QQQ, IWM — and trades the future that tracks it. An index future
 * runs about 23 hours, so its calendar-day bar contains an overnight the ETF never traded,
 * and an RSI(2) computed on those bars is not the same number the sleeve read. Folding the
 * daily bar out of the cash-hours window instead gets much closer to the ETF's own bar.
 *
 * It gets closer, not equal, and anyone comparing results to the published ones should know
 * exactly how it differs: the future and the ETF part company over dividends, over the fair
 * value carried in the basis, and — for the 200-day average especially — over the ratio
 * adjustment that splices a continuous contract together. The honest description of what this
 * file does is "the ETF's signal approximated from the future's own cash session", and the
 * way to remove the approximation is to feed it the ETF's bars.
 */

export interface RsiDipOptions {
    /** Length of the RSI. The published sleeve is 2 — fast enough that two down days do it. */
    rsiLength: number;
    /** The reading below which the dip counts as deep enough. */
    rsiThreshold: number;
    /** Length of the simple moving average the close has to be above. */
    smaLength: number;
    /** Start of the cash session the daily bar is folded from, minutes past local midnight. */
    sessionFromMin: number;
    /** End of it, exclusive. */
    sessionToMin: number;
    zone: string;
}

/** The published settings, against the US cash session on a Central-Time clock. */
export const RSI_DIP_DEFAULTS: RsiDipOptions = {
    rsiLength: 2,
    rsiThreshold: 10,
    smaLength: 200,
    sessionFromMin: 8 * 60 + 30,
    sessionToMin: 15 * 60,
    zone: 'America/Chicago',
};

export interface RsiDipSignal {
    /** Index in the base series of the last bar of the session that produced the signal — the
     *  bar from which it is known. */
    index: number;
    /** Local day of that session. */
    day: string;
    /** What the two conditions actually read, so a run can be checked rather than trusted. */
    rsi: number;
    close: number;
    sma: number;
}

export interface RsiDipDetection {
    signals: RsiDipSignal[];
    /** The daily bars the conditions were read from. */
    daily: OHLCV[];
    clock: BarClock;
}

export function detectRsiDip(
    bars: readonly OHLCV[],
    options: RsiDipOptions = RSI_DIP_DEFAULTS,
): RsiDipDetection {
    if (bars.length < 2) {
        throw new Error('detectRsiDip: at least two bars are needed');
    }

    const { rsiLength, rsiThreshold, smaLength, sessionFromMin, sessionToMin, zone } = options;
    const clock = readBarClock(bars, zone);
    const sessions = sessionBars(bars, clock, sessionFromMin, sessionToMin);

    const dailyCloses = closes(sessions.bars);
    const reading = rsi(dailyCloses, rsiLength);
    const trend = sma(dailyCloses, smaLength);

    const signals: RsiDipSignal[] = [];
    for (let k = 0; k < sessions.bars.length; k += 1) {
        const r = reading[k]!;
        const mean = trend[k]!;
        // Either average still filling: there is no reading to compare, not a reading of zero.
        if (!Number.isFinite(r) || !Number.isFinite(mean)) continue;

        const close = dailyCloses[k]!;
        if (r >= rsiThreshold || close <= mean) continue;

        signals.push({
            index: sessions.sourceEnd[k]!,
            day: sessions.days[k]!,
            rsi: r,
            close,
            sma: mean,
        });
    }

    return { signals, daily: sessions.bars, clock };
}
