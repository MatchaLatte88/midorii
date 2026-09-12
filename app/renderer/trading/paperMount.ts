import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { VelaWorkspace } from '../../../src/workspace';
import { mountAccountStrip } from '../replay/accountStrip';
import { mountQuickPanel } from '../replay/quickPanel';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionStyle } from './positionStyleSettings';
import { wireOrderEntry } from '../replay/replayOrders';
import { wirePositionLevels } from '../replay/replayLevels';
import { PaperController } from './PaperController';
import { catchUpLabel, fetchGapBars } from './paperCatchUp';
import { bracketsOf, limitsOf, riskOf, type PaperSettings } from './paperSettings';
import { limitRefusal, sessionState } from './riskLimits';
import { installTradeHotkeys, loadHotkeys } from './hotkeys';
import { tickSizeOf } from '../alerts/symbolTick';
import type { ThemeName, VelaTheme } from '../../../src';

/**
 * The trading half of the chart, put on and taken off again.
 *
 * Everything here already exists: the account card, the quick panel, the ticket and
 * the dock are the replay's own, and so are the two ways in through the chart itself
 * — a block right-clicked into an order, and a stop dragged to a new level. What is
 * new is only that they can be taken away again, because the chart's normal state is
 * a chart. Nothing of this is mounted while the Trade menu says Just Watching, and
 * `unmount` leaves the chart exactly as it found it.
 *
 * The feed
 * --------
 * The chart is already subscribed to the market; the account listens to the same
 * `bar` event rather than opening a second subscription of its own, so the price a
 * fill happens at is the price on the screen at that moment, by construction.
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

    // ── the ticket beside the plot ───────────────────────────────────────

    /**
     * The session limits, applied at the one place every way in passes through.
     *
     * Each gesture that can place an order calls this rather than carrying its own copy of
     * the rule. It refuses by throwing, so the reason reaches the person the same way every
     * other refusal does — and it only ever refuses an order that would ADD to what is on.
     */
    const guardLimits = (spec: { side: 'buy' | 'sell'; size: number }): void => {
        const refusal = limitRefusal(
            limitsOf(opts.settings()),
            sessionState(controller.history()),
            { net: controller.broker.netSize, side: spec.side, size: spec.size },
        );
        if (refusal) throw new Error(refusal);
    };

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => ({ equity: controller.broker.equity, price: controller.price() }),
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
        // Warm from the chart's own metadata — see alerts/symbolTick.ts.
        tick: () => tickSizeOf(controller.symbol) ?? null,
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
    /* The card anchors to the CELL: the renderer publishes the plot's own insets there
     * for host overlays, and it is already a positioning context. Without a cell —
     * which would mean Vela's shell had changed shape — nothing is mounted, since a
     * card floating in the wrong corner is worse than no card. */
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    // The words the Trade menu uses for this broker, so the card and the menu agree.
    const strip = cell
        ? mountAccountStrip(cell, {
            broker: 'Paper trading',
            brokerHint: 'Real prices, an account of this app\'s own. Nothing here reaches a venue.',
        })
        : null;
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => { guardLimits(spec); controller.order(spec); }),
            anchor: strip?.el ?? null,
        })
        : null;

    const guard = (run: () => void) => (): void => guarded(ws, run);
    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guard(() => controller.closeOne(id))(),
        closePart: (size, id) => guard(() => controller.closePart(size, id))(),
        reverse: (id) => guard(() => controller.reverse(id))(),
        breakEven: (id) => guard(() => controller.breakEven(id))(),
        protect: (levels, id) => guard(() => controller.protect(levels, id))(),
        setTrailing: (distance, id) => guard(() => controller.setTrailing(distance, {}, id))(),
        cancelOrder: (id) => guard(() => controller.cancelOrder(id))(),
        cancelAll: () => guard(() => controller.cancelAll())(),
        flatten: () => guard(() => controller.flatten())(),
    });

    const paint = (): void => {
        strip?.update(controller.account());
        /* The account's own line goes in with the book: what is open is only half of what a
         * person needs to see, and the other half — what this account has actually done —
         * has nowhere else to be read while it is still running. */
        dock.render(controller.book(), { stats: controller.stats() });
        // The ticket sizes against equity and the last price, so it moves with every tick.
        sidebar.refresh();
        quick?.refresh();
    };
    controller.onAccountChange = paint;
    paint();

    // ── the feed ─────────────────────────────────────────────────────────
    off.push(chart.on('bar', (bar) => controller.onBar(bar)));

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
        void resync();
    }));

    return {
        resync,
        unmount(): void {
            for (const dispose of off.splice(0)) dispose();
            controller.onAccountChange = null;
            quick?.destroy();
            strip?.destroy();
            strip?.el.remove();
            sidebar.dispose();
            sidebar.el.remove();
            dock.el.remove();
            indicator.remove();
        },
    };
}
