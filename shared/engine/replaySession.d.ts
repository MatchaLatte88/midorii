/**
 * Hand-written types for replaySession.js — the .js file stays the single
 * source of truth. Only the surface Midorii actually calls is typed here.
 */
import type { Broker, Costs, Order, OrderSpec, PositionMode, ProtectionLevels } from './broker';

export interface ReplayBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/** What `result()` returns — the same shape a backtest run produces. */
export interface ReplayResult {
    trades: unknown[];
    fills: unknown[];
    orders: Order[];
    equityCurve: unknown[];
    openPosition: unknown;
    stats: Record<string, unknown>;
    barCount: number;
    stepMs: number;
    costs: Required<Costs>;
    initialBalance: number;
    resolution: string;
    elapsedMs: number;
    from: number;
    to: number;
}

export declare class ReplaySession {
    constructor(options: {
        bars: ReplayBar[];
        startIndex: number;
        balance?: number;
        costs?: Costs;
        stepMs?: number | null;
        mode?: PositionMode;
    });

    readonly broker: Broker;
    bars: ReplayBar[];
    startIndex: number;
    index: number;
    stepMs: number;
    startTime: number;
    /** The playhead as an instant: the end of the last revealed bar. */
    clock: number;
    steps: number;

    get bar(): ReplayBar;
    get atEnd(): boolean;
    get progress(): number;
    get resolution(): string;
    get elapsedMs(): number;

    /** Reveal the next bar and match orders against it. Throws once `atEnd`. */
    step(subBars?: ReplayBar[] | null): void;

    /** Market entry, filled immediately at the last price (the human's path). */
    buy(spec?: Partial<OrderSpec>): Order;
    sell(spec?: Partial<OrderSpec>): Order;
    /** A raw order — market fills now, limit/stop rest until triggered. */
    order(spec: OrderSpec): Order;

    close(tag?: string): void;
    closePart(size: number, positionId?: number | null): void;
    reverse(positionId?: number | null): void;
    flatten(): void;
    cancelAll(tag?: string): void;

    protect(levels: ProtectionLevels, positionId?: number | null): void;
    breakEven(positionId?: number | null): boolean;
    setTrailing(distance: number, options?: { activateAt?: number }, positionId?: number | null): void;
    modifyOrder(id: number, patch: Partial<OrderSpec>): boolean;

    /** Swap the bar array (a timeframe change) without rewinding the clock. */
    rebase(opts: { bars: ReplayBar[]; stepMs?: number | null; forming?: unknown }): void;
    /** Append more bars to the end — never prepend. */
    extend(bars: ReplayBar[]): void;

    result(): ReplayResult;
    snapshot(): unknown;
    static restore(snapshot: unknown, ctx: { bars: ReplayBar[]; forming?: unknown }): ReplaySession;
}

/** Index of the bar covering `timeMs` (the clock → index translation). */
export declare function barIndexAt(bars: ReplayBar[], timeMs: number): number;
