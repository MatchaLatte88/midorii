import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { IndicatorHandle } from '../../../src';
import type { ReplayVisualState } from '../replay/replayIndicator';
import { STATE_INPUT } from '../replay/replayIndicator';
import { venueBook, type TradeBook } from '../replay/tradeBook';
import { tickDecimals, type ProjectXDealing } from '../providers/ProjectXProvider';
import type { ControlledPosition, TradingController } from './TradingController';
import { projectxHistory } from './projectxHistory';
import { chime } from './fillChime';
import type { HistoryRow } from '../replay/tradeBook';

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
 *   That sweep runs when the account is re-read, so the window between a fill and the sweep
 *   is real. The gateway's account-side hub is what makes it small: a fill arrives as an
 *   event and the read follows within a round trip of it. Where that socket cannot be opened
 *   the class falls back to asking every few seconds, which is what it did before — slower,
 *   and still correct. Named here rather than papered over either way.
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
const ORDER_TYPE = { limit: 1, market: 2, stop: 4, trailingStop: 5 } as const;
const ORDER_SIDE = { buy: 0, sell: 1 } as const;

interface ProjectXPosition extends ControlledPosition {
    contractId: string;
    openedAt: number;
    /** The resting orders currently protecting it, if any. */
    stopOrderId: number | null;
    targetOrderId: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    /** The stop is a trailing stop order rather than a fixed one. */
    trailing: boolean;
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

/**
 * How often the venue is re-read when nothing is telling us to.
 *
 * Also the width of the orphan window described above, which is why it is as short as it is:
 * with no push, this interval is how long a leftover protective order can sit working against
 * a position that has gone.
 */
const RECONCILE_MS = 5_000;

/**
 * The same, once the account-side hub is up.
 *
 * A fill then arrives as an event and is read within a round trip of happening, so the timer
 * stops being the thing that notices and goes back to being what it should be: a check that
 * the picture has not drifted. Four REST calls every half minute rather than every five
 * seconds — the gateway is rate-limited, and the calls were buying latency that is now free.
 */
const PUSHED_RECONCILE_MS = 30_000;

/**
 * How long a burst of events is allowed to collapse into one read.
 *
 * A single fill emits several — the order, the position, the trade — and reading four times
 * for one event would spend the rate limit this hub exists to save. Short enough that nobody
 * perceives it as a delay.
 */
const NUDGE_MS = 120;

/**
 * How often the closed-trade record is re-read when nothing suggests it has changed.
 *
 * Its own beat, because it is its own REST call and it answers a different question from the
 * account read: what is open changes on every tick, what has CLOSED changes only when a
 * position ends. A close is noticed the moment it happens and read straight away — this is
 * the floor under that, for a trade closed somewhere else.
 */
const HISTORY_MS = 60_000;

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
    /**
     * Orders this app placed to GET IN, by the id the gateway answered with.
     *
     * The one thing that tells a deliberate resting entry apart from a protective leg left
     * over from a position that has closed: on a flat contract the two are the same object —
     * a limit or a stop, waiting. {@link sweepOrphans} cancels the second and must never
     * cancel the first. Pruned on every read, so an entry that fills or is cancelled stops
     * being remembered.
     */
    private readonly working = new Set<number>();
    private balance = 0;
    private lastPrice = 0;
    private lastBid = 0;
    private lastAsk = 0;
    private lastReadAt = 0;
    private stale = false;
    private indicator: IndicatorHandle | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;
    /** A read asked for while one was already running — see {@link nudge}. */
    private rereadWanted = false;
    private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Let go of the account-side feed. Null while it is not up. */
    private unsubscribeUser: (() => void) | null = null;
    /** Whether the gateway is pushing account changes, which is what decides how often this
     *  class has to ask instead. */
    private pushed = false;
    /** Closed round trips, newest first — read fresh by the panel, refreshed here. */
    private closed: HistoryRow[] = [];
    private historyReadAt = 0;
    private historyInFlight = false;
    /** What was open at the last read, so a fill can be noticed rather than waited for. */
    private lastHeld = new Map<number, number>();
    /** The newest closed trade already announced, so a re-read does not announce it twice. */
    private lastClosedAt = 0;
    /** Whether a read has happened at all. The first one is the state of the world, not news. */
    private announced = false;

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

