import { injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatMoney, formatPercent, formatR, formatSignedMoney, formatSize } from '../format';
import type { OrderRow, PositionRow, TradeBook } from './tradeBook';

/**
 * The dock: what is open, what is waiting, and the things you do to them while a trade is on.
 * Only that — what has already closed is read in the ticket's History tab, beside the plot.
 *
 * It sits UNDER the chart rather than over it. Everything here used to be reachable only
 * through the engine, and the obvious place to put it — a column beside the plot — is the
 * mistake the old app made and undid: at 300 pixels a position is three lines, so the two
 * things a person does most, move the stop and take part off, end up below the fold. Across
 * the full width a position is one line and every control on it is one click away.
 *
 * Nothing here decides anything. A button calls the same Broker an entry went through, and the
 * row it redraws is whatever the account says afterwards — so a refused break-even stays
 * refused, with the engine's own reason on the button.
 */

const STYLE_ID = 'midorii-dock';
const CSS = `
.midorii-dock {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--vela-border);
    background: var(--vela-surface);
    font-size: 12px;
    color: var(--vela-fg);
}
.midorii-dock-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 10px 0 12px;
    height: 30px;
    flex: 0 0 auto;
}
.midorii-dock-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-dock-title b { color: var(--vela-fg-bright); font-weight: 600; }
.midorii-dock-spacer { flex: 1 1 auto; }
.midorii-dock-body {
    overflow-y: auto;
    max-height: 190px;
    padding: 0 12px 10px;
}
${overlayScrollbarCss('.midorii-dock-body')}
.midorii-dock[data-folded] .midorii-dock-body { display: none; }

.midorii-dock-empty { padding: 2px 0 8px; color: var(--vela-fg-muted); }
.midorii-dock-section {
    margin: 6px 0 4px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}

.midorii-dock-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    border-top: 1px solid var(--vela-border-faint);
    font-variant-numeric: tabular-nums;
}
.midorii-dock-side {
    flex: 0 0 auto;
    min-width: 46px;
    padding: 2px 6px;
    border-radius: var(--vela-radius-sm);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-align: center;
}
.midorii-dock-side[data-dir='long'] { color: var(--vela-up); background: color-mix(in srgb, var(--vela-up) 14%, transparent); }
.midorii-dock-side[data-dir='short'] { color: var(--vela-down); background: color-mix(in srgb, var(--vela-down) 14%, transparent); }
.midorii-dock-cell { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.midorii-dock-cell small {
    display: block;
    font-family: var(--vela-font, system-ui);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-dock .up { color: var(--vela-up); }
.midorii-dock .down { color: var(--vela-down); }
.midorii-dock .muted { color: var(--vela-fg-muted); }

.midorii-dock-price {
    width: 92px;
    padding: 3px 6px;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
}
.midorii-dock-price:focus { border-color: var(--vela-focus); }
.midorii-dock-price[data-trailing] { border-style: dashed; }

.midorii-dock-actions { display: flex; gap: 6px; margin-left: auto; }
.midorii-dock-btn {
    all: unset;
    box-sizing: border-box;
    padding: 4px 10px;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}
.midorii-dock-btn:hover:not(:disabled) { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-dock-btn:disabled { opacity: 0.4; cursor: default; }
.midorii-dock-btn[data-tone='danger'] { color: var(--vela-danger); }
/* The account's own line in the header: what it has done since it was opened. Quiet by
   default — it is a readout beside controls, not a headline. */
.midorii-dock-sum {
    display: flex;
    align-items: baseline;
    gap: 14px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--vela-fg-muted);
    white-space: nowrap;
    overflow: hidden;
}
.midorii-dock-sum b { font-weight: 600; color: var(--vela-fg-bright); }
.midorii-dock-sum .up { color: var(--vela-up); }
.midorii-dock-sum .down { color: var(--vela-down); }

.midorii-dock-fold {
    all: unset;
    padding: 2px 8px;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
    font-size: 12px;
}
.midorii-dock-fold:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
`;

