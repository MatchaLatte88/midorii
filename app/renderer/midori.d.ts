export {};

interface MidoriDatasetMeta {
    symbol: string;
    timeframe: string;
    format: number;
    count: number;
    first: number | null;
    last: number | null;
    barsWithBuyVolume: number;
    updatedAt: string;
    bytes: number;
    /** The venue it was downloaded from. Absent on datasets stored before sources existed. */
    source?: string;
}

/** A venue bars can be downloaded from, and how it spells a market. */
interface MidoriSource {
    id: string;
    label: string;
    example: string;
    naming: string;
}

/** One step of a running download — one archive month, or one page of candles. */
interface MidoriDownloadProgress {
    symbol: string;
    source: string;
    done: number;
    total: number;
    label: string;
}

interface MidoriDownloadResult {
    added: number;
    total: number;
    first: number | null;
    last: number | null;
    withBuyVolume: number;
    /** Months the venue had nothing for — before the listing, or a real gap. */
    missing: string[];
    source: string;
}

interface MidoriBarQuery {
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    dropIncomplete?: boolean;
}

interface MidoriBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    buyVolume: number;
}

/** A paused, unfinished replay — the account and the clock, never the bars. */
interface MidoriSessionRecord {
    id: string;
    name: string;
    symbol: string;
    timeframe: string;
    startTime: number;
    clock: number;
    stats: Record<string, unknown>;
    session: unknown;
}

// Mirrors what preload.cjs exposes via contextBridge (app/electron/preload.cjs).
declare global {
    interface Window {
        midori: {
            data: {
                datasets(): Promise<MidoriDatasetMeta[]>;
                meta(symbol: string): Promise<MidoriDatasetMeta | null>;
                sources(): Promise<MidoriSource[]>;
                symbols(source?: string): Promise<{ symbol: string; base: string; quote: string }[]>;
                bars(query: MidoriBarQuery): Promise<MidoriBar[]>;
                download(request: {
                    symbol: string;
                    source?: string;
                    from: number | string;
                    to: number | string;
                }): Promise<MidoriDownloadResult>;
                /** Returns its own unsubscribe. */
                onDownloadProgress(handler: (p: MidoriDownloadProgress) => void): () => void;
            };
            replay: {
                save(request: Record<string, unknown>): Promise<{ id: string }>;
                saveSession(request: {
                    id?: string | null;
                    name?: string;
                    symbol: string;
                    timeframe: string;
                    session: unknown;
                    stats?: Record<string, unknown>;
                }): Promise<{ id: string }>;
                sessions(): Promise<MidoriSessionRecord[]>;
                loadSession(id: string): Promise<MidoriSessionRecord | null>;
                deleteSession(id: string): Promise<boolean>;
            };
        };
    }
}
