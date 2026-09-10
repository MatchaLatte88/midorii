import type { MidoriBotAccount, MidoriBotAccountSnapshot } from '../midori';

/**
 * Where a bot's account, daily guards, and live ownership live between sittings.
 *
 * The account itself and the market it trades — never the bars, for the reason the chart's
 * own store gives: those are the market's, they are the same bars tomorrow, and keeping them
 * would only make the record big enough to hit a limit. A bot re-seeds its history from the
 * market when it starts (see BotRunner), which is both cheaper and more truthful than
 * carrying a stale copy of it around.
 *
 * On disk through the app's own store rather than in browser storage, again for the chart
 * account's reasons: a bot is meant to run for months, and weeks of trades plus an equity
 * curve do not belong in a five-megabyte quota shared with everything else the renderer
 * remembers — nor does a rewrite every few seconds belong on the main thread without an
 * atomic write behind it.
 */

/** How often an account is written while the feed is merely moving the mark. A fill writes
 *  immediately; ticks in between are worth at most one write a second, and only so a restart
 *  does not re-play ground the account has already covered. */
const WRITE_INTERVAL_MS = 1000;

/** One bot's stored account, or null where there is none. */
export function loadBotAccount(id: string): Promise<MidoriBotAccount | null> {
    return window.midori.bots.account.load(id);
}

export function saveBotAccount(id: string, account: MidoriBotAccountSnapshot): Promise<unknown> {
    return window.midori.bots.account.save(id, account);
}

export function clearBotAccount(id: string): Promise<boolean> {
    return window.midori.bots.account.clear(id);
}

/** Drop the accounts of bots that no longer exist. Answers how many went. */
export async function sweepBotAccounts(keep: readonly string[]): Promise<number> {
    const { removed } = await window.midori.bots.account.sweep(keep);
    return removed;
}

export interface BotAccountWriter {
    /** Write soon — at most once per {@link WRITE_INTERVAL_MS}, per bot. */
    schedule(id: string, account: MidoriBotAccountSnapshot): void;
    /**
     * Write whatever is waiting, now, and resolve once it has landed.
     *
     * Awaitable because of what happens next to an account that is being finished with: it
     * is read back to be filed as a run, and then deleted. A write still in flight would
     * arrive after the delete and put the account back — which is exactly what "start the
     * account over" then silently failed to do.
     */
    flush(): Promise<void>;
    /** Drop anything waiting and stop the timer. */
    cancel(): void;
}

/**
 * A writer that will not put a storage round trip in the middle of every tick.
 *
 * Trailing rather than leading, exactly as the chart account's is: what is worth storing is
 * the account as it ends up, not as it was when the burst started. A write that fails is
 * reported and dropped — the bot keeps running either way, and a failed write that silently
 * retried forever would be a growing queue nobody asked for.
 *
 * One writer per bot in practice (each runner holds its own), but keyed by id anyway so a
 * shared one could not confuse two accounts if anybody ever built one.
 */
export function botAccountWriter(): BotAccountWriter {
    let pending: { id: string; account: MidoriBotAccountSnapshot } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The write currently in flight, so a flush can wait for one it did not start. */
    let inFlight: Promise<void> = Promise.resolve();

    const write = (): Promise<void> => {
        timer = null;
        if (!pending) return inFlight;
        const { id, account } = pending;
        pending = null;
        /* Chained onto whatever is already going, so two writes for one bot can never land
         * out of order — the second one is the account as it ended up. */
        inFlight = inFlight
            .then(() => saveBotAccount(id, account))
            .then(() => undefined)
            .catch((err: unknown) => {
                console.error(`[midorii] could not persist the account for bot ${id}`, err);
            });
        return inFlight;
    };

    return {
        schedule(id, account): void {
            /* A pending write for a DIFFERENT bot is sent now rather than replaced. One
             * writer only ever serves one bot today, and dropping another's account on the
             * floor is not a thing to make possible by accident. */
            if (pending && pending.id !== id) write();
            pending = { id, account };
            timer ??= setTimeout(write, WRITE_INTERVAL_MS);
        },
        flush(): Promise<void> {
            if (timer != null) clearTimeout(timer);
            return write();
        },
        cancel(): void {
            if (timer != null) clearTimeout(timer);
            timer = null;
            pending = null;
        },
    };
}
