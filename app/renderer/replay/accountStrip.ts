import { injectStyles } from '../../../src/ui';
import { formatMoney, formatPercent, formatSignedMoney, formatSize } from '../format';
import type { AccountFigures } from './accountFigures';
import { makeOverlayCard } from './overlayCards';

/**
 * The account, on the chart, for as long as a session runs.
 *
 * Trading a replay without it is trading blind: the equity, what is open and what is standing
 * behind a stop were all in the engine and on none of the screens. Four figures is the whole
 * of it — anything more is review, and review belongs in the run library afterwards.
 *
 * Over the four, the one thing that decides what they MEAN: whose account this is. The same
 * card serves a replay and a paper account, and 8,934.98 says nothing about which of them is
 * being traded — the figures are identical in shape and a session left open is a session
 * whose kind is easy to misremember. A live account is not among them: that one has a card of
 * its own, because "real money" is not a line in a heading.
 *
 * It starts anchored to the price pane through the two custom properties the renderer
 * publishes on the cell for exactly this (`--vela-price-pane-top`, `--vela-scale-gutter`), so
 * it sits clear of the price axis at any width without reaching into the chart's own DOM.
 * That is where it STARTS: the card is draggable, and one dropped somewhere else holds its own
 * pixels from then on (see `overlayCards.ts`).
 *
 * The card takes the pointer, which is the price of being movable — a drag through the
 * top-right corner moves the card rather than the chart. It can be put away for that reason
 * alone: the close button puts it away — for good, until the corner's restore button asks for
 * it back — and Settings → Customization takes it off the chart entirely, restore button and
 * all.
 */

const STYLE_ID = 'midorii-account';
const CSS = `
.midorii-account {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    /* The last term is the room the restore button takes when it is on screen — see
       overlayCards.ts. Zero the rest of the time, and ignored once the card is dragged. */
    right: calc(var(--vela-scale-gutter, 0px) + 10px + var(--midorii-overlay-inset, 0px));
    z-index: 4;
    display: flex;
    flex-direction: column;
    padding: 6px 14px 8px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    user-select: none;
}
/* Deliberately NOT the small-caps the column labels wear: in that dress it reads as a fifth
   column heading with a missing figure under it. Plain sentence case, one notch quieter, is
   what makes it a heading over the four rather than one of them. */
.midorii-account-broker {
    margin-bottom: 4px;
    font-size: 10.5px;
    color: var(--vela-fg-faint);
    white-space: nowrap;
}
.midorii-account-cols { display: flex; gap: 20px; }
.midorii-account-col { display: flex; flex-direction: column; gap: 1px; min-width: 62px; }
.midorii-account-label {
    align-self: flex-start;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-account-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    line-height: 1.25;
    color: var(--vela-fg-bright);
}
.midorii-account-sub {
    min-height: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    line-height: 1.3;
    color: var(--vela-fg-muted);
}
.midorii-account .up { color: var(--vela-up); }
.midorii-account .down { color: var(--vela-down); }
.midorii-account .warn { color: var(--vela-danger); }
`;

/** Nothing is open: the column has no figure to give, and 0.00 would be an answer. */
const NONE = '—';

interface Column {
    readonly el: HTMLElement;
    readonly value: HTMLElement;
    readonly sub: HTMLElement;
}

export interface AccountStripOptions {
    /**
     * Whose account the figures are — the words the app calls this broker by elsewhere, so
     * the card and the Trade menu agree. Required rather than defaulted: a card that guessed
     * would eventually name the wrong account, and there is no safe guess to make.
     */
    broker: string;
    /** What the heading means, on hover. */
    brokerHint?: string;
}

export interface AccountStrip {
    /** The card itself, so whoever mounted it can take it away again. */
    readonly el: HTMLElement;
    update(figures: AccountFigures): void;
    /** Release the drag, the corner button and the settings listener. Does not remove `el`. */
    destroy(): void;
}

