import type { ThemeName, VelaTheme } from '../../../src';
import { resolveTheme } from '../../../src/core/theme';
import { applyThemeTokens, ensureUIHost, injectStyles } from '../../../src/ui';
import type { VelaWorkspace } from '../../../src/workspace';
import { formatMoney } from '../format';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionLevels } from '../replay/replayLevels';
import { wireOrderEntry } from '../replay/replayOrders';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import { mountQuickPanel } from '../replay/quickPanel';
import type { ProjectXController } from './ProjectXController';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';

/**
 * A ProjectX account, put on the chart and taken off again.
 *
 * The same furniture every traded chart gets — the ticket beside it, the dock beneath, the
 * levels on it — over a band that says which ACCOUNT this is. The account name is the part
 * that is not decoration here, and it is why this band differs from the others: a ProjectX
 * key reaches an evaluation and the funded accounts that came out of it, the gateway calls
 * all of them simulated, and the name is the only thing that tells them apart. So the name
 * is shown, always, in full.
 *
 * The break-even button is the other difference. Every other venue in this app hangs
 * protection off the position and needs no such gesture; here a stop is a resting order, and
 * moving it to the entry is the one move common enough to deserve its own key.
 */

const STYLE_ID = 'midorii-projectx';
const CSS = `
.midorii-projectx {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px);
    z-index: 5;
    display: flex; align-items: center; gap: 14px;
    padding: 7px 12px 8px;
    border: 1px solid var(--vela-border); border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev); box-shadow: var(--vela-shadow);
    user-select: none;
}
/* Amber, the colour this venue is marked with wherever it appears. */
.midorii-projectx { border-left: 3px solid var(--midorii-projectx-accent, #d99a2b); }
.midorii-projectx[data-live="1"] { border-color: var(--vela-danger); border-left-color: var(--vela-danger); }
.midorii-projectx[data-stale="1"] .midorii-projectx-col { opacity: 0.4; }
.midorii-projectx-badge {
    padding: 3px 8px; border-radius: 999px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
}
.midorii-projectx-badge[data-live="1"] { background: var(--vela-danger); color: #fff; }
.midorii-projectx-badge[data-live="0"] {
    border: 1px solid var(--midorii-projectx-accent, #d99a2b);
    background: var(--vela-surface); color: var(--midorii-projectx-accent, #d99a2b);
}
.midorii-projectx-account {
    max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-bright); font-size: 11px; font-weight: 600;
}
.midorii-projectx-col { display: flex; flex-direction: column; gap: 1px; min-width: 68px; }
.midorii-projectx-label {
    color: var(--vela-fg-muted); font-size: 9px; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
}
.midorii-projectx-value {
    color: var(--vela-fg-bright); font: 14px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
}
.midorii-projectx-value[data-side="short"] { color: var(--vela-danger); }
.midorii-projectx-note { max-width: 15ch; color: var(--vela-fg-muted); font-size: 10px; line-height: 1.3; }
.midorii-projectx-note.warn { color: var(--vela-danger); }
.midorii-projectx-btn {
    all: unset; padding: 5px 12px; border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md); color: var(--vela-fg);
    font-size: var(--vela-font-size-md); cursor: pointer;
}
.midorii-projectx-btn[disabled] { opacity: 0.4; cursor: default; }
.midorii-projectx-btn.danger { border-color: var(--vela-danger); color: var(--vela-danger); }
`;

export interface ProjectXMountOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    main: HTMLElement;
    controller: ProjectXController;
    settings: () => PaperSettings;
    onSettings: (next: PaperSettings) => void;
    theme: ThemeName | VelaTheme;
}

export interface ProjectXMount { unmount(): void }

function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

