import { NO_LIMITS, accountStanding } from './riskLimits';
import type { HistoryRow } from '../replay/tradeBook';
import type { MllMode, PropStanding, RiskLimits } from './riskLimits';

/**
 * Each account's own limits, and the mark its floor has trailed to.
 *
 * Kept per account for the same reason the market each was last looked at is (see
 * accountMarkets.ts): the numbers belong to the ACCOUNT and not to the app. A 50k evaluation
 * and the funded account beside it come from one firm with two sets of thresholds, and a demo
 * login has none at all — one figure serving all three would be wrong for two of them.
 *
 * The key names the account, in the same spelling the trade menu already uses: `projectx:1234`,
 * `capital:live`, `paper`. So a rule set follows the account through a restart, and switching
 * accounts switches the limits with it rather than carrying the last one's over.
 *
 * The mark is stored, and that is the point
 * -----------------------------------------
 * A trailing floor is only as good as the best day it knows about. `eodHighWater` can
 * reconstruct that from the closed trades, but only as far back as the venue serves them — so
 * the mark it finds is kept here, and the higher of the stored one and the reconstructed one
 * wins. A history window that rolls forward can then never lower a floor that has already been
 * raised, which is the direction that would matter: a floor too low warns too late.
 */

const STORAGE_KEY = 'midorii-account-rules';

/**
 * The paper account's key.
 *
 * A constant rather than a literal at the one place that needs it, because the venues get
 * theirs from the trade menu and a second spelling of this one would quietly give the paper
 * account two rule sets — one written, the other read.
 */
export const PAPER_ACCOUNT_KEY = 'paper';

/** An account's rule set as it is stored. */
export interface AccountRules {
    limits: RiskLimits;
    /**
     * The highest mark the floor has trailed to, in account money.
     *
     * An equity level, not a distance. Zero means nothing has been observed yet, and the
     * starting balance stands in for it until something has.
     */
    highWater: number;
}

export const NO_RULES: AccountRules = { limits: NO_LIMITS, highWater: 0 };

const MODES: readonly MllMode[] = ['static', 'eod', 'intraday'];

/**
 * Fill in whatever a stored record is missing, and refuse whatever it cannot mean.
 *
 * Storage is data from outside the program — a record written by an older version, a
 * hand-edited one, a half-written one. A negative loss limit or a mode this version has never
 * heard of would otherwise reach the guard, which is the one place a wrong number is worst.
 */
export function normalizeRules(raw: unknown): AccountRules {
    const source = (raw ?? {}) as Partial<Record<keyof RiskLimits | 'highWater', unknown>>;
    const number = (value: unknown, fallback: number, min: number, max: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    };
    const mode = MODES.find((m) => m === source.mllMode) ?? NO_LIMITS.mllMode;

    return {
        limits: {
            dailyLoss: number(source.dailyLoss, 0, 0, 1e9),
            maxSize: number(source.maxSize, 0, 0, 1e9),
            lossStreak: number(source.lossStreak, 0, 0, 100),
            startBalance: number(source.startBalance, 0, 0, 1e12),
            maxLoss: number(source.maxLoss, 0, 0, 1e12),
            mllMode: mode,
            mllFreezeAtStart: source.mllFreezeAtStart === true,
            profitGoal: number(source.profitGoal, 0, 0, 1e12),
            onBreach: source.onBreach === 'flatten' ? 'flatten' : 'refuse',
        },
        highWater: number(source.highWater, 0, 0, 1e12),
    };
}

/** Whatever is stored, one entry per account, with anything unreadable filled in. */
export function normalizeAccountRules(raw: unknown): Record<string, AccountRules> {
    const out: Record<string, AccountRules> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [account, value] of Object.entries(raw as Record<string, unknown>)) {
        out[account] = normalizeRules(value);
    }
    return out;
}

function loadAll(): Record<string, AccountRules> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeAccountRules(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the limits kept per account', err);
        return {};
    }
}

