import { ReplaySession } from '../../../shared/engine/replaySession.js';
import type { Broker } from '../../../shared/engine/broker.js';
import type { MidoriTick } from '../midori';
import { OP_REFS, REPLAY_OPS, applyOp, type ReplayOp } from './replayOps';
import type { ReplayWindow } from './replayWindow';

/**
 * What a replay has done, so it can be put back to any earlier candle.
 *
 * "Jump back here" means: the account as it stood when that candle first appeared, and
 * nothing that was done from then on. Trades taken after it are not hidden or marked — they
 * never happened, and the figures say so.
 *
 * Why the account is rebuilt rather than snapshotted
 * --------------------------------------------------
 * A snapshot per candle would be the obvious way and is the wrong one. A session with a
 * hundred trades snapshots to most of a megabyte, and a day of one-minute candles is several
 * hundred of them. Stepping is the opposite: five thousand candles through the engine take
 * under a millisecond, and the engine is deterministic — the same bars, the same prints and the
 * same calls give the same account, fill for fill.
 *
 * So what is kept is where the session BEGAN (one snapshot) and every call that changed the
 * account since, with the instant it was made at. Going back to a candle is restoring the
 * beginning and doing everything again up to that candle, and not past it.
 *
 * What makes that exact
 * ---------------------
 * - **Every account call is recorded** — the controller routes them all through one table
 *   (replayOps.ts), and the rebuild runs the same table.
 * - **Timeframe changes are recorded** as the instant they happened at, and the rebuild loads
 *   the same window at the same instant, so the stretch played on the hourly chart is played
 *   on the hourly chart again.
 * - **Switches between candles and ticks are recorded** the same way, and a stretch played on
 *   ticks is played on the same recorded ticks again. The engine gives the same account however
 *   a stretch of ticks is cut up, so the rebuild does not need to know how it was.
 * - **Positions and orders are carried as WHICH one, not as a number.** Ids come off a counter
 *   the whole app shares, so a rebuilt account numbers them differently. An order is named by
 *   where it stands in the account's list of orders — a list that is only ever added to — and a
 *   position by the order that opened it.
 *
 * What it refuses
 * ---------------
 * Anything that no longer lines up — bars that have changed on disk since, an order the engine
 * now refuses — stops the rebuild with the reason. An account quietly rebuilt differently from
 * the one that was traded would be a result nobody earned.
 */

export type PlayMode = 'bars' | 'ticks';

/** Where the journal begins: the session as it stood, and how it was being played. */
export interface JournalOrigin {
    /** `ReplaySession.snapshot()`. */
    snapshot: unknown;
    timeframe: string;
    clock: number;
    /** The recording a stretch played on ticks is read from, or null where there is none. */
    ticks: string | null;
}

export type JournalEntry =
    | { kind: 'op'; clock: number; op: ReplayOp; args: unknown[] }
    | { kind: 'retime'; clock: number; timeframe: string }
    | { kind: 'mode'; clock: number; mode: PlayMode };

/** The journal as it is stored with a parked session. */
export interface JournalRecord {
    version: 2;
    origin: JournalOrigin;
    entries: JournalEntry[];
    /**
     * The first instant a call was made that could not be written down, or null.
     *
     * Should never be set. Where it is, the session cannot be rebuilt past it, and a jump to a
     * later candle is refused rather than rebuilt wrong.
     */
    brokenAt: number | null;
}

/** A value with its references and its `undefined`s made storable. */
type Encoded = unknown;

export class ReplayJournal {
    readonly origin: JournalOrigin;
    private readonly entries: JournalEntry[];
    private brokenAt: number | null;

    private constructor(record: JournalRecord) {
        this.origin = record.origin;
        this.entries = record.entries.map((e) => ({ ...e }));
        this.brokenAt = record.brokenAt;
    }

    /** A journal starting from where `session` stands now, played on bars. */
    static begin(session: ReplaySession, timeframe: string, ticks: string | null = null): ReplayJournal {
        return ReplayJournal.startingFrom({ snapshot: session.snapshot(), timeframe, clock: session.clock, ticks });
    }

    /** A journal holding only its beginning. */
    static startingFrom(origin: JournalOrigin): ReplayJournal {
        return new ReplayJournal({ version: 2, origin, entries: [], brokenAt: null });
    }

