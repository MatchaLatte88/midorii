import { injectStyles } from '../../../src/ui';
import { makeOverlayCard } from './overlayCards';
import { emptyQuick, quickOrder, quickPlan, stepSize } from './quickTrade';
import type { QuickDraft } from './quickTrade';
import type { OrderSpec } from '../../../shared/engine/broker.js';

/**
 * Buy, size, Sell — floating on the chart, under the account card.
 *
 * Market orders only, and deliberately so: this is the control you reach for when the move is
 * already happening, and every field it does not have is a field you are not reading while it
 * happens. The considered order — limit, stop, a level drawn against structure — is the panel
 * at the side of the chart, and the two do not compete.
 *
 * The stop and target are optional and are given as a RISK, not as levels: say what the trade
 * may cost and how far the target is in stops, and the distances follow from the size. Leave
 * them empty and the order goes out bare, which is a thing people do on purpose.
 */

const STYLE_ID = 'midorii-quick';
const CSS = `
.midorii-quick {
    position: absolute;
    /* Same gutter as the account card, and the same room for the restore button, so the two
       share a right edge until one of them is dragged off it. */
    right: calc(var(--vela-scale-gutter, 0px) + 10px + var(--midorii-overlay-inset, 0px));
    z-index: 4;
    box-sizing: border-box;
    /* The account card's own width, worked out rather than measured: four 62px columns, three
       20px gaps and 14px of padding either side. The two are dragged separately now, so this
       is a starting resemblance and not a promise — a card whose figures grow past it is
       simply the wider of the two. */
    width: 336px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 7px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    user-select: none;
}
.midorii-quick-row { display: flex; align-items: center; gap: 6px; }

.midorii-quick-side {
    all: unset;
    box-sizing: border-box;
    flex: 0 0 auto;
    min-width: 68px;
    padding: 7px 16px;
    border-radius: 999px;
    border: 1px solid currentColor;
    text-align: center;
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
}
.midorii-quick-side[data-side='buy'] { color: var(--vela-up); }
.midorii-quick-side[data-side='sell'] { color: var(--vela-down); }
.midorii-quick-side[data-side='buy']:hover:not(:disabled) { background: color-mix(in srgb, var(--vela-up) 16%, transparent); }
.midorii-quick-side[data-side='sell']:hover:not(:disabled) { background: color-mix(in srgb, var(--vela-down) 16%, transparent); }
.midorii-quick-side:disabled { opacity: 0.4; cursor: default; }

.midorii-quick-step {
    all: unset;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--vela-surface-overlay);
    color: var(--vela-fg-muted);
    font-size: 9px;
    cursor: pointer;
}
.midorii-quick-step:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

.midorii-quick-size {
    flex: 1 1 auto;
    width: 96px;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--vela-surface-sunken);
    color: var(--vela-fg-bright);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    text-align: center;
    outline: none;
}
.midorii-quick-size:focus { border-color: var(--vela-focus); }
.midorii-quick-size::placeholder { color: var(--vela-fg-faint); font-family: var(--vela-font, system-ui); }

.midorii-quick-small {
    flex: 1 1 0;
    min-width: 0;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--vela-surface-sunken);
    color: var(--vela-fg);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    text-align: center;
    outline: none;
}
.midorii-quick-small:focus { border-color: var(--vela-focus); }
.midorii-quick-small::placeholder { color: var(--vela-fg-faint); font-family: var(--vela-font, system-ui); }

.midorii-quick-why {
    padding: 0 4px;
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--vela-danger);
    max-width: 260px;
}
.midorii-quick-why:empty { display: none; }
`;

/** How far under the account card the panel sits. */
const GAP = 8;
/** Where it sits when there is no card to sit under — the card's own anchor. */
const FALLBACK_TOP = 'calc(var(--vela-price-pane-top, 0px) + 10px)';

export interface QuickPanelOptions {
    /** The last price the session is standing on. */
    price(): number;
    /** Send the order. Refusals from the engine are the caller's to surface. */
    order(spec: OrderSpec): void;
    /** The account card, so the panel can sit directly under it whatever height it is. */
    anchor?: HTMLElement | null;
}

export interface QuickPanel {
    readonly el: HTMLElement;
    /** Repaint what depends on the account — the button states. Never touches the boxes. */
    refresh(): void;
    destroy(): void;
}

/**
 * A box that keeps what was typed even when it does not parse.
 *
 * Clearing a bad number would hide the typo instead of showing it, and these three boxes are
 * the difference between a trade that risks 50 and one that risks 5,000.
 */
