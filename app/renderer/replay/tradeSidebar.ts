import { NumberInput, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatMoney, formatPercent, formatR, formatSignedMoney, formatSize, formatWhen } from '../format';
import { equityPath } from '../runs/runStats';
import { emptyTicket, ticketOrder, ticketPlan, ticketRefusal } from './orderTicket';
import type { TicketAccount, TicketDraft } from './orderTicket';
import { DEFAULT_RISK } from './replayOrders';
import type { RiskSettings } from './replayOrders';
import type { HistoryRow } from './tradeBook';
import type { OrderSpec } from '../../../shared/engine/broker.js';

/**
 * The ticket: getting in, without drawing anything.
 *
 * The chart's position block is the considered way in — you draw where the trade is wrong,
 * look at it, and trade it when it still looks right. This is the other way in, and it is a
 * different frame of mind: a level is already known, or the market is moving and the block
 * would be three drags too slow. Both go to the same Broker at the same costs, so a run made
 * of the two is still one run.
 *
 * Beside the plot rather than under it, because it is used while looking at the chart and the
 * eye should not have to leave it. The dock below stays what it is — the dock is about what is
 * already ON, this is about what is not yet.
 *
 * It folds away to a rail. Screen is what a chart is for, and a panel that cannot be got rid
 * of is a panel people close by not opening the app.
 */

