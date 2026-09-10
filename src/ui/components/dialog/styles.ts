import { overlayScrollbarCss } from '../../styles';

export const DIALOG_STYLE_ID = 'vela-ui-dialog-6';

/*
 * The modal card.
 *
 * A dialog is the one moment the program stops and asks, so it is built like a printed
 * card rather than like a floating tool: a wide radius, a chrome band top and bottom that
 * holds the title and the buttons, and a plain body between them that is only content. The
 * three bands are what makes a dialog with two sentences in it and a dialog with forty
 * fields in it read as the same object.
 *
 * Above the title sits an EYEBROW — a small tracked line naming which part of the program
 * is speaking. It is there because a modal arrives with no surroundings: the panel it came
 * from is behind a scrim, and the title alone ("Settings", "Runs") does not say whose. It
 * is deliberately quiet — grey, not accented — because it is an address, not a headline.
 *
 * The accent appears exactly once per card, on the button that commits, and even there as
 * ink on a wash of itself rather than a saturated fill: that keeps one accent legible on a
 * night surface and on a paper one without needing white text it cannot always carry.
 */
export const DIALOG_CSS = `
.vela-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--vela-backdrop);
    /* The page stays visible behind a dimming scrim but stops being readable — a modal
       that can be read past is a modal people answer without looking at. */
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: var(--vela-z-dialog);
}
/* Non-dimming variant: still catches outside clicks, but the page stays readable. */
.vela-dialog-backdrop--clear {
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
.vela-dialog-positioner {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    z-index: var(--vela-z-dialog);
}
.vela-dialog-backdrop[data-contained],
.vela-dialog-positioner[data-contained] { position: absolute; }
.vela-dialog-positioner[data-align='center'] {
    align-items: center;
    padding-top: 0;
}
.vela-dialog {
    background: var(--vela-surface-card);
    color: var(--vela-fg);
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-xl);
    box-shadow: var(--vela-shadow-dialog);
    font-size: 13px;
    min-width: 300px;
    max-width: min(92vw, 560px);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
}
.vela-dialog[data-state='open'] { animation: vela-dialog-in var(--vela-dur-med) var(--vela-ease); }
@keyframes vela-dialog-in {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}
.vela-dialog-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 14px 14px 20px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
    user-select: none;
}
.vela-dialog-heading { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.vela-dialog-eyebrow {
    font-family: var(--vela-font-mono);
    font-size: 9px;
    font-weight: 400;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    opacity: 0.75;
}
.vela-dialog-eyebrow:empty { display: none; }
.vela-dialog-title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
    color: var(--vela-fg-bright);
}
.vela-dialog-close {
    all: unset;
    box-sizing: border-box;
    flex: none;
    cursor: pointer;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--vela-control-radius);
    color: var(--vela-fg-muted);
    line-height: 1;
    font-size: 15px;
    transition: background var(--vela-dur-fast) ease, color var(--vela-dur-fast) ease, border-color var(--vela-dur-fast) ease;
}
/* Closing is the one destructive-shaped action every dialog carries, so it warms rather
   than greys on approach — the same tint the delete buttons use. */
.vela-dialog-close:hover {
    background: var(--vela-danger-soft);
    border-color: var(--vela-danger-line);
    color: var(--vela-danger);
}
.vela-dialog-close:active { transform: scale(0.94); }
.vela-dialog-close:disabled { opacity: 0.35; cursor: default; }
.vela-dialog-body { padding: 20px; overflow: auto; min-height: 0; flex: 1 1 auto; }
.vela-dialog-body[data-flush] { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.vela-dialog-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.vela-dialog--settings {
    width: fit-content;
    min-width: min(560px, 94vw);
    max-width: min(720px, 94vw);
    max-height: 70vh;
    font-size: 13px;
    cursor: default;
}
.vela-dialog--form {
    width: fit-content;
    min-width: min(380px, 90%);
    max-width: min(640px, 94%);
    max-height: 82%;
    font-size: 14px;
}
/* Form dialogs (indicator inputs, drawing settings) put a tab strip immediately under the
   header, and that strip carries its own rule — a header line too would box the tabs in. */
.vela-dialog--form .vela-dialog-header { border-bottom: none; }
${overlayScrollbarCss('.vela-dialog-body')}
/* Scrollers NESTED in a dialog (a flush body's grid, a tab pane) get the same thin
   overlay bars — the two-class selectors below stay overridable by more specific
   per-dialog sheets. */
${overlayScrollbarCss('.vela-dialog *')}
/* ── mobile chrome: dialogs fill the shell ─────────────────────────────────────────
   Inside a shell in the mobile size class ([data-layout='mobile'] on the widget root,
   which is position:relative) every kit dialog presents fullscreen: desktop cards are
   unusable at phone widths, and the shell's bounds — not the viewport — are the honest
   "screen" for an embedded chart. */
[data-layout='mobile'] .vela-dialog-backdrop { position: absolute; }
[data-layout='mobile'] .vela-dialog-positioner {
    position: absolute;
    padding: 0;
    align-items: stretch;
}
[data-layout='mobile'] .vela-dialog {
    width: 100%;
    min-width: 0;
    max-width: none;
    max-height: none;
    flex: 1 1 auto;
    border: none;
    border-radius: 0;
    transform: none !important; /* a desktop drag offset must not survive the flip */
}
[data-layout='mobile'] .vela-dialog-close { width: 40px; height: 40px; }
[data-layout='mobile'] .vela-dialog-body { padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px)); }
`;
