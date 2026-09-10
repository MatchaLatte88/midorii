import { injectStyles, iconEl } from '../../../src/ui';

/**
 * The chrome the chart's floating cards share: pick one up, put it down somewhere else, and
 * put it away.
 *
 * The account card, the quick ticket and the bid/ask readout all float over live bars in a
 * corner, and a corner is exactly where a chart's own action tends to be. None of them is
 * worth moving the chart to read around, so each can be dragged anywhere over the plot and
 * each can be dismissed — with one button per chart to bring back whatever was dismissed,
 * since a card that can be closed and not reopened is a card people lose.
 *
 * Where a card sits and whether it is on the chart at all are both remembered per machine: a
 * layout somebody arranged once and had to arrange again next session is not a layout, and a
 * card somebody dismissed on purpose coming back at every launch is not a dismissal.
 *
 * Closing a card is still not the same as switching it off in Settings (see
 * `overlayDisplay.ts`), and the difference is what the chart says afterwards. A closed card
 * leaves the restore button behind — the chart is telling you something is put away and where
 * to get it back. A card switched off leaves nothing: no button, no trace, gone until somebody
 * goes looking in Settings for it. "Not right now" and "not at all", and both survive a
 * restart.
 *
 * A dragged card keeps its own pixels
 * -----------------------------------
 * Untouched, a card is placed by whoever mounted it — off the price-pane insets the renderer
 * publishes on the cell, so it clears the axis at any width. The moment it is dragged it
 * stops listening to that and holds the pixels it was dropped on.
 *
 * Those pixels are what it was PUT at, and the plot it was put on is not the plot it will
 * always have: the trade panel opens beside the chart, the window is resized, the app starts
 * again on another screen. A card is shown inside whatever plot it currently has and remembers
 * where it was put, so a chart squeezed by the panel pushes the card in and giving the room
 * back puts it where it belongs — rather than walking it left one panel toggle at a time.
 */

const STYLE_ID = 'midorii-card';

/**
 * The top-right corner is shared, so everything in it is measured from one set of numbers.
 *
 * The chart pins its own pane buttons there — maximize, and a study pane's move/collapse
 * cluster — 6px clear of the axis and 24px square, on a layer above anything a host puts in
 * the same place. They only appear on hover, which is what makes sharing the spot a bad idea:
 * a button under them would work until somebody moved the mouse. So that spot is left free and
 * the restore button sits beside it, at the same size, on the same line, with the same gap —
 * see `PaneControls.ts`, which wears this card's own surface and border for the same reason.
 */
const PANE_CLUSTER_RIGHT = 6;
const PANE_CLUSTER_SIZE = 24;
/** The restore button, matched to the cluster it stands next to. */
const DOCK_SIZE = 24;
const DOCK_GAP = 6;
/** Where the restore button's own right edge falls, past the axis. */
const DOCK_RIGHT = PANE_CLUSTER_RIGHT + PANE_CLUSTER_SIZE + DOCK_GAP;
/**
 * What a card at its default position gives up while the restore button is on screen.
 *
 * Measured from the card's own 10px inset, so it clears the button and leaves the same gap
 * everything else in this corner leaves.
 */
const CARD_INSET = DOCK_RIGHT + DOCK_SIZE + DOCK_GAP - 10;

const CSS = `
/* A display set by a class beats the user agent's own rule for [hidden], so a card switched
   off would otherwise stay on screen. This is what actually puts one away. */
.midorii-card[hidden] { display: none !important; }
.midorii-card { cursor: move; }
.midorii-card[data-dragging] { cursor: grabbing; }

/* On the corner rather than inside it: every one of these cards is packed to its padding,
   and a button in the top-right would sit on top of a figure somebody is reading. */
.midorii-card-close {
    all: unset;
    position: absolute;
    top: -7px;
    right: -7px;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    border: 1px solid var(--vela-border);
    border-radius: 999px;
    background: var(--vela-surface-elev);
    color: var(--vela-fg-muted);
    font-size: 10px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 90ms ease;
}
.midorii-card:hover .midorii-card-close,
.midorii-card-close:focus-visible { opacity: 1; }
.midorii-card-close:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

.midorii-card-dock {
    all: unset;
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + ${DOCK_RIGHT}px);
    z-index: 4;
    box-sizing: border-box;
    width: ${DOCK_SIZE}px;
    height: ${DOCK_SIZE}px;
    display: grid;
    place-items: center;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    color: var(--vela-fg-muted);
    font-size: 12px;
    cursor: pointer;
}
.midorii-card-dock:hover { color: var(--vela-fg-bright); background: var(--vela-hover); }
.midorii-card-dock[hidden] { display: none !important; }
`;

