import type { BarRange, OHLCV } from '../../../src';

/** The visible unit of work for venue history loads. */
export const HISTORY_SEGMENT_BARS = 500;

export interface ProgressiveHistoryOptions {
    range: BarRange;
    onBatch: (bars: OHLCV[]) => void;
    signal?: AbortSignal;
    fetch: (range: BarRange) => Promise<OHLCV[]>;
    firstRange?: (limit: number, original: BarRange) => BarRange;
    olderRange?: (oldest: number, limit: number, original: BarRange) => BarRange;
}

/**
 * Fetch the newest history segment first, then grow the confirmed series leftward.
 * Each emitted snapshot is cumulative and keeps every candle already shown. The final
 * segment is returned rather than emitted twice because the chart paints the resolved
 * answer itself.
 */
export async function loadHistoryProgressively(opts: ProgressiveHistoryOptions): Promise<OHLCV[]> {
    const { range, onBatch, signal, fetch } = opts;
    if (signal?.aborted) return [];
    // A from-bounded request names a specific window; it is not an initial chart depth.
    if (range.from != null) return fetch(range);

    const requested = range.limit ?? HISTORY_SEGMENT_BARS;
    if (requested <= 0) return [];
    const firstSize = Math.min(requested, HISTORY_SEGMENT_BARS);
    let confirmed = await fetch(opts.firstRange?.(firstSize, range) ?? { ...range, limit: firstSize });
    if (signal?.aborted || confirmed.length < firstSize || confirmed.length >= requested) return confirmed;
    onBatch(confirmed);

    while (confirmed.length < requested) {
        if (signal?.aborted) return confirmed;
        const segmentSize = Math.min(HISTORY_SEGMENT_BARS, requested - confirmed.length);
        const oldest = confirmed[0]!.time;
        const next = opts.olderRange?.(oldest, segmentSize, range) ?? {
            ...(range.session !== undefined ? { session: range.session } : {}),
            to: oldest - 1,
            limit: segmentSize,
        };
        const segment = await fetch(next);
        const older = segment.filter((bar) => bar.time < oldest).sort((a, b) => a.time - b.time);
        if (older.length === 0) return confirmed;
        confirmed = [...older, ...confirmed].slice(-requested);
        if (signal?.aborted || confirmed.length >= requested || segment.length < segmentSize) return confirmed;
        onBatch(confirmed);
    }
    return confirmed;
}
