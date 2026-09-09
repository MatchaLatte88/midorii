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

    /* Each bot's own paper account, keyed by the bot. Its own namespace rather than
       `paper`, which holds the one account the Chart tab trades — a bot never shares that,
       so hand-placed trades and automated ones are never in one ledger. */
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
});
