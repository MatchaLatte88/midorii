import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { VelaWorkspace } from '../../../src/workspace';
import { mountQuickPanel, type QuickPanel } from '../replay/quickPanel';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { makeOverlayCard } from '../replay/overlayCards';
import { wirePositionStyle } from './positionStyleSettings';
import { wireOrderEntry } from '../replay/replayOrders';
import { wirePendingMenu } from '../replay/chartPending';
import { wireTradePreview } from '../replay/chartPreview';
import { wirePositionLevels } from '../replay/replayLevels';
import { PaperController } from './PaperController';
import { catchUpLabel, fetchGapBars } from './paperCatchUp';
import { bracketsOf, riskOf, type PaperSettings } from './paperSettings';
import { sessionState } from './riskLimits';
import { flattenAll, wireProp } from './propBand';
import { PAPER_ACCOUNT_KEY } from './accountRules';
import { installTradeHotkeys, loadHotkeys } from './hotkeys';
import { mountAccountBand } from './accountBand';
import { tickSizeOf } from '../alerts/symbolTick';
import { formatMoney, formatPercent } from '../format';
import type { CapitalDealing } from '../providers/CapitalProvider';
import type { ProjectXDealing } from '../providers/ProjectXProvider';
import type { ThemeName, VelaTheme } from '../../../src';

/**
 * The trading half of the chart, put on and taken off again.
 *
 * Everything here already exists: the account band, the quick panel, the ticket and
 * the dock are the ones every traded chart gets, and so are the two ways in through the
 * chart itself — a block right-clicked into an order, and a stop dragged to a new level.
 * What is new is only that they can be taken away again, because the chart's normal state
 * is a chart. Nothing of this is mounted while the Trade menu says Just Watching, and
 * `unmount` leaves the chart exactly as it found it.
 *
 * The feed
 * --------
 * The chart is already subscribed to the market; the account listens to the same
 * `bar` event rather than opening a second subscription of its own, so the price a
 * fill happens at is the price on the screen at that moment, by construction.
 *
 * What the market brings with it
 * ------------------------------
 * On a market whose provider states more than candles, the account takes that too: a futures
 * contract's point value and size grid, the two sides of a quote a market order then fills
 * at, and the prints the tape shows. The same feeds the venue accounts read, so paper trading
 * a contract is paper trading it at the contract's own terms.
 */

/** How far back a fresh account looks for a price to stand on. Two bars of the finest
 *  timeframe there is — enough to find the last one even on a quiet market. */
const SEED_LOOKBACK_MS = 5 * 60_000;

export interface PaperMountOptions {
    workspace: VelaWorkspace;
    /** The column: the chart row on top, the dock beneath it. */
    stack: HTMLElement;
    /** The row: the chart, and the ticket beside it. */
    main: HTMLElement;
    controller: PaperController;
    /** Read fresh at every order — the settings dialog changes them mid-session. */
    settings: () => PaperSettings;
    /**
     * Put edited settings back where they came from.
     *
     * The ticket's quick sizes are settings a person edits from the ticket rather than from
     * the dialog — they are the sizes this account is traded in, and the place that question
     * comes up is while sizing a trade. They still belong in the one settings record, so
     * they go back through the one door that writes it.
     */
    onSettings: (next: PaperSettings) => void;
    /** The app's theme, for the one panel that sits OUTSIDE the chart's own root. */
    theme: ThemeName | VelaTheme;
}

export interface PaperMount {
    /** The latest room before the configured maximum-loss floor, or null with no floor. */
    mllRoom(): number | null;
    /** Fetch and play whatever the account missed, and put it on a price. Safe to call
     *  again — it re-reads where the account stands each time. */
    resync(): Promise<void>;
    /** Take the trading UI off the chart. The account itself is untouched. */
    unmount(): void;
}

/** Run an engine call and put its refusal in front of the person who asked for it. The
 *  engine's message is the message; there is nothing better to say than what it said. */
function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

/**
 * Put the trading UI on the live chart and wire it to `controller`.
 *
 * Mirrors what `replayBootstrap.mount` does for a replay, minus the transport and the
 * provider — the same panels, the same wirings, the same guard around every call into
 * the engine.
 */
