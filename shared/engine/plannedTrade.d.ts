/**
 * Hand-written types for plannedTrade.js — turns a drawn entry/stop/target
 * block into an order spec. The .js file stays the single source of truth.
 */
import type { OrderBracket, OrderType, Side } from './broker';

export declare const PLAN_MODES: readonly ['market', 'pending'];
export type PlanMode = 'market' | 'pending';

export declare const BRACKET_MODES: readonly ['levels', 'distance'];
/** How a market order carries the drawn stop and target: the drawn prices, or the drawn
 *  distances measured from the actual fill. A pending order fills at the drawn entry, where
 *  the two coincide. */
export type BracketMode = 'levels' | 'distance';

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
    /** Absolute levels, or distances from the fill — see `BracketMode`. */
    bracket: OrderBracket;
    risk: number;
    reward: number | null;
}

/**
 * Throws (with a message naming the anchor to move) on a block that is not a
 * trade: a stop on the entry, or a target on the stop's side.
 */
export declare function orderFromPlan(
    plan: TradePlan,
    options: { price: number; mode: PlanMode; bracket?: BracketMode },
): PlannedOrder;

export declare function sizingEntry(spec: PlannedOrder, price: number): number;
export declare function sizingStop(spec: PlannedOrder, entry: number): number;
