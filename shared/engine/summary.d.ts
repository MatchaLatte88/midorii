/**
 * Hand-written types for summary.js — the stats block a finished run reports.
 * The .js file stays the single source of truth.
 */
import type { Broker } from './broker';

/**
 * The figures a finished account is judged on. `null` where the account gave no honest
 * answer — no trades means no win rate, and 0% would read as "always lost".
 */
export interface RunStats {
    initialBalance: number;
    finalEquity: number;
    netPnl: number;
    /** A fraction, not a percentage: 0.12 is +12%. */
    returnPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    /** Null when nothing lost — an infinite factor is real but does not belong in a sum. */
    profitFactor: number | null;
    expectancy: number | null;
    feesPaid: number;
    barCount: number;
    equityPoints: number;
}

export declare function summarize(input: {
    broker: Broker;
    equityCurve: unknown[];
    maxDrawdown: number;
    maxDrawdownPct: number;
    barCount: number;
}): RunStats;
