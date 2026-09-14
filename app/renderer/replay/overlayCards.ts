import { Menu, injectStyles, iconEl, registerIcon, svg16, type MenuItemDescriptor } from '../../../src/ui';
import { loadOverlayDisplay, onOverlayDisplayChange, saveOverlayDisplay, type OverlayDisplay } from './overlayDisplay';
import { loadQuoteDisplay, onQuoteDisplayChange, saveQuoteDisplay } from '../quotes/quoteDisplay';

/**
 * The chrome the chart's floating cards share: pick one up, put it down somewhere else, and
 * put it away.
 *
 * The account card, the quick ticket and the bid/ask readout all float over live bars in a
 * corner, and a corner is exactly where a chart's own action tends to be. None of them is
 * worth moving the chart to read around, so each can be dragged anywhere over the plot and
 * each can be dismissed — with a View menu per chart that lists every card with its own
 * switch, since a card that can be closed and not reopened is a card people lose.
 *
 * Where a card sits and whether it is on the chart at all are both remembered per machine: a
 * layout somebody arranged once and had to arrange again next session is not a layout, and a
 * card somebody dismissed on purpose coming back at every launch is not a dismissal.
 *
 * The View menu's switch for a card is the same switch the chart's gear offers under Chart
 * cards (see `overlayDisplay.ts`), so the two doors cannot disagree. The card's own close
 * button only puts it away; the menu shows that as off too, and switching it on brings the
 * card back whichever of the two took it off the chart. Both survive a restart.
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
 * a button under them would work until somebody moved the mouse. So while the price pane has
 * a cluster — only once there is a second pane — that spot is left free and the full-screen
 * button sits beside it; with a lone pane there is nothing to share and it sits against the
 * axis. The View menu goes beside the full-screen button, at the same size, on the same line,
 * with the same gap — see `PaneControls.ts`, which wears this card's own surface and border
 * for the same reason. The renderer publishes what the cluster claims as
 * `--vela-pane-controls-width`, so all of this follows the panes coming and going.
 */
const PANE_CONTROLS = 'var(--vela-pane-controls-width, 0px)';
/** The corner buttons, matched to the cluster they stand next to. */
const DOCK_SIZE = 24;
const DOCK_GAP = 6;
/** Where the full-screen button's own right edge falls, past the axis and the pane cluster. */
const FULL_RIGHT = DOCK_GAP;
/** Where the View menu's own right edge falls, one step left of the full-screen button. */
const VIEW_RIGHT = FULL_RIGHT + DOCK_SIZE + DOCK_GAP;
/**
 * What a card at its default position gives up to the corner buttons.
 *
 * Measured from the card's own 10px inset, so it clears the leftmost button on screen and
 * leaves the same gap everything else in this corner leaves.
 */
const INSET_FULL_ONLY = `calc(${PANE_CONTROLS} + ${FULL_RIGHT + DOCK_SIZE + DOCK_GAP - 10}px)`;
const INSET_WITH_VIEW = `calc(${PANE_CONTROLS} + ${VIEW_RIGHT + DOCK_SIZE + DOCK_GAP - 10}px)`;

/* The pane cluster beside these already uses `maximize` for a pane taking the chart, so full
 * screen wears arrows of its own rather than a look-alike of the button next to it. */
registerIcon('midorii-fullscreen', svg16('<path d="M9.5 2.5h4v4M13.5 2.5 9.5 6.5M6.5 13.5h-4v-4M2.5 13.5l4-4"/>'));
registerIcon('midorii-fullscreen-exit', svg16('<path d="M13.5 6.5h-4v-4M9.5 6.5l4-4M2.5 9.5h4v4M6.5 9.5l-4 4"/>'));

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

.midorii-card-dock,
.midorii-card-full {
    all: unset;
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + ${PANE_CONTROLS} + ${VIEW_RIGHT}px);
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
.midorii-card-full { right: calc(var(--vela-scale-gutter, 0px) + ${PANE_CONTROLS} + ${FULL_RIGHT}px); }
.midorii-card-dock:hover,
.midorii-card-full:hover,
.midorii-card-dock[data-state='open'] { color: var(--vela-fg-bright); background: var(--vela-hover); }
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

