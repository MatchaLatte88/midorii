import type { BacktestBar } from '../../../shared/engine/backtest';
import type { Costs } from '../../../shared/engine/broker';
import type { RankMetricId, SweepRanges } from '../../../shared/analysis/sweep';
import type { SweepProgress, SweepRun } from './sweepRunner';

/**
 * What crosses the line between the page and the sweep's thread.
 *
 * Bars go over as one flat Float64Array rather than as objects. A year of 5-minute bars
 * with the minutes underneath them is over half a million objects, and structured-cloning
 * that costs seconds and doubles the memory while both copies exist. Packed, the same data
 * is one buffer that transfers without a copy at all — the page hands ownership over and
 * the worker rebuilds the objects the engine wants on its own side.
 *
 * The layout is the bar store's: stride 7, ascending, `[time, o, h, l, c, volume,
 * buyVolume]`. Same order on both sides of the wire and on disk, so there is one thing to
 * remember rather than three.
 */

/** Fields per bar. Deliberately the store's stride, not a shorter one — a strategy that
 *  reads volume or delta must not silently find zeros here. */
export const STRIDE = 7;

export function packBars(bars: readonly BacktestBar[]): Float64Array {
    const out = new Float64Array(bars.length * STRIDE);
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i] as BacktestBar & { buyVolume?: number };
        const at = i * STRIDE;
        out[at] = bar.time;
        out[at + 1] = bar.open;
        out[at + 2] = bar.high;
        out[at + 3] = bar.low;
        out[at + 4] = bar.close;
        out[at + 5] = bar.volume ?? 0;
        // NaN is how every layer here spells "not recorded", and it is not zero.
        out[at + 6] = bar.buyVolume ?? NaN;
    }
    return out;
}

export function unpackBars(packed: Float64Array): BacktestBar[] {
    const count = packed.length / STRIDE;
    const out: BacktestBar[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const at = i * STRIDE;
        out[i] = {
            time: packed[at]!,
            open: packed[at + 1]!,
            high: packed[at + 2]!,
            low: packed[at + 3]!,
            close: packed[at + 4]!,
            volume: packed[at + 5]!,
            buyVolume: packed[at + 6]!,
        } as BacktestBar;
    }
    return out;
}

/** A sweep as it is asked for, with the bars already packed. */
export interface SweepRequest {
    strategy: string;
    ranges: SweepRanges;
    base: Record<string, unknown>;
    bars: Float64Array;
    baseBars: Float64Array | null;
    from: number;
    to: number;
    balance: number;
    /** What every combination is charged, or null for the Broker's defaults. */
    costs: Costs | null;
    pointValue: number;
    sizeStep: number | null;
    minSize: number | null;
    stepMs: number | null;
    trainFraction: number;
    metric: RankMetricId;
    minTrades: number;
    showCount: number;
}

/** Page to thread. */
export type SweepCommand =
    | { type: 'run'; request: SweepRequest }
    | { type: 'stop' };

/** Thread to page. */
export type SweepEvent =
    | { type: 'progress'; progress: SweepProgress }
    | { type: 'done'; result: SweepRun }
    | { type: 'cancelled' }
    | { type: 'error'; message: string };
