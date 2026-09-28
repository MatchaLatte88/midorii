import { timeframeToMs } from '../../../src';
import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../../../src';
import type { Unsubscribe } from '../../../src/core/util/types';
import type { MidoriCapitalMarketInfo, MidoriCapitalQuote, MidoriCapitalRule } from '../midori';
import { loadHistoryProgressively } from './progressiveHistory';

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
 * What the venue will accept on this instrument, carried on its `SymbolInfo` under
 * `dealing`.
 *
 * None of this is the chart's business — the chart draws candles. It is here because a
 * CFD order is refused for reasons a crypto order never is: a size below the minimum, a
 * size off the increment grid, a stop closer to the market than the venue allows. An
 * order built without these is an order the server rejects, and finding that out from a
 * rejection is finding it out too late.
 *
 * Every field is nullable: Capital.com omits rules that do not apply to an instrument,
 * and a missing rule must read as "unknown", never as "no limit".
 */
export interface CapitalDealing {
    /** Smallest position the venue will open, in instrument units. */
    minSize: number | null;
    /** The grid sizes must sit on — 0.1 means 1.05 is refused. */
    sizeIncrement: number | null;
    maxSize: number | null;
    /** Margin as a share of notional; `marginFactorUnit` says how it is expressed. */
    marginFactor: number | null;
    marginFactorUnit: string | null;
    /** How near and how far a stop or target may sit. The unit rides along because it
     *  is sometimes POINTS and sometimes PERCENTAGE. */
    minStopDistance: MidoriCapitalRule | null;
    maxStopDistance: MidoriCapitalRule | null;
    lotSize: number | null;
    /**
     * The money THIS INSTRUMENT books its results in.
     *
     * Not the account's. A euro account trading a US index books that index's result in
     * dollars and converts it, so the two together are what decide whether a point can be
     * turned into account money without an exchange rate nobody here has — see
     * `CapitalController.pointValue`.
     */
    currency: string | null;
}

/** The instrument's live state — see {@link CapitalProvider.snapshot}. */
export interface CapitalSnapshot {
    /** Capital.com's own word: `TRADEABLE`, `CLOSED`, `EDITS_ONLY`, … */
    status: string;
    tradeable: boolean;
    bid: number;
    ask: number;
}