const STYLE_ID = 'midorii-side';
const CSS = `
.midorii-side {
    flex: 0 0 auto;
    width: 296px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--vela-border);
    background: var(--vela-surface);
    color: var(--vela-fg);
    font-size: 12px;
    overflow: hidden;
}
.midorii-side[data-collapsed] { width: 34px; }

.midorii-side-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 4px 0 12px;
    border-bottom: 1px solid var(--vela-border-faint);
}
/* Two tabs where the title was. The ticket and the record are read at different moments and
   296px is not wide enough to hold both, so they take turns rather than share. */
.midorii-side-tabs { flex: 1 1 auto; align-self: stretch; display: flex; gap: 14px; }
.midorii-side-tab {
    all: unset;
    display: grid;
    align-items: center;
    box-shadow: inset 0 -2px 0 transparent;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-tab:hover { color: var(--vela-fg-bright); }
.midorii-side-tab[data-on] { color: var(--vela-fg-bright); box-shadow: inset 0 -2px 0 var(--vela-accent); }
.midorii-side-fold {
    all: unset;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
    font-size: 13px;
}
.midorii-side-fold:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

/* Folded: the head keeps only the button, and the rail below it is the rest of the target. */
.midorii-side[data-collapsed] .midorii-side-head { padding: 0; justify-content: center; }
.midorii-side[data-collapsed] .midorii-side-tabs,
.midorii-side[data-collapsed] .midorii-side-body,
.midorii-side[data-collapsed] .midorii-side-hist,
.midorii-side[data-collapsed] .midorii-side-foot { display: none; }
.midorii-side-rail { display: none; }
.midorii-side[data-collapsed] .midorii-side-rail {
    all: unset;
    display: block;
    flex: 1 1 auto;
    writing-mode: vertical-rl;
    padding: 14px 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side[data-collapsed] .midorii-side-rail:hover { color: var(--vela-fg-bright); }

.midorii-side-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px 6px; }
${overlayScrollbarCss('.midorii-side-body')}

.midorii-side-sect {
    margin: 14px 0 7px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-side-sect:first-child { margin-top: 0; }

.midorii-side-row {
    display: grid;
    grid-template-columns: 74px 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 7px;
}
.midorii-side-row > span:first-child { color: var(--vela-fg-muted); }
.midorii-side-row[data-hint] { margin-bottom: 2px; }
/* A display set by a class beats the user agent's own rule for [hidden], so a row switched
   off with el.hidden would otherwise stay on screen. This is what actually hides it. */
.midorii-side [hidden] { display: none; }
.midorii-side-hint {
    margin: 0 0 7px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--vela-fg-faint);
    min-height: 13px;
}

.midorii-side-seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-sunken);
}
.midorii-side-seg button {
    all: unset;
    flex: 1 1 0;
    padding: 5px 0;
    border-radius: calc(var(--vela-radius-sm) - 1px);
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-seg button:hover { color: var(--vela-fg-bright); }
.midorii-side-seg button[data-on] {
    background: var(--vela-surface-overlay);
    color: var(--vela-fg-bright);
    box-shadow: var(--vela-shadow);
}

.midorii-side-price {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    outline: none;
}
.midorii-side-price:focus { border-color: var(--vela-focus); }
.midorii-side-price::placeholder { color: var(--vela-fg-faint); }

.midorii-side-unit { display: grid; grid-template-columns: 1fr 52px; gap: 6px; }
.midorii-side-unit button {
    all: unset;
    display: grid;
    place-items: center;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg-muted);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
}
.midorii-side-unit button:hover { color: var(--vela-fg-bright); background: var(--vela-hover); }

.midorii-side-out {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px 10px;
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-sunken);
}
.midorii-side-out > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.midorii-side-out small {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-side-out b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    font-weight: 500;
    color: var(--vela-fg-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.midorii-side-out i {
    font-style: normal;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--vela-fg-muted);
    min-height: 13px;
}
.midorii-side-out i.warn { color: var(--vela-danger); }

.midorii-side-foot {
    flex: 0 0 auto;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--vela-border-faint);
}
.midorii-side-why {
    margin-bottom: 8px;
    font-size: 11px;
    line-height: 1.35;
    color: var(--vela-danger);
}
.midorii-side-why:empty { display: none; }
.midorii-side-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.midorii-side-go {
    all: unset;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 8px 0 7px;
    border-radius: var(--vela-radius-md);
    color: var(--vela-fg-on-fill);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.05em;
    cursor: pointer;
}
.midorii-side-go small {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0;
    opacity: 0.85;
}
.midorii-side-go[data-side='buy'] { background: var(--vela-up); }
.midorii-side-go[data-side='sell'] { background: var(--vela-down); }
.midorii-side-go:hover:not(:disabled) { filter: brightness(1.1); }
.midorii-side-go:disabled { opacity: 0.35; cursor: default; }

.midorii-side-quick { display: flex; gap: 6px; margin-top: 8px; }
.midorii-side-quick button {
    all: unset;
    box-sizing: border-box;
    flex: 1 1 0;
    padding: 5px 0;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-radius-sm);
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-quick button:hover:not(:disabled) { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-side-quick button:disabled { opacity: 0.35; cursor: default; }
.midorii-side-quick button[data-tone='danger']:hover:not(:disabled) { color: var(--vela-danger); }

/* The record. Nothing on a closed trade can be edited, so the rows wear no controls and are
   free to stack two lines deep — which is what fits beside a chart. */
.midorii-side-hist { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

/* The curve is head, not list: it answers "how has it been going", which is the question the
   list is scrolled to answer one trade at a time — it must not scroll away while that happens. */
.midorii-side-pnl {
    flex: 0 0 auto;
    padding: 10px 12px 9px;
    border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-side-curve {
    display: block;
    width: 100%;
    margin-top: 8px;
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-sunken);
}
.midorii-side-pnl-net {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    font-size: 10px;
    color: var(--vela-fg-muted);
}
.midorii-side-pnl-net b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 600;
    color: var(--vela-fg-bright);
}

.midorii-side-hist-list { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px 10px; }
${overlayScrollbarCss('.midorii-side-hist-list')}
.midorii-side-hist-empty { padding: 2px 0; color: var(--vela-fg-muted); }
.midorii-side-more {
    padding: 8px 0 2px;
    font-size: 10px;
    line-height: 1.35;
    color: var(--vela-fg-faint);
}

.midorii-side-trade {
    padding: 7px 0;
    border-bottom: 1px solid var(--vela-border-faint);
    font-variant-numeric: tabular-nums;
}
.midorii-side-trade-top { display: flex; align-items: center; gap: 8px; }
.midorii-side-trade-dir {
    flex: 0 0 auto;
    min-width: 44px;
    padding: 2px 6px;
    border-radius: var(--vela-radius-sm);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-align: center;
}
.midorii-side-trade-dir[data-dir='long'] { color: var(--vela-up); background: color-mix(in srgb, var(--vela-up) 14%, transparent); }
.midorii-side-trade-dir[data-dir='short'] { color: var(--vela-down); background: color-mix(in srgb, var(--vela-down) 14%, transparent); }
.midorii-side-trade-when { flex: 1 1 auto; font-size: 10px; color: var(--vela-fg-faint); }
.midorii-side-trade-pnl {
    flex: 0 0 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--vela-fg-bright);
}
.midorii-side-trade-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin-top: 3px;
    padding-left: 52px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: var(--vela-fg-muted);
}
.midorii-side .up { color: var(--vela-up); }
.midorii-side .down { color: var(--vela-down); }
`;

