import { resolveParams, formatClock } from './index';
import type { StrategyParam, StrategyParams } from './types';

/**
 * What a strategy needs answering before it may trade unattended.
 *
 * A backtest runs a strategy over a fixed stretch of history and stops. Nothing about it
 * has to decide when to start, when to give up for the day, or what to do about a feed
 * that has gone quiet — the range is the answer to all three. A bot has no range. It runs
 * until somebody stops it, on a market that closes, through nights the person who started
 * it is asleep through, and every one of those questions becomes a real one.
 *
 * So these are not strategy settings and they are deliberately not stored with the
 * strategy. The same Relative Volume ORB is one strategy whether it is backtested, replayed
 * or run by a bot; what changes is what the BOT is allowed to do with it. A strategy that
 * carried a daily loss limit would be a strategy whose backtest silently differed from its
 * live behaviour, which is the one difference that must never exist.
 *
 * Why they are guards rather than rules
 * ------------------------------------
 * Nothing here ever opens a trade. Every one of them can only refuse one, or close what is
 * already open. That asymmetry is the whole design: a bug in a guard can cost an
 * opportunity, never a position nobody asked for. When the strategy and a guard disagree,
 * the guard wins and says why — see {@link guardRefusal}.
 *
 * Times are UTC
 * -------------
 * Deliberately, and stated on every field. A local clock would mean a bot that traded an
 * hour earlier for half the year, silently, on the machine's own daylight-saving rules —
 * and a session window is the one setting where being an hour out is indistinguishable
 * from working until it costs a trade. The Relative Volume ORB's own session handling is
 * separate and unaffected: that follows the New York clock, because a market open is a
 * property of the market, not of the bot watching it.
 */

/** The days of the week, in the order a week is read. `Date#getUTCDay` order is Sunday-first;
 *  the values below carry the index so nothing has to translate. */
const DAY_OPTIONS = [
    { value: '1', label: 'Mon' },
    { value: '2', label: 'Tue' },
    { value: '3', label: 'Wed' },
    { value: '4', label: 'Thu' },
    { value: '5', label: 'Fri' },
    { value: '6', label: 'Sat' },
    { value: '0', label: 'Sun' },
] as const;

