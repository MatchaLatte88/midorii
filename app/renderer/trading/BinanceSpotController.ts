import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';
import type { IndicatorHandle } from '../../../src';
import type { ReplayVisualState } from '../replay/replayIndicator';
import { STATE_INPUT } from '../replay/replayIndicator';
import { venueBook, type TradeBook } from '../replay/tradeBook';
import type {
    MidoriBinanceSpotAccount, MidoriBinanceSpotOrder, MidoriBinanceSpotSymbolInfo, MidoriBinanceSpotTrade,
} from '../midori';
import type { ControlledPosition, TradingController } from './TradingController';

export type BinanceSpotNotify = (message: string, kind: 'info' | 'error' | 'success') => void;

export interface BinanceSpotControllerOptions {
    symbol: string;
    info: MidoriBinanceSpotSymbolInfo;
    notify: BinanceSpotNotify;
    onChange?: () => void;
}

interface SpotPosition extends ControlledPosition {
    stopLoss: number | null;
    takeProfit: number | null;
    openedAt: number;
}

export interface SpotRestingOrder {
    id: number;
    orderId: number;
    orderListId: number;
    side: 'buy' | 'sell';
    size: number;
    price: number;
    kind: 'limit' | 'stop';
}

const RECONCILE_MS = 5_000;

