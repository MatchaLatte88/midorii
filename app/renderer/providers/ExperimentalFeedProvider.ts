import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../../../src';
import type { Unsubscribe } from '../../../src/core/util/types';

const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
    '1h': '60', '2h': '120', '3h': '180', '4h': '240',
    '1d': 'D', '1D': 'D', '1w': 'W', '1W': 'W', '1M': 'M',
};
const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'] as const;
const STREAM_STALL_MS = 20_000;
const POLL_MS = 5_000;

export function normalizeExperimentalTimeframe(timeframe: string): string {
    return TF_NORMALIZE[timeframe] ?? TF_NORMALIZE[timeframe.toLowerCase()] ?? timeframe;
}

function searchTerm(query: string): string {
    return query.trim().replace(/^experimental:/i, '');
}

/** Anonymous, opt-in global market data for the interactive chart only. */
export class ExperimentalFeedProvider implements DataProvider {
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;

    info(): ProviderInfo {
        return {
            name: 'experimental',
            displayName: 'Experimental global feed',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const resolution = normalizeExperimentalTimeframe(timeframe);
        if (!SUPPORTED_TIMEFRAMES.includes(resolution as typeof SUPPORTED_TIMEFRAMES[number])) {
            console.warn(`[midorii] Experimental feed: timeframe "${timeframe}" is not supported.`);
            return [];
        }
        return window.midori.experimentalFeed.bars({
            symbol: ticker,
            timeframe: resolution,
            ...(range.from == null ? {} : { from: range.from }),
            ...(range.to == null ? {} : { to: range.to }),
            ...(range.limit == null ? {} : { limit: range.limit }),
            ...(range.session == null ? {} : { session: range.session }),
        });
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.symbolsPromise) {
            this.symbolsPromise = this.searchSymbols('').catch((error: unknown) => {
                console.warn(`[midorii] Experimental feed: symbol index failed — ${error instanceof Error ? error.message : String(error)}`);
                this.symbolsPromise = null;
                return [];
            });
        }
        return this.symbolsPromise;
    }

    searchSymbols(query: string): Promise<SymbolDescriptor[]> {
        return window.midori.experimentalFeed.search(searchTerm(query));
    }

    getSymbolInfo(ticker: string): Promise<SymbolInfo> {
        return window.midori.experimentalFeed.symbolInfo(ticker);
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void, opts?: { session?: string }): Unsubscribe {
        const resolution = normalizeExperimentalTimeframe(timeframe);
        let closed = false;
        let subscriptionId: string | null = null;
        let stall: ReturnType<typeof setTimeout> | null = null;
        let polling: Unsubscribe | null = null;

        const clearStall = (): void => {
            if (!stall) return;
            clearTimeout(stall);
            stall = null;
        };
        const armStall = (): void => {
            clearStall();
            stall = setTimeout(fallToPolling, STREAM_STALL_MS);
        };
        const fallToPolling = (): void => {
            if (closed || polling) return;
            clearStall();
            if (subscriptionId) {
                void window.midori.experimentalFeed.unsubscribe(subscriptionId);
                subscriptionId = null;
            }
            polling = this.pollBars(ticker, timeframe, onBar, opts?.session);
        };

        armStall();
        const offBar = window.midori.experimentalFeed.onBar(({ subscriptionId: id, bar }) => {
            if (closed || polling || id !== subscriptionId) return;
            armStall();
            onBar(bar);
        });
        void window.midori.experimentalFeed.subscribe({ symbol: ticker, timeframe: resolution, session: opts?.session })
            .then((id) => {
                if (closed || polling) {
                    void window.midori.experimentalFeed.unsubscribe(id);
                    return;
                }
                subscriptionId = id;
            })
            .catch((error: unknown) => {
                console.warn(`[midorii] Experimental feed: subscription failed — ${error instanceof Error ? error.message : String(error)}`);
                fallToPolling();
            });

        return () => {
            closed = true;
            clearStall();
            offBar();
            polling?.();
            if (subscriptionId) void window.midori.experimentalFeed.unsubscribe(subscriptionId);
        };
    }

    private pollBars(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void, session?: string): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let complained = false;
        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2, session });
                if (stopped) return;
                complained = false;
                for (const bar of bars) onBar(bar);
            } catch (error: unknown) {
                if (!complained) {
                    complained = true;
                    console.warn(`[midorii] Experimental feed: polling failed — ${error instanceof Error ? error.message : String(error)}`);
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
}
