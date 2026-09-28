import { applyThemeTokens, ensureUIHost, injectStyles } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import type { VelaWorkspace } from '../../../src/workspace';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionLevels } from '../replay/replayLevels';
import { wireOrderEntry } from '../replay/replayOrders';
import { wirePendingMenu } from '../replay/chartPending';
import { wireTradePreview } from '../replay/chartPreview';
import { makeOverlayCard } from '../replay/overlayCards';
import { mountQuickPanel, type QuickPanel } from '../replay/quickPanel';
import { formatMoney } from '../format';
import type { CapitalController } from './CapitalController';
import type { LiveTradeRecord } from './CapitalController';
import { journalRows, loadJournal, recordTrade, settleEstimates } from './liveJournal';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';
import { sessionState } from './riskLimits';
import { flattenAll, wireProp } from './propBand';
import { mountAccountBand } from './accountBand';
import { installTradeHotkeys, loadHotkeys } from './hotkeys';
import { tickSizeOf } from '../alerts/symbolTick';
import { historyStats } from './accountStats';
import { wirePositionStyle } from './positionStyleSettings';
import type { ThemeName, VelaTheme } from '../../../src';

/**
 * The live account, put on the chart and taken off again.
 *
 * The counterpart of `paperMount`, and deliberately less than it. The panels a paper account
 * brings that read a TRADE HISTORY — the ticket's History tab, the account's own statistics —
 * are left off, because a venue does not hand one over: it reports what is open now. Rather
 * than filling those with computed stand-ins, what is here is only what the venue actually
 * answers for. The dock is here, since what is open now is exactly what it lists — minus the
 * four buttons that need an engine behind them, which this account has none of.
 *
 * What is always on screen
 * ------------------------
 * A band saying which account this is, red when the money is real — the difference between
 * demo and live is one word in a file nobody looks at twice, and the chart is where that word
 * has consequences. Beside it the two figures a live account is judged by (what it is worth,
 * what is left to trade with) and the one control that must never be more than one press away.
 *
 * It moves and it closes, like the other cards on the chart — but not all of it goes. What a
 * band like this is FOR is the one word that says whose money this is, and that word is true
 * whether or not somebody wants a band on their chart, so it stays behind as a line of small
 * caps in the same corner: quiet on a demo account, red on a real one. What leaves with the
 * band is the two figures and Close all, and both have another door (the panel beside the
 * chart flattens; the Trade menu names the account). The restore button in the corner brings
 * the whole thing back.
 */

const STYLE_ID = 'midorii-live';
const CSS = `
/* What is left of the band once it is put away: the one thing on it that is true whether or
   not anybody wants a band on their chart. Quiet in size and loud only in colour — a line of
   small caps in the corner is not in the way of reading a chart, and on a real account it is
   the difference between knowing and assuming. */
.midorii-live-mark {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px + var(--midorii-overlay-inset, 0px));
    z-index: 5;
    /* The height of the buttons it stands beside, so the words sit on their centre line
       rather than on their top edge. */
    height: 24px;
    display: flex;
    align-items: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--vela-fg-faint);
    user-select: none;
    cursor: default;
}
.midorii-live-mark[data-live="1"] { color: var(--vela-danger); }
`;

/** How often to ask whether the venue's ledgers have caught up with a reconstructed exit.
 *  Slow on purpose: they settle in minutes, and nothing here changes in between. */
const SETTLE_INTERVAL_MS = 5 * 60_000;

export interface CapitalMountOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    /** The row the chart lives in. */
    main: HTMLElement;
    controller: CapitalController;
    /** Which account this is, as the trade menu keys it — `capital:live` or `capital:demo`.
     *  The limits and the trailing mark are kept under it, so the two sides keep their own. */
    accountKey: string;
    /** Read fresh at every order — the settings dialog changes them mid-session. */
    settings: () => PaperSettings;
    /** Put edited settings back where they came from — see the paper mount's own note. */
    onSettings: (next: PaperSettings) => void;
    /** Whether this is the real-money account. */
    live: boolean;
    /** The instrument being traded, for the quote subscription. */
    epic: string;
    /** The app's palette, read fresh — the ticket sits outside the chart's own root. */
    theme: ThemeName | VelaTheme;
}

