const { contextBridge, ipcRenderer } = require('electron');

/* The renderer sees exactly this and nothing else — no ipcRenderer, no Node.
 *
 * Only namespaces with handlers behind them are exposed: drawings come back once
 * their IPC handlers exist. Exposing a method with nothing behind it fails with a
 * confusing "no handler registered" instead of being plainly absent.
 */
contextBridge.exposeInMainWorld('midori', {
  /** `'darwin'` gets native traffic lights; everywhere else draws its own window
   *  controls in the app topbar (see app/renderer/shell/appTopbar.ts). */
  platform: process.platform,

  ui: {
    /* `background` is the palette's own surface colour. The name alone was enough while
       there were two palettes; there are more now, and the window's paint colour — what
       shows during a resize and before the page has painted — has to be the one the page
       is about to paint. Omitted, the main process falls back to the name's default. */
    setTheme: (theme, background) => ipcRenderer.invoke('ui:set-theme', theme, background),
  },

  /** What the custom title bar's own minimize/maximize/close buttons call — a
   *  renderer cannot reach a BrowserWindow directly. */
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    readyToClose: () => ipcRenderer.send('window:close-ready'),
    onCloseRequested: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('window:close-requested', listener);
      return () => ipcRenderer.off('window:close-requested', listener);
    },
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    /* Fires on every maximize/restore, including ones Windows makes on its own
     * (Aero Snap, a double-click on the drag region) — the maximize button's
     * glyph has no other way to learn about those. Returns its own unsubscribe. */
    onMaximizedChange: (handler) => {
      const listener = (_event, maximized) => handler(maximized);
      ipcRenderer.on('window:maximized-changed', listener);
      return () => ipcRenderer.off('window:maximized-changed', listener);
    },
    /** Bring the window to the front from a minimized/background state — what a
     *  triggered alert's notification calls on click. */
    restore: () => ipcRenderer.send('window:restore'),
  },

  data: {
    datasets: () => ipcRenderer.invoke('data:datasets'),
    meta: (symbol) => ipcRenderer.invoke('data:meta', symbol),
    /** The venues bars can be downloaded from — id, label, and how each names a market. */
    sources: () => ipcRenderer.invoke('data:sources'),
    symbols: (source) => ipcRenderer.invoke('data:symbols', source),
    bars: (query) => ipcRenderer.invoke('data:bars', query),
    download: (request) => ipcRenderer.invoke('data:download', request),
    /** Fills in whatever a range is missing at either end, then reports the coverage —
     *  what the Backtest tab calls before running against a venue. */
    ensure: (request) => ipcRenderer.invoke('data:ensure', request),
    /** Removes a dataset. What every "remove it first" refusal points at. */
    delete: (symbol) => ipcRenderer.invoke('data:delete', symbol),

    /* Importing a CSV, in two steps: the picker reports what the file looks like, the
     * import runs under whatever the dialog corrected. inspectCsv re-reads the same file
     * after a delimiter change, since every other guess follows from it. */
    pickCsv: () => ipcRenderer.invoke('data:pick-csv'),
    inspectCsv: (request) => ipcRenderer.invoke('data:inspect-csv', request),
    importCsv: (request) => ipcRenderer.invoke('data:import-csv', request),

    /* Progress is pushed rather than polled: a download is hundreds of calls
     * long and the renderer wants each one as it lands. Returns its own
     * unsubscribe — the listener outlives the invoke, so nothing else would
     * ever take it off again. */
    onDownloadProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('data:download-progress', listener);
      return () => ipcRenderer.off('data:download-progress', listener);
    },
  },

  replay: {
    /** Stores a finished session as a run, in the same library a backtest lands in. */
    save: (request) => ipcRenderer.invoke('replay:save', request),

    /* A session that is not finished yet: the account and the clock, without
     * the bars. Saving again replaces the same entry, so putting one down
     * twice does not litter the list. */
    saveSession: (request) => ipcRenderer.invoke('replay:saveSession', request),
    sessions: () => ipcRenderer.invoke('replay:sessions'),
    loadSession: (id) => ipcRenderer.invoke('replay:loadSession', id),
    deleteSession: (id) => ipcRenderer.invoke('replay:deleteSession', id),
  },

  /* The paper account — one record, not a library. Read when paper trading is
     switched on, written whenever the account moves, cleared when it is started
     over. A FINISHED one goes to `replay.save` instead, onto the run shelf. */
  paper: {
    load: () => ipcRenderer.invoke('paper:load'),
    save: (account) => ipcRenderer.invoke('paper:save', account),
    clear: () => ipcRenderer.invoke('paper:clear'),
  },

  /* A finished backtest. The run itself happens in the renderer, where the detectors
     live; only the result crosses the bridge, onto the same shelf a replay lands on. */
  backtest: {
    save: (request) => ipcRenderer.invoke('backtest:save', request),
  },

  /* What each strategy is set to. Configuration rather than a result: the Strategies tab
     writes it, the Backtest tab starts from it. */
  strategies: {
    load: () => ipcRenderer.invoke('strategies:load'),
    save: (id, params) => ipcRenderer.invoke('strategies:save', id, params),
    reset: (id) => ipcRenderer.invoke('strategies:reset', id),
  },

  /* A finished parameter sweep — a ranking of settings, not an account. Its own shelf
     beside the runs, read on the same Analysis screen. */
  sweep: {
    save: (request) => ipcRenderer.invoke('sweep:save', request),
    list: () => ipcRenderer.invoke('sweep:list'),
    load: (id) => ipcRenderer.invoke('sweep:load', id),
    delete: (id) => ipcRenderer.invoke('sweep:delete', id),
    annotate: (id, note) => ipcRenderer.invoke('sweep:annotate', id, note),
  },

  /* Price alerts — one flat list, read at startup and rewritten whenever it changes. */
  alerts: {
    load: () => ipcRenderer.invoke('alerts:load'),
    save: (alerts) => ipcRenderer.invoke('alerts:save', alerts),
  },

  /* Trading bots — their definitions, round-tripped whole like the alerts. A bot's live
     state is not stored: it is rebuilt from the market's own history when the bot starts. */
  bots: {
    load: () => ipcRenderer.invoke('bots:load'),
    save: (bots) => ipcRenderer.invoke('bots:save', bots),

    /* Each bot's durable account, guard, and live-ownership state, keyed by the bot. */
    account: {
      load: (id) => ipcRenderer.invoke('botAccount:load', id),
      save: (id, account) => ipcRenderer.invoke('botAccount:save', id, account),
      clear: (id) => ipcRenderer.invoke('botAccount:clear', id),
      /** Remove accounts whose bot no longer exists. */
      sweep: (keep) => ipcRenderer.invoke('botAccount:sweep', keep),
    },
  },

  /* Finished runs — every session that was played to the end, and in time
   * every backtest, on one shelf. Listing hands back summaries; `load` opens
   * the one being looked at, with its trades and equity curve. */
  runs: {
    list: () => ipcRenderer.invoke('runs:list'),
    load: (id) => ipcRenderer.invoke('runs:load', id),
    delete: (id) => ipcRenderer.invoke('runs:delete', id),
    annotate: (id, note) => ipcRenderer.invoke('runs:annotate', id, note),
  },

  /* The live trading journal — every trade taken on a real account, kept by Midorii
     itself because the venue serves at most a day of history per request and loses it
     entirely with the account. */
  live: {
    trades: () => ipcRenderer.invoke('live:trades'),
    append: (trade) => ipcRenderer.invoke('live:append', trade),
    settle: (patch) => ipcRenderer.invoke('live:settle', patch),
    clear: () => ipcRenderer.invoke('live:clear'),
  },

  /** Capital.com forex/CFD data — the session (login, keepalive, the WebSocket)
   *  lives in the main process; see app/renderer/providers/CapitalProvider.ts. */
  capital: {
    configured: () => ipcRenderer.invoke('capital:configured'),
    /* Credential management. The secret goes IN and never comes back out — there is
       deliberately no channel that returns the key or the password. */
    credentials: {
      status: () => ipcRenderer.invoke('capital:credentials-status'),
      test: (creds) => ipcRenderer.invoke('capital:credentials-test', creds),
      save: (creds) => ipcRenderer.invoke('capital:credentials-save', creds),
      clear: () => ipcRenderer.invoke('capital:credentials-clear'),
    },
    environment: () => ipcRenderer.invoke('capital:environment'),
    markets: (searchTerm) => ipcRenderer.invoke('capital:markets', searchTerm),
    marketInfo: (epic) => ipcRenderer.invoke('capital:market-info', epic),
    prices: (query) => ipcRenderer.invoke('capital:prices', query),
    subscribe: (query) => ipcRenderer.invoke('capital:subscribe', query),
    unsubscribe: (subscriptionId) => ipcRenderer.invoke('capital:unsubscribe', subscriptionId),
    /* Pushed per subscription id — the renderer matches it to the `subscribe()`
     * call that started it. Returns its own unsubscribe. */
    onOhlc: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('capital:ohlc', listener);
      return () => ipcRenderer.off('capital:ohlc', listener);
    },
    /* Trading. Each of these resolves with what the venue CONFIRMED, not with the
     * receipt it gave for the instruction — see app/electron/data/capital.js. */
    account: () => ipcRenderer.invoke('capital:account'),
    positions: () => ipcRenderer.invoke('capital:positions'),
    openPosition: (spec) => ipcRenderer.invoke('capital:open-position', spec),
    amendPosition: (spec) => ipcRenderer.invoke('capital:amend-position', spec),
    closePosition: (dealId) => ipcRenderer.invoke('capital:close-position', dealId),
    workingOrders: () => ipcRenderer.invoke('capital:working-orders'),
    createOrder: (spec) => ipcRenderer.invoke('capital:create-order', spec),
    amendOrder: (spec) => ipcRenderer.invoke('capital:amend-order', spec),
    cancelOrder: (dealId) => ipcRenderer.invoke('capital:cancel-order', dealId),
    /** The two ledgers a finished trade's real cost is joined from. */
    history: (window) => ipcRenderer.invoke('capital:history', window),
    subscribeQuotes: (query) => ipcRenderer.invoke('capital:subscribe-quotes', query),
    unsubscribeQuotes: (subscriptionId) => ipcRenderer.invoke('capital:unsubscribe-quotes', subscriptionId),
    onQuote: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('capital:quote', listener);
      return () => ipcRenderer.off('capital:quote', listener);
    },
  },

  /** ProjectX futures data — the session, the SignalR socket and the tick-to-bar
   *  aggregation live in the main process; see app/electron/data/projectx.js. */
  projectx: {
    configured: () => ipcRenderer.invoke('projectx:configured'),
    /* Same rule as every other venue here: the key goes IN and never comes back out. */
    credentials: {
      status: () => ipcRenderer.invoke('projectx:credentials-status'),
      test: (creds) => ipcRenderer.invoke('projectx:credentials-test', creds),
      save: (creds) => ipcRenderer.invoke('projectx:credentials-save', creds),
      clear: () => ipcRenderer.invoke('projectx:credentials-clear'),
    },
    environment: () => ipcRenderer.invoke('projectx:environment'),
    accounts: (onlyActive) => ipcRenderer.invoke('projectx:accounts', onlyActive),
    contracts: (searchText) => ipcRenderer.invoke('projectx:contracts', searchText),
    bars: (query) => ipcRenderer.invoke('projectx:bars', query),
    subscribe: (query) => ipcRenderer.invoke('projectx:subscribe', query),
    unsubscribe: (subscriptionId) => ipcRenderer.invoke('projectx:unsubscribe', subscriptionId),
    /* Pushed per subscription id, like the Capital.com feeds. The bar is the one being
     * BUILT from the tape, re-sent on every print rather than only when it closes. */
    onBar: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:bar', listener);
      return () => ipcRenderer.off('projectx:bar', listener);
    },
    subscribeQuotes: (query) => ipcRenderer.invoke('projectx:subscribe-quotes', query),
    unsubscribeQuotes: (subscriptionId) => ipcRenderer.invoke('projectx:unsubscribe-quotes', subscriptionId),
    onQuote: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('projectx:quote', listener);
      return () => ipcRenderer.off('projectx:quote', listener);
    },
  },

  /** Binance Spot Demo. The base URL is fixed in the main process, and the secret has no
   *  renderer-facing read method. */
  binanceSpot: {
    environment: () => ipcRenderer.invoke('binance-spot:environment'),
    credentials: {
      status: () => ipcRenderer.invoke('binance-spot:credentials-status'),
      test: (creds) => ipcRenderer.invoke('binance-spot:credentials-test', creds),
      save: (creds) => ipcRenderer.invoke('binance-spot:credentials-save', creds),
      clear: () => ipcRenderer.invoke('binance-spot:credentials-clear'),
    },
    symbolInfo: (symbol) => ipcRenderer.invoke('binance-spot:symbol-info', symbol),
    account: () => ipcRenderer.invoke('binance-spot:account'),
    openOrders: (symbol) => ipcRenderer.invoke('binance-spot:open-orders', symbol),
    trades: (symbol) => ipcRenderer.invoke('binance-spot:trades', symbol),
    placeOrder: (spec) => ipcRenderer.invoke('binance-spot:place-order', spec),
    cancelOrder: (spec) => ipcRenderer.invoke('binance-spot:cancel-order', spec),
    cancelAll: (symbol) => ipcRenderer.invoke('binance-spot:cancel-all', symbol),
    replaceProtection: (spec) => ipcRenderer.invoke('binance-spot:replace-protection', spec),
    close: (symbol) => ipcRenderer.invoke('binance-spot:close', symbol),
  },

  /** Bybit V5 — spot pairs and USDT perpetuals, on the demo host or the live one. Which of
   *  the two is stored with the key; no call here can choose it. */
  bybit: {
    environment: () => ipcRenderer.invoke('bybit:environment'),
    credentials: {
      status: () => ipcRenderer.invoke('bybit:credentials-status'),
      test: (creds) => ipcRenderer.invoke('bybit:credentials-test', creds),
      save: (creds) => ipcRenderer.invoke('bybit:credentials-save', creds),
      clear: () => ipcRenderer.invoke('bybit:credentials-clear'),
    },
    instrument: (query) => ipcRenderer.invoke('bybit:instrument', query),
    /** Public candles, oldest first — what the chart provider draws from. */
    klines: (query) => ipcRenderer.invoke('bybit:klines', query),
    wallet: () => ipcRenderer.invoke('bybit:wallet'),
    positions: (symbol) => ipcRenderer.invoke('bybit:positions', symbol),
    openOrders: (query) => ipcRenderer.invoke('bybit:open-orders', query),
    executions: (query) => ipcRenderer.invoke('bybit:executions', query),
    placeOrder: (spec) => ipcRenderer.invoke('bybit:place-order', spec),
    cancelOrder: (spec) => ipcRenderer.invoke('bybit:cancel-order', spec),
    cancelAll: (query) => ipcRenderer.invoke('bybit:cancel-all', query),
    setProtection: (spec) => ipcRenderer.invoke('bybit:set-protection', spec),
    close: (query) => ipcRenderer.invoke('bybit:close', query),
  },
});
