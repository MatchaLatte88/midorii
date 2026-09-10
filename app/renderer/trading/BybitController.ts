import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { IndicatorHandle } from '../../../src';
import type { ReplayVisualState } from '../replay/replayIndicator';
import { STATE_INPUT } from '../replay/replayIndicator';
import { venueBook, type TradeBook } from '../replay/tradeBook';
import type {
    MidoriBybitCategory, MidoriBybitExecution, MidoriBybitInstrument, MidoriBybitOrder,
    MidoriBybitPosition, MidoriBybitWallet,
} from '../midori';
import type { ControlledPosition, TradingController } from './TradingController';

/**
 * Drives ONE Bybit market on a real account — a spot pair or a USDT perpetual.
 *
 * One class for both, because the venue is one API and almost everything about trading it is
 * the same call with a different word in it. The two places they genuinely differ are named
 * rather than hidden:
 *
 *   What is open. A perpetual is a POSITION the venue keeps and states the result of; a spot
 *   holding is a BALANCE, and the price it was bought at exists only in this account's own
 *   executions. So one is read and the other is reconstructed — see {@link bybitSpotCost} —
 *   and the reconstruction is honest about its limit: the venue serves a hundred executions,
 *   so a holding built over more trades than that has a cost basis this cannot see all of.
 *
 *   How it is protected. A perpetual's stop and target are attributes OF the position: one
 *   call sets both, nothing has to be cancelled first, and there is no moment in which the
 *   position stands unprotected. Spot has nothing to hang them on, so protection is a resting
 *   sell that must be cancelled and replaced — and that window is real.
 *
 * Like every venue controller here, nothing is computed that the venue already states, and
 * nothing is drawn before the venue has confirmed it. A press sends an instruction; what
 * appears on the chart is whatever comes back on the next read.
 */

export type BybitNotify = (message: string, kind: 'info' | 'error' | 'success') => void;

export interface BybitControllerOptions {
    /** The market as the app writes it — `BTCUSDT` or `BTCUSDT.P`. */
    ticker: string;
    info: MidoriBybitInstrument;
    notify: BybitNotify;
    /** Whether these credentials point at the real-money account. */
    live?: boolean;
    onChange?: () => void;
}

interface BybitPosition extends ControlledPosition {
    stopLoss: number | null;
    takeProfit: number | null;
    openedAt: number;
    /** The venue's own unrealized figure on a perpetual; computed on spot, which has none. */
    unrealized: number;
}

export interface BybitRestingOrder {
    id: number;
    orderId: string;
    side: 'buy' | 'sell';
    size: number;
    price: number;
    kind: 'limit' | 'stop';
    /** Which of spot's three books it lives in, because cancelling needs to say. */
    orderFilter: 'Order' | 'StopOrder' | 'tpslOrder';
}

const RECONCILE_MS = 5_000;

const number = (value: string | number | null | undefined): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * How many decimals a step needs to be written out to.
 *
 * `String(0.00000001)` is `"1e-8"`, not `"0.00000001"`, so counting what follows the dot
 * reports no decimals at all and rounds the size to a whole coin. No Bybit market is that
 * fine today; a market that is would be a wrong order, not a refused one.
 */
