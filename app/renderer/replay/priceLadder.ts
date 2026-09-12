import { injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatSize } from '../format';
import type { OrderSpec } from '../../../shared/engine/broker.js';

/**
 * The ladder: prices as a column, and everything you own laid out against them.
 *
 * A chart answers "where has this been"; a ladder answers "where is it now, and what of mine
 * is sitting there". They are different questions and the second one is the one being asked
 * while a trade is on — which is why every futures platform has one and why it is worth the
 * room it takes.
 *
 * What this ladder does NOT claim
 * ------------------------------
 * A classic DOM shows resting SIZE at every price, ten deep on each side. This gateway
 * publishes only the top of book, so there is no such thing to draw and none is drawn: the
 * two size columns are for what is YOURS — working orders and the position — and the best bid
 * and ask are marked as the two rows they are. An invented depth column would be the most
 * convincing wrong thing on the screen.
 *
 * The volume behind the prices is real and is this session's: it is folded from the same bar
 * stream the chart is drawn from, so it begins when the chart does rather than at the open.
 * Said on the panel rather than left to be discovered.
 *
 * Nothing here decides anything. A click sends an order through the same call the ticket uses,
 * and what appears on the ladder afterwards is whatever the account reports.
 */

const STYLE_ID = 'midorii-ladder';
const CSS = `
.midorii-ladder { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

.midorii-ladder-head {
    flex: 0 0 auto;
    display: flex; align-items: center; gap: var(--vela-space-2);
    padding: var(--vela-space-2) var(--vela-space-3);
    border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-ladder-sizes { flex: 1 1 auto; display: flex; gap: var(--vela-space-1); min-width: 0; }
.midorii-ladder-sizes button {
    all: unset;
    flex: 1 1 0;
    min-width: 0;
    padding: 4px 0;
    border-radius: 999px;
    background: var(--vela-surface-overlay);
    font-family: var(--vela-font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--vela-font-size-sm);
    font-weight: 600;
    color: var(--vela-fg-muted);
    text-align: center;
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease), color var(--vela-dur-fast) var(--vela-ease);
}
.midorii-ladder-sizes button:hover { background: var(--vela-hover-strong); color: var(--vela-fg-bright); }
.midorii-ladder-sizes button[data-on] { background: var(--vela-selected-bg); color: var(--vela-selected-fg); }

.midorii-ladder-recenter {
    all: unset;
    flex: 0 0 auto;
    width: 22px; height: 22px;
    display: grid; place-items: center;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    font-size: 12px;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--vela-dur-fast) var(--vela-ease), background var(--vela-dur-fast) var(--vela-ease);
}
.midorii-ladder[data-adrift='1'] .midorii-ladder-recenter { opacity: 1; pointer-events: auto; }
.midorii-ladder-recenter:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

/* The grid. Three columns, and the two outer ones are where a press lands — the price itself
   is a label, never a target, so there is no cell whose meaning depends on aiming well. */
.midorii-ladder-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
${overlayScrollbarCss('.midorii-ladder-rows')}

.midorii-ladder-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    align-items: stretch;
    height: 19px;
    font-family: var(--vela-font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--vela-font-size-sm);
    line-height: 19px;
}
.midorii-ladder-row + .midorii-ladder-row { box-shadow: inset 0 1px 0 var(--vela-border-faint); }

.midorii-ladder-cell {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--vela-fg-faint);
    transition: background var(--vela-dur-fast) var(--vela-ease);
}
.midorii-ladder-cell[data-col='buy']:hover { background: color-mix(in srgb, var(--vela-up) 16%, transparent); }
.midorii-ladder-cell[data-col='sell']:hover { background: color-mix(in srgb, var(--vela-down) 16%, transparent); }
/* What the press would do, shown before it is made rather than explained after. */
.midorii-ladder-cell::after {
    content: attr(data-ghost);
    font-size: 10px;
    font-weight: 600;
    opacity: 0;
    transition: opacity var(--vela-dur-fast) var(--vela-ease);
}
.midorii-ladder-cell:hover::after { opacity: 0.75; }
.midorii-ladder-cell[data-col='buy']:hover::after { color: var(--vela-up); }
.midorii-ladder-cell[data-col='sell']:hover::after { color: var(--vela-down); }
.midorii-ladder-cell:has(.midorii-ladder-chip)::after { content: ''; }

/* The price column: a label, and the session's volume behind it. */
.midorii-ladder-price {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    color: var(--vela-fg-muted);
    font-weight: 600;
}
.midorii-ladder-vol {
    position: absolute;
    inset: 2px auto 2px 50%;
    transform: translateX(-50%);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-fg-faint);
    opacity: 0.16;
    pointer-events: none;
}
.midorii-ladder-price > span { position: relative; }

/* The three rows that are not like the others. */
.midorii-ladder-row[data-bid='1'] .midorii-ladder-cell[data-col='buy'] { background: color-mix(in srgb, var(--vela-up) 12%, transparent); }
.midorii-ladder-row[data-ask='1'] .midorii-ladder-cell[data-col='sell'] { background: color-mix(in srgb, var(--vela-down) 12%, transparent); }
.midorii-ladder-row[data-last='1'] .midorii-ladder-price { background: var(--vela-chrome); color: var(--vela-fg-bright); }
.midorii-ladder-row[data-entry='1'] .midorii-ladder-price { box-shadow: inset 2px 0 0 var(--vela-accent), inset -2px 0 0 var(--vela-accent); }

/* Something of yours, sitting at this price. */
.midorii-ladder-chip {
    position: relative;
    min-width: 20px;
    padding: 0 6px;
    border-radius: var(--vela-radius-sm);
    font-size: 10px;
    font-weight: 700;
    line-height: 15px;
    color: var(--vela-fg-on-fill);
    transition: filter var(--vela-dur-fast) var(--vela-ease);
}
.midorii-ladder-chip[data-kind='buy'] { background: var(--vela-up); }
.midorii-ladder-chip[data-kind='sell'] { background: var(--vela-down); }
.midorii-ladder-chip[data-kind='position'] { background: var(--vela-accent); }
.midorii-ladder-chip[data-kind='stop'] { background: transparent; color: var(--vela-down); box-shadow: inset 0 0 0 1px var(--vela-down); }
.midorii-ladder-chip[data-kind='target'] { background: transparent; color: var(--vela-up); box-shadow: inset 0 0 0 1px var(--vela-up); }
.midorii-ladder-cell:hover .midorii-ladder-chip[data-cancels='1'] { filter: brightness(1.15); }
.midorii-ladder-cell:hover .midorii-ladder-chip[data-cancels='1']::after {
    content: '✕';
    margin-left: 5px;
    font-weight: 600;
}

.midorii-ladder-foot {
    flex: 0 0 auto;
    padding: var(--vela-space-2) var(--vela-space-3);
    border-top: 1px solid var(--vela-border-faint);
    font-size: 10px;
    line-height: 1.35;
    color: var(--vela-fg-faint);
}
`;