    /**
     * The two sides of the market, as the contract's quote feed states them.
     *
     * Kept apart from {@link mark}, and deliberately not folded into `price`: everything this
     * class values — the open result, a level's worth — is marked against what TRADED, and a
     * mid would quietly restate all of it every time the spread moved without a print. The
     * ticket is the one place the two sides belong, because that is where a person is choosing
     * a direction and wants to see what a buy costs and what a sell gets.
     *
     * Each side is remembered separately: the feed sends deltas, and a message carrying only
     * a new bid must not be read as an ask that has gone away.
     */
    markQuote(bid: number | null, ask: number | null): void {
        if (bid != null && bid > 0) this.lastBid = bid;
        if (ask != null && ask > 0) this.lastAsk = ask;
        this.onChange?.();
    }

    /** The two sides, or null until the feed has stated both. */
    quote(): { bid: number; ask: number } | null {
        return this.lastBid > 0 && this.lastAsk > 0 ? { bid: this.lastBid, ask: this.lastAsk } : null;
    }

    positions(): readonly ProjectXPosition[] { return this.open; }

    /**
     * The orders a person means when they say "my orders" — what is waiting to get IN.
     *
     * A position's stop and target are resting orders here too (see the note on this class),
     * but the position already draws them as its levels. Listing them again would offer two
     * ways to cancel the same protection, one of which leaves the position looking protected.
     * The same rule the engine's own book applies to its reduce-only legs.
     */
    orders(): readonly GatewayOrder[] { return this.workingOrders(); }

    book(): TradeBook {
        const rows = this.workingOrders()
            .map((o) => ({
                id: o.id,
                side: o.side === ORDER_SIDE.sell ? ('sell' as const) : ('buy' as const),
                price: o.type === ORDER_TYPE.stop ? o.stopPrice : o.limitPrice,
                size: o.size,
                kind: o.type === ORDER_TYPE.stop ? ('stop' as const) : ('limit' as const),
            }))
            // An order the venue states no price for has no row to sit on; a zero would be a
            // price nobody asked for, printed where a real one belongs.
            .filter((o): o is { id: number; side: 'buy' | 'sell'; price: number; size: number; kind: 'limit' | 'stop' } => o.price != null);
        return venueBook(this.open, rows, (p) => p.unrealized, (p) => this.breakEvenRefusal(p.id));
    }

    /**
     * What one point of this contract is worth, per contract, in account money.
     *
     * `tickValue` is what one TICK is worth, so the points-per-tick divide is what turns it
     * into a per-point figure: on NQ a quarter-point tick worth five dollars is twenty dollars
     * a point. Stated rather than assumed to be one, which is the assumption every figure on
     * the ticket used to be built on.
     */
    pointValue(): number { return this.dealing.tickValue / this.dealing.tickSize; }

    /** Whole contracts, downwards. Futures do not trade in pieces. */
    sizeOnGrid(size: number): number {
        const step = this.dealing.sizeStep > 0 ? this.dealing.sizeStep : 1;
        const snapped = Math.floor((size + step * 1e-9) / step) * step;
        return snapped >= this.dealing.minSize ? snapped : 0;
    }