/**
 * The three session limits an older version kept once for the whole app.
 *
 * A one-way read of a record this version no longer writes. They used to sit in the paper
 * trading settings and applied to every account at once; now each account carries its own, so
 * the old figures are the STARTING POINT for an account that has none of its own rather than
 * something silently dropped. Once that account's rules are saved, this is never consulted for
 * it again.
 */
function inheritedLimits(): Pick<RiskLimits, 'dailyLoss' | 'maxSize' | 'lossStreak'> {
    try {
        const raw = localStorage.getItem('midorii-paper-settings');
        const old = (raw == null ? {} : JSON.parse(raw)) as Record<string, unknown>;
        const number = (value: unknown): number => {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        return {
            dailyLoss: number(old.dailyLossLimit),
            maxSize: number(old.maxPositionSize),
            lossStreak: number(old.lossStreakLimit),
        };
    } catch (err) {
        console.error('[midorii] could not read the limits an older version stored', err);
        return { dailyLoss: 0, maxSize: 0, lossStreak: 0 };
    }
}

/** This account's rules, or the defaults with the old global limits folded in. */
export function loadAccountRules(account: string): AccountRules {
    const stored = loadAll()[account];
    if (stored) return stored;
    return { limits: { ...NO_LIMITS, ...inheritedLimits() }, highWater: 0 };
}

/**
 * One account as it goes to storage: the limits flat, with the mark beside them.
 *
 * Flat rather than the {@link AccountRules} shape it is read back into, so a record can be
 * looked at and edited by hand. Every entry is written through this on every save — writing
 * the read shape back for the accounts that were merely carried along is how their numbers
 * came back as zeroes, since nothing reads a nested `limits` out of a stored record.
 */
function forStorage(rules: AccountRules): Record<string, unknown> {
    return { ...rules.limits, highWater: rules.highWater };
}

export function saveAccountRules(account: string, rules: AccountRules): void {
    try {
        const all = { ...loadAll(), [account]: rules };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(
            Object.fromEntries(Object.entries(all).map(([key, value]) => [key, forStorage(value)])),
        ));
    } catch (err) {
        console.error('[midorii] could not persist the limits for this account', err);
    }
}

/**
 * The mark a rule change leaves behind.
 *
 * A mark measures one configuration. Move the starting balance — a different account, or the
 * real figure entered for the first time — or change what the floor follows, and the old mark
 * is a measurement of something else: keeping it would put the floor at a level nothing has
 * earned. So it goes back to the starting balance, which is where a fresh account's floor is
 * measured from anyway.
 *
 * Everything else leaves it alone. Raising the maximum loss or the goal does not un-happen the
 * best day the account has had.
 */
export function markAfterChange(before: RiskLimits, next: RiskLimits, mark: number): number {
    const measuresSomethingElse = before.startBalance !== next.startBalance
        || before.mllMode !== next.mllMode;
    return measuresSomethingElse ? next.startBalance : mark;
}

/** One account's live view of its own rules — what a mount holds and the guard reads. */
export interface PropGuard {
    limits(): RiskLimits;
    rules(): AccountRules;
    /**
     * What the account stands on right now.
     *
     * Where this reading passes the stored mark, the mark moves up and is written through:
     * that is the only way a trailing floor rises, and losing it to a restart would drop the
     * floor back under an account that had already earned a higher one.
     */
    read(input: { equity: number; openPnl: number; history: readonly HistoryRow[] }): PropStanding;
    /** Replace the rules — what the dialog hands back. */
    set(rules: AccountRules): void;
}

export function propGuard(account: string): PropGuard {
    let held = loadAccountRules(account);

    return {
        limits: () => held.limits,
        rules: () => held,
        read: ({ equity, openPnl, history }) => {
            const standing = accountStanding({
                limits: held.limits,
                equity,
                openPnl,
                history,
                storedHighWater: held.highWater,
            });
            if (standing.highWater > held.highWater) {
                held = { ...held, highWater: standing.highWater };
                saveAccountRules(account, held);
            }
            return standing;
        },
        set: (rules) => {
            held = rules;
            saveAccountRules(account, rules);
        },
    };
}