/** How many price rows the ladder holds. Odd, so there is a middle for the market to sit on. */
const ROWS = 61;
/** How far the market may drift from the middle before the recentre button offers itself. */
const DRIFT_ROWS = 12;

/** A position, as far as the ladder needs one. */
export interface LadderPosition {
    /** Signed: above zero is long. */
    size: number;
    entryPrice: number;
    stopLoss: number | null;
    takeProfit: number | null;
}

/** A working order, as far as the ladder needs one. */
export interface LadderOrder {
    id: number;
    side: 'buy' | 'sell';
    price: number;
    size: number;
}

export interface PriceLadderOptions {
    /** The last traded price. The ladder is built around it. */
    price(): number;
    /** The two sides, where the feed states them. Null marks neither row. */
    quote(): { bid: number; ask: number } | null;
    /** The instrument's own increment — one row is one of these. Null ⇒ no ladder. */
    tick(): number | null;
    positions(): readonly LadderPosition[];
    orders(): readonly LadderOrder[];
    /** The sizes offered at the top. The first is what a press sends until another is picked. */
    sizes(): readonly number[];
    /** Send an order. The same call the ticket makes, refusals included. */
    order(spec: OrderSpec): void;
    cancelOrder(id: number): void;
}

export interface PriceLadder {
    readonly el: HTMLElement;
    /** Redraw from the account as it stands. Cheap enough for every tick. */
    refresh(): void;
    /** Fold the session's volume in from a bar. Called as the chart receives them. */
    mark(price: number, volume: number): void;
    destroy(): void;
}

