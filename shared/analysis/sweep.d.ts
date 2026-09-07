/**
 * Hand-written types for sweep.js — the arithmetic a parameter sweep is built on.
 * The .js file stays the single source of truth (it carries the full reasoning).
 */
import type { RunStats } from '../engine/summary';

/** One swept parameter: an inclusive range walked in fixed steps. */
export interface SweepRange {
    from: number;
    to: number;
    step: number;
}

/** The ranges of a sweep, keyed by the parameter each varies. */
export type SweepRanges = Record<string, SweepRange>;

/** The figures kept for every combination — there can be thousands, so not the trades. */
export interface SweepStats {
    tradeCount: number;
    netPnl: number;
    returnPct: number;
    winRate: number | null;
    maxDrawdownPct: number;
    profitFactor: number | null;
    expectancy: number | null;
    feesPaid: number;
}

/** One combination and what it did. `outOfSample` is filled in only for the few that get
 *  re-run on the stretch that had no say in the ranking. */
export interface SweepEntry {
    params: Record<string, unknown>;
    stats: SweepStats;
    /** Absent while a combination was only ranked; null once a stored sweep has been read
     *  back, since that is how JSON spells "there is none". */
    outOfSample?: SweepStats | null;
}

export declare const MAX_COMBINATIONS: number;

export declare function expandRange(range: SweepRange): number[];
export declare function countCombinations(ranges: SweepRanges | null | undefined): number;
export declare function expandSweep(
    ranges: SweepRanges,
    base?: Record<string, unknown>,
    limit?: number,
): Record<string, unknown>[];
export declare function detectionCount(
    ranges: SweepRanges | null | undefined,
    detectionKeys?: readonly string[],
): number;

/** How a sweep can be ordered. */
export type RankMetricId = 'expectancy' | 'netPnl' | 'profitFactor' | 'returnPct';

export interface RankMetric {
    id: RankMetricId;
    label: string;
    hint: string;
    read(stats: SweepStats | RunStats): number | null;
}

export declare const RANK_METRICS: Record<RankMetricId, RankMetric>;

export declare function rankResults(
    results: readonly SweepEntry[],
    metric?: RankMetricId,
    minTrades?: number,
): { ranked: SweepEntry[]; excluded: SweepEntry[] };

export declare function bestAndWorst(
    ranked: readonly SweepEntry[],
    count?: number,
): { best: SweepEntry[]; worst: SweepEntry[]; overlapping: boolean };

export declare function splitRange(
    from: number,
    to: number,
    trainFraction?: number,
): { train: { from: number; to: number }; test: { from: number; to: number } };