const number = (value: string | number | undefined): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Average cost of the base units that remain, using the venue's own executions. */
export function spotAverageCost(trades: readonly MidoriBinanceSpotTrade[], baseAsset: string, quoteAsset: string): {
    quantity: number;
    price: number;
    openedAt: number;
} {
    let quantity = 0;
    let cost = 0;
    let openedAt = 0;
    for (const trade of [...trades].sort((a, b) => a.time - b.time)) {
        const qty = number(trade.qty);
        const quote = number(trade.quoteQty) || qty * number(trade.price);
        if (trade.isBuyer) {
            const received = Math.max(0, qty - (trade.commissionAsset === baseAsset ? number(trade.commission) : 0));
            const paid = quote + (trade.commissionAsset === quoteAsset ? number(trade.commission) : 0);
            if (quantity <= 0) openedAt = trade.time;
            quantity += received;
            cost += paid;
        } else if (quantity > 0) {
            const sold = Math.min(quantity, qty + (trade.commissionAsset === baseAsset ? number(trade.commission) : 0));
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
 * How many decimals a step has to be written out to.
 *
 * The exponent case is the whole reason this is a function: `String(0.00000001)` is `"1e-8"`,
 * so counting what follows the dot reports NO decimals, and the size is then rounded to a
 * whole coin. Rounded, not floored — `(0.5).toFixed(0)` is `"1"` — which inverts the one
 * guarantee {@link BinanceSpotController.snapSize} exists to make: that snapping can only ever
 * make an order smaller than asked for, never larger than the balance behind it.
 *
 * The same reading the venue module already does on the same numbers — see `decimalPlaces` in
 * app/electron/data/binanceSpot.js, which the order this snaps for is spelled out by.
 */
export function decimalPlaces(step: number): number {
    const text = String(step).toLowerCase();
    if (text.includes('e-')) return Number(text.split('e-')[1]);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

function isProtection(order: MidoriBinanceSpotOrder): boolean {
    return order.side === 'SELL' && (
        order.orderListId >= 0
        || order.type === 'STOP_LOSS'
        || order.type === 'STOP_LOSS_LIMIT'
        || order.type === 'TAKE_PROFIT'
        || order.type === 'TAKE_PROFIT_LIMIT'
    );
}

export class BinanceSpotController implements TradingController {
    readonly symbol: string;
    readonly info: MidoriBinanceSpotSymbolInfo;
    private readonly notify: BinanceSpotNotify;
    onChange: (() => void) | null;

    private accountState: MidoriBinanceSpotAccount | null = null;
    private live: SpotPosition[] = [];
    private resting: SpotRestingOrder[] = [];
    private protective: MidoriBinanceSpotOrder[] = [];
    private lastPrice = 0;
    private lastReadAt = 0;
    private stale = false;
    private indicator: IndicatorHandle | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;
    private readonly ids = new Map<number, number>();
    private nextId = 2;

    constructor(opts: BinanceSpotControllerOptions) {
        this.symbol = opts.symbol.toUpperCase();
        this.info = opts.info;
        this.notify = opts.notify;
        this.onChange = opts.onChange ?? null;
    }

    price(): number { return this.lastPrice; }

    mark(price: number): void {
        if (!(price > 0)) return;
        this.lastPrice = price;
        this.pushState();
        this.onChange?.();
    }

    positions(): readonly SpotPosition[] { return this.live; }
    orders(): readonly SpotRestingOrder[] { return this.resting; }

    /**
     * What is open and what is waiting, as the dock reads it — for a list, never for a
     * decision.
     *
     * Spot has no unrealized figure of its own: the venue holds balances, not positions with
     * a running result. So it is computed the same way {@link equity} already computes what
     * the pair is worth — the free and locked base units against the last price, over the
     * average cost {@link spotAverageCost} took from the venue's own executions. Fees on the
     * way in are already inside that cost; the sale's own fee is not, and cannot be until
     * there is a sale.
     */
    book(): TradeBook {
        return venueBook(this.live, this.resting, (p) => (this.lastPrice - p.entryPrice) * p.size);
    }
    accountCurrency(): string { return this.info.quoteAsset; }
    isStale(): boolean { return this.stale; }
    readAt(): number { return this.lastReadAt; }
    tradeable(): boolean { return this.info.status === 'TRADING'; }

    private balance(asset: string): { free: number; locked: number } {
        const row = this.accountState?.balances.find((candidate) => candidate.asset === asset);
        return { free: number(row?.free), locked: number(row?.locked) };
    }

    /** Value of this pair's base and quote balances, expressed in its quote asset. */
    equity(): number {
        const base = this.balance(this.info.baseAsset);
        const quote = this.balance(this.info.quoteAsset);
        return quote.free + quote.locked + (base.free + base.locked) * this.lastPrice;
    }

    available(): number { return this.balance(this.info.quoteAsset).free; }
    availableBase(): number { return this.balance(this.info.baseAsset).free; }

    order(spec: OrderSpec): void {
        if (!this.tradeable()) throw new Error(`Binance Spot Demo has ${this.symbol} on ${this.info.status}.`);
        const market = spec.type == null || spec.type === 'market';
        const step = market ? this.info.marketStepSize : this.info.stepSize;
        const size = this.snapSize(spec.size, step, market ? this.info.marketMinQty : this.info.minQty);
        const reference = spec.type === 'limit' ? spec.limitPrice : spec.type === 'stop' ? spec.stopPrice : this.lastPrice;
        if (!(reference != null && reference > 0)) throw new Error('A current price is required before placing this Spot order.');
        if (this.info.minNotional > 0 && size * reference < this.info.minNotional) {
            throw new Error(`This Spot order must be worth at least ${this.info.minNotional} ${this.info.quoteAsset}.`);
        }
        if (this.accountState && spec.side === 'sell' && size > this.availableBase() + step / 2) {
            throw new Error(`Spot can only sell the ${this.info.baseAsset} you hold; ${this.availableBase()} is free.`);
        }
        if (this.accountState && spec.side === 'buy' && size * reference > this.available() * 1.001) {
            throw new Error(`This buy needs more than the free ${this.info.quoteAsset} balance.`);
        }

        const payload = {
            symbol: this.symbol,
            side: spec.side === 'buy' ? ('BUY' as const) : ('SELL' as const),
            type: spec.type === 'limit' ? ('LIMIT' as const) : spec.type === 'stop' ? ('STOP_LOSS' as const) : ('MARKET' as const),
            quantity: size,
            ...(spec.limitPrice != null ? { price: spec.limitPrice } : {}),
            ...(spec.stopPrice != null ? { stopPrice: spec.stopPrice } : {}),
            ...(spec.bracket ? { bracket: spec.bracket } : {}),
        };
        const what = `${spec.side === 'buy' ? 'Buying' : 'Selling'} ${size} ${this.info.baseAsset}`;
        void this.send(() => window.midori.binanceSpot.placeOrder(payload), what);
    }

    protect(levels: ProtectionLevels, positionId?: number | null): void {
        const position = this.find(positionId);
        if (!position) throw new Error(`There is no ${this.info.baseAsset} holding to protect.`);
        const stopLoss = 'stopLoss' in levels ? levels.stopLoss ?? null : position.stopLoss;
        const takeProfit = 'takeProfit' in levels ? levels.takeProfit ?? null : position.takeProfit;
        if (stopLoss != null && stopLoss >= this.lastPrice) throw new Error('A Spot stop-loss must be below the market.');
        if (takeProfit != null && takeProfit <= this.lastPrice) throw new Error('A Spot take-profit must be above the market.');
        void this.send(
            () => window.midori.binanceSpot.replaceProtection({
                symbol: this.symbol,
                quantity: position.size,
                orders: this.protective.map((order) => ({ orderId: order.orderId, orderListId: order.orderListId })),
                ...(stopLoss == null ? {} : { stopLoss }),
                ...(takeProfit == null ? {} : { takeProfit }),
            }),
            'Updating Spot protection',
        );
    }

    closeOne(positionId: number): void {
        if (!this.find(positionId)) throw new Error(`There is no ${this.info.baseAsset} holding to close.`);
        void this.send(() => window.midori.binanceSpot.close(this.symbol), `Selling the ${this.info.baseAsset} holding`);
    }

    cancelOrder(orderId: number): void {
        const order = this.resting.find((candidate) => candidate.id === orderId);
        if (!order) throw new Error('That Spot order is no longer open.');
        void this.send(
            () => window.midori.binanceSpot.cancelOrder({ symbol: this.symbol, orderId: order.orderId }),
            'Cancelling the Spot order',
        );
    }

    cancelAll(): void {
        for (const order of this.resting) this.cancelOrder(order.id);
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

    private snapSize(value: number, step: number, minimum: number): number {
        if (!(value > 0) || !(step > 0)) throw new Error('Order size must be positive.');
        const snapped = Math.floor((value + step * 1e-9) / step) * step;
        const size = Number(snapped.toFixed(Math.min(15, decimalPlaces(step))));
        if (!(size >= minimum)) throw new Error(`The minimum Spot size is ${minimum} ${this.info.baseAsset}.`);
        return size;
    }

    private find(positionId?: number | null): SpotPosition | null {
        if (positionId == null) return this.live[0] ?? null;
        return this.live.find((position) => position.id === positionId) ?? null;
    }

    private async send(run: () => Promise<unknown>, what: string): Promise<void> {
        try {
            await run();
            this.notify(`${what} — accepted by Binance Spot Demo`, 'success');
        } catch (err: unknown) {
            this.notify(err instanceof Error ? err.message : String(err), 'error');
        }
        await this.reconcile();
    }

    private async reconcile(): Promise<void> {
        if (this.reconciling) return;
        this.reconciling = true;
        try {
            const [account, openOrders, trades] = await Promise.all([
                window.midori.binanceSpot.account(),
                window.midori.binanceSpot.openOrders(this.symbol),
                window.midori.binanceSpot.trades(this.symbol),
            ]);
            this.accountState = account;
            this.protective = openOrders.filter(isProtection);
            this.resting = openOrders.filter((order) => !isProtection(order)).map((order) => this.toResting(order));

            const holding = this.balance(this.info.baseAsset);
            const size = holding.free + holding.locked;
            const cost = spotAverageCost(trades, this.info.baseAsset, this.info.quoteAsset);
            const stop = this.protective.find((order) => order.type.startsWith('STOP_LOSS'));
            const target = this.protective.find((order) => order.type.startsWith('TAKE_PROFIT'));
            this.live = size >= this.info.minQty && size * this.lastPrice >= this.info.minNotional
                ? [{
                    id: 1,
                    size,
                    entryPrice: cost.price > 0 ? cost.price : this.lastPrice,
                    openedAt: cost.openedAt || Date.now(),
                    stopLoss: stop ? number(stop.stopPrice) : null,
                    takeProfit: target ? number(target.stopPrice || target.price) : null,
                }]
                : [];
            this.lastReadAt = Date.now();
            this.stale = false;
            this.pushState();
            this.onChange?.();
        } catch (err: unknown) {
            console.warn('[midorii] could not read the Binance Spot Demo account', err);
            this.stale = true;
            this.onChange?.();
        } finally {
            this.reconciling = false;
        }
    }

    private toResting(order: MidoriBinanceSpotOrder): SpotRestingOrder {
        let id = this.ids.get(order.orderId);
        if (id == null) {
            id = this.nextId++;
            this.ids.set(order.orderId, id);
        }
        const stop = number(order.stopPrice);
        return {
            id,
            orderId: order.orderId,
            orderListId: order.orderListId,
            side: order.side === 'BUY' ? 'buy' : 'sell',
            size: number(order.origQty) - number(order.executedQty),
            price: stop > 0 ? stop : number(order.price),
            kind: stop > 0 ? 'stop' : 'limit',
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
                    side: 'buy',
                    entryPrice: position.entryPrice,
                    entryTime: position.openedAt,
                    stopPrice: position.stopLoss,
                    targetPrice: position.takeProfit,
                    size: position.size,
                    openPnl: pnlAt(this.lastPrice) ?? 0,
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
