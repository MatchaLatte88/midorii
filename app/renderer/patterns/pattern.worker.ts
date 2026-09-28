import { unpackBars } from '../backtest/sweepProtocol';
import { minePatterns, PatternSearchCancelled } from './miner';
import type { PatternSearchCommand, PatternSearchEvent } from './patternProtocol';

/**
 * The thread a pattern search runs on — the sweep worker's arrangement, for the same
 * reasons (see sweep.worker.ts): tens of seconds of solid computation must not hold the
 * page, and stopping is a flag read between steps so it is quick without losing the thread.
 */

const PROGRESS_EVERY_MS = 100;

let stopped = false;

function post(event: PatternSearchEvent): void {
    self.postMessage(event);
}

self.onmessage = (message: MessageEvent<PatternSearchCommand>) => {
    const command = message.data;

    if (command.type === 'stop') {
        stopped = true;
        return;
    }
    if (command.type !== 'run') return;

    const { request } = command;
    let lastProgress = 0;

    minePatterns({
        bars: unpackBars(request.bars),
        exit: request.exit,
        costs: request.costs,
        maxDepth: request.maxDepth,
        anchor: request.anchor,
        minTrades: request.minTrades,
        nullRuns: request.nullRuns,
        keep: request.keep,
        seed: request.seed,
        riskPct: request.riskPct,
        balance: request.balance,
        shouldStop: () => stopped,
        onProgress: (progress) => {
            const now = Date.now();
            if (progress.done < progress.total && now - lastProgress < PROGRESS_EVERY_MS) return;
            lastProgress = now;
            post({ type: 'progress', progress });
        },
    }).then(
        (result) => post({ type: 'done', result }),
        (err: unknown) => {
            if (err instanceof PatternSearchCancelled) {
                post({ type: 'cancelled' });
                return;
            }
            post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        },
    );
};
