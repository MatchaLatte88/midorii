/**
 * Which of the chart's floating cards this app puts on a chart at all.
 *
 * One switch per card, in one place, because "what is allowed to float over my chart" is a
 * single question. The bid/ask card is the exception and answers under `quotes/quoteDisplay`
 * instead: it is one of three ways of showing the same two-sided price, and separating the
 * card from the lines and the scale tags would leave that setting explaining two thirds of
 * itself.
 *
 * Kept apart from the cards themselves for the same reason `quotes/quoteDisplay.ts` is kept
 * apart from a quote: what the account is worth is a fact, and this changes nothing about it
 * except whether it reaches the screen.
 *
 * The card's own close button also survives a restart, so this is not "permanent" against a
 * temporary one — the two differ in what they leave behind. A closed card leaves the restore
 * button in the corner, which is the chart saying something is put away and offering it back
 * in one press. Switched off here, the card leaves nothing at all: no button, no trace, and
 * the corner belongs to whatever else wants it. "Not right now" and "not at all", and only
 * the second one is worth walking to Settings for.
 */

export interface OverlayDisplay {
    /** The equity/open/risk/cash card a replay or a paper account puts in the corner. */
    showAccount: boolean;
    /** Buy / size / Sell, floating on the chart. The panel at the side is the other way in. */
    showQuick: boolean;
    /**
     * The band a live venue account puts on the chart: which account it is, what it is worth,
     * and Close all.
     *
     * Off by choice and not lightly. That band is where "this is real money" is said out loud,
     * and it carries the one control that must never be more than a press away — so switching
     * it off means trading a live account with neither on the chart. Everything it does is
     * available elsewhere (the Trade menu names the account, the panel beside the chart
     * flattens), which is the only reason this is offered at all.
     */
    showLive: boolean;
}

export const DEFAULT_OVERLAY_DISPLAY: OverlayDisplay = {
    showAccount: true,
    showQuick: true,
    showLive: true,
};

const STORAGE_KEY = 'midorii-overlay-display';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizeOverlayDisplay(raw: unknown): OverlayDisplay {
    const source = (raw ?? {}) as Partial<Record<keyof OverlayDisplay, unknown>>;
    const bool = (value: unknown, fallback: boolean): boolean => (
        typeof value === 'boolean' ? value : fallback
    );
    const d = DEFAULT_OVERLAY_DISPLAY;
    return {
        showAccount: bool(source.showAccount, d.showAccount),
        showQuick: bool(source.showQuick, d.showQuick),
        showLive: bool(source.showLive, d.showLive),
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
