/**
 * The app's own preferences — the handful of choices that belong to the program rather
 * than to a chart, an account or a strategy.
 *
 * Everything else already has a home: what a position looks like is in `positionStyle`,
 * what a paper account is charged is in `paperSettings`, what a strategy is set to is on
 * disk beside the runs. This file is for what was left over, and it is deliberately thin —
 * a preference that belongs to something is better stored with that thing, where whoever
 * reads it can also see what it means.
 *
 * localStorage rather than the run shelf: these describe THIS machine's copy of the app.
 * Nothing here is worth a round trip through the main process, and nothing here is worth
 * failing a start-up over — a storage error is reported and answered with the defaults.
 */

import { isAppStyle, type AppStyle } from '../shell/themes';

/** The views the app may open on. Replay is not among them: it asks a setup question
 *  first, and a program that opens on a dialog nobody asked for is a program that has
 *  to be dismissed before it can be used. */
export const STARTUP_TABS = [
    { value: 'chart', label: 'Chart' },
    { value: 'backtest', label: 'Backtest' },
    { value: 'analysis', label: 'Analysis' },
    { value: 'strategies', label: 'Strategies' },
] as const;

export type StartupTab = typeof STARTUP_TABS[number]['value'];

export interface AppPrefs {
    /** Which view a fresh window lands on. */
    startupTab: StartupTab;
    /**
     * Which palette the app wears. Dark or light is NOT part of it — that is the same
     * style at the other lightness, and it is switched from the title bar rather than
     * from here (see shell/themes).
     */
    style: AppStyle;
    /** Enables the private, chart-only global data bridge after the next restart. */
    experimentalMarketFeed: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
    startupTab: 'chart',
    style: 'midorii',
    experimentalMarketFeed: false,
};

const STORAGE_KEY = 'midorii-prefs';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizePrefs(raw: unknown): AppPrefs {
    const source = (raw ?? {}) as Partial<Record<keyof AppPrefs, unknown>>;
    const startupTab = STARTUP_TABS.some((t) => t.value === source.startupTab)
        ? source.startupTab as StartupTab
        : DEFAULT_PREFS.startupTab;
    const style = isAppStyle(source.style) ? source.style : DEFAULT_PREFS.style;
    const experimentalMarketFeed = source.experimentalMarketFeed === true;
    return { startupTab, style, experimentalMarketFeed };
}

/** What this machine last saved, or the defaults. Never throws. */
export function loadPrefs(): AppPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizePrefs(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the app preferences', err);
        return { ...DEFAULT_PREFS };
    }
}

/** Store them. A storage failure is reported, never swallowed — and never fatal. */
export function savePrefs(prefs: AppPrefs): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) {
        console.error('[midorii] could not persist the app preferences', err);
    }
}
