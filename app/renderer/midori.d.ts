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

// Mirrors the `data` namespace preload.cjs exposes via contextBridge — the
// walking skeleton's only IPC surface (see app/electron/preload.cjs).
declare global {
    interface Window {
        midori: {
            data: {
                datasets(): Promise<MidoriDatasetMeta[]>;
                meta(symbol: string): Promise<MidoriDatasetMeta | null>;
                symbols(): Promise<{ symbol: string; base: string; quote: string }[]>;
                bars(query: MidoriBarQuery): Promise<MidoriBar[]>;
            };
        };
    }
}