export const LIVE_GUARD_PARAMS: readonly StrategyParam[] = [
    {
        key: 'tradingDays',
        label: 'Trading days',
        type: 'multi',
        default: ['1', '2', '3', '4', '5'],
        hint: 'Which days of the week, in UTC, the bot may open a trade on. Monday to Friday '
            + 'by default, which is when the markets this app can reach are open. Turning a day '
            + 'off never closes what is already running — see “Flat at the window’s end”.',
        options: DAY_OPTIONS,
    },
    {
        key: 'sessionStart',
        label: 'Trade from (UTC)',
        type: 'time',
        default: 0,
        hint: 'The first minute of the day the bot may open a trade in, in UTC. Equal to the '
            + 'end time means the whole day, which is what a bot on a market that never closes '
            + 'wants. A window that ends before it starts wraps over midnight — 22:00 to 06:00 '
            + 'is the Asian session, not an empty window.',
    },
    {
        key: 'sessionEnd',
        label: 'Trade until (UTC)',
        type: 'time',
        default: 0,
        hint: 'The last minute of the day the bot may open a trade in, in UTC. After it the bot '
            + 'stops opening; whether it also closes what is open is the next setting.',
    },
    {
        key: 'flattenAtEnd',
        label: 'Flat at the window’s end',
        type: 'bool',
        default: false,
        hint: 'On, everything the bot has open is closed at market when the trading window '
            + 'ends, and its resting orders are cancelled — what somebody who does not want to '
            + 'hold overnight means. Off, an open position is left to its own stop and target, '
            + 'which is what a strategy that holds through the close needs. Off by default: '
            + 'closing a position nobody asked to close is the more expensive mistake.',
    },
    {
        key: 'maxTradesPerDay',
        label: 'Max trades per day',
        type: 'number',
        default: 0,
        min: 0,
        max: 500,
        step: 1,
        hint: 'How many positions the bot may open in one UTC day. 0 is no limit. This counts '
            + 'entries, not round trips — a strategy that scales in twice has used two.',
    },
    {
        key: 'maxOpenPositions',
        label: 'Max open positions',
        type: 'number',
        default: 1,
        min: 1,
        max: 50,
        step: 1,
        hint: 'How many positions the bot may hold at once. 1 is one trade at a time, which is '
            + 'what every strategy in this app is written for; higher only makes sense on a '
            + 'hedging account whose strategy deliberately stacks.',
    },
    {
        key: 'dailyLossLimit',
        label: 'Daily loss limit (%)',
        type: 'number',
        default: 0,
        min: 0,
        max: 100,
        step: 0.5,
        hint: 'How far the account may fall below where it started the UTC day before the bot '
            + 'stops opening for the rest of it, as a percentage of that starting equity. 0 is '
            + 'off. Measured against equity, so an open position moving against you counts — a '
            + 'limit that only saw booked losses would let one trade run past it.',
    },
    {
        key: 'dailyProfitTarget',
        label: 'Daily profit target (%)',
        type: 'number',
        default: 0,
        min: 0,
        max: 1000,
        step: 0.5,
        hint: 'How far above the day’s starting equity the bot may get before it stops opening '
            + 'for the rest of the day. 0 is off. The mirror of the loss limit and the same '
            + 'measurement — it is a reason to stop, not a target that closes anything.',
    },
    {
        key: 'cooldownMinutes',
        label: 'Cooldown after a loss (min)',
        type: 'number',
        default: 0,
        min: 0,
        max: 1440,
        step: 5,
        hint: 'How long the bot waits after a losing trade before it may open another. 0 is off. '
            + 'What it is for is a market that has just moved through the strategy’s setup and '
            + 'is about to offer the same one again a minute later.',
    },
    {
        key: 'maxSpreadPct',
        label: 'Max spread (%)',
        type: 'number',
        default: 0,
        min: 0,
        max: 10,
        step: 0.01,
        hint: 'How wide the bid/ask may be, as a percentage of price, for the bot to open '
            + 'anything. 0 is off. It is what keeps a bot out of the minutes around a market’s '
            + 'open and close, where the spread alone can cost more than the trade was sized to '
            + 'risk. Only has an effect where the venue quotes two sides.',
    },
    {
        key: 'staleFeedSeconds',
        label: 'Stale feed after (s)',
        type: 'number',
        default: 120,
        min: 0,
        max: 3600,
        step: 10,
        hint: 'How long the bot may go without an update from the feed before it refuses to open '
            + 'anything. 0 is off, which means a bot will keep trading on a price that stopped '
            + 'arriving an hour ago — the single most expensive thing an unattended strategy can '
            + 'do. Raise it on a slow market rather than switching it off.',
    },
];

export const LIVE_GUARD_KEYS: readonly string[] = LIVE_GUARD_PARAMS.map((p) => p.key);

/** The guards as the runner reads them — the schema resolved, and typed. */
export interface LiveGuards {
    /** `Date#getUTCDay` values the bot may open on. */
    tradingDays: readonly number[];
    /** Minutes since UTC midnight. Equal start and end means the whole day. */
    sessionStart: number;
    sessionEnd: number;
    flattenAtEnd: boolean;
    /** 0 is no limit, on all four of these. */
    maxTradesPerDay: number;
    maxOpenPositions: number;
    dailyLossLimit: number;
    dailyProfitTarget: number;
    cooldownMinutes: number;
    maxSpreadPct: number;
    staleFeedSeconds: number;
}

/** Validate stored guards against the schema and fill in whatever is missing. Throws on a
 *  value the schema cannot mean, exactly as a strategy's own settings do. */
export function resolveGuards(raw: Readonly<Record<string, unknown>> = {}): StrategyParams {
    return resolveParams(LIVE_GUARD_PARAMS, raw, 'guards');
}

/** The resolved values as the runner's own struct. */
export function guardsOf(params: StrategyParams): LiveGuards {
    const num = (key: string): number => {
        const value = params[key];
        return typeof value === 'number' ? value : 0;
    };
    const days = Array.isArray(params.tradingDays) ? (params.tradingDays as readonly string[]) : [];
    return {
        tradingDays: days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        sessionStart: num('sessionStart'),
        sessionEnd: num('sessionEnd'),
        flattenAtEnd: params.flattenAtEnd === true,
        maxTradesPerDay: num('maxTradesPerDay'),
        maxOpenPositions: num('maxOpenPositions'),
        dailyLossLimit: num('dailyLossLimit'),
        dailyProfitTarget: num('dailyProfitTarget'),
        cooldownMinutes: num('cooldownMinutes'),
        maxSpreadPct: num('maxSpreadPct'),
        staleFeedSeconds: num('staleFeedSeconds'),
    };
}

