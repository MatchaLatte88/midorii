import type { ThemeName, VelaTheme } from '../../../src';
import { resolveTheme } from '../../../src/core/theme';
import { applyThemeTokens, ensureUIHost, injectStyles } from '../../../src/ui';
import type { VelaWorkspace } from '../../../src/workspace';
import { formatMoney } from '../format';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionLevels } from '../replay/replayLevels';
import { wireOrderEntry } from '../replay/replayOrders';
import { wirePendingMenu } from '../replay/chartPending';
import { wireTradePreview } from '../replay/chartPreview';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import { mountQuickPanel } from '../replay/quickPanel';
import type { BinanceSpotController } from './BinanceSpotController';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';

const STYLE_ID = 'midorii-binance-spot';
const CSS = `
.midorii-binance-spot {
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
.midorii-binance-spot[data-stale="1"] .midorii-binance-spot-col { opacity: 0.4; }
.midorii-binance-spot-badge {
    padding: 3px 8px; border: 1px solid var(--vela-border); border-radius: 999px;
    background: var(--vela-surface); color: var(--vela-fg-muted);
    font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
}
.midorii-binance-spot-col { display: flex; flex-direction: column; gap: 1px; min-width: 68px; }
.midorii-binance-spot-label {
    color: var(--vela-fg-muted); font-size: 9px; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
}
.midorii-binance-spot-value {
    color: var(--vela-fg-bright); font: 14px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
}
.midorii-binance-spot-note { max-width: 15ch; color: var(--vela-fg-muted); font-size: 10px; line-height: 1.3; }
.midorii-binance-spot-note.warn { color: var(--vela-danger); }
.midorii-binance-spot-flat {
    all: unset; padding: 5px 12px; border: 1px solid var(--vela-danger);
    border-radius: var(--vela-radius-md); color: var(--vela-danger);
    font-size: var(--vela-font-size-md); cursor: pointer;
}
.midorii-binance-spot-flat[disabled] { opacity: 0.4; cursor: default; }
`;

export interface BinanceSpotMountOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    main: HTMLElement;
    controller: BinanceSpotController;
    settings: () => PaperSettings;
    onSettings: (next: PaperSettings) => void;
    theme: ThemeName | VelaTheme;
}

export interface BinanceSpotMount { unmount(): void }

function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

export function mountBinanceSpotTrading(opts: BinanceSpotMountOptions): BinanceSpotMount {
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

    /* What is open, under the chart — the replay's own dock on the venue's book. The four
     * buttons that need an engine behind the position are not offered and so not drawn; on
     * Spot two of them could not mean anything anyway, since it never shorts. */
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
    // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
    off.push(wirePendingMenu({
        chart,
        sidebar,
        price: () => controller.price(),
        tick: () => controller.info.tickSize,
    }));
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    off.push(wireTradePreview({
        chart,
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    injectStyles(STYLE_ID, CSS, doc);
    const card = doc.createElement('div');
    card.className = 'midorii-binance-spot';
    const badge = doc.createElement('span');
    badge.className = 'midorii-binance-spot-badge';
    badge.textContent = 'Spot demo';
    badge.title = 'Orders go only to Binance Spot Demo. This integration has no production endpoint.';

    const column = (label: string, title: string): { el: HTMLElement; value: HTMLElement } => {
        const el = doc.createElement('div');
        el.className = 'midorii-binance-spot-col';
        const heading = doc.createElement('span');
        heading.className = 'midorii-binance-spot-label';
        heading.textContent = label;
        heading.title = title;
        const value = doc.createElement('span');
        value.className = 'midorii-binance-spot-value';
        value.textContent = '—';
        el.append(heading, value);
        return { el, value };
    };
    const value = column(`Pair value ${controller.info.quoteAsset}`, 'The value of this pair\'s base and quote balances, not the whole demo account.');
    const quote = column(`Free ${controller.info.quoteAsset}`, 'Quote balance available for a buy.');
    const base = column(`Free ${controller.info.baseAsset}`, 'Base balance available for a sell. Spot never shorts.');
    const note = doc.createElement('span');
    note.className = 'midorii-binance-spot-note';
    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.className = 'midorii-binance-spot-flat';
    flatten.textContent = 'Sell holding';
    flatten.title = `Cancel every open ${controller.symbol} order, then sell the whole free ${controller.info.baseAsset} balance at market.`;
    let armed = false;
    const disarm = (): void => {
        armed = false;
        flatten.textContent = 'Sell holding';
    };
    flatten.onclick = () => {
        const position = controller.positions()[0];
        if (!position) return;
        if (!armed) {
            armed = true;
            flatten.textContent = 'Sell — press again';
            return;
        }
        disarm();
        guarded(ws, () => controller.closeOne(position.id));
    };
    flatten.onmouseleave = disarm;
    card.append(badge, value.el, quote.el, base.el, note, flatten);
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    cell?.appendChild(card);

    /* Buy / size / Sell on the plot, under the band — the same panel a replay and a paper
     * account get. Its protection goes out as LEVELS: Binance reads two prices and nothing
     * else, so a distance handed to it is protection dropped on the way out. */
    const quickPanel = cell
        ? mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => controller.order(spec)),
            brackets: 'levels',
            tick: () => controller.info.tickSize,
            anchor: card,
        })
        : null;
    off.push(() => quickPanel?.destroy());

    const paint = (): void => {
        // No account line with it: that summary is a history, and this account keeps none.
        dock.render(controller.book());
        value.value.textContent = formatMoney(controller.equity());
        quote.value.textContent = formatMoney(controller.available());
        base.value.textContent = String(Number(controller.availableBase().toPrecision(8)));
        const holding = controller.positions().length > 0;
        flatten.disabled = !holding;
        if (!holding) disarm();
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
        quickPanel?.refresh();
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
