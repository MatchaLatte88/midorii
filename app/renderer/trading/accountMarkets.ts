/**
 * Which market each live account was last looked at on.
 *
 * Every account is traded on its own instrument — gold futures on a prop account, the Nasdaq
 * CFD on a Capital.com one — and switching between them is a switch of both. So the chart the
 * account was left on is kept per account, and arming that account again brings it back
 * rather than refusing because the chart is still showing the other one.
 *
 * Symbol AND timeframe: the pair is how that account is watched, and a futures scalp on one
 * minute put back on the four-hour view the other account was on is not "where it was left".
 *
 * The key names the ACCOUNT, not the venue, wherever the venue can hold more than one: a
 * ProjectX key reaches an evaluation and funded accounts, and a demo login is not the live one.
 */

const STORAGE_KEY = 'midorii-account-markets';

export interface AccountMarket {
    symbol: string;
    timeframe: string;
}

/** Whatever is stored, with any entry that is not a usable market dropped. */
export function normalizeAccountMarkets(raw: unknown): Record<string, AccountMarket> {
    const out: Record<string, AccountMarket> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [account, value] of Object.entries(raw as Record<string, unknown>)) {
        const row = value as Partial<AccountMarket> | null;
        if (typeof row?.symbol === 'string' && row.symbol && typeof row.timeframe === 'string' && row.timeframe) {
            out[account] = { symbol: row.symbol, timeframe: row.timeframe };
        }
    }
    return out;
}

function loadAll(): Record<string, AccountMarket> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeAccountMarkets(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the markets remembered per account', err);
        return {};
    }
}

export function loadAccountMarket(account: string): AccountMarket | null {
    return loadAll()[account] ?? null;
}

export function saveAccountMarket(account: string, market: AccountMarket): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadAll(), [account]: market }));
    } catch (err) {
        console.error('[midorii] could not persist the market for this account', err);
    }
}

/**
 * The market arming an account on `provider` should put the chart on.
 *
 * The one it was left on, while this venue still serves it; else the market already on
 * screen when that one is this venue's, keeping its timeframe (`null`); else nothing — the
 * person has to choose one.
 */
export function marketForAccount(
    remembered: AccountMarket | null,
    onScreen: string,
    provider: string,
    providerOf: (symbol: string) => string | null,
): { symbol: string; timeframe: string | null } | null {
    if (remembered && providerOf(remembered.symbol) === provider) return remembered;
    if (onScreen && providerOf(onScreen) === provider) return { symbol: onScreen, timeframe: null };
    return null;
}