/** Where the bot stands right now, as far as the guards are concerned. */
export interface GuardState {
    /** Wall clock the decision is being made at. */
    now: number;
    /** What the account is worth right now. */
    equity: number;
    /** What it was worth at the first update of this UTC day. */
    dayOpenEquity: number;
    /** Positions the bot has opened and not yet closed. */
    openPositions: number;
    /** Entries it has made today. */
    tradesToday: number;
    /** When its last losing trade closed, or null if it has not had one. */
    lastLossAt: number | null;
    /** When the feed last spoke, or null before it ever has. */
    lastTickAt: number | null;
    /** The two sides of the book, where the venue quotes them. */
    spread: { bid: number; ask: number } | null;
}

/** Whether `now` falls inside the bot's trading window. Exported for the screen that has to
 *  say whether a bot is inside its hours without asking to place an order first. */
export function insideWindow(guards: LiveGuards, now: number): boolean {
    const date = new Date(now);
    if (!guards.tradingDays.includes(date.getUTCDay())) return false;

    const { sessionStart: from, sessionEnd: to } = guards;
    // Equal ends mean the whole day — the only way to say "no window" on a market that
    // never closes, and the default.
    if (from === to) return true;

    const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
    // A window that ends before it starts wraps over midnight: 22:00–06:00 is one window,
    // not an empty one.
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * Why the bot may not open anything right now, in one sentence, or null when it may.
 *
 * Ordered so the most fundamental refusal is the one reported: a bot outside its hours has
 * nothing to say about its spread. Everything here refuses only ENTRIES — managing what is
 * already open (a stop being moved, a position being closed) is never blocked, because a
 * guard that could strand a live position would be a guard that costs more than it saves.
 */
export function guardRefusal(guards: LiveGuards, state: GuardState): string | null {
    if (!insideWindow(guards, state.now)) {
        return guards.sessionStart === guards.sessionEnd
            ? 'Outside the bot’s trading days.'
            : `Outside the bot’s trading window (${formatClock(guards.sessionStart)}–${formatClock(guards.sessionEnd)} UTC).`;
    }

    if (guards.staleFeedSeconds > 0) {
        if (state.lastTickAt == null) return 'The feed has not spoken yet.';
        const age = (state.now - state.lastTickAt) / 1000;
        if (age > guards.staleFeedSeconds) {
            return `The feed has been quiet for ${Math.round(age)}s — nothing is sent on a price that old.`;
        }
    }

    if (state.openPositions >= guards.maxOpenPositions) {
        return guards.maxOpenPositions === 1
            ? 'The bot already has a position open.'
            : `The bot already holds ${state.openPositions} positions, which is its limit.`;
    }

    if (guards.maxTradesPerDay > 0 && state.tradesToday >= guards.maxTradesPerDay) {
        return `The bot has taken its ${guards.maxTradesPerDay} trades for today.`;
    }

    /* Measured against the day's own opening equity rather than the account's lifetime
     * figures: a limit that counted from the account's start would fire once and never
     * reset, and one that counted only booked results would let a single open trade run
     * straight through it. */
    if (state.dayOpenEquity > 0) {
        const movePct = ((state.equity - state.dayOpenEquity) / state.dayOpenEquity) * 100;
        if (guards.dailyLossLimit > 0 && movePct <= -guards.dailyLossLimit) {
            return `Down ${Math.abs(movePct).toFixed(2)}% on the day, at or past the ${guards.dailyLossLimit}% limit.`;
        }
        if (guards.dailyProfitTarget > 0 && movePct >= guards.dailyProfitTarget) {
            return `Up ${movePct.toFixed(2)}% on the day, at or past the ${guards.dailyProfitTarget}% target.`;
        }
    }

    if (guards.cooldownMinutes > 0 && state.lastLossAt != null) {
        const waited = (state.now - state.lastLossAt) / 60_000;
        if (waited < guards.cooldownMinutes) {
            const left = Math.ceil(guards.cooldownMinutes - waited);
            return `Cooling off after a loss — ${left} more ${left === 1 ? 'minute' : 'minutes'}.`;
        }
    }

    if (guards.maxSpreadPct > 0 && state.spread) {
        const { bid, ask } = state.spread;
        const mid = (bid + ask) / 2;
        if (mid > 0) {
            const spreadPct = ((ask - bid) / mid) * 100;
            if (spreadPct > guards.maxSpreadPct) {
                return `The spread is ${spreadPct.toFixed(3)}%, wider than the ${guards.maxSpreadPct}% this bot will trade.`;
            }
        }
    }

    return null;
}
