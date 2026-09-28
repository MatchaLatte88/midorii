import type { Costs } from '../../../shared/engine/broker';
import type { MineProgress, MineResult } from './miner';
import type { ExitRule } from './outcomes';

/**
 * What crosses the line between the Patterns tab and the search's thread.
 *
 * The bars go over packed, in the bar store's own stride-7 layout, for the reason the sweep
 * gives in sweepProtocol.ts: one buffer transfers without a copy, half a million objects do
 * not. The packing itself is the sweep's, reused rather than written twice.
 */

export interface PatternSearchRequest {
    bars: Float64Array;
    exit: ExitRule;
    costs: Required<Costs>;
    maxDepth: number;
    /** An atom every pattern must contain, or null for a free search. */
    anchor: string | null;
    minTrades: number;
    nullRuns: number;
    keep: number;
    seed: number;
    riskPct: number;
    balance: number;
}

/** Page to thread. */
export type PatternSearchCommand =
    | { type: 'run'; request: PatternSearchRequest }
    | { type: 'stop' };

/** Thread to page. */
export type PatternSearchEvent =
    | { type: 'progress'; progress: MineProgress }
    | { type: 'done'; result: MineResult }
    | { type: 'cancelled' }
    | { type: 'error'; message: string };
