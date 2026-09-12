import { injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatSize } from '../format';

/**
 * The tape: what actually traded, one print at a time.
 *
 * A bar is a summary of a minute. The tape is the minute itself, and the two things it says
 * that a bar cannot are the two reasons to read it: WHO crossed the spread — the print carries
 * its aggressor — and how the size was distributed, which is the difference between a move
 * made by one participant and the same move made by four hundred.
 *
 * Prints arrive in bursts, so they are folded into one repaint rather than appended one at a
 * time: twenty rows added individually is twenty layouts for a list that would look identical.
 *
 * Consecutive prints at the same price and side are rolled into one row with their sizes
 * added. A tape that printed 1, 1, 1, 1, 1 down a column is a tape nobody can read; the same
 * five as a single 5 is the thing that was actually noticed.
 */

const STYLE_ID = 'midorii-tape';
const CSS = `
.midorii-tape { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

.midorii-tape-head {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: 1fr 1.2fr 1fr;
    gap: var(--vela-space-2);
    padding: var(--vela-space-2) var(--vela-space-3);
    border-bottom: 1px solid var(--vela-border-faint);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-tape-head > :nth-child(2) { text-align: center; }
.midorii-tape-head > :last-child { text-align: right; }

.midorii-tape-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px var(--vela-space-3) 8px; }
${overlayScrollbarCss('.midorii-tape-list')}

.midorii-tape-row {
    display: grid;
    grid-template-columns: 1fr 1.2fr 1fr;
    gap: var(--vela-space-2);
    height: 18px;
    font-family: var(--vela-font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--vela-font-size-sm);
    line-height: 18px;
}
.midorii-tape-when { color: var(--vela-fg-faint); }
.midorii-tape-price { text-align: center; font-weight: 600; color: var(--vela-fg-bright); }
.midorii-tape-size {
    position: relative;
    text-align: right;
    font-weight: 600;
    /* The size bar sits behind the figure rather than beside it: a tape is read down the price
       column, and a second column of bars would be the widest thing on a 296px panel. */
    isolation: isolate;
}
.midorii-tape-size::before {
    content: '';
    position: absolute;
    inset: 2px 0 2px auto;
    width: var(--midorii-tape-share, 0%);
    right: 0;
    border-radius: var(--vela-radius-sm);
    opacity: 0.18;
    z-index: -1;
}
.midorii-tape-row[data-side='buy'] .midorii-tape-size { color: var(--vela-up); }
.midorii-tape-row[data-side='sell'] .midorii-tape-size { color: var(--vela-down); }
.midorii-tape-row[data-side='buy'] .midorii-tape-size::before { background: var(--vela-up); }
.midorii-tape-row[data-side='sell'] .midorii-tape-size::before { background: var(--vela-down); }
/* A print big enough to be the reason something moved reads as one. */
.midorii-tape-row[data-heavy='1'] .midorii-tape-price { color: var(--vela-fg-bright); }
.midorii-tape-row[data-heavy='1'] .midorii-tape-size { font-weight: 700; }

.midorii-tape-empty {
    padding: var(--vela-space-3);
    font-size: var(--vela-font-size-sm);
    line-height: 1.45;
    color: var(--vela-fg-muted);
}
`;

/** How many rows are kept. Past this the tape is scrolled through, not read. */
export const TAPE_ROWS = 200;

/** One print, as this module reads it. */
export interface TapePrint {
    /** Epoch milliseconds. */
    time: number;
    price: number;
    size: number;
    /** Who crossed the spread. */
    side: 'buy' | 'sell';
}

/** One row: a run of prints at the same price, on the same side, back to back. */
export interface TapeRow extends TapePrint {
    /** How many prints were rolled into this row. One means it stands alone. */
    prints: number;
}

/**
 * Fold a burst of prints into the rows already showing, newest first.
 *
 * Consecutive prints at the same price and side are added together rather than listed: five
 * lots that traded in the same instant at the same price were one event, and printing them as
 * five rows pushes the thing worth seeing off the top of the panel.
 *
 * `incoming` is oldest-first, the order the feed sends it; `rows` is newest-first, the order a
 * tape is read in.
 */
