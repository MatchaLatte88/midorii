import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type {
    MidoriBotCapitalOwnership,
    MidoriCapitalConfirmation,
    MidoriCapitalPosition,
    MidoriCapitalWorkingOrder,
} from '../midori';
import { capitalDealingRules, type CapitalDealing } from '../providers/CapitalProvider';
import type { IndicatorHandle } from '../../../src';
import type { ReplayVisualState } from '../replay/replayIndicator';
import { STATE_INPUT } from '../replay/replayIndicator';
import { venueBook, type TradeBook } from '../replay/tradeBook';
import type { ControlledPosition, TradingController } from './TradingController';
import { refusalMessage } from './venueRefusal';

/**
 * Drives ONE Capital.com instrument on a real account.
 *
 * The counterpart of {@link PaperController}, and different from it in the one way that
 * matters: nothing here is computed. A paper account is an engine that decides what a trade
 * did; this is a client of a venue that has already decided, and every figure it reports —
 * what is open, at what price, what the account is worth — is the venue's answer, read back.
 * Where those two disagree the venue is right, always, and the job of this class is to make
 * sure the screen is showing the venue rather than a plausible guess about it.
 *
 * Nothing is drawn before it is true
 * ----------------------------------
 * An order is TWO steps at Capital.com (see app/electron/data/capital.js): the venue takes
 * delivery, and only a second answer says whether anything happened. So a press changes
 * nothing on screen. The instruction goes out, and the position appears when — and only if —
 * the venue confirms it. That is slower than a paper fill and it is the honest ordering: a
 * position drawn on a press is a position the chart would have to take back.
 *
 * Two books, not one
 * ------------------
 * A position is a trade that HAS happened and a resting order is one that has not, and the
 * venue keeps them apart, with their own ids and their own endpoints. So does this: they are
 * read separately, addressed separately, and a number the chart uses for one is never a
 * number it uses for the other.
 */

/** Told about everything that happens out of band — a rejection, a confirmation, a drift. */
export type Notify = (message: string, kind: 'info' | 'error' | 'success') => void;

export interface CapitalControllerOptions {
    /** The instrument this account trades, in Capital.com's own naming. */
    epic: string;
    /** How a late answer reaches the person who caused it. */
    notify: Notify;
    /** Told whenever what is open has changed, so the chart can redraw. */
    onChange?: () => void;
    /** The venue's rules for this instrument, once they are known — see {@link setDealing}. */
    dealing?: CapitalDealing | null;
    /** Whether this is the real-money account, stamped onto every journal entry so a demo
     *  run can never be totalled together with a live one. */
    live?: boolean;
    /** Told about every trade that has ended, for the journal. */
    onTradeClosed?: (trade: LiveTradeRecord) => void;
    /**
     * Proven venue ids for one bot. Omit for the chart, which deliberately shows the whole
     * account. When present, every position and order exposed by this controller is restricted
     * to this ownership set.
     */
    ownership?: MidoriBotCapitalOwnership;
    /** Persist a changed ownership set before the bot can forget what it opened. */
    onOwnershipChange?: (ownership: MidoriBotCapitalOwnership) => void;
}

/** One finished trade, as the journal keeps it. */
export interface LiveTradeRecord {
    /** The venue's own deal id — the natural key, and what stops one closure being
     *  recorded twice when two reconciles overlap. */
    id: string;
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
    fees: number;
    /**
     * Whether the exit figures are the venue's own or this app's best guess.
     *
     * Exact when Midorii closed the position itself — the confirmation carries the fill.
     * Estimated when the venue closed it (a stop or a target fired between two reads), where
     * the last known price and unrealized figure are the closest honest answer available
     * until the transaction history catches up.
     */
    estimated: boolean;
    live: boolean;
    exitTag: string | null;
    /**
     * What `netPnl` and `fees` are denominated in.
     *
     * A CFD account holds one currency and its instruments quote in others, so a result is
     * only a number until something says which money it is. Taken from the venue's own answer
     * — the position's currency while the trade is a reconstruction, the cash ledger's once it
     * is settled — and never converted here: this app has no exchange rate and inventing one
     * would put a plausible wrong total in the record.
     */
    currency: string | null;
}

/** How often to ask the venue what is actually open. */
const RECONCILE_MS = 3_000;

/**
 * A venue position, plus the local number the chart knows it by.
 *
 * The chart addresses a position with a number (its price lines are built from one); the
 * venue addresses it with a `dealId` string. The mapping is kept rather than derived so a
 * position keeps the SAME number across every reconcile — a line that changed identity under
 * a drag would re-protect the wrong trade.
 */
