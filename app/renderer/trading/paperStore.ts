/**
 * Where a paper account lives between sittings.
 *
 * The account itself, and the market and moment it stands at — never the bars.
 * Those are the market's, they are the same bars tomorrow, and keeping them would
 * only make the record big enough to hit a storage limit. What matters is the
 * moment, because from it the gap to now can be fetched and played (see
 * paperCatchUp), which is what makes picking the account back up honest rather
 * than merely convenient.
 *
 * On disk, through the app's own store (app/electron/data/store/paperStore.js),
 * because this account is meant to run for months: weeks of trades and an equity
 * curve do not belong in a five-megabyte quota shared with every other thing the
 * renderer remembers, and a rewrite every few seconds wants an atomic one.
 *
 * The MODE — which broker the chart was last wired to — stays in localStorage.
 * It is one word, it belongs to this machine's window rather than to the account,
 * and reading it must not wait on a round trip before the chart can paint.
 */

const BROKER_KEY = 'midorii-trade-broker';

/** Where the account used to live, and still does on a machine that has not upgraded. */
const LEGACY_ACCOUNT_KEY = 'midorii-paper-account';

/** How often the account is written while the feed is merely moving the mark. A fill
 *  or a click writes immediately; ticks in between are worth at most one write a
 *  second, and only so a restart does not re-play ground already covered. */
const WRITE_INTERVAL_MS = 1000;

export interface PaperAccountRecord {
    /** The market the account trades. */
    symbol: string;
    /** A `LiveSession.snapshot()`. */
    session: unknown;
    /** When it was written. */
    savedAt: number;
}

/**
 * The stored account, or null where there is none.
 *
 * An account left behind in localStorage by an earlier version is moved across on
 * the way past — a paper account is weeks of work, and dropping it because it was
 * stored somewhere else last month would be the worst possible upgrade.
 */
export async function loadPaperAccount(): Promise<PaperAccountRecord | null> {
    const stored = await window.midori.paper.load();
    if (stored) return { symbol: stored.symbol, session: stored.session, savedAt: stored.savedAt };

    const legacy = readLegacyAccount();
    if (!legacy) return null;

    await savePaperAccount(legacy);
    dropLegacyAccount();
    console.info('[midorii] moved the paper account out of browser storage and onto disk');
    return legacy;
}

export async function savePaperAccount(account: { symbol: string; session: unknown }): Promise<void> {
    await window.midori.paper.save(account);
}

export async function clearPaperAccount(): Promise<void> {
    await window.midori.paper.clear();
    dropLegacyAccount();
}

/** The account an older version left in browser storage, if it is still readable. */
function readLegacyAccount(): PaperAccountRecord | null {
    let raw: string | null;
    try {
        raw = localStorage.getItem(LEGACY_ACCOUNT_KEY);
    } catch {
        return null;
    }
    if (raw == null) return null;

    try {
        const record = JSON.parse(raw) as { version?: number; symbol?: string; session?: unknown; savedAt?: number };
        if (record.version !== 1 || typeof record.symbol !== 'string' || record.session == null) return null;
        return { symbol: record.symbol, session: record.session, savedAt: record.savedAt ?? 0 };
    } catch {
        return null;
    }
}

function dropLegacyAccount(): void {
    try {
        localStorage.removeItem(LEGACY_ACCOUNT_KEY);
    } catch {
        /* Nothing to clean up, or storage is unavailable — either way the disk record wins. */
    }
}

export interface PaperWriter {
    /** Write soon — at most once per {@link WRITE_INTERVAL_MS}. */
    schedule(account: { symbol: string; session: unknown }): void;
    /** Write whatever is waiting, now. */
    flush(): void;
    /** Drop anything waiting and stop the timer. */
    cancel(): void;
}

/**
 * A writer that will not put a storage round trip in the middle of every tick.
 *
 * Trailing rather than leading: what is worth storing is the account as it ends up,
 * not as it was when the burst started. A write that fails is reported and dropped —
 * the account keeps running either way, and a failed write that silently retried
 * forever would be a growing queue nobody asked for.
 */
export function paperWriter(): PaperWriter {
    let pending: { symbol: string; session: unknown } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const write = (): void => {
        timer = null;
        if (!pending) return;
        const account = pending;
        pending = null;
        void savePaperAccount(account).catch((err: unknown) => (
            console.error('[midorii] could not persist the paper account', err)
        ));
    };

    return {
        schedule(account): void {
            pending = account;
            timer ??= setTimeout(write, WRITE_INTERVAL_MS);
        },
        flush(): void {
            if (timer != null) clearTimeout(timer);
            write();
        },
        cancel(): void {
            if (timer != null) clearTimeout(timer);
            timer = null;
            pending = null;
        },
    };
}

/**
 * Which broker the chart was last wired to.
 *
 * Stored for the same reason the account is: a mode you left something running in is a
 * mode you come back to. It is also what makes the catch-up happen by itself — an
 * account whose stop was hit overnight should say so on the way in, not the next time
 * somebody happens to open the Trade menu.
 */
export function loadActiveBroker(): string | null {
    try {
        return localStorage.getItem(BROKER_KEY);
    } catch (err) {
        console.error('[midorii] could not read the stored trade mode', err);
        return null;
    }
}

export function saveActiveBroker(id: string): void {
    try {
        localStorage.setItem(BROKER_KEY, id);
    } catch (err) {
        console.error('[midorii] could not persist the trade mode', err);
    }
}
