// The two decisions behind the chart's draggable cards, kept out of the DOM so they can be
// checked: what a stored layout is allowed to say, and how a dropped card is held inside the
// plot. A card that a stored position put off screen is a card nobody can get back, so this
// is the part worth a test. See app/renderer/replay/overlayCards.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    clampPlacement, loadOverlayLayout, normalizeOverlayLayout, saveCardPlacement,
} from '../app/renderer/replay/overlayCards';
import {
    DEFAULT_OVERLAY_DISPLAY, loadOverlayDisplay, normalizeOverlayDisplay, onOverlayDisplayChange,
    saveOverlayDisplay,
} from '../app/renderer/replay/overlayDisplay';

/** These modules reach for localStorage, which vitest's node environment has none of. */
function stubStorage(): Map<string, string> {
    const cells = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
    return cells;
}

/** The account card over a chart that fills a laptop screen. */
const CARD = { width: 336, height: 66 };
const CELL = { width: 1000, height: 600 };

describe('normalizeOverlayLayout', () => {
    it('keeps a position both cards can be placed by', () => {
        expect(normalizeOverlayLayout({ account: { left: 12, top: 40 }, quick: { left: 12, top: 120 } }))
            .toEqual({ account: { left: 12, top: 40 }, quick: { left: 12, top: 120 } });
    });

    it('reads a missing, empty or unparseable record as no layout at all', () => {
        expect(normalizeOverlayLayout(null)).toEqual({});
        expect(normalizeOverlayLayout({})).toEqual({});
        expect(normalizeOverlayLayout('nonsense')).toEqual({});
    });

    it('drops a half-written position rather than placing a card at zero', () => {
        // A card at {left: 0} is a card in the top-left corner, which is not what this said.
        expect(normalizeOverlayLayout({ account: { left: 12 } })).toEqual({});
        expect(normalizeOverlayLayout({ account: { left: '12', top: 40 } })).toEqual({});
        expect(normalizeOverlayLayout({ account: null })).toEqual({});
    });

    it('drops a number that cannot be a pixel', () => {
        expect(normalizeOverlayLayout({ account: { left: Number.NaN, top: 40 } })).toEqual({});
        expect(normalizeOverlayLayout({ quick: { left: 12, top: Number.POSITIVE_INFINITY } })).toEqual({});
    });

    it('ignores an id no card answers to', () => {
        expect(normalizeOverlayLayout({ ticket: { left: 12, top: 40 } })).toEqual({});
    });
});

describe('clampPlacement', () => {
    it('leaves a position that is already on the plot exactly where it was', () => {
        expect(clampPlacement({ left: 400, top: 200 }, CARD, CELL)).toEqual({ left: 400, top: 200 });
    });

    it('keeps the whole card on the plot, not just a corner of it', () => {
        // The cell does not clip what overflows it, so a card past the right-hand edge does
        // not hang off the chart — it goes under the trade panel beside it and is gone.
        expect(clampPlacement({ left: 5000, top: 100 }, CARD, CELL).left).toBe(CELL.width - CARD.width);
        expect(clampPlacement({ left: -5000, top: 100 }, CARD, CELL).left).toBe(0);
    });

    it('never puts a card above the plot, where its own top edge cannot be reached', () => {
        expect(clampPlacement({ left: 100, top: -300 }, CARD, CELL).top).toBe(0);
    });

    it('keeps the card whole when it is dragged past the bottom', () => {
        expect(clampPlacement({ left: 100, top: 5000 }, CARD, CELL).top).toBe(CELL.height - CARD.height);
    });

    it('pulls a card in when the plot narrows under it', () => {
        // The trade panel opening is exactly this: a position that fitted a moment ago now
        // reaches past the edge, and the card has to come back inside on its own.
        const wide = { left: 640, top: 40 };
        expect(clampPlacement(wide, CARD, CELL)).toEqual(wide); // fits the full-width chart
        const narrowed = clampPlacement(wide, CARD, { width: 700, height: 600 });
        expect(narrowed.left).toBe(700 - CARD.width);
        expect(narrowed.left + CARD.width).toBeLessThanOrEqual(700);
    });

    it('still answers on a cell too small to hold the card at all', () => {
        // A window dragged down to nothing: the room goes negative, and the card must not end
        // up at some position no later drag can recover from. Pinned to the corner instead.
        expect(clampPlacement({ left: 400, top: 200 }, CARD, { width: 20, height: 20 }))
            .toEqual({ left: 0, top: 0 });
    });
});

describe('the stored layout', () => {
    beforeEach(() => stubStorage());
    afterEach(() => vi.restoreAllMocks());

    it('starts empty, so both cards are placed by whoever mounted them', () => {
        expect(loadOverlayLayout()).toEqual({});
    });

    it('remembers one card without disturbing the other', () => {
        saveCardPlacement('account', { left: 30, top: 60 });
        saveCardPlacement('quick', { left: 30, top: 150 });
        saveCardPlacement('account', { left: 31, top: 61 });
        expect(loadOverlayLayout()).toEqual({ account: { left: 31, top: 61 }, quick: { left: 30, top: 150 } });
    });

    it('forgets a card on null, which puts it back where it is placed by default', () => {
        saveCardPlacement('account', { left: 30, top: 60 });
        saveCardPlacement('account', null);
        expect(loadOverlayLayout()).toEqual({});
    });

    it('reads a corrupted record as no layout rather than throwing at mount', () => {
        localStorage.setItem('midorii-overlay-layout', '{ not json');
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(loadOverlayLayout()).toEqual({});
        expect(quiet).toHaveBeenCalled(); // reported, never swallowed
    });
});

describe('chart card settings', () => {
    beforeEach(() => stubStorage());
    afterEach(() => vi.restoreAllMocks());

    it('shows the account card until somebody says otherwise', () => {
        expect(DEFAULT_OVERLAY_DISPLAY.showAccount).toBe(true);
        expect(loadOverlayDisplay()).toEqual({ showAccount: true });
    });

    it('takes anything a stored record cannot mean as the default', () => {
        expect(normalizeOverlayDisplay({ showAccount: 'no' })).toEqual({ showAccount: true });
        expect(normalizeOverlayDisplay(null)).toEqual({ showAccount: true });
    });

    it('round-trips the switch, and tells a chart that is already open', () => {
        const heard: boolean[] = [];
        const off = onOverlayDisplayChange((d) => heard.push(d.showAccount));
        saveOverlayDisplay({ showAccount: false });
        expect(loadOverlayDisplay()).toEqual({ showAccount: false });
        expect(heard).toEqual([false]);
        off();
        saveOverlayDisplay({ showAccount: true });
        expect(heard).toEqual([false]); // unsubscribed, and no longer listening
    });
});
