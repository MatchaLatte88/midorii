import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../../../src';
import type { Unsubscribe } from '../../../src/core/util/types';

/** Canonical Vela timeframe → Capital.com resolution — their 8 native bar sizes
 *  (no 2h/3h/6h/8h/12h/month; unlisted timeframes are simply not offered). */
const TF_TO_RESOLUTION: Record<string, string> = {
    '1': 'MINUTE', '5': 'MINUTE_5', '15': 'MINUTE_15', '30': 'MINUTE_30',
    '60': 'HOUR', '240': 'HOUR_4', D: 'DAY', W: 'WEEK',
};
/** User-facing aliases → canonical keys (matches the other providers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '4h': '240', '1d': 'D', '1D': 'D', '1w': 'W', '1W': 'W',
};
const SUPPORTED_TIMEFRAMES = ['1', '5', '15', '30', '60', '240', 'D', 'W'];

/** If a stream opens but delivers no candle within this window, fall back to polling. */
const STREAM_STALL_MS = 15_000;

export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** Capital.com `instrumentType` → Vela's SymbolDescriptor.type taxonomy (the symbol
 *  picker already has Forex/Commodities tabs; this is what feeds them). */
function typeOf(instrumentType: string): string {
    switch (instrumentType) {
        case 'CURRENCIES': return 'forex';
        case 'COMMODITIES': return 'commodity';
        case 'INDICES': return 'index';
        case 'SHARES': return 'stock';
        case 'CRYPTOCURRENCIES': return 'crypto';
        default: return instrumentType.toLowerCase();
    }
}

/**
 * Capital.com forex/CFD provider. Unlike the bundled crypto providers this needs a
 * real account — a Capital.com API key plus login/password (see .env.example) — so
 * it is not a public feed, and it lives here rather than under `src/data/providers/`:
 * the login response carries its session tokens in RESPONSE HEADERS that Capital.com
 * does not expose to cross-origin `fetch` (no `Access-Control-Expose-Headers`), so the
 * whole session has to run in Node (Electron's main process, see
 * app/electron/data/capital.js), not the browser-sandboxed renderer. This class is
 * the thin `DataProvider` adapter over that IPC bridge — it never touches the network
 * itself, and it only runs inside Midorii's own Electron shell.
 *
 *   chart.data.registerProvider('capital', new CapitalProvider());
 */
export class CapitalProvider implements DataProvider {
    private marketsPromise: Promise<SymbolDescriptor[]> | null = null;

    info(): ProviderInfo {
        return {
            name: 'capital',
            displayName: 'Capital.com',
            requiresApiKey: true,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const resolution = TF_TO_RESOLUTION[normalizeTf(timeframe)];
        if (!resolution) {
            console.warn(`[midorii] Capital.com: timeframe "${timeframe}" is not one of its native resolutions (1m/5m/15m/30m/1h/4h/1D/1W).`);
            return [];
        }
        try {
            const bars = await window.midori.capital.prices({ epic: ticker.toUpperCase(), resolution, from: range.from, to: range.to, limit: range.limit });
            return bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
        } catch (e) {
            // Fail soft, same contract as the bundled providers: an empty result
            // parks/empties the chart with a warning rather than rejecting the load.
            console.warn(`[midorii] Capital.com: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.marketsPromise) {
            this.marketsPromise = this.fetchMarkets().catch((e) => {
                console.warn(`[midorii] Capital.com: failed to list markets — ${e instanceof Error ? e.message : String(e)}`);
                return [] as SymbolDescriptor[];
            });
        }
        return this.marketsPromise;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        try {
            const info = await window.midori.capital.marketInfo(ticker.toUpperCase());
            if (!info) return undefined;
            return {
                ticker,
                tickerid: `CAPITAL:${ticker}`,
                prefix: 'CAPITAL',
                description: info.instrument.name,
                type: typeOf(info.instrument.type),
                currency: info.instrument.currency,
                timezone: 'Etc/UTC',
            };
        } catch {
            return undefined; // the engine synthesizes a fallback
        }
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        const resolution = TF_TO_RESOLUTION[normalizeTf(timeframe)];
        // No native resolution (an aggregated timeframe Capital.com doesn't serve) ⇒ poll.
        if (!resolution) return this.pollBars(ticker, timeframe, onBar);
        return this.streamOhlc(ticker.toUpperCase(), timeframe, resolution, onBar);
    }

    // ── internals ────────────────────────────────────────────────────────

    private async fetchMarkets(): Promise<SymbolDescriptor[]> {
        const markets = await window.midori.capital.markets();
        return markets
            .filter((m) => m.streamingPricesAvailable)
            .map((m) => ({ ticker: m.epic, description: m.instrumentName, type: typeOf(m.instrumentType) }));
    }

    /**
     * Subscribe to Capital.com's native `OHLCMarketData` WebSocket stream (relayed
     * through the main process — see app/electron/data/capital.js). A stall watchdog
     * falls back to polling if the socket opens but never delivers a candle;
     * reconnection while subscribed is the main process's job, not this class's.
     */
    private streamOhlc(epic: string, timeframe: string, resolution: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let closed = false;
        let subscriptionId: string | null = null;
        let stall: ReturnType<typeof setTimeout> | null = null;
        let polling: Unsubscribe | null = null;

        const clearStall = (): void => { if (stall) { clearTimeout(stall); stall = null; } };
        const fallToPolling = (): void => {
            if (closed || polling) return;
            clearStall();
            console.warn(`[midorii] Capital.com: ${epic} ${timeframe} stream delivered no data; falling back to polling.`);
            polling = this.pollBars(epic, timeframe, onBar);
        };

        stall = setTimeout(fallToPolling, STREAM_STALL_MS);
        const offOhlc = window.midori.capital.onOhlc(({ subscriptionId: id, bar }) => {
            if (closed || polling || id !== subscriptionId) return;
            clearStall();
            onBar(bar);
        });
        void window.midori.capital.subscribe({ epic, resolution })
            .then((id) => {
                if (closed) { void window.midori.capital.unsubscribe(id); return; }
                subscriptionId = id;
            })
            .catch((e) => {
                console.warn(`[midorii] Capital.com: subscribe failed for ${epic} — ${e instanceof Error ? e.message : String(e)}`);
                fallToPolling();
            });

        return () => {
            closed = true;
            clearStall();
            offOhlc();
            polling?.();
            if (subscriptionId) void window.midori.capital.unsubscribe(subscriptionId);
        };
    }

    /** Poll the forming candle — aggregated timeframes, or a non-delivering stream. */
    private pollBars(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                for (const b of bars) onBar(b);
            } catch { /* transient — keep polling */ }
            if (!stopped) timer = setTimeout(() => void poll(), 3000);
        };
        timer = setTimeout(() => void poll(), 3000);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }
}
