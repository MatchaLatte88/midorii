import type { StrategyParams } from './types';

/**
 * Reusing a strategy's detection across the runs of a sweep.
 *
 * Detection is what a sweep costs. On a year of BTC 5m, finding the setups is very nearly
 * the entire run — the loop that trades them is milliseconds — so a sweep of nineteen
 * reward-to-risk levels that detects nineteen times does the same work nineteen times to
 * answer nineteen questions about the same setups.
 *
 * Which parameters change what is DETECTED, rather than what is done about it, is a fact
 * only the strategy knows, so each one declares it as `detectionKeys` and builds its own
 * key from them. Everything here is the plumbing: a map, a stable key, and a lookup.
 *
 * The cache is keyed by parameters and NOT by the bars. That makes it the caller's job to
 * use one cache per stretch of history and never share one between two — do that and a
 * run silently reports another period's setups against these bars. The sweep runner
 * builds a fresh cache per stretch for exactly this reason.
 */

/** Whatever a strategy detected once, keyed by the parameters that produced it. */
export type DetectionCache = Map<string, unknown>;

/**
 * A stable key for one set of parameters.
 *
 * Sorted by name, so two objects with the same values agree however they were built, and
 * every value goes through JSON so a list parameter (`windows`) keys as reliably as a
 * number does.
 */
export function detectionCacheKey(
    id: string,
    params: StrategyParams,
    keys: readonly string[],
): string {
    const parts = [...keys].sort()
        .map((key) => `${key}=${JSON.stringify(params[key] ?? null)}`);
    return `${id}:${parts.join('|')}`;
}

/**
 * The cached value for `key`, computing it on the first ask.
 *
 * With no cache it is simply `compute()` — a single backtest passes none, and nothing in
 * a strategy has to know which of the two it is running under.
 */
export function cached<T>(cache: DetectionCache | undefined, key: string, compute: () => T): T {
    if (!cache) return compute();
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    const value = compute();
    cache.set(key, value);
    return value;
}
