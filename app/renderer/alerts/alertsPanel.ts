import { registerSidePanel, type SidePanelHandle } from '../../../src/plugin';
import { buildFieldControl } from '../../../src/ui';
import type { AlertDialog } from './AlertDialog';
import type { AlertStore } from './AlertStore';
import type { PriceAlert } from './alertTypes';
import { formatPrice } from '../format';

const CONDITION_LABEL: Record<PriceAlert['condition'], string> = {
    crossing: 'Crossing',
    above: 'Crossing up',
    below: 'Crossing down',
};

function row(alert: PriceAlert, store: AlertStore, dialog: AlertDialog): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vela-border);cursor:pointer;';

    const sw = buildFieldControl({
        kind: 'switch',
        checked: alert.enabled,
        onChange: (v) => store.update(alert.id, { enabled: v }),
    });
    sw.el.addEventListener('click', (e) => e.stopPropagation());

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
    const main = document.createElement('div');
    main.style.cssText = 'font-size:12px;color:var(--vela-fg-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    main.textContent = `${alert.symbol} @ ${formatPrice(alert.price)}`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--vela-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    sub.textContent = alert.label ? `${CONDITION_LABEL[alert.condition]} · ${alert.label}` : CONDITION_LABEL[alert.condition];
    info.append(main, sub);

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Delete alert';
    del.style.cssText = 'border:none;background:none;color:var(--vela-fg-muted);cursor:pointer;font-size:12px;padding:2px 4px;';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        store.remove(alert.id);
    });

    el.append(sw.el, info, del);
    el.addEventListener('click', () => dialog.open(alert.id));
    return el;
}

/** Registers the "Alerts" side panel — a flat list of every price alert (any symbol),
 *  each row toggling/editing/deleting in place. Separate from the built-in topbar
 *  "Alerts" bell, which is an unrelated script-`alert()` log (see VelaWorkspace.ts). */
export function registerAlertsPanel(store: AlertStore, dialog: AlertDialog): () => void {
    return registerSidePanel({
        id: 'midorii.alerts-panel',
        title: 'Alerts',
        // Deliberately not 'bell' — the topbar already has a bell for the unrelated
        // script-alerts log, and two identical glyphs side by side is how this panel goes
        // unnoticed. 'bands' (stacked horizontal lines) reads as "price levels" instead.
        icon: 'bands',
        order: 50,
        width: 260,
        mount(_ctx, body): SidePanelHandle {
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;overflow-y:auto;';
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:16px;font-size:12px;color:var(--vela-fg-muted);text-align:center;';
            empty.textContent = 'No alerts yet — right-click the chart to add one.';
            body.append(list, empty);

            const render = (): void => {
                const alerts = store.list();
                list.replaceChildren(...alerts.map((a) => row(a, store, dialog)));
                empty.hidden = alerts.length > 0;
            };
            render();
            const off = store.onChange(render);

            return { destroy: () => off() };
        },
    });
}
