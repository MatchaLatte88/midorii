import { NumberInput, Select, Switch, TextField, injectStyles } from '../../../src/ui';
import { formatClock, parseClock } from './index';
import type { StrategyParam, StrategyParamOption, StrategyParams } from './types';

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

.midorii-badges {
    display: inline-flex; align-items: stretch; gap: 4px;
    padding: 3px;
    border: 1px solid var(--vela-border-strong); border-radius: 7px;
}
.midorii-badge {
    appearance: none; -webkit-appearance: none;
    padding: 0 10px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    background: transparent; color: var(--vela-fg-muted);
    border: 0; border-radius: 5px;
    font: 600 12px/1 var(--vela-font); white-space: nowrap; cursor: pointer;
    transition: background var(--vela-dur-fast) ease, color var(--vela-dur-fast) ease;
}
.midorii-badge:hover:not([aria-checked='true']) { color: var(--vela-fg-bright); }
.midorii-badge[aria-checked='true'] {
    background: var(--vela-fg-bright); color: var(--vela-bg);
}
.midorii-badges:focus-within {
    border-color: var(--vela-focus); box-shadow: 0 0 0 3px var(--vela-focus-soft);
}
.midorii-badge:focus-visible { outline: none; }
`;

export function ensureParamFieldStyles(doc: Document): void {
    injectStyles(STYLE_ID, CSS, doc);
}

/**
 * A `select`'s options side by side, one of them on.
 *
 * A radio group rather than a row of switches, and it is spelled as one for the screen
 * reader too: exactly one of these is true at any moment, and two switches that happen to
 * be exclusive is a thing a keyboard user has to discover by trying it.
 *
 * Used where the choice decides what the field beside it MEANS — percent or cash — which
 * is the case that does not survive being hidden behind a dropdown: "Risk 100" read as
 * percent instead of cash is the whole account, and the dropdown shows the wrong one just
 * as confidently as the right one.
 */
export function badgeGroup(
    doc: Document,
    options: readonly StrategyParamOption[],
    value: string,
    onPick: (value: string) => void,
): HTMLElement {
    ensureParamFieldStyles(doc);
    const group = doc.createElement('div');
    group.className = 'midorii-badges';
    group.setAttribute('role', 'radiogroup');

    for (const option of options) {
        const badge = doc.createElement('button');
        badge.type = 'button';
        badge.className = 'midorii-badge';
        badge.setAttribute('role', 'radio');
        badge.setAttribute('aria-checked', option.value === value ? 'true' : 'false');
        /* Only the chosen one is in the tab order, which is what a radio group does: Tab
         * moves past the whole control rather than through every option in it. */
        badge.tabIndex = option.value === value ? 0 : -1;
        badge.textContent = option.label;
        badge.addEventListener('click', () => {
            if (option.value === value) return;
            onPick(option.value);
        });
        group.appendChild(badge);
    }

    return group;
}

/**
 * A labelled row: what the setting is called on the left, the control on the right.
 *
 * A `<label>` everywhere except around a radio group. A label forwards its clicks to the
 * first labelable control inside it, and every badge is a button — so clicking the words
 * "Risk per trade" would quietly pick the leftmost option. A group labels its own options.
 */
export function fieldRow(doc: Document, label: string, control: HTMLElement, hint?: string): HTMLElement {
    ensureParamFieldStyles(doc);
    const grouped = control.getAttribute('role') === 'radiogroup';
    const el = doc.createElement(grouped ? 'div' : 'label');
    el.className = 'midorii-field';
    if (grouped) el.setAttribute('aria-label', label);
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
 * The schema field as the form should show it beside the values it sits with.
 *
 * One field in the shared risk schema does not mean the same thing twice: `riskValue` is a
 * percentage or an amount of cash depending on the badge above it, and "Risk" alone is the
 * label for both. A stored schema cannot say that — the answer is in another field — so
 * the form says it, in the one place both forms go through.
 */
export function contextualParam(param: StrategyParam, values: StrategyParams): StrategyParam {
    if (param.key !== 'riskValue') return param;
    const cash = (values.riskMode ?? 'percent') === 'fixed';
    return { ...param, label: cash ? 'Risk ($ per trade)' : 'Risk (% of equity)' };
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
    field: StrategyParam,
    values: StrategyParams,
    onChange: () => void,
): HTMLElement {
    const param = contextualParam(field, values);
    if (param.type === 'select') {
        const current = String(values[param.key] ?? param.default);
        if (param.variant === 'badges') {
            const group = badgeGroup(doc, param.options ?? [], current, (v) => {
                values[param.key] = v;
                onChange();
            });
            return fieldRow(doc, param.label, group, param.hint);
        }
        const select = new Select({
            options: [...(param.options ?? [])],
            value: current,
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