interface LivePosition extends ControlledPosition {
    dealId: string;
    stopLoss: number | null;
    takeProfit: number | null;
    /** What closing it would trade at right now — the ask on a short, the bid on a long.
     *  The side matters: it is the price `upl` is measured against. */
    exitPrice: number;
    /** The venue's own unrealized figure. Never computed here. */
    upl: number;
    /** When the venue opened it, for the marker the chart draws at the entry. */
    openedAt: number;
    /** What the venue books this position's result in. */
    currency: string | null;
}

/** A resting order, plus the number the chart draws it under. */
export interface RestingOrder {
    id: number;
    dealId: string;
    side: 'buy' | 'sell';
    /** Where it waits. */
    price: number;
    size: number;
    /** `limit` or `stop`, in the app's own vocabulary. */
    kind: 'limit' | 'stop';
}

export class CapitalController implements TradingController {
    private readonly epic: string;
    private readonly notify: Notify;
    /** Told whenever what is open has changed. Settable after construction, for a readout
     *  that can only be built once the chart it sits on exists. */
    onChange: (() => void) | null;
    private readonly isLive: boolean;
    private readonly ownership: {
        initialized: boolean;
        positions: Set<string>;
        orders: Set<string>;
        uncertain: boolean;
    } | null;
    /** Ownership ids that a successful venue read has confirmed at least once. A newly
     * accepted create is deliberately absent until it appears in the venue book: the first
     * read often trails the dealing confirmation and must not erase it. */
    private readonly seenOwnedPositions: Set<string>;
    private readonly seenOwnedOrders: Set<string>;
    private readonly onOwnershipChange: ((ownership: MidoriBotCapitalOwnership) => void) | null;
    /** Told about every trade that has ended. Settable after construction, for a journal
     *  that is only opened once the screen showing it exists. */
    onTradeClosed: ((trade: LiveTradeRecord) => void) | null;
    /** Fills reported for closures this app asked for, waiting for the reconcile that
     *  notices the position is gone. Keyed by deal id. */
    private readonly ownExits = new Map<string, { price: number; at: number }>();
    private dealing: CapitalDealing | null;

    private live: LivePosition[] = [];
    /** `dealId` → what one point is worth on it, in account money. See {@link pointValue}. */
    private pointValues = new Map<string, number>();
    private resting: RestingOrder[] = [];
    private balance = 0;
    private availableMargin = 0;
    private lastBid = 0;
    private lastAsk = 0;
    /** What the venue last said about whether this instrument can be traded at all. */
    private marketStatus: string | null = null;
    /** The money the ACCOUNT is held in — which a result booked in another currency has to
     *  be read against. Null before the first successful read. */
    private accountCcy: string | null = null;
    /** When the last reconcile SUCCEEDED, and whether the one after it failed. */
    private lastReadAt = 0;
    private stale = false;
    /** `dealId` → the number the chart knows it by, kept for the life of the position. */
    private readonly ids = new Map<string, number>();
    /** The same, for resting orders — a separate space, because the venue's two books have
     *  separate ids and the chart must never address one with the other's number. */
    private readonly orderIds = new Map<string, number>();
    private nextId = 1;
    private indicator: IndicatorHandle | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** One reconcile at a time — a slow answer must not overlap the next request. */
    private reconciling = false;
    /** Venue instructions still waiting for a confirmation and their following account
     *  read. A bot shutdown waits for these so an accepted deal id can be persisted. */
    private readonly pendingActions = new Set<Promise<void>>();

    constructor(opts: CapitalControllerOptions) {
        this.epic = opts.epic.toUpperCase();
        this.notify = opts.notify;
        this.onChange = opts.onChange ?? null;
        this.dealing = opts.dealing ?? null;
        this.isLive = opts.live === true;
        this.onTradeClosed = opts.onTradeClosed ?? null;
        this.ownership = opts.ownership ? {
            initialized: opts.ownership.initialized,
            positions: new Set(opts.ownership.positionDealIds),
            orders: new Set(opts.ownership.workingOrderDealIds),
            uncertain: opts.ownership.uncertain,
        } : null;
        /* Persisted ids were confirmed in an earlier sitting. They can be retired on the
         * first successful read that no longer contains them. */
        this.seenOwnedPositions = new Set(opts.ownership?.positionDealIds ?? []);
        this.seenOwnedOrders = new Set(opts.ownership?.workingOrderDealIds ?? []);
        this.onOwnershipChange = opts.onOwnershipChange ?? null;
    }

    /** The venue's rules for this instrument — sizes it will accept, and how far a stop may
     *  sit. Arrives asynchronously with the symbol's metadata, so it is set rather than given. */
    setDealing(dealing: CapitalDealing | null): void {
        this.dealing = dealing;
    }

