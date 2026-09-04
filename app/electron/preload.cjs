const { contextBridge, ipcRenderer } = require('electron');

/* The renderer sees exactly this and nothing else — no ipcRenderer, no Node.
 *
 * Only namespaces with handlers behind them are exposed: drawings/backtest/sweep
 * and ui come back once their IPC handlers exist. Exposing a method with nothing
 * behind it fails with a confusing "no handler registered" instead of being
 * plainly absent.
 */
contextBridge.exposeInMainWorld('midori', {
  data: {
    datasets: () => ipcRenderer.invoke('data:datasets'),
    meta: (symbol) => ipcRenderer.invoke('data:meta', symbol),
    /** The venues bars can be downloaded from — id, label, and how each names a market. */
    sources: () => ipcRenderer.invoke('data:sources'),
    symbols: (source) => ipcRenderer.invoke('data:symbols', source),
    bars: (query) => ipcRenderer.invoke('data:bars', query),
    download: (request) => ipcRenderer.invoke('data:download', request),

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
});
