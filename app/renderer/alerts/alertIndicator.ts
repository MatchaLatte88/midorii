import { registerNativeIndicator } from '../../../src/plugin';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorOutput, PriceLine } from '../../../src/plugin';
import type { PriceAlert } from './alertTypes';

/** The native-indicator type id — mounted once per chart, always on (not a broker-gated
 *  visual like the trade/replay position lines). */
export const ALERT_INDICATOR_TYPE = 'price-alerts';

/** The single string input carrying every alert, serialized — mirrors
 *  `app/renderer/replay/replayIndicator.ts`'s `stateJson` channel. */
const ALERTS_INPUT = 'alertsJson';

const LINE_COLOR = '#f0a020';

/** `alert_<id>` → the price-line id an alert's line is mounted under — the address a
 *  close-button press reports back (see `readAlertLineId`). */
export const alertLineId = (alertId: string): string => `alert_${alertId}`;

/** The reverse of {@link alertLineId} — null for any id that is not one of ours (another
 *  price line, e.g. a paper-trading position level, sharing the same renderer callback). */
export function readAlertLineId(id: string): string | null {
    return id.startsWith('alert_') ? id.slice('alert_'.length) : null;
}

function priceLineFor(alert: PriceAlert): PriceLine {
    // The chart tag shows the short LABEL, never the message — the message can be as long
    // as it needs to be, and a tag riding the line has room for a name, not a note.
    const title = alert.label ? `${alert.label} (${alert.price})` : `Alert ${alert.price}`;
    return {
        id: alertLineId(alert.id),
        paneId: 'price',
        price: alert.price,
        color: LINE_COLOR,
        lineStyle: 'dashed',
        title,
        axisTag: true,
        action: 'close',
        // Right-click or double-click the tag reopens its settings popup (see
        // installAlerts.ts's `priceline:contextmenu` / `priceline:dblclick` listeners).
        interactiveTag: true,
        // Drag the line itself (or its tag) to reprice — dropped position reports through
        // `priceline:moved`, see installAlerts.ts.
        draggable: true,
    };
}

class PriceAlertIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private alerts: PriceAlert[] = [];

    start(ctx: NativeIndicatorContext, inputs: Record<string, unknown>): void {
        this.ctx = ctx;
        this.apply(inputs);
        this.emit();
    }

    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* not viewport-dependent */
    }

    setInputs(inputs: Record<string, unknown>): void {
        this.apply(inputs);
        this.emit();
    }

    suspend(): void {
        /* nothing running between frames */
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.ctx = null;
    }

    private apply(inputs: Record<string, unknown>): void {
        const raw = inputs[ALERTS_INPUT];
        if (typeof raw !== 'string') return;
        try {
            this.alerts = JSON.parse(raw) as PriceAlert[];
        } catch {
            /* keep the last good list */
        }
    }

    private emit(): void {
        if (!this.ctx) return;
        const priceLines: PriceLine[] = this.alerts
            .filter((a) => a.enabled && a.symbol === this.ctx!.symbol)
            .map(priceLineFor);
        const out: NativeIndicatorOutput = { priceLines };
        this.ctx.emit(out);
    }
}

let registered = false;

/** Registers the type once per process (the registry is process-wide). */
export function registerAlertIndicator(): void {
    if (registered) return;
    registered = true;
    registerNativeIndicator({
        type: ALERT_INDICATOR_TYPE,
        title: 'Price alerts',
        paneHint: 'price',
        overlay: true,
        multiInstance: false,
        // Machinery, not a setting anyone edits by hand — same reasoning as the
        // replay/trade position indicator's own empty schema.
        inputsSchema: () => [],
        defaultInputs: () => ({ [ALERTS_INPUT]: '[]' }),
        create: () => new PriceAlertIndicator(),
    });
}

/** The input payload `installAlerts.ts` pushes into the mounted indicator on every
 *  store change (`indicator.setInputs(alertIndicatorInputs(store.list()))`). */
export function alertIndicatorInputs(alerts: PriceAlert[]): Record<string, string> {
    return { [ALERTS_INPUT]: JSON.stringify(alerts) };
}
