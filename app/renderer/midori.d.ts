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

/** One Capital.com `GET /markets` row — the fields CapitalProvider reads. */
export interface MidoriCapitalMarket {
    epic: string;
    instrumentName: string;
    instrumentType: string;
    marketStatus: string;
    streamingPricesAvailable: boolean;
}

/** `GET /markets/:epic` — the subset CapitalProvider reads for `getSymbolInfo`. */
export interface MidoriCapitalMarketInfo {
    instrument: {
        epic: string;
        name: string;
        type: string;
        currency: string;
        lotSize: number;
    };
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
            capital: {
                /** Whether CAPITAL_API_KEY/CAPITAL_IDENTIFIER/CAPITAL_PASSWORD are set. */
                configured(): Promise<boolean>;
                markets(searchTerm?: string): Promise<MidoriCapitalMarket[]>;
                marketInfo(epic: string): Promise<MidoriCapitalMarketInfo | null>;
                prices(query: { epic: string; resolution: string; from?: number; to?: number; limit?: number }): Promise<MidoriCapitalBar[]>;
                /** Resolves to an opaque subscription id — pass it to `unsubscribe`. */
                subscribe(query: { epic: string; resolution: string }): Promise<string>;
                unsubscribe(subscriptionId: string): Promise<void>;
                /** Returns its own unsubscribe. */
                onOhlc(handler: (payload: { subscriptionId: string; bar: MidoriCapitalBar }) => void): () => void;
            };
        };
    }
}