interface CardSetting {
    /** How the View menu names it — the same words the gear's Chart cards tab uses. */
    label: string;
    get(): boolean;
    set(on: boolean): void;
    /** Hear about a save that may have changed it. Returns its own unsubscribe. */
    watch(listener: () => void): () => void;
}

/** One flag of the floating-card settings, as a {@link CardSetting}. */
function displaySetting(label: string, key: keyof OverlayDisplay): CardSetting {
    return {
        label,
        get: () => loadOverlayDisplay()[key],
        set: (on) => saveOverlayDisplay({ ...loadOverlayDisplay(), [key]: on }),
        watch: (listener) => onOverlayDisplayChange(listener),
    };
}

/**
 * The switch each card answers to. The bid/ask card's lives with the other two ways of
 * showing a quote — see `quotes/quoteDisplay.ts` — and is the same switch from here.
 */
const CARD_SETTINGS: Record<OverlayCardId, CardSetting> = {
    account: displaySetting('Account card', 'showAccount'),
    quick: displaySetting('Quick Buy / Sell panel', 'showQuick'),
    quote: {
        label: 'Bid / ask card',
        get: () => loadQuoteDisplay().showCard,
        set: (on) => saveQuoteDisplay({ ...loadQuoteDisplay(), showCard: on }),
        watch: (listener) => onQuoteDisplayChange(listener),
    },
    live: displaySetting('Live account band', 'showLive'),
};

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
     * Whether this chart can have the card at all — a market that does not quote what the
     * card exists to show cannot. Unavailable is not the same as switched off: it is not on
     * screen and the View menu does not list it, because there is nothing to show. The card's
     * own Settings switch is read by the card itself and needs no caller.
     */
    setAvailable(available: boolean): void;
    destroy(): void;
}

/**
 * Give `el` the shared chrome: a drag, a close button, and a row in the cell's View menu.
 * `el` must already be mounted in `cell`, which must be a positioning context.
 */
export function makeOverlayCard(cell: HTMLElement, el: HTMLElement, opts: OverlayCardOptions): OverlayCard {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    el.classList.add('midorii-card');

    let placement: CardPlacement | null = loadOverlayLayout()[opts.id] ?? null;
    let available = true;
    let closed = loadClosedCards().has(opts.id);
    const setting = CARD_SETTINGS[opts.id];
    let enabled = setting.get();
    /* Compared before repainting: the bid/ask record also carries the lines and the scale
     * tags, and a save about those is no reason to move this card. */
    const stopWatching = setting.watch(() => {
        const next = setting.get();
        if (next === enabled) return;
        enabled = next;
        paint();
    });

    /** Put the card away, or take it back out, and remember which. */
    const setClosed = (next: boolean): void => {
        closed = next;
        saveCardClosed(opts.id, next);
        paint();
    };

    const close = doc.createElement('button');
    close.className = 'midorii-card-close';
    close.type = 'button';
    close.title = 'Put this card away — the View menu in the corner brings it back';
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
        el.hidden = !available || !enabled || closed;
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
        id: opts.id,
        label: setting.label,
        available: () => available,
        shown: () => enabled && !closed,
        /* On clears both ways a card leaves the chart, so the switch always brings it back;
         * off is the Settings switch, the one the gear shows. */
        setShown: (on) => {
            if (on && closed) setClosed(false);
            if (on !== enabled) setting.set(on);
        },
        reflow,
    });

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => reflow()) : null;
    observer?.observe(cell);

    // `paint` rather than `reflow`: a card that was put away in an earlier session starts put
    // away, and the View menu has to be showing it as off from the first frame.
    paint();

    return {
        reflow,
        setAvailable(next: boolean): void {
            available = next;
            paint();
        },
        destroy(): void {
            observer?.disconnect();
            stopWatching();
            leave();
            close.remove();
        },
    };
}

// ── the corner: View menu and full screen ───────────────────────────────

