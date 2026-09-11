import type { OHLCV } from '../model/ohlcv';
import { readBarClock, type BarClock } from './barClock';

/**
 * The time-based range cell, and the continuation out of it — "TBR9", named for the 09:00
 * New York hour it was first measured on and still keeps its clock from.
 *
 * The shape of the idea
 * ---------------------
 * One hour of the morning is fenced off as a CELL. Its walls are not drawn from that hour's
 * own high and low — they are drawn before it starts, from how far this market has typically
 * travelled by late morning:
 *
 *     sigma   the sample standard deviation of the last 20 sessions' morning returns, each
 *             being (this session's late-morning close ÷ its 07:00 open) − 1
 *     bands   the 07:00 open × (1 ± 0.25 × sigma)
 *
 * If the cell hour never reaches either wall, the market has been quiet against its own
 * recent standard. The trade is the first touch of a wall in the hour AFTER that: quiet, then
 * a move, in the direction of the move.
 *
 * The bands being built from a forecast rather than from the hour itself is the whole
 * mechanism. A range broken out of is an ordinary breakout; a range that is quiet BY A
 * MEASURE SET IN ADVANCE, and then is not, is a change in what the session is doing. It also
 * means the walls are already known when the cell opens, so nothing about the setup is
 * decided after the fact.
 *
 * Where the clock comes from, and what breaks if it moves
 * ------------------------------------------------------
 * Every window is Central Time by default, because that is where the strategy was measured:
 * the cell is 07:00-07:59, the trigger hour is 08:00-08:59, and the 08:30 US cash open falls
 * inside the trigger hour rather than before it. That last fact is why the entry can need a
 * wait — see the strategy file. The return that feeds sigma is measured to 11:00, which is
 * also where the position is scheduled to come off, so the yardstick and the holding period
 * are the same stretch of day rather than two different ones.
 *
 * Sessions, not calendar days
 * ---------------------------
 * A session here is a local day that has both a 07:00 open and a late-morning close. Weekends
 * and holidays simply have neither, so they contribute no return and sigma skips them —
 * "the last 20 sessions" means twenty that traded, which is what it says.
 */

/** Clocks are minutes past local midnight, read in `zone`. */
export interface TimeBasedRangeOptions {
    /** Start of the cell — also the open the bands and the stop are anchored to. */
    cellStartMin: number;
    /** End of the cell and start of the trigger window. */
    cellEndMin: number;
    /** End of the trigger window. A wall untouched by then is not traded. */
    triggerEndMin: number;
    /** The close the morning return is measured to, by bar close. */
    returnEndMin: number;
    /** How many previous sessions sigma averages over. */
    sigmaDays: number;
    /** How many sigmas out the walls sit. */
    bandSigma: number;
    /** IANA zone the clocks above are read in. */
    zone: string;
}

export const TIME_BASED_RANGE_DEFAULTS: TimeBasedRangeOptions = {
    cellStartMin: 7 * 60,
    cellEndMin: 8 * 60,
    triggerEndMin: 9 * 60,
    returnEndMin: 11 * 60,
    sigmaDays: 20,
    bandSigma: 0.25,
    zone: 'America/Chicago',
};

/** One session's cell, once it has produced a trade. */
export interface TimeBasedRangeSetup {
    /** The bar that touched a wall — the first bar the setup could be acted on from. */
    index: number;
    /** Touching the upper wall is long, the lower one short. */
    direction: 'long' | 'short';
    day: string;
    /** The 07:00 open: what the bands are built around, and where the trade is wrong. */
    cellOpen: number;
    upper: number;
    lower: number;
    /** The forecast the walls were placed with, as a fraction (0.004 is 0.4%). */
    sigma: number;
}

export interface TimeBasedRangeDetection {
    setups: TimeBasedRangeSetup[];
    clock: BarClock;
}

/** One session's bars, and the two prices the morning return is measured between. */
interface Session {
    day: string;
    /** Bars of this local day, in order. */
    indices: number[];
    /** Open of the first bar inside the cell window, or null when the session has none. */
    cellOpen: number | null;
    /** Close of the last bar completing at or before the return mark, or null. */
    returnClose: number | null;
}

/**
 * Sample standard deviation (n − 1). Null below two values, where a spread is not defined —
 * and null rather than 0, because 0 would place both walls exactly on the open and make every
 * session touch one on its first bar.
 */