    /**
     * Pick a stored journal back up. Throws on something that is not a journal this version
     * can rebuild from.
     */
    static fromRecord(raw: unknown): ReplayJournal {
        const record = raw as Partial<JournalRecord> | null;
        if (!record || record.version !== 2 || !record.origin || !Array.isArray(record.entries)
            || !Number.isFinite(record.origin.clock) || typeof record.origin.timeframe !== 'string') {
            throw new Error('This is not a replay journal this version can read.');
        }
        let last = record.origin.clock;
        for (const entry of record.entries) {
            if (!Number.isFinite(entry.clock) || entry.clock < last) {
                throw new Error('The replay journal is out of order.');
            }
            if (entry.kind === 'op' && !REPLAY_OPS.includes(entry.op)) {
                throw new Error(`The replay journal names a call this version does not know: ${String(entry.op)}.`);
            }
            if (entry.kind !== 'op' && entry.kind !== 'retime' && entry.kind !== 'mode') {
                throw new Error('The replay journal holds an entry this version does not know.');
            }
            last = entry.clock;
        }
        return new ReplayJournal({
            version: 2,
            origin: { ...record.origin, ticks: record.origin.ticks ?? null },
            entries: record.entries,
            brokenAt: record.brokenAt ?? null,
        });
    }

    toRecord(): JournalRecord {
        return {
            version: 2,
            origin: this.origin,
            entries: this.entries.map((e) => ({ ...e })),
            brokenAt: this.brokenAt,
        };
    }

    /** Whether anything was done at this instant — what going back to the candle on screen undoes. */
    hasEntriesAt(clock: number): boolean {
        return this.entries.some((e) => e.clock === clock);
    }

    /** The instant a rebuild cannot go past, or null. */
    get unrecordableFrom(): number | null {
        return this.brokenAt;
    }

    /** Everything recorded, oldest first. */
    get recorded(): readonly JournalEntry[] {
        return this.entries;
    }

    /**
     * The call about to be made, in storable form — asked BEFORE it is made, since a close
     * takes away the very position it names.
     *
     * Null where a reference cannot be resolved. The caller still makes the call (the engine's
     * own refusal is the better message, and it usually comes) and marks the journal if the
     * call then goes through anyway.
     */
    encode(broker: Broker, op: ReplayOp, args: readonly unknown[]): Encoded[] | null {
        try {
            return encodeArgs(op, args, identify(broker));
        } catch {
            return null;
        }
    }

    /** Write down a call that went through. `encoded` null marks the journal broken from here. */
    record(clock: number, op: ReplayOp, encoded: Encoded[] | null): void {
        if (encoded === null) {
            this.brokenAt ??= clock;
            return;
        }
        this.entries.push({ kind: 'op', clock, op, args: encoded });
    }

    recordRetime(clock: number, timeframe: string): void {
        this.entries.push({ kind: 'retime', clock, timeframe });
    }

    recordMode(clock: number, mode: PlayMode): void {
        this.entries.push({ kind: 'mode', clock, mode });
    }
}

/** From an id now to which one it is, in `broker`. */
function identify(broker: Broker): { position(id: number): number; order(id: number): number } {
    const orderIndex = (id: number): number => {
        const at = broker.orders.findIndex((o) => o.id === id);
        if (at === -1) throw new Error(`order ${id} is not in this account`);
        return at;
    };
    return {
        position: (id) => {
            const position = broker.positions.find((p) => p.id === id);
            if (!position || position.entryOrderId == null) throw new Error(`position ${id} is not open, or opened by no order`);
            return orderIndex(position.entryOrderId);
        },
        order: orderIndex,
    };
}

/** From which one it is to its id now, in `broker`. */
function resolve(broker: Broker): { position(ordinal: number): number; order(ordinal: number): number } {
    const orderAt = (ordinal: number): number => {
        const order = broker.orders[ordinal];
        if (!order) throw new Error(`order ${ordinal + 1} of the session was never placed this time`);
        return order.id;
    };
    return {
        position: (ordinal) => {
            const entry = orderAt(ordinal);
            const position = broker.positions.find((p) => p.entryOrderId === entry);
            if (!position) throw new Error('the position that call names is not open this time');
            return position.id;
        },
        order: orderAt,
    };
}

function encodeArgs(op: ReplayOp, args: readonly unknown[], refs: ReturnType<typeof identify>): Encoded[] {
    const where = OP_REFS[op];
    return args.map((value, i) => {
        if (where.positions?.includes(i) && value != null) return { $p: refs.position(value as number) };
        if (where.orders?.includes(i) && value != null) return { $o: refs.order(value as number) };
        if (where.spec === i && value != null && typeof value === 'object') {
            const spec: Record<string, unknown> = {};
            for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
                if (key === 'positionId' && v != null) spec[key] = { $p: refs.position(v as number) };
                else if (key === 'parentId' && v != null) spec[key] = { $o: refs.order(v as number) };
                else spec[key] = encodeValue(v);
            }
            return spec;
        }
        return encodeValue(value);
    });
}

/** A plain copy that keeps `undefined` — a close with no tag and a close tagged null are
 *  booked differently, and JSON would turn the one into the other. */
function encodeValue(value: unknown): Encoded {
    if (value === undefined) return { $u: 1 };
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(encodeValue);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeValue(v);
    return out;
}

