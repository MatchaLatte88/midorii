import type { HistoryRow } from '../replay/tradeBook';

/**
 * The limits that stop a session rather than size a trade, and the floor under the account.
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
 * Two kinds of number live here
 * -----------------------------
 * The SESSION limits — the daily loss, the most that may be held, the run of losses — are
 * measured over one trading day and start again with the next. The ACCOUNT floor is not: the
 * maximum loss limit is measured against the account's own high-water mark and, once it is
 * touched, the account is gone rather than paused. That is why it is refused first and why it
 * is the first figure on the band.
 *
 * They are set per ACCOUNT rather than once for the app — see accountRules.ts. A funded
 * account and the evaluation beside it carry different numbers from the same firm, and one
 * figure serving both would be wrong for at least one of them.
 *
 * What these are NOT
 * ------------------
 * They are Midorii's own guard and not the firm's. They do not know the firm's threshold,
 * cannot see trades placed on the firm's own platform, and reset on the boundary below rather
 * than on whatever the firm uses. Treat a breach here as a warning that arrived early, never
 * as proof that the account is still within its rules.
 */

/**
 * How the maximum loss limit's floor follows the account up.
 *
 * Asked rather than assumed, because firms differ and a floor that trails the wrong thing
 * sits too low and warns too late.
 *
 * `static`   — a fixed floor under the starting balance. It never moves; you raise it yourself.
 * `eod`      — it follows the highest END-OF-DAY balance. What Topstep measures.
 * `intraday` — it follows the highest equity ever reached, open trade included. Stricter, and
 *              what firms in the Apex mould measure.
 */
export type MllMode = 'static' | 'eod' | 'intraday';

/** What a breach does to what is already open, beyond refusing the next entry. */
export type BreachAction = 'refuse' | 'flatten';

export interface RiskLimits {
    /** Most the account may give back in a session, in account money. Zero is off. */
    dailyLoss: number;
    /** Most that may be held at once, in units or contracts. Zero is off. */
    maxSize: number;
    /** Stop after this many losing trades in a row. Zero is off. */
    lossStreak: number;
    /**
     * What the account began with, as the firm states it.
     *
     * The figure the floor and the goal are both measured from, and the one number here that
     * cannot be derived: the balance a venue reports is today's, and an account that is up
     * 2,400 says nothing about where it started. Zero means it was never entered, which turns
     * the floor and the goal off — both would otherwise be measured against nothing.
     */
    startBalance: number;
    /** How far below the mark the floor sits — the MLL, in account money. Zero is off. */
    maxLoss: number;
    mllMode: MllMode;
    /**
     * Whether the floor stops trailing once it is level with the starting balance.
     *
     * What a funded account in the Topstep mould does: the floor follows the balance up until
     * it reaches what the account started at, and then stays there — so the account can never
     * be lost from above its own starting point. Off means it keeps following.
     */
    mllFreezeAtStart: boolean;
    /** What the account is trying to make, measured from the starting balance. Zero is off. */
    profitGoal: number;
    /**
     * What a breached floor or daily limit does to what is already open.
     *
     * `refuse` says nothing goes out that would add to a position, and leaves the open one to
     * you. `flatten` closes it at market and cancels the working orders — an order this app
     * sends of its own accord, which is why it is never the default.
     */
    onBreach: BreachAction;
}

export const NO_LIMITS: RiskLimits = {
    dailyLoss: 0,
    maxSize: 0,
    lossStreak: 0,
    startBalance: 0,
    maxLoss: 0,
    mllMode: 'static',
    mllFreezeAtStart: false,
    profitGoal: 0,
    onBreach: 'refuse',
};

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

/**
 * The highest balance any day has CLOSED at, worked back out of the closed trades.
 *
 * What the `eod` floor follows. The venue states today's balance and nothing about the path
 * to it, so the path is reconstructed: take the balance now, subtract everything the history
 * holds to reach the balance before it began, then walk forward and record where the balance
 * stood at each session boundary the trades cross. The balance at the start of a day is what
 * the day before it closed at, which is the figure wanted.
 *
 * Two things this cannot do, and both are said out loud rather than hidden:
 *
 *   - **It sees only as far back as the history reaches.** A gateway that serves a month
 *     answers for a month; a day that closed higher before that is invisible here, and a
 *     floor computed from this alone would sit too LOW — permissive, which is the dangerous
 *     direction. That is why a stored mark is kept alongside it and the higher of the two
 *     wins (see accountRules.ts), and why the mark can be typed in by hand.
 *   - **Today does not count.** A balance is folded in only at a boundary it has crossed, so
 *     a day that is up but still open cannot raise the floor under the trade making it.
 */
