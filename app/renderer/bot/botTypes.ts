import { STRATEGIES, resolveStrategyParams } from '../strategies';
import { resolveGuards } from '../strategies/liveGuards';
import type { MidoriBot } from '../midori';
import type { StrategyParams } from '../strategies/types';

/**
 * What a trading bot is.
 *
 * A strategy, a market, and the permissions to run it without anybody watching. Those three
 * things are separate on purpose:
 *
 *   the STRATEGY  says what a setup is and what to do about it. It is the same object a
 *                 backtest runs, unchanged — that is the whole point, because a bot whose
 *                 rules differed from the ones that were tested is a bot nobody has tested.
 *   the MARKET    is which instrument and which bars. A strategy carries no symbol; two
 *                 bots can run the same one on two markets and neither is a copy of it.
 *   the GUARDS    are what the bot may do unattended — hours, limits, a stale feed. None of
 *                 them can open a trade; every one can refuse one. See liveGuards.ts.
 *
 * The venue is a property of the bot, not of the account
 * -----------------------------------------------------
 * A bot points at paper or at Capital.com and each bot brings its own account with it: a
 * paper bot gets a fresh engine of its own rather than sharing the chart's paper account,
 * and a live bot gets its own view of the venue. Sharing one account between the chart and
 * a bot would mean a hand-placed trade and an automated one landing in the same position
 * ledger, where neither could be told from the other afterwards.
 */

/** Which broker a bot's orders go to. */
export type BotVenue = 'paper' | 'capital';

export interface BotConfig {
    id: string;
    /** What the person calls it. Never used as a key. */
    name: string;
    /** The strategy's registry id. */
    strategy: string;
    /** The market, provider-prefixed: `capital:EURUSD`, `binance:BTCUSDT`. */
    symbol: string;
    /** The bars the strategy is fed. Vela's canonical spelling — a bare number is minutes. */
    timeframe: string;
    venue: BotVenue;
    /** The strategy's own settings, as stored. Resolved against the schema before use. */
    params: Record<string, unknown>;
    /** The live guards, as stored. Resolved the same way. */
    guards: Record<string, unknown>;
    /** Starting cash for a paper bot. A live bot has the venue's own account. */
    balance: number;
    /**
     * Whether this bot should be running.
     *
     * Restored on startup for PAPER bots only. A live bot is never resumed by itself — a
     * real account must be armed by a person each time the app starts, which is the same
     * rule the chart's Trade menu follows for Capital.com.
     */
    enabled: boolean;
    createdAt: number;
}

/**
 * How many bars of history a bot runs on.
 *
 * Both the depth loaded before it starts and the size it is trimmed back to — one number,
 * because they are one thing: the stretch the detectors get to see. Enough for a daily ATR
 * over 200 sessions on a 5m chart; a strategy that needs more says so by producing nothing
 * until it has it.
 *
 * The number is a cost as much as a depth. A bot rebuilds its strategy over this whole
 * stretch every time a bar closes (see BotRunner), and that cost grows faster than the bar
 * count does — measured on this machine, the heaviest of the three strategies takes 8ms over
 * 1,500 bars, 15ms over 3,000, 25ms over 5,000 and 142ms over 20,000. At this size a bar
 * close is around 15ms once every one to five minutes; unbounded, a bot left running for a
 * fortnight on one-minute bars would be stalling the window every minute.
 */
export const HISTORY_BARS = 3000;

/**
 * Where the history is trimmed even though the strategy is still holding something.
 *
 * The ordinary trim waits until the strategy has nothing that a shifted history could
 * invalidate (see BotRunner's `trim`), which for every strategy in this app comes round
 * several times a day. This is the backstop for one that never lets go: past it the history
 * is cut and the strategy's state is dropped with it, loudly, because a bot quietly taking
 * half a second per bar is a worse failure than a bot that says it has forgotten where it was.
 *
 * Four times the window: the heaviest strategy is around 65ms there, which is a delay nobody
 * watching a chart would notice on a bar that closes once a minute at the fastest, and no
 * strategy in this app has ever reached it.
 */
export const MAX_HISTORY_BARS = HISTORY_BARS * 4;

