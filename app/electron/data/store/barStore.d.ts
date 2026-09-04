/**
 * Hand-written types for barStore.js — the .js file stays the single source of
 * truth. Only the surface TypeScript callers actually reach for is typed here,
 * the same arrangement as shared/engine.
 */

export interface StoredBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    /** NaN where the source does not report the taker side. */
    buyVolume: number;
}

export interface DatasetMeta {
    symbol: string;
    timeframe: string;
    format: number;
    count: number;
    first: number | null;
    last: number | null;
    barsWithBuyVolume: number;
    updatedAt: string;
    source?: string;
}

/** Doubles per bar in the flat on-disk layout. */
export declare const STRIDE: number;
export declare const BASE_TIMEFRAME: string;
export declare const FORMAT_VERSION: number;
/** The timeframes Midorii's own UI names — a menu, not the limit of what is served. */
export declare const TIMEFRAMES: Record<string, number>;

/** A bucket rule: a fixed length in `ms`, or a count of calendar `months`. */
export interface TimeframeSpec {
    ms: number | null;
    months: number;
}

/** Parse a timeframe in either dialect. Throws on anything it cannot bucket exactly. */
export declare function parseTimeframe(tf: string): TimeframeSpec;
/** Bar length in ms; a calendar month reports a nominal 30 days. */
export declare function timeframeMs(tf: string): number;
/** The start of the bucket holding `t`, on the edges the market reads. */
export declare function bucketStart(t: number, spec: TimeframeSpec): number;
/** The instant the bucket starting at `start` ends. */
export declare function bucketEnd(start: number, spec: TimeframeSpec): number;

/** Fold base-timeframe bars into `tf`. */
export declare function aggregate(
    data: Float64Array,
    from: number,
    to: number,
    tf: string,
    dropIncomplete?: boolean,
): StoredBar[];

export declare function readBars(
    dataDir: string,
    symbol: string,
    tf: string,
    from: number,
    to: number,
    dropIncomplete?: boolean,
): Promise<StoredBar[]>;

export declare function readMeta(dataDir: string, symbol: string): Promise<DatasetMeta | null>;
export declare function listDatasets(dataDir: string): Promise<DatasetMeta[]>;
export declare function mergeBars(
    dataDir: string,
    symbol: string,
    bars: Array<Partial<StoredBar> & { time: number }>,
    extraMeta?: Record<string, unknown>,
): Promise<{ added: number; total: number; first: number | null; last: number | null; withBuyVolume: number }>;