export function decimalsOf(step: number): number {
    const text = String(step).toLowerCase();
    if (text.includes('e-')) return Number(text.split('e-')[1]);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

/** Bybit states "no level" as an empty string rather than null. */
const level = (value: string | null | undefined): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Average cost of the base units that remain, from this account's own executions.
 *
 * Spot has no entry price — it has a balance — so the only honest answer is what the account
 * actually paid for the units it still holds, fees included on the way in. Walked oldest
 * first so a sale reduces the cost of what came before it rather than of what came after.
 *
 * Deliberately blind past what the venue serves: Bybit hands back the recent executions, not
 * the whole life of the account, so a holding accumulated over more trades than that reports
 * the cost of the ones it can see. That is a smaller wrong than inventing the rest.
 */
export function bybitSpotCost(
    executions: readonly MidoriBybitExecution[],
    baseAsset: string,
    quoteAsset: string,
): { quantity: number; price: number; openedAt: number } {
    let quantity = 0;
    let cost = 0;
    let openedAt = 0;
    const ordered = [...executions].sort((a, b) => number(a.execTime) - number(b.execTime));
    for (const row of ordered) {
        const qty = number(row.execQty);
        const value = number(row.execValue) || qty * number(row.execPrice);
        const fee = number(row.execFee);
        if (row.side === 'Buy') {
            const received = Math.max(0, qty - (row.feeCurrency === baseAsset ? fee : 0));
            const paid = value + (row.feeCurrency === quoteAsset ? fee : 0);
            if (quantity <= 0) openedAt = number(row.execTime);
            quantity += received;
            cost += paid;
        } else if (quantity > 0) {
            const sold = Math.min(quantity, qty + (row.feeCurrency === baseAsset ? fee : 0));
            const average = cost / quantity;
            quantity -= sold;
            cost = Math.max(0, cost - average * sold);
            if (quantity <= 1e-14) {
                quantity = 0;
                cost = 0;
                openedAt = 0;
            }
        }
    }
    return { quantity, price: quantity > 0 ? cost / quantity : 0, openedAt };
}

/**
 * Whether an order is protection on what is already open, rather than a way into something.
 *
 * Both products draw the line in the same place and reach it differently. A perpetual's own
 * stop and target are position attributes, but the venue also surfaces them as conditional
 * orders; listing those beside the working orders would offer two ways to cancel the same
 * protection, one of which leaves the position looking protected. On spot the protection IS
 * an order, and the same reasoning applies to it.
 */
export function isBybitProtection(order: MidoriBybitOrder, category: MidoriBybitCategory): boolean {
    const stopType = order.stopOrderType ?? '';
    if (category === 'linear') {
        return order.reduceOnly === true
            || stopType.includes('TakeProfit')
            || stopType.includes('StopLoss')
            || stopType === 'TrailingStop';
    }
    return order.side === 'Sell' && (stopType === 'tpslOrder' || stopType.includes('TakeProfit') || stopType.includes('StopLoss'));
}

export class BybitController implements TradingController {
    /** The market as the app writes it — what the chart and the journal call it. */
    readonly ticker: string;
    /** The market as Bybit writes it — what every request carries. */
    readonly symbol: string;
    readonly category: MidoriBybitCategory;
    readonly info: MidoriBybitInstrument;
    readonly isLive: boolean;
    private readonly notify: BybitNotify;
    onChange: (() => void) | null;

    private wallet: MidoriBybitWallet | null = null;
    private live: BybitPosition[] = [];
    private resting: BybitRestingOrder[] = [];
    private protective: MidoriBybitOrder[] = [];
    private lastPrice = 0;
    private lastReadAt = 0;
    private stale = false;
    private indicator: IndicatorHandle | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;
    private readonly ids = new Map<string, number>();
    private nextId = 2;

    constructor(opts: BybitControllerOptions) {
        this.ticker = opts.ticker.toUpperCase();
        this.info = opts.info;
        this.category = opts.info.category;
        this.symbol = opts.info.symbol;
        this.isLive = opts.live === true;
        this.notify = opts.notify;
        this.onChange = opts.onChange ?? null;
    }

    // ── TradingController ────────────────────────────────────────────────

    price(): number { return this.lastPrice; }

    mark(price: number): void {
        if (!(price > 0)) return;
        this.lastPrice = price;
        this.pushState();
        this.onChange?.();
    }

    positions(): readonly BybitPosition[] { return this.live; }
    orders(): readonly BybitRestingOrder[] { return this.resting; }

    book(): TradeBook {
        return venueBook(this.live, this.resting, (p) => p.unrealized);
    }

    /** What a result on this market is denominated in — the settle coin, or the spot quote. */
    accountCurrency(): string { return this.info.settleAsset ?? this.info.quoteAsset; }
    isStale(): boolean { return this.stale; }
    readAt(): number { return this.lastReadAt; }
    tradeable(): boolean { return this.info.status === 'Trading'; }
    /** Whether the account can short this market at all. Spot never can. */
    canShort(): boolean { return this.category === 'linear'; }

    private coin(asset: string): { equity: number; balance: number } {
        const row = this.wallet?.list?.[0]?.coin?.find((candidate) => candidate.coin === asset);
        return { equity: number(row?.equity), balance: number(row?.walletBalance) };
    }

    /**
     * What is behind this market, as the venue states it.
     *
     * A perpetual is margined out of the settle coin, and that coin's equity already carries
     * the open result. A spot pair has no equity of its own — the account holds two balances
     * — so it is what those two are worth together, in the quote asset.
     */
    equity(): number {
        if (this.category === 'linear') return this.coin(this.accountCurrency()).equity;
        const base = this.coin(this.info.baseAsset);
        const quote = this.coin(this.info.quoteAsset);
        return quote.balance + base.balance * this.lastPrice;
    }

    /**
     * What is free to open something new with.
     *
     * Account-level rather than per-coin, because a unified account is cross-margined and
     * Bybit states availability for the whole of it — there is no per-coin free balance to
     * report, and one invented from a wallet balance would be wrong the moment anything else
     * on the account had a position. Bybit denominates it in USD.
     */
    available(): number {
        return number(this.wallet?.list?.[0]?.totalAvailableBalance);
    }

    /**
     * Base units that could be sold right now — the spot half of {@link available}.
     *
     * What is held, less what the resting sells have already reserved. Computed rather than
     * read: a unified account reports no per-coin free balance, and the reservation is
     * exactly the orders this controller has just read.
     */
    availableBase(): number {
        const working = this.resting
            .filter((order) => order.side === 'sell')
            .reduce((sum, order) => sum + order.size, 0);
        const protecting = this.protective
            .filter((order) => order.side === 'Sell')
            .reduce((sum, order) => sum + (number(order.leavesQty) || number(order.qty)), 0);
        return Math.max(0, this.coin(this.info.baseAsset).balance - working - protecting);
    }

    order(spec: OrderSpec): void {
        if (!this.tradeable()) throw new Error(`Bybit has ${this.symbol} on ${this.info.status}.`);
        const size = this.snapSize(spec.size);
        const reference = spec.type === 'limit' ? spec.limitPrice
            : spec.type === 'stop' ? spec.stopPrice
                : this.lastPrice;
        if (!(reference != null && reference > 0)) {
            throw new Error('A current price is required before placing this Bybit order.');
        }
        if (this.info.minNotional > 0 && size * reference < this.info.minNotional) {
            throw new Error(`This Bybit order must be worth at least ${this.info.minNotional} ${this.info.quoteAsset}.`);
        }
        if (this.category === 'spot' && this.wallet) {
            if (spec.side === 'sell' && size > this.availableBase() + this.info.stepSize / 2) {
                throw new Error(`Spot can only sell the ${this.info.baseAsset} you hold; ${this.availableBase()} is free.`);
            }
            if (spec.side === 'buy' && size * reference > this.available() * 1.001) {
                throw new Error('This buy needs more than the account has available.');
            }
        }

        const payload = {
            category: this.category,
            symbol: this.symbol,
            side: spec.side === 'buy' ? ('Buy' as const) : ('Sell' as const),
            type: spec.type === 'limit' ? ('Limit' as const) : ('Market' as const),
            qty: size,
            ...(spec.type === 'limit' && spec.limitPrice != null ? { price: spec.limitPrice } : {}),
            ...(spec.type === 'stop' && spec.stopPrice != null ? { triggerPrice: spec.stopPrice } : {}),
            // Which way a trigger has to be crossed is read against the market, not guessed.
            ...(spec.type === 'stop' && this.lastPrice > 0 ? { reference: this.lastPrice } : {}),
            ...(spec.reduceOnly === true && this.category === 'linear' ? { reduceOnly: true } : {}),
            ...(spec.bracket ? { bracket: spec.bracket } : {}),
        };
        const what = `${spec.side === 'buy' ? 'Buying' : 'Selling'} ${size} ${this.info.baseAsset}`;
        void this.send(() => window.midori.bybit.placeOrder(payload), what);
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        const position = this.find(positionId);
        if (!position) throw new Error('There is nothing open on this Bybit market to protect.');
        const stopLoss = 'stopLoss' in levels ? levels.stopLoss ?? null : position.stopLoss;
        const takeProfit = 'takeProfit' in levels ? levels.takeProfit ?? null : position.takeProfit;
        const short = position.size < 0;
        if (stopLoss != null && this.lastPrice > 0) {
            if (!short && stopLoss >= this.lastPrice) throw new Error('A stop-loss on a long must sit below the market.');
            if (short && stopLoss <= this.lastPrice) throw new Error('A stop-loss on a short must sit above the market.');
        }
        if (takeProfit != null && this.lastPrice > 0) {
            if (!short && takeProfit <= this.lastPrice) throw new Error('A take-profit on a long must sit above the market.');
            if (short && takeProfit >= this.lastPrice) throw new Error('A take-profit on a short must sit below the market.');
        }

        void this.send(
            () => window.midori.bybit.setProtection({
                category: this.category,
                symbol: this.symbol,
                /* The spot half. A perpetual ignores both: its levels belong to the position,
                 * and setting them replaces whatever was there without cancelling anything. */
                ...(this.category === 'spot' ? {
                    quantity: Math.abs(position.size),
                    orders: this.protective.map((order) => order.orderId),
                } : {}),
                ...(stopLoss == null ? {} : { stopLoss }),
                ...(takeProfit == null ? {} : { takeProfit }),
            }),
            'Updating the Bybit protection',
        );
    }

    closeOne(positionId: number): void {
        if (!this.find(positionId)) throw new Error('There is nothing open on this Bybit market to close.');
        void this.send(
            () => window.midori.bybit.close({ category: this.category, symbol: this.symbol }),
            this.category === 'linear' ? 'Closing the position' : `Selling the ${this.info.baseAsset} holding`,
        );
    }

    cancelOrder(orderId: number): void {
        const order = this.resting.find((candidate) => candidate.id === orderId);
        if (!order) throw new Error('That Bybit order is no longer open.');
        void this.send(
            () => window.midori.bybit.cancelOrder({
                category: this.category,
                symbol: this.symbol,
                orderId: order.orderId,
                ...(this.category === 'spot' ? { orderFilter: order.orderFilter } : {}),
            }),
            'Cancelling the order',
        );
    }

    cancelAll(): void {
        if (this.resting.length === 0) return;
        void this.send(
            () => window.midori.bybit.cancelAll({ category: this.category, symbol: this.symbol }),
            'Cancelling the open orders',
        );
    }

    refreshVisuals(): void {
        this.pushState();
        void this.reconcile();
    }

    attachIndicator(handle: IndicatorHandle): void {
        this.indicator = handle;
        this.pushState();
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
        void this.reconcile();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ── internals ────────────────────────────────────────────────────────

    private snapSize(value: number): number {
        const step = this.info.stepSize;
        if (!(value > 0) || !(step > 0)) throw new Error('Order size must be positive.');
        const snapped = Math.floor((value + step * 1e-9) / step) * step;
        const size = Number(snapped.toFixed(Math.min(15, decimalsOf(step))));
        if (!(size >= this.info.minQty)) {
            throw new Error(`The minimum Bybit size is ${this.info.minQty} ${this.info.baseAsset}.`);
        }
        if (size > this.info.maxQty) {
            throw new Error(`The largest Bybit accepts here is ${this.info.maxQty} ${this.info.baseAsset}.`);
        }
        return size;
    }

    private find(positionId?: number | null): BybitPosition | null {
        if (positionId == null) return this.live[0] ?? null;
        return this.live.find((position) => position.id === positionId) ?? null;
    }

    private async send(run: () => Promise<unknown>, what: string): Promise<void> {
        try {
            await run();
            this.notify(`${what} — accepted by Bybit${this.isLive ? '' : ' demo'}`, 'success');
        } catch (err: unknown) {
            this.notify(err instanceof Error ? err.message : String(err), 'error');
        }
        await this.reconcile();
    }

    private async reconcile(): Promise<void> {
        if (this.reconciling) return;
        this.reconciling = true;
        try {
            const [wallet, openOrders] = await Promise.all([
                window.midori.bybit.wallet(),
                window.midori.bybit.openOrders({ category: this.category, symbol: this.symbol }),
            ]);
            this.wallet = wallet;
            this.protective = openOrders.filter((order) => isBybitProtection(order, this.category));
            this.resting = openOrders
                .filter((order) => !isBybitProtection(order, this.category))
                .map((order) => this.toResting(order));
            this.live = this.category === 'linear' ? await this.readPosition() : await this.readHolding();
            this.lastReadAt = Date.now();
            this.stale = false;
            this.pushState();
            this.onChange?.();
        } catch (err: unknown) {
            console.warn('[midorii] could not read the Bybit account', err);
            this.stale = true;
            this.onChange?.();
        } finally {
            this.reconciling = false;
        }
    }

    /** The perpetual, as the venue states it — nothing here is computed. */
    private async readPosition(): Promise<BybitPosition[]> {
        const answer = await window.midori.bybit.positions(this.symbol);
        const rows = (answer?.list ?? []).filter((row: MidoriBybitPosition) => number(row.size) > 0);
        return rows.map((row: MidoriBybitPosition) => ({
            id: 1,
            // Signed, which is what every reader of a position here means by direction.
            size: row.side === 'Sell' ? -number(row.size) : number(row.size),
            entryPrice: number(row.avgPrice),
            openedAt: number(row.createdTime) || Date.now(),
            stopLoss: level(row.stopLoss),
            takeProfit: level(row.takeProfit),
            unrealized: number(row.unrealisedPnl),
        }));
    }

    /** The spot holding, reconstructed — a balance plus what this account paid for it. */
    private async readHolding(): Promise<BybitPosition[]> {
        const held = this.coin(this.info.baseAsset).balance;
        if (!(held >= this.info.minQty) || held * this.lastPrice < this.info.minNotional) return [];
        const executions = await window.midori.bybit.executions({ category: 'spot', symbol: this.symbol });
        const cost = bybitSpotCost(executions, this.info.baseAsset, this.info.quoteAsset);
        const entryPrice = cost.price > 0 ? cost.price : this.lastPrice;
        const stop = this.protective.find((order) => level(order.stopLoss) != null);
        const target = this.protective.find((order) => level(order.takeProfit) != null);
        return [{
            id: 1,
            size: held,
            entryPrice,
            openedAt: cost.openedAt || Date.now(),
            stopLoss: stop ? level(stop.stopLoss) : null,
            takeProfit: target ? level(target.takeProfit) : null,
            /* Spot states no unrealized figure of its own, so it is the only number this
             * controller computes: what the units are worth now against what they cost. The
             * fee on the way in is already inside that cost; the sale's own fee is not, and
             * cannot be until there is a sale. */
            unrealized: (this.lastPrice - entryPrice) * held,
        }];
    }

    private toResting(order: MidoriBybitOrder): BybitRestingOrder {
        let id = this.ids.get(order.orderId);
        if (id == null) {
            id = this.nextId++;
            this.ids.set(order.orderId, id);
        }
        const trigger = number(order.triggerPrice);
        const stopType = order.stopOrderType ?? '';
        const remaining = number(order.leavesQty) || number(order.qty);
        return {
            id,
            orderId: order.orderId,
            side: order.side === 'Buy' ? 'buy' : 'sell',
            size: remaining,
            price: trigger > 0 ? trigger : number(order.price),
            kind: trigger > 0 ? 'stop' : 'limit',
            orderFilter: stopType === 'tpslOrder' ? 'tpslOrder' : stopType ? 'StopOrder' : 'Order',
        };
    }

    private pushState(): void {
        if (!this.indicator) return;
        const state: ReplayVisualState = {
            positions: this.live.map((position) => {
                const pnlAt = (price: number | null): number | null => (
                    price == null ? null : (price - position.entryPrice) * position.size
                );
                return {
                    id: position.id,
                    side: position.size < 0 ? 'sell' : 'buy',
                    entryPrice: position.entryPrice,
                    entryTime: position.openedAt,
                    stopPrice: position.stopLoss,
                    targetPrice: position.takeProfit,
                    size: Math.abs(position.size),
                    openPnl: position.unrealized,
                    stopPnl: pnlAt(position.stopLoss),
                    targetPnl: pnlAt(position.takeProfit),
                    openR: null,
                    stopR: null,
                    targetR: null,
                };
            }),
            orders: this.resting.map((order) => ({ id: order.id, side: order.side, price: order.price, tag: order.kind })),
            fills: [],
        };
        this.indicator.setInputs({ [STATE_INPUT]: JSON.stringify(state) });
    }
}
