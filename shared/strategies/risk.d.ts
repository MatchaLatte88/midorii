/**
 * Hand-written types for risk.js — risk-based position sizing, shared by the
 * replay and (later) the backtest so both size a trade identically. The .js
 * file stays the single source of truth.
 */

export type RiskMode = 'percent' | 'fixed';

export declare const RISK_MODES: readonly ['percent', 'fixed'];
export declare const RISK_PARAMS: ReadonlyArray<Record<string, unknown>>;

/**
 * Size for a trade risking `value` (percent of equity, or cash) between `entry`
 * and `stop`, capped at `maxLeverage` × equity of notional. Null when the trade
 * cannot be sized (no stop distance, no equity, no risk).
 */
export declare function positionSize(
    equity: number,
    entry: number,
    stop: number,
    mode: RiskMode,
    value: number,
    maxLeverage?: number,
): number | null;
