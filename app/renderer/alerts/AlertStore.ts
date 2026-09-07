import type { PriceAlert } from './alertTypes';

/** How long a burst of edits (dragging the price field, toggling switches) is allowed
 *  to settle before it is written — one round trip per burst, not one per keystroke. */
const WRITE_DEBOUNCE_MS = 400;

export type Unsubscribe = () => void;

/**
 * The single source of truth for price alerts — CRUD + persistence + change
 * notification, the same shape as `src/core/drawings/DrawingStore.ts` minus the paint
 * order (alerts have none). Persists through `window.midori.alerts`
 * (app/electron/data/store/alertStore.js) rather than the workspace document: an alert
 * must survive a symbol switch, and outlive the chart it was set from.
 */
export class AlertStore {
    private byId = new Map<string, PriceAlert>();
    private readonly listeners = new Set<() => void>();
    private writeTimer: ReturnType<typeof setTimeout> | null = null;

    /** Read the stored list and populate the store. Call once at startup. */
    async load(): Promise<void> {
        const stored = await window.midori.alerts.load();
        this.byId = new Map(stored.map((a) => [a.id, a]));
        this.emit();
    }

    list(): PriceAlert[] {
        return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Every enabled alert on one symbol — what the chart line and the engine both filter by. */
    forSymbol(symbol: string): PriceAlert[] {
        return this.list().filter((a) => a.symbol === symbol);
    }

    get(id: string): PriceAlert | undefined {
        return this.byId.get(id);
    }

    add(alert: PriceAlert): PriceAlert {
        this.byId.set(alert.id, alert);
        this.emit();
        this.scheduleWrite();
        return alert;
    }

    update(id: string, patch: Partial<Omit<PriceAlert, 'id'>>): PriceAlert | null {
        const existing = this.byId.get(id);
        if (!existing) return null;
        const next = { ...existing, ...patch };
        this.byId.set(id, next);
        this.emit();
        this.scheduleWrite();
        return next;
    }

    remove(id: string): boolean {
        const ok = this.byId.delete(id);
        if (ok) {
            this.emit();
            this.scheduleWrite();
        }
        return ok;
    }

    onChange(cb: () => void): Unsubscribe {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Write now rather than waiting for the debounce — used on page unload. */
    flush(): void {
        if (this.writeTimer == null) return;
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
        this.write();
    }

    private scheduleWrite(): void {
        if (this.writeTimer != null) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.write();
        }, WRITE_DEBOUNCE_MS);
    }

    private write(): void {
        void window.midori.alerts.save(this.list()).catch((err: unknown) => (
            console.error('[midorii] could not persist alerts', err)
        ));
    }

    private emit(): void {
        for (const cb of this.listeners) cb();
    }
}
