import { timeframeToMs } from '../../../src';
import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor } from '../../../src';

/** Timeframes barStore.js knows how to serve — see electron/data/store/barStore.js TIMEFRAMES. */
const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

/**
 * Bridges Vela's DataProvider port to Midori's local bar store over the
 * Electron IPC bridge (`window.midori.data.*`, see app/electron/preload.cjs).
 *
 * Serves ONLY symbols already downloaded to disk — no network call. Errors are
 * thrown, never swallowed into an empty array: an empty result for local data
 * would be a real bug (a missing dataset, a bad timeframe), not something to
 * paper over the way a flaky network provider might.
 */
export class LocalArchiveProvider implements DataProvider {
    info(): ProviderInfo {
        return {
            name: 'local',
            displayName: 'Local archive',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: false, symbolInfo: false },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const meta = await window.midori.data.meta(ticker);
        if (!meta) throw new Error(`No local data for ${ticker}. Download it first.`);

        const to = range.to ?? Date.now();
        // Vela's initial load often asks only for { limit }, with no `from` —
        // the IPC boundary requires both as finite numbers, so synthesize one,
        // clamped to what the dataset actually covers.
        const from = range.from ?? Math.max(meta.first ?? to, to - (range.limit ?? 500) * timeframeToMs(timeframe));

        const bars = await window.midori.data.bars({ symbol: ticker, timeframe, from, to, dropIncomplete: false });
        return bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        const datasets = await window.midori.data.datasets();
        return datasets.map((m) => ({ ticker: m.symbol, description: m.symbol, type: 'crypto' }));
    }
}
