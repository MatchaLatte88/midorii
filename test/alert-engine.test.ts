// The alert engine's crossing detection — the one part of the price-alert feature that
// cannot be eyeballed by hand (it needs a real sequence of live ticks), so it gets a
// direct test instead. See app/renderer/alerts/AlertEngine.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { AlertStore } from '../app/renderer/alerts/AlertStore';
import { AlertEngine } from '../app/renderer/alerts/AlertEngine';
import { newAlert } from '../app/renderer/alerts/alertTypes';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';

/** `AlertStore` persists through `window.midori` — stub it so the store runs under
 *  vitest's plain node environment, same as the app's own renderer-side stores would
 *  see through the real preload bridge. */
function stubMidori(): void {
    (globalThis as unknown as { window: unknown }).window = {
        midori: {
            alerts: {
                load: async () => [] as unknown[],
                save: async () => ({ savedAt: Date.now() }),
            },
        },
    };
}

/** A `DataProvider` whose `subscribe` hands the test a way to push bars by hand and to
 *  tell whether it has been torn down. */
function fakeProvider(): DataProvider & { push(close: number): void; subscribed: boolean } {
    let onBar: ((bar: OHLCV) => void) | null = null;
    const provider = {
        subscribed: false,
        getBars: async () => [] as OHLCV[],
        subscribe: (_ticker: string, _tf: string, cb: (bar: OHLCV) => void) => {
            onBar = cb;
            provider.subscribed = true;
            return () => {
                onBar = null;
                provider.subscribed = false;
            };
        },
        push(close: number): void {
            onBar?.({ time: Date.now(), open: close, high: close, low: close, close, volume: 0 });
        },
    };
    return provider as unknown as DataProvider & { push(close: number): void; subscribed: boolean };
}

describe('AlertEngine crossing detection', () => {
    let store: AlertStore;
    let provider: ReturnType<typeof fakeProvider>;
    let fired: Array<{ id: string; price: number }>;
    let engine: AlertEngine;

    beforeEach(() => {
        stubMidori();
        store = new AlertStore();
        provider = fakeProvider();
        fired = [];
        engine = new AlertEngine(store, { binance: () => provider }, (alert, price) => {
            fired.push({ id: alert.id, price });
        });
    });

    it('never fires on the first bar after subscribing (nothing to have crossed FROM yet)', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        engine.start();
        provider.push(150); // already past the level, but it's the seed bar
        expect(fired).toEqual([]);
        expect(store.get(alert.id)?.enabled).toBe(true);
    });

    it('fires a "crossing" alert on an upward cross and disables a "once" alert', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        engine.start();
        provider.push(90); // seed
        provider.push(105); // crosses up through 100
        expect(fired).toEqual([{ id: alert.id, price: 105 }]);
        expect(store.get(alert.id)?.enabled).toBe(false);
    });

    it('fires a "crossing" alert on a downward cross too', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        engine.start();
        provider.push(110);
        provider.push(95);
        expect(fired).toEqual([{ id: alert.id, price: 95 }]);
    });

    it('an "above" alert ignores a downward cross and fires only on the upward one', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        store.update(alert.id, { condition: 'above' });
        engine.start();
        provider.push(105);
        provider.push(95); // crosses down — must not fire an "above" alert
        expect(fired).toEqual([]);
        provider.push(105); // crosses up — fires
        expect(fired).toEqual([{ id: alert.id, price: 105 }]);
    });

    it('a "below" alert ignores an upward cross and fires only on the downward one', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        store.update(alert.id, { condition: 'below' });
        engine.start();
        provider.push(95);
        provider.push(105); // crosses up — must not fire a "below" alert
        expect(fired).toEqual([]);
        provider.push(95); // crosses down — fires
        expect(fired).toEqual([{ id: alert.id, price: 95 }]);
    });

    it('a repeating (non-"once") alert stays enabled and fires on every crossing', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        store.update(alert.id, { once: false });
        engine.start();
        provider.push(90);
        provider.push(105); // cross #1 (up)
        provider.push(90); // cross #2 (back down)
        provider.push(105); // cross #3 (up again)
        expect(fired).toHaveLength(3);
        expect(store.get(alert.id)?.enabled).toBe(true);
    });

    it('closes the subscription once the last enabled alert on a symbol is gone', () => {
        const alert = store.add(newAlert('binance:BTCUSDT', 100));
        engine.start();
        expect(provider.subscribed).toBe(true);
        store.remove(alert.id);
        expect(provider.subscribed).toBe(false);
    });

    it('never opens a subscription for a provider with no streaming (e.g. the local archive)', () => {
        const localOnly = new AlertEngine(store, {}, () => undefined as never);
        store.add(newAlert('local:BTCUSDT', 100));
        expect(() => localOnly.start()).not.toThrow();
    });
});
