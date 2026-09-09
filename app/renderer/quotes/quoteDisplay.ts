/**
 * How the two-sided price is SHOWN — purely a matter of taste, and off in three pieces.
 *
 * Kept apart from the quote itself for the same reason `alerts/alertDisplay.ts` is kept
 * apart from an alert: what the venue is quoting is a fact, and this changes nothing about
 * it except what reaches the screen. One setting shared by every market rather than one per
 * symbol — a chart that shows the spread on one instrument and hides it on the next is not
 * a preference, it is a surprise.
 *
 * Three pieces because they cost different things to look at. The card is a corner of the
 * chart; the lines cross the whole plot and sit right where the candles are; the brackets
 * take up room on the price scale, which is the busiest strip on the chart. Somebody who
 * wants the spread as a number but not as two lines through their candles is not being
 * fussy — and today that person has to choose between the lot and nothing.
 */

export interface QuoteDisplay {
    /** The bid/ask/spread card in the corner of the chart. */
    showCard: boolean;
    /** Bid and ask as levels across the plot. */
    showLines: boolean;
    /**
     * Chip each line's price against the price scale.
     *
     * Rides on {@link showLines}: a bracket is a label on a line, so lines off means no
     * brackets to place, whatever this says. Turning it off on its own leaves the two levels
     * visible with the scale left to the price it already shows.
     */
    showBrackets: boolean;
}

export const DEFAULT_QUOTE_DISPLAY: QuoteDisplay = { showCard: true, showLines: true, showBrackets: true };

const STORAGE_KEY = 'midorii-quote-display';

/** Whatever a stored record is missing, or cannot mean, comes back as the default. */
export function normalizeQuoteDisplay(raw: unknown): QuoteDisplay {
    const source = (raw ?? {}) as Partial<Record<keyof QuoteDisplay, unknown>>;
    const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
    const d = DEFAULT_QUOTE_DISPLAY;
    return {
        showCard: bool(source.showCard, d.showCard),
        showLines: bool(source.showLines, d.showLines),
        showBrackets: bool(source.showBrackets, d.showBrackets),
    };
}

/** What this machine last saved, or the defaults. Never throws. */
export function loadQuoteDisplay(): QuoteDisplay {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeQuoteDisplay(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the quote display settings', err);
        return { ...DEFAULT_QUOTE_DISPLAY };
    }
}

type DisplayListener = (display: QuoteDisplay) => void;
const listeners = new Set<DisplayListener>();

/** Hear about every save, so what is on the chart is redrawn by whoever owns it.
 *  Returns its own unsubscribe. */
export function onQuoteDisplayChange(listener: DisplayListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Store it, and tell whoever is drawing. A storage failure is reported, never swallowed —
 *  and never fatal: the chart is repainted either way, so what is on screen is what was
 *  asked for even when the machine cannot remember it. */
export function saveQuoteDisplay(display: QuoteDisplay): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
    } catch (err) {
        console.error('[midorii] could not persist the quote display settings', err);
    }
    for (const listener of listeners) {
        try {
            listener(display);
        } catch (err) {
            console.error('[midorii] a quote display listener failed', err);
        }
    }
}