/** Nothing to state yet — a dash, never a zero. */
const NONE = '—';

/** What the panel can ask the session to do. Every one already exists on the controller. */
export interface SidebarActions {
    order(spec: OrderSpec): void;
    flatten(): void;
    cancelAll(): void;
}

export interface TradeSidebarOptions {
    /** The account and the last price, read fresh on every repaint. */
    account(): TicketAccount;
    /** What is open and what is waiting — only the counts, for the two quick buttons. */
    counts(): { positions: number; orders: number };
    actions: SidebarActions;
    /** Starting risk settings. The panel owns them from then on — see {@link TradeSidebar.risk}. */
    risk?: RiskSettings;
    /**
     * Closed round trips, newest first, read fresh on every repaint.
     *
     * Absent where the account keeps none — a replay's result is read in the run library
     * afterwards, in one piece — and then the tab is not offered at all rather than offered
     * empty.
     */
    history?(): readonly HistoryRow[];
}

export interface TradeSidebar {
    /** The panel itself, so whoever mounted it can take it away again. */
    readonly el: HTMLElement;
    /**
     * The risk settings as they stand.
     *
     * The panel is where they are set, and they are not only its own: a block traded from the
     * chart is sized by the same numbers. One session, one answer to "how much may this lose"
     * — two would mean the same 1% meant different money depending on which hand placed the
     * trade.
     */
    risk(): RiskSettings;
    /** Repaint the derived figures from the account as it stands. Never touches the boxes. */
    refresh(): void;
}

/** A row of mutually exclusive buttons. Returns the element; `sync` repaints the selection. */
function segmented<T extends string>(
    doc: Document,
    options: readonly { value: T; label: string }[],
    current: () => T,
    onPick: (value: T) => void,
): { el: HTMLElement; sync(): void } {
    const el = doc.createElement('div');
    el.className = 'midorii-side-seg';
    const buttons = options.map((o) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.onclick = () => onPick(o.value);
        el.append(b);
        return { b, value: o.value };
    });
    const sync = (): void => {
        for (const { b, value } of buttons) {
            if (value === current()) b.dataset.on = '';
            else delete b.dataset.on;
        }
    };
    sync();
    return { el, sync };
}

/**
 * A price box that commits on Enter or on leaving it, and never on every keystroke — a stop
 * typed one digit at a time would otherwise be read as 7, then 77, then 779, and the size
 * beside it would jump about while it was being typed.
 *
 * Empty means "no level", which is how a stop is taken back off.
 */
function priceInput(doc: Document, placeholder: string, commit: (price: number | null) => void): HTMLInputElement {
    const input = doc.createElement('input');
    input.className = 'midorii-side-price';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;

    const apply = (): void => {
        const raw = input.value.trim();
        if (raw === '') {
            commit(null);
            return;
        }
        const price = Number(raw);
        // A price that does not parse is left in the box rather than silently dropped: it is
        // what was typed, and clearing it would hide the typo instead of showing it.
        if (Number.isFinite(price) && price > 0) commit(price);
        else commit(null);
    };

    input.addEventListener('blur', apply);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = '';
            commit(null);
            input.blur();
        }
    });
    return input;
}

