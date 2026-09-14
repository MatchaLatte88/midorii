import type { MidoriTick } from '../midori';

/**
 * A recording, read a stretch at a time for a replay to play.
 *
 * A busy day of prints and quotes is far too much to carry across the bridge in one go, and a
 * replay only ever needs the next few minutes of it. So a window of market time is held here
 * and moved forward as the playhead reaches its end — the main process keeps the day parsed,
 * so each move is a slice rather than a decompression.
 *
 * The window is always a contiguous stretch starting at or before what was last asked for, so
 * an answer is either wholly inside what is held or loaded fresh — never stitched from two reads
 * that might disagree about the events on the seam.
 */

/** How much market time one load covers. At thirty times real speed that is a minute of play. */
const WINDOW_MS = 30 * 60_000;
/** How far ahead a search for the next event gives up: past this, the recording has ended. */
const HORIZON_MS = 7 * 24 * 60 * 60_000;

export type TickReader = (request: { name: string; from: number; to: number }) => Promise<MidoriTick[]>;

export class TickFeed {
    private events: MidoriTick[] = [];
    private from = 0;
    private to = 0;

    constructor(
        /** The recording's name — the contract, `NQU6`. */
        readonly source: string,
        private readonly read: TickReader = (request) => window.midori.ticks.read(request),
    ) {}

    /** The events in [from, until), oldest first. */
    async between(from: number, until: number): Promise<MidoriTick[]> {
        if (!(until > from)) return [];
        if (from < this.from || until > this.to) await this.load(from, Math.max(until, from + WINDOW_MS));
        return this.slice(from, until);
    }

    /**
     * When the next event at or after `from` happens, or null where nothing is recorded within
     * a week of it — the recording has ended. What lets a replay skip the dead air of a night
     * without playing through it in real time.
     */
    async nextAfter(from: number): Promise<number | null> {
        for (let span = WINDOW_MS; span <= HORIZON_MS; span *= 4) {
            const events = await this.between(from, from + span);
            if (events.length > 0) return events[0]![0];
        }
        return null;
    }

    private async load(from: number, to: number): Promise<void> {
        this.events = await this.read({ name: this.source, from, to });
        this.from = from;
        this.to = to;
    }

    private slice(from: number, until: number): MidoriTick[] {
        const events = this.events;
        let lo = 0;
        let hi = events.length;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (events[mid]![0] < from) lo = mid + 1;
            else hi = mid;
        }
        const out: MidoriTick[] = [];
        for (let i = lo; i < events.length && events[i]![0] < until; i++) out.push(events[i]!);
        return out;
    }
}
