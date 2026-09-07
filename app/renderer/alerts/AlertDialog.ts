import { Dialog, fieldGrid, fieldRow, buildFieldControl, type SelectOption } from '../../../src/ui';
import type { AlertStore } from './AlertStore';
import { LABEL_MAX_LENGTH, type PriceAlert } from './alertTypes';

const CONDITION_OPTIONS: readonly SelectOption[] = [
    { value: 'crossing', label: 'Crossing' },
    { value: 'above', label: 'Crossing up' },
    { value: 'below', label: 'Crossing down' },
];

function btn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.addEventListener('click', onClick);
    return b;
}

/**
 * The "Add Alert" popup — opened right after a right-click creates the alert (at the
 * clicked price, with sensible defaults) so its level/condition/message can be adjusted
 * on the spot, and reopened from the alerts panel or the chart line's own click to edit
 * an existing one. Same shell as
 * `src/renderers/native/drawings/DrawingSettingsDialog.ts`: live edits write straight
 * into the store, Cancel restores the open-time snapshot.
 */
export class AlertDialog {
    private ui: Dialog | null = null;

    constructor(private readonly host: HTMLElement, private readonly store: AlertStore) {}

    open(alertId: string): void {
        this.close();
        const alert = this.store.get(alertId);
        if (!alert) return;
        const snapshot: PriceAlert = { ...alert };

        const grid = fieldGrid({ variant: 'inputs' });
        grid.style.padding = '16px 20px';

        const priceCtrl = buildFieldControl({
            kind: 'number',
            value: alert.price,
            fill: true,
            commit: 'blur',
            onChange: (n) => this.store.update(alertId, { price: n }),
        });
        grid.appendChild(fieldRow({ label: 'Price', control: priceCtrl.el, controlWidth: 280 }));

        const conditionCtrl = buildFieldControl({
            kind: 'select',
            options: CONDITION_OPTIONS,
            value: alert.condition,
            fill: false,
            onChange: (v) => this.store.update(alertId, { condition: v as PriceAlert['condition'] }),
        });
        grid.appendChild(fieldRow({ label: 'Condition', control: conditionCtrl.el }));

        const labelCtrl = buildFieldControl({
            kind: 'text',
            value: alert.label,
            fill: true,
            placeholder: `Chart label (${LABEL_MAX_LENGTH} chars max)…`,
            onChange: (v) => this.store.update(alertId, { label: v.slice(0, LABEL_MAX_LENGTH) }),
        });
        // No `maxLength` in the field kit's text descriptor — set it on the native input
        // directly, same as DrawingSettingsDialog reaches into a built control's DOM.
        const labelInput = labelCtrl.el.querySelector('input');
        if (labelInput) labelInput.maxLength = LABEL_MAX_LENGTH;
        grid.appendChild(fieldRow({ label: 'Label', control: labelCtrl.el, controlWidth: 280 }));

        const messageCtrl = buildFieldControl({
            kind: 'textarea',
            value: alert.message,
            rows: 5,
            placeholder: 'Message (optional)…',
            onChange: (v) => this.store.update(alertId, { message: v }),
        });
        grid.appendChild(fieldRow({ label: 'Message', control: messageCtrl.el, stacked: true }));

        grid.appendChild(fieldRow({
            label: 'Once',
            bool: true,
            toggle: { checked: alert.once, onChange: (v) => this.store.update(alertId, { once: v }) },
        }));
        grid.appendChild(fieldRow({
            label: 'Enabled',
            bool: true,
            toggle: { checked: alert.enabled, onChange: (v) => this.store.update(alertId, { enabled: v }) },
        }));

        const ui = new Dialog({
            host: this.host,
            title: 'Alert',
            contained: true,
            align: 'center',
            draggable: true,
            flush: true,
            className: 'vela-dialog--form',
            closeOnBackdrop: true,
            footer: (foot) => {
                foot.append(
                    btn('Delete', false, () => {
                        this.store.remove(alertId);
                        this.close();
                    }),
                    btn('Cancel', false, () => {
                        this.store.update(alertId, snapshot);
                        this.close();
                    }),
                    btn('Ok', true, () => this.close()),
                );
            },
            onOpenChange: (open) => { if (!open) this.close(); },
        });
        ui.body.appendChild(grid);
        this.ui = ui;
        ui.show();
    }

    close(): void {
        const ui = this.ui;
        this.ui = null;
        ui?.destroy();
    }

    destroy(): void {
        this.close();
    }
}