/** A labelled control on its own line, with a slot for a hint underneath. */
function row(doc: Document, label: string, control: HTMLElement): { el: HTMLElement; hint: HTMLElement } {
    const el = doc.createElement('div');
    el.className = 'midorii-side-row';
    el.dataset.hint = '';
    const name = doc.createElement('span');
    name.textContent = label;
    el.append(name, control);

    const hint = doc.createElement('div');
    hint.className = 'midorii-side-hint';
    return { el, hint };
}

/** One figure in the readout: caption, value, and a second line for what qualifies it. */
function outCell(doc: Document, caption: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } {
    const el = doc.createElement('div');
    const small = doc.createElement('small');
    small.textContent = caption;
    const value = doc.createElement('b');
    const sub = doc.createElement('i');
    el.append(small, value, sub);
    return { el, value, sub };
}

/** How far back the curve is drawn. */
type PnlSpan = 'all' | 'month' | 'week' | 'day';

/** How far back each window reaches. All time has no floor. */
const SPAN_MS: Record<Exclude<PnlSpan, 'all'>, number> = {
    month: 30 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
};

/**
 * The window's realised PnL, trade by trade, oldest first.
 *
 * Realised only: what is still open moves with every tick and belongs on the chart, not in a
 * record of what has already been decided.
 *
 * It starts at zero where the first trade in the window was OPENED rather than at the edge of
 * the window itself — the line then says what has been made since trading last started, and
 * does not spend half its width on hours nothing happened in.
 */
function pnlPoints(history: readonly HistoryRow[], span: PnlSpan): { time: number; balance: number }[] {
    const since = span === 'all' ? 0 : Date.now() - SPAN_MS[span];
    // The history is newest first; a curve is read the other way round.
    const trades = history.filter((t) => t.closedAt >= since).reverse();
    if (trades.length === 0) return [];

    const first = trades[0]!;
    const points = [{ time: Math.min(first.openedAt, first.closedAt), balance: 0 }];
    let sum = 0;
    for (const t of trades) {
        sum += t.netPnl;
        points.push({ time: t.closedAt, balance: sum });
    }
    return points;
}

/**
 * The window as a line, with zero drawn across it so up and down are visible.
 *
 * The geometry is the run library's own — one answer to "where does this point go", so a
 * curve read beside the chart and the same curve read afterwards are the same shape.
 */
function pnlCurveSvg(doc: Document, points: ReadonlyArray<{ time: number; balance: number }>): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 280;
    const H = 56;

    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'midorii-side-curve');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = `${H}px`;

    // Room above and below, so a line that ends at its own high is not drawn on the edge.
    const line = equityPath(points, W, H - 12, 0);
    if (!line.d) return svg;

    const g = doc.createElementNS(NS, 'g');
    g.setAttribute('transform', 'translate(0 6)');

    if (line.baselineY !== null) {
        const base = doc.createElementNS(NS, 'line');
        base.setAttribute('x1', '0');
        base.setAttribute('x2', String(W));
        base.setAttribute('y1', String(line.baselineY));
        base.setAttribute('y2', String(line.baselineY));
        base.setAttribute('stroke', 'var(--vela-border-strong)');
        base.setAttribute('stroke-dasharray', '4 4');
        base.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(base);
    }

    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', line.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    // The whole window in one colour: it is up or it is not.
    path.setAttribute('stroke', points[points.length - 1]!.balance >= 0 ? 'var(--vela-up)' : 'var(--vela-down)');
    g.appendChild(path);

    svg.appendChild(g);
    return svg;
}

/** How many closed trades are put in the DOM. Older ones are counted, not drawn — a history
 *  of ten thousand rows is a scroll nobody reads and a paint everybody waits for. */
const HISTORY_SHOWN = 200;

