/**
 * How an open position is DRAWN — the one thing about a trade that is purely a matter of taste.
 *
 * Kept apart from the paper settings next door on purpose: those describe an account and change
 * what a trade costs, these change nothing at all except what you see. They also apply to a
 * replay and a paper account alike, because a position looks like a position either way.
 *
 * Every value is stated, none derived, so the whole style is one record to read, store and hand
 * to the indicator. Colours are plain CSS strings — whatever the settings dialog's picker hands
 * back — and the fills are built from them at draw time rather than stored twice.
 */

export type PositionLineStyle = 'solid' | 'dashed' | 'dotted';

export interface PositionStyle {
    /**
     * Run the zones and the entry line out to the right edge of the chart instead of stopping
     * at the last bar.
     *
     * Where a trade is going is ahead of it, not behind: a stop that stops being drawn at the
     * newest candle leaves the empty half of the screen — the half you are actually looking
     * into — with nothing in it.
     */
    extendRight: boolean;
    entryColor: string;
    stopColor: string;
    targetColor: string;
    /** How the two levels are stroked. The entry is stated separately because it is not a
     *  level anyone placed — it is where the trade already is. */
    levelStyle: PositionLineStyle;
    entryStyle: PositionLineStyle;
    /** Stroke width for the levels and the entry, in px. */
    lineWidth: number;
    /** Draw the risk/reward areas at all. */
    zones: boolean;
    /** How solid those areas are, 0–1, at their strongest. */
    zoneOpacity: number;
    /** Fade the area out towards the entry instead of filling it evenly. The colour then means
     *  distance from the level, which is the thing the area is about. */
    zoneGradient: boolean;
    /**
     * Mark the point every order actually filled on.
     *
     * A position says where the account IS; a fill says what it DID, and the two stop agreeing
     * the moment a trade is closed. On a chart being read back — a finished replay, a paper
     * account a week in — the marks are the only thing left of the trades. On a chart being
     * traded they are one more thing over the candles, which is why they come off in one click.
     */
    executions: boolean;
}

export const DEFAULT_POSITION_STYLE: PositionStyle = {
    extendRight: true,
    entryColor: '#b2b5be',
    stopColor: '#f23645',
    targetColor: '#089981',
    levelStyle: 'solid',
    entryStyle: 'dashed',
    lineWidth: 1,
    zones: true,
    zoneOpacity: 0.15,
    zoneGradient: true,
    executions: true,
};

const STORAGE_KEY = 'midorii-position-style';

/** The choices offered for the numeric settings — the dialog's host rows are text pickers,
 *  and a level's width is a choice between three answers, not a free number. */
export const LINE_WIDTHS = [1, 2, 3] as const;
export const ZONE_OPACITIES = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4] as const;

/** `0.15` → `15%`, for the dialog's dropdown. */
export function opacityLabel(value: number): string {
    return `${Math.round(value * 100)}%`;
}

/**
 * A colour at a given alpha.
 *
 * The zones are the position's own colours seen through a fixed transparency, so there is
 * nothing to store for them and nothing that can drift out of step with the lines. Handles the
 * `#rgb`/`#rrggbb` the picker returns and the `rgb()`/`rgba()` a hand-edited record might; an
 * unreadable colour is returned untouched rather than replaced, so a wrong colour looks wrong
 * instead of quietly turning into the default.
 */
export function withAlpha(color: string, alpha: number): string {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (hex) {
        const h = hex[1]!;
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        const n = Number.parseInt(full, 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})`;
    return color;
}

/**
 * Fill in whatever a stored record is missing, and refuse whatever it cannot mean.
 *
 * Same reasoning as the paper settings: storage is data from outside the program. Nothing here
 * can hurt an account, but a width of 400 or an opacity of 9 paints over the chart, and a
 * record from an older version simply has fewer fields than this one.
 */
export function normalizeStyle(raw: unknown): PositionStyle {
    const source = (raw ?? {}) as Partial<Record<keyof PositionStyle, unknown>>;
    const d = DEFAULT_POSITION_STYLE;
    const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
    const color = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value : fallback);
    const lineStyle = (value: unknown, fallback: PositionLineStyle): PositionLineStyle =>
        value === 'solid' || value === 'dashed' || value === 'dotted' ? value : fallback;
    const oneOf = (value: unknown, allowed: readonly number[], fallback: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return allowed.includes(n) ? n : fallback;
    };

    return {
        extendRight: bool(source.extendRight, d.extendRight),
        entryColor: color(source.entryColor, d.entryColor),
        stopColor: color(source.stopColor, d.stopColor),
        targetColor: color(source.targetColor, d.targetColor),
        levelStyle: lineStyle(source.levelStyle, d.levelStyle),
        entryStyle: lineStyle(source.entryStyle, d.entryStyle),
        lineWidth: oneOf(source.lineWidth, LINE_WIDTHS as readonly number[], d.lineWidth),
        zones: bool(source.zones, d.zones),
        zoneOpacity: oneOf(source.zoneOpacity, ZONE_OPACITIES as readonly number[], d.zoneOpacity),
        zoneGradient: bool(source.zoneGradient, d.zoneGradient),
        executions: bool(source.executions, d.executions),
    };
}

/** The style this machine last saved, or the defaults. Never throws. */
export function loadPositionStyle(): PositionStyle {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeStyle(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the position style', err);
        return { ...DEFAULT_POSITION_STYLE };
    }
}

/**
 * Everyone drawing positions right now, so a style saved on one screen reaches the chart
 * on another.
 *
 * There are two places to change this — the chart's own settings dialog and the Settings
 * tab — and only one place it is drawn. Without this the second screen would write a
 * record the chart does not read until it is remounted, which is a setting that appears
 * not to work rather than one that works late.
 */
type StyleListener = (style: PositionStyle) => void;
const listeners = new Set<StyleListener>();

/** Hear about every save, including this screen's own. Returns its own unsubscribe. */
export function onPositionStyleChange(listener: StyleListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Store it, and tell whoever is drawing. A storage failure is reported, never swallowed —
 *  and never fatal: the chart is repainted either way, so what is on screen is what was
 *  asked for even when the machine cannot remember it. */
export function savePositionStyle(style: PositionStyle): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
    } catch (err) {
        console.error('[midorii] could not persist the position style', err);
    }
    for (const listener of listeners) {
        try {
            listener(style);
        } catch (err) {
            console.error('[midorii] a position-style listener failed', err);
        }
    }
}
