// The dock's height policy: how far the list may be dragged up, and what stops it. Pure —
// the gesture that drives it is a pointer drag, and that is proven in the browser.
import { describe, it, expect } from 'vitest';
import { clampDockHeight, DEFAULT_DOCK_HEIGHT, MIN_DOCK_HEIGHT } from '../app/renderer/replay/tradeDock';

describe('trade dock height', () => {
    it('leaves a height the column can spare alone', () => {
        expect(clampDockHeight(320, 900)).toBe(320);
    });

    it('never squeezes the list below two rows', () => {
        expect(clampDockHeight(10, 900)).toBe(MIN_DOCK_HEIGHT);
        expect(clampDockHeight(-400, 900)).toBe(MIN_DOCK_HEIGHT);
    });

    it('leaves the chart its floor', () => {
        // The dock is attached to a chart; one that could swallow it would hide the thing
        // it is about.
        expect(clampDockHeight(10_000, 900)).toBe(700);
    });

    it('gives the list the floor rather than nothing when the column is tiny', () => {
        // A window short enough that the floor and the minimum cannot both be honoured. The
        // list wins — a dock dragged to nothing is a dock that has stopped answering.
        expect(clampDockHeight(400, 120)).toBe(MIN_DOCK_HEIGHT);
    });

    it('falls back to a ceiling of its own when the column has not been laid out', () => {
        // A tab that has never been shown measures zero, and zero is not "no room".
        expect(clampDockHeight(10_000, 0)).toBe(640);
        expect(clampDockHeight(DEFAULT_DOCK_HEIGHT, 0)).toBe(DEFAULT_DOCK_HEIGHT);
    });
});
