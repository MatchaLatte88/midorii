/**
 * Which of the trade panel's optional tabs this app offers.
 *
 * Kept apart from the panel for the same reason `overlayDisplay.ts` is kept apart from the
 * cards: an account keeps its ladder whether or not somebody wants the tab, and this changes
 * nothing about that except whether it reaches the screen. One setting for every account —
 * a tab that is there on one venue and gone on the next is not a preference, it is a surprise.
 */

export interface SidebarDisplay {
    /** The Ladder tab, on an account that has one. */
    showLadder: boolean;
}

export const DEFAULT_SIDEBAR_DISPLAY: SidebarDisplay = { showLadder: true };

const STORAGE_KEY = 'midorii-sidebar-display';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizeSidebarDisplay(raw: unknown): SidebarDisplay {
    const source = (raw ?? {}) as Partial<Record<keyof SidebarDisplay, unknown>>;
    return {
        showLadder: typeof source.showLadder === 'boolean' ? source.showLadder : DEFAULT_SIDEBAR_DISPLAY.showLadder,
    };
}

/** What this machine last saved, or the defaults. Never throws. */
export function loadSidebarDisplay(): SidebarDisplay {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeSidebarDisplay(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the trade panel settings', err);
        return { ...DEFAULT_SIDEBAR_DISPLAY };
    }
}

type DisplayListener = (display: SidebarDisplay) => void;
const listeners = new Set<DisplayListener>();

/** Hear about every save, so a panel already open changes as the switch is thrown.
 *  Returns its own unsubscribe. */
export function onSidebarDisplayChange(listener: DisplayListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Store it, and tell whichever panels are open. A storage failure is reported, never
 *  swallowed — and never fatal: the panels are updated either way. */
export function saveSidebarDisplay(display: SidebarDisplay): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
    } catch (err) {
        console.error('[midorii] could not persist the trade panel settings', err);
    }
    for (const listener of listeners) {
        try {
            listener(display);
        } catch (err) {
            console.error('[midorii] a trade panel listener failed', err);
        }
    }
}
