import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { IndicatorHandle } from '../../../src';
import type { ReplayVisualState } from '../replay/replayIndicator';
import { STATE_INPUT } from '../replay/replayIndicator';
import { venueBook, type TradeBook } from '../replay/tradeBook';
import type { ProjectXDealing } from '../providers/ProjectXProvider';
import type { ControlledPosition, TradingController } from './TradingController';

/**
 * Drives ONE futures contract on a ProjectX account.
 *
 * The same rule as every venue controller here: nothing is computed that the venue already
 * states, and nothing is drawn before the venue has confirmed it. A press sends an
 * instruction; what appears on the chart is whatever comes back on the next read.
 *
 * Protection is not an attribute of the position
 * ----------------------------------------------
 * This is the one way ProjectX differs from every other venue in this app, and the whole
 * shape of {@link protect} follows from it. The gateway takes brackets only when an order is
 * PLACED — there is no call that puts a stop on a position that is already open. (The
 * bracket settings in the platform are risk settings of the platform, and the drag-a-level
 * gesture is its own chart, not the API.)
 *
 * So a stop here is a real, resting order in the other direction, and a target is another.
 * Three consequences, all of them dealt with below rather than hidden:
 *
 *   Moving a level MODIFIES the resting order rather than cancelling and replacing it —
 *   there is no instant in which the position stands unprotected.
 *
 *   The two are not OCO. If the stop fills, the target is still working, and a target left
 *   working against a position that no longer exists would OPEN one the other way. So every
 *   reconcile sweeps protective orders whose position has gone.
 *
 *   That sweep runs on a timer, which means the window between a fill and the sweep is
 *   real — a few seconds. It is the honest cost of the venue's shape, and it is named here
 *   rather than papered over.
 */

export type ProjectXNotify = (message: string, kind: 'info' | 'error' | 'success') => void;

export interface ProjectXControllerOptions {
    /** The contract as the chart writes it — `NQU6`. */
    ticker: string;
    /** What every request carries — `CON.F.US.ENQ.U26`. */
    dealing: ProjectXDealing;
    notify: ProjectXNotify;
    /** Which account this is wired to, for anything that has to SAY so. */
    accountName?: string;
    /** Whether the account is a funded one. Never inferred: the gateway reports evaluation
     *  and funded accounts alike as simulated, so only the person connecting knows. */
    live?: boolean;
    onChange?: () => void;
}

/** The gateway's own position kinds. */
const POSITION_TYPE = { undefined: 0, long: 1, short: 2 } as const;
/** Its order kinds and sides, mirrored from app/electron/data/projectx.js. */
const ORDER_TYPE = { limit: 1, market: 2, stop: 4 } as const;
const ORDER_SIDE = { buy: 0, sell: 1 } as const;

interface ProjectXPosition extends ControlledPosition {
    contractId: string;
    openedAt: number;
    /** The resting orders currently protecting it, if any. */
    stopOrderId: number | null;
    targetOrderId: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    /** Computed here, because the gateway states no unrealized figure on a position. */
    unrealized: number;
}

interface GatewayPosition {
    id: number; accountId: number; contractId: string;
    creationTimestamp: string; type: number; size: number; averagePrice: number;
}
interface GatewayOrder {
    id: number; accountId: number; contractId: string;
    creationTimestamp: string; updateTimestamp: string;
    status: number; type: number; side: number; size: number;
    limitPrice: number | null; stopPrice: number | null; filledPrice: number | null;
}

/** How often the venue is re-read. Also the width of the orphan window described above. */
const RECONCILE_MS = 5_000;

export class ProjectXController implements TradingController {
    readonly ticker: string;
    readonly contractId: string;
    readonly dealing: ProjectXDealing;
    readonly isLive: boolean;
    readonly accountName: string;
    private readonly notify: ProjectXNotify;
    onChange: (() => void) | null;

    private open: ProjectXPosition[] = [];
    private resting: GatewayOrder[] = [];
    private balance = 0;
    private lastPrice = 0;
    private lastReadAt = 0;
    private stale = false;
    private indicator: IndicatorHandle | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;

    constructor(opts: ProjectXControllerOptions) {
        this.ticker = opts.ticker.toUpperCase();
        this.dealing = opts.dealing;
        this.contractId = opts.dealing.contractId;
        this.isLive = opts.live === true;
        this.accountName = opts.accountName ?? 'ProjectX';
        this.notify = opts.notify;
        this.onChange = opts.onChange ?? null;
    }

    // ── TradingController ────────────────────────────────────────────────

    price(): number { return this.lastPrice; }

    /** Marked from the quote stream — the venue's price, never one this class worked out. */
    mark(price: number): void {
        if (!(price > 0)) return;
        this.lastPrice = price;
        this.recomputeUnrealized();
        this.pushState();
        this.onChange?.();
    }