function box(doc: Document, className: string, placeholder: string, onInput: (value: number | null) => void): HTMLInputElement {
    const input = doc.createElement('input');
    input.className = className;
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;
    input.addEventListener('input', () => {
        const raw = input.value.trim();
        if (raw === '') {
            onInput(null);
            return;
        }
        const n = Number(raw);
        onInput(Number.isFinite(n) ? n : null);
    });
    return input;
}

/**
 * Mount the panel over a chart cell. The caller owns it afterwards — `destroy()` releases what
 * keeps it under the account card and what makes it draggable, and `el.remove()` takes it off.
 */
export function mountQuickPanel(cell: HTMLElement, opts: QuickPanelOptions): QuickPanel {
    const doc = cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const draft: QuickDraft = emptyQuick();

    const el = doc.createElement('div');
    el.className = 'midorii-quick';
    el.style.top = FALLBACK_TOP;

    const row = doc.createElement('div');
    row.className = 'midorii-quick-row';

    const side = (which: 'buy' | 'sell'): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.className = 'midorii-quick-side';
        b.type = 'button';
        b.dataset.side = which;
        b.textContent = which === 'buy' ? 'Buy' : 'Sell';
        b.onclick = () => send(which);
        return b;
    };
    const buy = side('buy');
    const sell = side('sell');

    const size = box(doc, 'midorii-quick-size', 'size', (v) => {
        draft.size = v;
        refresh();
    });

    const stepper = (dir: 1 | -1, glyph: string): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.className = 'midorii-quick-step';
        b.type = 'button';
        b.textContent = glyph;
        b.title = dir > 0 ? 'One step up, at the precision already typed' : 'One step down';
        b.onclick = () => {
            size.value = stepSize(size.value, dir);
            draft.size = size.value === '' ? null : Number(size.value);
            refresh();
        };
        return b;
    };

    row.append(buy, stepper(-1, '▼'), size, stepper(1, '▲'), sell);

    const brackets = doc.createElement('div');
    brackets.className = 'midorii-quick-row';
    const risk = box(doc, 'midorii-quick-small', 'risk $', (v) => {
        draft.riskCash = v;
        refresh();
    });
    risk.title = 'What the stop may cost. Empty sends the order with no stop at all.';
    const rrr = box(doc, 'midorii-quick-small', 'RRR', (v) => {
        draft.rrr = v;
        refresh();
    });
    rrr.title = 'Where the target goes, as a multiple of the stop distance. Empty leaves it off.';
    brackets.append(risk, rrr);

    const why = doc.createElement('div');
    why.className = 'midorii-quick-why';

    el.append(row, brackets, why);
    cell.appendChild(el);

    /* Where it starts: under the card, whatever height the card turns out to be — it is built
     * from the same theme this panel is, and a hard-coded offset would drift the moment either
     * changed. Only where it STARTS, though. Both are dragged independently, and one that has
     * been dropped somewhere holds its own pixels; `reflow` is what decides which of the two
     * this is, so a moved panel does not jump back under a card that changed height. */
    const anchor = opts.anchor ?? null;
    const place = (): void => {
        // No card, or a card that is switched off: there is nothing to sit under, and the
        // panel takes the corner the card would have had.
        if (!anchor || anchor.offsetParent === null) {
            el.style.top = FALLBACK_TOP;
            return;
        }
        el.style.top = `${anchor.offsetTop + anchor.offsetHeight + GAP}px`;
    };
    const card = makeOverlayCard(cell, el, { id: 'quick', place });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => card.reflow()) : null;
    if (anchor) observer?.observe(anchor);

    function refresh(): void {
        const plan = quickPlan(draft, opts.price());
        const blocked = plan.refusal != null;
        for (const b of [buy, sell]) {
            b.disabled = blocked;
            b.title = plan.refusal ?? '';
        }
        /* "Type a size first" is what an empty panel always says; printing it under an empty
         * panel would be telling someone who has not started yet that they got it wrong. */
        why.textContent = draft.size == null ? '' : plan.refusal ?? '';
    }

    function send(which: 'buy' | 'sell'): void {
        const plan = quickPlan(draft, opts.price());
        if (plan.refusal != null || plan.size == null) return;
        opts.order(quickOrder(draft, which, plan));
        /* The size stays. It is how this session is being traded — the next entry is usually
         * the same size, and re-typing it while a move runs is exactly what this panel exists
         * to avoid. The risk and the reward:risk stay with it for the same reason. */
        refresh();
    }

    refresh();

    return {
        el,
        refresh,
        destroy(): void {
            observer?.disconnect();
            card.destroy();
            el.remove();
        },
    };
}
