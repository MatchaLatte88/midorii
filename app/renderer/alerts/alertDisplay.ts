/**
 * How an alert is DRAWN — the part of it that is purely a matter of taste.
 *
 * Kept apart from the alert itself for the same reason `trading/positionStyle.ts` is kept
 * apart from the paper settings: an alert's level, condition and message describe what it
 * WATCHES and change when it fires; this changes nothing except what you see. It is one
 * setting shared by every alert rather than a field on each, because a chart where some
 * tags carry their price and others do not is not a preference, it is a mess.
 */

/** The tag riding an alert's line: `Alert 111234.57`, or `Breakout (111234.57)` with a label. */
export interface AlertDisplay {
    /**
     * Repeat the level inside the line's own tag.
     *
     * Off, the tag says only what the alert IS — its label, or the bare word `Alert` — and
     * the price is left to the axis, where the position and its two levels already leave
     * theirs (see `replay/replayIndicator.ts`). The line has not moved and the alert still
     * fires at exactly the same price; the number is simply not said twice.
     */
    showLevel: boolean;
}

export const DEFAULT_ALERT_DISPLAY: AlertDisplay = { showLevel: true };

const STORAGE_KEY = 'midorii-alert-display';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizeAlertDisplay(raw: unknown): AlertDisplay {
    const source = (raw ?? {}) as Partial<Record<keyof AlertDisplay, unknown>>;
    return {
        showLevel: typeof source.showLevel === 'boolean' ? source.showLevel : DEFAULT_ALERT_DISPLAY.showLevel,
    };
}

/** What this machine last saved, or the defaults. Never throws. */
export function loadAlertDisplay(): AlertDisplay {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeAlertDisplay(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the alert display settings', err);
        return { ...DEFAULT_ALERT_DISPLAY };
    }
}

type DisplayListener = (display: AlertDisplay) => void;
const listeners = new Set<DisplayListener>();

/** Hear about every save, so the lines on the chart are redrawn by whoever owns them.
 *  Returns its own unsubscribe. */
export function onAlertDisplayChange(listener: DisplayListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Store it, and tell whoever is drawing. A storage failure is reported, never swallowed —
 *  and never fatal: the chart is repainted either way, so what is on screen is what was
 *  asked for even when the machine cannot remember it. */
export function saveAlertDisplay(display: AlertDisplay): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
    } catch (err) {
        console.error('[midorii] could not persist the alert display settings', err);
    }
    for (const listener of listeners) {
        try {
            listener(display);
        } catch (err) {
            console.error('[midorii] an alert display listener failed', err);
        }
    }
}
