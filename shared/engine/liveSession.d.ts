/**
 * Hand-written types for liveSession.js — the .js file stays the single source
 * of truth. Only the surface Midorii actually calls is typed here.
 */
import type { Broker, Costs, Order, OrderSpec, PositionMode, ProtectionLevels } from './broker';
import type { RunStats } from './summary';

/** A bar, or an update of the bar still forming, as the feed delivers it. */
export interface LiveBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/** What `buy`/`sell` take: a size and, optionally, the protection to attach on the way in. */
export interface EntrySpec {
    size: number;
    stopLoss?: number;
    takeProfit?: number;
    tag?: string | null;
}

/** One point of the account's curve. */
export interface EquityPoint {
    time: number;
    equity: number;
    balance: number;
    drawdown: number;
}

/** What `result()` returns — the same shape a backtest run produces. */
export interface LiveResult {
    trades: unknown[];
    fills: unknown[];
    orders: Order[];
    equityCurve: EquityPoint[];
    openPosition: unknown;
    stats: RunStats;
    warmupBars: number;
    barCount: number;
    stepMs: number | null;
    costs: Required<Costs>;
    initialBalance: number;
    resolution: string | null;
    elapsedMs: number;
    from: number;
    to: number;
}

export declare class LiveSession {
    constructor(options?: { balance?: number; costs?: Costs; mode?: PositionMode });

    broker: Broker;
    /** Open time of the bar the account stands in, or null before the first update. */
    barTime: number | null;
    seenHigh: number | null;
    seenLow: number | null;
    /** Wall clock when the account was opened — survives a restart. */
    createdAt: number;
    /** The first market instant it ever saw, or null before the first update. */
    firstBarTime: number | null;
    barsPlayed: number;
    peakEquity: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    /** How often the curve takes a point while nothing settles; doubles as the curve fills. */
    sampleMs: number;
    equityCurve: EquityPoint[];

    /** The newest price the account has been marked at, or null before the first update. */
    get price(): number | null;
    /** Nothing open and nothing waiting — free to move to another market. */
    get isIdle(): boolean;

    /** Put the account on a price without letting anything fill on it. */
    mark(bar: LiveBar): void;
    /** Play the ground covered since the last update into the account. */
    onBar(bar: LiveBar): LiveBar | null;
    /** Walk the account forward over bars it missed; returns how many were played. */
    catchUp(bars: readonly LiveBar[]): number;

    buy(spec?: EntrySpec): Order;
    sell(spec?: EntrySpec): Order;
    order(spec: OrderSpec): Order;

    close(tag?: string): Order | null;
    closeOne(positionId: number): Order | null;
    closePart(size: number, positionId?: number | null): Order | null;
    reverse(positionId?: number | null): Order | null;
    flatten(): Order[];
    cancelOrder(id: number): boolean;
    cancelAll(tag?: string): number;

    protect(levels: ProtectionLevels, positionId?: number | null): void;
    breakEven(positionId?: number | null): boolean;
    setTrailing(distance: number, options?: { activateAt?: number }, positionId?: number | null): void;
    modifyOrder(id: number, patch: Partial<OrderSpec>): boolean;

    /** What the account has done, in the figures every stored run reports. */
    stats(): RunStats;
    /** Wall-clock time the account has been open, across every sitting. */
    get elapsedMs(): number;
    /** The account as a finished run — the shape a backtest and a replay both produce. */
    result(options?: { resolution?: string | null }): LiveResult;

    snapshot(): unknown;
    static restore(snapshot: unknown): LiveSession;
}