export function mountProjectXTrading(opts: ProjectXMountOptions): ProjectXMount {
    const { workspace: ws, controller } = opts;
    const chart = ws.chart;
    const doc = ws.root.ownerDocument;
    const off: Array<() => void> = [];

    registerTradeIndicator();
    const indicator = chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
    controller.attachIndicator(indicator);

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => ({
            equity: controller.equity(),
            price: controller.price(),
            available: controller.available(),
        }),
        counts: () => ({ positions: controller.positions().length, orders: controller.orders().length }),
        actions: {
            order: (spec) => guarded(ws, () => controller.order(spec)),
            flatten: () => guarded(ws, () => {
                for (const position of controller.positions()) controller.closeOne(position.id);
            }),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        risk: riskOf(opts.settings()),
        brackets: () => bracketsOf(opts.settings()),
        tick: () => controller.dealing.tickSize,
        quickSizes: () => opts.settings().quickSizes,
        onQuickSizes: (next) => opts.onSettings({ ...opts.settings(), quickSizes: next }),
        sizing: () => opts.settings().sizingMode,
        onSizing: (next) => opts.onSettings({ ...opts.settings(), sizingMode: next }),
    });
    ensureUIHost(sidebar.el, resolveTheme(opts.theme));
    off.push(chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme)));
    off.push(() => {
        sidebar.dispose();
        sidebar.el.remove();
    });

    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guarded(ws, () => controller.closeOne(id)),
        protect: (levels, id) => guarded(ws, () => controller.protect(levels, id)),
        cancelOrder: (id) => guarded(ws, () => controller.cancelOrder(id)),
        cancelAll: () => guarded(ws, () => controller.cancelAll()),
        flatten: () => {
            for (const position of controller.positions()) guarded(ws, () => controller.closeOne(position.id));
        },
    });
    off.push(() => dock.el.remove());

    off.push(wireOrderEntry({
        chart,
        controller,
        host: ws.root,
        risk: () => riskOf(opts.settings()),
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    /* The drag gestures on the plot — where a stop and a target are set on an open position.
     * They land in `protect`, which on this venue means resting orders of their own. */
    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    injectStyles(STYLE_ID, CSS, doc);
    const card = doc.createElement('div');
    card.className = 'midorii-projectx';
    card.dataset.live = controller.isLive ? '1' : '0';

    const badge = doc.createElement('span');
    badge.className = 'midorii-projectx-badge';
    badge.dataset.live = controller.isLive ? '1' : '0';
    badge.textContent = controller.isLive ? 'Funded' : 'ProjectX';
    badge.title = controller.isLive
        ? 'Orders placed here go to a funded account. They are real orders.'
        : 'The gateway reports this account as simulated. On a prop firm that includes funded '
        + 'accounts settled in simulation — check the account name rather than this label.';

    /* The account name, in full and always. On this venue it is the only thing that
     * distinguishes an evaluation from a funded account. */
    const account = doc.createElement('span');
    account.className = 'midorii-projectx-account';
    account.textContent = controller.accountName;
    account.title = `Orders from this chart go to ${controller.accountName}.`;

    const column = (label: string, title: string): { el: HTMLElement; value: HTMLElement } => {
        const el = doc.createElement('div');
        el.className = 'midorii-projectx-col';
        const heading = doc.createElement('span');
        heading.className = 'midorii-projectx-label';
        heading.textContent = label;
        heading.title = title;
        const value = doc.createElement('span');
        value.className = 'midorii-projectx-value';
        value.textContent = '—';
        el.append(heading, value);
        return { el, value };
    };

    const worth = column('Equity USD', 'The account balance the gateway states, with the open result added to it.');
    const size = column('Position', 'What is open right now, in contracts. Negative is short.');
    const open = column('Open P/L', 'Ticks moved times the value of a tick times the contracts held.');

    const note = doc.createElement('span');
    note.className = 'midorii-projectx-note';

    /**
     * Break-even: move the stop to the entry.
     *
     * Disabled with a reason rather than hidden — a button that vanishes leaves somebody
     * hunting for it, and one that can always be pressed and then explains itself is worse.
     * The controller is asked WHY it is unavailable and the answer goes in the tooltip.
     */
    const breakEven = doc.createElement('button');
    breakEven.type = 'button';
    breakEven.className = 'midorii-projectx-btn';
    breakEven.textContent = 'Break-even';
    breakEven.onclick = () => guarded(ws, () => {
        controller.breakEven();
        ws.toast('Stop moved to the entry.', 'info');
    });

    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.className = 'midorii-projectx-btn danger';
    flatten.textContent = 'Close position';
    flatten.title = `Close the open ${controller.ticker} position at market.`;
    let armed = false;
    const disarm = (): void => {
        armed = false;
        flatten.textContent = 'Close position';
    };
    flatten.onclick = () => {
        const position = controller.positions()[0];
        if (!position) return;
        if (!armed) {
            armed = true;
            flatten.textContent = 'Close — press again';
            return;
        }
        disarm();
        guarded(ws, () => controller.closeOne(position.id));
    };
    flatten.onmouseleave = disarm;

    card.append(badge, account, worth.el, size.el, open.el, note, breakEven, flatten);
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    if (cell) cell.appendChild(card);
    else console.warn('[midorii] no chart cell to mount the ProjectX account band into');

    /* Buy / size / Sell on the plot. Brackets go out as DISTANCES: the gateway takes them in
     * ticks from the fill, which is a distance, and a level handed to it would have to be
     * measured against a fill price that does not exist yet. */
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => controller.order(spec)),
            brackets: 'distance',
            tick: () => controller.dealing.tickSize,
            anchor: card,
        })
        : null;
    off.push(() => quick?.destroy());

    const paint = (): void => {
        dock.render(controller.book());
        worth.value.textContent = formatMoney(controller.equity());
        const position = controller.positions()[0];
        const held = position?.size ?? 0;
        size.value.textContent = held === 0 ? 'flat' : String(held);
        if (held < 0) size.value.dataset.side = 'short';
        else delete size.value.dataset.side;
        open.value.textContent = position ? formatMoney(position.unrealized) : '—';

        const refusal = controller.breakEvenRefusal();
        breakEven.disabled = refusal != null;
        breakEven.title = refusal ?? `Move the ${controller.ticker} stop to ${position?.entryPrice ?? 'the entry'}.`;

        flatten.disabled = position == null;
        if (position == null) disarm();
        card.dataset.stale = controller.isStale() ? '1' : '0';
        if (controller.isStale()) {
            note.textContent = controller.readAt() > 0
                ? `not answering · last ${new Date(controller.readAt()).toISOString().slice(11, 19)}`
                : 'not answering';
            note.classList.add('warn');
        } else {
            note.textContent = '';
            note.classList.remove('warn');
        }
    };

    controller.onChange = () => {
        paint();
        sidebar.refresh();
        quick?.refresh();
    };
    off.push(chart.on('bar', (bar) => controller.mark(bar.close)));
    paint();
    controller.start();

    return {
        unmount(): void {
            controller.stop();
            controller.onChange = null;
            for (const dispose of off) dispose();
            card.remove();
            indicator.remove();
        },
    };
}