function column(doc: Document, label: string, hint?: string): Column {
    const el = doc.createElement('div');
    el.className = 'midorii-account-col';

    const title = doc.createElement('span');
    title.className = 'midorii-account-label';
    title.textContent = label;
    if (hint) title.title = hint;

    const value = doc.createElement('span');
    value.className = 'midorii-account-value';

    const sub = doc.createElement('span');
    sub.className = 'midorii-account-sub';

    el.append(title, value, sub);
    return { el, value, sub };
}

/** Paint a figure and colour it only when its direction is what it is there to say. */
function put(target: HTMLElement, text: string, sign?: number, tone: 'signed' | 'warn' = 'signed'): void {
    target.textContent = text;
    target.classList.remove('up', 'down', 'warn');
    if (tone === 'warn') {
        if (text) target.classList.add('warn');
        return;
    }
    if (sign != null && sign !== 0) target.classList.add(sign > 0 ? 'up' : 'down');
}

/** How the open position reads in units: `0.30 long`, `0.15 short`, or nothing at all. */
function sizeLine(figures: AccountFigures): string {
    if (figures.openPositions === 0) return 'flat';
    const net = figures.netSize;
    if (net === 0) return `${figures.openPositions} open · hedged`;
    return `${formatSize(Math.abs(net))} ${net > 0 ? 'long' : 'short'}`;
}

/**
 * Mount the readout into a chart cell. The caller owns it afterwards — `destroy()` releases
 * what it wired up and `el.remove()` takes it off.
 *
 * It is mounted whatever the setting says and then hidden, rather than not mounted at all:
 * the switch can be thrown while a session is running, and a card that had to be recreated
 * would come back having forgotten where it was dragged to.
 */
export function mountAccountStrip(cell: HTMLElement, opts: AccountStripOptions): AccountStrip {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-account';

    const broker = doc.createElement('div');
    broker.className = 'midorii-account-broker';
    broker.textContent = opts.broker;
    if (opts.brokerHint) broker.title = opts.brokerHint;

    const equity = column(doc, 'Equity', 'Cash plus whatever is open — what the account is worth if everything closed at the last price.');
    const open = column(doc, 'Open', 'Profit on open positions that has not been booked yet. A dash means nothing is open.');
    const risk = column(
        doc,
        'Risk',
        'What every stop in the market would come to together if all of them filled, net of what '
        + 'getting out costs. A stop moved past break-even pays into this rather than adding to it, '
        + 'so it can read as a gain. A position with no stop is counted beside it rather than as '
        + 'zero — its risk is not small, it is undecided.',
    );
    const cash = column(doc, 'Cash', 'Settled money: what would be left if every open position closed at break-even.');

    const cols = doc.createElement('div');
    cols.className = 'midorii-account-cols';
    cols.append(equity.el, open.el, risk.el, cash.el);

    el.append(broker, cols);
    cell.appendChild(el);

    const card = makeOverlayCard(cell, el, { id: 'account' });

    return {
        el,
        destroy(): void {
            card.destroy();
        },
        update(f: AccountFigures): void {
            // Equity stays bright rather than coloured: the return underneath it carries the
            // direction, and two colours saying one thing is one too many.
            put(equity.value, formatMoney(f.equity));
            put(equity.sub, formatPercent(f.returnPct, 2, true), f.returnPct);

            put(open.value, f.open == null ? NONE : formatSignedMoney(f.open), f.open ?? 0);
            put(open.sub, sizeLine(f));

            // Shown as what it would cost, so money at risk reads as a loss.
            put(risk.value, f.risk == null ? NONE : formatSignedMoney(-f.risk), f.risk == null ? 0 : -f.risk);
            put(
                risk.sub,
                f.unprotected > 0 ? `${f.unprotected} unprotected` : '',
                undefined,
                f.unprotected > 0 ? 'warn' : 'signed',
            );

            put(cash.value, formatMoney(f.cash));
            put(cash.sub, '');
        },
    };
}
