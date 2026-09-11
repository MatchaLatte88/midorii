import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '../../../src';
import type { Unsubscribe } from '../../../src/core/util/types';
import type { MidoriProjectXContract, MidoriProjectXQuote } from '../midori';

/** Canonical Vela timeframe → nothing of its own: the gateway's unit pair is worked out in
 *  the main process (see app/electron/data/projectx.js). This is only what it will accept. */
const SUPPORTED_TIMEFRAMES = ['15S', '30S', '1', '5', '15', '30', '60', '240', 'D', 'W'];
/** User-facing aliases → canonical keys (matches the other providers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '4h': '240', '1d': 'D', '1D': 'D', '1w': 'W', '1W': 'W',
};

/**
 * A timeframe in the spelling the bridge expects.
 *
 * Seconds are upper-cased rather than table-mapped: the picker already canonicalises a
 * typed `S` to `30S` (src/widget/timeframe.ts), so the only variation left to absorb is
 * somebody typing it in lower case.
 */
export function normalizeTf(timeframe: string): string {
    const tf = timeframe.trim();
    if (/^\d+s$/i.test(tf)) return tf.toUpperCase();
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/**
 * A dated futures contract's name, split into the product and the expiry it belongs to.
 *
 * `NQU6` is September 2026 of the NQ product; `MNQU6` is the same month of a different
 * product. The month letters are the exchange's own (F=January through Z=December), and the
 * year is one or two digits depending on the venue. Written non-greedy so the SHORTEST
 * leading product that still leaves a valid month+year wins — otherwise `MNQU6` would be
 * read as product `M`, month `N`, and a year of `QU6` that does not parse.
 */
const CONTRACT_CODE = /^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/;

/** The product root of a contract name — `NQU6` → `NQ`. Null where the name is not a
 *  dated code at all, which is not an error: a venue may list something else. */
export function rootOf(name: string): string | null {
    const match = CONTRACT_CODE.exec(name.toUpperCase());
    return match ? match[1]! : null;
}

/**
 * The exchange product a contract belongs to, for grouping and session vocabulary.
 *
 * Taken from `symbolId` (`F.US.ENQ` → `ENQ`) rather than the name, because that is the
 * venue's own identity for the product and is stable across expiries. Only used to tell
 * markets apart — an index future and a natural-gas future keep different hours.
 */
function marketOf(contract: MidoriProjectXContract): string | undefined {
    const parts = contract.symbolId?.split('.');
    return parts && parts.length ? parts[parts.length - 1] : undefined;
}

/**
 * What the venue will accept on this contract, carried on its `SymbolInfo` under `dealing`.
 *
 * Futures are sized in whole contracts and priced in ticks, and a position's worth is ticks
 * moved times the value of a tick — so neither number is optional the way a CFD's lot size
 * is. A ticket built without them is a ticket that reports the wrong money.
 */
export interface ProjectXDealing {
    /** The gateway's own id, which every order and subscription is addressed by. */
    contractId: string;
    tickSize: number;
    /** Currency per tick, per contract. */
    tickValue: number;
    /** Futures trade in whole contracts; there is no fractional size. */
    minSize: number;
    sizeStep: number;
}

/**
 * Decimal places needed to write `tick` exactly — the same rule the price axis applies to
 * `mintick` (see src/renderers/native/chrome/ticks.ts).
 *
 * Repeated here rather than imported because it is a property of the NUMBER, and this
 * provider needs it before any renderer is involved: futures ticks are routinely not powers
 * of ten (0.25 on the index futures, 1/64 = 0.015625 on the long bond, 0.0000005 on the
 * yen), and `pricescale` means "steps per unit at the quoted precision" — ten to the power
 * of the decimals, never one over the tick. Computed the naive way, a quarter-point tick
 * would claim a price scale of 4.
 */
function tickDecimals(tick: number): number {
    if (!(tick > 0) || !Number.isFinite(tick)) return 2;
    for (let d = 0; d <= 8; d += 1) {
        if (Math.abs(Number(tick.toFixed(d)) - tick) <= tick * 1e-6) return d;
    }
    return 8;
}

export function projectXDealing(contract: MidoriProjectXContract): ProjectXDealing {
    return {
        contractId: contract.id,
        tickSize: contract.tickSize,
        tickValue: contract.tickValue,
        minSize: 1,
        sizeStep: 1,
    };
}

/**
 * ProjectX futures provider.
 *
 * Like {@link CapitalProvider} this is a thin `DataProvider` adapter over an IPC bridge
 * rather than a network client: the session, the SignalR socket and the tick-to-bar
 * aggregation all live in the main process (app/electron/data/projectx.js), because the
 * bearer token must not reach the renderer and because the forming candle has to be built
 * from the tape — the market hub streams trades and quotes, and no candle feed at all.
 *
 * Two ways to name a contract, both resolved here
 * ----------------------------------------------
 * The gateway addresses everything by a dated id (`CON.F.US.ENQ.U26`), which nobody wants
 * to type. So a ticker may be:
 *
 *   `NQU6`   the venue's own short name — one expiry, unambiguous, what the index lists
 *   `NQ`     the product root — resolves to whichever expiry is currently active
 *   `CON.…`  the raw gateway id, for anything holding one already
 *
 * The index offers the dated names rather than the roots, so a chart left open across a
 * rollover keeps showing the contract it was opened on instead of silently becoming a
 * different instrument. The root is a convenience for typing, and `SymbolDescriptor.group`
 * is what folds the expiries back together in a picker.
 *
 *   chart.data.registerProvider('projectx', new ProjectXProvider());
 */
export class ProjectXProvider implements DataProvider {
    /** Every contract seen so far, by upper-cased name AND by id. */
    private readonly byKey = new Map<string, MidoriProjectXContract>();
    /** Product root → its contracts, newest listing order preserved. */
    private readonly byRoot = new Map<string, MidoriProjectXContract[]>();
    private contractsPromise: Promise<SymbolDescriptor[]> | null = null;

    info(): ProviderInfo {
        return {
            name: 'projectx',
            displayName: 'ProjectX',
            requiresApiKey: true,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const tf = normalizeTf(timeframe);
        if (!SUPPORTED_TIMEFRAMES.includes(tf)) {
            console.warn(`[midorii] ProjectX: timeframe "${timeframe}" is not one it serves (1m/5m/15m/30m/1h/4h/1D/1W).`);
            return [];
        }
        const contract = await this.resolve(ticker);
        if (!contract) {
            console.warn(`[midorii] ProjectX: no contract matches "${ticker}".`);
            return [];
        }
        /* A refusal is passed on rather than swallowed — the chart is protected either way
         * (MultiProviderFeed turns a rejected load into an empty series and a warning), and
         * everything calling this directly then gets to say WHY there are no bars instead of
         * being handed an empty array that reads like a quiet market. */
        const bars = await window.midori.projectx.bars({
            contractId: contract.id, timeframe: tf, from: range.from, to: range.to, limit: range.limit,
        });
        return bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.contractsPromise) {
            /* Only a list that ARRIVED is worth keeping. The first call often lands before
             * the account is connected, and caching that failure would leave the picker empty
             * for the rest of the session — including after the credentials are saved, which
             * is exactly when somebody goes looking for a symbol. */
            this.contractsPromise = this.fetchContracts().catch((e) => {
                console.warn(`[midorii] ProjectX: failed to list contracts — ${e instanceof Error ? e.message : String(e)}`);
                this.contractsPromise = null;
                return [] as SymbolDescriptor[];
            });
        }
        return this.contractsPromise;
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        try {
            const contract = await this.resolve(ticker);
            if (!contract) return undefined;
            /* The tick is the venue's own, not a guess from the quoted decimals: futures are
             * quoted in ticks that are not always a power of ten (crude oil moves in 0.01,
             * the 10-year note in 1/64ths), so deriving one from decimal places would put a
             * grid under the price axis that the market does not actually trade on. */
            const { tickSize } = contract;
            const usable = typeof tickSize === 'number' && tickSize > 0;
            return {
                ticker: contract.name,
                tickerid: `PROJECTX:${contract.name}`,
                prefix: 'PROJECTX',
                description: contract.description,
                type: 'futures',
                currency: 'USD',
                timezone: 'Etc/UTC',
                ...(usable ? { mintick: tickSize, pricescale: Math.pow(10, tickDecimals(tickSize)) } : {}),
                dealing: projectXDealing(contract),
            };
        } catch {
            return undefined; // the engine synthesizes a fallback
        }
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        const tf = normalizeTf(timeframe);
        let closed = false;
        let subscriptionId: string | null = null;

        const offBar = window.midori.projectx.onBar(({ subscriptionId: id, bar }) => {
            if (closed || id !== subscriptionId) return;
            onBar(bar);
        });

        void this.resolve(ticker)
            .then((contract) => {
                if (closed) return;
                if (!contract) throw new Error(`no contract matches "${ticker}"`);
                return window.midori.projectx.subscribe({ contractId: contract.id, timeframe: tf })
                    .then((id) => {
                        if (closed) { void window.midori.projectx.unsubscribe(id); return; }
                        subscriptionId = id;
                    });
            })
            .catch((e) => {
                /* Reported and left at that. There is deliberately no fall back to polling
                 * here, unlike the Capital.com provider: this feed is the TAPE, and a quiet
                 * stretch on it is a market where nothing traded, not a stream that died.
                 * A watchdog counting silence would switch a working subscription over to
                 * polling every time the market went still. */
                console.warn(`[midorii] ProjectX: subscribe failed for ${ticker} — ${e instanceof Error ? e.message : String(e)}`);
            });

        return () => {
            closed = true;
            offBar();
            if (subscriptionId) void window.midori.projectx.unsubscribe(subscriptionId);
        };
    }

    /**
     * Subscribe to live quotes for `ticker`.
     *
     * Outside `DataProvider` on purpose — that port is about candles, and nothing in the
     * chart engine has a concept of a two-sided price. This is here for what trades on top
     * of the chart: the bars are built from prints, so the bid and the ask are the only
     * things that say what a trade would actually cost, and no amount of history holds them.
     */
    subscribeQuotes(ticker: string, onQuote: (quote: MidoriProjectXQuote) => void): Unsubscribe {
        let closed = false;
        let subscriptionId: string | null = null;

        const offQuote = window.midori.projectx.onQuote(({ subscriptionId: id, quote }) => {
            if (closed || id !== subscriptionId) return;
            onQuote(quote);
        });

        void this.resolve(ticker)
            .then((contract) => {
                if (closed) return;
                if (!contract) throw new Error(`no contract matches "${ticker}"`);
                return window.midori.projectx.subscribeQuotes({ contractId: contract.id })
                    .then((id) => {
                        if (closed) { void window.midori.projectx.unsubscribeQuotes(id); return; }
                        subscriptionId = id;
                    });
            })
            .catch((e) => {
                console.warn(`[midorii] ProjectX: quote subscription failed for ${ticker} — ${e instanceof Error ? e.message : String(e)}`);
            });

        return () => {
            closed = true;
            offQuote();
            if (subscriptionId) void window.midori.projectx.unsubscribeQuotes(subscriptionId);
        };
    }

    /** The contract behind a ticker, or null. Public because the trading side addresses
     *  the venue by contract id and has the same three spellings to resolve. */
    async resolve(ticker: string): Promise<MidoriProjectXContract | null> {
        const key = ticker.trim().toUpperCase();
        if (!key) return null;

        const cached = this.lookup(key);
        if (cached) return cached;

        /* Not known yet. The index is the cheaper of the two ways to learn — one call for
         * every contract — so it is tried first and the targeted search is the fallback for
         * a venue where listing is not available. */
        await this.listSymbols();
        const indexed = this.lookup(key);
        if (indexed) return indexed;

        try {
            this.remember(await window.midori.projectx.contracts(key));
        } catch (e) {
            console.warn(`[midorii] ProjectX: contract search for "${key}" failed — ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
        return this.lookup(key);
    }

    // ── internals ────────────────────────────────────────────────────────

    /** A contract by exact name, by gateway id, or by product root. */
    private lookup(key: string): MidoriProjectXContract | null {
        const exact = this.byKey.get(key);
        if (exact) return exact;
        const group = this.byRoot.get(key);
        if (!group?.length) return null;
        /* The active expiry is the one a root means TODAY. Falling back to the first listed
         * rather than to nothing: a venue that has stopped marking any contract active is
         * still serving them, and a chart is better off on a stale expiry it can name than
         * on nothing at all. */
        return group.find((c) => c.activeContract) ?? group[0]!;
    }

    private remember(contracts: readonly MidoriProjectXContract[]): void {
        for (const contract of contracts) {
            this.byKey.set(contract.name.toUpperCase(), contract);
            this.byKey.set(contract.id.toUpperCase(), contract);
            const root = rootOf(contract.name);
            if (!root) continue;
            const group = this.byRoot.get(root);
            if (group) {
                /* Replaced rather than appended on a second sighting — a re-listing carries
                 * the venue's newer answer about which expiry is active. */
                const at = group.findIndex((c) => c.id === contract.id);
                if (at >= 0) group[at] = contract;
                else group.push(contract);
            } else {
                this.byRoot.set(root, [contract]);
            }
        }
    }

    private async fetchContracts(): Promise<SymbolDescriptor[]> {
        const contracts = await window.midori.projectx.availableContracts();
        this.remember(contracts);
        /* `default` is "at most one per group" (see SymbolDescriptor), and `activeContract`
         * is not promised to be exclusive within a product — a venue listing two live
         * expiries of the same root would otherwise mark both, and a picker would have no
         * defined answer for which one the product itself loads. So the flag is claimed
         * once per root, by the first active expiry the venue lists. */
        const claimed = new Set<string>();
        return contracts.map((contract) => {
            const root = rootOf(contract.name);
            const isDefault = contract.activeContract && (root == null || !claimed.has(root));
            if (isDefault && root != null) claimed.add(root);
            const market = marketOf(contract);
            return {
                ticker: contract.name,
                description: contract.description,
                type: 'futures',
                ...(root ? { group: root } : {}),
                /* The active expiry is what a picker loads when the product is picked as a
                 * whole — the one a person means by "NQ" without saying which month. */
                ...(isDefault ? { default: true } : {}),
                ...(market ? { market } : {}),
            } satisfies SymbolDescriptor;
        });
    }
}
