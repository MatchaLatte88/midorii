/**
 * Hand-written types for csv.js — reading market data out of a file.
 * The .js file stays the single source of truth (it carries the full reasoning).
 */

/** Which columns hold what. `null` where the file has nothing for that field; `date` and
 *  `clock` are the split-timestamp case, joined back together at parse time. */
export interface CsvMapping {
    time: number | null;
    date: number | null;
    clock: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    buyVolume: number | null;
}

/** Which of two ambiguous numbers in `03/04/2024` is the day. */
export type CsvDateStyle = 'mdy' | 'dmy' | 'ymd';

/** A bar as the file produced it. `buyVolume` is NaN where the file does not record it —
 *  which is not the same as nobody having bought. */
export interface CsvBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    buyVolume: number;
}

export interface CsvSettings {
    delimiter?: string;
    hasHeader?: boolean;
    mapping?: CsvMapping;
    dateStyle?: CsvDateStyle;
    /** An IANA zone name. Naive timestamps are read as wall-clock time in it, DST and
     *  all; an epoch number ignores it, being absolute already. */
    timeZone?: string;
}

/** What the sniffer believes about a file, as a proposal the caller may correct. */
export interface CsvInspection {
    delimiter: string;
    hasHeader: boolean;
    headers: string[];
    mapping: CsvMapping;
    dateStyle: CsvDateStyle;
    /** False when the timestamps are epoch numbers, which carry their own clock. */
    needsTimeZone: boolean;
    /** Fields the file has no column for. Non-empty means it cannot be imported as is. */
    missing: string[];
    sample: string[][];
    columnCount: number;
    /** The field order a headerless file is read in, or null when it has a header. */
    positional: string[] | null;
}

export interface CsvParseResult {
    bars: CsvBar[];
    /** Rows that could not be read as a bar. A handful is a footer or a blank price; half
     *  the file is the wrong delimiter, and the caller has to be able to tell. */
    skipped: number;
    rows: number;
    /** The bar length the file settles on, or null when it settles on none. */
    intervalMs: number | null;
    firstError: string | null;
}

/** The clocks the import dialog offers. Anything Intl accepts works. */
export declare const CSV_TIME_ZONES: ReadonlyArray<{ value: string; label: string }>;

export declare function splitRow(line: string, delimiter: string): string[];
export declare function mapColumns(headers: readonly string[]): CsvMapping;
export declare function missingFields(mapping: CsvMapping): string[];
export declare function sniffDateStyle(samples: readonly string[]): CsvDateStyle;

/** A timestamp reader for one set of settings: the raw cell (plus a separate clock cell,
 *  where the file splits them) to epoch ms, or NaN when it is not a timestamp. */
export declare function makeTimeReader(
    settings?: { dateStyle?: CsvDateStyle; timeZone?: string },
): (raw: string, clock?: string) => number;

/** Reads the head of a file and reports what it believes about it. A forced delimiter or
 *  header flag overrules the guess, and everything else follows from it. */
export declare function sniffCsv(
    text: string,
    forced?: { delimiter?: string; hasHeader?: boolean },
): CsvInspection;

/** Turns a whole file into bars under settings that have nothing left to guess. */
export declare function parseMarketCsv(text: string, settings?: CsvSettings): CsvParseResult;

/** How long one bar is, as the gap that occurs most often. Null when the bars agree on
 *  no interval at all. */
export declare function dominantInterval(bars: readonly { time: number }[]): number | null;
