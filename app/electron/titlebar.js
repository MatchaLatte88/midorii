/* Native window background colours.
 *
 * Its own module so that both the window creation and the IPC handler can read
 * it without importing each other — main.js and ipc.js would otherwise form a
 * cycle just to share it.
 *
 * The title bar itself is drawn entirely in the renderer now (app-topbar, in
 * app/renderer/shell/appTopbar.ts) — there is no native overlay left to theme.
 * What is left here is just the window's paint colour, so a resize or a theme
 * switch never flashes the other theme's colour before the page repaints.
 */
export const TITLEBAR = {
  light: '#f8fafc',
  dark: '#070d16',
};

/** The custom title bar's height — mirrored in app/renderer/index.html's `--app-topbar-h`. */
export const TITLEBAR_HEIGHT = 40;

/** A `#rgb`/`#rrggbb` colour, which is all `setBackgroundColor` is being trusted with. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Applies a theme to a window's background colour. Throws on an unknown theme.
 *
 * `background` is the renderer naming the exact colour it is about to paint — the app has
 * more palettes than the two defaults above, and this colour is only ever seen NEXT TO the
 * painted page (during a resize, and in the moment before the first paint), so being one
 * palette out is visible. Anything that is not a plain hex colour is ignored rather than
 * refused: the window keeps the theme's default, which is never wrong enough to fail a
 * theme switch over.
 */
export function applyTitleBarTheme(win, theme, background) {
  if (!TITLEBAR[theme]) {
    throw new Error(`Unknown theme "${theme}". Known: ${Object.keys(TITLEBAR).join(', ')}`);
  }
  if (!win || win.isDestroyed()) return false;

  win.setBackgroundColor(HEX.test(background ?? '') ? background : TITLEBAR[theme]);
  return true;
}