    positions(): readonly ProjectXPosition[] { return this.open; }
    orders(): readonly GatewayOrder[] { return this.resting; }
    book(): TradeBook { return venueBook(this.open, [], (p) => p.unrealized); }

    /** Futures settle in the account's currency; this gateway reports US dollars. */
    accountCurrency(): string { return 'USD'; }
    isStale(): boolean { return this.stale; }
    readAt(): number { return this.lastReadAt; }
    tradeable(): boolean { return true; }
    canShort(): boolean { return true; }

    /**
     * What the account is worth, as the venue states it, plus what is open.
     *
     * The balance is the gateway's own figure and the open result is added to it here —
     * unlike a margin venue, a ProjectX account reports no equity that already carries the
     * position. The addition is arithmetic on the venue's own numbers, not a valuation.
     */
    equity(): number {
        return this.balance + this.open.reduce((sum, p) => sum + p.unrealized, 0);
    }

    available(): number { return this.balance; }

    order(spec: OrderSpec): void {
        const size = Math.round(spec.size);
        if (!(size >= this.dealing.minSize)) {
            throw new Error(`Futures trade in whole contracts — ${this.ticker} needs at least ${this.dealing.minSize}.`);
        }
        const type = spec.type === 'limit' ? 'limit' : spec.type === 'stop' ? 'stop' : 'market';
        void this.send(window.midori.projectx.placeOrder({
            contractId: this.contractId,
            side: spec.side === 'sell' ? 'sell' : 'buy',
            type,
            size,
            ...(spec.limitPrice != null ? { limitPrice: spec.limitPrice } : {}),
            ...(spec.stopPrice != null ? { stopPrice: spec.stopPrice } : {}),
            ...(spec.tag != null ? { customTag: spec.tag } : {}),
            ...this.bracketTicks(spec),
        }), `${spec.side} ${size} ${this.ticker}`);
    }

    /**
     * Brackets asked for WITH the order, converted into the gateway's ticks.
     *
     * Preferred over {@link protect} when the protection is known up front: a bracket placed
     * with the order is the venue's own, attached the moment it fills, and it is linked to
     * the position rather than being two loose orders this class has to shepherd. Protection
     * added later has no such path — see the note on this class.
     *
     * Only distances convert. An absolute level would have to be measured against a fill
     * price that does not exist yet, and guessing it from the last trade would put the stop
     * somewhere nobody chose.
     */
    private bracketTicks(spec: OrderSpec): { stopLossTicks?: number; takeProfitTicks?: number } {
        const bracket = spec.bracket;
        if (!bracket) return {};
        const ticks = (distance: number | undefined): number | undefined => (
            distance != null && distance > 0 ? Math.max(1, Math.round(distance / this.dealing.tickSize)) : undefined
        );
        const stop = ticks(bracket.stopDistance);
        const target = ticks(bracket.targetDistance);
        return {
            ...(stop != null ? { stopLossTicks: stop } : {}),
            ...(target != null ? { takeProfitTicks: target } : {}),
        };
    }

    /** Cancel one resting order — what the dock's cancel button reaches. */
    cancelOrder(orderId: number): void {
        void this.send(window.midori.projectx.cancelOrder(orderId), 'cancel the order');
    }

    /**
     * Cancel every resting order on this contract.
     *
     * Including the protective ones, deliberately: this is the "clear the decks" gesture, and
     * a stop that survived it would be a stop nobody expects to still be there.
     */
    cancelAll(): void {
        const ids = this.resting.map((o) => o.id);
        if (!ids.length) return;
        void this.send(
            Promise.all(ids.map((id) => window.midori.projectx.cancelOrder(id))),
            'cancel the orders',
        );
    }

    /**
     * Put a stop and a target on an open position, replacing what it had.
     *
     * Each level is one resting order in the closing direction. An existing one is MOVED
     * rather than replaced — a cancel followed by a place leaves the position naked for as
     * long as the round trip takes, and that is exactly the moment a stop is for. A level
     * set to null cancels its order; `undefined` leaves that side alone, so dragging the
     * stop does not disturb the target.
     */
    protect(levels: ProtectionLevels, positionId?: number | null): void {
        const position = this.positionFor(positionId);
        if (!position) throw new Error(`No open ${this.ticker} position to protect.`);
        /* A long is closed by selling and a short by buying — protection always faces the
         * other way from the position it guards. */
        const closingSide = position.size > 0 ? 'sell' : 'buy';
        const size = Math.abs(position.size);

        if (levels.stopLoss !== undefined) {
            void this.setLevel(position, 'stop', levels.stopLoss, closingSide, size);
        }
        if (levels.takeProfit !== undefined) {
            void this.setLevel(position, 'target', levels.takeProfit, closingSide, size);
        }
    }

