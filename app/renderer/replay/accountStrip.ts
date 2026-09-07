import { injectStyles } from '../../../src/ui';
import { formatMoney, formatPercent, formatSignedMoney, formatSize } from '../format';
import type { AccountFigures } from './accountFigures';

/**
 * The account, on the chart, for as long as a session runs.
 *
 * Trading a replay without it is trading blind: the equity, what is open and what is standing
 * behind a stop were all in the engine and on none of the screens. Four figures is the whole
 * of it — anything more is review, and review belongs in the run library afterwards.
 *
 * It anchors to the price pane through the two custom properties the renderer publishes on the
 * cell for exactly this (`--vela-price-pane-top`, `--vela-scale-gutter`), so it sits clear of
 * the price axis at any width without reaching into the chart's own DOM.
 *
 * The card does not take the pointer: it floats over live bars, and a readout that swallowed a
 * drag through the top-right corner would be a readout people move the chart to avoid. Only
 * the labels do, so hovering one can explain what it is counting.
 */

const STYLE_ID = 'midorii-account';
const CSS = `
.midorii-account {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px);
    z-index: 4;
    display: flex;
    gap: 20px;
    padding: 7px 14px 8px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    pointer-events: none;
    user-select: none;
}
.midorii-account-col { display: flex; flex-direction: column; gap: 1px; min-width: 62px; }
.midorii-account-label {
    pointer-events: auto;
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

export interface AccountStrip {
    /** The card itself, so whoever mounted it can take it away again. */
    readonly el: HTMLElement;
    update(figures: AccountFigures): void;
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
 * Mount the readout into a chart cell. The caller owns it afterwards — `el.remove()` takes it
 * off, and there is nothing else to release.
 */
export function mountAccountStrip(cell: HTMLElement): AccountStrip {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-account';

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

    el.append(equity.el, open.el, risk.el, cash.el);
    cell.appendChild(el);

    return {
        el,
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