    /**
     * What this account has already closed, newest first.
     *
     * Read fresh by the panel on every repaint and refreshed here, because the gateway states
     * executions rather than trades and pairing them is work — see {@link projectxHistory}.
     */
    history(): readonly HistoryRow[] { return this.closed; }

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
        /* Down to a whole contract, never up: the size arriving here was worked out from a
         * risk, and raising it raises what the trade loses at its stop past the figure the
         * person agreed to. */
        const size = this.sizeOnGrid(spec.size);
        if (!(size >= this.dealing.minSize)) {
            throw new Error(`Futures trade in whole contracts — ${this.ticker} needs at least ${this.dealing.minSize}.`);
        }
        const type = spec.type === 'limit' ? 'limit' : spec.type === 'stop' ? 'stop' : 'market';
        /* An entry price reaches here the same way a dragged level does — off the chart, at
         * whatever the pixel under the cursor stood for — so it goes on the tick grid before
         * anything else happens to it (see {@link onTick}). Put on the spec rather than on the
         * payload alone, because the brackets are measured FROM this price: rounding it in one
         * place and measuring from the other would put the stop a fraction of a tick off what
         * the order actually rests at. */
        const priced: OrderSpec = {
            ...spec,
            ...(spec.limitPrice != null ? { limitPrice: this.onTick(spec.limitPrice) } : {}),
            ...(spec.stopPrice != null ? { stopPrice: this.onTick(spec.stopPrice) } : {}),
        };
        /* Worked out before the call rather than inside it: a bracket that cannot be expressed
         * in the gateway's own shape throws, and it has to throw HERE — synchronously, out of
         * the press that asked for it — rather than leaving an unprotected order behind. */
        const brackets = this.bracketTicks(priced);
        void this.send(window.midori.projectx.placeOrder({
            contractId: this.contractId,
            side: spec.side === 'sell' ? 'sell' : 'buy',
            type,
            size,
            ...(priced.limitPrice != null ? { limitPrice: priced.limitPrice } : {}),
            ...(priced.stopPrice != null ? { stopPrice: priced.stopPrice } : {}),
            ...(spec.tag != null ? { customTag: spec.tag } : {}),
            ...brackets,
        }), `${spec.side} ${size} ${this.ticker}`, (result) => {
            /* A resting entry is remembered by id, because that is the only thing separating it
             * from a leftover protective leg once it is sitting on a flat contract — see
             * {@link sweepOrphans}. A market order rests for nobody and is not recorded. */
            if (type !== 'market' && result.orderId != null) this.working.add(result.orderId);
        }).catch(() => { /* send has already put the venue's refusal in front of the person */ });
    }

    /**
     * Brackets asked for WITH the order, converted into the gateway's ticks.
     *
     * Preferred over {@link protect} when the protection is known up front: a bracket placed
     * with the order is the venue's own, attached the moment it fills, and it is linked to
     * the position rather than being two loose orders this class has to shepherd. Protection
     * added later has no such path — see the note on this class.
     *
     * Both shapes of {@link OrderBracket} arrive here and both have to leave as ticks.
     * A distance already is one. A LEVEL — which is what the ticket panel and a block drawn
     * on the chart both produce — is turned into one by measuring it against where this order
     * goes in: the typed price for a resting order, the last trade for a market one. That is
     * an approximation for the market case, and the honest kind: the fill lands a spread from
     * the last trade, so the stop ends up that same spread from where it was drawn. The
     * alternative is what this method used to do — read only distances, and drop a level
     * silently — which sent an order the person believed was protected and was not.
     *
     * Anything that cannot be converted THROWS rather than being left out. An order that
     * quietly loses its stop is the one failure this venue must not have.
     */
    private bracketTicks(spec: OrderSpec): { stopLossTicks?: number; takeProfitTicks?: number } {
        const bracket = spec.bracket;
        if (!bracket) return {};

        const ticks = (distance: number | undefined): number | undefined => (
            distance != null && distance > 0 ? Math.max(1, Math.round(distance / this.dealing.tickSize)) : undefined
        );

        /** Where this order is expected to go in — what a level is a distance FROM. */
        const reference = spec.type === 'limit' ? spec.limitPrice
            : spec.type === 'stop' ? spec.stopPrice
            : this.lastPrice;

        const fromLevel = (level: number | undefined, which: 'stop' | 'target'): number | undefined => {
            if (level == null) return undefined;
            if (reference == null || !(reference > 0)) {
                throw new Error(`The ${which} cannot be sent — there is no entry price yet to measure it from.`);
            }
            /* Which side it belongs on is not this method's rule to invent; it is the same one
             * `levelAllowed` holds a dragged level to, checked again here because a distance
             * carries no side and a mirrored one would protect nothing. */
            const below = level < reference;
            const wantBelow = which === 'stop' ? spec.side === 'buy' : spec.side === 'sell';
            if (below !== wantBelow) {
                throw new Error(which === 'stop'
                    ? 'A stop belongs on the losing side of the entry.'
                    : 'A target belongs on the winning side of the entry.');
            }
            const converted = ticks(Math.abs(level - reference));
            if (converted == null) {
                throw new Error(`The ${which} is at the entry — there is no distance to send.`);
            }
            return converted;
        };

        const stop = ticks(bracket.stopDistance) ?? fromLevel(bracket.stopLoss, 'stop');
        const target = ticks(bracket.targetDistance) ?? fromLevel(bracket.takeProfit, 'target');
        return {
            ...(stop != null ? { stopLossTicks: stop } : {}),
            ...(target != null ? { takeProfitTicks: target } : {}),
        };
    }

    /**
     * Move a resting order to a new price — what a drag on its line reaches.
     *
     * Which FIELD carries the price follows from what kind of order it is: a stop waits on its
     * trigger and a limit on its level, and sending the wrong one would leave the order where
     * it was while the chart showed it somewhere else. Looked up rather than guessed, and an
     * order that is no longer resting refuses rather than inventing a kind for it.
     */
    moveOrder(orderId: number, price: number): void {
        const order = this.resting.find((o) => o.id === orderId);
        if (!order) throw new Error('That order is no longer working — it may have filled or been cancelled.');
        const patch = order.type === ORDER_TYPE.stop ? { stopPrice: price } : { limitPrice: price };
        void this.send(window.midori.projectx.modifyOrder(orderId, patch), 'move the order');
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

    /**
     * Bring the protective orders back to the size of the position they guard.
     *
     * Taking part of a position off leaves its stop and its target standing at the size the
     * position used to be. On this venue those are ordinary resting orders and the gateway
     * has no opinion about it, so a stop for two contracts goes on working against a position
     * of one — and filling it would close the one and open another the other way.
     *
     * Run from the reconcile, so it corrects a partial close made anywhere: this app, the
     * venue's own platform, or a bracket that filled half. Resized rather than replaced, for
     * the reason {@link setLevel} gives — there is no instant without protection.
     */
    private async resizeGuards(): Promise<void> {
        for (const position of this.open) {
            const want = Math.abs(position.size);
            for (const id of [position.stopOrderId, position.targetOrderId]) {
                if (id == null) continue;
                const order = this.resting.find((o) => o.id === id);
                if (!order || order.size === want) continue;
                try {
                    await window.midori.projectx.modifyOrder(id, { size: want });
                    /* Locally too, so the next round does not ask again while the read that
                     * would have confirmed it is still in flight. */
                    order.size = want;
                } catch (e) {
                    this.notify(
                        `A ${this.ticker} protective order is still sized for ${order.size} against a position of ${want}, `
                        + `and could not be corrected — check it on the platform. ${e instanceof Error ? e.message : String(e)}`,
                        'error',
                    );
                }
            }
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

    /**
     * Take part of a position off at market — the gateway's own partial close.
     *
     * Down to whole contracts, and refused where that leaves nothing to take or everything:
     * half of one contract is not an order, and "part" that is the whole position is a close,
     * which has its own call. The stop and target are brought down to the new size by the
     * reconcile that follows ({@link resizeGuards}).
     */
    closePart(size: number, positionId?: number | null): void {
        const position = this.positionFor(positionId);
        if (!position) throw new Error(`No open ${this.ticker} position to take part of.`);
        const held = Math.abs(position.size);
        const part = this.sizeOnGrid(Math.abs(size));
        if (!(part >= this.dealing.minSize)) {
            throw new Error(`${held} ${this.ticker} cannot be split into whole contracts — close the position instead.`);
        }
        if (part >= held) throw new Error('That is the whole position — close it instead.');
        void this.send(
            window.midori.projectx.closePosition(position.contractId, part),
            `close ${part} ${this.ticker}`,
        ).catch(() => { /* send has already put the venue's refusal in front of the person */ });
    }

    /**
     * Turn the position round: one market order for twice its size, the other way.
     *
     * One order rather than a close and an open, so there is no moment of being flat between
     * two instructions of which the second can be refused. The stop and target go FIRST: they
     * face the other way from the new position, and a sell stop left under a short adds to it
     * when it triggers. If they cannot be cancelled nothing is sent; if the order is refused
     * after they were, the position is still open without them, and that is said out loud.
     */
    reverse(positionId?: number | null): void {
        const position = this.positionFor(positionId);
        if (!position) throw new Error(`No open ${this.ticker} position to reverse.`);
        void this.flip(position);
    }

    private async flip(position: ProjectXPosition): Promise<void> {
        const guards = [position.stopOrderId, position.targetOrderId].filter((id): id is number => id != null);
        try {
            await Promise.all(guards.map((id) => window.midori.projectx.cancelOrder(id)));
        } catch (e) {
            this.notify(
                `Not reversed — the ${this.ticker} stop or target could not be cancelled first. `
                + `${e instanceof Error ? e.message : String(e)}`,
                'error',
            );
            await this.reconcile().catch(() => { /* the refusal was already reported */ });
            return;
        }
        const size = Math.abs(position.size);
        await this.send(window.midori.projectx.placeOrder({
            contractId: position.contractId,
            side: position.size > 0 ? 'sell' : 'buy',
            type: 'market',
            size: size * 2,
        }), `reverse ${size} ${this.ticker}`).catch(() => {
            if (guards.length) {
                this.notify(`The ${this.ticker} position is still open WITHOUT its stop and target — they were cancelled before the reverse was refused.`, 'error');
            }
        });
    }

    /**
     * Replace the stop with a trailing stop `distance` behind the market.
     *
     * The gateway takes the trail as a PRICE LEVEL and measures the distance from the last
     * trade itself, so the level sent is the last price less the distance for a long and plus
     * it for a short. The new stop is placed before the old one is cancelled: for a round trip
     * there are two stops, never none.
     */
    setTrailing(distance: number, positionId?: number | null): void {
        const position = this.positionFor(positionId);
        if (!position) throw new Error(`No open ${this.ticker} position to trail.`);
        if (!(this.lastPrice > 0)) throw new Error('No price yet to trail from.');
        if (!(distance >= this.dealing.tickSize)) {
            throw new Error(`A trail needs at least one tick (${this.dealing.tickSize}).`);
        }
        const long = position.size > 0;
        const trailPrice = this.onTick(long ? this.lastPrice - distance : this.lastPrice + distance);
        void this.replaceStop(position, {
            type: 'trailingStop',
            trailPrice,
        }, 'set the trailing stop').catch(() => { /* reported by send */ });
    }

    /** Place a new stop in the closing direction, then cancel the one it replaces. */
    private async replaceStop(
        position: ProjectXPosition,
        stop: { type: 'stop'; stopPrice: number } | { type: 'trailingStop'; trailPrice: number },
        what: string,
    ): Promise<void> {
        const previous = position.stopOrderId;
        await this.send(window.midori.projectx.placeOrder({
            contractId: position.contractId,
            side: position.size > 0 ? 'sell' : 'buy',
            size: Math.abs(position.size),
            ...stop,
        }), what);
        if (previous != null) await this.send(window.midori.projectx.cancelOrder(previous), 'remove the previous stop');
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
        /* Within a tick of the entry, not exactly on it. Both numbers have been through a
         * divide and a round on the way here, and an exact comparison would offer the gesture
         * again on a stop that is already sitting where it would put one. */
        if (position.stopLoss != null
            && Math.abs(position.stopLoss - position.entryPrice) < this.dealing.tickSize / 2) {
            return 'The stop is already at entry.';
        }
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
        this.beat(RECONCILE_MS);
        void this.listen();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.nudgeTimer) { clearTimeout(this.nudgeTimer); this.nudgeTimer = null; }
        this.unsubscribeUser?.();
        this.unsubscribeUser = null;
        this.pushed = false;
    }

    /** Whether the gateway is pushing account changes rather than this class asking for them. */
    isPushed(): boolean { return this.pushed; }

    /** Re-read on this interval, replacing whatever beat was running. */
    private beat(every: number): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => void this.reconcile(), every);
    }

    /**
     * Take the account-side feed, and slow the timer down once it is up.
     *
     * Best effort, and silent when it fails: a gateway that will not open this socket is not
     * a reason to refuse to trade, it is a reason to go on asking every five seconds — which
     * is exactly what this class did before the socket existed. The only thing that changes
     * on failure is that nothing changes.
     */
    private async listen(): Promise<void> {
        try {
            const off = window.midori.projectx.onUserEvent(() => this.nudge());
            const id = await window.midori.projectx.subscribeUser();
            /* Stopped while the socket was opening — the handle is still owed a release, and
             * the timer must not be slowed down for a feed nobody is listening to. */
            if (!this.timer) {
                off();
                void window.midori.projectx.unsubscribeUser(id);
                return;
            }
            this.unsubscribeUser = () => {
                off();
                void window.midori.projectx.unsubscribeUser(id);
            };
            this.pushed = true;
            this.beat(PUSHED_RECONCILE_MS);
            this.onChange?.();
        } catch (e) {
            console.warn(`[midorii] ProjectX is not pushing account changes — ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Something happened to the account: read it, once, however many events said so.
     *
     * A fill arrives as three or four events in the same instant, and each of them means the
     * same thing here. Collapsed into one read on a short delay, and a read asked for while
     * one is already in flight is remembered rather than dropped — the running read may have
     * left before the change landed, so answering it with "already reading" would show the
     * state from just before the fill and then sit on it until the slow beat came round.
     */
    private nudge(): void {
        if (this.nudgeTimer) return;
        this.nudgeTimer = setTimeout(() => {
            this.nudgeTimer = null;
            void this.reconcile();
        }, NUDGE_MS);
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
     * Say out loud what has just filled.
     *
     * A position that was not there a moment ago, or one that grew — both are a fill, and both
     * are the thing a person needs to know without having been watching. Worked out by
     * comparing two reads rather than from the hub's own events: those are a doorbell here and
     * carry no shape this class trusts, and the comparison is true whatever caused it — an
     * order of this app's, a bracket that triggered, a press on the venue's own platform.
     *
     * The FIRST read announces nothing. Opening a chart onto a position that has been on since
     * yesterday is not a fill, and a toast saying it was would be the app's first lie.
     */
    private announceFills(): void {
        const held = new Map(this.open.map((p) => [p.id, p.size]));
        if (this.announced) {
            for (const [id, size] of held) {
                const before = this.lastHeld.get(id) ?? 0;
                const grew = Math.abs(size) > Math.abs(before);
                if (!grew) continue;
                const added = Math.abs(size) - Math.abs(before);
                const position = this.open.find((p) => p.id === id);
                this.notify(
                    `Filled — ${size > 0 ? 'long' : 'short'} ${added} ${this.ticker} at ${position?.entryPrice ?? this.lastPrice}`,
                    'success',
                );
                chime('fill');
            }
        }
        this.lastHeld = held;
        this.announced = true;
    }

    /**
     * Say what a closed trade came to, once the record has caught up with it.
     *
     * Separate from the fill notice because it answers a different question and arrives at a
     * different moment: what is OPEN changes the instant a stop triggers, what it MADE is known
     * when the venue has booked it. Announced from the record rather than computed here, so the
     * figure in the toast is the figure in the History tab.
     */
    private announceCloses(): void {
        const newest = this.closed[0];
        if (!newest) return;
        if (!this.announced || newest.closedAt <= this.lastClosedAt) {
            this.lastClosedAt = Math.max(this.lastClosedAt, newest.closedAt);
            return;
        }
        this.lastClosedAt = newest.closedAt;
        const sign = newest.netPnl >= 0 ? '+' : '−';
        this.notify(
            `Closed ${newest.side} ${newest.size} ${this.ticker} — ${sign}${Math.abs(newest.netPnl).toFixed(2)}`,
            newest.netPnl >= 0 ? 'success' : 'info',
        );
        chime('close');
    }

    /**
     * Re-read the closed-trade record, unless it was read recently enough.
     *
     * Never allowed to fail loudly: a record that cannot be fetched is a History tab showing
     * what it last knew, which is a smaller problem than a position that cannot be traded.
     * The account read it rides beside has its own staleness marker for the figures that
     * actually matter while a trade is on.
     */
    private async refreshHistory(now: boolean): Promise<void> {
        if (this.historyInFlight) return;
        if (!now && Date.now() - this.historyReadAt < HISTORY_MS) return;
        this.historyInFlight = true;
        try {
            const trades = await window.midori.projectx.trades();
            this.closed = projectxHistory(trades);
            this.historyReadAt = Date.now();
            this.announceCloses();
            this.onChange?.();
        } catch (e) {
            console.warn(`[midorii] ProjectX: could not read the trade record — ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.historyInFlight = false;
        }
    }

    /** Everything resting that is not an open position's own protection. See {@link orders}. */
    private workingOrders(): GatewayOrder[] {
        const guards = new Set<number>();
        for (const p of this.open) {
            if (p.stopOrderId != null) guards.add(p.stopOrderId);
            if (p.targetOrderId != null) guards.add(p.targetOrderId);
        }
        return this.resting.filter((o) => !guards.has(o.id));
    }

    /**
     * Send one instruction, report what the venue said, and re-read.
     *
     * Every instruction ends in a fresh read rather than in an assumption about what it did:
     * the chart is drawn from what the venue holds, so the only honest way to update it is
     * to ask again.
     *
     * `record` runs on the venue's answer BEFORE that read. An order this class has to
     * remember — a working entry, which {@link sweepOrphans} must not touch — is then already
     * known to the reconcile that follows. Recorded afterwards, there would be exactly one
     * sweep in which an order this app had just placed looked like an order nobody claimed.
     */
    private async send<T>(work: Promise<T>, what: string, record?: (result: T) => void): Promise<T> {
        try {
            const result = await work;
            record?.(result);
            await this.reconcile();
            return result;
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

        const level = this.onTick(price);

        /* A level set on a trailing stop fixes it there. The trail cannot be modified into a
         * plain stop, so it is replaced — new one first, for the reason given above. */
        if (which === 'stop' && existingId != null && position.trailing) {
            await this.replaceStop(position, { type: 'stop', stopPrice: level }, 'set the stop');
            return;
        }

        if (existingId != null) {
            // Moved, not replaced: no window in which the position is unprotected.
            await this.send(
                window.midori.projectx.modifyOrder(existingId, which === 'stop' ? { stopPrice: level } : { limitPrice: level }),
                `move the ${which}`,
            );
            return;
        }

        await this.send(window.midori.projectx.placeOrder({
            contractId: position.contractId,
            side: closingSide,
            type: which === 'stop' ? 'stop' : 'limit',
            size,
            ...(which === 'stop' ? { stopPrice: level } : { limitPrice: level }),
        }), `set the ${which}`);
    }

    /**
     * A price the venue will accept: the nearest whole tick.
     *
     * A dragged level arrives as whatever price the pixel under the cursor stands for, and
     * that is a continuous number — 29410.29 on a contract that trades in quarters. ProjectX
     * refuses it outright ("Invalid stop price. Price is outside allowed range"), so the
     * rounding happens here rather than being left to the person to hit exactly.
     *
     * `toFixed` after the multiplication, because the multiplication is where the binary
     * fractions show: a tick of 0.1 turns 3 steps into 0.30000000000000004, and a price with
     * a tail like that is refused for the same reason the unrounded one was.
     *
     * Nearest, not outward. The level means where it was DRAWN; moving a stop half a tick
     * further from the market would be this class deciding the trade is worth a bit more
     * risk than the person asked for.
     */
    private onTick(price: number): number {
        const { tickSize } = this.dealing;
        if (!(tickSize > 0)) return price;
        return Number((Math.round(price / tickSize) * tickSize).toFixed(tickDecimals(tickSize)));
    }

    /**
     * Re-read the account, and reconcile what is drawn with what the venue holds.
     *
     * Three reads in one round because they are one picture: what is open, what is resting
     * against it, and what the account is worth. Reading them apart would draw a position
     * with a stop that has already been cancelled, or the other way round.
     */
    private async reconcile(): Promise<void> {
        /* Remembered rather than dropped. The read already in flight may have left before the
         * change that prompted this one landed, so returning here without a note would leave
         * the screen a fill behind until the next beat — which, once the hub is up, is half a
         * minute away. Picked up in the `finally` below. */
        if (this.reconciling) { this.rereadWanted = true; return; }
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

            const held = this.open.length;
            const mine = positions.filter((p) => p.contractId === this.contractId);
            this.resting = orders.filter((o) => o.contractId === this.contractId);
            /* An entry that has filled or been cancelled is not resting any more, and a set
             * that went on remembering it would spare a protective leg that later took the
             * same id. Pruned against what the venue actually holds, every read. */
            const alive = new Set(orders.map((o) => o.id));
            for (const id of this.working) if (!alive.has(id)) this.working.delete(id);
            this.open = mine.map((p) => this.toPosition(p));
            this.recomputeUnrealized();
            this.lastReadAt = Date.now();
            this.stale = false;
            /* A position that was open a moment ago and is not now has closed, and a closed
             * position is exactly what the record is about — so it is re-read then rather
             * than waiting out the slow beat. */
            const closedSomething = this.open.length < held;
            this.announceFills();
            await this.sweepOrphans(positions);
            await this.resizeGuards();
            void this.refreshHistory(closedSomething);
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
        if (this.rereadWanted) {
            this.rereadWanted = false;
            await this.reconcile();
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
     * Only orders on contracts with no position are swept, and never one this app placed to
     * get IN: a resting entry has no position by definition, and cancelling it was this
     * function's own bug — it took away orders the person had deliberately left working.
     * {@link working} is what keeps them.
     *
     * An order placed somewhere else — the venue's own platform, while this chart was flat —
     * is still swept, and that is on purpose. Of the two ways to be wrong here, cancelling an
     * entry somebody has to place again is the cheap one; leaving a stop working against
     * nothing opens a position in the opposite direction, and that is what this exists for.
     */
    private async sweepOrphans(positions: readonly GatewayPosition[]): Promise<void> {
        const held = new Set(positions.map((p) => p.contractId));
        const orphans = this.resting.filter((o) => (
            !held.has(o.contractId)
            && !this.working.has(o.id)
            && (o.type === ORDER_TYPE.stop || o.type === ORDER_TYPE.trailingStop || o.type === ORDER_TYPE.limit)
        ));
        if (!orphans.length) return;
        for (const order of orphans) {
            try {
                await window.midori.projectx.cancelOrder(order.id);
                this.notify(`Cancelled a ${order.type === ORDER_TYPE.limit ? 'target' : 'stop'} left over from a closed ${this.ticker} position.`, 'info');
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
        /* Facing the other way from the position — and not something this app put out to get
         * IN. A sell limit above a long is the shape of both a target and a short entry, and
         * reading the second as the first would draw somebody's entry as this position's
         * target and then move it the next time the target was dragged. */
        const guards = this.resting.filter((o) => (
            o.contractId === raw.contractId && o.side === closing && !this.working.has(o.id)
        ));
        const stop = guards.find((o) => o.type === ORDER_TYPE.stop || o.type === ORDER_TYPE.trailingStop) ?? null;
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
            trailing: stop?.type === ORDER_TYPE.trailingStop,
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

    /**
     * Hand the chart's own indicator the state it draws positions and levels from.
     *
     * Serialized, because that is the only shape the input takes — it is read back with
     * `JSON.parse` and anything that is not a string is ignored, silently. This used to send
     * the object itself through a pair of casts, so nothing on a ProjectX chart was ever
     * drawn: no entry line, no stop, no target, and therefore nothing to drag either, since
     * the drag gestures are wired to those lines.
     *
     * The figures are the indicator's own, not this class's: every field it reads is filled
     * in or explicitly null. Two of them cannot be filled in honestly — see below.
     */
    private pushState(): void {
        if (!this.indicator) return;
        const { tickSize, tickValue } = this.dealing;
        const state: ReplayVisualState = {
            positions: this.open.map((p) => {
                /* Ticks moved times the value of a tick times the contracts held — the same
                 * arithmetic {@link recomputeUnrealized} does, asked about a level instead of
                 * about the last price. A plain price difference would be out by the contract
                 * multiplier: four points on one NQ is 80 dollars, not four. */
                const at = (level: number | null): number | null => (
                    level == null ? null : ((level - p.entryPrice) / tickSize) * tickValue * p.size
                );
                return {
                    id: p.id,
                    side: p.size > 0 ? ('buy' as const) : ('sell' as const),
                    entryPrice: p.entryPrice,
                    entryTime: p.openedAt,
                    stopPrice: p.stopLoss,
                    targetPrice: p.takeProfit,
                    size: Math.abs(p.size),
                    openPnl: p.unrealized,
                    stopPnl: at(p.stopLoss),
                    targetPnl: at(p.takeProfit),
                    /* R is the risk a trade OPENED with, and the gateway records none — the
                     * stop on the position now is not necessarily the stop it opened with.
                     * Null rather than a figure derived from the current level, which would
                     * restate what one R was every time the stop moved. The same answer
                     * CapitalController gives, for the same reason. */
                    openR: null,
                    stopR: null,
                    targetR: null,
                };
            }),
            orders: this.workingOrders()
                .map((o) => ({
                    id: o.id,
                    side: o.side === ORDER_SIDE.sell ? ('sell' as const) : ('buy' as const),
                    price: o.type === ORDER_TYPE.stop ? o.stopPrice : o.limitPrice,
                    size: o.size,
                    /* What the line is TITLED on the chart — the kind of order, the way the
                     * Capital.com account labels its own resting orders. The side alone is
                     * what the indicator falls back to, and "buy" on a line already drawn in
                     * the buy colour says nothing the line has not said. */
                    tag: o.type === ORDER_TYPE.stop ? 'stop' : 'limit',
                }))
                .filter((o): o is { id: number; side: 'buy' | 'sell'; price: number; size: number; tag: string } => o.price != null),
            // A resting order here is an ordinary order and `moveOrder` changes it in place.
            ordersMovable: true,
            // The gateway reports what the account HOLDS, not the prints that made it.
            fills: [],
            currency: this.accountCurrency(),
        };
        this.indicator.setInputs({ [STATE_INPUT]: JSON.stringify(state) });
    }
}
