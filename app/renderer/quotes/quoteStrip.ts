import { injectStyles } from '../../../src/ui';
import { makeOverlayCard } from '../replay/overlayCards';

/**
 * The two-sided price, on the chart, for markets that quote one.
 *
 * The candles are drawn from the BID — the convention every CFD chart follows — so the
 * chart alone never says what a BUY costs. That is the ask, it is a different number, and
 * the gap between them is the first thing a trade pays before it is right about anything.
 * Three figures is the whole of it: what you can sell at, what you can buy at, and what
 * standing between the two costs.
 *
 * It starts anchored to the price pane through the custom properties the renderer publishes
 * for host overlays (`--vela-price-pane-bottom`, `--vela-scale-gutter`), so it sits clear of
 * the price axis and the time axis at any size without reaching into the chart's DOM. The
 * bottom-right corner because the account card already has the top-right one, the legend
 * the top-left, and the attribution mark the bottom-left.
 *
 * That is where it STARTS. Like the other floating cards it can be dragged anywhere over the
 * plot and dropped there for good, and closed from its own corner — which is the price of
 * being movable: the card takes the pointer, so a drag through it moves the card rather than
 * the chart. Closed, it stays closed across restarts and the chart's restore button is what
 * brings it back; the switch under Settings → Customization takes it off entirely, restore
 * button and all. See `replay/overlayCards.ts`.
 *
 * Stale is shown, not hidden
 * --------------------------
 * A quote is only true for as long as the stream keeps saying it. When ticks stop — the
 * socket dropped, the market closed — the card dims and says when it last heard anything
 * rather than going on displaying the last number as though it were current. A price that
 * looks live and is not is worse than no price at all.
 */

const STYLE_ID = 'midorii-quote';
const CSS = `
.midorii-quote {
    position: absolute;
    bottom: calc(var(--vela-price-pane-bottom, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px);
    z-index: 4;
    display: flex;
    gap: 18px;
    padding: 7px 14px 8px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    user-select: none;
    transition: opacity 120ms ease;
}
.midorii-quote-col { display: flex; flex-direction: column; gap: 1px; min-width: 58px; }
.midorii-quote-label {
    align-self: flex-start;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-quote-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    line-height: 1.25;
    color: var(--vela-fg-bright);
}
.midorii-quote-sub {
    min-height: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    line-height: 1.3;
    color: var(--vela-fg-muted);
}
/* Dimmed whole rather than greyed per figure: the card is one statement, and all of it
   is equally out of date. */
.midorii-quote.stale { opacity: 0.4; }
`;

/** A two-sided price, whatever venue it came from. */
export interface Quote {
    bid: number;
    ask: number;
    /** Epoch ms, as the venue stamped it. */
    time: number;
}

/** Nothing has arrived yet, or what arrived is too old to state. */
const NONE = '—';

/** After this long without a tick the card stops claiming to be current. */
const STALE_MS = 10_000;

export interface QuoteStrip {
    /** The card itself, so whoever mounted it can take it away again. */
    readonly el: HTMLElement;
    /**
     * Show a quote. `tick` is the instrument's own increment, used both to print the
     * figures at the precision the market quotes them and to say the spread in a unit
     * that means something; undefined prints them as they arrived.
     */
    update(quote: Quote, tick?: number): void;
    /**
     * Say that nothing is arriving — a market with no quote stream, or one that stopped.
     * Stops the staleness timer too.
     */
    clear(): void;
    /**
     * Whether this chart shows the card at all: the Settings switch, and whether the market
     * on screen quotes two sides in the first place. A card that is not available is not
     * offered by the restore button either — there is nothing behind it to restore.
     */
    setAvailable(available: boolean): void;
    /** Release the drag and the card's seat in the restore button. Does not remove `el`. */
    destroy(): void;
}

/** `HH:MM:SS` in UTC — the clock everything else in the app is stamped in. To the second
 *  because a quote goes stale in ten of them, and a time to the minute could not say so. */
function clockOf(ms: number): string {
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : NONE;
}

/** How many decimals an increment implies — 0.00001 ⇒ 5. */
export function decimalsOf(tick: number): number {
    if (!(tick > 0)) return 2;
    // `toFixed(10)` then trimming beats parsing the exponent form a small tick prints as.
    const text = tick.toFixed(10).replace(/0+$/, '');
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
}

function column(doc: Document, label: string, hint: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } {
    const el = doc.createElement('div');
    el.className = 'midorii-quote-col';

    const title = doc.createElement('span');
    title.className = 'midorii-quote-label';
    title.textContent = label;
    title.title = hint;

    const value = doc.createElement('span');
    value.className = 'midorii-quote-value';
    value.textContent = NONE;

    const sub = doc.createElement('span');
    sub.className = 'midorii-quote-sub';

    el.append(title, value, sub);
    return { el, value, sub };
}

/**
 * Mount the readout into a chart cell. The caller owns it afterwards — `clear()` stops its
 * timer, `destroy()` releases the drag, and `el.remove()` takes it off.
 */
export function mountQuoteStrip(cell: HTMLElement): QuoteStrip {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-quote stale';

    const bid = column(doc, 'Bid', 'What you can sell at. The candles are drawn from this side.');
    const ask = column(doc, 'Ask', 'What you can buy at — always the higher of the two, and never shown by the candles.');
    const spread = column(
        doc,
        'Spread',
        'What the gap between the two sides costs you the moment you enter, before the trade '
        + 'is right or wrong about anything. Said underneath in the increments the instrument '
        + 'is quoted in.',
    );

    el.append(bid.el, ask.el, spread.el);
    cell.appendChild(el);

    /* No `place` of its own: with nothing dragged, the CSS above holds it in the corner, and
     * the corner it uses is not the one the restore button sits in — so unlike the two cards
     * up top, this one has no room to make for it. */
    const card = makeOverlayCard(cell, el, { id: 'quote' });

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    /** When the venue stamped the last quote — what the card names once it goes stale. */
    let lastAt: number | null = null;
    const markStale = (): void => {
        el.classList.add('stale');
        // Dimming alone says "something is off"; the time says WHAT, and rules out the
        // reading that these are current figures on a quiet market.
        bid.sub.textContent = lastAt == null ? '' : `last ${clockOf(lastAt)}`;
    };

    return {
        el,
        update(quote: Quote, tick?: number): void {
            const digits = tick != null ? decimalsOf(tick) : undefined;
            const price = (v: number): string => (digits != null ? v.toFixed(digits) : String(v));

            bid.value.textContent = price(quote.bid);
            ask.value.textContent = price(quote.ask);

            const gap = quote.ask - quote.bid;
            spread.value.textContent = price(gap);
            /* In ticks rather than pips: a pip is a convention that differs by instrument
             * (and reverses on the yen crosses), while the increment is what the venue
             * actually quotes in and needs inventing by nobody. */
            spread.sub.textContent = tick != null && tick > 0
                ? `${Number((gap / tick).toFixed(2))} ticks`
                : '';

            lastAt = quote.time;
            bid.sub.textContent = '';
            el.classList.remove('stale');
            if (staleTimer) clearTimeout(staleTimer);
            staleTimer = setTimeout(markStale, STALE_MS);
        },
        setAvailable(available: boolean): void {
            card.setAvailable(available);
        },
        destroy(): void {
            card.destroy();
        },
        clear(): void {
            if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
            lastAt = null;
            bid.sub.textContent = '';
            bid.value.textContent = NONE;
            ask.value.textContent = NONE;
            spread.value.textContent = NONE;
            spread.sub.textContent = '';
            el.classList.add('stale');
        },
    };
}
