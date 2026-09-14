import { registerNativeIndicator } from '../../../src/plugin';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorOutput, PriceLine } from '../../../src/plugin';
import type { PriceAlert } from './alertTypes';
import { formatPrice } from '../format';
import { DEFAULT_ALERT_DISPLAY, type AlertDisplay } from './alertDisplay';

/** The native-indicator type id — mounted once per chart, always on (not a broker-gated
 *  visual like the trade/replay position lines). */
export const ALERT_INDICATOR_TYPE = 'price-alerts';

/** The single string input carrying every alert, serialized — mirrors
 *  `app/renderer/replay/replayIndicator.ts`'s `stateJson` channel. */
const ALERTS_INPUT = 'alertsJson';

/** The one display choice the tags share — see `alertDisplay.ts`. Travels beside the list
 *  rather than being read from storage in here: the indicator draws what it was handed. */
const SHOW_LEVEL_INPUT = 'showLevel';

const LINE_COLOR = '#f0a020';

/** `alert_<id>` → the price-line id an alert's line is mounted under — the address a
 *  close-button press reports back (see `readAlertLineId`). */
export const alertLineId = (alertId: string): string => `alert_${alertId}`;

/** The reverse of {@link alertLineId} — null for any id that is not one of ours (another
 *  price line, e.g. a paper-trading position level, sharing the same renderer callback). */
export function readAlertLineId(id: string): string | null {
    return id.startsWith('alert_') ? id.slice('alert_'.length) : null;
}

/** Exported for the tag-wording test — the four readings of one alert (labelled or not,
 *  level shown or not) are the whole of what the display setting does. */
export function priceLineFor(alert: PriceAlert, showLevel: boolean): PriceLine {
    // The chart tag shows the short LABEL, never the message — the message can be as long
    // as it needs to be, and a tag riding the line has room for a name, not a note.
    // Without the level, a labelled alert is its label alone and an unlabelled one is the
    // bare word: the price is still on the axis, and `axisTag` below still puts it there.
    const level = formatPrice(alert.price);
    const title = alert.label
        ? (showLevel ? `${alert.label} (${level})` : alert.label)
        : (showLevel ? `Alert ${level}` : 'Alert');
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
    private showLevel = DEFAULT_ALERT_DISPLAY.showLevel;

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
        const show = inputs[SHOW_LEVEL_INPUT];
        if (typeof show === 'boolean') this.showLevel = show;
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
            .map((a) => priceLineFor(a, this.showLevel));
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
        internal: true,
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
export function alertIndicatorInputs(alerts: PriceAlert[], display: AlertDisplay = DEFAULT_ALERT_DISPLAY): Record<string, string | boolean> {
    return { [ALERTS_INPUT]: JSON.stringify(alerts), [SHOW_LEVEL_INPUT]: display.showLevel };
}