interface Seat {
    id: OverlayCardId;
    label: string;
    /** Whether the View menu lists it — see {@link OverlayCard.setAvailable}. */
    available(): boolean;
    shown(): boolean;
    setShown(on: boolean): void;
    /** Re-place a card that is placed relative to another one. */
    reflow(): void;
}

interface Dock {
    /** Seat a card. Returns its own release. */
    add(seat: Seat): () => void;
    /** Re-read every seat into the menu and the corner, and re-place what is on screen. */
    sync(): void;
}

const docks = new WeakMap<HTMLElement, Dock>();

/**
 * The corner buttons a chart with cards gets: the View menu, one switch per card, and full
 * screen for the chart on its own.
 *
 * They sit one step left of the chart's own pane buttons whenever the price pane has them —
 * see {@link PANE_CONTROLS} for why that step is not optional. The cards that have never been dragged shift left far enough
 * to clear them, through a custom property they read in their own `right`. Two overlays
 * sharing one corner would otherwise be two overlays on top of each other.
 *
 * Full screen takes the cell, not the window: the chart and what floats on it, without the
 * app's bars or the panel beside it. The chart's own dialogs live inside the cell and come
 * along; anything hung on the document outside it does not show until full screen is left.
 */
function dockFor(cell: HTMLElement): Dock {
    const existing = docks.get(cell);
    if (existing) return existing;

    const doc = cell.ownerDocument;
    const view = doc.createElement('button');
    view.className = 'midorii-card-dock';
    view.type = 'button';
    view.title = 'View — which chart cards are shown';
    view.setAttribute('aria-label', 'Choose which chart cards are shown');
    view.appendChild(iconEl('eye', doc));
    view.hidden = true;

    const full = doc.createElement('button');
    full.className = 'midorii-card-full';
    full.type = 'button';
    const paintFull = (): void => {
        const on = doc.fullscreenElement === cell;
        full.replaceChildren(iconEl(on ? 'midorii-fullscreen-exit' : 'midorii-fullscreen', doc));
        full.title = on ? 'Leave full screen' : 'Show the chart full screen';
        full.setAttribute('aria-label', full.title);
    };
    full.onclick = () => {
        const change = doc.fullscreenElement === cell ? doc.exitFullscreen() : cell.requestFullscreen();
        change.catch((err: unknown) => console.error('[midorii] could not change full screen', err));
    };
    /* Heard on the cell: the event is fired at the element going in or out and bubbles from
     * there, so nothing is left listening on the document once the cell is gone. Esc leaves
     * full screen by itself, and this is how the icon hears about it. */
    cell.addEventListener('fullscreenchange', paintFull);
    paintFull();

    cell.append(view, full);

    const seats = new Set<Seat>();

    /** The rows, in the one order the cards are always named in. */
    const listed = (): Seat[] => [...seats]
        .filter((seat) => seat.available())
        .sort((a, b) => IDS.indexOf(a.id) - IDS.indexOf(b.id));

    const items = (): MenuItemDescriptor[] => listed().map((seat) => ({
        id: seat.id,
        label: seat.label,
        checked: seat.shown(),
        toggle: true,
    }));

    const menu = new Menu({
        trigger: view,
        host: cell,
        placement: 'bottom-end',
        items: [],
        onSelect: (id) => {
            const seat = listed().find((s) => s.id === id);
            // The switch repaints the card, which syncs the dock and with it these rows.
            seat?.setShown(!seat.shown());
        },
    });

    const dock: Dock = {
        add(seat) {
            seats.add(seat);
            return () => {
                seats.delete(seat);
                dock.sync();
            };
        },
        sync() {
            const rows = items();
            view.hidden = rows.length === 0;
            menu.setItems(rows);
            cell.style.setProperty('--midorii-overlay-inset', view.hidden ? INSET_FULL_ONLY : INSET_WITH_VIEW);
            /* One card going away moves the corner the others are placed from — a card placed
             * under the one that just closed now has nothing to sit under. A ResizeObserver
             * does not answer for this: a card switched to display:none reports no resize at
             * all, so the card below it would be left hanging in the gap. */
            for (const seat of [...seats]) seat.reflow();
        },
    };

    docks.set(cell, dock);
    return dock;
}
