/**
 * Which of the chart's floating cards are on the chart at all.
 *
 * Kept apart from the cards themselves for the same reason `quotes/quoteDisplay.ts` is kept
 * apart from a quote: what the account is worth is a fact, and this changes nothing about it
 * except whether it reaches the screen.
 *
 * This is the PERMANENT answer — somebody who trades from the ticket alone and reads the
 * account in the dock below has no use for the card and should not have to dismiss it every
 * session. The card's own close button is the other, temporary answer: it puts the card away
 * for as long as the chart is open and the corner's restore button brings it straight back.
 * Two controls because they answer two different questions, and a session-long dismissal
 * that survived a restart would read as the app losing the card.
 */

export interface OverlayDisplay {
    /** The equity/open/risk/cash card in the corner of the chart. */
    showAccount: boolean;
}

export const DEFAULT_OVERLAY_DISPLAY: OverlayDisplay = { showAccount: true };

const STORAGE_KEY = 'midorii-overlay-display';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizeOverlayDisplay(raw: unknown): OverlayDisplay {
    const source = (raw ?? {}) as Partial<Record<keyof OverlayDisplay, unknown>>;
    return {
        showAccount: typeof source.showAccount === 'boolean'
            ? source.showAccount
            : DEFAULT_OVERLAY_DISPLAY.showAccount,
    };
}

/** What this machine last saved, or the defaults. Never throws. */
export function loadOverlayDisplay(): OverlayDisplay {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeOverlayDisplay(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the chart card settings', err);
        return { ...DEFAULT_OVERLAY_DISPLAY };
    }
}

type DisplayListener = (display: OverlayDisplay) => void;
const listeners = new Set<DisplayListener>();

/** Hear about every save, so a card already on a chart goes away as the switch is thrown.
 *  Returns its own unsubscribe. */
export function onOverlayDisplayChange(listener: DisplayListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Store it, and tell whichever charts are already open. A storage failure is reported,
 *  never swallowed — and never fatal: the cards are updated either way, so what is on
 *  screen is what was asked for even when the machine cannot remember it. */
export function saveOverlayDisplay(display: OverlayDisplay): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
    } catch (err) {
        console.error('[midorii] could not persist the chart card settings', err);
    }
    for (const listener of listeners) {
        try {
            listener(display);
        } catch (err) {
            console.error('[midorii] a chart card listener failed', err);
        }
    }
}
