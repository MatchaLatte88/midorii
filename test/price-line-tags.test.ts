// A price line's tag, its button, and what a pointer at (x, y) has hold of.
//
// The button closes a position, so the one thing that must not drift is the agreement between
// where it is painted and where it is hit — both come from these functions, and this is what
// holds them to it.
import { describe, it, expect } from 'vitest';
import {
    ACTION_GAP, ACTION_SIZE, GRAB_TOLERANCE, TAG_HEIGHT, TAG_INSET, TAG_PAD,
    inRect, priceLineActionRect, priceLineHitAt, priceLineTagRect, priceLineTagSegments,
    bracketTagWidth, declutterAxisTags,
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

    it('lays an outlined trading bracket against the edge with its action on the left', () => {
        const title = 'TP  +$293.50  +2.00R';
        const tag = priceLineTagRect(measure, title, true, DATA_W, 300, 'bracket');
        const action = priceLineActionRect(DATA_W, 300, tag);
        expect(tag.x + tag.width).toBe(DATA_W - TAG_INSET);
        expect(action.x + action.width + ACTION_GAP).toBe(tag.x);
        expect(tag.width).toBe(bracketTagWidth(measure, title));
        expect(priceLineTagSegments(title)).toEqual(['TP', '+$293.50', '+2.00R']);
    });
});

describe('price line hit testing', () => {
    const hit = (x: number, y: number, l: PriceLine) => priceLineHitAt(x, y, l, 300, DATA_W, measure);

    it('takes the button before the tag it sits on', () => {
        const l = line({ title: 'SL −$820', draggable: true, action: 'close' });
        const b = priceLineActionRect(DATA_W, 300);
        expect(hit(b.x + b.width / 2, 300, l)).toBe('action');
    });

    it('hits the bracket action where it is drawn to the tag\'s left', () => {
        const l = line({ title: 'SL  −$46.50', tagStyle: 'bracket', action: 'close' });
        const tag = priceLineTagRect(measure, l.title!, true, DATA_W, 300, 'bracket');
        const b = priceLineActionRect(DATA_W, 300, tag);
        expect(hit(b.x + b.width / 2, 300, l)).toBe('action');
        expect(hit(tag.x + 3, 300, l)).toBe('tag');
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

describe('declutterAxisTags', () => {
    /** The smallest gap two settled chips may have between their centres. */
    const H = 16;
    /** Every neighbouring pair is at least a chip apart — the whole point of the exercise. */
    const gaps = (ys: number[]): number[] => {
        const sorted = [...ys].sort((a, b) => a - b);
        return sorted.slice(1).map((y, i) => y - sorted[i]!);
    };

    it('leaves chips that already clear each other exactly where they are', () => {
        expect(declutterAxisTags([100, 200, 300], H)).toEqual([100, 200, 300]);
        // Touching but not overlapping is not a collision.
        expect(declutterAxisTags([100, 116], H)).toEqual([100, 116]);
    });

    it('splits a colliding pair evenly — neither chip is the one that gives way', () => {
        // A bid and its ask, four pixels apart: each moves six, and the pair stays centred
        // on where it was.
        expect(declutterAxisTags([100, 104], H)).toEqual([94, 110]);
        const mid = (ys: number[]): number => (Math.min(...ys) + Math.max(...ys)) / 2;
        expect(mid(declutterAxisTags([100, 104], H))).toBe(mid([100, 104]));
    });

    it('answers in the caller\'s order, not in top-down order', () => {
        // The ask arrives first and sits ABOVE the bid; each answer must come back against
        // the chip that asked for it, or the two prices are drawn on each other's lines.
        expect(declutterAxisTags([104, 100], H)).toEqual([110, 94]);
    });

    it('collapses a run that only overlaps once the run above has moved', () => {
        // The pair at 20/25 centres on 22.5 and spreads to 14.5/30.5 — which then collides
        // with the chip at 0. Resolving only the pair just joined leaves that overlap.
        const out = declutterAxisTags([0, 20, 25], H);
        expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(H);
    });

    it('separates a dense run of levels', () => {
        const out = declutterAxisTags([200, 202, 204, 206, 208], H);
        expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(H);
        // Still centred on the group it came from: five chips around 204.
        expect((Math.min(...out) + Math.max(...out)) / 2).toBe(204);
    });

    it('keeps chips inside the pane', () => {
        // Two chips at the very top of the scale cannot spread upward past it.
        const out = declutterAxisTags([2, 4], H, 8, 400);
        expect(Math.min(...out)).toBeGreaterThanOrEqual(8);
        expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(H);

        const low = declutterAxisTags([396, 398], H, 8, 400);
        expect(Math.max(...low)).toBeLessThanOrEqual(400);
    });

    it('has nothing to do for a single chip, or none', () => {
        expect(declutterAxisTags([100], H)).toEqual([100]);
        expect(declutterAxisTags([], H)).toEqual([]);
    });
});