export function eodHighWater(
    history: readonly HistoryRow[],
    balance: number,
    startBalance: number,
    now = Date.now(),
): number {
    /* Oldest first is the order a curve is walked; the account reports it newest first. */
    const rows = [...history].reverse();

    let running = balance;
    for (const row of rows) running -= row.netPnl;

    /* The balance before the history begins is itself a day's close, and the starting balance
     * is the mark before anything had been traded at all. */
    let mark = Math.max(startBalance, running);
    const today = sessionStart(now);
    let session = rows.length > 0 ? sessionStart(rows[0]!.closedAt) : today;

    for (const row of rows) {
        const at = sessionStart(row.closedAt);
        // A boundary crossed: what stands now is what the session just ended closed at.
        if (at > session) {
            mark = Math.max(mark, running);
            session = at;
        }
        running += row.netPnl;
    }
    /* Nothing closed in this session, so the walk never crossed into it — the balance it ended
     * on is the last day's close and has not been folded in yet. */
    if (today > session) mark = Math.max(mark, running);

    return mark;
}

/**
 * Where the floor sits, given the mark it trails — or null when there is no floor.
 *
 * Off without a maximum loss AND a starting balance: the amount says how far below the mark
 * to sit, and the starting balance is what the mark is measured from before the account has
 * been anywhere. Neither can stand in for the other.
 *
 * A trailing floor never trails DOWN. The mark is the best the account has done, so a losing
 * account keeps the floor it started with instead of carrying it down and never breaching.
 */
export function mllFloor(limits: RiskLimits, highWater: number): number | null {
    if (!(limits.maxLoss > 0) || !(limits.startBalance > 0)) return null;
    const mark = limits.mllMode === 'static'
        ? limits.startBalance
        : Math.max(highWater, limits.startBalance);
    const floor = mark - limits.maxLoss;
    return limits.mllFreezeAtStart ? Math.min(floor, limits.startBalance) : floor;
}

/** What the account stands on: figures a screen can show and an order can be refused by. */
export interface PropStanding {
    /** The level the equity may not touch, or null where no floor is set. */
    floor: number | null;
    /**
     * Whether the account has stated what it is worth yet.
     *
     * False between arming a chart and the venue's first answer, when the equity is still
     * zero. Everything measured against the equity is null while it is false — see
     * {@link accountStanding}.
     */
    known: boolean;
    /** The mark the floor trails, after this reading. Stored, so it cannot fall back. */
    highWater: number;
    /** Money between the equity and the floor. Null with no floor; negative once breached. */
    room: number | null;
    /** This session's result WITH the open trade in it — what the daily limit is measured on. */
    dayResult: number;
    /** Money left before the daily limit. Null when it is off; negative once past it. */
    dayRoom: number | null;
    /** Ahead of the starting balance, open trade included. Null without a starting balance. */
    profit: number | null;
    /** Along the goal, 0 to 1 and beyond. Null with no goal set. */
    goalProgress: number | null;
    /** Still to make. Null with no goal; zero once it is reached. */
    goalRoom: number | null;
    /** Losing trades in a row, ending now. */
    lossStreak: number;
    /** When the session these are measured over began. */
    since: number;
    /** Which limit is past, or null. The floor is named first: it is the one that ends things. */
    breached: 'mll' | 'dll' | null;
}

/**
 * Everything the limits are judged against, out of what the account can say about itself.
 *
 * One call per repaint rather than a figure at a time: the daily result, the floor and the
 * goal all read the same equity and the same history, and computing them apart is how two
 * figures on one band come to disagree.
 *
 * `openPnl` is asked for rather than derived, because the venues state the two differently —
 * one gives a balance and a position, another a balance with the open result already inside
 * it. The caller knows which it has; this does not.
 */
