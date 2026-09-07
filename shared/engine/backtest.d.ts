/**
 * Hand-written types for backtest.js — the loop that drives a strategy over history.
 * The .js file stays the single source of truth (it carries the full reasoning).
 */
import type { Costs, Order, Position, PositionMode, Side } from './broker';
import type { RunStats } from './summary';

/** A bar as the loop reads it. `time` is the bar's open time in epoch ms. */
export interface BacktestBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/** One point of the equity curve — one per bar the strategy was live for. */
export interface EquityPoint {
    time: number;
    equity: number;
    balance: number;
    drawdown: number;
}

/**
 * Anything a strategy reads as an event. The only field the loop needs is `index`: the bar
 * from which the item could have been acted on. Anything drawn from an earlier bar keeps
 * that under its own name (`startIndex`), which this loop never reads.
 */
export interface BacktestEvent {
    index: number;
}

/** What a strategy is handed on every closed bar. */
export interface BacktestContext<P = Record<string, unknown>> {
    readonly bar: BacktestBar;
    readonly index: number;
    readonly time: number;
    /** The last `n` closed bars, oldest first, ending with the current one. */
    history(n?: number): BacktestBar[];
    /** A declared series value; `back` counts bars into the past. Null before it is defined. */
    value(name: string, back?: number): number | null;
    /** The declared events this bar confirmed — never anything from a later bar. */
    events<T extends BacktestEvent = BacktestEvent>(name: string): readonly T[];

    readonly position: Position | null;
    readonly positions: Position[];
    readonly balance: number;
    readonly equity: number;
    readonly isFlat: boolean;
    readonly pendingOrders: Order[];

    readonly params: P;

    /** Market entry with the stop and target attached. */
    buy(spec: { size: number; stopLoss?: number; takeProfit?: number; tag?: string | null }): Order;
    sell(spec: { size: number; stopLoss?: number; takeProfit?: number; tag?: string | null }): Order;
    /** Any order the Broker takes — a resting limit or stop, with an optional bracket. */
    order(spec: Parameters<import('./broker').Broker['placeOrder']>[0]): Order;
    close(tag?: string): Order | null;
    cancel(id: number): boolean;
    cancelAll(tag?: string | null): number;

    /** Free-form store that survives across bars, for strategy state. */
    state: Record<string, unknown>;
}

/** A runnable strategy: precomputed inputs plus what to do with them. */
export interface RunnableStrategy<P = Record<string, unknown>> {
    /** Per-bar values, one array per name, each the same length as the bars. */
    series?: Record<string, ReadonlyArray<number | null | undefined>>;
    /** Discrete objects, bucketed by their `index` — see {@link BacktestEvent}. */
    events?: Record<string, readonly BacktestEvent[]>;
    params?: P;
    init?(ctx: BacktestContext<P>): void;
    onBar(ctx: BacktestContext<P>): void;
    onFinish?(ctx: BacktestContext<P>): void;
}

/** Everything a finished run reports. */
export interface BacktestResult {
    trades: unknown[];
    fills: unknown[];
    orders: Order[];
    equityCurve: EquityPoint[];
    /** A position the strategy left open at the last bar, as it stood. */
    openPosition: Position | null;
    stats: RunStats;
    /** Bars skipped while a declared series was still undefined. */
    warmupBars: number;
    barCount: number;
    /** How long one bar is, so a stored run can be read back without re-deriving it. */
    stepMs: number | null;
    /** The costs the run was actually charged, not the overrides it was handed. */
    costs: Required<Costs>;
    initialBalance: number;
    /** `'intrabar'` when minute bars settled the ambiguous bars, else `'pessimistic'`. */
    resolution: 'intrabar' | 'pessimistic';
    elapsedMs: number;
}

export declare function runBacktest<P = Record<string, unknown>>(params: {
    bars: readonly BacktestBar[];
    baseBars?: readonly BacktestBar[] | null;
    strategy: RunnableStrategy<P>;
    broker?: { balance?: number; costs?: Costs; mode?: PositionMode };
    stepMs?: number | null;
}): BacktestResult;

export type { Side };
