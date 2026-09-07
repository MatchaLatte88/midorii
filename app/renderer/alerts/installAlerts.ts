import { registerWidgetAction, type DataProvider } from '../../../src/plugin';
import type { IndicatorHandle } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import { AlertDialog } from './AlertDialog';
import { AlertEngine } from './AlertEngine';
import { playAlertSound } from './alertSound';
import { AlertStore } from './AlertStore';
import { ALERT_INDICATOR_TYPE, alertIndicatorInputs, readAlertLineId, registerAlertIndicator } from './alertIndicator';
import { registerAlertsPanel } from './alertsPanel';
import { newAlert, symbolProvider } from './alertTypes';
import { installCursorPriceTracking, lastCrosshairPrice } from './cursorPrice';

/** Providers whose symbols can carry an alert — everything with a live feed. The local
 *  archive has none, so "Add Alert" stays hidden there. */
const STREAMING_PROVIDERS = new Set(['binance', 'coinbase', 'hyperliquid', 'capital']);

function hasStream(symbol: string): boolean {
    const provider = symbolProvider(symbol);
    return provider != null && STREAMING_PROVIDERS.has(provider);
}

/** `"binance:BTCUSDT"` → `"BTCUSDT"`, for the notification title. */
function tickerOf(symbol: string): string {
    const i = symbol.indexOf(':');
    return i > 0 ? symbol.slice(i + 1) : symbol;
}

/**
 * Wires up price alerts: the "Add Alert" context-menu entry, the on-chart dashed price
 * line, the Alerts side panel, and the background engine that watches the live feed and
 * fires a native notification. Call once, after the workspace is built (see
 * `app/renderer/main.ts`, alongside `installTradeMenu`).
 */
export function installAlerts(workspace: VelaWorkspace, providers: Record<string, () => DataProvider>): void {
    registerAlertIndicator();

    const store = new AlertStore();
    const dialog = new AlertDialog(workspace.root, store);
    registerAlertsPanel(store, dialog);

    const offCursor = installCursorPriceTracking();
    workspace.refreshActions(); // mount the just-registered cursor-price attachment now

    // The alert lines' own visual: one always-on native indicator, fed the whole list on
    // every store change (mirrors app/renderer/trading/paperMount.ts's position lines).
    const indicator: IndicatorHandle = workspace.chart.addNativeIndicator(ALERT_INDICATOR_TYPE);
    const pushLines = (): void => indicator.setInputs(alertIndicatorInputs(store.list()));
    const offIndicatorSync = store.onChange(pushLines);

    // The chart line's own ✕ tag button deletes the alert — filtered by our id prefix so
    // a paper-trading position's close button (the same chart-wide event) is untouched.
    const offPriceLineAction = workspace.chart.on('priceline:action', ({ id }) => {
        const alertId = readAlertLineId(id);
        if (alertId) store.remove(alertId);
    });

    // Dragging the line (or its tag) to a new level reprices the alert — `draggable` on
    // the line is what lets the renderer claim the gesture at all (see alertIndicator.ts).
    const offPriceLineMoved = workspace.chart.on('priceline:moved', ({ id, price }) => {
        const alertId = readAlertLineId(id);
        if (alertId) store.update(alertId, { price });
    });

    // Right-click or double-click the alert's own tag (its "bracket") reopens its popup —
    // `interactiveTag` on the line is what makes these two fire only for the tag, not for
    // a right-click/double-click anywhere else on the chart (see alertIndicator.ts).
    const reopen = (id: string): void => {
        const alertId = readAlertLineId(id);
        if (alertId) dialog.open(alertId);
    };
    const offPriceLineContext = workspace.chart.on('priceline:contextmenu', ({ id }) => reopen(id));
    const offPriceLineDblClick = workspace.chart.on('priceline:dblclick', ({ id }) => reopen(id));

    const engine = new AlertEngine(store, providers, (alert, price) => {
        const body = alert.message || `Crossed ${alert.price} (now ${price})`;
        playAlertSound();
        try {
            const n = new Notification(`Price alert — ${tickerOf(alert.symbol)}`, { body });
            n.onclick = () => window.midori.window.restore();
        } catch (err) {
            console.error('[midorii] could not show the alert notification', err);
        }
        workspace.toast(`${tickerOf(alert.symbol)} alert: ${body}`, 'info');
    });

    registerWidgetAction({
        id: 'midorii.add-alert',
        target: 'context:body',
        label: 'Add Alert',
        icon: 'bell',
        when: (ctx) => hasStream(ctx.symbol) && lastCrosshairPrice() != null,
        run: (ctx) => {
            const price = lastCrosshairPrice();
            if (price == null) return;
            const alert = store.add(newAlert(ctx.symbol, price));
            dialog.open(alert.id);
        },
    });

    // `load()` itself fires `onChange` once populated, which already pushes the loaded
    // list into the indicator via `pushLines` above — only the engine needs starting here.
    void store.load().then(() => engine.start());

    window.addEventListener('beforeunload', () => {
        store.flush();
    });

    // Kept alive for the lifetime of the app (Midorii never tears this down); the
    // disposers exist so a future "uninstall" path has somewhere to hang.
    void offCursor;
    void offIndicatorSync;
    void offPriceLineAction;
    void offPriceLineMoved;
    void offPriceLineContext;
    void offPriceLineDblClick;
}