    // ── TradingController ────────────────────────────────────────────────

    /**
     * The price a plan is measured against — the mid, where both sides are known.
     *
     * Neither side of the book is the right answer to "what is this worth": a buy pays the
     * ask and a sell receives the bid, and the chart's candles are drawn from the bid alone.
     * Sizing every trade off the bid made a buy's reference wrong by the whole spread and a
     * sell's right, which is the worst of the three available kinds of wrong — it is silent,
     * and it is one-sided. The mid is wrong by half a spread in both directions instead, and
     * the card beside the chart says what that half is worth.
     *
     * The venue still fills at its own price; nothing here is a promise about that.
     */
    price(): number {
        if (this.lastBid > 0 && this.lastAsk > 0) return (this.lastBid + this.lastAsk) / 2;
        return this.lastBid || this.lastAsk;
    }

    /** The two sides, for whoever needs the one that applies to their direction. */
    quote(): { bid: number; ask: number } | null {
        return this.lastBid > 0 && this.lastAsk > 0 ? { bid: this.lastBid, ask: this.lastAsk } : null;
    }

    /** Whether the venue would accept an order right now, as of the last read. */
    tradeable(): boolean {
        return this.marketStatus == null || this.marketStatus === 'TRADEABLE';
    }

    /** The venue's own word for what the market is doing, or null before the first read. */
    status(): string | null {
        return this.marketStatus;
    }

    /** The currency the account itself is denominated in. */
    accountCurrency(): string | null {
        return this.accountCcy;
    }

    /**
     * Whether what is on screen is known to be current.
     *
     * A failed read leaves the last figures in place — a dropped connection is not a closed
     * position — but leaving them there UNMARKED is the lie the quote card already refuses to
     * tell. So the state is reported, and whoever is drawing says so.
     */
    isStale(): boolean {
        return this.stale;
    }

    /** When the account was last read successfully. 0 before the first time. */
    readAt(): number {
        return this.lastReadAt;
    }

    /**
     * What the account is worth, as the venue states it: settled cash plus the open profit it
     * computes itself. Not a sum over positions — the venue charges financing and currency
     * conversion this app does not model, and its number is the one the money is in.
     */
    equity(): number {
        return this.balance;
    }

    /** What the venue says is open on this instrument. */
    positions(): readonly ControlledPosition[] {
        return this.live;
    }

    /** How much is left to open something new with, after margin. */
    available(): number {
        return this.availableMargin;
    }

    /**
     * What share of a position's notional the venue holds against it, as a fraction.
     *
     * Capital.com states it as a percentage (`3.33` with `marginFactorUnit: 'PERCENTAGE'`),
     * and the unit is honoured rather than assumed: reading 3.33 as a fraction would size
     * every trade at a three-hundredth of what it should be. Undefined until the instrument's
     * rules have landed, or where the venue does not margin this instrument at all — and
     * undefined has to mean unknown, never "no margin required".
     */
    marginFactor(): number | undefined {
        const factor = this.dealing?.marginFactor;
        if (factor == null || !(factor > 0)) return undefined;
        const unit = this.dealing?.marginFactorUnit?.toUpperCase();
        if (unit === 'PERCENTAGE') return factor / 100;
        // An unrecognised unit is not something to guess the scale of.
        return undefined;
    }

    /**
     * Mark the account at the last traded price — the chart's own candle close, which on a
     * CFD feed is the BID. Used only until a two-sided quote arrives.
     */
    mark(price: number): void {
        if (price > 0 && this.lastBid === 0) this.lastBid = price;
    }

    /** Mark the account at both sides, from the venue's quote stream. */
    markQuote(bid: number, ask: number): void {
        if (bid > 0) this.lastBid = bid;
        if (ask > 0) this.lastAsk = ask;
    }

    order(spec: OrderSpec): void {
        if (this.ownership?.uncertain) {
            throw new Error(
                'This bot has an order whose outcome could not be identified. Check the venue account '
                + 'and restart the bot only after the market has no ambiguous exposure.',
            );
        }
        if (this.ownership && (this.lastReadAt === 0 || this.stale)) {
            throw new Error(
                'The Capital.com account state is not current. The bot will not open another '
                + 'trade until positions, orders, and available funds can be read safely.',
            );
        }
        this.requireOpenMarket();
        const size = this.venueSize(spec.size);
        if (spec.type === 'limit' || spec.type === 'stop') {
            this.rest(spec, size);
            return;
        }
        const payload = {
            epic: this.epic,
            direction: spec.side === 'buy' ? ('BUY' as const) : ('SELL' as const),
            size,
            /* Protection rides along on the way IN. Attaching it afterwards would leave the
             * position unprotected for as long as the second request takes — on a live
             * account, in a market that is moving. */
            ...(spec.bracket?.stopLoss != null ? { stopLevel: spec.bracket.stopLoss } : {}),
            ...(spec.bracket?.takeProfit != null ? { profitLevel: spec.bracket.takeProfit } : {}),
        };
        const what = `${spec.side === 'buy' ? 'Buying' : 'Selling'} ${size}`;
        /* Persist uncertainty BEFORE the asynchronous request leaves this call. If the app
         * closes before Capital.com answers, the next start must inspect the venue instead
         * of trusting an empty ownership set and orphaning a position that may have opened. */
        this.markOwnershipUncertain();
        this.submit(
            () => window.midori.capital.openPosition(payload),
            what,
            (confirmation) => this.resolveCreatedDeal(confirmation, 'position'),
            () => this.markOwnershipUncertain(),
        );
    }