    /** Close one position outright, at market. */
    closeOne(positionId: number): void {
        const position = this.positionFor(positionId);
        if (!position) throw new Error(`No open ${this.ticker} position to close.`);
        void this.send(
            window.midori.projectx.closePosition(position.contractId),
            `close ${this.ticker}`,
        );
    }

    refreshVisuals(): void {
        this.pushState();
        this.onChange?.();
    }

    // ── Break-even ───────────────────────────────────────────────────────

    /**
     * Why break-even is refused right now, or null when it is available.
     *
     * Asked rather than discovered: a button that can be pressed and then explains itself is
     * worse than one that says beforehand why it is not offered. A stop AT the entry only
     * makes sense once the market has left it — placing one on the wrong side of the market
     * is an order the venue rejects, and one exactly at it is a stop that fills immediately.
     */
    breakEvenRefusal(positionId?: number | null): string | null {
        const position = this.positionFor(positionId);
        if (!position) return `No open ${this.ticker} position.`;
        if (!(this.lastPrice > 0)) return 'No price yet.';
        const ticks = (this.lastPrice - position.entryPrice) / this.dealing.tickSize;
        const inProfit = position.size > 0 ? ticks : -ticks;
        if (inProfit < 1) return 'The trade is not in profit yet.';
        if (position.stopLoss === position.entryPrice) return 'The stop is already at entry.';
        return null;
    }