export function foldPrints(rows: readonly TapeRow[], incoming: readonly TapePrint[], limit = TAPE_ROWS): TapeRow[] {
    if (incoming.length === 0) return rows as TapeRow[];
    const out = rows.slice();
    for (const print of incoming) {
        if (!(print.size > 0) || !(print.price > 0)) continue;
        const head = out[0];
        if (head && head.price === print.price && head.side === print.side) {
            /* Rolled into the row above, which keeps the newest timestamp: the run is still
             * happening, and the time that matters is the one it last happened at. */
            out[0] = { ...head, size: head.size + print.size, prints: head.prints + 1, time: print.time };
            continue;
        }
        out.unshift({ ...print, prints: 1 });
    }
    return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Which prints are big enough to stand out, given what has been going through.
 *
 * A fixed threshold cannot serve two instruments — twenty lots is a large print on one and
 * noise on another — so it is read off the tape itself: the size at the given quantile of what
 * is currently showing. Returns zero where there is nothing to compare against, which marks
 * nothing rather than marking everything.
 */
export function heavyFrom(rows: readonly TapeRow[], quantile = 0.9): number {
    if (rows.length < 10) return 0;
    const sizes = rows.map((r) => r.size).sort((a, b) => a - b);
    const at = Math.min(sizes.length - 1, Math.floor(sizes.length * quantile));
    return sizes[at] ?? 0;
}

/** `14:32:07` — the clock, to the second, in the reader's own time. */
function clock(ms: number): string {
    const at = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export interface TimeAndSalesOptions {
    /** How a price is written — the instrument's own precision. */
    priceText(price: number): string;
}

export interface TimeAndSales {
    readonly el: HTMLElement;
    /** Take a burst of prints. Repaints once, however many arrived. */
    push(prints: readonly TapePrint[]): void;
    destroy(): void;
}

export function mountTimeAndSales(host: HTMLElement, opts: TimeAndSalesOptions): TimeAndSales {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-tape';

    const head = doc.createElement('div');
    head.className = 'midorii-tape-head';
    for (const label of ['Time', 'Price', 'Size']) {
        const cell = doc.createElement('span');
        cell.textContent = label;
        head.append(cell);
    }

    const list = doc.createElement('div');
    list.className = 'midorii-tape-list';

    const empty = doc.createElement('p');
    empty.className = 'midorii-tape-empty';
    empty.textContent = 'Waiting for the first print. Prints at the same price and side, back to back, '
        + 'are shown as one row with their sizes added.';
    list.append(empty);

    el.append(head, list);
    host.append(el);

    let rows: TapeRow[] = [];
    /** The biggest size currently showing, so the bars behind the sizes are comparable. */
    let peak = 0;

    function render(): void {
        if (rows.length === 0) {
            list.replaceChildren(empty);
            return;
        }
        const heavy = heavyFrom(rows);
        const nodes = rows.map((row) => {
            const node = doc.createElement('div');
            node.className = 'midorii-tape-row';
            node.dataset.side = row.side;
            if (heavy > 0 && row.size >= heavy) node.dataset.heavy = '1';

            const when = doc.createElement('span');
            when.className = 'midorii-tape-when';
            when.textContent = clock(row.time);

            const price = doc.createElement('span');
            price.className = 'midorii-tape-price';
            price.textContent = opts.priceText(row.price);

            const size = doc.createElement('span');
            size.className = 'midorii-tape-size';
            size.textContent = formatSize(row.size);
            size.style.setProperty('--midorii-tape-share', peak > 0 ? `${Math.min(100, (row.size / peak) * 100)}%` : '0%');
            if (row.prints > 1) size.title = `${row.prints} prints at this price, added`;

            node.append(when, price, size);
            return node;
        });
        list.replaceChildren(...nodes);
    }

    return {
        el,
        push(prints: readonly TapePrint[]): void {
            rows = foldPrints(rows, prints);
            peak = rows.reduce((most, row) => (row.size > most ? row.size : most), 0);
            render();
        },
        destroy(): void {
            el.remove();
        },
    };
}