    /**
     * Put an order on the book at a level, to fill later or not at all.
     *
     * Which of LIMIT and STOP the venue is told is the app's own `type`, unchanged: a buy
     * below the market is a limit and a buy above it is a stop, and the ticket has already
     * refused a level dropped on the wrong side (see `ticketRefusal`). Re-deciding it here
     * from the last price would disagree with that check the moment the market moved between
     * the two.
     */
    private rest(spec: OrderSpec, size: number): void {
        const level = spec.type === 'limit' ? spec.limitPrice : spec.stopPrice;
        if (level == null || !(level > 0)) throw new Error('A resting order needs a price to wait at.');
        const payload = {
            epic: this.epic,
            direction: spec.side === 'buy' ? ('BUY' as const) : ('SELL' as const),
            size,
            type: spec.type === 'limit' ? ('LIMIT' as const) : ('STOP' as const),
            level,
            ...(spec.bracket?.stopLoss != null ? { stopLevel: spec.bracket.stopLoss } : {}),
            ...(spec.bracket?.takeProfit != null ? { profitLevel: spec.bracket.takeProfit } : {}),
        };
        const what = `Resting a ${spec.side} ${spec.type} for ${size} at ${level}`;
        this.markOwnershipUncertain();
        this.submit(
            () => window.midori.capital.createOrder(payload),
            what,
            (confirmation) => this.resolveCreatedDeal(confirmation, 'order'),
            () => this.markOwnershipUncertain(),
        );
    }

    /** Take a resting order off the book. */
    cancelOrder(orderId: number): void {
        const order = this.resting.find((o) => o.id === orderId);
        if (!order) throw new Error('That order is no longer on the book.');
        this.submit(
            () => window.midori.capital.cancelOrder(order.dealId),
            'Cancelling the order',
            (confirmation) => {
                if (confirmation.accepted) this.forgetWorkingOrder(order.dealId);
            },
        );
    }

    /** Take every resting order off the book. Open positions are untouched. */
    cancelAll(): void {
        for (const order of this.resting) {
            this.submit(
                () => window.midori.capital.cancelOrder(order.dealId),
                'Cancelling the order',
                (confirmation) => {
                    if (confirmation.accepted) this.forgetWorkingOrder(order.dealId);
                },
            );
        }
    }

    /** What is waiting on the book right now. */
    orders(): readonly RestingOrder[] {
        return this.resting;
    }

    /**
     * What is open and what is waiting, as the dock reads it — for a list, never for a
     * decision.
     *
     * The same rows a paper account paints, built from the venue's answer instead of an
     * engine's. The open figure is the venue's own `upl` rather than one computed from the
     * last price: it is the number the money is in, financing and conversion included.
     */
    book(): TradeBook {
        return venueBook(this.live, this.resting, (p) => p.upl);
    }

    /**
     * Refuse before sending, where the venue would refuse on arrival.
     *
     * Forex is shut all weekend, and an instrument can go close-only at any time. The venue
     * says no either way; asking here turns a round trip and a code into an answer given at
     * the moment of the press, in words about the market rather than about the request.
     */
    private requireOpenMarket(): void {
        if (this.tradeable()) return;
        throw new Error(
            this.marketStatus === 'CLOSED'
                ? 'The market is closed — nothing can be sent until it opens.'
                : `The venue has this market on ${this.marketStatus}, which does not accept new orders.`,
        );
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        const position = this.find(positionId);
        if (!position) throw new Error('That position is no longer open.');
        /* BOTH sides go on every amend, and this is the correction of an assumption that
         * cost a stop: `PUT /positions` REPLACES the protection set rather than patching it,
         * so a body naming only the target is a body that silently takes the stop off. The
         * untouched side is re-sent exactly as it stands and only an explicit null removes
         * anything — re-stating a level the venue already holds is the cheap risk here, and
         * losing a stop because nobody mentioned it is the expensive one. */
        const stopLevel = 'stopLoss' in levels ? levels.stopLoss ?? null : position.stopLoss;
        const profitLevel = 'takeProfit' in levels ? levels.takeProfit ?? null : position.takeProfit;
        this.submit(
            () => window.midori.capital.amendPosition({ dealId: position.dealId, stopLevel, profitLevel }),
            'Moving the level',
        );
    }

