import { NumberInput, Select, Switch, TextField, injectStyles } from '../../../src/ui';
import { formatClock, parseClock } from './index';
import type { StrategyParam, StrategyParams } from './types';

/**
 * One schema field, as the control its type asks for.
 *
 * Lifted out of the Strategies tab when the Trading Bot tab arrived, because both screens
 * edit the same shape: a strategy's own settings there, the same settings plus the live
 * guards here (see liveGuards.ts). Two copies of this would be two places for a `select`
 * to stop matching its schema, and the guards are the half where being wrong costs money.
 *
 * Every control writes straight into the `values` object it is handed and then calls
 * `onChange`. That is deliberately not a state library: the object is the form's draft,
 * whether a caller keeps the current controls or repaints after a structural change.
 */

const STYLE_ID = 'midorii-param-fields';
const CSS = `
.midorii-field {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 26px;
}
.midorii-field > span:first-child { color: var(--vela-fg-muted); white-space: nowrap; }
.midorii-field-toggles { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.midorii-field-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.midorii-field-grid {
    display: grid; gap: 10px 18px;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
}
/* A clock is four characters and a colon; a field sized for a sentence reads as though
   more were expected in it. */
.midorii-field-clock { width: 84px; flex: none; }
`;

export function ensureParamFieldStyles(doc: Document): void {
    injectStyles(STYLE_ID, CSS, doc);
}

/** A labelled row: what the setting is called on the left, the control on the right. */
export function fieldRow(doc: Document, label: string, control: HTMLElement, hint?: string): HTMLElement {
    ensureParamFieldStyles(doc);
    const el = doc.createElement('label');
    el.className = 'midorii-field';
    const text = doc.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    el.append(text, control);
    return el;
}

/** The auto-fitting two-column grid both forms lay their fields out in. */
export function fieldGrid(doc: Document): HTMLElement {
    ensureParamFieldStyles(doc);
    const el = doc.createElement('div');
    el.className = 'midorii-field-grid';
    return el;
}

/**
 * Build the control for `param`, bound to `values[param.key]`.
 *
 * `onChange` is called after the value has already been written, so a caller that repaints
 * from `values` sees the new one. A `time` field commits on blur or Enter (the kit's own
 * text field does that); anything it cannot read as a clock is put back the way it was,
 * rather than being taken as a number of minutes nobody typed.
 */
export function paramField(
    doc: Document,
    param: StrategyParam,
    values: StrategyParams,
    onChange: () => void,
): HTMLElement {
    if (param.type === 'select') {
        const select = new Select({
            options: [...(param.options ?? [])],
            value: String(values[param.key] ?? param.default),
            onChange: (v) => { values[param.key] = v; onChange(); },
        });
        return fieldRow(doc, param.label, select.el, param.hint);
    }

    if (param.type === 'multi') {
        const picked = new Set(Array.isArray(values[param.key]) ? (values[param.key] as readonly string[]) : []);
        const group = doc.createElement('div');
        group.className = 'midorii-field-toggles';
        for (const option of param.options ?? []) {
            const wrap = doc.createElement('label');
            wrap.className = 'midorii-field-toggle';
            const toggle = new Switch({
                checked: picked.has(option.value),
                size: 'sm',
                onChange: (on) => {
                    if (on) picked.add(option.value);
                    else picked.delete(option.value);
                    // The schema's own order, not the order they were clicked in.
                    values[param.key] = (param.options ?? []).map((o) => o.value).filter((v) => picked.has(v));
                    onChange();
                },
            });
            const text = doc.createElement('span');
            text.textContent = option.label;
            wrap.append(toggle.el, text);
            group.appendChild(wrap);
        }
        return fieldRow(doc, param.label, group, param.hint);
    }

    if (param.type === 'bool') {
        const toggle = new Switch({
            checked: values[param.key] === true,
            onChange: (on) => { values[param.key] = on; onChange(); },
        });
        return fieldRow(doc, param.label, toggle.el, param.hint);
    }

    if (param.type === 'time') {
        const held = Number(values[param.key] ?? param.default);
        const field = new TextField({
            value: formatClock(Number.isFinite(held) ? held : 0),
            size: 'sm',
            fill: false,
            onChange: (text) => {
                const minutes = parseClock(text);
                if (minutes == null) {
                    /* Not a clock. The stored value stays untouched, so a typo cannot become
                     * a trading window. The field itself restores its committed value. */
                    onChange();
                    return;
                }
                values[param.key] = minutes;
                onChange();
            },
        });
        field.el.classList.add('midorii-field-clock');
        return fieldRow(doc, param.label, field.el, param.hint);
    }

    const input = new NumberInput({
        value: Number(values[param.key] ?? param.default),
        min: param.min,
        max: param.max,
        step: param.step,
        integer: param.step === 1,
        fill: false,
        onChange: (v) => { values[param.key] = v; onChange(); },
    });
    return fieldRow(doc, param.label, input.el, param.hint);
}