/** One closed trade, as a record: two lines, and nothing on it to press. */
function tradeRow(doc: Document, t: HistoryRow): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-side-trade';

    const top = doc.createElement('div');
    top.className = 'midorii-side-trade-top';
    const dir = doc.createElement('span');
    dir.className = 'midorii-side-trade-dir';
    dir.dataset.dir = t.side;
    dir.textContent = t.side === 'long' ? 'LONG' : 'SHORT';
    const when = doc.createElement('span');
    when.className = 'midorii-side-trade-when';
    when.textContent = formatWhen(t.closedAt);
    const pnl = doc.createElement('b');
    pnl.className = 'midorii-side-trade-pnl';
    if (t.netPnl !== 0) pnl.classList.add(t.netPnl > 0 ? 'up' : 'down');
    pnl.textContent = formatSignedMoney(t.netPnl);
    top.append(dir, when, pnl);

    const sub = doc.createElement('div');
    sub.className = 'midorii-side-trade-sub';
    const part = (text: string, tone?: 'up' | 'down'): HTMLElement => {
        const span = doc.createElement('span');
        if (tone) span.classList.add(tone);
        span.textContent = text;
        return span;
    };
    sub.append(
        part(formatSize(t.size)),
        part(`${formatMoney(t.entryPrice)} → ${formatMoney(t.exitPrice)}`),
        part(formatR(t.r), t.r == null || t.r === 0 ? undefined : t.r > 0 ? 'up' : 'down'),
    );
    // How it ended, where the engine recorded one — a stop and a target read very differently.
    if (t.exitTag) sub.append(part(t.exitTag));
    el.append(top, sub);
    return el;
}

/**
 * Mount the panel. The caller owns the element afterwards — `el.remove()` takes it away, and
 * there is nothing else to release.
 */