    closeOne(positionId: number): void {
        const position = this.find(positionId);
        if (!position) throw new Error('That position is no longer open.');
        const dealId = position.dealId;
        this.submit(
            () => window.midori.capital.closePosition(dealId),
            'Closing the position',
            /* The fill the venue reports back, kept for the journal: this is the one exit
             * price that is a fact rather than an estimate, and it exists only here. */
            (confirmation) => {
                if (confirmation.accepted && confirmation.level != null) {
                    this.ownExits.set(dealId, { price: confirmation.level, at: Date.now() });
                }
                if (confirmation.accepted) this.forgetPosition(dealId);
            },
        );
    }

    /** Ask the venue what is true and redraw from the answer. */
    refreshVisuals(): void {
        this.pushState();
        void this.reconcile();
    }

    /** Hand over the native indicator that draws this account's positions. */
    attachIndicator(handle: IndicatorHandle): void {
        this.indicator = handle;
        this.pushState();
    }

    /**
     * What the chart draws, built from the venue's own answer.
     *
     * Not {@link visualState}, which reads an engine: there is no engine here. The shape is
     * the same so the same indicator draws both, but two of its figures cannot be filled in
     * and are left null rather than invented — R needs the risk a trade OPENED with, and a
     * venue does not record one. Executions are likewise absent: the venue reports positions,
     * not the prints that made them.
     */
    private pushState(): void {
        if (!this.indicator) return;
        const state: ReplayVisualState = {
            positions: this.live.map((p) => {
                /* Points alone are not money: a point of US500 is a dollar and a point of a
                 * EUR account is not, and one unit of an instrument is not always one point of
                 * it. Both corrections live in the one factor below, so a level says what it is
                 * worth in the money the account is actually kept in. */
                const perPoint = this.pointValue(p);
                const at = (level: number | null): number | null => (
                    level == null || perPoint == null ? null : (level - p.entryPrice) * p.size * perPoint
                );
                return {
                    id: p.id,
                    side: p.size > 0 ? ('buy' as const) : ('sell' as const),
                    entryPrice: p.entryPrice,
                    entryTime: p.openedAt,
                    stopPrice: p.stopLoss,
                    targetPrice: p.takeProfit,
                    size: Math.abs(p.size),
                    // The venue's own unrealized figure, not one computed from the last price.
                    openPnl: p.upl,
                    stopPnl: at(p.stopLoss),
                    targetPnl: at(p.takeProfit),
                    openR: null,
                    stopR: null,
                    targetR: null,
                };
            }),
            orders: this.resting.map((o) => ({ id: o.id, side: o.side, price: o.price, tag: o.kind })),
            fills: [],
            currency: this.accountCcy,
        };
        this.indicator.setInputs({ [STATE_INPUT]: JSON.stringify(state) });
    }

    // ── the venue ────────────────────────────────────────────────────────

    /** Begin following the account. Safe to call again. Resolves whether the initial account
     *  read succeeded, so an unattended caller can refuse to arm on unknown state. */
    start(): Promise<boolean> {
        if (this.timer) return Promise.resolve(this.lastReadAt > 0 && !this.stale);
        this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
        return this.reconcile();
    }

