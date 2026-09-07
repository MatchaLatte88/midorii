import { runSweep, SweepCancelled } from './sweepRunner';
import { unpackBars, type SweepCommand, type SweepEvent } from './sweepProtocol';

/**
 * The thread a sweep runs on.
 *
 * A sweep is minutes to hours of solid computation. Run on the page's own thread it would
 * hold it for all of that: no repaint, no progress, no Stop button — an application that
 * looks crashed while it works. So it runs here, and the page keeps drawing.
 *
 * It is a worker rather than a main-process job for the same reason the single backtest is
 * not one: the detectors a strategy is built on are TypeScript modules in the chart core,
 * and the main process runs plain JavaScript straight off disk. Duplicating them there is
 * the one thing that must not happen — the chart and the backtest would drift apart about
 * the same market.
 *
 * Stopping is cooperative and has to be. A worker can be terminated outright, but that
 * throws away every combination already finished; the flag here is read between runs, so
 * stopping is quick without losing the work. Reading it at all is what `runSweep`'s pauses
 * between combinations are for — a thread that never yields never sees its own messages.
 */

/** Progress messages, at most this often. One per combination would be a hundred thousand
 *  postMessages for a sweep whose UI can show about ten a second. */
const PROGRESS_EVERY_MS = 100;

let stopped = false;

function post(event: SweepEvent): void {
    self.postMessage(event);
}

self.onmessage = (message: MessageEvent<SweepCommand>) => {
    const command = message.data;

    if (command.type === 'stop') {
        stopped = true;
        return;
    }
    if (command.type !== 'run') return;

    const request = command.request;
    let lastProgress = 0;

    runSweep({
        strategy: request.strategy,
        ranges: request.ranges,
        base: request.base,
        bars: unpackBars(request.bars),
        baseBars: request.baseBars ? unpackBars(request.baseBars) : null,
        from: request.from,
        to: request.to,
        balance: request.balance,
        stepMs: request.stepMs,
        trainFraction: request.trainFraction,
        metric: request.metric,
        minTrades: request.minTrades,
        showCount: request.showCount,
        shouldStop: () => stopped,
        onProgress: (progress) => {
            const now = Date.now();
            // The last one always goes: a bar that stops at 998 of 1000 reads as a hang.
            if (progress.done < progress.total && now - lastProgress < PROGRESS_EVERY_MS) return;
            lastProgress = now;
            post({ type: 'progress', progress });
        },
    }).then(
        (result) => post({ type: 'done', result }),
        (err: unknown) => {
            if (err instanceof SweepCancelled) {
                /* Not an error: someone asked. Its own message so the page can tell "you
                 * stopped it" from "it broke", which a rejection cannot. */
                post({ type: 'cancelled' });
                return;
            }
            post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        },
    );
};
