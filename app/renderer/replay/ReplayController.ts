import type { ControlledPosition } from '../trading/TradingController';
import { ReplaySession } from '../../../shared/engine/replaySession.js';
import type { ReplayBar, ReplayResult } from '../../../shared/engine/replaySession.js';
import type { Broker, Costs, Order, OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import { timeframeToMs } from '../../../src';
import type { IndicatorHandle } from '../../../src';
import type { MidoriTick } from '../midori';
import type { ReplayProvider } from './ReplayProvider';
import { STATE_INPUT } from './replayIndicator';
import { visualState } from '../trading/visualState';
import { accountFigures, type AccountFigures } from './accountFigures';
import { tradeBook, type TradeBook } from './tradeBook';
import { loadReplayWindow } from './replayWindow';
import { applyOp, type ReplayOp } from './replayOps';
import { ReplayJournal, nextBarClock, rebuildSession, type PlayMode } from './replayJournal';
import type { TickFeed } from './tickFeed';

/** Playback speeds on candles, in bars per second. */
export const SPEEDS = [1, 2, 4, 10, 30] as const;
/** Playback speeds on ticks, as multiples of real time. */
export const TICK_SPEEDS = [1, 2, 5, 10, 30, 60] as const;

/** How often tick playback moves the clock. Ten a second reads as continuous on a tape. */
const TICK_FRAME_MS = 100;
/**
 * A stretch with nothing recorded in it longer than this is jumped rather than played — a
 * night, a weekend, the minutes before the recording began. Shorter ones are the market being
 * quiet, and quiet is part of what is being practised.
 */
const IDLE_SKIP_MS = 60_000;

export interface ReplayControllerOptions {
    provider: ReplayProvider;
    /** Identity of what is being replayed — stored with the session and the run. */
    symbol: string;
    timeframe: string;
    /** The whole window: context bars before the playhead, then the bars to reveal. */
    bars: ReplayBar[];
    /** Index of the last bar visible at the start. */
    startIndex: number;
    balance?: number;
    costs?: Costs;
    /**
     * A `ReplaySession.snapshot()` to pick up instead of starting fresh. The
     * playhead comes from its clock, not from `startIndex` — that is what lets a
     * parked session resume against a differently-shaped bar window.
     */
    restoreFrom?: unknown;
    /** The bar the restored clock stands inside, where it does not sit on a boundary. */
    forming?: ReplayBar | null;
    /** Id of the stored session being resumed, so saving updates that entry. */
    restoredSessionId?: string | null;
    /**
     * The journal a parked session was saved with — see replayJournal.ts. Absent on a fresh
     * session, and on one parked before journals were kept: that one can go back as far as
     * where it was picked up, and no further.
     */
    journal?: unknown;
    /** The recorded prints and quotes this replay can be played on, or none. */
    ticks?: TickFeed | null;
    /**
     * Put the chart on `clock` again, on a fresh provider — what going back to an earlier
     * candle needs, since the chart already holds the candles after it and the shared cache
     * would serve them straight back. Absent ⇒ the session cannot go back.
     */
    rechart?: (timeframe: string, clock: number) => Promise<ReplayProvider>;
    /**
     * Told whenever playback starts or stops — including when it stops itself at
     * the last bar, which no click would report. A play/pause button needs this
     * to stay honest.
     */
    onPlayStateChange?: () => void;
    /**
     * Told whenever the account moved — a bar revealed, an order placed, a position
     * closed. Every one of those already goes through `pushState`, so a readout hung
     * here cannot miss one and never has to poll. Settable afterwards as well, for a
     * readout that can only be built once the chart it sits on exists.
     */
    onAccountChange?: () => void;
    /** Something the person should be told that no click asked about — playback stopping at the
     *  end of a recording, a history that could not be read. */
    onNotice?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Drives one replay: the account (ReplaySession) and the chart (ReplayProvider)
 * step in lockstep.
 *
 * The session owns the bar array and the playhead — this class never keeps a
 * second cursor, so the account and the chart cannot drift apart. Everything
 * runs in the renderer; nothing here crosses IPC except loading bars and ticks.
 *
 * Two ways to play
 * ----------------
 * On CANDLES, one bar at a time, each matched whole. On TICKS, where a recording exists, the
 * clock runs in time — sped up or not — through every recorded print and quote, and the candle
 * under the playhead grows as they happen. The account is the same engine either way; only
 * what it is fed changes, and the switch between the two is recorded like any other step, so
 * going back to a candle plays each stretch the way it was played.
 *
 * The session can be REPLACED — by going back to an earlier candle — so it is read through
 * {@link session} every time and never held onto from outside.
 */
export class ReplayController {
    private current: ReplaySession;
    readonly symbol: string;
    private provider: ReplayProvider;
    /** The timeframe the session is currently running on — see {@link retime}. */
    private currentTimeframe: string;
    /** Which retime is the live one; an older one that lands late is dropped. */
    private retimeGeneration = 0;
    /** Set once a session has been put down, so saving again replaces that entry. */
    private savedSessionId: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private speedBarsPerSec: number = 4;
    private tickSpeed: number = 5;
    private indicator: IndicatorHandle | null = null;
    private readonly onPlayStateChange: (() => void) | null;
    private readonly onNotice: ReplayControllerOptions['onNotice'] | null;
    /** Everything done since the session began — what {@link jumpTo} rebuilds from. */
    private journal: ReplayJournal;
    private readonly rechart: ReplayControllerOptions['rechart'] | null;
    readonly ticks: TickFeed | null;
    private playMode: PlayMode = 'bars';
    /** A jump is being rebuilt. Nothing may change the account until it has landed. */
    private jumping = false;
    /** Stepping a run of bars; the visuals are pushed once when it is done. */
    private quiet = false;
    /** A frame of tick playback is still loading or playing; the timer waits for it. */
    private tickBusy = false;
    /** See {@link ReplayControllerOptions.onAccountChange}. */
    onAccountChange: (() => void) | null;
    /** Handed every print a tick stretch played, oldest first — for the tape and the ladder. */
    onPrints: ((prints: ReadonlyArray<[number, 1, number, number, 0 | 1 | null]>) => void) | null = null;
    /** Told once a jump has landed — the tape and the ladder describe a market that is gone. */
    onJump: (() => void) | null = null;

    constructor(opts: ReplayControllerOptions) {
        this.provider = opts.provider;
        this.symbol = opts.symbol;
        this.currentTimeframe = opts.timeframe;
        this.onPlayStateChange = opts.onPlayStateChange ?? null;
        this.onAccountChange = opts.onAccountChange ?? null;
        this.onNotice = opts.onNotice ?? null;
        this.savedSessionId = opts.restoredSessionId ?? null;
        this.rechart = opts.rechart ?? null;
        this.ticks = opts.ticks ?? null;
        this.current = opts.restoreFrom
            ? ReplaySession.restore(opts.restoreFrom, { bars: opts.bars, forming: opts.forming ?? null })
            : new ReplaySession({
                bars: opts.bars,
                startIndex: opts.startIndex,
                balance: opts.balance,
                costs: opts.costs,
            });

        let journal: ReplayJournal | null = null;
        if (opts.journal != null) {
            try {
                journal = ReplayJournal.fromRecord(opts.journal);
            } catch (err: unknown) {
                /* Said, not swallowed — and not fatal: refusing to open a parked session over its
                 * history would cost the session itself. What is lost is going back past today. */
                console.error('[midorii] the replay journal could not be read', err);
                this.onNotice?.(
                    'This session\'s history could not be read, so it can go back only as far as where it was picked up.',
                    'error',
                );
            }
        }
        this.journal = journal ?? ReplayJournal.begin(this.current, opts.timeframe, this.ticks?.source ?? null);
        /* A session parked on ticks comes back on ticks, where the recording is there to play. */
        if (lastMode(this.journal) === 'ticks') {
            if (this.ticks) this.playMode = 'ticks';
            else this.journal.recordMode(this.current.clock, 'bars');
        }
    }

    /** The account and the playhead. Read through this every time — a jump replaces it. */
    get session(): ReplaySession {
        return this.current;
    }

    /** How the session is being played right now. */
    get mode(): PlayMode {
        return this.playMode;
    }

    /**
     * Hand over the native indicator that draws this session's positions and
     * orders. Optional: without it the replay still runs, just unpainted.
     */
    attachIndicator(handle: IndicatorHandle): void {
        this.indicator = handle;
        this.pushState();
    }

    /** What the account is worth right now — for a readout, never for a decision. */
    account(): AccountFigures {
        return accountFigures(this.current.broker);
    }

    /** Redraw the chart from the account as it stands — after a refused edit, so what is on
     *  screen goes back to being what is true. */
    refreshVisuals(): void {
        this.pushState();
    }

    /**
     * Push the account's visual state to the indicator. JSON through a string
     * input is the only channel into a running native instance (`InputValue` is
     * primitives only) — a deliberate workaround, not a Vela feature.
     */
    private pushState(): void {
        this.onAccountChange?.();
        if (!this.indicator) return;
        this.indicator.setInput(STATE_INPUT, JSON.stringify(visualState(this.current.broker, this.current.bar.close)));
    }

    /** The newest price the session stands on — what a market order fills against. */
    price(): number {
        return this.current.bar.close;
    }

    /** The account. The session owns it; this is the name the chart wirings know it by. */
    get broker(): Broker {
        return this.current.broker;
    }

    /** What the account is worth. Its own computation — this account IS the engine. */
    equity(): number {
        return this.current.broker.equity;
    }

    /** What is open right now, for the chart's own gestures. */
    positions(): readonly ControlledPosition[] {
        return this.current.broker.positions;
    }

    // ── transport ────────────────────────────────────────────────────────

    /** The timeframe the chart and the account are both on right now. */
    get timeframe(): string {
        return this.currentTimeframe;
    }

    get playing(): boolean {
        return this.timer != null;
    }

    /** The speed in the current mode — bars a second on candles, times real time on ticks. */
    get speed(): number {
        return this.playMode === 'ticks' ? this.tickSpeed : this.speedBarsPerSec;
    }

    /** The speeds the current mode offers. */
    get speeds(): readonly number[] {
        return this.playMode === 'ticks' ? TICK_SPEEDS : SPEEDS;
    }

    get atEnd(): boolean {
        return this.current.atEnd;
    }

    /**
     * Reveal one bar, whole: the account matches orders against it, the chart paints it.
     *
     * The candle primitive. On ticks it refuses — a whole-candle step through a candle whose
     * prints are being played would skip the prints still to come; {@link stepForward} is the
     * one to use from a button.
     */
    step(): void {
        if (this.jumping) return;
        if (this.playMode === 'ticks') {
            throw new Error('Playing on ticks — step forward plays to the end of the candle instead.');
        }
        if (this.current.atEnd) {
            this.pause();
            return;
        }
        this.current.step();
        this.provider.revealNext(this.current.bar);
        // A step can also fill a resting order or hit a stop, so the visuals are
        // pushed here too, not only after a manual trade.
        if (!this.quiet) this.pushState();
    }

    /**
     * Reveal `n` bars one at a time. Never a jump: an order has to be matched
     * against every bar it could have filled on, and Vela heals a multi-bar gap
     * by refetching (which would ask the provider for the future).
     */
    skip(n: number): void {
        for (let i = 0; i < n && !this.current.atEnd; i++) this.step();
    }

    /** One candle on, whichever way the session is being played: on ticks, to the end of the
     *  candle in progress. */
    async stepForward(): Promise<void> {
        await this.skipForward(1);
    }

    /** `n` candles on, whichever way the session is being played. */
    async skipForward(n: number): Promise<void> {
        if (this.playMode === 'bars') {
            this.skip(n);
            return;
        }
        this.pause();
        await this.playTicksTo(this.candleEndsAhead(n));
    }

    /**
     * Until the bar at `index` in the session's bars is the last one closed — what "skip to the
     * next setup" lands with. On candles stepped one bar at a time, like {@link skip}, with the
     * visuals pushed once at the end; on ticks, played through every print on the way.
     *
     * Returns how many candles were passed. Stops early at the end of the loaded bars.
     */
    async skipToIndex(index: number): Promise<number> {
        if (this.jumping) return 0;
        const from = this.current.index;
        if (this.playMode === 'ticks') {
            const bar = this.current.bars[index];
            if (!bar) return 0;
            this.pause();
            await this.playTicksTo(bar.time + this.current.stepMs);
            return this.current.index - from;
        }
        this.quiet = true;
        try {
            while (!this.current.atEnd && this.current.index < index) this.step();
        } finally {
            this.quiet = false;
        }
        this.pushState();
        return this.current.index - from;
    }

    play(): void {
        if (this.timer != null || this.jumping) return;
        if (this.playMode === 'bars' && this.current.atEnd) return;
        if (this.playMode === 'ticks') this.startTickPlay();
        else this.startTicking();
        this.onPlayStateChange?.();
    }

    pause(): void {
        if (this.timer == null) return;
        clearInterval(this.timer);
        this.timer = null;
        this.onPlayStateChange?.();
    }

    setSpeed(speed: number): void {
        if (!(speed > 0)) throw new Error(`setSpeed: speed must be positive, got ${speed}`);
        if (this.playMode === 'ticks') this.tickSpeed = speed;
        else this.speedBarsPerSec = speed;
        if (this.timer != null) {
            // Re-cadence in place: playback never stopped, so no state change is
            // reported and a play/pause button does not flicker.
            clearInterval(this.timer);
            this.timer = null;
            if (this.playMode === 'ticks') this.startTickPlay();
            else this.startTicking();
        }
    }

    /**
     * Play on candles or on ticks from here.
     *
     * Leaving ticks finishes the candle in progress on its prints first: stepping whole candles
     * from the middle of one would either skip the prints still to come or match the finished
     * candle a second time. The switch is recorded, so going back past it plays each stretch the
     * way it was played.
     */
    async setPlayMode(mode: PlayMode): Promise<void> {
        if (mode === this.playMode) return;
        if (this.jumping) throw new Error('The session is going back to an earlier candle — one moment.');
        if (mode === 'ticks' && !this.ticks) throw new Error('This replay has no recorded ticks to play.');
        this.pause();
        if (mode === 'bars') {
            const forming = this.current.forming;
            if (forming !== null && forming.index === this.current.index && forming.ticked) {
                await this.playTicksTo(forming.full.time + this.current.stepMs);
            }
        }
        this.playMode = mode;
        this.journal.recordMode(this.current.clock, mode);
    }

    /**
     * Move the running session onto another timeframe.
     *
     * The clock is what carries across: it is one instant, the same instant on
     * every timeframe, and everything before it is what this session has been
     * allowed to see. So the window is reloaded around it, the account is
     * rebased onto those bars, and nothing about the account itself changes —
     * no trade is replayed, no position is re-priced, no bar is skipped.
     *
     * Switching to a slower timeframe usually lands the clock inside a bar
     * rather than on a boundary. That bar goes in as far as it has got and the
     * next step finishes it, rather than jumping over the minutes in between —
     * which would let a resting order miss the price that would have filled it.
     *
     * Playback resumes if it was running. Throws if the new timeframe cannot be
     * served for this symbol, leaving the session exactly where it was.
     */
    async retime(timeframe: string): Promise<void> {
        if (timeframe === this.currentTimeframe) return;
        if (this.jumping) throw new Error('The session is going back to an earlier candle — change the timeframe once it has.');

        const generation = ++this.retimeGeneration;
        const wasPlaying = this.playing;
        this.pause();

        const window_ = await loadReplayWindow(this.symbol, timeframe, this.current.clock);
        // A faster switch overtook this one while the bars were loading; its
        // window is the current one and this one would rebase back onto a
        // timeframe the chart has already left.
        if (generation !== this.retimeGeneration) return;

        this.current.rebase(window_);
        this.currentTimeframe = timeframe;
        // Written down, so going back past this instant plays the stretch before it on the
        // timeframe it was actually played on.
        this.journal.recordRetime(this.current.clock, timeframe);
        this.provider.retime(timeframe, this.current.clock);
        this.pushState();
        if (wasPlaying) this.play();
    }

    /**
     * Go back to a candle and carry on from there, as though nothing after it had been done.
     *
     * `candleTime` is the candle's open, on the timeframe on screen. The playhead lands at its
     * close — the candle has just appeared — with the account exactly as it stood at that
     * moment: every trade, order and change made from then on is gone, and so are the fills and
     * the drawdown they caused. Going back to the candle the session is standing on undoes what
     * was done on it; on ticks, going back to the candle still in progress goes to its start.
     *
     * Rebuilt from the session's beginning (see replayJournal.ts), so it is exact rather than
     * approximate, and it fails loudly — leaving the session where it was — rather than landing
     * on an account that was never traded. The time spent at the session is kept: going back
     * undoes trades, not practice.
     */
    async jumpTo(candleTime: number): Promise<void> {
        if (this.jumping) throw new Error('Already going back — one moment.');
        if (!this.rechart) throw new Error('This replay cannot go back to an earlier candle.');

        const timeframe = this.currentTimeframe;
        const clock = this.current.clock;
        let target = candleTime + timeframeToMs(timeframe);
        if (target > clock) {
            // The candle in progress: back to where it began.
            if (candleTime < clock) target = candleTime;
            else throw new Error('That candle has not been played yet.');
        }
        if (target === clock && !this.journal.hasEntriesAt(clock)) {
            throw new Error('Nothing has been done on this candle yet — pick one further left to go back to.');
        }

        // Playback stays paused afterwards: somebody who went back wants to look first.
        this.pause();
        this.jumping = true;
        // A timeframe change still loading would rebase the old session after this one lands.
        this.retimeGeneration++;
        try {
            const rebuilt = await rebuildSession(
                this.journal,
                { clock: target, timeframe },
                {
                    loadWindow: (tf, at) => loadReplayWindow(this.symbol, tf, at),
                    loadTicks: (source, from, to) => window.midori.ticks.read({ name: source, from, to }),
                },
            );
            const provider = await this.rechart(timeframe, rebuilt.session.clock);

            const spent = this.current.elapsedMs;
            const next = rebuilt.session as ReplaySession & { elapsedBefore: number; startedAt: number };
            next.elapsedBefore = spent;
            next.startedAt = Date.now();

            this.current = rebuilt.session;
            this.journal = rebuilt.journal;
            this.provider = provider;
            this.playMode = rebuilt.mode === 'ticks' && this.ticks ? 'ticks' : 'bars';
            if (rebuilt.mode === 'ticks' && !this.ticks) this.journal.recordMode(this.current.clock, 'bars');
            this.onJump?.();
            this.pushState();
        } finally {
            this.jumping = false;
        }
    }

    private startTicking(): void {
        this.timer = setInterval(() => {
            if (this.current.atEnd) {
                this.pause();
                return;
            }
            this.step();
        }, 1000 / this.speedBarsPerSec);
    }

    // ── ticks ────────────────────────────────────────────────────────────

    private startTickPlay(): void {
        this.timer = setInterval(() => {
            if (this.tickBusy) return;
            this.tickBusy = true;
            void this.playFrame(TICK_FRAME_MS * this.tickSpeed)
                .catch((err: unknown) => {
                    this.pause();
                    this.onNotice?.(err instanceof Error ? err.message : String(err), 'error');
                })
                .finally(() => { this.tickBusy = false; });
        }, TICK_FRAME_MS);
    }

    /** One frame of tick playback: `span` of market time, with dead air jumped. */
    async playFrame(span: number): Promise<void> {
        const feed = this.ticks;
        if (!feed) return;
        const session = this.current;
        const end = this.loadedEnd();
        if (session.clock >= end) {
            this.pause();
            this.onNotice?.('The loaded candles end here.', 'info');
            return;
        }
        let until = Math.min(session.clock + span, end);
        if ((await feed.between(session.clock, until)).length === 0) {
            const next = await feed.nextAfter(until);
            if (next === null) {
                this.pause();
                this.onNotice?.('The recording ends here — switch to candles to carry on.', 'info');
                return;
            }
            if (next - session.clock > IDLE_SKIP_MS) until = Math.min(next, end);
        }
        await this.playTicksTo(until);
    }

    /**
     * Play the recording up to `until` — the one place ticks reach the account and the chart.
     *
     * Dropped where the session was replaced while the ticks were loading: they belong to a
     * market the playhead has since left.
     */
    private async playTicksTo(until: number): Promise<void> {
        const feed = this.ticks;
        if (!feed) throw new Error('This replay has no recorded ticks to play.');
        const session = this.current;
        const to = Math.min(until, this.loadedEnd());
        if (!(to > session.clock)) return;
        const events = await feed.between(session.clock, to);
        if (session !== this.current || this.jumping) return;

        const { closed, prints } = session.advanceTicks(events as MidoriTick[], to);
        for (const bar of closed) this.provider.revealNext(bar);
        if (session.forming !== null && session.forming.index === session.index) {
            this.provider.revealForming(session.bar, session.clock);
        }
        if (prints.length > 0) this.onPrints?.(prints);
        this.pushState();
    }

    /** Where the loaded candles end — the furthest the clock can go. */
    private loadedEnd(): number {
        const { bars, stepMs, forming } = this.current;
        const last = forming !== null && forming.index === bars.length - 1 ? forming.full : bars[bars.length - 1]!;
        return last.time + stepMs;
    }

    /** The end of the `n`-th candle from the playhead, counting the one in progress as the first. */
    private candleEndsAhead(n: number): number {
        const session = this.current;
        const first = nextBarClock(session);
        if (first === null) return session.clock;
        const index = session.forming !== null && session.forming.index === session.index
            ? session.index + n - 1
            : session.index + n;
        const bar = session.bars[Math.min(index, session.bars.length - 1)]!;
        return Math.max(first, bar.time + session.stepMs);
    }

    // ── trading (thin pass-throughs; the engine owns the rules) ──────────

    /**
     * Make one account call, and write it down if it went through.
     *
     * The reference it names is read BEFORE the call, since a close takes away the position it
     * names. A refusal is the engine's and reaches the caller unchanged, with nothing recorded.
     */
    private act<T>(op: ReplayOp, args: unknown[]): T {
        if (this.jumping) throw new Error('The session is going back to an earlier candle — one moment.');
        const encoded = this.journal.encode(this.current.broker, op, args);
        const out = applyOp(this.current, op, args) as T;
        this.journal.record(this.current.clock, op, encoded);
        this.pushState();
        return out;
    }

    buy(spec: Partial<OrderSpec> = {}): Order {
        return this.act('buy', [spec]);
    }

    sell(spec: Partial<OrderSpec> = {}): Order {
        return this.act('sell', [spec]);
    }

    order(spec: OrderSpec): Order {
        return this.act('order', [spec]);
    }

    close(tag?: string): void {
        this.act('close', [tag]);
    }

    flatten(): void {
        this.act('flatten', []);
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        this.act('protect', [levels, positionId]);
    }

    breakEven(positionId?: number | null): boolean {
        return this.act('breakEven', [positionId]);
    }

    /**
     * Close ONE position outright, at market.
     *
     * Not `closePart` with the position's own size: that books the exit as a scale-out, and
     * the tag is what the trade record ends up saying about how it ended.
     */
    closeOne(positionId: number): void {
        this.act('closeOne', [positionId]);
    }

    /** Take part of a position off at market, now. */
    closePart(size: number, positionId?: number | null): void {
        this.act('closePart', [size, positionId]);
    }

    /** Close and open the same size the other way, in one go. */
    reverse(positionId?: number | null): void {
        this.act('reverse', [positionId]);
    }

    /** Let the stop follow price at a fixed distance behind it. */
    setTrailing(distance: number, options?: { activateAt?: number }, positionId?: number | null): void {
        this.act('setTrailing', [distance, options ?? {}, positionId]);
    }

    /** Move a resting order rather than cancelling and replacing it. */
    modifyOrder(id: number, patch: Partial<OrderSpec>): boolean {
        return this.act('modifyOrder', [id, patch]);
    }

    /** Take one resting order out of the book. */
    cancelOrder(id: number): boolean {
        return this.act('cancelOrder', [id]);
    }

    cancelAll(tag?: string): void {
        this.act('cancelAll', [tag]);
    }

    /** What is open and what is waiting — for a list, never for a decision. */
    book(): TradeBook {
        return tradeBook(this.current.broker);
    }

    /** The finished run, in the same shape a backtest produces. */
    result(): ReplayResult {
        return this.current.result();
    }

    // ── persistence ──────────────────────────────────────────────────────

    /**
     * Put the session down for later: the account and the clock go to disk, the
     * bars do not (they are already in the data store, and are the same bars
     * tomorrow). Saving twice replaces the same entry rather than piling up.
     *
     * The journal goes with it, so a session picked up tomorrow can still go back to a candle
     * from today — and so does the recording it plays, so it comes back on the same ticks.
     */
    async saveSession(name = ''): Promise<string> {
        this.pause();
        const broker = this.current.broker;
        const { id } = await window.midori.replay.saveSession({
            id: this.savedSessionId,
            name,
            symbol: this.symbol,
            timeframe: this.timeframe,
            session: this.current.snapshot(),
            journal: this.journal.toRecord(),
            ticks: this.ticks?.source ?? null,
            stats: {
                bars: this.current.steps,
                trades: broker.trades.length,
                openPositions: broker.positions.length,
                equity: broker.equity,
                initialBalance: broker.initialBalance,
            },
        });
        this.savedSessionId = id;
        return id;
    }

    /**
     * Store the finished session as a run — the same library, format and results
     * page a backtest lands in, so a hand-traded run and a strategy run compare
     * directly. Refused by the boundary if the session took no trades.
     */
    async saveAsRun(note = ''): Promise<string> {
        this.pause();
        const { id } = await window.midori.replay.save({
            symbol: this.symbol,
            timeframe: this.timeframe,
            note,
            ...this.result(),
        });
        return id;
    }

    destroy(): void {
        this.pause();
    }
}

/** How a journal leaves the session being played — the mode of its last switch, or candles. */
function lastMode(journal: ReplayJournal): PlayMode {
    let mode: PlayMode = 'bars';
    for (const entry of journal.recorded) if (entry.kind === 'mode') mode = entry.mode;
    return mode;
}