/** Pull the dealing rules off a market record, keeping "unknown" distinct from "none". */
export function capitalDealingRules(info: MidoriCapitalMarketInfo): CapitalDealing {
    const rules = info.dealingRules;
    return {
        // Sizes come back tagged `POINTS`, which is Capital.com's unit for everything and
        // means "units of the instrument" here. Read as the plain number it is.
        minSize: rules?.minDealSize?.value ?? null,
        sizeIncrement: rules?.minSizeIncrement?.value ?? null,
        maxSize: rules?.maxDealSize?.value ?? null,
        marginFactor: info.instrument.marginFactor ?? null,
        marginFactorUnit: info.instrument.marginFactorUnit ?? null,
        minStopDistance: rules?.minStopOrProfitDistance ?? null,
        maxStopDistance: rules?.maxStopOrProfitDistance ?? null,
        lotSize: info.instrument.lotSize ?? null,
        currency: info.instrument.currency ?? null,
    };
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
        /* A refusal is passed on rather than swallowed. The chart is protected either way —
         * MultiProviderFeed's `safeBars` already turns a rejected load into an empty series
         * and a warning — but everything that calls this directly (the bot's seed, the paper
         * account's catch-up, the poll below) then gets to say WHY there are no bars, rather
         * than being handed an empty array that reads like a quiet market. */
        const bars = await window.midori.capital.prices({ epic: ticker.toUpperCase(), resolution, from: range.from, to: range.to, limit: range.limit });
        return bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
    }

    /**
     * Paint recent history first, then extend it backward in 500-bar segments.
     *
     * Capital's bridge accepts a count-bounded `to`, so every request after the first
     * ends immediately before the oldest confirmed candle. The snapshots therefore only
     * grow at the left edge; nothing already painted moves or disappears. Checking the
     * abort signal between pages also means a newer symbol/timeframe switch leaves at most
     * the one request already on the wire, rather than finishing an obsolete 2000-bar load.
     */
    async getBarsProgressive(
        ticker: string,
        timeframe: string,
        range: BarRange,
        onBatch: (bars: OHLCV[]) => void,
        opts?: { signal?: AbortSignal },
    ): Promise<OHLCV[]> {
        return loadHistoryProgressively({
            range,
            onBatch,
            signal: opts?.signal,
            fetch: (segment) => this.getBars(ticker, timeframe, segment),
        });
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.marketsPromise) {
            /* Only a list that ARRIVED is worth keeping. The first call often lands before
             * the account is connected, and caching that failure would leave the symbol
             * picker empty for the rest of the session — including after the credentials are
             * saved, which is exactly when somebody goes looking for a symbol. */
            this.marketsPromise = this.fetchMarkets().catch((e) => {
                console.warn(`[midorii] Capital.com: failed to list markets — ${e instanceof Error ? e.message : String(e)}`);
                this.marketsPromise = null;
                return [] as SymbolDescriptor[];
            });
        }
        return this.marketsPromise;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        try {
            const info = await window.midori.capital.marketInfo(ticker.toUpperCase());
            if (!info) return undefined;
            /* How many decimals the instrument is QUOTED to — 5 for EURUSD, 2 for an index.
             * The tick follows from it, and with the tick the price axis stops guessing its
             * own precision and `snapToTick` starts having a grid to snap to. Absent (an
             * instrument served without a snapshot) leaves both off rather than guessing: a
             * wrong tick silently moves every level a person drops. */
            const decimals = info.snapshot?.decimalPlacesFactor;
            const mintick = typeof decimals === 'number' && decimals >= 0 ? Math.pow(10, -decimals) : undefined;
            return {
                ticker,
                tickerid: `CAPITAL:${ticker}`,
                prefix: 'CAPITAL',
                description: info.instrument.name,
                type: typeOf(info.instrument.type),
                currency: info.instrument.currency,
                timezone: 'Etc/UTC',
                ...(mintick != null ? { mintick, pricescale: Math.round(1 / mintick) } : {}),
                dealing: capitalDealingRules(info),
            };
        } catch {
            return undefined; // the engine synthesizes a fallback
        }
    }

    /**
     * What the market is doing RIGHT NOW — tradeable or shut, and at what.
     *
     * Deliberately not part of {@link getSymbolInfo}: that answer is cached for the life of
     * the session (see MultiProviderFeed's `symInfoCache`), and a cached `marketStatus` is a
     * lie the moment forex closes on Friday evening. Stock data belongs in the cached
     * record; a state that changes belongs in a call somebody makes when they need it.
     */
    async snapshot(ticker: string): Promise<CapitalSnapshot | null> {
        const info = await window.midori.capital.marketInfo(ticker.toUpperCase());
        const snap = info?.snapshot;
        if (!snap) return null;
        return { status: snap.marketStatus, tradeable: snap.marketStatus === 'TRADEABLE', bid: snap.bid, ask: snap.offer };
    }

    /**
     * Subscribe to live bid/ask ticks for `ticker`.
     *
     * Outside `DataProvider` on purpose — that port is about candles, and nothing in the
     * chart engine has a concept of a two-sided price. This is public for what trades on top
     * of the chart, while {@link subscribe} also consumes it internally to keep the forming
     * candle on the current mid. Historical bars still come from the venue's bid-based OHLC
     * feed (see `rowToBar` in app/electron/data/capital.js), and no amount of that history
     * contains the ask.
     */
    subscribeQuotes(ticker: string, onQuote: (quote: MidoriCapitalQuote) => void): Unsubscribe {
        const epic = ticker.toUpperCase();
        let closed = false;
        let subscriptionId: string | null = null;

        const offQuote = window.midori.capital.onQuote(({ subscriptionId: id, quote }) => {
            if (closed || id !== subscriptionId) return;
            onQuote(quote);
        });
        void window.midori.capital.subscribeQuotes({ epic })
            .then((id) => {
                if (closed) { void window.midori.capital.unsubscribeQuotes(id); return; }
                subscriptionId = id;
            })
            .catch((e) => {
                console.warn(`[midorii] Capital.com: quote subscription failed for ${epic} — ${e instanceof Error ? e.message : String(e)}`);
            });

        return () => {
            closed = true;
            offQuote();
            if (subscriptionId) void window.midori.capital.unsubscribeQuotes(subscriptionId);
        };
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        const resolution = TF_TO_RESOLUTION[normalizeTf(timeframe)];
        const epic = ticker.toUpperCase();
        /* The quote stream is Capital's freshest price: the bid/ask lines already move on
         * every one of its ticks, while the separate OHLC feed can trail for seconds. Fold
         * the same ticks into the forming candle at their midpoint. The OHLC feed remains
         * the baseline (and polling its fallback), so opens, volume, and any movement seen
         * before this subscription began are not invented from one late quote. */
        return this.streamMidpointBars(epic, timeframe, onBar, (emit) => (
            // No native resolution (an aggregated timeframe Capital.com doesn't serve) ⇒ poll.
            resolution
                ? this.streamOhlc(epic, timeframe, resolution, emit)
                : this.pollBars(epic, timeframe, emit)
        ));
    }

    // ── internals ────────────────────────────────────────────────────────

    private async fetchMarkets(): Promise<SymbolDescriptor[]> {
        const markets = await window.midori.capital.markets();
        return markets
            .filter((m) => m.streamingPricesAvailable)
            .map((m) => ({ ticker: m.epic, description: m.instrumentName, type: typeOf(m.instrumentType) }));
    }

    /**
     * Keep one forming bar on the latest bid/ask midpoint.
     *
     * The venue's OHLC and quote subscriptions share a socket but are independent feeds. A
     * quote can therefore arrive before the first candle, or a slower candle can arrive after
     * a newer quote. `midBar` remembers the quote-side facts for one bucket; merging it over
     * every later baseline update prevents that later bid close from pulling the chart back.
     */
    private streamMidpointBars(
        epic: string,
        timeframe: string,
        onBar: (bar: OHLCV) => void,
        subscribeBase: (onBase: (bar: OHLCV) => void) => Unsubscribe,
    ): Unsubscribe {
        const intervalMs = timeframeToMs(normalizeTf(timeframe));
        let baseBar: OHLCV | null = null;
        let midBar: OHLCV | null = null;

        const merged = (base: OHLCV): OHLCV => {
            if (!midBar || midBar.time !== base.time) return base;
            return {
                ...base,
                high: Math.max(base.high, midBar.high),
                low: Math.min(base.low, midBar.low),
                close: midBar.close,
            };
        };

        const stopBase = subscribeBase((bar) => {
            baseBar = bar;
            onBar(merged(bar));
        });
        const stopQuotes = this.subscribeQuotes(epic, (quote) => {
            if (!(quote.bid > 0) || !(quote.ask > 0)) return;
            const mid = (quote.bid + quote.ask) / 2;
            if (!Number.isFinite(mid)) return;

            const at = Number.isFinite(quote.time) && quote.time > 0 ? quote.time : Date.now();
            /* Anchor buckets on the venue's latest candle where possible. This matters for
             * weekly bars: an epoch-based floor starts weeks on Thursday, while the venue's
             * candle tells us its real boundary. */
            const origin = baseBar?.time ?? 0;
            const time = origin + Math.floor((at - origin) / intervalMs) * intervalMs;
            if (midBar && time < midBar.time) return; // a late network packet cannot rewind the chart

            if (!midBar || midBar.time !== time) {
                midBar = { time, open: mid, high: mid, low: mid, close: mid };
            } else {
                midBar = {
                    ...midBar,
                    high: Math.max(midBar.high, mid),
                    low: Math.min(midBar.low, mid),
                    close: mid,
                };
            }

            onBar(baseBar?.time === time ? merged(baseBar) : midBar);
        });

        return () => {
            stopBase();
            stopQuotes();
        };
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
            /* Hand the WS slot back. There are forty of them, and a stream that has said
             * nothing for fifteen seconds is not about to start — holding it would cost a
             * slot for the life of the chart and deliver nothing in return. */
            if (subscriptionId) {
                void window.midori.capital.unsubscribe(subscriptionId);
                subscriptionId = null;
            }
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
                // `polling` as much as `closed`: the watchdog can fire before this id ever
                // arrives, and an id nobody holds is a slot nobody can give back.
                if (closed || polling) { void window.midori.capital.unsubscribe(id); return; }
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
        let complained = false;
        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                /* Re-checked AFTER the await: an unsubscribe during the fetch — a symbol or
                 * timeframe switch — must not push the OLD market's bars into the new series.
                 * On the same timeframe the forming bar shares its open time, so a stale one
                 * would silently REPLACE the new market's candle rather than land beside it. */
                if (stopped) return;
                complained = false;
                for (const b of bars) onBar(b);
            } catch (e) {
                /* Said once per outage rather than every three seconds: a poll that keeps
                 * failing is one fact, not twenty a minute. It keeps polling either way —
                 * the usual cause is a blip and the usual cure is the next attempt. */
                if (!complained) {
                    complained = true;
                    console.warn(`[midorii] Capital.com: polling ${ticker} ${timeframe} failed — ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!stopped) timer = setTimeout(() => void poll(), 3000);
        };
        timer = setTimeout(() => void poll(), 3000);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }
}