/**
 * A price on the instrument's own grid.
 *
 * Rounded through the tick rather than to a number of decimals, because a futures grid is not
 * decimal — a quarter-point tick has prices ending in .25 and .75, and a "two decimal places"
 * rule would print rows the venue does not trade.
 */
function onGrid(price: number, tick: number): number {
    return Number((Math.round(price / tick) * tick).toFixed(8));
}

/** How a price is written in the column, at the precision the tick actually needs. */
function priceText(price: number, tick: number): string {
    const decimals = (() => {
        for (let d = 0; d <= 8; d += 1) {
            if (Math.abs(Number(tick.toFixed(d)) - tick) <= tick * 1e-6) return d;
        }
        return 8;
    })();
    return price.toFixed(decimals);
}


/** Something of yours, sitting on a row. */
export interface LadderChip {
    kind: 'buy' | 'sell' | 'position' | 'stop' | 'target';
    label: string;
    /** The order this chip would cancel, or null where it is not an order. */
    cancels: number | null;
}

/** One price, and everything that is true of it. */
export interface LadderRow {
    price: number;
    /** The market last traded here. */
    last: boolean;
    bid: boolean;
    ask: boolean;
    /** A position was opened at this price. */
    entry: boolean;
    /** This row's session volume against the busiest row's — 0 to 1, for the bar behind it. */
    volumeShare: number;
    buy: LadderChip[];
    sell: LadderChip[];
}

export interface LadderInput {
    /** The price the middle row stands for. */
    centre: number;
    tick: number;
    /** How many rows. Odd, so there is a middle. */
    count: number;
    /** The last traded price. */
    price: number;
    quote: { bid: number; ask: number } | null;
    positions: readonly LadderPosition[];
    orders: readonly LadderOrder[];
    /** Session volume, keyed by the price on the grid. */
    volumeAt: ReadonlyMap<number, number>;
}

/**
 * The rows, top-down — highest price first, the way a ladder is always drawn.
 *
 * Everything of yours is placed by the side it would TRADE from rather than by the side it
 * belongs to: a long's stop sells, so it sits in the sell column, level with the price it
 * would sell at. That is the column a person's eye is already in when they ask "what happens
 * if this comes down to here".
 *
 * Pure, and separate from the panel that paints it, for the reason the ticket's own plan is:
 * every rule here is a rule about where an order is, and a rule about orders that can only be
 * exercised by clicking on a chart is a rule nobody checks.
 */