function decodeValue(value: Encoded, refs: ReturnType<typeof resolve>): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => decodeValue(v, refs));
    const record = value as Record<string, unknown>;
    const only = Object.keys(record).length === 1;
    if (only && record.$u === 1) return undefined;
    if (only && typeof record.$p === 'number') return refs.position(record.$p);
    if (only && typeof record.$o === 'number') return refs.order(record.$o);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = decodeValue(v, refs);
    return out;
}

/** What a rebuild reads the market through. */
export interface RebuildIO {
    loadWindow(timeframe: string, clock: number): Promise<ReplayWindow>;
    /** The recorded events in [from, to). Needed only where a stretch was played on ticks. */
    loadTicks?(source: string, from: number, to: number): Promise<MidoriTick[]>;
}

/** Where the playhead goes: an instant, on the timeframe on screen. */
export interface RebuildTarget {
    clock: number;
    timeframe: string;
}

/** When the next step would put the clock. Null at the end of the loaded bars. */
export function nextBarClock(session: ReplaySession): number | null {
    const forming = session.forming;
    if (forming !== null && forming.index === session.index) return forming.full.time + session.stepMs;
    const next = session.bars[session.index + 1];
    return next ? next.time + session.stepMs : null;
}

function iso(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The session as it stood at `target.clock`, before anything done at that instant.
 *
 * Returns a fresh session, a fresh journal holding only what came before, and how the session
 * was being played at that moment. The originals are not touched, so a rebuild that fails
 * leaves the running session exactly as it was.
 */
export async function rebuildSession(
    journal: ReplayJournal,
    target: RebuildTarget,
    io: RebuildIO,
): Promise<{ session: ReplaySession; journal: ReplayJournal; mode: PlayMode }> {
    const { origin } = journal;
    if (target.clock < origin.clock) {
        throw new Error(`This session's record begins at ${iso(origin.clock)} UTC — it cannot go back before that.`);
    }
    const broken = journal.unrecordableFrom;
    if (broken !== null && target.clock > broken) {
        throw new Error(`Something done at ${iso(broken)} UTC could not be recorded, so the session cannot be rebuilt past it.`);
    }

    const first = await io.loadWindow(origin.timeframe, origin.clock);
    const session = ReplaySession.restore(origin.snapshot, { bars: first.bars, forming: first.forming });
    const rebuilt = ReplayJournal.startingFrom(origin);
    let timeframe = origin.timeframe;
    let mode: PlayMode = 'bars';

    const advanceTo = async (clock: number): Promise<void> => {
        if (mode === 'ticks') {
            if (!(clock > session.clock)) return;
            if (!origin.ticks || !io.loadTicks) {
                throw new Error('This session was played on ticks, and the recording is not available to rebuild it.');
            }
            session.advanceTicks(await io.loadTicks(origin.ticks, session.clock, clock), clock);
            return;
        }
        for (let next = nextBarClock(session); next !== null && next <= clock; next = nextBarClock(session)) {
            session.step();
        }
    };

    for (const entry of journal.recorded) {
        if (entry.clock >= target.clock) break;

        await advanceTo(entry.clock);
        if (session.clock !== entry.clock) {
            throw new Error(
                `The bars no longer line up with this session at ${iso(entry.clock)} UTC — `
                + 'the data on disk has changed since it was played.',
            );
        }

        if (entry.kind === 'retime') {
            session.rebase(await io.loadWindow(entry.timeframe, entry.clock));
            timeframe = entry.timeframe;
            rebuilt.recordRetime(entry.clock, entry.timeframe);
            continue;
        }
        if (entry.kind === 'mode') {
            mode = entry.mode;
            rebuilt.recordMode(entry.clock, entry.mode);
            continue;
        }

        try {
            applyOp(session, entry.op, entry.args.map((value) => decodeValue(value, resolve(session.broker))));
        } catch (err: unknown) {
            throw new Error(
                `Rebuilding stopped at ${iso(entry.clock)} UTC: "${entry.op}" went through the first time and `
                + `not this time (${err instanceof Error ? err.message : String(err)}).`,
            );
        }
        // The same references mean the same orders and positions in the rebuilt account.
        rebuilt.record(entry.clock, entry.op, entry.args);
    }

    /* The last stretch. On the timeframe it was played on for as long as that timeframe's
     * candles end before the target; the rest on the timeframe on screen, since the playhead
     * is going to a candle of THAT chart. Nothing was done in between — anything that was is an
     * entry, and has been applied above. */
    await advanceTo(target.clock);
    if (timeframe !== target.timeframe) {
        const at = session.clock;
        session.rebase(await io.loadWindow(target.timeframe, at));
        rebuilt.recordRetime(at, target.timeframe);
        await advanceTo(target.clock);
    }
    if (session.clock !== target.clock) {
        throw new Error(`The loaded bars do not reach ${iso(target.clock)} UTC on this timeframe.`);
    }

    return { session, journal: rebuilt, mode };
}