export function mountPaperTrading(opts: PaperMountOptions): PaperMount {
    const { workspace: ws, controller } = opts;
    const chart = ws.chart;
    const off: Array<() => void> = [];

    // The account's own visuals: positions, their levels, and resting orders. Added
    // straight on the chart rather than through the widget context, so recomputed state
    // stays out of the undo timeline and out of the persisted indicator ledger.
    registerTradeIndicator();
    const indicator = chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
    controller.attachIndicator(indicator);
    // How those visuals look, and the Trading tab in the chart settings that says so.
    const styling = wirePositionStyle({ workspace: ws, indicator });
    off.push(styling.dispose);

    /** What the account's market brings with it — see the note at the top of this file. */
    let market: { tick: number | null; tape: boolean } = { tick: tickSizeOf(controller.symbol) ?? null, tape: false };

    // ── the ticket beside the plot ───────────────────────────────────────

    /* The paper account's own limits — the same rule set a funded account carries, under its
     * own key. Worth having here rather than only on a venue: a floor practised on paper is a
     * floor somebody has already met once before it costs them an account. See propBand.ts. */
    const prop = wireProp({
        account: PAPER_ACCOUNT_KEY,
        name: 'Paper account',
        host: ws.root,
        equity: () => controller.account().equity,
        /* The engine has watched every tick since the account opened, so it states the open
         * result itself — this is the one account here that never has to be asked twice. */
        openPnl: () => controller.account().open ?? 0,
        history: () => controller.history(),
        flatten: () => flattenAll(controller),
        notify: (message, kind) => ws.toast(message, kind),
        onChange: () => paint(),
    });

    /**
     * The limits, applied at the one place every way in passes through.
     *
     * Each gesture that can place an order calls this rather than carrying its own copy of
     * the rule. It refuses by throwing, so the reason reaches the person the same way every
     * other refusal does — and it only ever refuses an order that would ADD to what is on.
     */
    const guardLimits = (spec: { side: 'buy' | 'sell'; size: number }): void => {
        prop.guard({ net: controller.broker.netSize, side: spec.side, size: spec.size });
    };

    /* A reverse leaves the size where it was, so the guard above would wave it through — but it
     * ends one trade and opens another, and a session that may not open trades may not do that. */
    const guardReverse = (id: number): void => {
        const held = controller.broker.positionById(id)?.size ?? 0;
        prop.guard({ net: 0, side: held > 0 ? 'sell' : 'buy', size: Math.abs(held) });
    };

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => ({
            equity: controller.broker.equity,
            price: controller.price(),
            // What a point is worth and the grid a size lands on, where the market states them.
            pointValue: controller.pointValue(),
            ...controller.dealingRules(),
            ...(controller.quote() ?? {}),
        }),
        counts: () => {
            const book = controller.book();
            return { positions: book.positions.length, orders: book.orders.length };
        },
        actions: {
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            flatten: () => guarded(ws, () => controller.flatten()),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        risk: riskOf(opts.settings()),
        // What this account has already done, in the panel's own History tab.
        history: () => controller.history(),
        /* All three read the settings fresh rather than a copy taken at wiring time: they are
         * changed from the dialog while the panel is on screen, and a ticket bracketed by
         * last week's numbers is worse than one bracketed by none. */
        brackets: () => bracketsOf(opts.settings()),
        // The contract's own increment where the market states one; else warm from the
        // chart's metadata — see alerts/symbolTick.ts.
        tick: () => market.tick ?? tickSizeOf(controller.symbol) ?? null,
        /* The ladder, off the same engine the ticket reads, so the two cannot disagree about
         * what is open. */
        ladder: {
            quote: () => controller.quote(),
            positions: () => controller.broker.positions.map((p) => ({
                size: p.size, entryPrice: p.entryPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
            })),
            orders: () => controller.book().orders
                .filter((o) => o.price != null)
                .map((o) => ({ id: o.id, side: o.side, price: o.price!, size: o.size })),
            cancelOrder: (id) => guarded(ws, () => controller.cancelOrder(id)),
        },
        // Only on a market whose feed carries prints — asked again as the account moves.
        tape: () => market.tape,
        quickSizes: () => opts.settings().quickSizes,
        onQuickSizes: (next) => opts.onSettings({ ...opts.settings(), quickSizes: next }),
        sizing: () => opts.settings().sizingMode,
        onSizing: (next) => opts.onSettings({ ...opts.settings(), sizingMode: next }),
    });
    /* Its own kit host: the ticket is a sibling of the chart rather than a child, so the
     * theme variables the workspace writes on its own root do not reach it. */
    ensureUIHost(sidebar.el, resolveTheme(opts.theme));
    off.push(chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme)));

    // ── the two ways in through the chart itself ─────────────────────────
    off.push(wireOrderEntry({
        chart,
        controller,
        host: ws.root,
        // The dialog's risk settings, not the ticket's own copy: one account, one answer
        // to "how much may this lose", whichever hand places the trade.
        risk: () => riskOf(opts.settings()),
        beforeOrder: guardLimits,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
    off.push(wirePendingMenu({
        chart,
        sidebar,
        price: () => controller.price(),
        tick: () => market.tick ?? tickSizeOf(controller.symbol) ?? null,
    }));
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    off.push(wireTradePreview({
        chart,
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    const guard = (run: () => void) => (): void => guarded(ws, run);

    /* The keys — the same ones every traded chart here answers to. Break-even is the engine's
     * own, applied to whichever position is open. */
    off.push(installTradeHotkeys({
        root: ws.root,
        bindings: loadHotkeys,
        actions: {
            buy: () => sidebar.submit('buy'),
            sell: () => sidebar.submit('sell'),
            flatten: () => guard(() => controller.flatten())(),
            cancelAll: () => guard(() => controller.cancelAll())(),
            breakEven: () => guard(() => {
                const position = controller.broker.position;
                if (position) controller.breakEven(position.id);
            })(),
        },
    }));

    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // ── the account, on the chart and under it ───────────────────────────
    /* The band anchors to the CELL: the renderer publishes the plot's own insets there
     * for host overlays, and it is already a positioning context. Without a cell —
     * which would mean Vela's shell had changed shape — nothing is mounted, since a
     * band floating in the wrong corner is worse than no band. */
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    if (!cell) console.warn('[midorii] no chart cell to mount the paper account band into');
    const figures = () => controller.account();
    const tone = (value: number | null): 'up' | 'down' | null => (value == null || value === 0 ? null : value > 0 ? 'up' : 'down');
    const band = cell ? mountAccountBand({
        cell,
        // The words the Trade menu uses for this broker, so the band and the menu agree.
        badge: 'Paper',
        badgeTitle: 'Real prices, an account of this app\'s own. Nothing here reaches a venue.',
        live: false,
        storageKey: 'midorii-band-paper',
        columns: [
            {
                id: 'equity',
                label: 'Equity',
                title: 'The balance plus what is open, marked to the last price.',
                value: () => formatMoney(figures().equity),
            },
            {
                id: 'open',
                label: 'Open P/L',
                title: 'What is open is worth right now, before the costs of getting out.',
                value: () => {
                    const open = figures().open;
                    return open == null ? '—' : formatMoney(open);
                },
                tone: () => tone(figures().open),
            },
            {
                id: 'risk',
                label: 'At risk',
                title: 'What every stop would come to if all of them filled. A position without a stop '
                    + 'is counted beside it, not as zero.',
                value: () => {
                    const { risk, unprotected } = figures();
                    const text = risk == null ? '—' : formatMoney(risk);
                    return unprotected > 0 ? `${text} · ${unprotected} without stop` : text;
                },
            },
            {
                id: 'session',
                label: 'Session',
                title: 'What this session has realised — the same day the session limits are measured over.',
                value: () => formatMoney(sessionState(controller.history()).realised),
                tone: () => tone(sessionState(controller.history()).realised),
                optional: true,
            },
            {
                id: 'cash',
                label: 'Cash',
                title: 'Realised only: what would still be there if everything open closed at nothing.',
                value: () => formatMoney(figures().cash),
                optional: true,
            },
            {
                id: 'return',
                label: 'Return',
                title: 'Equity against the balance the account started with.',
                value: () => formatPercent(figures().returnPct, 2, true),
                tone: () => tone(figures().returnPct),
                optional: true,
            },
            ...prop.columns,
        ],
        actions: [
            prop.action,
            {
                id: 'break-even',
                label: 'Break-even',
                refusal: () => {
                    const position = controller.broker.position;
                    return position ? controller.broker.breakEvenRefusal(position) : 'Nothing is open.';
                },
                title: () => 'Move the stop to where the trade comes out flat after costs.',
                run: () => guarded(ws, () => {
                    const position = controller.broker.position;
                    if (position) controller.breakEven(position.id);
                }),
            },
            {
                id: 'flatten',
                label: 'Close all',
                tone: 'danger' as const,
                arm: { label: 'Close all — press again' },
                refusal: () => (controller.broker.positions.length === 0 ? 'Nothing is open.' : null),
                title: () => {
                    const open = controller.broker.positions.length;
                    return `Close ${open} open ${open === 1 ? 'position' : 'positions'} at market, now.`;
                },
                run: () => guarded(ws, () => controller.flatten()),
            },
        ],
        staleNote: () => controller.refusal,
    }) : null;

    let quick: QuickPanel | null = null;
    /* Draggable, closable and switchable off, in the seat the account card has always had. */
    const overlay = cell && band ? makeOverlayCard(cell, band.el, {
        id: 'account',
        onVisibility: () => quick?.reflow(),
    }) : null;
    if (overlay) {
        off.push(() => overlay.destroy());
    }

    if (cell) {
        quick = mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            tick: () => market.tick ?? tickSizeOf(controller.symbol) ?? null,
            pointValue: () => controller.pointValue(),
            anchor: () => (band == null || band.el.hidden ? null : band.el),
        });
    }

    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guard(() => controller.closeOne(id))(),
        closePart: (size, id) => guard(() => controller.closePart(size, id))(),
        reverse: (id) => guard(() => { guardReverse(id); controller.reverse(id); })(),
        breakEven: (id) => guard(() => controller.breakEven(id))(),
        protect: (levels, id) => guard(() => controller.protect(levels, id))(),
        setTrailing: (distance, id) => guard(() => controller.setTrailing(distance, {}, id))(),
        cancelOrder: (id) => guard(() => controller.cancelOrder(id))(),
        cancelAll: () => guard(() => controller.cancelAll())(),
        flatten: () => guard(() => controller.flatten())(),
    });

    function paint(): void {
        /* One reading, before the figures that show it — see the note in propBand.ts. */
        prop.read();
        band?.refresh();
        /* The account's own line goes in with the book: what is open is only half of what a
         * person needs to see, and the other half — what this account has actually done —
         * has nowhere else to be read while it is still running. */
        dock.render(controller.book(), { stats: controller.stats() });
        // The ticket sizes against equity and the last price, so it moves with every tick.
        sidebar.refresh();
        quick?.refresh();
        /* Last, so whatever is about to be closed was on the screen first. Does nothing unless
         * this account is set to close out on a breach. */
        prop.enforce();
    }
    controller.onAccountChange = paint;
    paint();

    // ── what the market brings with it ───────────────────────────────────

    let releaseMarket: (() => void) | null = null;
    /** Bumped on every wiring, so an answer that arrives after the market moved is dropped. */
    let wiring = 0;

    /**
     * Take on the dealing rules, the quote and the prints of the market the account is on.
     *
     * Each is best effort: a feed that will not open leaves the account trading the way it
     * does on a coin pair — last price, simulated spread, no tape. What is NOT best effort is
     * the point value: an account holding something refuses a new one, and says so.
     */
    const wireMarket = async (symbol: string): Promise<void> => {
        const token = ++wiring;
        releaseMarket?.();
        releaseMarket = null;
        market = { tick: tickSizeOf(symbol) ?? null, tape: false };
        sidebar.resetMarket();

        const resolved = chart.data.resolve(symbol);
        const info = await chart.data.symbolInfo(symbol).catch(() => undefined);
        if (token !== wiring) return;
        const dealing = (info as { dealing?: unknown } | undefined)?.dealing;
        const release: Array<() => void> = [];
        releaseMarket = () => { for (const dispose of release.splice(0)) dispose(); };

        try {
            if (resolved?.provider === 'projectx' && (dealing as ProjectXDealing | undefined)?.contractId) {
                const contract = dealing as ProjectXDealing;
                controller.setInstrument({
                    pointValue: contract.tickValue / contract.tickSize,
                    sizeStep: contract.sizeStep,
                    minSize: contract.minSize,
                });
                market = { tick: contract.tickSize, tape: true };
                release.push(subscribeProjectX(contract.contractId, token));
            } else if (resolved?.provider === 'capital') {
                /* No point value: a CFD unit's result is in the instrument's own currency, and a
                 * paper account has no currency of its own to convert it into — one is what it
                 * has always been measured in here. The size grid is the venue's own. */
                const rules = dealing as CapitalDealing | undefined;
                controller.setInstrument({ sizeStep: rules?.sizeIncrement, minSize: rules?.minSize });
                const provider = chart.data.providerInstance('capital') as
                    { subscribeQuotes?: (t: string, cb: (q: { bid: number; ask: number }) => void) => () => void } | undefined;
                if (typeof provider?.subscribeQuotes === 'function') {
                    release.push(provider.subscribeQuotes(resolved.ticker, (q) => controller.markQuote(q.bid, q.ask)));
                }
            } else {
                controller.setInstrument(null);
            }
        } catch (err: unknown) {
            ws.toast(err instanceof Error ? err.message : String(err), 'error');
        }
        paint();
    };

    /** The contract's quote and prints, from the same gateway hub the ProjectX account reads. */
    const subscribeProjectX = (contractId: string, token: number): (() => void) => {
        const api = window.midori.projectx;
        let quoteId: string | null = null;
        let printId: string | null = null;
        let released = false;
        const offQuote = api.onQuote((payload) => {
            if (payload.subscriptionId === quoteId) controller.markQuote(payload.quote.bid, payload.quote.ask);
        });
        const offPrints = api.onPrints((payload) => {
            if (payload.subscriptionId !== printId) return;
            sidebar.pushPrints(payload.prints.map((print) => ({
                time: Date.parse(print.timestamp),
                price: print.price,
                size: print.volume,
                // Measured rather than documented: `type` is the side that crossed the spread.
                side: print.type === 1 ? 'sell' as const : 'buy' as const,
            })));
        });
        api.subscribeQuotes({ contractId })
            .then((id) => { if (released || token !== wiring) void api.unsubscribeQuotes(id); else quoteId = id; })
            .catch((err: unknown) => console.warn('[midorii] ProjectX quotes are not available for the paper account', err));
        api.subscribePrints({ contractId })
            .then((id) => { if (released || token !== wiring) void api.unsubscribePrints(id); else printId = id; })
            .catch((err: unknown) => console.warn('[midorii] ProjectX prints are not available for the paper account', err));
        return () => {
            released = true;
            offQuote();
            offPrints();
            if (quoteId) void api.unsubscribeQuotes(quoteId);
            if (printId) void api.unsubscribePrints(printId);
        };
    };

    void wireMarket(controller.symbol);

    // ── the feed ─────────────────────────────────────────────────────────
    off.push(chart.on('bar', (bar) => {
        controller.onBar(bar);
        // The ladder's session volume, folded from the same stream the chart is drawn from.
        sidebar.markVolume(bar.close, bar.volume ?? 0);
    }));

    /** Where the account should be caught up from — the bar it stood in, or just
     *  enough of the recent past to find a price for a fresh one. */
    const resync = async (): Promise<void> => {
        const from = controller.session.barTime ?? Date.now() - SEED_LOOKBACK_MS;
        const before = controller.broker.trades.length;
        try {
            const { bars, timeframe } = await fetchGapBars(chart, controller.symbol, from);
            if (bars.length === 0) return;
            const played = controller.catchUp(bars);
            const closed = controller.broker.trades.length - before;
            /* Only worth saying when something actually happened while nobody was
             * looking. A fresh account catching up on the last two minutes has nothing
             * to report and should not open with a notice. */
            if (closed > 0) {
                ws.toast(
                    `Paper account caught up over ${played} ${catchUpLabel(timeframe)} bars — `
                    + `${closed} ${closed === 1 ? 'position' : 'positions'} closed while the app was away.`,
                    'info',
                );
            }
        } catch (err: unknown) {
            // An account that cannot be caught up still trades from here on; what it must
            // not do is pretend the gap did not happen.
            ws.toast(
                `Paper account could not be caught up: ${err instanceof Error ? err.message : String(err)}`,
                'error',
            );
        }
    };

    /* A market switch under a running account. A different SYMBOL is a different
     * instrument and the account only follows while it holds nothing; a different
     * timeframe is the same market seen differently, and only costs the account the bar
     * it was standing in. */
    off.push(chart.on('market:changed', ({ symbol, prev }) => {
        if (symbol === prev.symbol) {
            controller.rebase();
            return;
        }
        if (!controller.follow(symbol)) {
            ws.toast(controller.refusal ?? 'Paper trading stayed on its own market.', 'error');
            return;
        }
        void wireMarket(symbol);
        void resync();
    }));

    return {
        mllRoom: () => prop.last().room,
        resync,
        unmount(): void {
            wiring += 1;
            releaseMarket?.();
            releaseMarket = null;
            for (const dispose of off.splice(0)) dispose();
            controller.onAccountChange = null;
            quick?.destroy();
            band?.destroy();
            sidebar.dispose();
            sidebar.el.remove();
            dock.el.remove();
            indicator.remove();
        },
    };
}
