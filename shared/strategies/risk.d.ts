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
    type: 'select' | 'number' | 'bool';
    default: string | number | boolean;
    min?: number;
    max?: number;
    step?: number;
    options?: ReadonlyArray<{ value: string; label: string }>;
    /** How the control should be drawn where the type alone leaves a choice. */
    variant?: 'badges';
    hint?: string;
}

/** The questions every strategy shares, prepended to each schema so they cannot drift. */
export declare const RISK_PARAMS: readonly RiskParam[];

/**
 * Size for a trade risking `value` (percent of equity, or cash) between `entry`
 * and `stop`, capped at `maxLeverage` × equity of notional — or uncapped when
 * `maxLeverage` is null. Null when the trade cannot be sized (no stop distance,
 * no equity, no risk).
 */
export declare function positionSize(
    equity: number,
    entry: number,
    stop: number,
    mode: RiskMode,
    value: number,
    maxLeverage?: number | null,
): number | null;

/** The notional ceiling these parameters ask for, or null when it is switched off. */
export declare function leverageCap(params: Readonly<Record<string, unknown>>): number | null;

/** How the trade is managed once it is on — see the Broker's `management` option. */
export interface RiskManagement {
    /** R in front at which the stop moves to break-even. 0 never does. */
    breakEvenAtR: number;
    /** R in front at which the trail arms. 0 never trails. */
    trailAtR: number;
    /** How far behind the extreme the trailing stop sits, in R. */
    trailR: number;
}

/** The management rules in these parameters, or null when the trade just runs to its levels. */
export declare function riskManagement(
    params: Readonly<Record<string, unknown>>,
): RiskManagement | null;
