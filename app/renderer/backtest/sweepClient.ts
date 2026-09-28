import SweepWorker from './sweep.worker?worker';
import type { SweepProgress, SweepRun } from './sweepRunner';
import { packBars, type SweepCommand, type SweepEvent, type SweepRequest } from './sweepProtocol';
import type { BacktestBar } from '../../../shared/engine/backtest';
import type { RankMetricId, SweepRanges } from '../../../shared/analysis/sweep';
import type { Costs } from '../../../shared/engine/broker';

/**
 * Starting a sweep on its own thread, and getting it back.
 *
 * One at a time, and that is a policy rather than a limitation: two sweeps would compete
 * for the same cores and both finish later than either alone, and the tab has one place to
 * show progress. Asking for a second while one runs is refused rather than queued — a
 * queue would leave someone waiting on work they cannot see.
 */

export interface StartSweepOptions {
    strategy: string;
    ranges: SweepRanges;
    base: Record<string, unknown>;
    bars: readonly BacktestBar[];
    baseBars?: readonly BacktestBar[] | null;
    from: number;
    to: number;
    balance: number;
    /** What every combination is charged. Null takes the Broker's defaults. */
    costs?: Costs | null;
    /** Money per point per unit. 1 unless the instrument says otherwise. */
    pointValue?: number;
    /** The smallest a size may move by, or null for no step. */
    sizeStep?: number | null;
    /** The least a position may ever be, or null. */
    minSize?: number | null;
    stepMs?: number | null;
    trainFraction: number;
    metric: RankMetricId;
    minTrades: number;
    showCount?: number;
    onProgress?: (p: SweepProgress) => void;
}

export interface SweepHandle {
    /** The finished sweep, or null when it was stopped. Rejects on a real failure. */
    result: Promise<SweepRun | null>;
    /** Asks the thread to stop after the combination it is on. */
    stop(): void;
}

let active: Worker | null = null;

export function isSweepRunning(): boolean {
    return active !== null;
}

export function startSweep(options: StartSweepOptions): SweepHandle {
    if (active) throw new Error('A sweep is already running.');

    const bars = packBars(options.bars);
    const baseBars = options.baseBars && options.baseBars.length > 0 ? packBars(options.baseBars) : null;

    const request: SweepRequest = {
        strategy: options.strategy,
        ranges: options.ranges,
        base: options.base,
        bars,
        baseBars,
        from: options.from,
        to: options.to,
        balance: options.balance,
        costs: options.costs ?? null,
        pointValue: options.pointValue ?? 1,
        sizeStep: options.sizeStep ?? null,
        minSize: options.minSize ?? null,
        stepMs: options.stepMs ?? null,
        trainFraction: options.trainFraction,
        metric: options.metric,
        minTrades: options.minTrades,
        showCount: options.showCount ?? 4,
    };

    const worker: Worker = new SweepWorker();
    active = worker;

    const result = new Promise<SweepRun | null>((resolve, reject) => {
        // Whatever happens, the slot has to be released or nothing can run again.
        const finish = (settle: () => void): void => {
            if (active === worker) active = null;
            worker.terminate();
            settle();
        };

        worker.onmessage = (message: MessageEvent<SweepEvent>) => {
            const event = message.data;
            if (event.type === 'progress') {
                options.onProgress?.(event.progress);
                return;
            }
            if (event.type === 'done') {
                finish(() => resolve(event.result));
                return;
            }
            if (event.type === 'cancelled') {
                finish(() => resolve(null));
                return;
            }
            finish(() => reject(new Error(event.message)));
        };

        worker.onerror = (event: ErrorEvent) => {
            finish(() => reject(new Error(event.message || 'The sweep thread stopped unexpectedly.')));
        };

        const command: SweepCommand = { type: 'run', request };
        /* The buffers go by transfer, not by copy: the page gives up ownership of the
         * packed bars, which is what makes handing over half a million of them free.
         * Nothing here reads them again. */
        const transfer = [bars.buffer, baseBars?.buffer].filter((b): b is ArrayBuffer => b != null);
        worker.postMessage(command, transfer);
    });

    return {
        result,
        stop: () => {
            const command: SweepCommand = { type: 'stop' };
            worker.postMessage(command);
        },
    };
}
