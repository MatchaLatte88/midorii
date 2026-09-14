/**
 * The shape a settings dialog in this app wears: labelled rows, section headings, the small
 * print under them, and the footer buttons.
 *
 * Extracted from the paper-trading settings when a second dialog needed the same thing. The
 * class names still say `paper` because that is what they were called when they were only that
 * dialog's, and renaming them would change every rule for nothing — the CSS is identical
 * either way and nothing outside this file and its two callers reads the names.
 *
 * The style id is shared too, so whichever dialog opens first injects the rules and the second
 * finds them already there.
 */

export const SETTINGS_STYLE_ID = 'midorii-paper-settings';

export const SETTINGS_CSS = `
.midorii-paper-sect {
    margin: 18px 0 10px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    opacity: 0.85;
}
.midorii-paper-sect:first-child { margin-top: 0; }
.midorii-paper-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
    font-size: var(--vela-font-size-md);
    color: var(--vela-fg);
}
.midorii-paper-row > span:first-child { white-space: nowrap; }
.midorii-paper-pair { display: flex; align-items: center; gap: 6px; }
.midorii-paper-note {
    margin: -2px 0 12px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vela-fg-muted);
}
.midorii-paper-warn {
    margin: 4px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vela-danger);
    min-height: 1.45em;
}
.midorii-paper-key {
    min-width: 10ch;
    font-family: var(--vela-font-mono);
    font-size: 11px;
}
.midorii-paper-key[data-listening='1'] {
    border-color: var(--vela-accent);
    color: var(--vela-accent);
}
/* Only the danger tone is these dialogs' own — the plain and primary shapes are the kit's
   footer buttons, which every other dialog in the app now wears. */
.vela-dialog-btn[data-tone='danger'] { color: var(--vela-danger); }
.vela-dialog-btn[data-tone='danger']:hover {
    border-color: var(--vela-danger-line);
    background: var(--vela-danger-soft);
    color: var(--vela-danger);
}
`;

/** One setting: what it is called, and the control that sets it. */
export function row(label: string, control: HTMLElement, doc: Document): HTMLElement {
    const el = doc.createElement('label');
    el.className = 'midorii-paper-row';
    const text = doc.createElement('span');
    text.textContent = label;
    el.append(text, control);
    return el;
}

/** The small print under a heading — what these settings mean, not what they are called. */
export function note(text: string, doc: Document): HTMLElement {
    const el = doc.createElement('p');
    el.className = 'midorii-paper-note';
    el.textContent = text;
    return el;
}

export function section(text: string, doc: Document): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-paper-sect';
    el.textContent = text;
    return el;
}

export function button(text: string, doc: Document, primary = false): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.textContent = text;
    return b;
}
