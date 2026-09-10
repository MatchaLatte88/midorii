// Style delivery for the UI kit — JS-injected constructed sheets, same idiom as the
// renderer chrome (id-guarded <style> tags; no bundler CSS pipeline, works in Shadow DOM).

export { withAlpha } from '../core/color';

/** Overlay scrollbar used by settings panes, dialog bodies, and similar chrome. */
export function overlayScrollbarCss(selector: string, width = 8): string {
    return (
        `${selector}::-webkit-scrollbar{width:${width}px;height:${width}px;}` +
        `${selector}::-webkit-scrollbar-thumb{background:var(--vela-scroll);border-radius:4px;border:2px solid transparent;background-clip:padding-box;}` +
        `${selector}::-webkit-scrollbar-track{background:transparent;}` +
        `${selector}::-webkit-scrollbar-button{display:none;width:0;height:0;}`
    );
}

export const BUTTON_STYLE_ID = 'vela-ui-button';

/**
 * The action button, in the three tones a decision comes in: plain (step back), primary
 * (commit), danger (remove).
 *
 * It lives here rather than in the dialog sheet because it outgrew dialogs — the run
 * library, the settings page and the bot form all end in the same row of buttons, and a
 * page that never opens a dialog must still be able to wear one. The class keeps its
 * historical `vela-dialog-btn` name so the markup that already uses it stays valid.
 *
 * Neither filled tone is saturated: they are ink on a wash of themselves, which is what
 * lets one accent stay legible on a night surface and on a paper one without white text.
 */
export const BUTTON_CSS = `
.vela-dialog-btn {
    cursor: pointer;
    height: var(--vela-control-h);
    padding: 0 14px;
    border-radius: var(--vela-control-radius);
    border: 1px solid var(--vela-border);
    background: var(--vela-surface);
    color: var(--vela-fg);
    font-weight: 600;
    font-size: 12px;
    font-family: inherit;
    transition: background var(--vela-dur-fast) ease, color var(--vela-dur-fast) ease, opacity var(--vela-dur-fast) ease, border-color var(--vela-dur-fast) ease;
}
.vela-dialog-btn:hover:not(:disabled) { background: var(--vela-hover); color: var(--vela-fg-bright); border-color: var(--vela-border-strong); }
.vela-dialog-btn:disabled { opacity: 0.4; cursor: default; }
.vela-dialog-btn-primary {
    border-color: var(--vela-accent-line);
    background: var(--vela-accent-soft);
    color: var(--vela-accent-ink);
}
.vela-dialog-btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vela-accent-ink) 18%, transparent);
    border-color: var(--vela-accent-ink);
    color: var(--vela-accent-ink);
}
.vela-dialog-btn-danger {
    border-color: var(--vela-danger-line);
    background: var(--vela-danger-soft);
    color: var(--vela-danger);
}
.vela-dialog-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vela-danger) 18%, transparent);
    border-color: var(--vela-danger);
    color: var(--vela-danger);
}
`;

/** Focus ring shared by typeable fields (combo inputs, textareas). */
export const FIELD_FOCUS_CSS =
    'outline:none;transition:border-color .12s ease,box-shadow .12s ease;';
export const FIELD_FOCUS_RING =
    'border-color:var(--vela-focus);box-shadow:0 0 0 3px var(--vela-focus-soft);';

/** Inject a stylesheet once per root (document or shadow root). Idempotent by id. */
export function injectStyles(id: string, css: string, root: Document | ShadowRoot = document): void {
    if (typeof document === 'undefined') return;
    const host = root instanceof Document ? root.head : root;
    if (root.getElementById?.(id) ?? host.querySelector(`#${CSS.escape(id)}`)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    host.appendChild(s);
}
