import type { DataProvider } from '../../../src/plugin';
import type { AlertStore } from './AlertStore';
import type { PriceAlert } from './alertTypes';
import { symbolProvider, symbolTicker } from './alertTypes';

/** Fixed granularity for every alert subscription — independent of whatever timeframe
 *  the visible chart happens to be on. Fine enough to catch a cross promptly, coarse
 *  enough that one subscription per symbol is cheap to keep open in the background. */
const WATCH_TIMEFRAME = '1';

type ProviderFactories = Record<string, () => DataProvider>;

interface Watch {
    unsubscribe: () => void;
    /** Close of the last bar seen on this symbol — null until the first one arrives, so
     *  a fresh subscription never fires on its very first update (there is nothing yet
     *  to have crossed FROM). */
    prevClose: number | null;
}

/**
 * Watches the live feed for every symbol with at least one ENABLED alert — one
 * subscription per symbol, shared across however many alerts sit on it, open
 * regardless of what the chart currently shows. Crossing is detected between
 * consecutive bar closes; providers with no `subscribe` (the local archive) are
 * silently skipped, same graceful-degradation rule the rest of the data layer follows.
 */
export class AlertEngine {
    private readonly watches = new Map<string, Watch>();
    private unsubStore: (() => void) | null = null;

    constructor(
        private readonly store: AlertStore,
        private readonly providers: ProviderFactories,
        private readonly onTrigger: (alert: PriceAlert, price: number) => void,
    ) {}

    start(): void {
        this.unsubStore = this.store.onChange(() => this.resync());
        this.resync();
    }

    stop(): void {
        this.unsubStore?.();
        this.unsubStore = null;
        for (const watch of this.watches.values()) watch.unsubscribe();
        this.watches.clear();
    }

    /** Open a subscription for every symbol that newly needs one, close the ones that
     *  no longer do (its last enabled alert was removed, disabled, or fired `once`). */
    private resync(): void {
        const needed = new Set(this.store.list().filter((a) => a.enabled).map((a) => a.symbol));

        for (const [symbol, watch] of this.watches) {
            if (!needed.has(symbol)) {
                watch.unsubscribe();
                this.watches.delete(symbol);
            }
        }
        for (const symbol of needed) {
            if (!this.watches.has(symbol)) this.subscribe(symbol);
        }
    }

    private subscribe(symbol: string): void {
        const providerId = symbolProvider(symbol);
        const factory = providerId ? this.providers[providerId] : undefined;
        if (!factory) return; // unknown provider prefix — nothing to watch
        const provider = factory();
        if (!provider.subscribe) return; // no streaming on this provider (e.g. local) — stays inert

        const watch: Watch = { unsubscribe: () => undefined, prevClose: null };
        watch.unsubscribe = provider.subscribe(symbolTicker(symbol), WATCH_TIMEFRAME, (bar) => {
            this.checkCross(symbol, watch, bar.close);
        });
        this.watches.set(symbol, watch);
    }

    private checkCross(symbol: string, watch: Watch, close: number): void {
        const prev = watch.prevClose;
        watch.prevClose = close;
        if (prev == null) return;

        for (const alert of this.store.forSymbol(symbol)) {
            if (!alert.enabled) continue;
            const crossedUp = prev < alert.price && close >= alert.price;
            const crossedDown = prev > alert.price && close <= alert.price;
            const fired = alert.condition === 'crossing' ? (crossedUp || crossedDown)
                : alert.condition === 'above' ? crossedUp
                : crossedDown;
            if (fired) this.trigger(alert, close);
        }
    }

    private trigger(alert: PriceAlert, price: number): void {
        // A repeating alert re-arms immediately (stays enabled); `once` disables itself
        // so the SAME cross does not fire again on the next tick sitting right on the level.
        this.store.update(alert.id, { enabled: !alert.once, lastTriggeredAt: Date.now() });
        this.onTrigger(alert, price);
    }
}
