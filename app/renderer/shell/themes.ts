import { mix } from '../../../src/core/color';
import { DARK_THEME, LIGHT_THEME } from '../../../src/core/theme';
import type { VelaTheme } from '../../../src/core/options';

/**
 * The palettes this app can wear.
 *
 * Two dimensions, not one. A STYLE is a look — which colours the program is made of. A
 * THEME is that look at one of two lightnesses. They are kept apart because they are chosen
 * for different reasons: the style is a taste, set once and forgotten, while dark and light
 * are switched by the time of day, which is why the switch for it sits in the title bar and
 * the style lives on the Settings tab.
 *
 * Every style is a pair of {@link VelaTheme}s, which is the same object the chart itself is
 * themed with — so a style is not a second skin bolted over the app, it IS the chart theme,
 * and every panel, dialog and menu follows it because they all derive from those tokens.
 *
 * The greys are mixed rather than typed
 * -------------------------------------
 * A grid line and a border are a wash of ink over the background at a stated strength, and
 * writing them as hexes hides that relationship — the next person changing the background
 * has no way to see which other four values were chosen against it. `mix` states it.
 */

export type AppThemeName = 'dark' | 'light';

/** Which palette the app is wearing. `midorii` is what it has always looked like. */
export type AppStyle = 'midorii' | 'katsumii';

export interface AppStyleInfo {
    label: string;
    /** One line for the Settings row — what picking it changes. */
    hint: string;
    dark: VelaTheme;
    light: VelaTheme;
}

/* ── Katsumii ─────────────────────────────────────────────────────────────
 *
 * Taken from katsumii.com's own stylesheet, whose design tokens are named in the comments
 * beside each value. What is NOT taken: the candles, which stay the app's own green and red
 * (a style changes what surrounds a chart, never what the chart is saying), and the type —
 * the site is set in Manrope, which this app does not ship and will not fetch, being one
 * that works with no network at all.
 */

/** `--v6-bg` dark: the near-black navy the site's dark mode is built on. */
const KATSUMII_NIGHT = '#070d16';
/** `--v6-bg` light: barely-tinted paper (Tailwind slate-50), which the site uses whole. */
const KATSUMII_PAPER = '#f8fafc';
/** `--v6-ink` light — and the ink the light greys below are washes of. */
const KATSUMII_INK = '#0f172a';
/** `--v6-muted` dark: the site's dark body text, and this palette's axis ink. */
const KATSUMII_HAZE = '#94a3b8';
/** What the dark greys are washes of — the site's own line colour is this at 8%. */
const KATSUMII_MIST = '#e2e8f0';
/**
 * `--v6-gold`, the site's accent, in the one shade that carries white text.
 *
 * The site's dark mode accents in cyan (`#22d3ee`) and its light mode in this deep sky
 * blue. Here the deep one is the accent in BOTH, because an accent is a fill with a label
 * on it — a primary button, a selected row — and white on cyan cannot be read. The cyan is
 * not lost: it is the bright partner below, which is only ever a line or a lit switch.
 */
const KATSUMII_DEEP = '#0369a1';
/** `--v6-gold-hi` dark: the signature cyan, on the dark palette's switches and underlines. */
const KATSUMII_CYAN = '#22d3ee';
/** `--v6-gold-hi` light: on paper the higher-contrast partner is DARKER, not brighter. */
const KATSUMII_ABYSS = '#075985';

const KATSUMII_DARK: VelaTheme = {
    background: KATSUMII_NIGHT,
    textColor: KATSUMII_HAZE,
    gridColor: mix(KATSUMII_NIGHT, KATSUMII_MIST, 0.08),
    borderColor: mix(KATSUMII_NIGHT, KATSUMII_MIST, 0.2),
    upColor: DARK_THEME.upColor,
    downColor: DARK_THEME.downColor,
    fontFamily: DARK_THEME.fontFamily,
    accent: KATSUMII_DEEP,
    accentBright: KATSUMII_CYAN,
};

const KATSUMII_LIGHT: VelaTheme = {
    background: KATSUMII_PAPER,
    textColor: KATSUMII_INK,
    // Stronger than the border, as the app's own light theme has it: on paper a grid needs
    // more ink to register at all than an edge does.
    gridColor: mix(KATSUMII_PAPER, KATSUMII_INK, 0.2),
    borderColor: mix(KATSUMII_PAPER, KATSUMII_INK, 0.12),
    upColor: LIGHT_THEME.upColor,
    downColor: LIGHT_THEME.downColor,
    fontFamily: LIGHT_THEME.fontFamily,
    accent: KATSUMII_DEEP,
    accentBright: KATSUMII_ABYSS,
};

export const STYLES: Record<AppStyle, AppStyleInfo> = {
    midorii: {
        label: 'Midorii',
        hint: 'The app’s own: neutral graphite, and the blue accent Vela ships with.',
        dark: DARK_THEME,
        light: LIGHT_THEME,
    },
    katsumii: {
        label: 'Katsumii',
        hint: 'Deep navy and slate paper, accented in sky and cyan — after katsumii.com.',
        dark: KATSUMII_DARK,
        light: KATSUMII_LIGHT,
    },
};

/** The styles as a settings dropdown reads them, in the order they are offered. */
export const STYLE_OPTIONS: ReadonlyArray<{ value: AppStyle; label: string }> = (
    Object.entries(STYLES) as Array<[AppStyle, AppStyleInfo]>
).map(([value, info]) => ({ value, label: info.label }));

export function isAppStyle(value: unknown): value is AppStyle {
    return value === 'midorii' || value === 'katsumii';
}

/** The palette to hand the chart, the kit and the window for one style at one lightness. */
export function paletteOf(style: AppStyle, theme: AppThemeName): VelaTheme {
    return STYLES[style][theme];
}
