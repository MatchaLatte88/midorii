// What the setting under Settings → Customization → Alerts actually changes: the wording of
// the tag riding an alert's line. The price stays on the axis either way, and nothing about
// when the alert fires is touched. See app/renderer/alerts/alertDisplay.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { priceLineFor } from '../app/renderer/alerts/alertIndicator';
import {
    DEFAULT_ALERT_DISPLAY, loadAlertDisplay, normalizeAlertDisplay, onAlertDisplayChange, saveAlertDisplay,
} from '../app/renderer/alerts/alertDisplay';
import { newAlert } from '../app/renderer/alerts/alertTypes';

function alertAt(price: number, label = ''): ReturnType<typeof newAlert> {
    return { ...newAlert('binance:BTCUSDT', price), label };
}

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

describe('the alert tag', () => {
    it('repeats the level by default, and drops it when the setting is off', () => {
        expect(priceLineFor(alertAt(111234.57), true).title).toBe('Alert 111234.57');
        expect(priceLineFor(alertAt(111234.57), false).title).toBe('Alert');
    });

    it('falls back to the bare label rather than an empty tag', () => {
        expect(priceLineFor(alertAt(111234.57, 'Breakout'), true).title).toBe('Breakout (111234.57)');
        expect(priceLineFor(alertAt(111234.57, 'Breakout'), false).title).toBe('Breakout');
    });

    it('keeps the price on the axis and the line where it was, either way', () => {
        const off = priceLineFor(alertAt(111234.57), false);
        expect(off.axisTag).toBe(true); // the level is still readable, on the scale
        expect(off.price).toBe(111234.57); // and the alert still fires exactly there
    });
});

describe('alert display settings', () => {
    beforeEach(() => stubStorage());
    afterEach(() => vi.restoreAllMocks());

    it('defaults to showing the level', () => {
        expect(DEFAULT_ALERT_DISPLAY.showLevel).toBe(true);
        expect(loadAlertDisplay()).toEqual({ showLevel: true });
    });

    it('round-trips a saved choice', () => {
        saveAlertDisplay({ showLevel: false });
        expect(loadAlertDisplay()).toEqual({ showLevel: false });
    });

    it('answers a malformed or missing record with the default', () => {
        expect(normalizeAlertDisplay(null)).toEqual({ showLevel: true });
        expect(normalizeAlertDisplay({ showLevel: 'no' })).toEqual({ showLevel: true });
        expect(normalizeAlertDisplay({})).toEqual({ showLevel: true });
        expect(normalizeAlertDisplay({ showLevel: false })).toEqual({ showLevel: false });
    });

    it('tells the chart on every save, so the tags are redrawn at once', () => {
        const seen: boolean[] = [];
        const off = onAlertDisplayChange((d) => seen.push(d.showLevel));
        saveAlertDisplay({ showLevel: false });
        saveAlertDisplay({ showLevel: true });
        off();
        saveAlertDisplay({ showLevel: false }); // no longer listening
        expect(seen).toEqual([false, true]);
    });

    it('still repaints when the machine cannot remember the choice', () => {
        // A storage failure is reported, never swallowed — and never fatal.
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        (globalThis as unknown as { localStorage: unknown }).localStorage = {
            getItem: () => null,
            setItem: () => { throw new Error('quota'); },
        };
        const seen: boolean[] = [];
        const off = onAlertDisplayChange((d) => seen.push(d.showLevel));
        saveAlertDisplay({ showLevel: false });
        off();
        expect(seen).toEqual([false]); // the chart was told anyway
        expect(err).toHaveBeenCalled();
    });
});
