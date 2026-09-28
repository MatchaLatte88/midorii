import PatternWorker from './pattern.worker?worker';
import { packBars } from '../backtest/sweepProtocol';
import type { BacktestBar } from '../../../shared/engine/backtest';
import type { MineProgress, MineResult } from './miner';
import type { PatternSearchCommand, PatternSearchEvent, PatternSearchRequest } from './patternProtocol';

/**
 * Starting a pattern search on its own thread, and getting it back. One at a time, refused
 * rather than queued — the sweep client's policy, for the sweep client's reasons.
 */

export interface StartPatternSearchOptions extends Omit<PatternSearchRequest, 'bars'> {
    bars: readonly BacktestBar[];
    onProgress?: (progress: MineProgress) => void;
}

export interface PatternSearchHandle {
    /** The finished search, or null when it was stopped. Rejects on a real failure. */
    result: Promise<MineResult | null>;
    stop(): void;
}

let active: Worker | null = null;

export function startPatternSearch(options: StartPatternSearchOptions): PatternSearchHandle {
    if (active) throw new Error('A pattern search is already running.');

    const { bars: source, onProgress, ...rest } = options;
    const bars = packBars(source);
    const request: PatternSearchRequest = { ...rest, bars };

    const worker: Worker = new PatternWorker();
    active = worker;

    const result = new Promise<MineResult | null>((resolve, reject) => {
        const finish = (settle: () => void): void => {
            if (active === worker) active = null;
            worker.terminate();
            settle();
        };

        worker.onmessage = (message: MessageEvent<PatternSearchEvent>) => {
            const event = message.data;
            if (event.type === 'progress') {
                onProgress?.(event.progress);
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
            finish(() => reject(new Error(event.message || 'The pattern search thread stopped unexpectedly.')));
        };

        const command: PatternSearchCommand = { type: 'run', request };
        worker.postMessage(command, [bars.buffer]);
    });

    return {
        result,
        stop: () => {
            const command: PatternSearchCommand = { type: 'stop' };
            worker.postMessage(command);
        },
    };
}