/** What the dock can ask the session to do. Every one of these already exists on the engine. */
export interface DockOptions {
    /**
     * How to get into a trade, for the line shown while nothing has been traded yet.
     *
     * The dock is used on three screens and only two of them have the chart's own order
     * gestures. On the Trading Bot tab there is deliberately no way in at all — a strategy
     * opens the trades — so the default here would be telling somebody to do something that
     * screen refuses to let them do.
     */
    howToTrade?: string;
}

export interface DockActions {
    closePosition(id: number): void;
    closePart(size: number, id: number): void;
    reverse(id: number): void;
    breakEven(id: number): void;
    protect(levels: { stopLoss?: number | null; takeProfit?: number | null }, id: number): void;
    setTrailing(distance: number, id: number): void;
    cancelOrder(id: number): void;
    cancelAll(): void;
    flatten(): void;
}

export interface TradeDock {
    readonly el: HTMLElement;
    /** Repaint. `account` adds the summary line — omit it and the dock is exactly what it
     *  was: what is open and what is waiting. */
    render(book: TradeBook, account?: AccountView | null): void;
}

function button(label: string, tone?: 'danger'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'midorii-dock-btn';
    b.textContent = label;
    if (tone) b.dataset.tone = tone;
    return b;
}

/** A number cell with its own small caption above it. */
function cell(doc: Document, caption: string, text: string, tone?: 'up' | 'down' | 'muted'): HTMLElement {
    const el = doc.createElement('span');
    el.className = `midorii-dock-cell${tone ? ` ${tone}` : ''}`;
    const label = doc.createElement('small');
    label.textContent = caption;
    el.append(label, doc.createTextNode(text));
    return el;
}

/**
 * A price as it goes INTO an editable field: no grouping, so what comes back out parses, and
 * no floating-point tail from the arithmetic that produced it. The price itself is left alone
 * — rounding a stop for display would be a claim about where it is.
 */
function plain(value: number): string {
    return String(Number(value.toFixed(8)));
}

/**
 * A price field that commits on Enter or on leaving it, and never on every keystroke — a stop
 * typed one digit at a time would otherwise be placed at 7, then 77, then 779.
 *
 * An empty field means "no level", which is how a stop is taken off.
 */
function priceField(doc: Document, value: number | null, commit: (price: number | null) => void): HTMLInputElement {
    const input = doc.createElement('input');
    input.className = 'midorii-dock-price';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = value == null ? '' : plain(value);
    input.placeholder = '—';

    const apply = (): void => {
        const raw = input.value.trim();
        if (raw === '') {
            if (value != null) commit(null);
            return;
        }
        const price = Number(raw);
        if (!Number.isFinite(price) || price <= 0) {
            input.value = value == null ? '' : plain(value);
            return;
        }
        if (price !== value) commit(price);
    };

    input.addEventListener('blur', apply);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = value == null ? '' : plain(value);
            input.blur();
        }
    });
    return input;
}

/** Ask for one number, in place of the button that opened the ask. */
function prompt(doc: Document, label: string, onValue: (value: number) => void): HTMLElement {
    const wrap = doc.createElement('span');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center';
    const input = doc.createElement('input');
    input.className = 'midorii-dock-price';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = label;
    input.style.width = '76px';
    const ok = button('Set');
    const submit = (): void => {
        const value = Number(input.value.trim());
        if (Number.isFinite(value) && value > 0) onValue(value);
    };
    ok.onclick = submit;
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
    });
    wrap.append(input, ok);
    return wrap;
}