    /** Stop following it. The account itself is untouched — this is a screen going away. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Read back what the venue holds, and redraw from it.
     *
     * Everything is taken from the answer, including positions this app never opened — the
     * same account can be traded from a phone, and a position the chart does not draw is one
     * a person cannot see they are carrying.
     */
    private async reconcile(): Promise<boolean> {
        if (this.reconciling) return this.lastReadAt > 0 && !this.stale;
        this.reconciling = true;
        try {
            const [account, positions, working, market] = await Promise.all([
                window.midori.capital.account(),
                window.midori.capital.positions(),
                window.midori.capital.workingOrders(),
                /* Read every time rather than cached with the instrument's other metadata:
                 * this is the one field there that CHANGES — forex shuts on Friday evening —
                 * and a cached "TRADEABLE" is exactly the answer that would be wrong. */
                window.midori.capital.marketInfo(this.epic).catch(() => null),
            ]);
            if (account) {
                this.balance = account.balance.balance + account.balance.profitLoss;
                this.availableMargin = account.balance.available;
                this.accountCcy = account.currency ?? null;
            }
            const marketPositions = positions.filter((p) => p.market.epic === this.epic);
            let ownershipChanged = false;
            if (this.ownership) {
                /* A filled working order becomes a position under a new deal id. The position
                 * keeps the order id it came from, which is the only documented, durable link
                 * between the two books. */
                for (const row of marketPositions) {
                    const source = row.position.workingOrderId;
                    if (!source || !this.ownership.orders.has(source)) continue;
                    if (!this.ownership.positions.has(row.position.dealId)) {
                        this.ownership.positions.add(row.position.dealId);
                        ownershipChanged = true;
                    }
                    this.seenOwnedPositions.add(row.position.dealId);
                    this.seenOwnedOrders.delete(source);
                    if (this.ownership.orders.delete(source)) ownershipChanged = true;
                }
            }

            const before = this.live;
            this.live = marketPositions
                .filter((p) => !this.ownership || this.ownership.positions.has(p.position.dealId))
                .map((p) => this.toLive(p));
            const open = new Set(this.live.map((p) => p.dealId));
            for (const dealId of open) this.seenOwnedPositions.add(dealId);
            /* Anything that was open a moment ago and is not now has ENDED — by a stop, a
             * target, or this app's own close button. Recorded here rather than where the
             * close was requested, because most closures are not requested by anyone here:
             * a stop firing overnight is the commonest trade there is, and it would be
             * missing from a journal that only wrote down what it had asked for. */
            for (const gone of before) {
                if (open.has(gone.dealId)) continue;
                this.record(gone);
                if (this.ownership?.positions.delete(gone.dealId)) ownershipChanged = true;
                this.seenOwnedPositions.delete(gone.dealId);
            }
            // Numbers for positions that are gone are dropped, so a long session does not
            // accumulate them — and a dealId never comes back once the venue has closed it.
            for (const dealId of this.ids.keys()) if (!open.has(dealId)) this.ids.delete(dealId);
            if (this.ownership) {
                for (const dealId of [...this.ownership.positions]) {
                    if (this.seenOwnedPositions.has(dealId) && !open.has(dealId)) {
                        this.ownership.positions.delete(dealId);
                        this.seenOwnedPositions.delete(dealId);
                        ownershipChanged = true;
                    }
                }
            }

            const marketOrders = working.filter((o) => o.workingOrderData.epic === this.epic);
            this.resting = marketOrders
                .filter((o) => !this.ownership || this.ownership.orders.has(o.workingOrderData.dealId))
                .map((o) => this.toResting(o));
            const waiting = new Set(this.resting.map((o) => o.dealId));
            for (const dealId of waiting) this.seenOwnedOrders.add(dealId);
            for (const dealId of this.orderIds.keys()) if (!waiting.has(dealId)) this.orderIds.delete(dealId);
            if (this.ownership) {
                for (const dealId of [...this.ownership.orders]) {
                    if (this.seenOwnedOrders.has(dealId) && !waiting.has(dealId)) {
                        this.ownership.orders.delete(dealId);
                        this.seenOwnedOrders.delete(dealId);
                        ownershipChanged = true;
                    }
                }
            }
            if (ownershipChanged) this.publishOwnership();

            if (market?.snapshot) {
                this.marketStatus = market.snapshot.marketStatus;
                // The venue's own two sides, which the candle feed does not carry.
                this.markQuote(market.snapshot.bid, market.snapshot.offer);
            }
            if (market) this.dealing = capitalDealingRules(market);
            this.lastReadAt = Date.now();
            this.stale = false;
            this.pushState();
            this.onChange?.();
            return true;
        } catch (err: unknown) {
            /* A failed reconcile leaves the LAST known state on screen rather than emptying
             * the chart: a dropped connection is not a closed position, and drawing it as one
             * is the more alarming of the two lies. */
            console.warn('[midorii] could not read the Capital.com account', err);
            /* Marked rather than hidden. The figures stay on screen because they are the last
             * true ones, and the card says they are no longer being confirmed — the same
             * bargain the quote card strikes when its stream goes quiet. */
            this.stale = true;
            this.onChange?.();
            return false;
        } finally {
            this.reconciling = false;
        }
    }