export function mountTradeSidebar(host: HTMLElement, opts: TradeSidebarOptions): TradeSidebar {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const draft: TicketDraft = emptyTicket();
    const risk: RiskSettings = { ...(opts.risk ?? DEFAULT_RISK) };

    const el = doc.createElement('div');
    el.className = 'midorii-side';

    // ── head ─────────────────────────────────────────────────────────────
    const head = doc.createElement('div');
    head.className = 'midorii-side-head';

    const tabs = doc.createElement('div');
    tabs.className = 'midorii-side-tabs';
    const tab = (name: 'trade' | 'history', label: string): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.className = 'midorii-side-tab';
        b.type = 'button';
        b.textContent = label;
        b.onclick = () => setTab(name);
        tabs.append(b);
        return b;
    };
    const tradeTab = tab('trade', 'Trade');
    const historyTab = tab('history', 'History');
    // Nothing to show without an account that keeps a history, so nothing is offered.
    historyTab.hidden = opts.history == null;

    const fold = doc.createElement('button');
    fold.className = 'midorii-side-fold';
    head.append(tabs, fold);

    const rail = doc.createElement('button');
    rail.className = 'midorii-side-rail';

    const setFolded = (folded: boolean): void => {
        if (folded) el.setAttribute('data-collapsed', '');
        else el.removeAttribute('data-collapsed');
        fold.textContent = folded ? '‹' : '›';
        fold.title = folded ? 'Open the ticket' : 'Fold the ticket away';
        rail.title = fold.title;
    };
    fold.onclick = () => setFolded(!el.hasAttribute('data-collapsed'));
    rail.onclick = () => setFolded(false);
    setFolded(false);

    // ── order ────────────────────────────────────────────────────────────
    const body = doc.createElement('div');
    body.className = 'midorii-side-body';

    const orderHead = doc.createElement('div');
    orderHead.className = 'midorii-side-sect';
    orderHead.textContent = 'Order';

    const types = segmented(
        doc,
        [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }] as const,
        () => draft.type,
        (value) => {
            draft.type = value;
            types.sync();
            refresh();
        },
    );

    const entryBox = priceInput(doc, 'Price', (v) => { draft.entryPrice = v; refresh(); });
    const entry = row(doc, 'Entry', entryBox);
    const stopBox = priceInput(doc, NONE, (v) => { draft.stopLoss = v; refresh(); });
    const stop = row(doc, 'Stop loss', stopBox);
    const targetBox = priceInput(doc, NONE, (v) => { draft.takeProfit = v; refresh(); });
    const target = row(doc, 'Take profit', targetBox);

    // ── size ─────────────────────────────────────────────────────────────
    const sizeHead = doc.createElement('div');
    sizeHead.className = 'midorii-side-sect';
    sizeHead.textContent = 'Size';

    const sizings = segmented(
        doc,
        [{ value: 'risk', label: 'By risk' }, { value: 'fixed', label: 'Fixed units' }] as const,
        () => draft.sizing,
        (value) => {
            draft.sizing = value;
            sizings.sync();
            refresh();
        },
    );

    /* Percent or cash, on the field itself rather than in a second dropdown: it is one
     * question about one number, and the answer belongs next to it. */
    const unit = doc.createElement('div');
    unit.className = 'midorii-side-unit';
    const riskValue = new NumberInput({
        value: risk.value, min: 0.01, max: 1e6, step: 0.25, size: 'sm', fill: true,
        onChange: (v) => { risk.value = v; refresh(); },
    });
    const unitBtn = doc.createElement('button');
    unitBtn.type = 'button';
    unitBtn.title = 'Read the risk as a percentage of equity, or as cash';
    unitBtn.onclick = () => {
        risk.mode = risk.mode === 'percent' ? 'fixed' : 'percent';
        refresh();
    };
    unit.append(riskValue.el, unitBtn);
    const riskRow = row(doc, 'Risk', unit);

    const leverage = new NumberInput({
        value: risk.maxLeverage, min: 1, max: 100, step: 0.5, size: 'sm', fill: true,
        onChange: (v) => { risk.maxLeverage = v; refresh(); },
    });
    const leverageRow = row(doc, 'Max leverage', leverage.el);

    const fixed = new NumberInput({
        value: 0, min: 0, step: 0.01, size: 'sm', fill: true,
        onChange: (v) => { draft.fixedSize = v > 0 ? v : null; refresh(); },
    });
    const fixedRow = row(doc, 'Units', fixed.el);

    // ── readout ──────────────────────────────────────────────────────────
    const out = doc.createElement('div');
    out.className = 'midorii-side-out';
    const outSize = outCell(doc, 'Size');
    const outNotional = outCell(doc, 'Notional');
    const outRisk = outCell(doc, 'Risk');
    const outRr = outCell(doc, 'Reward : risk');
    out.append(outSize.el, outNotional.el, outRisk.el, outRr.el);

    body.append(
        orderHead, types.el,
        entry.el, entry.hint,
        stop.el, stop.hint,
        target.el, target.hint,
        sizeHead, sizings.el,
        riskRow.el, riskRow.hint,
        leverageRow.el, leverageRow.hint,
        fixedRow.el, fixedRow.hint,
        out,
    );

    // ── send ─────────────────────────────────────────────────────────────
    const foot = doc.createElement('div');
    foot.className = 'midorii-side-foot';
    const why = doc.createElement('div');
    why.className = 'midorii-side-why';

    const sides = doc.createElement('div');
    sides.className = 'midorii-side-sides';
    const go = (side: 'buy' | 'sell'): { btn: HTMLButtonElement; price: HTMLElement } => {
        const btn = doc.createElement('button');
        btn.className = 'midorii-side-go';
        btn.type = 'button';
        btn.dataset.side = side;
        const price = doc.createElement('small');
        btn.append(doc.createTextNode(side === 'buy' ? 'Buy' : 'Sell'), price);
        btn.onclick = () => send(side);
        sides.append(btn);
        return { btn, price };
    };
    const buy = go('buy');
    const sell = go('sell');

    const quick = doc.createElement('div');
    quick.className = 'midorii-side-quick';
    const cancelAll = doc.createElement('button');
    cancelAll.type = 'button';
    cancelAll.textContent = 'Cancel orders';
    cancelAll.onclick = () => opts.actions.cancelAll();
    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.dataset.tone = 'danger';
    flatten.textContent = 'Flatten';
    /* The panic button, where the hand already is. The dock has one too — that is not a
     * duplicate to tidy away: reaching to the other end of the screen to get out is exactly
     * the moment it must not be a reach. */
    flatten.onclick = () => opts.actions.flatten();
    quick.append(cancelAll, flatten);

    foot.append(why, sides, quick);

    // ── history ──────────────────────────────────────────────────────────
    const hist = doc.createElement('div');
    hist.className = 'midorii-side-hist';

    /* Four windows on the same trades. "How has it been going" is a different question over a
     * day than over a year, and a week that undid a month is only visible from both. */
    let span: PnlSpan = 'all';
    const spans = segmented(
        doc,
        [
            { value: 'all', label: 'All time' },
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
            { value: 'day', label: 'Day' },
        ] as const,
        () => span,
        (value) => {
            span = value;
            spans.sync();
            renderCurve();
        },
    );

    const pnl = doc.createElement('div');
    pnl.className = 'midorii-side-pnl';
    let curve = pnlCurveSvg(doc, []);
    const net = doc.createElement('div');
    net.className = 'midorii-side-pnl-net';
    const netValue = doc.createElement('b');
    const netCount = doc.createElement('span');
    net.append(netValue, netCount);
    pnl.append(spans.el, curve, net);

    const histList = doc.createElement('div');
    histList.className = 'midorii-side-hist-list';
    hist.append(pnl, histList);

    /* How long the drawn list is, so an unchanged one is left alone: refresh() runs on every
     * tick, and rebuilding two hundred closed trades at that rate is the one thing in this
     * panel that would make the chart stutter. A history only ever grows or is replaced
     * wholesale by a reset, so its length identifies it. */
    let drawnHistory = -1;

    el.append(head, rail, body, hist, foot);
    host.appendChild(el);

    /** Which half is on. The other is hidden rather than unmounted — a ticket half-typed is
     *  not a thing to throw away because the record was glanced at. */
    function setTab(next: 'trade' | 'history'): void {
        for (const [b, name] of [[tradeTab, 'trade'], [historyTab, 'history']] as const) {
            if (name === next) b.dataset.on = '';
            else delete b.dataset.on;
        }
        /* The foot goes with the ticket: Buy and Sell under a list of finished trades would
         * send an order from a panel that is not showing what it was sized against. */
        body.hidden = next !== 'trade';
        foot.hidden = next !== 'trade';
        hist.hidden = next !== 'history';
        rail.textContent = next === 'trade' ? 'Trade' : 'History';
    }

    /** Redraw the curve over the window as it stands, and the money it comes to. */
    function renderCurve(): void {
        const points = pnlPoints(opts.history?.() ?? [], span);
        const next = pnlCurveSvg(doc, points);
        curve.replaceWith(next);
        curve = next;

        netValue.classList.remove('up', 'down');
        if (points.length === 0) {
            netValue.textContent = NONE;
            netCount.textContent = span === 'all' ? 'Nothing closed yet' : 'Nothing closed in this window';
            return;
        }

        // The first point is the zero the line starts from, not a trade.
        const closed = points.length - 1;
        const total = points[closed]!.balance;
        netValue.textContent = formatSignedMoney(total);
        if (total !== 0) netValue.classList.add(total > 0 ? 'up' : 'down');
        netCount.textContent = closed === 1 ? '1 trade' : `${closed} trades`;
    }

    /** Redraw the closed trades, but only when there is a different set of them. */
    function renderHistory(): void {
        const history = opts.history?.() ?? [];
        if (history.length === drawnHistory) return;
        drawnHistory = history.length;

        renderCurve();

        histList.replaceChildren();
        if (history.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'midorii-side-hist-empty';
            empty.textContent = 'Nothing closed yet.';
            histList.append(empty);
            return;
        }

        histList.append(...history.slice(0, HISTORY_SHOWN).map((t) => tradeRow(doc, t)));
        if (history.length > HISTORY_SHOWN) {
            const more = doc.createElement('div');
            more.className = 'midorii-side-more';
            more.textContent = `${history.length - HISTORY_SHOWN} older trades are in the account but not drawn here.`;
            histList.append(more);
        }
    }

    /** Distance from the reference, as a signed percentage — or nothing to say. */
    function away(level: number | null, reference: number | null): string {
        if (level == null || reference == null || reference <= 0) return '';
        return formatPercent((level - reference) / reference, 2, true);
    }

    function refresh(): void {
        const account = opts.account();
        const plan = ticketPlan(draft, account, risk);
        const buyWhy = ticketRefusal(draft, 'buy', account, plan);
        const sellWhy = ticketRefusal(draft, 'sell', account, plan);

        // A market order has no price of its own to wait at.
        entry.el.hidden = draft.type === 'market';
        entry.hint.hidden = draft.type === 'market';
        entry.hint.textContent = away(draft.entryPrice, account.price > 0 ? account.price : null);

        stop.hint.textContent = away(draft.stopLoss, plan.reference);
        target.hint.textContent = away(draft.takeProfit, plan.reference);

        const byRisk = draft.sizing === 'risk';
        for (const r of [riskRow, leverageRow]) {
            r.el.hidden = !byRisk;
            r.hint.hidden = !byRisk;
        }
        fixedRow.el.hidden = byRisk;
        fixedRow.hint.hidden = byRisk;

        unitBtn.textContent = risk.mode === 'percent' ? '%' : 'cash';
        // The half that was not typed: 1% of this account is that much money, and vice versa.
        riskRow.hint.textContent = risk.mode === 'percent'
            ? `≈ ${formatMoney((account.equity * risk.value) / 100)}`
            : account.equity > 0 ? `≈ ${formatPercent(risk.value / account.equity)} of equity` : '';
        leverageRow.hint.textContent = '';
        fixedRow.hint.textContent = '';

        outSize.value.textContent = plan.size == null ? NONE : formatSize(plan.size);
        outSize.sub.textContent = plan.capped ? 'at the leverage cap' : '';
        outSize.sub.classList.toggle('warn', plan.capped);

        outNotional.value.textContent = plan.notional == null ? NONE : formatMoney(plan.notional);
        outNotional.sub.textContent = plan.notional != null && account.equity > 0
            ? `${(plan.notional / account.equity).toFixed(2)}× equity`
            : '';

        outRisk.value.textContent = plan.risk == null ? NONE : formatMoney(plan.risk.cash);
        outRisk.sub.textContent = plan.risk?.share == null ? '' : `${formatPercent(plan.risk.share)} of equity`;

        outRr.value.textContent = plan.rr == null ? NONE : `${plan.rr.toFixed(2)} R`;
        outRr.sub.textContent = '';

        for (const [g, refusal] of [[buy, buyWhy], [sell, sellWhy]] as const) {
            g.btn.disabled = refusal != null;
            g.btn.title = refusal ?? '';
            g.price.textContent = plan.reference == null ? NONE : formatMoney(plan.reference);
        }
        /* Only when neither side can be sent: with one side live the panel works, and a red
         * line under a button that is merely the wrong direction would be noise. The greyed
         * button still carries its own reason. */
        why.textContent = buyWhy != null && sellWhy != null ? buyWhy : '';

        const counts = opts.counts();
        cancelAll.disabled = counts.orders === 0;
        flatten.disabled = counts.positions === 0;

        renderHistory();
    }

    function send(side: 'buy' | 'sell'): void {
        const account = opts.account();
        const plan = ticketPlan(draft, account, risk);
        if (ticketRefusal(draft, side, account, plan) != null || plan.size == null) return;

        opts.actions.order(ticketOrder(draft, side, plan.size));

        /* Emptied afterwards. A ticket still holding the last trade's stop is the one mistake
         * here that costs money: the next click would send a level from a setup that is over.
         * The order type and the risk settings stay — those are how this session is traded,
         * not what this trade was. */
        draft.entryPrice = null;
        draft.stopLoss = null;
        draft.takeProfit = null;
        entryBox.value = '';
        stopBox.value = '';
        targetBox.value = '';
        refresh();
    }

    setTab('trade');
    refresh();

    return {
        el,
        risk: () => ({ ...risk }),
        refresh,
    };
}
