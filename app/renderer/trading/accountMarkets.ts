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
/**
 * Whether the chart has moved to another instrument than the one an account was armed on.
 *
 * Compared as the provider resolves them rather than as strings: the same contract can be
 * written with and without its prefix, and a timeframe change keeps the instrument. A symbol
 * nothing resolves is another instrument — the account certainly cannot trade it.
 */
export function leftArmedMarket(
    armed: { provider: string; ticker: string } | null,
    now: { provider: string; ticker: string } | null,
): boolean {
    if (!armed) return false;
    return now?.provider !== armed.provider || now.ticker.toUpperCase() !== armed.ticker.toUpperCase();
}

/**
 * What to say about what an account leaves open on the instrument the chart has moved away from,
 * or null when it leaves nothing. Open at the venue is not the same as gone, and a chart that no
 * longer draws a position is exactly where somebody forgets they are carrying one.
 */
export function leftBehindNotice(ticker: string, left: { positions: number; orders: number }): string | null {
    const parts: string[] = [];
    if (left.positions > 0) parts.push(`${left.positions} open ${left.positions === 1 ? 'position' : 'positions'}`);
    if (left.orders > 0) parts.push(`${left.orders} working ${left.orders === 1 ? 'order' : 'orders'}`);
    if (parts.length === 0) return null;
    return `${parts.join(' and ')} on ${ticker} stay at the venue and are no longer shown here. `
        + `Switch back to ${ticker} to manage them.`;
}

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