    private toLive(row: MidoriCapitalPosition): LivePosition {
        const { dealId, direction, size, level, stopLevel, profitLevel, upl, currency } = row.position;
        // A short is closed by buying, so it is marked at the ask; a long at the bid.
        const exitPrice = direction === 'SELL' ? row.market.offer : row.market.bid;
        let id = this.ids.get(dealId);
        if (id == null) {
            id = this.nextId++;
            this.ids.set(dealId, id);
        }
        return {
            id,
            dealId,
            openedAt: Date.parse(`${row.position.createdDateUTC}Z`) || Date.now(),
            // Signed for the chart, which reads direction off the sign; the venue has no
            // negative sizes and says BUY or SELL instead.
            size: direction === 'SELL' ? -size : size,
            entryPrice: level,
            exitPrice,
            stopLoss: stopLevel,
            takeProfit: profitLevel,
            upl: upl ?? 0,
            currency: currency ?? null,
        };
    }

    /**
     * Write one ended position into the journal.
     *
     * Exact where this app closed it — the confirmation carried the fill price, and the
     * result follows from it arithmetically. Estimated otherwise, from the last price seen
     * and the last unrealized figure the venue gave: those are the closest honest answer
     * available between reads, and they are MARKED as estimates rather than presented as the
     * venue's own. A journal that quietly guesses is one nobody can audit later.
     */
    private record(gone: LivePosition): void {
        if (!this.onTradeClosed) return;
        const own = this.ownExits.get(gone.dealId);
        this.ownExits.delete(gone.dealId);

        const exitPrice = own?.price ?? this.price();
        const size = Math.abs(gone.size);
        const netPnl = own
            // Direction-aware: a short makes money as the price falls.
            ? (exitPrice - gone.entryPrice) * gone.size
            : gone.upl;

        this.onTradeClosed({
            id: gone.dealId,
            symbol: this.epic,
            side: gone.size > 0 ? 'long' : 'short',
            size,
            entryPrice: gone.entryPrice,
            exitPrice,
            openedAt: gone.openedAt,
            closedAt: own?.at ?? Date.now(),
            netPnl,
            /* Not known from anything the venue reports here. Zero is wrong for a CFD, which
             * is why it is stated as unknown-and-not-charged rather than dressed up: the
             * transaction history is where the real cost of a trade lives. */
            fees: 0,
            estimated: !own,
            live: this.isLive,
            exitTag: own ? 'manual' : null,
            currency: gone.currency,
        });
    }

    private toResting(row: MidoriCapitalWorkingOrder): RestingOrder {
        const { dealId, direction, orderSize, orderLevel, orderType } = row.workingOrderData;
        let id = this.orderIds.get(dealId);
        if (id == null) {
            id = this.nextId++;
            this.orderIds.set(dealId, id);
        }
        return {
            id,
            dealId,
            side: direction === 'SELL' ? 'sell' : 'buy',
            price: orderLevel,
            size: orderSize,
            kind: orderType === 'STOP' ? 'stop' : 'limit',
        };
    }

    private find(positionId?: number | null): LivePosition | null {
        if (positionId == null) return this.live[0] ?? null;
        return this.live.find((p) => p.id === positionId) ?? null;
    }

    /**
     * Send one instruction and put the venue's verdict in front of the person, whichever way
     * it went.
     *
     * This is the whole reason a live account needs a `notify` at all: the answer arrives
     * after the call that caused it has returned, so a refusal has nowhere else to go. It is
     * named after the action so a rejection landing seconds later is still attached to the
     * press that caused it.
     */
    private async send(
        run: () => Promise<MidoriCapitalConfirmation>,
        what: string,
        observe?: (confirmation: MidoriCapitalConfirmation) => void,
        onUnknownOutcome?: () => void,
    ): Promise<void> {
        try {
            const confirmation = await run();
            observe?.(confirmation);
            if (!confirmation.accepted) {
                this.notify(refusalMessage(confirmation.reason, what), 'error');
            } else if (confirmation.level != null) {
                this.notify(`${what} — filled at ${confirmation.level}`, 'success');
            } else {
                this.notify(`${what} — done`, 'success');
            }
        } catch (err: unknown) {
            onUnknownOutcome?.();
            // A request that never got a verdict, which is NOT a refusal: something may well
            // be open. The message from below says so, and it is the one to show.
            this.notify(err instanceof Error ? err.message : String(err), 'error');
        }
        // Either way, the venue is the truth — go and read it rather than assuming.
        await this.reconcile();
    }

    /** Track one venue instruction so a bot can wait for all delivered work before its
     *  runtime state is considered safely stored. */
    private submit(
        run: () => Promise<MidoriCapitalConfirmation>,
        what: string,
        observe?: (confirmation: MidoriCapitalConfirmation) => void,
        onUnknownOutcome?: () => void,
    ): void {
        const action = this.send(run, what, observe, onUnknownOutcome);
        this.pendingActions.add(action);
        void action.then(
            () => this.pendingActions.delete(action),
            () => this.pendingActions.delete(action),
        );
    }

