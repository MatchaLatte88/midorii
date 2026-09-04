/**
 * Hand-written types for summary.js — the stats block a finished run reports.
 * The .js file stays the single source of truth.
 */
import type { Broker } from './broker';

export declare function summarize(input: {
    broker: Broker;
    equityCurve: unknown[];
    maxDrawdown: number;
    maxDrawdownPct: number;
    barCount: number;
}): Record<string, unknown>;