/** Which card. One id per card, and the id is what its position is filed under. */
export type OverlayCardId = 'account' | 'quick' | 'quote' | 'live';

/** Where a card was dropped, in pixels from the cell's top-left corner. */
export interface CardPlacement {
    left: number;
    top: number;
}

export type OverlayLayout = Partial<Record<OverlayCardId, CardPlacement>>;

const LAYOUT_KEY = 'midorii-overlay-layout';
const IDS: readonly OverlayCardId[] = ['account', 'quick', 'quote', 'live'];

/** A stored layout, with anything that cannot be a position dropped rather than trusted. */
export function normalizeOverlayLayout(raw: unknown): OverlayLayout {
    const source = (raw ?? {}) as Record<string, unknown>;
    const layout: OverlayLayout = {};
    for (const id of IDS) {
        const stored = source[id] as Partial<CardPlacement> | undefined;
        if (!stored || typeof stored !== 'object') continue;
        const { left, top } = stored;
        if (typeof left !== 'number' || typeof top !== 'number') continue;
        if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
        layout[id] = { left, top };
    }
    return layout;
}

/** What this machine last saved, or an empty layout. Never throws. */
export function loadOverlayLayout(): OverlayLayout {
    try {
        const raw = localStorage.getItem(LAYOUT_KEY);
        return normalizeOverlayLayout(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the chart card layout', err);
        return {};
    }
}

/**
 * File where a card was dropped, or — with `null` — forget it and let it be placed again.
 *
 * Read-modify-write rather than held in a module-level copy: two charts can be open at once,
 * and the one that moved a card last is the one whose answer should survive.
 */
export function saveCardPlacement(id: OverlayCardId, placement: CardPlacement | null): void {
    try {
        const layout = loadOverlayLayout();
        if (placement) layout[id] = placement;
        else delete layout[id];
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (err) {
        console.error('[midorii] could not persist the chart card layout', err);
    }
}

const CLOSED_KEY = 'midorii-overlay-closed';

/**
 * Which cards are put away, as a plain list of ids. Anything the list cannot mean is dropped
 * rather than trusted — a bad record must not be able to hide a card with no way back.
 */
export function normalizeClosedCards(raw: unknown): OverlayCardId[] {
    if (!Array.isArray(raw)) return [];
    return IDS.filter((id) => raw.includes(id));
}

/** What this machine last put away, or nothing. Never throws. */
export function loadClosedCards(): Set<OverlayCardId> {
    try {
        const raw = localStorage.getItem(CLOSED_KEY);
        return new Set(normalizeClosedCards(raw == null ? null : JSON.parse(raw)));
    } catch (err) {
        console.error('[midorii] could not read which chart cards were put away', err);
        return new Set();
    }
}

/**
 * File a card as put away, or as back on the chart.
 *
 * Read-modify-write for the same reason the layout is: two charts can be open, and one of
 * them closing its own card must not un-close the other's.
 */
export function saveCardClosed(id: OverlayCardId, closed: boolean): void {
    try {
        const put = loadClosedCards();
        if (closed) put.add(id);
        else put.delete(id);
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...put]));
    } catch (err) {
        console.error('[midorii] could not persist which chart cards were put away', err);
    }
}

/**
 * Hold a placement inside the plot — the WHOLE card, not a corner of it.
 *
 * The plot has no edge of its own: the cell does not clip what its children overflow, so a
 * card allowed past the right-hand side does not hang half off a chart, it disappears under
 * the trade panel beside it. And the plot narrows on its own — the panel opens, the window is
 * resized, the app is restarted at another size — so "somewhat off the edge" is a state a
 * card arrives at without anybody dragging it there.
 *
 * A card wider or taller than the plot is pinned to the top-left, where at least its own
 * corner and its close button are reachable.
 */