    /** Move the stop to the entry price. The one gesture that has its own button. */
    breakEven(positionId?: number | null): void {
        const refusal = this.breakEvenRefusal(positionId);
        if (refusal) throw new Error(refusal);
        const position = this.positionFor(positionId)!;
        this.protect({ stopLoss: position.entryPrice }, position.id);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    start(): void {
        if (this.timer) return;
        void this.reconcile();
        this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    attachIndicator(indicator: IndicatorHandle | null): void {
        this.indicator = indicator;
        this.pushState();
    }

    // ── internals ────────────────────────────────────────────────────────

    private positionFor(positionId?: number | null): ProjectXPosition | null {
        if (positionId == null) return this.open[0] ?? null;
        return this.open.find((p) => p.id === positionId) ?? null;
    }

    /**
     * Send one instruction, report what the venue said, and re-read.
     *
     * Every instruction ends in a fresh read rather than in an assumption about what it did:
     * the chart is drawn from what the venue holds, so the only honest way to update it is
     * to ask again.
     */
    private async send(work: Promise<unknown>, what: string): Promise<void> {
        try {
            await work;
            await this.reconcile();
        } catch (e) {
            this.notify(e instanceof Error ? e.message : String(e), 'error');
            /* Re-read even after a refusal: a rejected instruction can still have changed
             * something (a partial fill, a bracket that did land), and the screen must go
             * back to being what is true rather than what was drawn hopefully. */
            await this.reconcile().catch(() => { /* the refusal was already reported */ });
            throw e instanceof Error ? e : new Error(String(e));
        }
    }

    /**
     * Place, move or cancel one protective level.
     *
     * The order is identified by what it already is: a stop order protecting this position
     * is one in the closing direction with a stop price. Found, it is moved; absent, it is
     * placed; asked for null, it is cancelled.
     */
    private async setLevel(
        position: ProjectXPosition,
        which: 'stop' | 'target',
        price: number | null,
        closingSide: 'buy' | 'sell',
        size: number,
    ): Promise<void> {
        const existingId = which === 'stop' ? position.stopOrderId : position.targetOrderId;

        if (price == null) {
            if (existingId == null) return;
            await this.send(window.midori.projectx.cancelOrder(existingId), `remove the ${which}`);
            return;
        }

        if (existingId != null) {
            // Moved, not replaced: no window in which the position is unprotected.
            await this.send(
                window.midori.projectx.modifyOrder(existingId, which === 'stop' ? { stopPrice: price } : { limitPrice: price }),
                `move the ${which}`,
            );
            return;
        }

        await this.send(window.midori.projectx.placeOrder({
            contractId: position.contractId,
            side: closingSide,
            type: which === 'stop' ? 'stop' : 'limit',
            size,
            ...(which === 'stop' ? { stopPrice: price } : { limitPrice: price }),
        }), `set the ${which}`);
    }

    /**
     * Re-read the account, and reconcile what is drawn with what the venue holds.
     *
     * Three reads in one round because they are one picture: what is open, what is resting
     * against it, and what the account is worth. Reading them apart would draw a position
     * with a stop that has already been cancelled, or the other way round.
     */
    private async reconcile(): Promise<void> {
        if (this.reconciling) return;
        this.reconciling = true;
        try {
            const [positions, orders, accounts] = await Promise.all([
                window.midori.projectx.positions() as Promise<GatewayPosition[]>,
                window.midori.projectx.openOrders() as Promise<GatewayOrder[]>,
                window.midori.projectx.accounts(true),
            ]);
            const chosen = await window.midori.projectx.account();
            const account = accounts.find((a) => a.id === chosen.accountId);
            this.balance = account?.balance ?? this.balance;

            const mine = positions.filter((p) => p.contractId === this.contractId);
            this.resting = orders.filter((o) => o.contractId === this.contractId);
            this.open = mine.map((p) => this.toPosition(p));
            this.recomputeUnrealized();
            this.lastReadAt = Date.now();
            this.stale = false;
            await this.sweepOrphans(positions);
            this.pushState();
            this.onChange?.();
        } catch (e) {
            /* Marked rather than thrown: a failed read is a screen that must stop claiming to
             * be current, not a reason to tear the chart down. The next round usually fixes
             * it, and `isStale` is what the mount shows in the meantime. */
            this.stale = true;
            console.warn(`[midorii] ProjectX: could not read the account — ${e instanceof Error ? e.message : String(e)}`);
            this.onChange?.();
        } finally {
            this.reconciling = false;
        }
    }

    /**
     * Cancel protective orders whose position is gone.
     *
     * The reason this class polls at all. A stop and a target are two independent orders
     * here, and the venue does not link them — so when one fills, the other is left working
     * against nothing. Left alone it would eventually fill too, and open a position in the
     * opposite direction that nobody asked for.
     *
     * Only orders on contracts with no position are swept, and only ones that look
     * protective — a resting entry the person placed deliberately is not this function's
     * business.
     */
    private async sweepOrphans(positions: readonly GatewayPosition[]): Promise<void> {
        const held = new Set(positions.map((p) => p.contractId));
        const orphans = this.resting.filter((o) => (
            !held.has(o.contractId) && (o.type === ORDER_TYPE.stop || o.type === ORDER_TYPE.limit)
        ));
        if (!orphans.length) return;
        for (const order of orphans) {
            try {
                await window.midori.projectx.cancelOrder(order.id);
                this.notify(`Cancelled a ${order.type === ORDER_TYPE.stop ? 'stop' : 'target'} left over from a closed ${this.ticker} position.`, 'info');
            } catch (e) {
                /* Said once, loudly: an orphan that cannot be cancelled is the dangerous
                 * case — it is a live order against nothing, and the person has to know. */
                this.notify(`A leftover ${this.ticker} order (${order.id}) could not be cancelled — check it on the platform. ${e instanceof Error ? e.message : String(e)}`, 'error');
            }
        }
        this.resting = this.resting.filter((o) => !orphans.includes(o));
    }

    /** One gateway position, with the protective orders that belong to it attached. */
    private toPosition(raw: GatewayPosition): ProjectXPosition {
        /* Signed the way the chart reads it: the gateway states a direction and a positive
         * size, and everything downstream here works in signed sizes. */
        const signed = raw.type === POSITION_TYPE.short ? -raw.size : raw.size;
        const closing = signed > 0 ? ORDER_SIDE.sell : ORDER_SIDE.buy;
        const guards = this.resting.filter((o) => o.contractId === raw.contractId && o.side === closing);
        const stop = guards.find((o) => o.type === ORDER_TYPE.stop) ?? null;
        const target = guards.find((o) => o.type === ORDER_TYPE.limit) ?? null;
        return {
            id: raw.id,
            size: signed,
            entryPrice: raw.averagePrice,
            contractId: raw.contractId,
            openedAt: Date.parse(raw.creationTimestamp),
            stopOrderId: stop?.id ?? null,
            targetOrderId: target?.id ?? null,
            stopLoss: stop?.stopPrice ?? null,
            takeProfit: target?.limitPrice ?? null,
            unrealized: 0,
        };
    }

    /**
     * What each position is worth right now, in money.
     *
     * Ticks moved times the value of a tick times the contracts held — the only correct way
     * on a futures contract, and the reason `tickValue` is carried on the symbol at all. A
     * naive price difference would be out by the contract multiplier: four points on one NQ
     * is 80 dollars, not four.
     */
    private recomputeUnrealized(): void {
        if (!(this.lastPrice > 0)) return;
        const { tickSize, tickValue } = this.dealing;
        for (const position of this.open) {
            const ticks = (this.lastPrice - position.entryPrice) / tickSize;
            position.unrealized = ticks * tickValue * position.size;
        }
    }

    /** Hand the chart's own indicator the state it draws positions and levels from. */
    private pushState(): void {
        if (!this.indicator) return;
        const state: ReplayVisualState = {
            positions: this.open.map((p) => ({
                id: p.id,
                size: p.size,
                entryPrice: p.entryPrice,
                stopLoss: p.stopLoss,
                takeProfit: p.takeProfit,
            })),
            orders: [],
            price: this.lastPrice,
        } as unknown as ReplayVisualState;
        this.indicator.setInput(STATE_INPUT, state as unknown as number);
    }
}
