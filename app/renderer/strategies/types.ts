import type { OHLCV } from '../../../src/core/model/ohlcv';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import type { DetectionCache } from './detection';

/**
 * What a strategy is, as a thing the app can list, configure and run.
 *
 * The line between a strategy and an indicator is not complexity. An indicator describes the
 * market; a strategy commits to a trade. The moment something says "buy here, risk this much,
 * get out there" it stops being a drawing on a chart and becomes a thing that can be right or
 * wrong about money — and that is what can be backtested.
 *
 * A strategy is allowed to USE an indicator, and Silver Bullet does: the detector stays in the
 * chart core, keeps painting on the chart, and the strategy reads its setups as events. One
 * definition, two uses. If the strategy re-implemented the detection, the chart and the
 * backtest would eventually disagree about the same market.
 *
 * Why `build` takes the bars
 * --------------------------
 * The backtest loop is handed events already computed (see `shared/engine/backtest.js`), so
 * building a runnable strategy is where detection happens. It also means the parameters reach
 * the detector: a run with a 0.5% minimum gap has to hand that number over, and a static
 * object cannot.
 */

/** What a settable field holds. `multi` is a list of option values. */
export type StrategyParamValue = number | string | boolean | readonly string[];

/** The values of a whole schema, keyed by field. */
export type StrategyParams = Record<string, StrategyParamValue>;

export type StrategyParamType = 'number' | 'select' | 'multi' | 'bool';

export interface StrategyParamOption {
    value: string;
    label: string;
}

/** One settable field. The same shape `RISK_PARAMS` is written in, so the two can be
 *  concatenated into one schema without translation. */
export interface StrategyParam {
    key: string;
    label: string;
    type: StrategyParamType;
    default: StrategyParamValue;
    min?: number;
    max?: number;
    step?: number;
    options?: readonly StrategyParamOption[];
    hint?: string;
}

/** A strategy as the registry holds it. */
export interface StrategySpec {
    id: string;
    name: string;
    description: string;
    /** The chart indicator this is built on, so a host can offer to draw what it traded. */
    indicator?: string;
    /** What the indicator it reads is called, for a screen that has to explain the
     *  difference between the two. */
    indicatorName?: string;
    /** Entry, stop, target and size — see {@link StrategyRules}. */
    rules?: StrategyRules;
    /** Risk first, then whatever the strategy itself asks. */
    params: readonly StrategyParam[];
    /**
     * Which parameters change what is DETECTED, rather than what is done about it.
     *
     * A sweep uses this twice: to reuse one detection across every combination that
     * differs only in how the setups are traded, and to tell someone up front whether the
     * 323 runs they just asked for are twenty seconds or twenty minutes. A strategy that
     * declares none simply detects once per combination, which is correct and slow.
     */
    detectionKeys?: readonly string[];
    /** Detection over `bars` plus the rules that act on it. `params` must already be resolved
     *  against the schema — see `resolveStrategyParams`. A sweep passes a `cache`, which is
     *  valid for ONE stretch of bars; see detection.ts. */
    build(params: StrategyParams, bars: readonly OHLCV[], cache?: DetectionCache): RunnableStrategy<StrategyParams>;
}

/**
 * What makes something a strategy rather than a drawing.
 *
 * An indicator says "this happened here" and stops. A strategy commits: it gets in
 * somewhere, it is wrong somewhere, it takes profit somewhere, and it decides how much is
 * at stake. Those four answers are what can be automated, and what can be right or wrong
 * about money.
 *
 * Written out per strategy rather than inferred, because they are the thing a person needs
 * to read before trusting a result — and because a strategy that cannot state them in four
 * sentences is not finished.
 */
export interface StrategyRules {
    /** What has to be true before any of the rest applies. */
    conditions: readonly string[];
    /** Where the order goes, and of what kind. */
    entry: string;
    /** Where the trade is wrong. */
    stop: string;
    /** Where it takes profit. */
    target: string;
    /** How large the position is, and what decides it. */
    size: string;
}

/** The metadata half of a strategy — everything except the part that runs. */
export type StrategyInfo = Omit<StrategySpec, 'build'>;

/** The keys `RISK_PARAMS` contributes, which every strategy shares. Used to split a schema
 *  into "what every strategy is asked" and "what this one asks". */
export const RISK_PARAM_KEYS: readonly string[] = ['riskMode', 'riskValue', 'maxLeverage', 'rrr'];