export interface CapitalMount {
    /** Figures already reconciled by this mount's rule and journal wiring. */
    summary(): { mllRoom: number | null; realised: number };
    /** Take the live trading UI off the chart. The account itself is untouched. */
    unmount(): void;
}

/** Run an engine call and put its refusal in front of the person who asked for it. */
function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

export function mountCapitalTrading(opts: CapitalMountOptions): CapitalMount {
    const { workspace: ws, controller } = opts;
    const chart = ws.chart;
    const doc = ws.root.ownerDocument;
    const off: Array<() => void> = [];

    // The account's own visuals — the same indicator a replay and a paper account draw with.
    registerTradeIndicator();
    const indicator = chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
    controller.attachIndicator(indicator);
    // How positions are drawn, and the Trading tab in the chart settings that says so.
    off.push(wirePositionStyle({ workspace: ws, indicator }).dispose);

    /* ── the ticket beside the plot ──────────────────────────────────────
     *
     * The same panel a paper account gets, minus its History tab: `history` is optional
     * precisely so an account that keeps none does not offer an empty one, and a venue keeps
     * none — it reports what is open, not what has been. The two figures it needs that a
     * paper account has no notion of are the margin ones, and they come straight from the
     * venue rather than from the leverage setting. */
    /* What this account has already done. Midorii's own record rather than the venue's —
     * see liveJournal.ts for why. Filled in just below, once the panel showing it exists. */
    let journal: LiveTradeRecord[] = [];


    /* This account's own limits — the floor under it, its daily limit, its goal — and the
     * figures for the band. Kept under the account's key, so the demo and the live side do not
     * share one set of numbers. See propBand.ts. */
    const prop = wireProp({
        account: opts.accountKey,
        name: opts.live ? 'Capital.com — live money' : 'Capital.com — demo',
        host: ws.root,
        currency: () => controller.accountCurrency(),
        equity: () => controller.equity(),
        /* The venue states the balance with the open result already inside it, so the open part
         * is the positions' own — which is what makes the daily limit count a trade still on. */
        openPnl: () => controller.positions().reduce((sum, p) => sum + p.upl, 0),
        history: () => journalRows(journal),
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
        prop.guard({
            net: controller.positions().reduce((sum, p) => sum + p.size, 0),
            side: spec.side,
            size: spec.size,
        });
    };

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => {
            const pointValue = controller.pointValue();
            return {
            equity: controller.equity(),
            price: controller.price(),
            available: controller.available(),
            marginFactor: controller.marginFactor(),
            /* The one account whose feed quotes two sides, so the one where the ticket's
             * header shows what a sell gets and what a buy costs rather than the same number
             * twice. Null until the first tick — the panel then shows the last price on both
             * halves, which is what every other account shows always. */
            ...(controller.quote() ?? {}),
            /* The grid a size has to land on, so the figure on the ticket is the figure that
             * goes out — this venue refuses anything off its increment, and the ticket used to
             * show a size the controller then quietly rounded on the way past. */
            ...(controller.dealingRules() ?? {}),
            /* What a point is worth, where the venue's own figures can say it — see
             * `CapitalController.pointValue`. Passed only when it is KNOWN: absent means one,
             * which is what every figure here assumed before, so an instrument whose factor
             * cannot be stated honestly is left exactly as it was rather than guessed at. */
            ...(pointValue != null ? { pointValue } : {}),
            };
        },
        counts: () => ({ positions: controller.positions().length, orders: controller.orders().length }),
        actions: {
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            flatten: () => guarded(ws, () => {
                for (const p of controller.positions()) controller.closeOne(p.id);
            }),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        risk: riskOf(opts.settings()),
        history: () => journalRows(journal),
        brackets: () => bracketsOf(opts.settings()),
        // The venue's own increment for this instrument — see alerts/symbolTick.ts.
        tick: () => tickSizeOf(opts.epic) ?? null,
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
        quickSizes: () => opts.settings().quickSizes,
        onQuickSizes: (next) => opts.onSettings({ ...opts.settings(), quickSizes: next }),
        sizing: () => opts.settings().sizingMode,
        onSizing: (next) => opts.onSettings({ ...opts.settings(), sizingMode: next }),
    });
    /**
     * Turn reconstructed exits into facts, whenever the venue's ledgers have caught up.
     *
     * A closure noticed between two reads is recorded with an estimated exit and no idea of
     * financing or commission; the venue's history knows all of it a few minutes later. Run
     * on arrival and then on a slow beat — the ledgers are not immediate, and there is
     * nothing here worth asking about every few seconds.
     */
    const settle = async (): Promise<void> => {
        const settled = await settleEstimates(journal);
        if (settled === 0) return;
        journal = await loadJournal();
        sidebar.refresh();
    };

    void loadJournal().then((trades) => {
        journal = trades;
        sidebar.refresh();
        return settle();
    }).catch((err: unknown) => console.error('[midorii] the live journal could not be opened', err));

    const settleTimer = setInterval(() => void settle().catch(() => {}), SETTLE_INTERVAL_MS);
    off.push(() => clearInterval(settleTimer));

    /**
     * Every trade that ends goes on the record, whoever ended it.
     *
     * Written before it is shown: the file is the record, and a list that had the trade while
     * the journal did not would be the wrong one to believe. A write that fails is said out
     * loud rather than logged — everything else in this app can be recomputed, and this
     * cannot.
     */
    controller.onTradeClosed = (trade): void => {
        void recordTrade(trade)
            .then((added) => {
                if (!added) return; // already on record — two reads noticed the same closure
                journal = [trade, ...journal];
                sidebar.refresh();
                // The ledgers lag the closure; one delayed look usually catches it, and the
                // slow beat above catches whatever it does not.
                if (trade.estimated) setTimeout(() => void settle().catch(() => {}), 30_000);
            })
            .catch((err: unknown) => {
                ws.toast(
                    `A closed trade could not be written to the journal: ${err instanceof Error ? err.message : String(err)}`,
                    'error',
                );
            });
    };

    /* Its own kit host: the ticket is a sibling of the chart rather than a child, so the
     * theme variables the workspace writes on its own root do not reach it. */
    ensureUIHost(sidebar.el, resolveTheme(opts.theme));
    off.push(chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme)));
    off.push(() => {
        sidebar.dispose();
        sidebar.el.remove();
    });

    /* ── what is open, under the chart ────────────────────────────────────
     *
     * The replay's own dock, on the venue's book. Two of its buttons are not offered here and
     * the dock does not draw them: the venue's API has no partial close, and a reverse would
     * be a close and an open as two instructions, of which the second can be refused after the
     * first has filled. Break-even and the trail are the venue's own and go through the same
     * controller an order does. */
    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guarded(ws, () => controller.closeOne(id)),
        breakEven: (id) => guarded(ws, () => controller.breakEven(id)),
        setTrailing: (distance, id) => guarded(ws, () => controller.setTrailing(distance, id)),
        protect: (levels, id) => guarded(ws, () => controller.protect(levels, id)),
        cancelOrder: (id) => guarded(ws, () => controller.cancelOrder(id)),
        cancelAll: () => guarded(ws, () => controller.cancelAll()),
        // One instruction per position: the venue has no "flatten" of its own, exactly as
        // the card's own Close all does it.
        flatten: () => {
            for (const position of controller.positions()) guarded(ws, () => controller.closeOne(position.id));
        },
    });
    off.push(() => dock.el.remove());

    // ── the two ways in through the chart itself ─────────────────────────
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
        tick: () => tickSizeOf(opts.epic) ?? null,
    }));
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    off.push(wireTradePreview({
        chart,
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    /* The keys — the same ones every traded chart here answers to. Break-even applies to the
     * first open position, as it does on the other accounts. */
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
            breakEven: () => guarded(ws, () => controller.breakEven()),
        },
    }));

    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // ── the band that says which account this is ─────────────────────────
    injectStyles(STYLE_ID, CSS, doc);
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    if (!cell) console.warn('[midorii] no chart cell to mount the live account band into');
    const badgeTitle = opts.live
        ? 'Orders from this chart are real orders on a real account.'
        : 'Real prices, money that is not real. The Trade menu switches to the live account.';

    const band = cell ? mountAccountBand({
        cell,
        badge: opts.live ? 'Live money' : 'Demo',
        badgeTitle: badgeTitle,
        live: opts.live,
        storageKey: 'midorii-band-capital',
        columns: [
            {
                id: 'equity',
                /* The account's own money, named on the label. A CFD account holds one currency
                 * while its instruments quote in others, so "4,821.55" is a figure and not yet
                 * an amount. */
                label: () => {
                    const ccy = controller.accountCurrency();
                    return ccy ? `Equity ${ccy}` : 'Equity';
                },
                title: 'What the venue says the account is worth — its figure, not a computed one. '
                    + 'The label carries the currency the account itself is held in; an instrument '
                    + 'quoting in another one books its results in that other money.',
                value: () => formatMoney(controller.equity()),
            },
            {
                id: 'available',
                label: 'Available',
                title: 'What is left to open something new with, after margin.',
                value: () => formatMoney(controller.available()),
            },
            {
                id: 'open',
                label: 'Open P/L',
                title: 'What the venue says the open positions are worth right now — its own figure.',
                value: () => {
                    const open = controller.positions();
                    if (open.length === 0) return '—';
                    return formatMoney(open.reduce((sum, p) => sum + p.upl, 0));
                },
                tone: () => {
                    const total = controller.positions().reduce((sum, p) => sum + p.upl, 0);
                    return total === 0 ? null : total > 0 ? 'up' : 'down';
                },
                optional: true,
            },
            {
                id: 'session',
                label: 'Session',
                title: 'What this session has realised — the same day the session limits are measured over.',
                value: () => formatMoney(sessionState(journalRows(journal)).realised),
                tone: () => {
                    const realised = sessionState(journalRows(journal)).realised;
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
                refusal: () => controller.breakEvenRefusal(),
                title: () => `Move the stop to ${controller.positions()[0]?.entryPrice ?? 'the entry'}.`,
                run: () => guarded(ws, () => controller.breakEven()),
            },
            {
                id: 'flatten',
                label: 'Close all',
                tone: 'danger' as const,
                /* Two presses rather than one — it closes real positions at market — but never
                 * more than two, and never behind a menu. */
                arm: { label: 'Close all — press again' },
                refusal: () => (controller.positions().length === 0 ? 'Nothing is open.' : null),
                title: () => {
                    const open = controller.positions().length;
                    return `Close ${open} open ${open === 1 ? 'position' : 'positions'} at market, now.`;
                },
                run: () => {
                    /* One instruction per position: the venue has no "flatten" of its own, and
                     * the order gate in the main process keeps them inside its rate limit. */
                    for (const position of controller.positions()) guarded(ws, () => controller.closeOne(position.id));
                },
            },
        ],
        /* One line for the two things that make every figure beside it untrustworthy or
         * unusable: a connection that has stopped answering, and a market that is shut.
         * Staleness first — a market status read minutes ago is not news about the market, it
         * is another figure that has stopped being confirmed. */
        staleNote: () => {
            if (controller.isStale()) {
                const at = controller.readAt();
                return at > 0 ? `not answering · last ${new Date(at).toISOString().slice(11, 19)}` : 'not answering';
            }
            if (!controller.tradeable()) {
                return controller.status() === 'CLOSED' ? 'market closed' : `market ${String(controller.status()).toLowerCase()}`;
            }
            return null;
        },
    }) : null;
    const card = band?.el ?? null;
    /* Which account this is, in one word, for when the band is not on the chart. It is not a
     * smaller band and does not try to be: no figures, no controls, nothing to press — just
     * the fact that would otherwise leave with the band. */
    const mark = doc.createElement('div');
    mark.className = 'midorii-live-mark';
    mark.dataset.live = opts.live ? '1' : '0';
    mark.textContent = opts.live ? 'Live money' : 'Demo';
    mark.title = opts.live
        ? 'Orders from this chart are real orders on a real account. The account band is put '
            + 'away — bring it back from the corner, or from Settings → Customization.'
        : 'Real prices, money that is not real. The account band is put away — bring it back '
            + 'from the corner, or from Settings → Customization.';
    mark.hidden = true;
    if (cell) cell.appendChild(mark);

    /* Buy / size / Sell on the plot, the same panel a replay and a paper account get — see
     * `quickPanel.ts`. Declared before the band's own card so that card can tell it to move
     * when the band goes away and the mark takes its place. */
    let quick: QuickPanel | null = null;

    /* Draggable, closable, and switchable off — see the note at the top of this file for what
     * closing a LIVE account's band costs, and what the mark above keeps hold of. No `place`
     * of its own: with nothing dragged the CSS holds it in the corner. */
    const overlay = cell && card ? makeOverlayCard(cell, card, {
        id: 'live',
        onVisibility: (visible) => {
            mark.hidden = visible;
            /* The panel below sits under whichever of the two is in the corner, and neither
             * a band switched to display:none nor the mark appearing is a resize anything
             * would hear about. */
            quick?.reflow();
        },
    }) : null;
    if (overlay) {
        off.push(() => overlay.destroy());
    }

    if (cell) {
        quick = mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            /* The venue takes two prices and reads nothing else — a distance handed to it is
             * protection dropped on the way out. See `QuickProtection`. */
            brackets: 'levels',
            tick: () => tickSizeOf(opts.epic) ?? null,
            // Under the band, or under the one line the band leaves behind.
            anchor: () => (card == null || card.hidden ? mark : card),
        });
        off.push(() => quick?.destroy());
    }

    function paint(): void {
        /* One reading, at the top, for everything below it — see the note in propBand.ts. */
        prop.read();
        /* The account line, from the journal — the one record of what this account has done
         * that this app keeps. Measured against the balance without what is open. */
        const realised = controller.equity() - controller.positions().reduce((sum, p) => sum + p.upl, 0);
        dock.render(controller.book(), { stats: historyStats(journalRows(journal), realised) });
        band?.refresh();
        /* Last, so whatever is about to be closed was on the screen first. Does nothing unless
         * this account is set to close out on a breach. */
        prop.enforce();
    }
    controller.onChange = (): void => {
        paint();
        sidebar.refresh();
        quick?.refresh();
    };
    paint();

    /* The two-sided price, straight from the venue's quote stream.
     *
     * The candle feed carries the bid alone, and a plan measured against it is wrong by the
     * whole spread on one side. The stream carries both. The candle close still comes through
     * as a fallback for the moments before the first tick lands — better a one-sided price
     * than none, as long as nothing pretends otherwise. */
    const provider = chart.data.providerInstance('capital') as
        { subscribeQuotes?: (t: string, cb: (q: { bid: number; ask: number }) => void) => () => void } | undefined;
    if (typeof provider?.subscribeQuotes === 'function') {
        off.push(provider.subscribeQuotes(opts.epic, (q) => controller.markQuote(q.bid, q.ask)));
    }
    off.push(chart.on('bar', (bar) => {
        controller.mark(bar.close);
        sidebar.markVolume(bar.close, bar.volume ?? 0);
    }));

    controller.start();

    return {
        summary: () => ({
            mllRoom: prop.last().room,
            realised: journalRows(journal).reduce((sum, row) => sum + row.netPnl, 0),
        }),
        unmount(): void {
            controller.stop();
            controller.onChange = null;
            controller.onTradeClosed = null;
            for (const dispose of off) dispose();
            band?.destroy();
            mark.remove();
            indicator.remove();
        },
    };
}
