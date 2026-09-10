/** Windows whose renderer has finished its asynchronous shutdown work. */
const closeApproved = new WeakSet();

/**
 * Hold a window close long enough for the renderer to flush bot accounts.
 *
 * BrowserWindow's `close` event is the one path shared by the title-bar button, Alt+F4 and
 * app shutdown. The timeout is a crash escape hatch: a renderer that never answers must not
 * make the desktop process impossible to close.
 */
export function guardWindowClose(win, timeoutMs = 10_000) {
  let requested = false;
  let fallback = null;
  win.on('close', (event) => {
    if (closeApproved.has(win) || win.webContents.isDestroyed()) return;
    event.preventDefault();
    if (requested) return;
    requested = true;
    win.webContents.send('window:close-requested');
    fallback = setTimeout(() => {
      if (win.isDestroyed()) return;
      approveWindowClose(win);
    }, timeoutMs);
  });
  win.on('closed', () => {
    if (fallback != null) clearTimeout(fallback);
  });
}

/** Release a guarded window once its renderer has completed shutdown. */
export function approveWindowClose(win) {
  closeApproved.add(win);
  win.close();
}
