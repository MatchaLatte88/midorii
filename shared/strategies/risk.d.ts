/**
 * Hand-written types for risk.js — risk-based position sizing, shared by the
 * replay and the backtest so both size a trade identically. The .js file stays
 * the single source of truth.
 */

export type RiskMode = 'percent' | 'fixed';

export declare const RISK_MODES: readonly ['percent', 'fixed'];

/** One settable field, in the shape every strategy schema is written in. */
export interface RiskParam {
    key: string;
    label: string;
    type: 'select' | 'number';
    default: string | number;
    min?: number;
    max?: number;
    step?: number;
    options?: ReadonlyArray<{ value: string; label: string }>;
    hint?: string;
}

/** The two questions every strategy shares, prepended to each schema so they cannot drift. */
export declare const RISK_PARAMS: readonly RiskParam[];

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