export function clampPlacement(
    placement: CardPlacement,
    card: { width: number; height: number },
    cell: { width: number; height: number },
): CardPlacement {
    const hold = (value: number, room: number): number => Math.min(Math.max(value, 0), Math.max(0, room));
    return {
        left: hold(placement.left, cell.width - card.width),
        top: hold(placement.top, cell.height - card.height),
    };
}

export interface OverlayCardOptions {
    id: OverlayCardId;
    /**
     * Put the card where it belongs when it has never been dragged. Called on mount and
     * whenever the cell changes shape; a card with a stored position never calls it.
     */
    place?: () => void;
    /**
     * Told whenever the card comes or goes, closed or switched off alike — and once on mount,
     * so a caller never has to guess the state it starts in.
     *
     * For a card that leaves something behind. The live account's band does: what it says
     * about real money is true whether or not somebody wants the band on their chart, so a
     * line of text takes its corner while it is away.
     */
    onVisibility?: (visible: boolean) => void;
}

export interface OverlayCard {
    /** Re-place, or re-clamp, after the cell changed shape. */
    reflow(): void;
    /**
     * Whether this chart has the card at all — a Settings switch, or a market that does not
     * quote what the card exists to show. Unavailable is not the same as closed: it is not on
     * screen and the restore button does not offer it, because there is nothing to restore.
     */
    setAvailable(available: boolean): void;
    destroy(): void;
}

/**
 * Give `el` the shared chrome: a drag, a close button, and a seat in the cell's restore
 * button. `el` must already be mounted in `cell`, which must be a positioning context.
 */
export function makeOverlayCard(cell: HTMLElement, el: HTMLElement, opts: OverlayCardOptions): OverlayCard {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    el.classList.add('midorii-card');

    let placement: CardPlacement | null = loadOverlayLayout()[opts.id] ?? null;
    let available = true;
    let closed = loadClosedCards().has(opts.id);

    /** Put the card away, or take it back out, and remember which. */
    const setClosed = (next: boolean): void => {
        closed = next;
        saveCardClosed(opts.id, next);
        paint();
    };

    const close = doc.createElement('button');
    close.className = 'midorii-card-close';
    close.type = 'button';
    close.title = 'Put this card away — the button in the corner brings it back';
    close.setAttribute('aria-label', 'Hide this card');
    close.appendChild(iconEl('close', doc));
    close.onclick = (e) => {
        e.stopPropagation();
        setClosed(true);
    };
    el.appendChild(close);

    /** Put the card at these pixels. Says nothing about where it was PUT — see `placement`. */
    const show = (at: CardPlacement): void => {
        el.style.left = `${at.left}px`;
        el.style.top = `${at.top}px`;
        // A card holding its own pixels answers to neither the gutter nor the restore button.
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    /**
     * Where the card is put, held inside the plot as it is right now.
     *
     * `placement` is where somebody DROPPED it and is never overwritten by this: a chart
     * narrowed by the trade panel pushes the card in, and the card goes back to where it was
     * put when the panel closes again. Clamping the stored answer instead would walk the card
     * left across the screen, one panel toggle at a time, and never walk it back.
     */
    const held = (): CardPlacement | null => {
        if (!placement) return null;
        return clampPlacement(
            placement,
            { width: el.offsetWidth, height: el.offsetHeight },
            { width: cell.clientWidth, height: cell.clientHeight },
        );
    };

    function reflow(): void {
        if (el.hidden) return; // nothing measurable, and nothing on screen to move
        const kept = held();
        if (kept) show(kept);
        else opts.place?.();
    }

    function paint(): void {
        el.hidden = !available || closed;
        dock.sync();
        if (!el.hidden) reflow();
        opts.onVisibility?.(!el.hidden);
    }

    // ── the drag ────────────────────────────────────────────────────────
    /* Anything a person can operate is not a handle: dragging from the size box or a Buy
     * button would mean the panel moved instead of the order being typed. Everything else on
     * a card — a figure, a label, the space between them — is fair to grab. */
    const INTERACTIVE = 'button, input, select, textarea, a, [contenteditable]';
    let grabX = 0;
    let grabY = 0;
    let dragging = false;

    el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        const r = el.getBoundingClientRect();
        grabX = e.clientX - r.left;
        grabY = e.clientY - r.top;
        dragging = true;
        el.dataset.dragging = '';
        el.setPointerCapture(e.pointerId);
        /* The chart underneath reads a pointerdown as the start of a pan, and a card dragged
         * across the plot would drag the bars with it. */
        e.preventDefault();
        e.stopPropagation();
    });

    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const cr = cell.getBoundingClientRect();
        // The one place `placement` is written: this is somebody putting the card somewhere.
        placement = clampPlacement(
            { left: e.clientX - cr.left - grabX, top: e.clientY - cr.top - grabY },
            { width: el.offsetWidth, height: el.offsetHeight },
            { width: cell.clientWidth, height: cell.clientHeight },
        );
        show(placement);
    });

    const drop = (e: PointerEvent): void => {
        if (!dragging) return;
        dragging = false;
        delete el.dataset.dragging;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        if (placement) saveCardPlacement(opts.id, placement);
    };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);

    // ── the corner, and the cell changing shape ─────────────────────────
    const dock = dockFor(cell);
    const leave = dock.add({
        restore: () => setClosed(false),
        isClosed: () => available && closed,
        reflow,
    });

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => reflow()) : null;
    observer?.observe(cell);

    // `paint` rather than `reflow`: a card that was put away in an earlier session starts put
    // away, and the corner button has to be offering it from the first frame.
    paint();

    return {
        reflow,
        setAvailable(next: boolean): void {
            available = next;
            paint();
        },
        destroy(): void {
            observer?.disconnect();
            leave();
            close.remove();
        },
    };
}

