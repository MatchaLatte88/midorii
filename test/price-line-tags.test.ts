// A price line's tag, its button, and what a pointer at (x, y) has hold of.
//
// The button closes a position, so the one thing that must not drift is the agreement between
// where it is painted and where it is hit — both come from these functions, and this is what
// holds them to it.
import { describe, it, expect } from 'vitest';
import {
    ACTION_SIZE, GRAB_TOLERANCE, TAG_HEIGHT, TAG_INSET, TAG_PAD,
    inRect, priceLineActionRect, priceLineHitAt, priceLineTagRect,
} from '../src/renderers/native/chrome/priceLineTags';
import { levelAllowed, levelFromDrop } from '../app/renderer/replay/replayLevels';
import type { PriceLine } from '../src/core/model/scene';

/** Monospace-ish stand-in: 6px a character, so widths are predictable. */
const measure = { measureText: (s: string) => ({ width: s.length * 6 }) };
const DATA_W = 800;
const line = (over: Partial<PriceLine> = {}): PriceLine => ({ id: 'l', paneId: 'price', price: 100, ...over });

describe('price line tag geometry', () => {
    it('puts the button against the right edge, centred on the line', () => {
        const b = priceLineActionRect(DATA_W, 300);
        expect(b).toEqual({ x: DATA_W - TAG_INSET - ACTION_SIZE, y: 300 - ACTION_SIZE / 2, width: ACTION_SIZE, height: ACTION_SIZE });
    });

    it('lays the tag out against the button, not the edge', () => {
        const withButton = priceLineTagRect(measure, 'SL', true, DATA_W, 300);
        const alone = priceLineTagRect(measure, 'SL', false, DATA_W, 300);
        expect(alone.x + alone.width).toBe(DATA_W - TAG_INSET);
        expect(withButton.x + withButton.width).toBeLessThan(priceLineActionRect(DATA_W, 300).x);
        // Same text, same size — only the position moves.
        expect(withButton.width).toBe('SL'.length * 6 + TAG_PAD * 2);
        expect(withButton.height).toBe(TAG_HEIGHT);
    });

    it('keeps the button still while the tag grows', () => {
        // A P&L gaining a digit must not slide the button out from under a reaching finger.
        const short = priceLineTagRect(measure, '+$9', true, DATA_W, 300);
        const long = priceLineTagRect(measure, '+$1,234.56  +2.10R', true, DATA_W, 300);
        expect(long.x).toBeLessThan(short.x); // the tag grows leftwards
        expect(priceLineActionRect(DATA_W, 300).x).toBe(DATA_W - TAG_INSET - ACTION_SIZE); // button unmoved
    });
});

describe('price line hit testing', () => {
    const hit = (x: number, y: number, l: PriceLine) => priceLineHitAt(x, y, l, 300, DATA_W, measure);

    it('takes the button before the tag it sits on', () => {
        const l = line({ title: 'SL −$820', draggable: true, action: 'close' });
        const b = priceLineActionRect(DATA_W, 300);
        expect(hit(b.x + b.width / 2, 300, l)).toBe('action');
    });

    it('treats the tag as a handle for the line', () => {
        const l = line({ title: 'SL −$820', draggable: true });
        const t = priceLineTagRect(measure, l.title!, false, DATA_W, 300);
        expect(hit(t.x + 4, 300, l)).toBe('tag');
        // The tag answers even where the line itself is far out of reach vertically.
        expect(hit(t.x + 4, 300 + TAG_HEIGHT / 2 - 1, l)).toBe('tag');
    });

    it('grabs the line body only within tolerance, and only when draggable', () => {
        const l = line({ draggable: true });
        expect(hit(200, 300 + GRAB_TOLERANCE, l)).toBe('line');
        expect(hit(200, 300 + GRAB_TOLERANCE + 1, l)).toBeNull();
        expect(hit(DATA_W + 20, 300, l)).toBeNull(); // out on the axis, not the plot
        expect(hit(200, 300, line({}))).toBeNull(); // not draggable → nothing to take hold of
    });

    it('grabs the body of a line that spawns levels, the same as a draggable one', () => {
        // A position with no protection draws ONE line — its entry — and that line is where
        // both levels come from. If it is not grabbable here, there is no way to put a stop on
        // such a position from the chart at all.
        const l = line({ dragSpawns: true });
        expect(hit(200, 300 + GRAB_TOLERANCE, l)).toBe('line');
        expect(hit(200, 300 + GRAB_TOLERANCE + 1, l)).toBeNull();
    });

    it('reports nothing for a bare line with no tag and no drag', () => {
        expect(hit(200, 300, line({ title: undefined }))).toBeNull();
    });

    it('inRect is inclusive of its edges', () => {
        const r = { x: 10, y: 20, width: 30, height: 40 };
        expect(inRect(10, 20, r)).toBe(true);
        expect(inRect(40, 60, r)).toBe(true);
        expect(inRect(41, 60, r)).toBe(false);
    });
});

describe('where a dragged level may be dropped', () => {
    it('keeps a stop on the losing side and a target on the winning side', () => {
        // Long at 100: stop below, target above.
        expect(levelAllowed('stop', 'buy', 100, 95)).toBe(true);
        expect(levelAllowed('stop', 'buy', 100, 105)).toBe(false);
        expect(levelAllowed('target', 'buy', 100, 105)).toBe(true);
        expect(levelAllowed('target', 'buy', 100, 95)).toBe(false);
        // Short at 100: the mirror image.
        expect(levelAllowed('stop', 'sell', 100, 105)).toBe(true);
        expect(levelAllowed('stop', 'sell', 100, 95)).toBe(false);
        expect(levelAllowed('target', 'sell', 100, 95)).toBe(true);
    });

    it('refuses the entry itself and anything that is not a number', () => {
        expect(levelAllowed('stop', 'buy', 100, 100)).toBe(false);
        expect(levelAllowed('target', 'buy', 100, Number.NaN)).toBe(false);
    });
});

describe('what a drag off the entry draws', () => {
    it('reads the level off the direction alone', () => {
        // Long at 100: down is where it is wrong, up is where it is done.
        expect(levelFromDrop('buy', 100, 95)).toBe('stop');
        expect(levelFromDrop('buy', 100, 105)).toBe('target');
        // Short at 100: the mirror image.
        expect(levelFromDrop('sell', 100, 105)).toBe('stop');
        expect(levelFromDrop('sell', 100, 95)).toBe('target');
    });

    it('names neither for a drop on the entry, or on nothing at all', () => {
        expect(levelFromDrop('buy', 100, 100)).toBeNull();
        expect(levelFromDrop('buy', 100, Number.NaN)).toBeNull();
    });

    it('agrees with what a dragged level is allowed to do', () => {
        // Two rules, one meaning: whatever a drop spawns must be a drop that level could
        // have been dragged to. If they ever disagree, a pulled stop lands somewhere a
        // moved stop is refused.
        for (const side of ['buy', 'sell'] as const) {
            for (const price of [80, 95, 99.99, 100.01, 105, 130]) {
                const level = levelFromDrop(side, 100, price)!;
                expect(levelAllowed(level, side, 100, price)).toBe(true);
            }
        }
    });
});