function sampleStdev(values: readonly number[]): number | null {
    if (values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}

export function detectTimeBasedRange(
    bars: readonly OHLCV[],
    options: TimeBasedRangeOptions = TIME_BASED_RANGE_DEFAULTS,
): TimeBasedRangeDetection {
    if (bars.length < 2) {
        throw new Error('detectTimeBasedRange: at least two bars are needed');
    }

    const { cellStartMin, cellEndMin, triggerEndMin, returnEndMin, sigmaDays, bandSigma, zone } = options;
    const clock = readBarClock(bars, zone);
    const sessions = groupSessions(bars, clock, cellStartMin, cellEndMin, returnEndMin);

    const setups: TimeBasedRangeSetup[] = [];
    /* Returns of the sessions already passed, oldest first. Only sessions that HAVE one get
     * in, so a holiday does not silently count as a flat day and shrink the forecast. */
    const history: number[] = [];

    for (const session of sessions) {
        const { cellOpen, returnClose } = session;

        const sigma = history.length >= sigmaDays ? sampleStdev(history.slice(-sigmaDays)) : null;

        /* Recorded before the bail-outs below, so a session that cannot be traded still
         * teaches the next ones what a morning looks like here. */
        if (cellOpen != null && returnClose != null && cellOpen > 0) {
            history.push(returnClose / cellOpen - 1);
        }

        if (sigma == null || sigma <= 0 || cellOpen == null || !(cellOpen > 0)) continue;

        const upper = cellOpen * (1 + bandSigma * sigma);
        const lower = cellOpen * (1 - bandSigma * sigma);

        const found = scanSession(bars, clock, session, {
            cellStartMin, cellEndMin, triggerEndMin, upper, lower,
        });
        if (found === null) continue;

        setups.push({
            index: found.index,
            direction: found.direction,
            day: session.day,
            cellOpen,
            upper,
            lower,
            sigma,
        });
    }

    return { setups, clock };
}

/** Bars bucketed by local day, with the two prices the morning return needs. */
function groupSessions(
    bars: readonly OHLCV[],
    clock: BarClock,
    cellStartMin: number,
    cellEndMin: number,
    returnEndMin: number,
): Session[] {
    const sessions: Session[] = [];
    let current: Session | null = null;

    for (let i = 0; i < bars.length; i += 1) {
        const day = clock.days[i]!;
        if (!current || current.day !== day) {
            current = { day, indices: [], cellOpen: null, returnClose: null };
            sessions.push(current);
        }
        current.indices.push(i);

        const openMin = clock.openMinutes[i]!;
        /* The first bar of the cell WINDOW, not the one stamped exactly 07:00 — a session
         * missing that minute still has a cell, and demanding the exact stamp would drop it
         * entirely. A session whose data begins after the cell has none, which is what the
         * upper bound enforces. */
        if (current.cellOpen === null && openMin >= cellStartMin && openMin < cellEndMin) {
            current.cellOpen = bars[i]!.open;
        }
        /* The last bar completing at or before the mark, so a missing final minute costs a
         * little accuracy rather than the whole session's return. Bars before the cell are
         * excluded: the return is measured across the morning, not across the night. */
        if (openMin >= cellStartMin && clock.closeMinutes[i]! <= returnEndMin) {
            current.returnClose = bars[i]!.close;
        }
    }

    return sessions;
}

/**
 * Whether this session's cell stayed inside its walls, and which wall the trigger hour then
 * touched first. Null for every session that is not a setup.
 */
function scanSession(
    bars: readonly OHLCV[],
    clock: BarClock,
    session: Session,
    walls: { cellStartMin: number; cellEndMin: number; triggerEndMin: number; upper: number; lower: number },
): { index: number; direction: 'long' | 'short' } | null {
    const { cellStartMin, cellEndMin, triggerEndMin, upper, lower } = walls;
    let sawCell = false;

    for (const i of session.indices) {
        const openMin = clock.openMinutes[i]!;
        const bar = bars[i]!;

        if (openMin >= cellStartMin && openMin < cellEndMin) {
            sawCell = true;
            // Strictly inside: a cell bar that so much as reaches a wall ends the session.
            if (bar.high >= upper || bar.low <= lower) return null;
            continue;
        }

        if (openMin < cellEndMin || openMin >= triggerEndMin) continue;
        // No quiet hour on record means there was nothing for the market to break out of.
        if (!sawCell) return null;

        const up = bar.high >= upper;
        const down = bar.low <= lower;
        /* Both walls inside one bar. Which came first is exactly what a bar cannot say, and
         * the direction IS the trade here — there is no pessimistic side to fall back on, so
         * the session is passed over rather than guessed at. */
        if (up && down) return null;
        if (up) return { index: i, direction: 'long' };
        if (down) return { index: i, direction: 'short' };
    }

    return null;
}
