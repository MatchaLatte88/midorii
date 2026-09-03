const { contextBridge, ipcRenderer } = require('electron');

/* The renderer sees exactly this and nothing else — no ipcRenderer, no Node.
 *
 * Walking-skeleton scope: only the `data` namespace. drawings/backtest/replay/
 * sweep/ui come back once their IPC handlers exist (see the migration plan) —
 * exposing a method with no handler behind it would fail silently with a
 * confusing "no handler registered" instead of a clear "not built yet".
 */
contextBridge.exposeInMainWorld('midori', {
  data: {
    datasets: () => ipcRenderer.invoke('data:datasets'),
    meta: (symbol) => ipcRenderer.invoke('data:meta', symbol),
    symbols: () => ipcRenderer.invoke('data:symbols'),
    bars: (query) => ipcRenderer.invoke('data:bars', query),
  },
});
