/**
 * Hand-written types for broker.js — the .js file stays the single source of
 * truth (it carries full JSDoc). Only the surface Midorii actually calls is
 * typed here; the internals stay untyped on purpose.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type PositionMode = 'netting' | 'hedging';

export declare const SIDE: { readonly BUY: 'buy'; readonly SELL: 'sell' };
export declare const POSITION_MODE: { readonly NETTING: 'netting'; readonly HEDGING: 'hedging' };
export declare const DEFAULT_COSTS: {
    feeRate: number; feePerUnit: number; spreadPct: number; slippagePct: number;
};
/** Every cost switched off — what the rules alone are worth. */
export declare const NO_COSTS: { feeRate: 0; feePerUnit: 0; spreadPct: 0; slippagePct: 0 };

/** Rules the account applies to an open position by itself, in R. Zero switches one off. */
export interface Management {
    breakEvenAtR?: number;
    trailAtR?: number;
    trailR?: number;
}

export interface Costs {
    feeRate?: number;
    /** Commission per unit traded, in account money — added to `feeRate`, not instead of it. */
    feePerUnit?: number;
    spreadPct?: number;
    slippagePct?: number;
}

/** An open position. `size > 0` is long, `< 0` is short. */
export interface Position {
    id: number;
    entryOrderId: number | null;
    size: number;
    entryPrice: number;
    openedAt: number;
    fees: number;
    stopLoss: number | null;
    takeProfit: number | null;
    trailing: unknown;
    /** Whether the managed break-even has already fired — it may only fire once. */
    breakEvenDone?: boolean;
    /** What one unit risked when the position first had a stop — the fixed R unit. */
    riskPerUnit: number | null;
    entryTag: string | null;
}

export interface Order {
    id: number;
    side: Side;
    type: OrderType;
    size: number;
    limitPrice: number | null;
    stopPrice: number | null;
    reduceOnly: boolean;
    tag: string | null;
    parentId: number | null;
    positionId: number | null;
    bracket: OrderBracket | null;
    status: 'pending' | 'filled' | 'cancelled';
    placedAt: number | null;
    filledAt: number | null;
    fillPrice: number | null;
    fee: number | null;
}

/** Protection attached the moment an order fills — absolute prices OR distances, never both. */
export interface OrderBracket {
    stopLoss?: number;
    takeProfit?: number;
    stopDistance?: number;
    targetDistance?: number;
}

export interface OrderSpec {
    side: Side;
    type?: OrderType;
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    reduceOnly?: boolean;
    tag?: string | null;
    parentId?: number | null;
    positionId?: number | null;
    bracket?: OrderBracket | null;
}

export interface ProtectionLevels {
    stopLoss?: number | null;
    takeProfit?: number | null;
}

export declare class Broker {
    constructor(options?: {
        balance?: number;
        costs?: Costs;
        mode?: PositionMode;
        pointValue?: number;
        /** The smallest a size may move by — a contract, a lot. Null: no step. */
        sizeStep?: number | null;
        /** The least a position may ever be. Null: no minimum. */
        minSize?: number | null;
        /** Whether a resting limit fills on a touch or needs the level crossed. Default 'touch'. */
        limitFillMode?: 'touch' | 'through';
        management?: Management | null;
    });

    readonly mode: PositionMode;
    readonly initialBalance: number;
    balance: number;
    readonly costs: Required<Costs>;
    pending: Order[];
    orders: Order[];
    fills: unknown[];
    trades: unknown[];
    positions: Position[];
    time: number | null;
    lastPrice: number | null;
    /** Money per point per unit — 1 unless an instrument says otherwise. */
    readonly pointValue: number;
    /** The smallest a size may move by, or null — see the constructor option. */
    readonly sizeStep: number | null;
    /** The least a position may ever be, or null — see the constructor option. */
    readonly minSize: number | null;
    /** Whether a resting limit fills on a touch or needs the level crossed. */
    readonly limitFillMode: 'touch' | 'through';
    /** The two sides a market order fills at, or null. */
    readonly quote: { bid: number; ask: number } | null;
    /** Break-even and trailing rules the account applies itself, or null. */
    readonly management: Required<Management> | null;

    /** Throws while anything is open or waiting. */
    setPointValue(value: number): void;
    /** Install the managed break-even and trail, or clear them with null. */
    setManagement(rules: Management | null): void;
    setQuote(bid: number | null, ask: number | null): void;

    get position(): Position | null;
    get equity(): number;
    get unrealizedPnl(): number;
    get netSize(): number;
    get isFlat(): boolean;
    positionPnl(position: Position | null): number;
    positionById(id: number): Position | null;

    placeOrder(spec: OrderSpec): Order;
    cancelOrder(id: number): boolean;
    modifyOrder(id: number, patch?: Partial<OrderSpec>): boolean;
    cancelAll(tag?: string | null): number;
    submitEntry(spec: { side: Side; size: number; stopLoss?: number; takeProfit?: number; tag?: string | null }): Order;
    closePosition(tag?: string, options?: { size?: number; positionId?: number }): Order | null;
    flatten(tag?: string): Order[];

    protect(position: Position, levels?: ProtectionLevels): void;
    /** Net result of exiting now, costs included. */
    exitResult(position: Position, price: number, opts?: { takesLiquidity?: boolean }): number;
    breakEvenPrice(position: Position): number | null;
    /** Why break-even is refused right now (a string), or null when it is available. */
    breakEvenRefusal(position: Position): string | null;
    breakEven(position: Position): boolean;
    setTrailing(position: Position, distance: number, options?: { activateAt?: number }): void;

    /** Fill a market order immediately — at the quote's side where one is set, else the last price. */
    fillNow(order: Order): void;
    /** Match pending orders against a bar; `subBars` (1m) resolve intrabar, else pessimistic. */
    processBar(bar: unknown, subBars?: unknown[] | null): void;

    snapshot(): unknown;
    static restore(data: unknown): Broker;
}

export declare function resetOrderIds(): void;