export function accountStanding(input: {
    limits: RiskLimits;
    /** The account's worth right now, open trade included. */
    equity: number;
    /** What the open position is worth right now. Zero when flat. */
    openPnl: number;
    /** Closed trades, newest first. */
    history: readonly HistoryRow[];
    /** The mark carried over from before — see accountRules.ts. */
    storedHighWater: number;
    now?: number;
}): PropStanding {
    const { limits, equity, openPnl, history, storedHighWater } = input;
    const now = input.now ?? Date.now();
    const session = sessionState(history, now);

    /**
     * Whether the account has said what it is worth.
     *
     * A chart armed on an account states zero until the venue's first answer, and zero is an
     * absence rather than a reading. Judged as one it would put every fresh chart instantly
     * below its own floor — and on an account set to close out on a breach, it would announce
     * one and send a market order before the venue had been asked anything at all. So nothing
     * measured against the equity is answered until there is an equity.
     *
     * The daily limit is left alone by this: it is measured on the session's own trades and on
     * what is open, both of which are honestly zero before the first read.
     */
    const known = equity > 0;

    /* The realised balance: the equity with the open trade taken back out. What an end-of-day
     * mark is made of — a day closes with no position, so its close is a realised figure. */
    const balance = equity - openPnl;

    let highWater = Math.max(storedHighWater, limits.startBalance);
    if (!known) {
        // Nothing to learn from an account that has not spoken; the stored mark stands.
    } else if (limits.mllMode === 'intraday') {
        highWater = Math.max(highWater, equity);
    } else if (limits.mllMode === 'eod') {
        highWater = Math.max(highWater, eodHighWater(history, balance, limits.startBalance, now));
    }

    const floor = mllFloor(limits, highWater);
    const dayResult = session.realised + openPnl;
    const profit = known && limits.startBalance > 0 ? equity - limits.startBalance : null;

    /* Breached is about what IS, not about what was asked for: a floor nobody set cannot be
     * touched, and a daily limit of zero is off rather than met at the first cent. */
    const mll = known && floor != null && equity <= floor;
    const dll = limits.dailyLoss > 0 && dayResult <= -limits.dailyLoss;

    return {
        floor,
        known,
        highWater,
        room: floor == null || !known ? null : equity - floor,
        dayResult,
        dayRoom: limits.dailyLoss > 0 ? limits.dailyLoss + dayResult : null,
        profit,
        goalProgress: limits.profitGoal > 0 && profit != null ? profit / limits.profitGoal : null,
        goalRoom: limits.profitGoal > 0 && profit != null ? Math.max(0, limits.profitGoal - profit) : null,
        lossStreak: session.lossStreak,
        since: session.since,
        breached: mll ? 'mll' : dll ? 'dll' : null,
    };
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
 *
 * Ordered by what a breach costs: the floor ends the account, the daily limit ends the day,
 * the run of losses is a rule somebody set themselves, and the size cap is the mildest of the
 * four. The first one that answers is the one said out loud, because somebody fixing one
 * refusal at a time should be told the worst thing first.
 *
 * A profit goal refuses nothing. It is a destination rather than a limit — an account that
 * reaches it and goes on trading has broken no rule this app knows of.
 */
export function limitRefusal(
    limits: RiskLimits,
    standing: PropStanding,
    exposure: Exposure,
): string | null {
    if (!increases(exposure)) return null;

    if (standing.breached === 'mll' && standing.floor != null) {
        return `The account is at its maximum loss limit — the floor is ${money(standing.floor)} and the account is on it. `
            + 'Closing what is open still works; nothing new goes out. Check the account on your firm’s own platform.';
    }
    if (standing.breached === 'dll') {
        return `The loss limit for this session is reached — ${money(standing.dayResult)} against a limit of ${money(limits.dailyLoss)}. `
            + 'Closing what is open still works; opening something new does not, until the next session.';
    }
    if (limits.lossStreak > 0 && standing.lossStreak >= limits.lossStreak) {
        return `${standing.lossStreak} losing trades in a row, which is the run you said to stop at. `
            + 'Closing what is open still works.';
    }
    if (limits.maxSize > 0 && sizeAfter(exposure) > limits.maxSize) {
        return `That would hold ${sizeAfter(exposure)} against a limit of ${limits.maxSize}.`;
    }
    return null;
}