export function ladderRows(input: LadderInput): LadderRow[] {
    const { tick, count } = input;
    if (!(tick > 0) || !(count > 0)) return [];

    const at = (price: number): number => onGrid(price, tick);
    const middle = (count - 1) / 2;

    const bid = input.quote ? at(input.quote.bid) : null;
    const ask = input.quote ? at(input.quote.ask) : null;
    const last = input.price > 0 ? at(input.price) : null;

    /* Indexed once, so a row is a lookup rather than a walk over everything the account
     * holds — a ladder is repainted on every tick. */
    const chips = new Map<number, { buy: LadderChip[]; sell: LadderChip[] }>();
    const put = (price: number | null, column: 'buy' | 'sell', chip: LadderChip): void => {
        if (price == null || !(price > 0)) return;
        const key = at(price);
        const row = chips.get(key) ?? { buy: [], sell: [] };
        row[column].push(chip);
        chips.set(key, row);
    };

    for (const order of input.orders) {
        put(order.price, order.side, { kind: order.side, label: formatSize(order.size), cancels: order.id });
    }
    const entries = new Set<number>();
    for (const position of input.positions) {
        const long = position.size > 0;
        const closing = long ? 'sell' : 'buy';
        put(position.entryPrice, long ? 'buy' : 'sell', {
            kind: 'position', label: formatSize(Math.abs(position.size)), cancels: null,
        });
        entries.add(at(position.entryPrice));
        put(position.stopLoss, closing, { kind: 'stop', label: 'SL', cancels: null });
        put(position.takeProfit, closing, { kind: 'target', label: 'TP', cancels: null });
    }

    let peak = 0;
    for (const volume of input.volumeAt.values()) if (volume > peak) peak = volume;

    const rows: LadderRow[] = [];
    for (let i = 0; i < count; i += 1) {
        const price = at(input.centre + (middle - i) * tick);
        const here = chips.get(price);
        rows.push({
            price,
            last: last != null && price === last,
            bid: bid != null && price === bid,
            ask: ask != null && price === ask,
            entry: entries.has(price),
            volumeShare: peak > 0 ? (input.volumeAt.get(price) ?? 0) / peak : 0,
            buy: here?.buy ?? [],
            sell: here?.sell ?? [],
        });
    }
    return rows;
}

/**
 * The order a press on one of the two columns sends — or null where there is none to send.
 *
 * A limit is a pullback and a stop is a breakout, and which of the two this is follows from
 * the side of the market that was pressed. The same rule the ticket holds a typed level to,
 * applied to a press instead of to a field — so nobody has to answer a question the position
 * of their own cursor has already answered.
 *
 * A press ON the market is null: there is no resting order that waits where the price already
 * is, and treating it as one would send a limit that fills on arrival.
 */
export function ladderOrder(
    side: 'buy' | 'sell',
    price: number,
    market: number,
    size: number,
): OrderSpec | null {
    if (!(price > 0) || !(market > 0) || !(size > 0) || price === market) return null;
    const type = (side === 'buy') === (price < market) ? 'limit' : 'stop';
    return {
        side,
        type,
        size,
        ...(type === 'limit' ? { limitPrice: price } : { stopPrice: price }),
        // The same tag the ticket puts on the same kind of order — one word in the library.
        tag: `manual-${type}`,
    };
}

/**
 * Where the ladder is anchored after this tick, and whether it is still following.
 *
 * It follows the market while the market is near the middle and holds still once it is not —
 * which is either because the price ran or because somebody scrolled, and the two want the
 * same thing: a ladder that does not slide out from under the row being read. It takes hold
 * again by itself when the market comes back, so the usual case needs no button at all.
 */
export function ladderAnchor(state: {
    centre: number;
    market: number;
    tick: number;
    adrift: boolean;
    /** How many rows the market may wander before the ladder lets go. */
    drift: number;
}): { centre: number; adrift: boolean } {
    const { tick } = state;
    if (!(tick > 0) || !(state.market > 0)) return { centre: state.centre, adrift: state.adrift };
    const anchor = onGrid(state.market, tick);
    if (!(state.centre > 0)) return { centre: anchor, adrift: false };

    const rows = Math.round((anchor - state.centre) / tick);
    let adrift = state.adrift;
    if (Math.abs(rows) > state.drift) adrift = true;
    else if (Math.abs(rows) <= 1) adrift = false;
    return { centre: adrift ? state.centre : anchor, adrift };
}

