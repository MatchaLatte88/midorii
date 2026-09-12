import type { HistoryRow } from '../replay/tradeBook';

/**
 * The limits that stop a session rather than size a trade.
 *
 * Risk-per-trade decides how big one trade is. These decide whether there is a next one at
 * all, and they exist because the way a funded account is actually lost is not one bad trade
 * — it is the four after it. A prop firm enforces its own version of this and closes the
 * account when it is breached; the point of having them here is to stop before that, at a
 * number chosen while calm rather than while down.
 *
 * Every limit is off at zero. Nothing here is on by default: a limit somebody did not choose
 * would start refusing orders for reasons they never agreed to, and the first time they met
 * it would be mid-trade.
 *
 * What these are NOT
 * ------------------
 * They are Midorii's own guard and not the firm's. They do not know the firm's threshold,
 * cannot see trades placed on the firm's own platform, and reset on the boundary below rather
 * than on whatever the firm uses. Treat a breach here as a warning that arrived early, never
 * as proof that the account is still within its rules.
 */
export interface RiskLimits {
    /** Most the account may give back in a session, in account money. Zero is off. */
    dailyLoss: number;
    /** Most that may be held at once, in units or contracts. Zero is off. */
    maxSize: number;
    /** Stop after this many losing trades in a row. Zero is off. */
    lossStreak: number;
}

export const NO_LIMITS: RiskLimits = { dailyLoss: 0, maxSize: 0, lossStreak: 0 };

/** What the session has done so far — see {@link sessionState}. */
export interface SessionState {
    /** Realised result since the session began. Negative is down. */
    realised: number;
    /** Losing trades in an unbroken run ending now. */
    lossStreak: number;
    /** When the session this is measured over began. */
    since: number;
}

/**
 * Where one trading day ends and the next begins: 17:00 in New York.
 *
 * The futures day, not the calendar one. An index future trades through the evening and into
 * the next morning, and a limit that reset at local midnight would let a bad afternoon carry
 * on into a session the firm has already counted as tomorrow — which is the one moment a
 * limit is for. The same boundary is used for every account here rather than one rule per
 * venue: two answers to "how much have I lost today" is worse than one that is explicit.
 *
 * Twice a year the offset moves within the window this measures, so the session either side
 * of a clock change is an hour long or an hour short. Not corrected, because correcting it
 * would mean deciding which hour a trade belonged to, and the limit is a floor rather than
 * an accounting record.
 */
export function sessionStart(now: number): number {
    const shift = newYorkOffset(now);
    const wall = now + shift;
    const at = new Date(wall);
    let start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 17, 0, 0, 0);
    if (wall < start) start -= 24 * 60 * 60_000;
    return start - shift;
}

/** How far New York is from UTC at `at`, in milliseconds — negative, since it is behind. */
function newYorkOffset(at: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(at));
    const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
    return asUtc - at;
}

/**
 * What this session has done, out of the closed trades the account already reports.
 *
 * Read from the record rather than tallied as trades close, for the reason the account
 * readouts give: a running total kept here would be a second answer to a question the history
 * already answers, and the two would part company the first time anything was traded from
 * somewhere else.
 *
 * `history` is newest first, which is the order every account in this app reports it in.
 */
export function sessionState(history: readonly HistoryRow[], now = Date.now()): SessionState {
    const since = sessionStart(now);
    const mine = history.filter((row) => row.closedAt >= since);
    let realised = 0;
    for (const row of mine) realised += row.netPnl;

    /* The run ending NOW, so it is counted from the newest backwards and stops at the first
     * trade that made money. A scratch — exactly nothing — breaks it too: it is not a loss. */
    let lossStreak = 0;
    for (const row of mine) {
        if (!(row.netPnl < 0)) break;
        lossStreak += 1;
    }
    return { realised, lossStreak, since };
}

/** What an order would do to the exposure already on. */
export interface Exposure {
    /** Signed units held now: above zero is long. */
    net: number;
    side: 'buy' | 'sell';
    size: number;
}

/**
 * Whether an order would make the position bigger than it is.
 *
 * The distinction the whole guard turns on: a limit that has been hit must go on letting a
 * position be CLOSED. Refusing the exit would trap somebody inside the trade that breached
 * the limit, which is the exact opposite of what the limit is for.
 */
export function increases(exposure: Exposure): boolean {
    const signed = exposure.side === 'buy' ? exposure.size : -exposure.size;
    if (exposure.net === 0) return true;
    return Math.sign(signed) === Math.sign(exposure.net);
}

/** What the position would come to, where the order adds to it. */
function sizeAfter(exposure: Exposure): number {
    const signed = exposure.side === 'buy' ? exposure.size : -exposure.size;
    return Math.abs(exposure.net + signed);
}

/** Money, for a message. Plain rather than localised — this is a sentence, not a readout. */
function money(n: number): string {
    return `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}`;
}

/**
 * Why this order may not be sent, in words — or null when it may.
 *
 * Only ever refuses an order that would ADD to what is on. Everything that reduces goes
 * through untouched, whatever has been breached.
 */
export function limitRefusal(
    limits: RiskLimits,
    session: SessionState,
    exposure: Exposure,
): string | null {
    if (!increases(exposure)) return null;

    if (limits.dailyLoss > 0 && session.realised <= -limits.dailyLoss) {
        return `The loss limit for this session is reached — ${money(session.realised)} against a limit of ${money(limits.dailyLoss)}. `
            + 'Closing what is open still works; opening something new does not, until the next session.';
    }
    if (limits.lossStreak > 0 && session.lossStreak >= limits.lossStreak) {
        return `${session.lossStreak} losing trades in a row, which is the run you said to stop at. `
            + 'Closing what is open still works.';
    }
    if (limits.maxSize > 0 && sizeAfter(exposure) > limits.maxSize) {
        return `That would hold ${sizeAfter(exposure)} against a limit of ${limits.maxSize}.`;
    }
    return null;
}