function positionRow(doc: Document, p: PositionRow, actions: DockActions): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'midorii-dock-row';
    row.dataset.position = String(p.id);

    const side = doc.createElement('span');
    side.className = 'midorii-dock-side';
    side.dataset.dir = p.side;
    side.textContent = p.side === 'long' ? 'LONG' : 'SHORT';

    const pnlTone = p.unrealized === 0 ? undefined : p.unrealized > 0 ? 'up' : 'down';

    row.append(
        side,
        cell(doc, 'Size', formatSize(p.size)),
        cell(doc, 'Entry', formatMoney(p.entryPrice)),
        cell(doc, 'Open', formatSignedMoney(p.unrealized), pnlTone),
        cell(doc, 'R', formatR(p.r), pnlTone),
    );

    const stop = doc.createElement('span');
    stop.className = 'midorii-dock-cell';
    const stopLabel = doc.createElement('small');
    stopLabel.textContent = p.trailing ? 'Stop · trailing' : 'Stop';
    const stopInput = priceField(doc, p.stopLoss, (price) => actions.protect({ stopLoss: price }, p.id));
    if (p.trailing) stopInput.dataset.trailing = '';
    stop.append(stopLabel, stopInput);

    const target = doc.createElement('span');
    target.className = 'midorii-dock-cell';
    const targetLabel = doc.createElement('small');
    targetLabel.textContent = 'Target';
    target.append(targetLabel, priceField(doc, p.takeProfit, (price) => actions.protect({ takeProfit: price }, p.id)));

    row.append(stop, target);

    const bar = doc.createElement('span');
    bar.className = 'midorii-dock-actions';

    const be = button('Break-even');
    if (p.breakEvenRefusal) {
        be.disabled = true;
        // The engine's own words, rather than a greyed button with no reason on it.
        be.title = p.breakEvenRefusal;
    } else {
        be.onclick = () => actions.breakEven(p.id);
    }

    const half = button('Take half');
    half.onclick = () => actions.closePart(p.size / 2, p.id);

    const trail = button('Trail…');
    trail.onclick = () => {
        trail.replaceWith(prompt(doc, 'distance', (distance) => actions.setTrailing(distance, p.id)));
    };

    const reverse = button('Reverse');
    reverse.onclick = () => actions.reverse(p.id);

    const close = button('Close', 'danger');
    close.onclick = () => actions.closePosition(p.id);

    bar.append(be, half, trail, reverse, close);
    row.append(bar);
    return row;
}

function orderRow(doc: Document, o: OrderRow, actions: DockActions): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'midorii-dock-row';
    row.dataset.order = String(o.id);

    const side = doc.createElement('span');
    side.className = 'midorii-dock-side';
    side.dataset.dir = o.side === 'buy' ? 'long' : 'short';
    side.textContent = o.side === 'buy' ? 'BUY' : 'SELL';

    row.append(
        side,
        cell(doc, 'Type', o.type),
        cell(doc, 'Size', formatSize(o.size)),
        cell(doc, 'Price', o.price == null ? '—' : formatMoney(o.price)),
        cell(doc, 'Tag', o.tag ?? '—', 'muted'),
    );

    const bar = doc.createElement('span');
    bar.className = 'midorii-dock-actions';
    const cancel = button('Cancel', 'danger');
    cancel.onclick = () => actions.cancelOrder(o.id);
    bar.append(cancel);
    row.append(bar);
    return row;
}

/**
 * The account behind the book, where there is one that keeps figures.
 *
 * Optional, and absent for a replay: a replay's result is read in the run library
 * afterwards, in one piece. A paper account is never finished, so the only place its
 * figures can be read is while it is running.
 */
export interface AccountView {
    /** What the account has done since it was opened. */
    stats: {
        netPnl: number;
        returnPct: number;
        tradeCount: number;
        winRate: number | null;
        maxDrawdownPct: number;
        feesPaid: number;
    };
}

/** The account's line in the dock header — what it has done, in six figures. */
function summaryLine(doc: Document, stats: AccountView['stats']): HTMLElement {
    const el = doc.createElement('span');
    el.className = 'midorii-dock-sum';

    const figure = (caption: string, text: string, sign?: number): void => {
        const item = doc.createElement('span');
        const value = doc.createElement('b');
        value.textContent = text;
        if (sign != null && sign !== 0) value.classList.add(sign > 0 ? 'up' : 'down');
        item.append(doc.createTextNode(`${caption} `), value);
        el.append(item);
    };

    figure('Net', formatSignedMoney(stats.netPnl), stats.netPnl);
    figure('Return', formatPercent(stats.returnPct, 2, true), stats.returnPct);
    figure('Trades', String(stats.tradeCount));
    figure('Won', formatPercent(stats.winRate));
    // Shown as the cost it was: a drawdown is not an achievement to print in green.
    figure('Max DD', formatPercent(-stats.maxDrawdownPct, 2, true), stats.maxDrawdownPct > 0 ? -1 : 0);
    figure('Fees', formatMoney(stats.feesPaid));
    return el;
}

