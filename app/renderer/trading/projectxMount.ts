import type { ThemeName, VelaTheme } from '../../../src';
import { resolveTheme } from '../../../src/core/theme';
import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
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
import type { ProjectXController } from './ProjectXController';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';
import { sessionState } from './riskLimits';
import { flattenAll, wireProp } from './propBand';
import { mountAccountBand } from './accountBand';
import { installTradeHotkeys, loadHotkeys } from './hotkeys';
import { historyStats } from './accountStats';
import { wirePositionStyle } from './positionStyleSettings';

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

/**
 * The colour ProjectX is marked with wherever it appears — the Trade menu, and the band here.
 *
 * Amber because this venue lists SEVERAL accounts and they have to read as one group without
 * repeating the venue's name in every label. It lives beside the band rather than beside the
 * menu because the band is the thing it describes; the menu imports it, the way it already
 * imports everything else about this venue.
 */
export const PROJECTX_ACCENT = '#d99a2b';

export interface ProjectXMountOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    main: HTMLElement;
    controller: ProjectXController;
    /** Which account this is, as the trade menu keys it — `projectx:1234`. The limits and the
     *  trailing mark are kept under it, so each account carries its own. */
    accountKey: string;
    settings: () => PaperSettings;
    onSettings: (next: PaperSettings) => void;
    theme: ThemeName | VelaTheme;
}

