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
import type { BybitController } from './BybitController';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';

/**
 * A Bybit account, put on the chart and taken off again.
 *
 * The same furniture every traded chart gets — the ticket beside it, the dock beneath, the
 * position levels on it — over a band that says which account this is. The band is the part
 * that is not decoration: on a live key it is red and says so, because the difference between
 * demo and live is one word in a file nobody looks at twice, and the chart is where that word
 * has consequences.
 *
 * What the band shows differs with the product, because the two are worth different things. A
 * perpetual has equity behind it and a position with a direction; a spot pair has two balances
 * and a holding that can only ever be sold.
 */

const STYLE_ID = 'midorii-bybit';
const CSS = `
.midorii-bybit {
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
.midorii-bybit[data-live="1"] { border-color: var(--vela-danger); }
.midorii-bybit[data-stale="1"] .midorii-bybit-col { opacity: 0.4; }
.midorii-bybit-badge {
    padding: 3px 8px; border-radius: 999px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
}
.midorii-bybit-badge[data-live="1"] { background: var(--vela-danger); color: #fff; }
.midorii-bybit-badge[data-live="0"] {
    border: 1px solid var(--vela-border); background: var(--vela-surface); color: var(--vela-fg-muted);
}
.midorii-bybit-col { display: flex; flex-direction: column; gap: 1px; min-width: 68px; }
.midorii-bybit-label {
    color: var(--vela-fg-muted); font-size: 9px; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
}
.midorii-bybit-value {
    color: var(--vela-fg-bright); font: 14px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
}
.midorii-bybit-value[data-side="short"] { color: var(--vela-danger); }
.midorii-bybit-note { max-width: 15ch; color: var(--vela-fg-muted); font-size: 10px; line-height: 1.3; }
.midorii-bybit-note.warn { color: var(--vela-danger); }
.midorii-bybit-flat {
    all: unset; padding: 5px 12px; border: 1px solid var(--vela-danger);
    border-radius: var(--vela-radius-md); color: var(--vela-danger);
    font-size: var(--vela-font-size-md); cursor: pointer;
}
.midorii-bybit-flat[disabled] { opacity: 0.4; cursor: default; }
`;

export interface BybitMountOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    main: HTMLElement;
    controller: BybitController;
    settings: () => PaperSettings;
    onSettings: (next: PaperSettings) => void;
    theme: ThemeName | VelaTheme;
}

export interface BybitMount { unmount(): void }

function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

export function mountBybitTrading(opts: BybitMountOptions): BybitMount {
    const { workspace: ws, controller } = opts;
    const chart = ws.chart;
    const doc = ws.root.ownerDocument;
    const off: Array<() => void> = [];
    const perpetual = controller.category === 'linear';

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
        tick: () => controller.info.tickSize,
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

    /* What is open, under the chart — the replay's own dock on the venue's book. The buttons
     * that need an engine behind the position are not offered and so not drawn. */
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
    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    injectStyles(STYLE_ID, CSS, doc);
    const card = doc.createElement('div');
    card.className = 'midorii-bybit';
    card.dataset.live = controller.isLive ? '1' : '0';
    const badge = doc.createElement('span');
    badge.className = 'midorii-bybit-badge';
    badge.dataset.live = controller.isLive ? '1' : '0';
    badge.textContent = controller.isLive
        ? `Live money · ${perpetual ? 'perp' : 'spot'}`
        : `Demo · ${perpetual ? 'perp' : 'spot'}`;
    badge.title = controller.isLive
        ? `Orders placed here are real orders on your Bybit ${perpetual ? 'perpetual' : 'spot'} account.`
        : 'Orders go to Bybit Demo Trading. The prices are real; the money is not.';

    const column = (label: string, title: string): { el: HTMLElement; value: HTMLElement } => {
        const el = doc.createElement('div');
        el.className = 'midorii-bybit-col';
        const heading = doc.createElement('span');
        heading.className = 'midorii-bybit-label';
        heading.textContent = label;
        heading.title = title;
        const value = doc.createElement('span');
        value.className = 'midorii-bybit-value';
        value.textContent = '—';
        el.append(heading, value);
        return { el, value };
    };

    const settle = controller.accountCurrency();
    const worth = perpetual
        ? column(`Equity ${settle}`, `The ${settle} this account holds, with the open result already in it.`)
        : column(`Pair value ${controller.info.quoteAsset}`, 'What this pair\'s two balances are worth together, not the whole account.');
    const free = column('Available', 'What the unified account has free to open something new with. Bybit states it in USD across the whole account, not per coin.');
    const third = perpetual
        ? column('Position', 'What is open right now, in contracts. Negative is short.')
        : column(`Free ${controller.info.baseAsset}`, `The ${controller.info.baseAsset} not already reserved by a resting sell. Spot never shorts.`);

    const note = doc.createElement('span');
    note.className = 'midorii-bybit-note';

    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.className = 'midorii-bybit-flat';
    const flattenLabel = perpetual ? 'Close position' : 'Sell holding';
    flatten.textContent = flattenLabel;
    flatten.title = perpetual
        ? `Cancel every open ${controller.symbol} order, then close the position at market.`
        : `Cancel every open ${controller.symbol} order, then sell the whole ${controller.info.baseAsset} balance at market.`;
    let armed = false;
    const disarm = (): void => {
        armed = false;
        flatten.textContent = flattenLabel;
    };
    flatten.onclick = () => {
        const position = controller.positions()[0];
        if (!position) return;
        if (!armed) {
            armed = true;
            flatten.textContent = `${perpetual ? 'Close' : 'Sell'} — press again`;
            return;
        }
        disarm();
        guarded(ws, () => controller.closeOne(position.id));
    };
    flatten.onmouseleave = disarm;

    card.append(badge, worth.el, free.el, third.el, note, flatten);
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    if (cell) cell.appendChild(card);
    else console.warn('[midorii] no chart cell to mount the Bybit account band into');

    /* Buy / size / Sell on the plot, under the band — the same panel a replay and a paper
     * account get. Its protection goes out as LEVELS: Bybit reads two prices and nothing
     * else, so a distance handed to it is protection dropped on the way out. */
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => controller.order(spec)),
            brackets: 'levels',
            tick: () => controller.info.tickSize,
            anchor: card,
        })
        : null;
    off.push(() => quick?.destroy());

    const paint = (): void => {
        // No account line with it: that summary is a history, and this account keeps none.
        dock.render(controller.book());
        worth.value.textContent = formatMoney(controller.equity());
        free.value.textContent = formatMoney(controller.available());
        const position = controller.positions()[0];
        if (perpetual) {
            const size = position?.size ?? 0;
            third.value.textContent = size === 0 ? 'flat' : String(Number(size.toPrecision(8)));
            if (size < 0) third.value.dataset.side = 'short';
            else delete third.value.dataset.side;
        } else {
            third.value.textContent = String(Number(controller.availableBase().toPrecision(8)));
        }
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
