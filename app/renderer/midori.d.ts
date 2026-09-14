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

export interface MidoriExperimentalSymbol {
    ticker: string;
    description?: string;
    type?: string;
}

export interface MidoriExperimentalBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface MidoriExperimentalSymbolInfo extends Record<string, unknown> {
    ticker: string;
    tickerid: string;
    prefix?: string;
    description?: string;
    type?: string;
    currency?: string;
    timezone?: string;
    pricescale?: number;
    mintick?: number;
}

/** A paused, unfinished replay — the account and the clock, never the bars. */
/** What the feed recorder is doing, and what it has kept. */
export interface MidoriRecorderStatus {
    enabled: boolean;
    recordings: Array<{ name: string; days: string[]; bytes: number }>;
}

/**
 * One recorded event.
 * `[time, 1, price, volume, side]` is a print — side 0 means the buyer crossed the spread, 1 the
 * seller, null where the feed did not say. `[time, 2, bid, ask, last]` is a complete quote.
 */
export type MidoriTick = [number, 1, number, number, 0 | 1 | null] | [number, 2, number | null, number | null, number | null];

interface MidoriSessionRecord {
    id: string;
    name: string;
    symbol: string;
    timeframe: string;
    startTime: number;
    clock: number;
    stats: Record<string, unknown>;
    session: unknown;
    /** Absent on a session parked before journals were kept. */
    journal?: unknown;
    /** The recording it plays on ticks, where it has one. */
    ticks?: string | null;
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

/** Daily limits that must survive a stop or restart within the same UTC day. */
export interface MidoriBotGuardRuntime {
    dayKey: string;
    dayOpenEquity: number;
    tradesToday: number;
    lastLossAt: number | null;
}

/** Venue ids proven to belong to one Capital.com bot. */
export interface MidoriBotCapitalOwnership {
    /** Distinguishes an empty, verified book from a record created before ownership existed. */
    initialized: boolean;
    positionDealIds: string[];
    workingOrderDealIds: string[];
    /** An order with no verdict may exist, but cannot be assigned safely. */
    uncertain: boolean;
}

/** One bot's durable runtime: paper account, guard counters, and live venue ownership. */
export interface MidoriBotAccount {
    symbol: string;
    /** Present for paper bots. Live bots have no local broker session. */
    session?: unknown;
    guards?: MidoriBotGuardRuntime;
    capital?: MidoriBotCapitalOwnership;
    savedAt: number;
}

export type MidoriBotAccountSnapshot = Omit<MidoriBotAccount, 'savedAt'>;

/** One Capital.com `GET /markets` row — the fields CapitalProvider reads. */
export interface MidoriCapitalMarket {
    epic: string;
    instrumentName: string;
    instrumentType: string;
    marketStatus: string;
    streamingPricesAvailable: boolean;
}

/**
 * One tradeable futures contract.
 *
 * `id` is what every other ProjectX call takes — the dated contract (`CON.F.US.ENQ.U26`).
 * `symbolId` is the root behind it (`F.US.ENQ`), the same across expiries, which is what
 * makes a rollover recognisable as one instrument rather than two.
 *
 * `tickSize` and `tickValue` are not decoration: a futures position's worth is ticks moved
 * times value per tick, so sizing and P&L are wrong without both.
 */
export interface MidoriProjectXContract {
    id: string;
    /** The venue's short name, e.g. `NQU6`. */
    name: string;
    description: string;
    tickSize: number;
    tickValue: number;
    /** False on an expiry that has rolled off — still returned, not still traded. */
    activeContract: boolean;
    symbolId: string;
}

/** One account the key reaches. `simulated` is undocumented but always present, and is the
 *  only honest way to tell a practice book from a funded one. */
export interface MidoriProjectXAccount {
    id: number;
    name: string;
    balance: number;
    canTrade: boolean;
    simulated?: boolean;
    /** Whether it was reached on the live side — set by the probe, not by the gateway. */
    live?: boolean;
}

/** A bar as the renderer reads it — already converted out of the gateway's single-letter
 *  fields and its `+00:00` timestamps. */
export interface MidoriProjectXBar {
    /** Open time, epoch milliseconds. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * A quote, always complete.
 *
 * The feed itself sends deltas — after the opening snapshot, only the fields that moved —
 * and the main process folds them into the last known state before this crosses the bridge.
 * A field is null only where nothing has ever been seen for it.
 */
/**
 * One execution on a ProjectX account — a HALF-TURN, as the gateway states it.
 *
 * `profitAndLoss` is null on the fill that opened a position and carries the realised result
 * on the one that closed it, which is the whole reason a record of round trips has to be
 * built rather than read: two of these are one trade.
 */
export interface MidoriProjectXTrade {
    id: number;
    accountId: number;
    contractId: string;
    /** ISO 8601, with an offset. */
    creationTimestamp: string;
    price: number;
    /** Null on a half-turn that opened. The venue's own realised figure where it is not. */
    profitAndLoss: number | null;
    fees: number;
    /** 0 buys, 1 sells — the same pair the order endpoints use. */
    side: number;
    size: number;
    /** Cancelled by the venue after the fact. Left out of any record it appears in. */
    voided: boolean;
    orderId: number;
}

/**
 * One print on the tape, as the market hub states it.
 *
 * `type` is the AGGRESSOR — which side crossed the spread to make this trade happen — and it
 * is the whole reason a tape is read rather than a price list. Measured against a live feed
 * rather than taken from the documentation, which does not say.
 */
export interface MidoriProjectXPrint {
    /** ISO 8601, with an offset. */
    timestamp: string;
    price: number;
    volume: number;
    /** 0 bought into the offer, 1 sold into the bid. */
    type: number;
}

export interface MidoriProjectXQuote {
    contractId: string;
    last: number | null;
    bid: number | null;
    ask: number | null;
    /** From the feed's `lastUpdated`, epoch milliseconds. */
    time: number;
}

/**
 * What is stored for ProjectX, in the credential store's own vocabulary.
 *
 * `identifier` is the platform username and `env` is which book the key trades — the store
 * keeps a login name and a real-money flag under those names for every broker, and ProjectX
 * uses them rather than inventing a second pair. The gateway host has no counterpart there
 * and is kept as an extra field.
 */
export interface MidoriProjectXCredentialStatus {
    configured: boolean;
    /** The platform username. */
    identifier: string | null;
    /** `'live'` is a funded account; `'demo'` is an evaluation or practice one. */
    env: 'demo' | 'live' | null;
    hasSecret?: boolean;
    savedAt?: number | null;
    /** The account orders are addressed to, once one has been chosen. */
    accountId?: number;
    /** The firm's gateway host, absent when it is the TopstepX default. */
    base?: string;
    hub?: string;
    encryptionAvailable: boolean;
    /** Whether the environment is currently supplying credentials — worth showing, because
     *  it explains a connection that works with nothing stored. */
    envPresent: boolean;
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
        /** The resting order that created this position, where it entered from the book. */
        workingOrderId?: string;
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
        /** Not in the venue's documented response — read where it is present, never relied on. */
        trailingStop?: boolean;
        stopDistance?: number | null;
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

/** A balance from the Binance Spot Demo account. Decimal strings stay exact across IPC. */
export interface MidoriBinanceSpotBalance {
    asset: string;
    free: string;
    locked: string;
}

export interface MidoriBinanceSpotAccount {
    canTrade: boolean;
    accountType: string;
    permissions: string[];
    balances: MidoriBinanceSpotBalance[];
    uid?: number;
    updateTime?: number;
}

export interface MidoriBinanceSpotSymbolInfo {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    tickSize: number;
    stepSize: number;
    minQty: number;
    maxQty: number;
    marketStepSize: number;
    marketMinQty: number;
    marketMaxQty: number;
    minNotional: number;
    orderTypes: string[];
    ocoAllowed: boolean;
    otoAllowed: boolean;
}

export interface MidoriBinanceSpotOrder {
    symbol: string;
    orderId: number;
    orderListId: number;
    clientOrderId: string;
    price: string;
    origQty: string;
    executedQty: string;
    status: string;
    type: string;
    side: 'BUY' | 'SELL';
    stopPrice: string;
    time: number;
    updateTime: number;
}

export interface MidoriBinanceSpotTrade {
    id: number;
    orderId: number;
    orderListId: number;
    price: string;
    qty: string;
    quoteQty: string;
    commission: string;
    commissionAsset: string;
    time: number;
    isBuyer: boolean;
}

export interface MidoriBinanceSpotCredentialStatus {
    configured: boolean;
    identifier: string | null;
    env: 'demo';
    hasSecret: boolean;
    savedAt?: number | null;
    encryptionAvailable: boolean;
    envPresent: boolean;
}

/** Which of Bybit's two products a call is about. */
export type MidoriBybitCategory = 'spot' | 'linear';

/**
 * One Bybit market's rules, already read out of the two shapes the venue states them in —
 * spot describes a base precision and a minimum order value, linear a quantity step and a
 * minimum notional. See `parseBybitInstrument` in app/electron/data/bybit.js.
 */
export interface MidoriBybitInstrument {
    category: MidoriBybitCategory;
    symbol: string;
    /** The venue's own word: `Trading`, `PreLaunch`, `Delivering`, `Closed`. */
    status: string;
    baseAsset: string;
    quoteAsset: string;
    /** What a perpetual settles in; null on spot, which settles in the pair itself. */
    settleAsset: string | null;
    tickSize: number;
    stepSize: number;
    minQty: number;
    maxQty: number;
    /** The smallest an order may be worth, in the quote asset. 0 where the venue sets none. */
    minNotional: number;
    maxLeverage: number | null;
}

/** One coin's line in the unified wallet. Decimal strings stay exact across IPC. */
export interface MidoriBybitWalletCoin {
    coin: string;
    equity: string;
    walletBalance: string;
    usdValue: string;
    unrealisedPnl?: string;
}

export interface MidoriBybitWallet {
    list: Array<{
        accountType: string;
        totalEquity: string;
        totalAvailableBalance: string;
        totalWalletBalance: string;
        coin: MidoriBybitWalletCoin[];
    }>;
}

/** One open perpetual position, as the venue states it. */
export interface MidoriBybitPosition {
    symbol: string;
    /** `Buy`, `Sell`, or empty where the position is flat. */
    side: 'Buy' | 'Sell' | '';
    size: string;
    avgPrice: string;
    positionValue: string;
    leverage: string;
    markPrice: string;
    liqPrice: string;
    unrealisedPnl: string;
    /** Empty strings where none is set — the venue does not use null here. */
    takeProfit: string;
    stopLoss: string;
    createdTime: string;
    updatedTime: string;
}

export interface MidoriBybitOrder {
    orderId: string;
    orderLinkId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    price: string;
    qty: string;
    leavesQty: string;
    triggerPrice: string;
    /** `Stop`, `TakeProfit`, `StopLoss`, `tpslOrder`, … Empty on a plain order. */
    stopOrderType: string;
    orderStatus: string;
    reduceOnly: boolean;
    takeProfit: string;
    stopLoss: string;
    createdTime: string;
}

export interface MidoriBybitExecution {
    execId: string;
    orderId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    execPrice: string;
    execQty: string;
    execValue: string;
    execFee: string;
    feeCurrency: string;
    execType: string;
    execTime: string;
}

/** What a Bybit key reaches, without ever handing the key back. */
export interface MidoriBybitAccountSummary {
    uid: string | null;
    note: string | null;
    readOnly: boolean;
    uta: boolean;
    spot: boolean;
    derivatives: boolean;
    wallet: MidoriBybitWallet['list'][number] | null;
}

export interface MidoriBybitCredentialStatus {
    configured: boolean;
    identifier: string | null;
    env: 'demo' | 'live' | null;
    hasSecret: boolean;
    savedAt?: number | null;
    encryptionAvailable: boolean;
    envPresent: boolean;
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
                /** Tell the main process that asynchronous shutdown work has finished. */
                readyToClose(): void;
                /** Fires for the title-bar button, Alt+F4, and application shutdown. */
                onCloseRequested(handler: () => void): () => void;
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
            /** The ProjectX feed recorder — see app/electron/data/tickRecorder.js. */
            recorder: {
                status(): Promise<MidoriRecorderStatus>;
                setEnabled(enabled: boolean): Promise<MidoriRecorderStatus>;
            };
            /** What the recorder kept, for a replay to play. Oldest first. */
            ticks: {
                read(request: { name: string; from: number; to: number }): Promise<MidoriTick[]>;
                /** The contract a recording is of, where the gateway had listed it. */
                meta(name: string): Promise<{ contractId: string; tickSize: number | null; tickValue: number | null } | null>;
            };
            replay: {
                save(request: Record<string, unknown>): Promise<{ id: string }>;
                saveSession(request: {
                    id?: string | null;
                    name?: string;
                    symbol: string;
                    timeframe: string;
                    session: unknown;
                    /** What the session has done since it began, so it can go back to a candle
                     *  after being picked up again — see replay/replayJournal.ts. */
                    journal?: unknown;
                    /** The recording the session plays on ticks, where it has one. */
                    ticks?: string | null;
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
                /** Each bot's durable account, daily guards, and live venue ownership. */
                account: {
                    load(id: string): Promise<MidoriBotAccount | null>;
                    save(id: string, account: MidoriBotAccountSnapshot): Promise<{ savedAt: number }>;
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
            /** Optional, anonymous chart data. This surface deliberately exposes no
             *  automation, backtest, alert, or order operation. */
            experimentalFeed: {
                search(query: string): Promise<MidoriExperimentalSymbol[]>;
                symbolInfo(symbol: string): Promise<MidoriExperimentalSymbolInfo>;
                bars(query: {
                    symbol: string;
                    timeframe: string;
                    from?: number;
                    to?: number;
                    limit?: number;
                    session?: string;
                }): Promise<MidoriExperimentalBar[]>;
                subscribe(query: { symbol: string; timeframe: string; session?: string }): Promise<string>;
                unsubscribe(subscriptionId: string): Promise<void>;
                onBar(handler: (payload: { subscriptionId: string; bar: MidoriExperimentalBar }) => void): () => void;
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
                /**
                 * Move to the other account on the credentials already held.
                 *
                 * The key never moves — only which endpoint it is used against. Tried before it
                 * takes effect, so a key Capital.com has not issued for the other side is
                 * refused here and the account in use is left untouched.
                 *
                 * `persisted` false means the credentials came from .env.local and there was
                 * nowhere to record the choice: it holds for this sitting, and CAPITAL_ENV
                 * decides the next one.
                 */
                setEnvironment(env: 'demo' | 'live'): Promise<{
                    env: 'demo' | 'live';
                    accounts: MidoriCapitalAccountSummary[];
                    persisted: boolean;
                }>;
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
                /** Move (or, with an explicit null, remove) the stop and target on a position.
                 *  `trailingStop` true needs `stopDistance`, the trail in price. The call
                 *  REPLACES the protection set, so every side that should stay is re-sent. */
                amendPosition(spec: {
                    dealId: string;
                    stopLevel?: number | null;
                    profitLevel?: number | null;
                    trailingStop?: boolean;
                    stopDistance?: number;
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
            /** Futures data through the ProjectX gateway — the session, the SignalR socket
             *  and the tick-to-bar aggregation live in the main process; this only ever
             *  sees bars and quotes. See app/electron/data/projectx.js. */
            projectx: {
                /** Whether PROJECTX_USERNAME/PROJECTX_API_KEY are in effect. */
                configured(): Promise<boolean>;
                credentials: {
                    status(): Promise<MidoriProjectXCredentialStatus>;
                    /** Try them WITHOUT storing, and answer with the accounts they reach. */
                    test(creds: { userName: string; apiKey: string; base?: string; live?: boolean }): Promise<MidoriProjectXAccount[]>;
                    /** Try, then store, then put into effect. Rejects without storing where
                     *  the gateway refuses them. */
                    save(creds: { userName: string; apiKey: string; base?: string; hub?: string; live?: boolean }): Promise<{
                        accounts: MidoriProjectXAccount[];
                        live: boolean;
                    }>;
                    clear(): Promise<{ source: string; live: boolean }>;
                };
                /**
                 * Which side of the gateway the credentials reach.
                 *
                 * `live` is not a data setting. The gateway refuses the live side outright to
                 * an account that holds only simulated ones, so anything that can place an
                 * order has to be able to SAY which book it is wired to.
                 */
                environment(): Promise<{ configured: boolean; live: boolean; base: string | null }>;
                accounts(onlyActive?: boolean): Promise<MidoriProjectXAccount[]>;
                /**
                 * Which account orders are addressed to.
                 *
                 * Unlike Capital.com there is no venue-side preferred account: every ProjectX
                 * call carries an id, and one key routinely reaches an evaluation plus the
                 * funded accounts that came out of it. Nothing is chosen by default, because
                 * guessing here would put an order on somebody's funded book.
                 */
                account(): Promise<{ accountId: number | null; chosen: boolean }>;
                /** Verified against the venue before it takes effect; rejects for an account
                 *  that is gone or may not trade. */
                selectAccount(id: number): Promise<MidoriProjectXAccount>;
                /** Open positions on the chosen account. Rejects when none is chosen. */
                positions(): Promise<unknown[]>;
                /** Resting orders on the chosen account. Rejects when none is chosen. */
                openOrders(): Promise<unknown[]>;
                /**
                 * Executions on the chosen account — HALF-TURNS, not round trips.
                 *
                 * `profitAndLoss` is null on the fill that opened and carries the realised
                 * result on the one that closed; pairing them is `projectxHistory.ts`.
                 * Defaults to the last thirty days.
                 */
                trades(range?: { from?: number; to?: number }): Promise<MidoriProjectXTrade[]>;
                /**
                 * Place an order. Brackets are given in TICKS from the fill, which is the
                 * gateway's own shape — and they can only be set HERE, when the order is
                 * placed. Protecting a position that is already open means resting orders
                 * of its own; see ProjectXController.
                 */
                placeOrder(spec: {
                    contractId: string;
                    side: 'buy' | 'sell';
                    type: 'market' | 'limit' | 'stop' | 'trailingStop' | 'joinBid' | 'joinAsk';
                    size: number;
                    limitPrice?: number;
                    stopPrice?: number;
                    trailPrice?: number;
                    customTag?: string;
                    stopLossTicks?: number;
                    takeProfitTicks?: number;
                }): Promise<{ orderId: number | null }>;
                /** Move a resting order. Only the fields given are sent. */
                modifyOrder(orderId: number, changes: { size?: number; limitPrice?: number; stopPrice?: number; trailPrice?: number }): Promise<void>;
                cancelOrder(orderId: number): Promise<void>;
                /** Close at market — whole, or `size` contracts of it. */
                closePosition(contractId: string, size?: number | null): Promise<void>;
                contracts(searchText: string): Promise<MidoriProjectXContract[]>;
                /** Everything reachable, for the symbol index. The one call here never seen
                 *  answer on a real account — callers degrade rather than depend on it. */
                availableContracts(): Promise<MidoriProjectXContract[]>;
                bars(query: { contractId: string; timeframe: string; from?: number; to?: number; limit?: number }): Promise<MidoriProjectXBar[]>;
                /** Resolves to an opaque subscription id — pass it to `unsubscribe`. */
                subscribe(query: { contractId: string; timeframe: string }): Promise<string>;
                unsubscribe(subscriptionId: string): Promise<void>;
                /** Returns its own unsubscribe. The bar is the one being BUILT from the tape,
                 *  re-sent on every print rather than only when it closes. */
                onBar(handler: (payload: { subscriptionId: string; bar: MidoriProjectXBar }) => void): () => void;
                /**
                 * The tape — every print on a contract, in the batches the hub delivers.
                 *
                 * Costs nothing extra on the wire: it rides the same subscription the bars and
                 * the quotes do. What it adds is the prints themselves, with the aggressor side
                 * on each one, rather than only their effect on a bar.
                 */
                subscribePrints(query: { contractId: string }): Promise<string>;
                unsubscribePrints(subscriptionId: string): Promise<void>;
                onPrints(handler: (payload: { subscriptionId: string; prints: MidoriProjectXPrint[] }) => void): () => void;
                subscribeQuotes(query: { contractId: string }): Promise<string>;
                unsubscribeQuotes(subscriptionId: string): Promise<void>;
                onQuote(handler: (payload: { subscriptionId: string; quote: MidoriProjectXQuote }) => void): () => void;
                /**
                 * The account side of the gateway's realtime feed — orders, positions, trades
                 * and the balance, as they happen.
                 *
                 * Resolves once the socket is actually up, so a caller can tell whether it is
                 * being pushed to or is still on its own timer. The payload is passed through
                 * untouched and is deliberately NOT what anything reads: an event here means
                 * "something changed, ask again", which is the same rule the rest of this
                 * venue follows. Subscribing follows whichever account is chosen.
                 */
                subscribeUser(): Promise<string>;
                unsubscribeUser(subscriptionId: string): Promise<void>;
                onUserEvent(handler: (payload: {
                    subscriptionId: string;
                    event: 'GatewayUserAccount' | 'GatewayUserOrder' | 'GatewayUserPosition' | 'GatewayUserTrade';
                    payload: unknown;
                }) => void): () => void;
            };
            /** Spot trading on Binance's demo host. No production environment is exposed. */
            binanceSpot: {
                environment(): Promise<{ configured: boolean; env: 'demo'; live: false }>;
                credentials: {
                    status(): Promise<MidoriBinanceSpotCredentialStatus>;
                    test(creds: { apiKey: string; secretKey: string }): Promise<MidoriBinanceSpotAccount>;
                    save(creds: { apiKey: string; secretKey: string }): Promise<{
                        account: MidoriBinanceSpotAccount;
                        env: 'demo';
                    }>;
                    clear(): Promise<{ source: string; env: 'demo' }>;
                };
                symbolInfo(symbol: string): Promise<MidoriBinanceSpotSymbolInfo>;
                account(): Promise<MidoriBinanceSpotAccount>;
                openOrders(symbol: string): Promise<MidoriBinanceSpotOrder[]>;
                trades(symbol: string): Promise<MidoriBinanceSpotTrade[]>;
                placeOrder(spec: {
                    symbol: string;
                    side: 'BUY' | 'SELL';
                    type: 'MARKET' | 'LIMIT' | 'STOP_LOSS';
                    quantity: number;
                    price?: number;
                    stopPrice?: number;
                    bracket?: { stopLoss?: number; takeProfit?: number };
                }): Promise<unknown>;
                cancelOrder(spec: { symbol: string; orderId: number }): Promise<unknown>;
                cancelAll(symbol: string): Promise<unknown>;
                replaceProtection(spec: {
                    symbol: string;
                    quantity: number;
                    orders: Array<{ orderId: number; orderListId: number }>;
                    stopLoss?: number;
                    takeProfit?: number;
                }): Promise<unknown>;
                close(symbol: string): Promise<unknown>;
            };
            /**
             * Bybit V5 — spot pairs and USDT perpetuals through one surface, because the
             * venue is one API and the product is a parameter of it.
             *
             * Which host the credentials reach is stored with them and reported by
             * {@link environment}; nothing here can choose it.
             */
            bybit: {
                environment(): Promise<{ configured: boolean; env: 'demo' | 'live' | null; live: boolean }>;
                credentials: {
                    status(): Promise<MidoriBybitCredentialStatus>;
                    test(creds: { apiKey: string; secretKey: string; env: 'demo' | 'live' }): Promise<MidoriBybitAccountSummary>;
                    save(creds: { apiKey: string; secretKey: string; env: 'demo' | 'live' }): Promise<{
                        account: MidoriBybitAccountSummary;
                        env: 'demo' | 'live';
                    }>;
                    clear(): Promise<{ source: string; env: 'demo' | 'live' }>;
                };
                instrument(query: { category: MidoriBybitCategory; symbol: string }): Promise<MidoriBybitInstrument>;
                /** Public candles, oldest first. Unsigned, and served from the live host in
                 *  both environments — Bybit's demo module has no price history of its own. */
                klines(query: {
                    category: MidoriBybitCategory;
                    symbol: string;
                    /** Bybit's own interval vocabulary: minutes as a number, or D/W/M. */
                    interval: string;
                    start?: number;
                    end?: number;
                    limit?: number;
                }): Promise<MidoriCapitalBar[]>;
                wallet(): Promise<MidoriBybitWallet>;
                /** Perpetual positions only — spot holds balances instead. */
                positions(symbol: string): Promise<{ list: MidoriBybitPosition[] }>;
                openOrders(query: { category: MidoriBybitCategory; symbol: string }): Promise<MidoriBybitOrder[]>;
                executions(query: { category: MidoriBybitCategory; symbol: string }): Promise<MidoriBybitExecution[]>;
                placeOrder(spec: {
                    category: MidoriBybitCategory;
                    symbol: string;
                    side: 'Buy' | 'Sell';
                    type: 'Market' | 'Limit';
                    qty: number;
                    price?: number;
                    /** Set to make it a conditional order — a stop entry, or a stop exit. */
                    triggerPrice?: number;
                    /** The market price the trigger's direction is read against. */
                    reference?: number;
                    reduceOnly?: boolean;
                    bracket?: { stopLoss?: number; takeProfit?: number };
                }): Promise<unknown>;
                cancelOrder(spec: {
                    category: MidoriBybitCategory;
                    symbol: string;
                    orderId: string;
                    orderFilter?: string;
                }): Promise<unknown>;
                cancelAll(query: { category: MidoriBybitCategory; symbol: string }): Promise<unknown>;
                /**
                 * Put a stop and a target on what is open, replacing what it had.
                 *
                 * `quantity` and `orders` are the spot half: spot protection is a resting
                 * sell over a stated number of base units, so the old one has to be named to
                 * be cancelled. A perpetual ignores both — its stop and target are attributes
                 * of the position, and setting them replaces whatever was there.
                 */
                setProtection(spec: {
                    category: MidoriBybitCategory;
                    symbol: string;
                    quantity?: number;
                    orders?: string[];
                    stopLoss?: number;
                    takeProfit?: number;
                }): Promise<unknown>;
                close(query: { category: MidoriBybitCategory; symbol: string }): Promise<unknown>;
            };
        };
    }
}