/**
 * Mount the dock. The caller owns the element afterwards — `el.remove()` takes it away, and
 * there is nothing else to release.
 */
export function mountTradeDock(host: HTMLElement, actions: DockActions, opts: DockOptions = {}): TradeDock {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-dock';

    const head = doc.createElement('div');
    head.className = 'midorii-dock-head';
    const title = doc.createElement('span');
    title.className = 'midorii-dock-title';

    const summary = doc.createElement('span');

    const spacer = doc.createElement('span');
    spacer.className = 'midorii-dock-spacer';

    const cancelAll = button('Cancel all orders');
    cancelAll.onclick = () => actions.cancelAll();
    const flatten = button('Flatten', 'danger');
    flatten.onclick = () => actions.flatten();

    const fold = doc.createElement('button');
    fold.className = 'midorii-dock-fold';
    fold.textContent = '⌄';
    fold.title = 'Fold the dock away';
    fold.onclick = () => {
        const folded = el.hasAttribute('data-folded');
        if (folded) el.removeAttribute('data-folded');
        else el.setAttribute('data-folded', '');
        fold.textContent = folded ? '⌄' : '⌃';
        fold.title = folded ? 'Fold the dock away' : 'Open the dock';
    };

    head.append(title, summary, spacer, cancelAll, flatten, fold);

    const body = doc.createElement('div');
    body.className = 'midorii-dock-body';

    /* Everything in here moves with every tick and is rebuilt every time, which is only
     * cheap because it is a handful of rows: what has already closed — the two hundred rows
     * that would make a live feed stutter if they were repainted at that rate — is the
     * ticket's, and is drawn there only when it changes. */
    const live = doc.createElement('div');
    body.append(live);

    el.append(head, body);
    host.appendChild(el);

    return {
        el,
        render(bookState: TradeBook, account: AccountView | null = null): void {
            const { positions, orders } = bookState;
            summary.replaceChildren();
            if (account) summary.append(summaryLine(doc, account.stats));
            title.replaceChildren();
            const counts = doc.createElement('span');
            counts.innerHTML = '';
            counts.append(
                doc.createTextNode('Positions '),
                Object.assign(doc.createElement('b'), { textContent: String(positions.length) }),
                doc.createTextNode('   ·   Orders '),
                Object.assign(doc.createElement('b'), { textContent: String(orders.length) }),
            );
            title.append(counts);

            // A button that cannot do anything is not offered.
            cancelAll.disabled = orders.length === 0;
            flatten.disabled = positions.length === 0;

            live.replaceChildren();

            if (positions.length === 0 && orders.length === 0) {
                const empty = doc.createElement('div');
                empty.className = 'midorii-dock-empty';
                // The how-to only while nothing has been traded yet: after the first round
                // trip it is instructions for something the person has already done.
                const howTo = opts.howToTrade ?? 'Draw a position on the chart, then right-click it to order.';
                empty.textContent = (account?.stats.tradeCount ?? 0) === 0 && howTo
                    ? `Nothing open. ${howTo}`
                    : 'Nothing open.';
                live.append(empty);
                return;
            }

            if (positions.length > 0) {
                const label = doc.createElement('div');
                label.className = 'midorii-dock-section';
                label.textContent = 'Open';
                live.append(label, ...positions.map((p) => positionRow(doc, p, actions)));
            }
            if (orders.length > 0) {
                const label = doc.createElement('div');
                label.className = 'midorii-dock-section';
                label.textContent = 'Working orders';
                live.append(label, ...orders.map((o) => orderRow(doc, o, actions)));
            }
        },
    };
}