// ── the restore button ──────────────────────────────────────────────────

interface Seat {
    restore(): void;
    isClosed(): boolean;
    /** Re-place a card that is placed relative to another one. */
    reflow(): void;
}

interface Dock {
    /** Seat a card. Returns its own release. */
    add(seat: Seat): () => void;
    /** Show or hide the button, per what is currently put away, and re-place what is left. */
    sync(): void;
}

const docks = new WeakMap<HTMLElement, Dock>();

/**
 * The one button per chart that brings closed cards back.
 *
 * It sits in the corner the cards were dismissed from, one step left of the chart's own pane
 * buttons — see {@link PANE_CLUSTER_SIZE} for why that step is not optional. While it is there the
 * cards still ON the chart — the ones that have never been dragged, at least — shift left far
 * enough to clear both, through a custom property they read in their own `right`. Two overlays
 * sharing one corner would otherwise be two overlays on top of each other.
 */
function dockFor(cell: HTMLElement): Dock {
    const existing = docks.get(cell);
    if (existing) return existing;

    const doc = cell.ownerDocument;
    const button = doc.createElement('button');
    button.className = 'midorii-card-dock';
    button.type = 'button';
    button.title = 'Bring the chart cards back';
    button.setAttribute('aria-label', 'Show the hidden chart cards');
    button.appendChild(iconEl('eye', doc));
    button.hidden = true;
    cell.appendChild(button);

    const seats = new Set<Seat>();

    const dock: Dock = {
        add(seat) {
            seats.add(seat);
            return () => {
                seats.delete(seat);
                dock.sync();
            };
        },
        sync() {
            const anyClosed = [...seats].some((seat) => seat.isClosed());
            button.hidden = !anyClosed;
            if (anyClosed) cell.style.setProperty('--midorii-overlay-inset', `${CARD_INSET}px`);
            else cell.style.removeProperty('--midorii-overlay-inset');
            /* One card going away moves the corner the others are placed from — the button
             * takes room, and a card placed under the one that just closed now has nothing
             * to sit under. A ResizeObserver does not answer for this: a card switched to
             * display:none reports no resize at all, so the card below it would be left
             * hanging in the gap. */
            for (const seat of [...seats]) seat.reflow();
        },
    };

    button.onclick = () => {
        // A copy: restoring repaints, which syncs the dock, which reads this same set.
        for (const seat of [...seats]) seat.restore();
    };

    docks.set(cell, dock);
    return dock;
}
