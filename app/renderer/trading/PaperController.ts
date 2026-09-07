import { LiveSession } from '../../../shared/engine/liveSession.js';
import type { LiveBar } from '../../../shared/engine/liveSession.js';
import type { Broker, Order, OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { RunStats } from '../../../shared/engine/summary.js';
import type { LiveResult } from '../../../shared/engine/liveSession.js';
import type { IndicatorHandle } from '../../../src';
import { accountFigures, type AccountFigures } from '../replay/accountFigures';
import { tradeBook, tradeHistory, type ClosedTrade, type HistoryRow, type TradeBook } from '../replay/tradeBook';
import { STATE_INPUT } from '../replay/replayIndicator';
import { costsOf, positionModeOf, type PaperSettings } from './paperSettings';
import type { TradingController } from './TradingController';
import { visualState } from './visualState';

/**
 * Drives one paper account against the live chart.
 *
 * The counterpart of {@link ReplayController}, and deliberately the same shape
 * minus the half that has no meaning here: there is no transport. A live account
 * cannot be paused, stepped or run at 4×, because the thing it is running against
 * is not a recording. What is left is the account, the chart's feed going into it,
 * and the panels reading it back out — all of which are the replay's, unchanged.
 *
 * One market at a time
 * --------------------
 * The engine's Broker holds positions without a symbol on them: it is one account
 * in one instrument, which is exactly what a replay is and is not what a chart is.
 * So the account is BOUND to the market it trades. While it holds nothing it moves
 * with the chart; the moment it holds something, the chart may wander off and the
 * account stays where its money is — refusing new orders in as many words, rather
 * than quietly booking a Bitcoin position against Ethereum's prices.
 */

export interface PaperControllerOptions {
    /** The market the account trades — the chart's symbol when it was started. */
    symbol: string;
    settings: PaperSettings;
    /** A stored `LiveSession.snapshot()` to pick up instead of starting fresh. */
    restore?: unknown;
    /** Told whenever the account moved — an order placed, a fill, a bar played. */
    onAccountChange?: () => void;
    /** Told whenever the account changed in a way that is worth writing down. */
    onPersist?: () => void;
}

export class PaperController implements TradingController {
    readonly session: LiveSession;
    private boundSymbol: string;
    private indicator: IndicatorHandle | null = null;
    /** Why trading is refused right now, or null. Set when the chart wanders off. */
    private away: string | null = null;
    /** See {@link stats} and {@link history} — both are read on every repaint. */
    private statsCache: RunStats | null = null;
    private statsAt = -1;
    private historyCache: readonly HistoryRow[] | null = null;
    private historyAt = -1;
    /** How many fills a restored account arrived with — see {@link markFills}. */
    private readonly inheritedFills: number;

    /** See {@link PaperControllerOptions.onAccountChange}. Settable after construction,
     *  for a readout that can only be built once the chart it sits on exists. */
    onAccountChange: (() => void) | null;
    onPersist: (() => void) | null;

    constructor(opts: PaperControllerOptions) {
        this.boundSymbol = opts.symbol;
        this.onAccountChange = opts.onAccountChange ?? null;
        this.onPersist = opts.onPersist ?? null;
        this.session = opts.restore
            ? LiveSession.restore(opts.restore)
            : new LiveSession({
                balance: opts.settings.balance,
                costs: costsOf(opts.settings),
                mode: positionModeOf(opts.settings),
            });
        /* Stamping runs newest-first and stops at the first fill already stamped, so an
         * unstamped run is always a leading one: where the stamps begin is where this
         * account's traceable history begins. */
        const stamped = this.session.broker.fills.findIndex((f) => (f as { symbol?: string }).symbol != null);
        this.inheritedFills = stamped === -1 ? this.session.broker.fills.length : stamped;
    }

    /** The market this account trades. */
    get symbol(): string {
        return this.boundSymbol;
    }

    /** The account. */
    get broker(): Broker {
        return this.session.broker;
    }

    /** The newest price the account has been marked at — 0 before the feed has spoken. */
    price(): number {
        return this.session.price ?? 0;
    }

    /** Why an order would be refused right now, or null when one can be sent. */
    get refusal(): string | null {
        return this.away;
    }

    /** What the account is worth right now — for a readout, never for a decision. */
    account(): AccountFigures {
        return accountFigures(this.session.broker);
    }

    /** What is open and what is waiting — for a list, never for a decision. */
    book(): TradeBook {
        return tradeBook(this.session.broker);
    }

    /**
     * What the account has done since it was opened — the same figures a stored run
     * reports, so a paper account and a backtest are read off the same numbers.
     *
     * Read several times a second, and `summarize` walks every trade and every fill. So
     * the walk is cached against the fill count — nothing it computes can change without
     * a fill — and only the figures that move with the MARK are taken fresh. Those are
     * cheap: the equity is a sum over open positions, and the drawdown is two numbers the
     * session has been keeping on every tick anyway.
     */
    stats(): RunStats {
        const fills = this.session.broker.fills.length;
        if (!this.statsCache || this.statsAt !== fills) {
            this.statsCache = this.session.stats();
            this.statsAt = fills;
        }
        const broker = this.session.broker;
        const netPnl = broker.equity - broker.initialBalance;
        return {
            ...this.statsCache,
            finalEquity: broker.equity,
            netPnl,
            returnPct: broker.initialBalance > 0 ? netPnl / broker.initialBalance : 0,
            maxDrawdown: this.session.maxDrawdown,
            maxDrawdownPct: this.session.maxDrawdownPct,
        };
    }

    /** Closed round trips, newest first — cached against the trade count for the same
     *  reason {@link stats} is: the list cannot change without one. */
    history(): readonly HistoryRow[] {
        const trades = this.session.broker.trades as ClosedTrade[];
        if (!this.historyCache || this.historyAt !== trades.length) {
            this.historyCache = tradeHistory(trades);
            this.historyAt = trades.length;
        }
        return this.historyCache;
    }

    /** When the account was opened, as a wall clock. */
    get openedAt(): number {
        return this.session.createdAt;
    }

    /**
     * The account as a finished run, ready for the library.
     *
     * What starting over goes through: weeks of trades become a stored result on the same
     * shelf as a backtest, rather than a file that gets deleted.
     */
    result(resolution: string | null = null): LiveResult {
        return this.session.result({ resolution });
    }

    /**
     * Hand over the native indicator that draws this account's positions and orders.
     * Optional: without it the account still trades, just unpainted.
     */
    attachIndicator(handle: IndicatorHandle): void {
        this.indicator = handle;
        this.pushState();
    }

    /** Redraw from the account as it stands — after a refused edit, so what is on screen
     *  goes back to being what is true. */
    refreshVisuals(): void {
        this.pushState();
    }

    /* --- the feed --------------------------------------------------------- */

    /**
     * Follow the chart onto `symbol`, if the account is free to go.
     *
     * Free means holding nothing: no position, no resting order. Then there is
     * nothing to carry across and the account simply trades what is on screen. With
     * something open it stays put — and says so, in the message a refused order then
     * repeats. Returns whether it moved.
     */
    follow(symbol: string): boolean {
        if (symbol === this.boundSymbol) {
            this.away = null;
            return true;
        }
        if (!this.session.isIdle) {
            this.away = `Paper trading is running on ${this.boundSymbol} — close what is open, or switch back to it.`;
            this.pushState();
            return false;
        }
        this.boundSymbol = symbol;
        this.away = null;
        /* A market the account has never seen: the next update marks it rather than
         * filling on it, exactly as the first update of all does. The price goes too —
         * one instrument's last price says nothing about another's. */
        this.rebase();
        this.session.broker.lastPrice = null;
        this.pushState();
        this.persist();
        return true;
    }

    /**
     * Forget which bar the account is standing in, keeping the account itself.
     *
     * What a timeframe switch does to it. The bar the account was mid-way through has
     * ceased to exist — the same minute is now part of a bar with a different open
     * time and a different range — so reading the next update as movement inside it
     * would be reading it against a bar that is gone. The next update re-anchors
     * instead, which costs the tick it arrives on and nothing else.
     */
    rebase(): void {
        this.session.barTime = null;
        this.session.seenHigh = null;
        this.session.seenLow = null;
    }

    /** One update from the chart's feed. Ignored while the chart is on another market. */
    onBar(bar: LiveBar): void {
        if (this.away != null) return;
        /* Fills only ever grow, and every one of them changes the account — a count that
         * could go both ways (pending, trades) nets out on exactly the case that matters
         * most: a stop filling, which takes one order off and books one trade. */
        const fills = this.session.broker.fills.length;
        const standing = this.session.barTime;
        this.session.onBar(bar);
        this.pushState();
        /* A tick that only moved the mark inside the same bar is not worth a write. A
         * fill is, and so is crossing into a new bar: the stored bar time is where a
         * catch-up starts from, and one left too far back would replay prices the
         * account has already been offered. One write per bar keeps that honest without
         * putting storage in the path of every tick. */
        if (this.session.broker.fills.length !== fills || this.session.barTime !== standing) this.persist();
    }

    /**
     * Walk the account over bars it missed while the app was closed, then stand on the
     * last of them. Returns how many were played.
     */
    catchUp(bars: readonly LiveBar[]): number {
        const played = this.session.catchUp(bars);
        this.pushState();
        if (played > 0) this.persist();
        return played;
    }

    /* --- trading (thin pass-throughs; the engine owns the rules) ----------- */

    order(spec: OrderSpec): Order {
        this.guard();
        const order = this.session.order(spec);
        this.settled();
        return order;
    }

    flatten(): void {
        this.guard();
        this.session.flatten();
        this.settled();
    }

    closeOne(positionId: number): void {
        this.guard();
        this.session.closeOne(positionId);
        this.settled();
    }

    closePart(size: number, positionId?: number | null): void {
        this.guard();
        this.session.closePart(size, positionId ?? null);
        this.settled();
    }

    reverse(positionId?: number | null): void {
        this.guard();
        this.session.reverse(positionId ?? null);
        this.settled();
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        this.session.protect(levels, positionId ?? null);
        this.settled();
    }

    breakEven(positionId?: number | null): boolean {
        const done = this.session.breakEven(positionId ?? null);
        this.settled();
        return done;
    }

    setTrailing(distance: number, options?: { activateAt?: number }, positionId?: number | null): void {
        this.session.setTrailing(distance, options ?? {}, positionId ?? null);
        this.settled();
    }

    cancelOrder(id: number): boolean {
        const gone = this.session.cancelOrder(id);
        this.settled();
        return gone;
    }

    cancelAll(tag?: string): void {
        this.session.cancelAll(tag);
        this.settled();
    }

    /* --- persistence ------------------------------------------------------ */

    /** The account and where it stands, ready to be written down. */
    snapshot(): { symbol: string; session: unknown } {
        return { symbol: this.boundSymbol, session: this.session.snapshot() };
    }

    /* --- internals -------------------------------------------------------- */

    /** Refuse anything that would open or close a position on the wrong market. Managing
     *  what is already open is left alone: a stop belongs to a position, not to a chart. */
    private guard(): void {
        if (this.away != null) throw new Error(this.away);
    }

    private settled(): void {
        this.pushState();
        this.persist();
    }

    private persist(): void {
        this.onPersist?.();
    }

    /**
     * Push the account's visual state to the indicator. JSON through a string input is
     * the only channel into a running native instance (`InputValue` is primitives only)
     * — a deliberate workaround, not a Vela feature.
     */
    private pushState(): void {
        this.markFills();
        this.onAccountChange?.();
        if (!this.indicator) return;
        this.indicator.setInput(STATE_INPUT, JSON.stringify(visualState(this.session.broker, this.price(), this.boundSymbol)));
    }

    /**
     * Write the account's current market onto every fill that does not carry one yet.
     *
     * The Broker records no symbol — it is one account in one instrument — and this app moves
     * that account between markets whenever it is flat. Its positions cannot survive the move,
     * but its fills do, so without this the account's whole history would be marked onto
     * whatever chart it happens to be standing on.
     *
     * Stamped onto the Broker's own record rather than kept in a list beside it, so it rides
     * `snapshot()`/`restore()` with the fill it belongs to and there is no second history to
     * fall out of step with the first. Run before anything reads the account, and ahead of the
     * write that follows a fill, so no fill is ever stored without its market. Fills only ever
     * grow, so the walk stops at the first one already stamped.
     *
     * What a restored account arrived UNstamped is left that way: those fills were made before
     * this was recorded, and the market the account happens to be on now is not evidence of
     * where they happened. They therefore go unmarked on every chart — which is the honest
     * answer, and the only one that cannot put a stale price into a live price scale.
     */
    private markFills(): void {
        const fills = this.session.broker.fills as Array<{ symbol?: string }>;
        for (let i = fills.length - 1; i >= this.inheritedFills; i -= 1) {
            if (fills[i]!.symbol != null) break;
            fills[i]!.symbol = this.boundSymbol;
        }
    }
}
