import { timeframeToMs } from '../../../src';
import type { ReplayBar } from '../../../shared/engine/replaySession.js';

/** Bars of history kept behind the playhead, for context and indicator warmup. */
export const CONTEXT_BARS = 500;
/** Ceiling on the whole preloaded window — a multi-year 1m replay must not eat the heap. */
export const MAX_WINDOW_BARS = 20_000;

/** The bars a session runs on, plus the bar the playhead is standing inside. */
export interface ReplayWindow {
    bars: ReplayBar[];
    /**
     * The bar in progress: the bucket holding the clock, aggregated only from the
     * minutes that have been played. Null when the clock sits exactly on a bar
     * boundary — which is every start, and every switch to a faster timeframe.
     */
    forming: ReplayBar | null;
    /** Bar length, as {@link ReplaySession.rebase} means it. */
    stepMs: number;
}

/**
 * The bar window around a clock: context behind it, room to play in front.
 *
 * Loaded once, up front — the bars come off the local disk over IPC, so there is
 * no network latency to hide behind chunked loading, and one array in memory
 * removes a whole class of async-during-playback bugs.
 *
 * The window is derived from the clock rather than from a bar index, which is
 * what lets the timeframe change underneath a running session: an index means
 * something only against one array, the clock is the same instant on every
 * timeframe.
 */
export async function loadReplayWindow(
    symbol: string,
    timeframe: string,
    clock: number,
): Promise<ReplayWindow> {
    const tfMs = timeframeToMs(timeframe);
    const meta = await window.midori.data.meta(symbol);
    if (!meta || meta.first == null || meta.last == null) {
        throw new Error(`No local data for ${symbol}. Download it first.`);
    }
    const from = Math.max(meta.first, clock - CONTEXT_BARS * tfMs);
    const to = Math.min(meta.last + tfMs, clock + (MAX_WINDOW_BARS - CONTEXT_BARS) * tfMs);
    const bars = await window.midori.data.bars({ symbol, timeframe, from, to, dropIncomplete: false });

    // The bucket the clock is standing in — the last one that has opened.
    let holder: ReplayBar | null = null;
    for (const bar of bars) {
        if (bar.time >= clock) break;
        holder = bar;
    }
    if (holder === null) {
        throw new Error(`No bars before ${new Date(clock).toISOString()} for ${symbol} ${timeframe}.`);
    }

    // Whole bucket already behind the clock ⇒ nothing is in progress. Otherwise ask
    // the store for the same bucket cut off at the clock: the aggregation stops
    // there, so what comes back is the bar as far as it has actually got.
    let forming: ReplayBar | null = null;
    if (holder.time + tfMs > clock) {
        const partial = await window.midori.data.bars({
            symbol, timeframe, from: holder.time, to: clock, dropIncomplete: false,
        });
        forming = partial[partial.length - 1] ?? null;
    }

    return { bars, forming, stepMs: tfMs };
}
