/* Native window frame colours.
 *
 * Its own module so that both the window creation and the IPC handler can read
 * it without importing each other — main.js and ipc.js would otherwise form a
 * cycle just to share two colour pairs.
 *
 * These values mirror --bg and --txt from src/styles/tokens.css. When those
 * change, change these: the OS draws the frame and cannot read a stylesheet.
 */
export const TITLEBAR = {
  light: { color: '#f8fafc', symbolColor: '#0f172a' },
  dark: { color: '#070d16', symbolColor: '#eef2f7' },
};

export const TITLEBAR_HEIGHT = 40;

/** Applies a theme to a window's native frame. Throws on an unknown theme. */
export function applyTitleBarTheme(win, theme) {
  if (!TITLEBAR[theme]) {
    throw new Error(`Unknown theme "${theme}". Known: ${Object.keys(TITLEBAR).join(', ')}`);
  }
  if (!win || win.isDestroyed()) return false;

  win.setTitleBarOverlay({ ...TITLEBAR[theme], height: TITLEBAR_HEIGHT });
  // Also the colour behind the page, so a resize never flashes the old theme.
  win.setBackgroundColor(TITLEBAR[theme].color);
  return true;
}
