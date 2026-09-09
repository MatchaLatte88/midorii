/**
 * What a bot has done, and why it did not do the rest.
 *
 * A bot runs while nobody is watching, which makes "what happened" the only question worth
 * asking about one — and the hardest to answer afterwards. A bot that took no trades all
 * week is either working perfectly on a market that offered nothing, or has been refusing
 * every setup since Tuesday for a reason nobody can now reconstruct. The log is what tells
 * those two apart.
 *
 * So refusals are recorded, not just actions. Every time a guard turns a setup away it says
 * which guard and why, once — see {@link BotLog.note}, which collapses a refusal repeated
 * on every bar into one entry with a count. Without that collapsing a bot outside its
 * trading window would write an entry a minute all night and bury the trade it took at
 * four in the afternoon.
 *
 * In memory only. The log is a window onto a running bot rather than a record of one: what
 * a bot actually TRADED is a paper account or a live journal entry, and both of those are
 * on disk already. Writing this too would be a third account of the same events, free to
 * disagree with the other two.
 */

export type BotLogKind = 'info' | 'order' | 'refused' | 'error';

export interface BotLogEntry {
    at: number;
    kind: BotLogKind;
    text: string;
    /** How many times in a row this same line has happened. 1 unless it repeated. */
    count: number;
}

/** How many entries one bot keeps. A bot on 1m bars refusing all night would otherwise
 *  grow without limit; past this the oldest go, which are the ones nobody scrolls to. */
const MAX_ENTRIES = 300;

export class BotLog {
    private entries: BotLogEntry[] = [];

    /** Told whenever the log changed, so a screen showing it can repaint. */
    onChange: (() => void) | null = null;

    /** Everything on record, newest first. */
    list(): readonly BotLogEntry[] {
        return this.entries;
    }

    /** The newest entry, for a one-line status. */
    last(): BotLogEntry | null {
        return this.entries[0] ?? null;
    }

    /**
     * Record something.
     *
     * A line identical to the newest one bumps its count and its time rather than adding a
     * second copy — see the file header. Identity is the kind and the exact text, so
     * "Outside the bot's trading window" collapses and "Down 2.1% on the day" (whose figure
     * moves) does not, which is the right side to be wrong on: a changing message is a
     * changing situation.
     */
    note(kind: BotLogKind, text: string): void {
        const head = this.entries[0];
        if (head && head.kind === kind && head.text === text) {
            head.count += 1;
            head.at = Date.now();
        } else {
            this.entries.unshift({ at: Date.now(), kind, text, count: 1 });
            if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
        }
        this.onChange?.();
    }

    clear(): void {
        this.entries = [];
        this.onChange?.();
    }
}
