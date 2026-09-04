import { ReplaySession } from '../../../shared/engine/replaySession.js';
import type { ReplayBar, ReplayResult } from '../../../shared/engine/replaySession.js';
import type { Costs, Order, OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { IndicatorHandle } from '../../../src';
import type { ReplayProvider } from './ReplayProvider';
import { STATE_INPUT, type ReplayVisualState } from './replayIndicator';
import { loadReplayWindow } from './replayWindow';

/** Playback speeds, in bars per second. */
export const SPEEDS = [1, 2, 4, 10, 30] as const;

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
     * Told whenever playback starts or stops — including when it stops itself at
     * the last bar, which no click would report. A play/pause button needs this
     * to stay honest.
     */
    onPlayStateChange?: () => void;
}

/**
 * Drives one replay: the account (ReplaySession) and the chart (ReplayProvider)
 * step in lockstep, one bar at a time.
 *
 * The session owns the bar array and the playhead — this class never keeps a
 * second cursor, so the account and the chart cannot drift apart. Everything
 * runs in the renderer; nothing here crosses IPC (the bars are already loaded,
 * and a click has to become an order and a redrawn chart in the same frame).
 */
export class ReplayController {
    readonly session: ReplaySession;
    readonly symbol: string;
    private readonly provider: ReplayProvider;
    /** The timeframe the session is currently running on — see {@link retime}. */
    private currentTimeframe: string;
    /** Which retime is the live one; an older one that lands late is dropped. */
    private retimeGeneration = 0;
    /** Set once a session has been put down, so saving again replaces that entry. */
    private savedSessionId: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private speedBarsPerSec: number = 4;
    private indicator: IndicatorHandle | null = null;
    private readonly onPlayStateChange: (() => void) | null;

    constructor(opts: ReplayControllerOptions) {
        this.provider = opts.provider;
        this.symbol = opts.symbol;
        this.currentTimeframe = opts.timeframe;
        this.onPlayStateChange = opts.onPlayStateChange ?? null;
        this.savedSessionId = opts.restoredSessionId ?? null;
        this.session = opts.restoreFrom
            ? ReplaySession.restore(opts.restoreFrom, { bars: opts.bars, forming: opts.forming ?? null })
            : new ReplaySession({
                bars: opts.bars,
                startIndex: opts.startIndex,
                balance: opts.balance,
                costs: opts.costs,
            });
    }

    /**
     * Hand over the native indicator that draws this session's positions and
     * orders. Optional: without it the replay still runs, just unpainted.
     */
    attachIndicator(handle: IndicatorHandle): void {
        this.indicator = handle;
        this.pushState();
    }

    /**
     * Push the account's visual state to the indicator. JSON through a string
     * input is the only channel into a running native instance (`InputValue` is
     * primitives only) — a deliberate workaround, not a Vela feature.
     */
    private pushState(): void {
        if (!this.indicator) return;
        const broker = this.session.broker;
        const state: ReplayVisualState = {
            positions: broker.positions.map((p) => ({
                id: p.id,
                side: p.size > 0 ? 'buy' : 'sell',
                entryPrice: p.entryPrice,
                entryTime: p.openedAt,
                stopPrice: p.stopLoss,
                targetPrice: p.takeProfit,
            })),
            orders: broker.pending
                // reduce-only legs are a position's own stop/target — that position
                // already draws them as its levels, so they are not resting orders.
                .filter((o) => !o.reduceOnly)
                .map((o) => ({ id: o.id, side: o.side, price: o.limitPrice ?? o.stopPrice, tag: o.tag }))
                .filter((o): o is { id: number; side: 'buy' | 'sell'; price: number; tag: string | null } => o.price != null),
        };
        this.indicator.setInput(STATE_INPUT, JSON.stringify(state));
    }

    // ── transport ────────────────────────────────────────────────────────

    /** The timeframe the chart and the account are both on right now. */
    get timeframe(): string {
        return this.currentTimeframe;
    }