export function mountPriceLadder(host: HTMLElement, opts: PriceLadderOptions): PriceLadder {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-ladder';

    // ── the size being traded ────────────────────────────────────────────
    const head = doc.createElement('div');
    head.className = 'midorii-ladder-head';
    const sizeRow = doc.createElement('div');
    sizeRow.className = 'midorii-ladder-sizes';
    const recentre = doc.createElement('button');
    recentre.type = 'button';
    recentre.className = 'midorii-ladder-recenter';
    recentre.textContent = '⤓';
    recentre.title = 'Bring the market back to the middle';
    head.append(sizeRow, recentre);

    /** Which size a press sends. The first offered, until somebody picks another. */
    let size = opts.sizes()[0] ?? 1;
    let sizeButtons: Array<{ el: HTMLButtonElement; value: number }> = [];

    function renderSizes(): void {
        const offered = opts.sizes();
        if (sizeButtons.length === offered.length && sizeButtons.every((b, i) => b.value === offered[i])) {
            for (const b of sizeButtons) {
                if (b.value === size) b.el.dataset.on = '';
                else delete b.el.dataset.on;
            }
            return;
        }
        sizeRow.replaceChildren();
        sizeButtons = offered.map((value) => {
            const b = doc.createElement('button');
            b.type = 'button';
            b.textContent = formatSize(value);
            b.onclick = () => { size = value; renderSizes(); paintGhosts(); };
            sizeRow.append(b);
            return { el: b, value };
        });
        if (!offered.includes(size)) size = offered[0] ?? size;
        for (const b of sizeButtons) {
            if (b.value === size) b.el.dataset.on = '';
            else delete b.el.dataset.on;
        }
    }

    // ── the rows ─────────────────────────────────────────────────────────
    const rowsEl = doc.createElement('div');
    rowsEl.className = 'midorii-ladder-rows';

    interface Row {
        el: HTMLElement;
        buy: HTMLElement;
        sell: HTMLElement;
        price: HTMLElement;
        priceText: HTMLElement;
        vol: HTMLElement;
        /** The price this row currently stands for. */
        at: number;
    }

    const rows: Row[] = [];
    for (let i = 0; i < ROWS; i += 1) {
        const row = doc.createElement('div');
        row.className = 'midorii-ladder-row';

        const buy = doc.createElement('div');
        buy.className = 'midorii-ladder-cell';
        buy.dataset.col = 'buy';

        const price = doc.createElement('div');
        price.className = 'midorii-ladder-price';
        const vol = doc.createElement('div');
        vol.className = 'midorii-ladder-vol';
        const text = doc.createElement('span');
        price.append(vol, text);

        const sell = doc.createElement('div');
        sell.className = 'midorii-ladder-cell';
        sell.dataset.col = 'sell';

        row.append(buy, price, sell);
        rowsEl.append(row);
        rows.push({ el: row, buy, sell, price, priceText: text, vol, at: 0 });
    }

    const foot = doc.createElement('div');
    foot.className = 'midorii-ladder-foot';
    foot.textContent = 'Volume is this session’s, counted from when the chart opened. '
        + 'The two columns are yours — this venue publishes only the top of book.';

    el.append(head, rowsEl, foot);
    host.append(el);

    /* Where the ladder is anchored, and whether the market has wandered off it. Held rather
     * than recomputed from the price, so a ladder somebody is reading does not slide out from
     * under them on every tick — it follows while it is centred and holds still once they
     * have scrolled, exactly like the chart's own auto-scroll. */
    let centre = 0;
    let adrift = false;

    /** This session's volume at each price, keyed by the price on the grid. */
    const volumeAt = new Map<number, number>();
    let peakVolume = 0;
    /** The last bar's running volume, so only what is NEW is folded in. */
    let lastBarVolume = 0;
    let lastBarPrice = 0;

    function mark(price: number, volume: number): void {
        const tick = opts.tick();
        if (tick == null || !(tick > 0) || !(price > 0)) return;
        /* Bars arrive re-sent on every print, so the volume on one grows. Only the growth is
         * new; a falling figure is a fresh bar and the whole of it is new. */
        const fresh = price === lastBarPrice || volume >= lastBarVolume ? volume - lastBarVolume : volume;
        lastBarVolume = volume;
        lastBarPrice = price;
        if (!(fresh > 0)) return;
        const at = onGrid(price, tick);
        const total = (volumeAt.get(at) ?? 0) + fresh;
        volumeAt.set(at, total);
        if (total > peakVolume) peakVolume = total;
    }

    function paintGhosts(): void {
        const text = formatSize(size);
        for (const row of rows) {
            row.buy.dataset.ghost = text;
            row.sell.dataset.ghost = text;
        }
    }

    /** One chip, painted from what {@link ladderRows} decided it is. */
    function chipNode(chip: LadderChip): HTMLElement {
        const c = doc.createElement('span');
        c.className = 'midorii-ladder-chip';
        c.dataset.kind = chip.kind;
        c.textContent = chip.label;
        if (chip.cancels != null) {
            const id = chip.cancels;
            c.dataset.cancels = '1';
            c.title = 'Cancel this order';
            c.onclick = (event) => {
                // The cell underneath would otherwise also place an order at this price.
                event.stopPropagation();
                opts.cancelOrder(id);
            };
        }
        return c;
    }

    function refresh(): void {
        renderSizes();
        const tick = opts.tick();
        const market = opts.price();
        if (tick == null || !(tick > 0) || !(market > 0)) {
            el.dataset.empty = '1';
            return;
        }
        delete el.dataset.empty;

        const anchored = ladderAnchor({ centre, market, tick, adrift, drift: DRIFT_ROWS });
        centre = anchored.centre;
        adrift = anchored.adrift;
        el.dataset.adrift = adrift ? '1' : '0';

        const model = ladderRows({
            centre,
            tick,
            count: ROWS,
            price: market,
            quote: opts.quote(),
            positions: opts.positions(),
            orders: opts.orders(),
            volumeAt,
        });

        for (let i = 0; i < ROWS; i += 1) {
            const row = rows[i]!;
            const data = model[i];
            if (!data) continue;
            row.at = data.price;
            row.priceText.textContent = priceText(data.price, tick);

            const flag = (name: string, on: boolean): void => {
                if (on) row.el.dataset[name] = '1';
                else delete row.el.dataset[name];
            };
            flag('last', data.last);
            flag('bid', data.bid);
            flag('ask', data.ask);
            flag('entry', data.entry);

            row.vol.style.width = `${Math.round(data.volumeShare * 100)}%`;
            row.buy.replaceChildren(...data.buy.map(chipNode));
            row.sell.replaceChildren(...data.sell.map(chipNode));
        }
        paintGhosts();
    }

    /** A press in one of the two columns. */
    const press = (col: 'buy' | 'sell') => (event: MouseEvent): void => {
        const cell = event.currentTarget as HTMLElement;
        const row = rows.find((r) => r.buy === cell || r.sell === cell);
        if (!row) return;
        const spec = ladderOrder(col, row.at, opts.price(), size);
        // Null is a press on the market itself, where no resting order can wait.
        if (spec) opts.order(spec);
    };
    for (const row of rows) {
        row.buy.addEventListener('click', press('buy'));
        row.sell.addEventListener('click', press('sell'));
    }

    recentre.onclick = () => {
        adrift = false;
        refresh();
    };

    /* Scrolling the list moves the ladder by rows rather than scrolling the page: the rows are
     * re-priced in place, so there is nothing to scroll TO — the anchor is the thing that
     * moves. Held still afterwards, which is the whole point of scrolling it. */
    const onWheel = (event: WheelEvent): void => {
        const tick = opts.tick();
        if (tick == null || !(tick > 0)) return;
        event.preventDefault();
        const step = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 40));
        centre = onGrid(centre - step * tick, tick);
        adrift = true;
        refresh();
    };
    rowsEl.addEventListener('wheel', onWheel, { passive: false });

    renderSizes();
    refresh();

    return {
        el,
        refresh,
        mark,
        destroy(): void {
            rowsEl.removeEventListener('wheel', onWheel);
            el.remove();
        },
    };
}
