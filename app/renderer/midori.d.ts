export {};

/** One dataset in the library, as the import dialog and the backtest form read it. */
export interface MidoriCsvMapping {
    /** The single timestamp column, or null when the file splits it in two. */
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
export type MidoriCsvDateStyle = 'mdy' | 'dmy' | 'ymd';

/** What the picker believes about a file, and what the dialog lets someone correct. */
export interface MidoriCsvInspection {
    /** The absolute path, handed back to `importCsv`. The renderer never opens it. */
    file: string;
    /** Every file the picker returned, this one first — a large export usually arrives as
     *  a set of parts, and they are read as one series under these settings. */
    files?: string[];
    name: string;
    bytes: number;
    timeZones: ReadonlyArray<{ value: string; label: string }>;
    delimiter: string;
    hasHeader: boolean;
    headers: string[];
    mapping: MidoriCsvMapping;
    dateStyle: MidoriCsvDateStyle;
    /** False when the timestamps are epoch numbers, which carry their own clock. */
    needsTimeZone: boolean;
    /** Fields the file has no column for. Non-empty means it cannot be imported as is. */
    missing: string[];
    sample: string[][];
    columnCount: number;
    /** The field order a headerless file is read in, or null when it has a header. */
    positional: string[] | null;
    /** The clock the dialog is currently reading naive timestamps in. */
    timeZone: string;
    /** The first few rows as the import would store them — the only way to see whether
     *  the date style and the time zone are right. */
    preview: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    /** Why the preview is empty, when it is. Shown rather than thrown. */
    previewError: string | null;
}

export interface MidoriCsvImportResult {
    symbol: string;
    timeframe: string;
    intervalMs: number;
    added: number;
    total: number;
    first: number | null;
    last: number | null;
    withBuyVolume: number;
    /** Rows that could not be read as a bar — a footer, or the wrong delimiter. */
    skipped: number;
    rows: number;
    firstError: string | null;
    /** How many files were read into this dataset. */
    files: number;
}

/** What a range costs before a backtest can run on it. */
export interface MidoriEnsureResult {
    symbol: string;
    source: string;
    /** Bars this call had to fetch — zero when the archive already had the range. */
    added: number;
    total: number;
    first: number | null;
    last: number | null;
    /** Months the venue had nothing for — before the listing, or a real gap. */
    missing: string[];
}

/** One swept parameter: an inclusive range walked in fixed steps. */
export interface MidoriSweepRange {
    from: number;
    to: number;
    step: number;
}

/** The figures kept for every combination of a sweep — thousands of these, so no trades. */
export interface MidoriSweepStats {
    tradeCount: number;
    netPnl: number;
    returnPct: number;
    winRate: number | null;
    maxDrawdownPct: number;
    profitFactor: number | null;
    expectancy: number | null;
    feesPaid: number;
}

/** One combination and what it did. `outOfSample` is filled in only for the few re-run
 *  on the stretch that had no say in the ranking. */
export interface MidoriSweepEntry {
    params: Record<string, unknown>;
    stats: MidoriSweepStats;
    outOfSample?: MidoriSweepStats | null;
}

/** A sweep as the library lists it. */
export interface MidoriSweepSummary {
    id: string;
    createdAt: number;
    strategy: string;
    strategyName: string;
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    metric: string;
    minTrades: number;
    combinationCount: number;
    rankedCount: number;
    /** Which parameters were varied — what the row is actually about. */
    sweptKeys: string[];
    /** The winner. Null when nothing cleared the trade floor. */
    best: MidoriSweepEntry | null;
    cancelled: boolean;
    note: string;
}

/** A sweep in full, with its ranked surface. `best` widens from the index's single
 *  winner to the whole head of the ranking, which is why the summary's is left behind. */
export interface MidoriSweep extends Omit<MidoriSweepSummary, 'best'> {
    best: MidoriSweepEntry[];
    ranges: Record<string, MidoriSweepRange>;
    /** The settings every combination shared. */
    base: Record<string, unknown>;
    balance: number;
    trainFraction: number;
    split: {
        train: { from: number; to: number };
        test: { from: number; to: number };
        trainBars: number;
        testBars: number;
    } | null;
    excludedCount: number;
    results: MidoriSweepEntry[];
    /** True when the middle of the ranking was dropped to keep the file readable. */
    resultsTruncated?: boolean;
    worst: MidoriSweepEntry[];
    overlapping: boolean;
    elapsedMs: number;
    resolution: 'intrabar' | 'pessimistic';
}

export interface MidoriDatasetMeta {
    symbol: string;
    timeframe: string;
    format: number;
    count: number;
    first: number | null;
    last: number | null;
    barsWithBuyVolume: number;
    updatedAt: string;
    bytes: number;
    /** The venue it was downloaded from, or `'csv'` for an import. Absent on datasets
     *  stored before sources existed. */
    source?: string;
    /** How long one stored bar is. A minute for anything downloaded; whatever the file
     *  carried for an import. Absent on datasets stored before imports existed. */
    baseMs?: number;
    /** The file an import came from, for the library view. */
    importedFrom?: string;
    importedAt?: string;
}

/** A venue bars can be downloaded from, and how it spells a market. */
export interface MidoriSource {
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

export interface MidoriBar {
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

/** The figures every finished run reports, whoever traded it. `null` where the account
 *  gave no honest answer — no trades means no win rate, and 0% would read as "always lost". */
export interface MidoriRunStats {
    initialBalance: number;
    finalEquity: number;
    netPnl: number;
    /** A fraction, not a percentage: 0.12 is +12%. */
    returnPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    /** Null when nothing lost — an infinite factor is real but does not belong in a sum. */
    profitFactor: number | null;
    expectancy: number | null;
    feesPaid: number;
    barCount: number;
    equityPoints: number;
}

/** One closed round trip. */
export interface MidoriTrade {
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    pnl: number;
    fees: number;
    netPnl: number;
    entryTag: string | null;
    exitTag: string | null;
    stopLoss: number | null;
    takeProfit: number | null;
    /** What the trade risked per unit when it was opened, so its result can be read in R. */
    riskPerUnit: number | null;
}

/** One point of the stored equity curve. Condensed on the way in: the first point, the last,
 *  and every point where the realised balance moved. */
export interface MidoriEquityPoint {
    time: number;
    equity: number;
    balance: number;
    drawdown: number;
}

/** A run as the library lists it — enough for the list without opening the file. */
export interface MidoriRunSummary {
    id: string;
    createdAt: number;
    strategy: string;
    strategyName: string;
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    initialBalance: number;
    resolution?: string;
    note: string;
    stats: Pick<MidoriRunStats,
        'netPnl' | 'returnPct' | 'winRate' | 'tradeCount' | 'maxDrawdownPct' | 'profitFactor' | 'expectancy' | 'feesPaid'>;
}

/** A run in full. */
export interface MidoriRun extends Omit<MidoriRunSummary, 'stats'> {
    stats: MidoriRunStats;
    trades: MidoriTrade[];
    equityCurve: MidoriEquityPoint[];
    /** Says the curve is the condensed one, so nothing mistakes its length for a bar count. */
    equityCondensed?: boolean;
    params: Record<string, unknown>;
}

/** The running paper account — a `LiveSession.snapshot()` and the market it trades. */
interface MidoriPaperAccount {
    symbol: string;
    session: unknown;
    savedAt: number;
}

/** A stored price alert — see app/renderer/alerts/alertTypes.ts for the live shape. */
export interface MidoriPriceAlert {
    id: string;
    symbol: string;
    price: number;
    condition: 'crossing' | 'above' | 'below';
    label: string;
    message: string;
    once: boolean;
    enabled: boolean;
    createdAt: number;
    lastTriggeredAt: number | null;
}

/**
 * A stored trading bot — see app/renderer/bot/botTypes.ts for what each field means.
 *
 * The settings are `unknown`-valued on purpose: the store keeps what it was handed and the
 * renderer resolves it against the current schema, so a build that renames a parameter is
 * met with a value that falls back to its default rather than a file it cannot read.
 */
export interface MidoriBot {
    id: string;
    name: string;
    /** Which strategy it runs, by registry id. */
    strategy: string;
    /** The market, provider-prefixed: `capital:EURUSD`. */
    symbol: string;
    /** The bars the strategy is fed, in Vela's canonical spelling. */
    timeframe: string;
    /** Where its orders go: this app's own paper account, or a real Capital.com one. */
    venue: 'paper' | 'capital';
    /** The strategy's own settings, as stored. */
    params: Record<string, unknown>;
    /** What the bot is allowed to do unattended — see strategies/liveGuards.ts. */
    guards: Record<string, unknown>;
    /** Starting cash for a paper bot. Ignored on a live one, which has the venue's. */
    balance: number;
    /** Whether the bot should be running. Restored on startup for paper bots only. */
    enabled: boolean;
    createdAt: number;
}

/** One bot's stored paper account — a `LiveSession.snapshot()` and the market it trades. */
export interface MidoriBotAccount {
    symbol: string;
    session: unknown;
    savedAt: number;
}

/** One Capital.com `GET /markets` row — the fields CapitalProvider reads. */
export interface MidoriCapitalMarket {
    epic: string;
    instrumentName: string;
    instrumentType: string;
    marketStatus: string;
    streamingPricesAvailable: boolean;
}

/** A dealing-rule threshold. `unit` is `'POINTS'` or `'PERCENTAGE'` — a distance rule
 *  can be expressed either way, so it is never safe to read `value` without it. */
export interface MidoriCapitalRule {
    unit: string;
    value: number;
}

/** `GET /markets/:epic` — the subset CapitalProvider reads for `getSymbolInfo`. */
export interface MidoriCapitalMarketInfo {
    instrument: {
        epic: string;
        name: string;
        type: string;
        currency: string;
        lotSize: number;
        /** Margin required as a percentage of notional (`marginFactorUnit` says which).
         *  Absent on instruments Capital.com does not margin. */
        marginFactor?: number;
        marginFactorUnit?: string;
    };
    /** What the venue will accept. Every one of these is a rejection waiting to happen
     *  if an order is built without it. */
    dealingRules?: {
        /** The smallest position the venue will open. */
        minDealSize?: MidoriCapitalRule;
        maxDealSize?: MidoriCapitalRule;
        /** The grid sizes must sit on — 0.1 means 1.05 is refused. */
        minSizeIncrement?: MidoriCapitalRule;
        /** How far a stop or a target must be from the market, and how far it may be. */
        minStopOrProfitDistance?: MidoriCapitalRule;
        maxStopOrProfitDistance?: MidoriCapitalRule;
        minStepDistance?: MidoriCapitalRule;
    };
    snapshot?: {
        /** `TRADEABLE`, `CLOSED`, `EDITS_ONLY`, … — forex is shut at the weekend. */
        marketStatus: string;
        bid: number;
        /** Capital.com's name for the ask. */
        offer: number;
        /** How many decimals the instrument is quoted to — 5 for EURUSD. */
        decimalPlacesFactor: number;
        scalingFactor: number;
    };
}

/** The trading account, as `GET /accounts` reports it. */
export interface MidoriCapitalAccount {
    accountId: string;
    accountName: string;
    currency: string;
    balance: {
        /** Settled cash. */
        balance: number;
        deposit: number;
        /** Open profit and loss, the venue's own figure — never a computed one. */
        profitLoss: number;
        /** What is left to open something new with, after margin. */
        available: number;
    };
}

/** One open position, as `GET /positions` reports it. */
export interface MidoriCapitalPosition {
    position: {
        dealId: string;
        dealReference: string;
        /** Always positive — a short is `direction`, never a negative size. */
        size: number;
        direction: 'BUY' | 'SELL';
        /** The price it opened at. */
        level: number;
        currency: string;
        contractSize: number;
        createdDateUTC: string;
        stopLevel: number | null;
        profitLevel: number | null;
        /** Unrealized profit and loss, as the venue computes it. */
        upl?: number;
    };
    market: {
        epic: string;
        instrumentName: string;
        marketStatus: string;
        bid: number;
        offer: number;
    };
}

/** One resting order, as `GET /workingorders` reports it. */
export interface MidoriCapitalWorkingOrder {
    workingOrderData: {
        dealId: string;
        direction: 'BUY' | 'SELL';
        epic: string;
        orderSize: number;
        /** Where it waits. */
        orderLevel: number;
        /** Which of the two a level means follows from the direction. */
        orderType: 'LIMIT' | 'STOP';
        createdDateUTC: string;
        currencyCode: string;
    };
    marketData: {
        epic: string;
        instrumentName: string;
        marketStatus: string;
    };
}

/**
 * What became of one instruction — the answer to `GET /confirms/{dealReference}`, which is
 * the only thing that says whether an order did anything.
 *
 * `accepted` is decided by an explicit `ACCEPTED` from the venue and nothing else: an answer
 * that does not say so is a refusal here, never a hopeful maybe.
 */
export interface MidoriCapitalConfirmation {
    accepted: boolean;
    dealId: string | null;
    dealReference: string | null;
    /** `OPEN`, `CLOSED`, `AMENDED`, … — what became of the position. Null on a refusal. */
    status: string | null;
    /** The venue's own word for why not (`INSUFFICIENT_FUNDS`, `MARKET_CLOSED`, …), or null. */
    reason: string | null;
    /** Where it actually filled — not the price that was asked for. */
    level: number | null;
    size: number | null;
    direction: string | null;
}

/** What to open, in the venue's own terms. */
export interface MidoriCapitalOrderSpec {
    epic: string;
    direction: 'BUY' | 'SELL';
    /** Positive; the venue refuses anything off its own size grid. */
    size: number;
    stopLevel?: number;
    profitLevel?: number;
    guaranteedStop?: boolean;
    trailingStop?: boolean;
}

/**
 * One finished trade in Midorii's own live journal.
 *
 * `estimated` is the field that keeps this record honest: a position closed by a stop
 * overnight is noticed by the next read, not watched as it happens, so its exit price and
 * result are this app's best reconstruction until the venue's transaction history confirms
 * them. Marked rather than quietly presented as fact.
 */
export interface MidoriLiveTrade {
    /** The venue's own deal id — the natural key, so one closure is never recorded twice. */
    id: string;
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
    fees: number;
    estimated: boolean;
    /** Whether it was taken on the real-money account, so a demo run never totals in. */
    live: boolean;
    exitTag: string | null;
    /** What `netPnl` and `fees` are denominated in. Null on entries written before this was
     *  recorded — unknown, which is not the same as the account's own currency. */
    currency: string | null;
}

/** One trading account the credentials reach. */
export interface MidoriCapitalAccountSummary {
    accountId: string;
    accountName: string;
    currency: string;
    preferred: boolean;
    balance: number | null;
    available: number | null;
}

/** What a screen may know about the stored credentials — everything except the secrets. */
export interface MidoriCapitalCredentialStatus {
    /** Whether something is stored at all. */
    configured: boolean;
    /** The login the stored key belongs to. Shown so the account is recognisable; it is not
     *  what protects it. */
    identifier: string | null;
    env: 'demo' | 'live' | null;
    hasSecret: boolean;
    savedAt?: number | null;
    /** False on a machine with no OS keychain — storing is refused there rather than done
     *  in plain text. */
    encryptionAvailable: boolean;
    /** Whether a `.env.local` is currently supplying credentials instead. */
    envPresent: boolean;
}

/** One bid/ask tick off the `quote` stream, renamed out of Capital.com's vocabulary
 *  (`ofr` → `ask`) on the way through the main process. */
export interface MidoriCapitalQuote {
    epic: string;
    bid: number;
    ask: number;
    bidSize: number | null;
    askSize: number | null;
    /** Epoch ms, as the venue stamped it. */
    time: number;
}

export interface MidoriCapitalBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// Mirrors what preload.cjs exposes via contextBridge (app/electron/preload.cjs).
declare global {
    interface Window {
        midori: {
            /** `process.platform` from the main process — `'darwin'` gets native traffic
             *  lights; everywhere else draws its own window controls in the app topbar. */
            platform: string;
            ui: {
                /** Purely cosmetic: keeps the OS window's paint colour in step with the
                 *  app theme so a resize never flashes the other theme's colour.
                 *  `background` is the palette's exact surface colour (`#rgb`/`#rrggbb`);
                 *  without it the window falls back to the theme name's default, which is
                 *  only right for the palette the app shipped with. */
                setTheme(theme: 'light' | 'dark', background?: string): Promise<boolean>;
            };
            window: {
                minimize(): void;
                toggleMaximize(): void;
                close(): void;
                isMaximized(): Promise<boolean>;
                /** Fires on every maximize/restore, Windows' own (Aero Snap, a
                 *  double-click on the drag region) included. Returns its own unsubscribe. */
                onMaximizedChange(handler: (maximized: boolean) => void): () => void;
                /** Bring the window to the front from minimized/background — what a
                 *  triggered alert's notification calls on click. */
                restore(): void;
            };
            data: {
                datasets(): Promise<MidoriDatasetMeta[]>;
                meta(symbol: string): Promise<MidoriDatasetMeta | null>;
                sources(): Promise<MidoriSource[]>;
                symbols(source?: string): Promise<{ symbol: string; base: string; quote: string }[]>;
                bars(query: MidoriBarQuery): Promise<MidoriBar[]>;
                /** Removes a dataset — bars and metadata. False when there was none. */
                delete(symbol: string): Promise<boolean>;
                /** Fills in whatever the range is missing at either end and reports the
                 *  coverage. What the Backtest tab calls before running on a venue. */
                ensure(request: {
                    symbol: string;
                    source?: string;
                    from: number;
                    to: number;
                }): Promise<MidoriEnsureResult>;
                /** Opens the file picker. Resolves null when it is dismissed. */
                pickCsv(): Promise<MidoriCsvInspection | null>;
                /** Re-reads a file the picker already returned, under whatever the dialog
                 *  has corrected so far. */
                inspectCsv(request: {
                    file: string;
                    delimiter?: string;
                    hasHeader?: boolean;
                    mapping?: MidoriCsvMapping;
                    dateStyle?: MidoriCsvDateStyle;
                    timeZone?: string;
                }): Promise<MidoriCsvInspection>;
                importCsv(request: {
                    /** One file, or `files` for a set of parts read as one series. */
                    file?: string;
                    files?: string[];
                    symbol: string;
                    delimiter: string;
                    hasHeader: boolean;
                    mapping: MidoriCsvMapping;
                    dateStyle: MidoriCsvDateStyle;
                    timeZone?: string;
                }): Promise<MidoriCsvImportResult>;
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
            /** The paper account — one record, not a library. A FINISHED one goes to
             *  `replay.save` instead, onto the same shelf backtests and replays land on. */
            paper: {
                load(): Promise<MidoriPaperAccount | null>;
                save(account: { symbol: string; session: unknown }): Promise<{ savedAt: number }>;
                clear(): Promise<boolean>;
            };
            /** A finished backtest. The loop runs in the renderer, where the detectors a
             *  strategy is built on live; only the result crosses the bridge, onto the same
             *  shelf a replay lands on. */
            backtest: {
                /** Files a finished run and answers with its library entry. Rejects a run with
                 *  no result, no range, or a strategy id reserved for hand-traded sessions. */
                save(request: Record<string, unknown>): Promise<MidoriRunSummary>;
            };
            /**
             * What each strategy is set to, keyed by strategy id.
             *
             * Configuration rather than a result. The Strategies tab writes it and the
             * Backtest tab starts from it; a run stores what it actually ran with, so the
             * two never have to agree after the fact. Values are stored as given and
             * resolved against the current schema on the way out — see
             * `resolveStrategyParams`.
             */
            strategies: {
                load(): Promise<Record<string, Record<string, unknown>>>;
                save(id: string, params: Record<string, unknown>): Promise<Record<string, Record<string, unknown>>>;
                /** Forgets one strategy's settings, so it falls back to its own defaults. */
                reset(id: string): Promise<Record<string, Record<string, unknown>>>;
            };
            /** A finished parameter sweep — a ranking of settings rather than an account.
             *  Its own shelf beside the runs, read on the same Analysis screen. */
            sweep: {
                save(request: Record<string, unknown>): Promise<MidoriSweepSummary>;
                list(): Promise<MidoriSweepSummary[]>;
                load(id: string): Promise<MidoriSweep>;
                delete(id: string): Promise<boolean>;
                annotate(id: string, note: string): Promise<string>;
            };
            /** Price alerts — one flat list, read at startup and rewritten whenever it changes. */
            alerts: {
                load(): Promise<MidoriPriceAlert[]>;
                save(alerts: MidoriPriceAlert[]): Promise<{ savedAt: number }>;
            };
            /** Trading bots — their definitions, round-tripped whole. */
            bots: {
                load(): Promise<MidoriBot[]>;
                save(bots: MidoriBot[]): Promise<{ savedAt: number }>;
                /** Each bot's own paper account, keyed by the bot it belongs to. */
                account: {
                    load(id: string): Promise<MidoriBotAccount | null>;
                    save(id: string, account: { symbol: string; session: unknown }): Promise<{ savedAt: number }>;
                    clear(id: string): Promise<boolean>;
                    /** Drop accounts whose bot is gone; answers how many went. */
                    sweep(keep: readonly string[]): Promise<{ removed: number }>;
                };
            };
            runs: {
                /** Every stored run, newest first, as summaries. */
                list(): Promise<MidoriRunSummary[]>;
                /** One run in full — trades and equity curve included. Rejects if it is gone. */
                load(id: string): Promise<MidoriRun>;
                delete(id: string): Promise<boolean>;
                /** Replaces the run's note and answers with what was stored. */
                annotate(id: string, note: string): Promise<string>;
            };
            /** Forex/CFD data — the login and the WebSocket live in the main process
             *  (see app/electron/data/capital.js); this only ever sees bars. */
            /**
             * The live trading journal — Midorii's own record of what has been traded on a
             * real account. Kept here rather than read from the venue each time: the venue
             * serves at most a day of history per request and loses it with the account.
             */
            live: {
                /** Every trade on record, oldest first. */
                trades(): Promise<MidoriLiveTrade[]>;
                /** Add one. `added` is false where the id was already on record — the same
                 *  closure can be noticed twice when two reads overlap. */
                append(trade: MidoriLiveTrade): Promise<{ added: boolean; total: number }>;
                /** Replace the estimated exit figures on one entry with the venue's own.
                 *  Resolves false where the entry is unknown or already settled. */
                settle(patch: { id: string; exitPrice?: number; netPnl?: number; fees?: number; currency?: string | null }): Promise<boolean>;
                clear(): Promise<void>;
            };
            capital: {
                /** Whether CAPITAL_API_KEY/CAPITAL_IDENTIFIER/CAPITAL_PASSWORD are set. */
                configured(): Promise<boolean>;
                /**
                 * Managing the stored credentials.
                 *
                 * The secret goes in and never comes back out: there is no call here that
                 * returns the key or the password, which is why no bug can put either on a
                 * screen or in a log.
                 */
                credentials: {
                    status(): Promise<MidoriCapitalCredentialStatus>;
                    /** Try them WITHOUT storing, and answer with the accounts they reach. */
                    test(creds: { apiKey: string; identifier: string; password: string; env: 'demo' | 'live' }): Promise<MidoriCapitalAccountSummary[]>;
                    /** Try, then store, then put into effect. Rejects without storing where
                     *  the venue refuses them. */
                    save(creds: { apiKey: string; identifier: string; password: string; env: 'demo' | 'live' }): Promise<{
                        accounts: MidoriCapitalAccountSummary[];
                        env: 'demo' | 'live';
                    }>;
                    /** Forget them, falling back to whatever the environment says. */
                    clear(): Promise<{ source: string; env: string }>;
                };
                /**
                 * Which account the credentials point at.
                 *
                 * `live` is the whole reason this exists: the difference between demo and real
                 * money is one word in a file, and anything that can place an order has to be
                 * able to SAY which of the two it is wired to rather than assume.
                 */
                environment(): Promise<{ configured: boolean; env: 'demo' | 'live' | null; live: boolean }>;
                markets(searchTerm?: string): Promise<MidoriCapitalMarket[]>;
                marketInfo(epic: string): Promise<MidoriCapitalMarketInfo | null>;
                prices(query: { epic: string; resolution: string; from?: number; to?: number; limit?: number }): Promise<MidoriCapitalBar[]>;
                /** Resolves to an opaque subscription id — pass it to `unsubscribe`. */
                subscribe(query: { epic: string; resolution: string }): Promise<string>;
                unsubscribe(subscriptionId: string): Promise<void>;
                /** Returns its own unsubscribe. */
                onOhlc(handler: (payload: { subscriptionId: string; bar: MidoriCapitalBar }) => void): () => void;
                /** The trading account this session acts on — the preferred one. */
                account(): Promise<MidoriCapitalAccount | null>;
                /** Every position the account holds, including ones this app never opened. */
                positions(): Promise<MidoriCapitalPosition[]>;
                /**
                 * Open a position, and resolve with what the venue CONFIRMED — an accepted
                 * deal or a named refusal. Rejects only where no verdict could be obtained
                 * at all, which is not the same as a refusal: the instruction was delivered,
                 * so the position list is the thing to check before sending it again.
                 */
                openPosition(spec: MidoriCapitalOrderSpec): Promise<MidoriCapitalConfirmation>;
                /** Move (or, with an explicit null, remove) the stop and target on a position. */
                amendPosition(spec: {
                    dealId: string;
                    stopLevel?: number | null;
                    profitLevel?: number | null;
                }): Promise<MidoriCapitalConfirmation>;
                closePosition(dealId: string): Promise<MidoriCapitalConfirmation>;
                /** Every resting order the account holds, on any instrument. */
                workingOrders(): Promise<MidoriCapitalWorkingOrder[]>;
                /** Rest an order at a level. Which of LIMIT/STOP a level means follows from
                 *  the direction, and the caller decides it. */
                createOrder(spec: {
                    epic: string;
                    direction: 'BUY' | 'SELL';
                    size: number;
                    type: 'LIMIT' | 'STOP';
                    level: number;
                    stopLevel?: number;
                    profitLevel?: number;
                }): Promise<MidoriCapitalConfirmation>;
                amendOrder(spec: {
                    dealId: string;
                    level?: number;
                    stopLevel?: number | null;
                    profitLevel?: number | null;
                }): Promise<MidoriCapitalConfirmation>;
                cancelOrder(dealId: string): Promise<MidoriCapitalConfirmation>;
                /**
                 * The two ledgers a finished trade's real cost has to be joined from — the
                 * cash side and the position's life. The window is in epoch milliseconds and
                 * is walked in daily slices, which is all `/history/activity` serves.
                 */
                history(window: { from: number; to: number }): Promise<{
                    transactions: unknown[];
                    activities: unknown[];
                }>;
                /** The bid/ask tick stream, subscribed per instrument (no resolution —
                 *  a quote is not bucketed). Resolves to an opaque subscription id. */
                subscribeQuotes(query: { epic: string }): Promise<string>;
                unsubscribeQuotes(subscriptionId: string): Promise<void>;
                /** Returns its own unsubscribe. */
                onQuote(handler: (payload: { subscriptionId: string; quote: MidoriCapitalQuote }) => void): () => void;
            };
        };
    }
}
