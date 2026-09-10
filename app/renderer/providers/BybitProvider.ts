import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../../../src';
import type { Unsubscribe } from '../../../src/core/util/types';
import type { MidoriBybitCategory, MidoriBybitInstrument } from '../midori';

/**
 * Bybit market data — spot pairs and USDT perpetuals, on one chart.
 *
 * Bybit calls its BTC contract and its BTC pair the same thing and keeps them apart with a
 * category. A chart symbol cannot do that, so this uses the suffix the app already uses for
 * Binance's perpetuals: `BTCUSDT` is the spot pair, `BTCUSDT.P` is the contract. The split
 * itself is made in the main process (`bybitMarket` in app/electron/data/bybit.js); this
 * class only ever passes the ticker along.
 *
 * Here rather than under `src/data/providers/` for the same reason CapitalProvider is: it is
 * Midorii's own venue wiring, not part of the charting library, and it reaches the network
 * only through the main process — which is also what keeps one rate gate over the history
 * download and the live poll, instead of two that do not know about each other.
 *
 * Candles are POLLED, not streamed. Bybit has a public WebSocket and this does not use it
 * yet: a relay for it belongs in the main process beside the Capital.com one, and until that
 * exists a three-second poll is the honest version rather than a pretend stream.
 */

/** Canonical Vela timeframe → Bybit interval. Their vocabulary is minutes, plus D/W/M. */
const TF_TO_INTERVAL: Record<string, string> = {
    '1': '1', '3': '3', '5': '5', '15': '15', '30': '30',
    '60': '60', '120': '120', '240': '240', '360': '360', '720': '720',
    D: 'D', W: 'W', M: 'M',
};
/** User-facing aliases → canonical keys (matches the other providers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1D': 'D', '1w': 'W', '1W': 'W', '1M': 'M',
};
const SUPPORTED_TIMEFRAMES = Object.keys(TF_TO_INTERVAL);

/** How often the forming candle is re-read. */
const POLL_MS = 3_000;

export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** Which of Bybit's two products a ticker names — the renderer's half of `bybitMarket`. */
export function categoryOf(ticker: string): MidoriBybitCategory {
    return ticker.toUpperCase().endsWith('.P') ? 'linear' : 'spot';
}

/** The symbol without the app's own perpetual suffix — what Bybit itself calls the market. */
export function venueSymbol(ticker: string): string {
    const upper = ticker.toUpperCase();
    return upper.endsWith('.P') ? upper.slice(0, -2) : upper;
}

export class BybitProvider implements DataProvider {
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;
    /** Rules already read, so the ticket and the axis do not re-ask on every repaint. */
    private readonly instruments = new Map<string, Promise<MidoriBybitInstrument>>();

    info(): ProviderInfo {
        return {
            name: 'bybit',
            displayName: 'Bybit',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const interval = TF_TO_INTERVAL[normalizeTf(timeframe)];
        if (!interval) {
            console.warn(`[midorii] Bybit: timeframe "${timeframe}" is not one of its native intervals.`);
            return [];
        }
        /* A refusal is passed on rather than swallowed, exactly as CapitalProvider does it:
         * the chart is protected by MultiProviderFeed either way, and everything that calls
         * this directly then gets to say WHY there are no bars instead of being handed an
         * empty array that reads like a quiet market. */
        return window.midori.bybit.klines({
            category: categoryOf(ticker),
            symbol: venueSymbol(ticker),
            interval,
            ...(range.from == null ? {} : { start: range.from }),
            ...(range.to == null ? {} : { end: range.to }),
            ...(range.limit == null ? {} : { limit: range.limit }),
        });
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.symbolsPromise) {
            /* Only a list that ARRIVED is worth keeping — caching a failed first call would
             * leave the picker empty for the rest of the session. */
            this.symbolsPromise = this.fetchSymbols().catch((e: unknown) => {
                console.warn(`[midorii] Bybit: failed to list markets — ${e instanceof Error ? e.message : String(e)}`);
                this.symbolsPromise = null;
                return [] as SymbolDescriptor[];
            });
        }
        return this.symbolsPromise;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        try {
            const info = await this.instrument(ticker);
            const perpetual = info.category === 'linear';
            return {
                ticker,
                tickerid: `BYBIT:${ticker.toUpperCase()}`,
                prefix: 'BYBIT',
                description: perpetual
                    ? `${info.baseAsset}/${info.quoteAsset} perpetual`
                    : `${info.baseAsset}/${info.quoteAsset}`,
                type: 'crypto',
                currency: info.quoteAsset,
                timezone: 'Etc/UTC',
                mintick: info.tickSize,
                pricescale: Math.round(1 / info.tickSize),
            };
        } catch {
            return undefined; // the engine synthesizes a fallback
        }
    }

    /**
     * The venue's own rules for one market, read once per session.
     *
     * Cached as the PROMISE rather than the answer, so two callers arriving in the same tick
     * — the axis wanting a tick size and the ticket wanting a step — make one request between
     * them. A failed read drops out of the cache: the usual cause is a blip, and a market
     * that is permanently unknown fails just as cheaply on the second ask.
     */
    instrument(ticker: string): Promise<MidoriBybitInstrument> {
        const key = ticker.toUpperCase();
        let pending = this.instruments.get(key);
        if (!pending) {
            pending = window.midori.bybit.instrument({ category: categoryOf(key), symbol: venueSymbol(key) });
            pending.catch(() => this.instruments.delete(key));
            this.instruments.set(key, pending);
        }
        return pending;
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let complained = false;

        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                /* Re-checked AFTER the await: an unsubscribe during the fetch — a symbol or
                 * timeframe switch — must not push the old market's bars into the new series.
                 * On the same timeframe the forming bar shares its open time, so a stale one
                 * would silently REPLACE the new market's candle rather than land beside it. */
                if (stopped) return;
                complained = false;
                for (const bar of bars) onBar(bar);
            } catch (e: unknown) {
                // Said once per outage rather than every three seconds.
                if (!complained) {
                    complained = true;
                    console.warn(`[midorii] Bybit: polling ${ticker} ${timeframe} failed — ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
        };

        timer = setTimeout(() => void poll(), POLL_MS);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }

    // ── internals ────────────────────────────────────────────────────────

    private async fetchSymbols(): Promise<SymbolDescriptor[]> {
        /* The same list the download dialog offers, rather than a second call that could
         * disagree with it: one venue, one answer about what it lists. */
        const markets = await window.midori.data.symbols('bybit');
        return markets.map((m) => ({
            ticker: m.symbol,
            description: m.symbol.endsWith('.P')
                ? `${m.base}/${m.quote} perpetual`
                : `${m.base}/${m.quote}`,
            type: 'crypto',
        }));
    }
}