    /** Wait until every instruction already sent has received its verdict and the venue
     *  account has been read back. No new instruction is created here. */
    async settle(): Promise<void> {
        while (this.pendingActions.size > 0) {
            await Promise.all([...this.pendingActions]);
        }
    }

    /** Resolve the uncertainty recorded before a create left for the venue. */
    private resolveCreatedDeal(
        confirmation: MidoriCapitalConfirmation,
        kind: 'position' | 'order',
    ): void {
        if (!this.ownership) return;
        if (!confirmation.accepted) {
            if (this.ownership.uncertain) {
                this.ownership.uncertain = false;
                this.publishOwnership();
            }
            return;
        }
        if (!confirmation.dealId) {
            this.markOwnershipUncertain();
            throw new Error(
                `Capital.com accepted the ${kind} but returned no deal id. `
                + 'The bot is blocked from new entries until the account can be checked safely.',
            );
        }
        const target = kind === 'position' ? this.ownership.positions : this.ownership.orders;
        const changed = !target.has(confirmation.dealId) || this.ownership.uncertain;
        target.add(confirmation.dealId);
        this.ownership.uncertain = false;
        if (changed) this.publishOwnership();
    }

    private markOwnershipUncertain(): void {
        if (!this.ownership || this.ownership.uncertain) return;
        this.ownership.uncertain = true;
        this.publishOwnership();
    }

    /**
     * What one point of movement is worth on this position, in the ACCOUNT's money.
     *
     * Read off the venue's own arithmetic rather than computed. `upl` is what Capital.com
     * says the position is worth right now, in account currency; `(exit − entry) × size` is
     * how far it has travelled, in points. Their ratio is everything that sits between the
     * two — the contract size, and the rate between the instrument’s currency and the
     * account's — and neither has to be known here, fetched, or kept up to date. That is the
     * whole reason for doing it this way: this app has no FX feed and should not grow one to
     * put a number on a label.
     *
     * Only taken when the position has actually moved: near breakeven the division says
     * nothing. Kept once taken, because it does not change while a position is open — the
     * size is fixed and so is the contract. Null until then, and a level with no figure
     * beside it is the honest thing to draw; a figure from a division by nearly nothing is
     * not.
     *
     * One caveat, stated rather than buried: `upl` carries whatever financing the venue has
     * already charged, so a position held over several nights implies a slightly stale rate.
     * It is right to the cent on the day a trade is taken.
     */
    private pointValue(p: LivePosition): number | null {
        const drift = p.exitPrice - p.entryPrice;
        if (p.exitPrice > 0 && p.upl !== 0 && Math.abs(drift) > p.entryPrice * 1e-5) {
            this.pointValues.set(p.dealId, p.upl / (drift * p.size));
        }
        return this.pointValues.get(p.dealId) ?? null;
    }

    private forgetPosition(dealId: string): void {
        this.pointValues.delete(dealId);
        this.seenOwnedPositions.delete(dealId);
        if (this.ownership?.positions.delete(dealId)) this.publishOwnership();
    }

    private forgetWorkingOrder(dealId: string): void {
        this.seenOwnedOrders.delete(dealId);
        if (this.ownership?.orders.delete(dealId)) this.publishOwnership();
    }

    private publishOwnership(): void {
        if (!this.ownership || !this.onOwnershipChange) return;
        this.onOwnershipChange({
            initialized: this.ownership.initialized,
            positionDealIds: [...this.ownership.positions],
            workingOrderDealIds: [...this.ownership.orders],
            uncertain: this.ownership.uncertain,
        });
    }

    /**
     * A size the venue will accept: on its own increment grid, and not below its minimum.
     *
     * The ticket sizes a trade from risk and hands over whatever number that produces. A CFD
     * venue refuses anything off its grid, so rounding here is what turns a risk calculation
     * into a sendable order — and a size that rounds to below the minimum is refused with the
     * reason, rather than being quietly raised to a trade bigger than the one that was sized.
     */
    private venueSize(size: number): number {
        const step = this.dealing?.sizeIncrement;
        const min = this.dealing?.minSize;
        let out = size;
        if (step != null && step > 0) {
            // Eight decimals clears the dust a divide-and-multiply leaves behind.
            out = Number((Math.round(size / step) * step).toFixed(8));
        }
        if (min != null && out < min) {
            throw new Error(
                `${out} is below the smallest deal this instrument accepts (${min}). `
                + 'Raise the risk per trade, or move the stop closer, until the size reaches it.',
            );
        }
        if (!(out > 0)) throw new Error('That sizes to nothing.');
        const max = this.dealing?.maxSize;
        if (max != null && out > max) {
            throw new Error(`${out} is above the largest deal this instrument accepts (${max}).`);
        }
        return out;
    }
}