export const DEFAULT_TIMEFRAME = '5';

/** The venues a bot can be pointed at, as the form lists them. */
export const VENUE_OPTIONS = [
    { value: 'paper', label: 'Paper account' },
    { value: 'capital', label: 'Capital.com' },
] as const;

/** A fresh bot on a strategy's own defaults. */
export function newBot(strategy: string, symbol: string): BotConfig {
    const spec = STRATEGIES[strategy];
    return {
        id: `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name: spec ? `${spec.name} bot` : 'New bot',
        strategy,
        symbol,
        timeframe: DEFAULT_TIMEFRAME,
        venue: 'paper',
        params: {},
        guards: {},
        balance: 10_000,
        enabled: false,
        createdAt: Date.now(),
    };
}

/**
 * Fill in whatever a stored record is missing, and refuse whatever it cannot mean.
 *
 * Storage is data from outside the program — a file written by an older build, a
 * hand-edited entry. A bot with no strategy or no market cannot be started, and finding
 * that out at the moment it would have sent an order is the worst place to find it out.
 * Returns null for a record that is not a bot at all; the caller drops it and says so.
 */
export function normalizeBot(raw: unknown): BotConfig | null {
    const source = (raw ?? {}) as Partial<Record<keyof BotConfig, unknown>>;
    if (typeof source.id !== 'string' || !source.id.trim()) return null;
    if (typeof source.strategy !== 'string' || !source.strategy.trim()) return null;

    const balance = Number(source.balance);
    return {
        id: source.id,
        name: typeof source.name === 'string' && source.name.trim() ? source.name : 'Bot',
        strategy: source.strategy,
        symbol: typeof source.symbol === 'string' ? source.symbol : '',
        timeframe: typeof source.timeframe === 'string' && source.timeframe ? source.timeframe : DEFAULT_TIMEFRAME,
        venue: source.venue === 'capital' ? 'capital' : 'paper',
        params: isRecord(source.params) ? source.params : {},
        guards: isRecord(source.guards) ? source.guards : {},
        balance: Number.isFinite(balance) && balance > 0 ? balance : 10_000,
        enabled: source.enabled === true,
        createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** A bot on its way to storage. Identical today; its own function so the two directions
 *  stay separable when one of them has to change. */
export function toStored(bot: BotConfig): MidoriBot {
    return { ...bot };
}

/**
 * Why this bot cannot be started, or null when it can.
 *
 * Checked before anything is subscribed to or any account is built, so a misconfigured bot
 * fails on the button that started it rather than three seconds later in a log nobody is
 * reading.
 */
export function startRefusal(bot: BotConfig): string | null {
    if (!STRATEGIES[bot.strategy]) {
        return `This build has no strategy called "${bot.strategy}".`;
    }
    if (!bot.symbol.trim()) return 'This bot has no market to trade.';
    if (bot.venue === 'capital' && !bot.symbol.startsWith('capital:')) {
        return 'A Capital.com bot has to run on a Capital.com market — pick one from the symbol list.';
    }
    try {
        resolveStrategyParams(bot.strategy, bot.params);
    } catch (err) {
        return `The strategy settings no longer fit: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
        resolveGuards(bot.guards);
    } catch (err) {
        return `The live conditions no longer fit: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
}

/** The bot's strategy settings, resolved. Throws exactly where {@link startRefusal} reports. */
export function paramsOf(bot: BotConfig): StrategyParams {
    return resolveStrategyParams(bot.strategy, bot.params);
}

/** The bot's live guards, resolved. */
export function guardParamsOf(bot: BotConfig): StrategyParams {
    return resolveGuards(bot.guards);
}

/** `"capital:EURUSD"` → `"capital"`, or null on a bare symbol. */
export function providerOf(symbol: string): string | null {
    const i = symbol.indexOf(':');
    return i > 0 ? symbol.slice(0, i).toLowerCase() : null;
}

/** `"capital:EURUSD"` → `"EURUSD"`. */
export function tickerOf(symbol: string): string {
    const i = symbol.indexOf(':');
    return i > 0 ? symbol.slice(i + 1) : symbol;
}