export interface ProjectXMount {
    /** The latest room before this account's configured maximum-loss floor. */
    mllRoom(): number | null;
    unmount(): void;
}

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
    // How positions are drawn, and the Trading tab in the chart settings that says so.
    off.push(wirePositionStyle({ workspace: ws, indicator }).dispose);

    /* This account's own limits: the floor under it, its daily limit, its goal — and the
     * figures for the band. Kept under the account's key, so the evaluation and the funded
     * account beside it do not share one set of numbers. See propBand.ts. */
    const prop = wireProp({
        account: opts.accountKey,
        name: controller.accountName,
        host: ws.root,
        currency: () => 'USD',
        equity: () => controller.equity(),
        /* The gateway states no unrealized figure on a position; the controller computes it,
         * and it is what makes the daily limit count the trade that is still open. */
        openPnl: () => controller.positions().reduce((sum, p) => sum + p.unrealized, 0),
        history: () => controller.history(),
        flatten: () => flattenAll(controller),
        notify: (message, kind) => ws.toast(message, kind),
        onChange: () => paint(),
    });

    /**
     * The limits, applied at the one place every way in passes through.
     *
     * Three gestures place an order here — the ticket, the quick panel and a block traded on
     * the plot — and each of them calls this rather than carrying its own copy of the rule.
     * It refuses by throwing so the reason reaches the person the same way every other venue
     * refusal does.
     */
    const guardLimits = (spec: { side: 'buy' | 'sell'; size: number }): void => {
        prop.guard({
            net: controller.positions().reduce((sum, p) => sum + p.size, 0),
            side: spec.side,
            size: spec.size,
        });
    };

    /* A reverse leaves the size where it was, so the guard above would wave it through — but it
     * ends one trade and opens another, and a session that may not open trades may not do that. */
    const guardReverse = (id: number): void => {
        const held = controller.positions().find((p) => p.id === id)?.size ?? 0;
        prop.guard({ net: 0, side: held > 0 ? 'sell' : 'buy', size: Math.abs(held) });
    };

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => ({
            equity: controller.equity(),
            price: controller.price(),
            available: controller.available(),
            /* The three facts that make a figure on this ticket a figure about futures rather
             * than about a spot unit: what a point is worth, and the grid a size has to land
             * on. Without the first, every risk shown here is out by the contract multiplier. */
            pointValue: controller.pointValue(),
            sizeStep: controller.dealing.sizeStep,
            minSize: controller.dealing.minSize,
            /* What a buy costs and what a sell gets, where the feed has stated both — the
             * same two-sided header the Capital.com account has. Null until then, and the
             * panel shows the last price on both halves, which is what it always did. */
            ...(controller.quote() ?? {}),
        }),
        counts: () => ({ positions: controller.positions().length, orders: controller.orders().length }),
        actions: {
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            flatten: () => guarded(ws, () => {
                for (const position of controller.positions()) controller.closeOne(position.id);
            }),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        risk: riskOf(opts.settings()),
        /* Built from the gateway's executions rather than kept by this app — the venue is the
         * one that knows what a fill realised on a contract. See projectxHistory.ts. */
        history: () => controller.history(),
        brackets: () => bracketsOf(opts.settings()),
        tick: () => controller.dealing.tickSize,
        /* The ladder. Everything it draws comes off the same controller the ticket reads, so
         * the two can never disagree about what is open. */
        ladder: {
            quote: () => controller.quote(),
            positions: () => controller.positions().map((p) => ({
                size: p.size, entryPrice: p.entryPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
            })),
            orders: () => controller.book().orders
                .filter((o) => o.price != null)
                .map((o) => ({ id: o.id, side: o.side, price: o.price!, size: o.size })),
            cancelOrder: (id) => guarded(ws, () => controller.cancelOrder(id)),
        },
        /* This gateway streams prints, so there is a tape to read. */
        tape: true,
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
        closePart: (size, id) => guarded(ws, () => controller.closePart(size, id)),
        reverse: (id) => guarded(ws, () => { guardReverse(id); controller.reverse(id); }),
        breakEven: (id) => guarded(ws, () => {
            controller.breakEven(id);
            ws.toast('Stop moved to the entry.', 'info');
        }),
        setTrailing: (distance, id) => guarded(ws, () => controller.setTrailing(distance, id)),
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
        beforeOrder: guardLimits,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
    off.push(wirePendingMenu({
        chart,
        sidebar,
        price: () => controller.price(),
        tick: () => controller.dealing.tickSize,
    }));
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    off.push(wireTradePreview({
        chart,
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    /* The drag gestures on the plot — where a stop and a target are set on an open position.
     * They land in `protect`, which on this venue means resting orders of their own. */
    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    /* The band that says which account this is. The shared one — a row of figures and a strip
     * of controls — given what only this venue can say: the name, because on a prop firm it is
     * the only thing separating an evaluation from a funded account, and a break-even button,
     * because this is the one venue where a stop is a resting order and moving it to the entry
     * is a move common enough to deserve a control of its own. */
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    if (!cell) console.warn('[midorii] no chart cell to mount the ProjectX account band into');
    const band = cell ? mountAccountBand({
        cell,
        name: controller.accountName,
        badge: controller.isLive ? 'Funded' : 'ProjectX',
        badgeTitle: controller.isLive
            ? 'Orders placed here go to a funded account. They are real orders.'
            : 'The gateway reports this account as simulated. On a prop firm that includes funded '
            + 'accounts settled in simulation — check the account name rather than this label.',
        live: controller.isLive,
        accent: PROJECTX_ACCENT,
        storageKey: 'midorii-band-projectx',
        columns: [
            {
                id: 'equity',
                label: 'Equity USD',
                title: 'The account balance the gateway states, with the open result added to it.',
                value: () => formatMoney(controller.equity()),
            },
            {
                id: 'position',
                label: 'Position',
                title: 'What is open right now, in contracts. Negative is short.',
                value: () => {
                    const held = controller.positions()[0]?.size ?? 0;
                    return held === 0 ? 'flat' : String(held);
                },
                tone: () => {
                    const held = controller.positions()[0]?.size ?? 0;
                    return held === 0 ? null : held > 0 ? 'up' : 'down';
                },
            },
            {
                id: 'open',
                label: 'Open P/L',
                title: 'Ticks moved times the value of a tick times the contracts held.',
                value: () => {
                    const position = controller.positions()[0];
                    return position ? formatMoney(position.unrealized) : '—';
                },
                tone: () => {
                    const open = controller.positions()[0]?.unrealized ?? 0;
                    return open === 0 ? null : open > 0 ? 'up' : 'down';
                },
            },
            {
                id: 'available',
                label: 'Balance',
                title: 'The balance on its own, before the open result is added to it.',
                value: () => formatMoney(controller.available()),
                optional: true,
            },
            {
                id: 'session',
                label: 'Session',
                title: 'What this session has realised — the same day the session limits are measured over.',
                value: () => formatMoney(sessionState(controller.history()).realised),
                tone: () => {
                    const realised = sessionState(controller.history()).realised;
                    return realised === 0 ? null : realised > 0 ? 'up' : 'down';
                },
                optional: true,
            },
            ...prop.columns,
        ],
        actions: [
            prop.action,
            {
                id: 'break-even',
                label: 'Break-even',
                /* Disabled with a reason rather than hidden — a button that vanishes leaves
                 * somebody hunting for it, and one that can always be pressed and then explains
                 * itself is worse. The controller is asked WHY, and the answer is the tooltip. */
                refusal: () => controller.breakEvenRefusal(),
                title: () => `Move the ${controller.ticker} stop to ${controller.positions()[0]?.entryPrice ?? 'the entry'}.`,
                run: () => guarded(ws, () => {
                    controller.breakEven();
                    ws.toast('Stop moved to the entry.', 'info');
                }),
            },
            {
                id: 'flatten',
                label: 'Close position',
                tone: 'danger' as const,
                arm: { label: 'Close — press again' },
                refusal: () => (controller.positions().length === 0 ? `No open ${controller.ticker} position.` : null),
                title: () => `Close the open ${controller.ticker} position at market.`,
                run: () => {
                    const position = controller.positions()[0];
                    if (position) guarded(ws, () => controller.closeOne(position.id));
                },
            },
        ],
        staleNote: () => {
            if (!controller.isStale()) return null;
            return controller.readAt() > 0
                ? `not answering · last ${new Date(controller.readAt()).toISOString().slice(11, 19)}`
                : 'not answering';
        },
    }) : null;
    off.push(() => band?.destroy());

    /* Buy / size / Sell on the plot. Brackets go out as DISTANCES: the gateway takes them in
     * ticks from the fill, which is a distance, and a level handed to it would have to be
     * measured against a fill price that does not exist yet. */
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            brackets: 'distance',
            tick: () => controller.dealing.tickSize,
            pointValue: () => controller.pointValue(),
            anchor: band?.el ?? null,
        })
        : null;
    off.push(() => quick?.destroy());

    function paint(): void {
        /* One reading, at the top, for everything below it: the band's figures and anything the
         * breach does are then the same answer rather than two walks of the same history. */
        prop.read();
        // The account line, from the closed trades the gateway reports — see accountStats.ts.
        dock.render(controller.book(), { stats: historyStats(controller.history(), controller.available()) });
        band?.refresh();
        /* Last, so whatever is about to be closed was on the screen first. Does nothing unless
         * this account is set to close out on a breach. */
        prop.enforce();
    }

    /* The keys. Every one of them is a button that is already on this screen — see hotkeys.ts
     * for why the two entry keys go through the panel rather than building an order. */
    off.push(installTradeHotkeys({
        root: ws.root,
        bindings: loadHotkeys,
        actions: {
            buy: () => sidebar.submit('buy'),
            sell: () => sidebar.submit('sell'),
            flatten: () => {
                for (const position of controller.positions()) guarded(ws, () => controller.closeOne(position.id));
            },
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
            breakEven: () => guarded(ws, () => {
                controller.breakEven();
                ws.toast('Stop moved to the entry.', 'info');
            }),
        },
    }));

    controller.onChange = () => {
        paint();
        sidebar.refresh();
        quick?.refresh();
    };
    off.push(chart.on('bar', (bar) => {
        controller.mark(bar.close);
        /* The ladder's session volume, folded from the same stream the chart is drawn from —
         * see priceLadder.ts for why it begins when the chart does rather than at the open. */
        sidebar.markVolume(bar.close, bar.volume ?? 0);
    }));

    /* The contract's own two-sided quote, straight from the gateway rather than off the bar.
     * Best effort and its own subscription: a feed that will not open leaves the ticket
     * showing the last price on both sides, which is what every other account here shows. */
    let quoteSubscription: string | null = null;
    const offQuotes = window.midori.projectx.onQuote((payload) => {
        if (payload.subscriptionId !== quoteSubscription) return;
        controller.markQuote(payload.quote.bid, payload.quote.ask);
    });
    window.midori.projectx.subscribeQuotes({ contractId: controller.contractId })
        .then((id) => { quoteSubscription = id; })
        .catch((err: unknown) => console.warn('[midorii] ProjectX quotes are not available for the ticket', err));
    off.push(() => {
        offQuotes();
        if (quoteSubscription) void window.midori.projectx.unsubscribeQuotes(quoteSubscription);
    });

    /* The tape. It rides the same hub subscription the quotes and the bars do, so it costs
     * nothing on the wire — what it adds is the prints themselves, aggressor side and all. */
    let printSubscription: string | null = null;
    const offPrints = window.midori.projectx.onPrints((payload) => {
        if (payload.subscriptionId !== printSubscription) return;
        sidebar.pushPrints(payload.prints.map((print) => ({
            time: Date.parse(print.timestamp),
            price: print.price,
            size: print.volume,
            // Measured rather than documented: `type` is the side that crossed the spread.
            side: print.type === 1 ? 'sell' : 'buy',
        })));
    });
    window.midori.projectx.subscribePrints({ contractId: controller.contractId })
        .then((id) => { printSubscription = id; })
        .catch((err: unknown) => console.warn('[midorii] ProjectX prints are not available for the tape', err));
    off.push(() => {
        offPrints();
        if (printSubscription) void window.midori.projectx.unsubscribePrints(printSubscription);
    });
    paint();
    controller.start();

    return {
        mllRoom: () => prop.last().room,
        unmount(): void {
            controller.stop();
            controller.onChange = null;
            for (const dispose of off) dispose();
            indicator.remove();
        },
    };
}
