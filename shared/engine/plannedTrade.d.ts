/**
 * Hand-written types for plannedTrade.js — turns a drawn entry/stop/target
 * block into an order spec. The .js file stays the single source of truth.
 */
import type { OrderBracket, OrderType, Side } from './broker';

export declare const PLAN_MODES: readonly ['market', 'pending'];
export type PlanMode = 'market' | 'pending';

/** A drawn position block. `target` may be absent. */
export interface TradePlan {
    entry: number;
    stop: number;
    target?: number | null;
}

export interface PlannedOrder {
    side: Side;
    type: OrderType;
    /** The level a resting order waits at; null for a market order. */
    price: number | null;
    /** Absolute levels for a pending entry, distances from the fill for a market one. */
    bracket: OrderBracket;
    risk: number;
    reward: number | null;
}

/**
 * Throws (with a message naming the anchor to move) on a block that is not a
 * trade: a stop on the entry, or a target on the stop's side.
 */
export declare function orderFromPlan(plan: TradePlan, options: { price: number; mode: PlanMode }): PlannedOrder;

export declare function sizingEntry(spec: PlannedOrder, price: number): number;
export declare function sizingStop(spec: PlannedOrder, entry: number): number;
