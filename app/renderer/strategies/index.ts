import type { OHLCV } from '../../../src/core/model/ohlcv';
import type { RunnableStrategy } from '../../../shared/engine/backtest';
import type { DetectionCache } from './detection';
import { INTRADAY_MOMENTUM_STRATEGY } from './intradayMomentum';
import { OPENING_RANGE_STRATEGY } from './openingRange';
import { SILVER_BULLET_STRATEGY } from './silverBullet';
import type { StrategyInfo, StrategyParams, StrategyParamValue, StrategySpec } from './types';

/**
 * The strategies this app can run, and the one way of turning settings into a runnable one.
 *
 * Risk lives outside the strategies, not inside each
 * -------------------------------------------------
 * Every strategy gets the same two questions, so they are asked once, in `RISK_PARAMS`, and
 * answered the same way everywhere: how much is at stake on a trade, and where the target sits
 * relative to that. A strategy that invented its own names for these would make two runs
 * impossible to compare, which is the whole point of storing them.
 *
 * Position sizing is derived, never set. You choose the risk; the distance to the stop decides
 * the size, so being stopped out costs what you said it would however wide the stop happens to
 * be.
 */

export const STRATEGIES: Record<string, StrategySpec> = {
    silverbullet: SILVER_BULLET_STRATEGY,
    openingrange: OPENING_RANGE_STRATEGY,
    intradaymomentum: INTRADAY_MOMENTUM_STRATEGY,
};

function specFor(id: string): StrategySpec {
    const spec = STRATEGIES[id];
    if (!spec) throw new Error(`Unknown strategy "${id}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
    return spec;
}

/** Metadata for the UI, without the part that runs. */
export function strategyCatalog(): StrategyInfo[] {
    return Object.values(STRATEGIES).map(({ build, ...rest }) => rest);
}

/**
 * Validates settings against a strategy's schema and returns them merged with the defaults.
 *
 * A bad value is refused where it was entered rather than silently ignored by whatever reads
 * it later — a run whose settings were quietly corrected reports a result nobody asked for.
 */
export function resolveStrategyParams(id: string, params: Readonly<Record<string, unknown>> = {}): StrategyParams {
    const spec = specFor(id);
    const merged: StrategyParams = {};

    for (const p of spec.params) {
        const given = params[p.key];
        if (given === undefined) {
            merged[p.key] = p.default;
            continue;
        }

        if (p.type === 'number') {
            const n = Number(given);
            if (!Number.isFinite(n)) throw new Error(`${id}.${p.key}: "${String(given)}" is not a number`);
            if (p.min !== undefined && n < p.min) throw new Error(`${id}.${p.key}: ${n} is below ${p.min}`);
            if (p.max !== undefined && n > p.max) throw new Error(`${id}.${p.key}: ${n} is above ${p.max}`);
            merged[p.key] = n;
        } else if (p.type === 'multi') {
            if (!Array.isArray(given)) throw new Error(`${id}.${p.key}: expected a list, got ${typeof given}`);
            for (const v of given) {
                if (!p.options?.some((o) => o.value === v)) {
                    throw new Error(`${id}.${p.key}: "${String(v)}" is not one of ${optionList(p.options)}`);
                }
            }
            merged[p.key] = [...given] as readonly string[];
        } else if (p.type === 'select') {
            if (!p.options?.some((o) => o.value === given)) {
                throw new Error(`${id}.${p.key}: "${String(given)}" is not one of ${optionList(p.options)}`);
            }
            merged[p.key] = given as string;
        } else if (p.type === 'bool') {
            if (typeof given !== 'boolean') throw new Error(`${id}.${p.key}: expected true or false`);
            merged[p.key] = given;
        } else {
            merged[p.key] = given as StrategyParamValue;
        }
    }

    return merged;
}

function optionList(options: readonly { value: string }[] | undefined): string {
    return (options ?? []).map((o) => o.value).join(', ');
}

/**
 * Builds a runnable strategy from an id, raw settings and the bars it will run over.
 *
 * `cache` is a sweep's detection cache and belongs to ONE stretch of bars — see
 * detection.ts. A single backtest passes none.
 */
export function buildStrategy(
    id: string,
    params: Readonly<Record<string, unknown>>,
    bars: readonly OHLCV[],
    cache?: DetectionCache,
): RunnableStrategy<StrategyParams> {
    return specFor(id).build(resolveStrategyParams(id, params), bars, cache);
}

/** One stored setting, ready to print: what it is called and what it was. */
export interface DescribedParam {
    key: string;
    label: string;
    value: string;
}

/** A stored value as the form would have shown it — an option's label rather than its id,
 *  a switch as On or Off. */
function describeValue(value: unknown, param: StrategySpec['params'][number] | undefined): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'On' : 'Off';
    if (Array.isArray(value)) {
        const labels = value.map((v) => param?.options?.find((o) => o.value === v)?.label ?? String(v));
        return labels.length > 0 ? labels.join(', ') : 'None';
    }
    if (param?.type === 'select') {
        return param.options?.find((o) => o.value === value)?.label ?? String(value);
    }
    return String(value);
}

/**
 * The settings a run was made with, in the order the form asks for them.
 *
 * Reading a stored run is the reason the settings are stored at all, and a raw object is
 * not reading: `minGapSizeUnit: "points"` is a field name, "Measured in: Points" is the
 * question that was answered. Anything the schema no longer knows about is still listed,
 * under its own key — a run made by an older build says what it did, rather than quietly
 * dropping the setting that made it interesting.
 *
 * Takes an id rather than a spec so it works for a run whose strategy is gone entirely.
 */
export function describeParams(id: string, params: Readonly<Record<string, unknown>>): DescribedParam[] {
    const spec = STRATEGIES[id];
    const schema = new Map((spec?.params ?? []).map((p) => [p.key, p]));
    const ordered = [
        ...(spec?.params ?? []).map((p) => p.key),
        ...Object.keys(params).filter((key) => !schema.has(key)),
    ];

    const rows: DescribedParam[] = [];
    for (const key of ordered) {
        if (!(key in params)) continue;
        const param = schema.get(key);
        rows.push({ key, label: param?.label ?? key, value: describeValue(params[key], param) });
    }
    return rows;
}

/** Which of a strategy's parameters change what it detects. Empty when it says nothing —
 *  every combination then detects for itself, which is correct and slow. */
export function detectionKeysOf(id: string): readonly string[] {
    return specFor(id).detectionKeys ?? [];
}

export { RISK_PARAM_KEYS } from './types';
export { cached, detectionCacheKey } from './detection';
export type { DetectionCache } from './detection';
export type { StrategyInfo, StrategyParam, StrategyParams, StrategyParamValue, StrategySpec } from './types';