    get playing(): boolean {
        return this.timer != null;
    }

    get speed(): number {
        return this.speedBarsPerSec;
    }

    get atEnd(): boolean {
        return this.session.atEnd;
    }

    /** Reveal one bar: the account matches orders against it, the chart paints it. */
    step(): void {
        if (this.session.atEnd) {
            this.pause();
            return;
        }
        this.session.step();
        this.provider.revealNext(this.session.bar);
        // A step can also fill a resting order or hit a stop, so the visuals are
        // pushed here too, not only after a manual trade.
        this.pushState();
    }

    /**
     * Reveal `n` bars one at a time. Never a jump: an order has to be matched
     * against every bar it could have filled on, and Vela heals a multi-bar gap
     * by refetching (which would ask the provider for the future).
     */
    skip(n: number): void {
        for (let i = 0; i < n && !this.session.atEnd; i++) this.step();
    }

    play(): void {
        if (this.timer != null || this.session.atEnd) return;
        this.startTicking();
        this.onPlayStateChange?.();
    }

    pause(): void {
        if (this.timer == null) return;
        clearInterval(this.timer);
        this.timer = null;
        this.onPlayStateChange?.();
    }

    setSpeed(barsPerSec: number): void {
        if (!(barsPerSec > 0)) throw new Error(`setSpeed: speed must be positive, got ${barsPerSec}`);
        this.speedBarsPerSec = barsPerSec;
        if (this.timer != null) {
            // Re-cadence in place: playback never stopped, so no state change is
            // reported and a play/pause button does not flicker.
            clearInterval(this.timer);
            this.startTicking();
        }
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

        const generation = ++this.retimeGeneration;
        const wasPlaying = this.playing;
        this.pause();

        const window_ = await loadReplayWindow(this.symbol, timeframe, this.session.clock);
        // A faster switch overtook this one while the bars were loading; its
        // window is the current one and this one would rebase back onto a
        // timeframe the chart has already left.
        if (generation !== this.retimeGeneration) return;

        this.session.rebase(window_);
        this.currentTimeframe = timeframe;
        this.provider.retime(timeframe, this.session.clock);
        this.pushState();
        if (wasPlaying) this.play();
    }

    private startTicking(): void {
        this.timer = setInterval(() => {
            if (this.session.atEnd) {
                this.pause();
                return;
            }
            this.step();
        }, 1000 / this.speedBarsPerSec);
    }

    // ── trading (thin pass-throughs; the engine owns the rules) ──────────

    buy(spec: Partial<OrderSpec> = {}): Order {
        const order = this.session.buy(spec);
        this.pushState();
        return order;
    }

    sell(spec: Partial<OrderSpec> = {}): Order {
        const order = this.session.sell(spec);
        this.pushState();
        return order;
    }

    order(spec: OrderSpec): Order {
        const order = this.session.order(spec);
        this.pushState();
        return order;
    }

    close(tag?: string): void {
        this.session.close(tag);
        this.pushState();
    }

    flatten(): void {
        this.session.flatten();
        this.pushState();
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        this.session.protect(levels, positionId);
        this.pushState();
    }

    breakEven(positionId?: number | null): boolean {
        const done = this.session.breakEven(positionId);
        this.pushState();
        return done;
    }

    /** The finished run, in the same shape a backtest produces. */
    result(): ReplayResult {
        return this.session.result();
    }

    // ── persistence ──────────────────────────────────────────────────────

    /**
     * Put the session down for later: the account and the clock go to disk, the
     * bars do not (they are already in the data store, and are the same bars
     * tomorrow). Saving twice replaces the same entry rather than piling up.
     */
    async saveSession(name = ''): Promise<string> {
        this.pause();
        const broker = this.session.broker;
        const { id } = await window.midori.replay.saveSession({
            id: this.savedSessionId,
            name,
            symbol: this.symbol,
            timeframe: this.timeframe,
            session: this.session.snapshot(),
            stats: {
                bars: this.session.steps,
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
