export const DRAWER_STYLE_ID = 'vela-ui-drawer-2';

export const DRAWER_CSS = `
.vela-drawer-backdrop {
    position: fixed;
    inset: 0;
    background: var(--vela-backdrop);
    /* Same scrim as a dialog's — a sheet and a card interrupt for the same reason. */
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: var(--vela-z-dialog);
}
.vela-drawer-positioner {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: var(--vela-z-dialog);
}
/* Inside a shell that declares a size class, the sheet scopes to the SHELL's bounds
   (the widget root is position:relative) instead of the whole viewport — an embedded
   chart must not curtain the host page. */
[data-layout] .vela-drawer-backdrop, [data-layout] .vela-drawer-positioner { position: absolute; }
.vela-drawer {
    background: var(--vela-surface-card);
    color: var(--vela-fg);
    border: 1px solid var(--vela-border-strong);
    border-bottom: none;
    border-radius: var(--vela-radius-xl) var(--vela-radius-xl) 0 0;
    box-shadow: var(--vela-shadow-dialog);
    font-size: 13px;
    width: 100%;
    max-height: 85%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
}
.vela-drawer[data-state='open'] { animation: vela-drawer-in var(--vela-dur-med) var(--vela-ease); }
@keyframes vela-drawer-in {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
}
/* The grab zone owns its touches (drag-to-dismiss), so the browser must not scroll it. */
.vela-drawer-grab {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 0 6px;
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.vela-drawer-grab::before {
    content: '';
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--vela-border-strong);
}
.vela-drawer-title {
    flex: none;
    padding: 0 20px 12px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--vela-fg-bright);
    user-select: none;
}
.vela-drawer-title:empty { display: none; }
.vela-drawer-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    /* Vertical pans stay native scrolling; horizontal moves reach the sheet's gesture
       recognizer as pointer events (tab swipes). Without this the browser claims a
       sideways touch as a scroll attempt and CANCELS the pointer stream, so swipes
       never registered on real touch devices. Sideways-scrolling strips inside the
       body opt back in with their own touch-action: pan-x. */
    touch-action: pan-y;
    padding: 0 var(--vela-space-3) calc(var(--vela-space-3) + env(safe-area-inset-bottom, 0px));
}
.vela-drawer-body::-webkit-scrollbar { width: 8px; }
.vela-drawer-body::-webkit-scrollbar-thumb {
    background: var(--vela-scroll);
    border-radius: 4px;
    border: 2px solid transparent;
    background-clip: padding-box;
}
`;
