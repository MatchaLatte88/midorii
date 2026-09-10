import { applyThemeTokens, ensureUIHost, injectStyles } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import { mountTradeDock } from '../replay/tradeDock';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import type { VelaWorkspace } from '../../../src/workspace';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionLevels } from '../replay/replayLevels';
import { wireOrderEntry } from '../replay/replayOrders';
import { makeOverlayCard } from '../replay/overlayCards';
import { loadOverlayDisplay, onOverlayDisplayChange } from '../replay/overlayDisplay';
import { mountQuickPanel, type QuickPanel } from '../replay/quickPanel';
import { formatMoney } from '../format';
import type { CapitalController } from './CapitalController';
import type { LiveTradeRecord } from './CapitalController';
import { journalRows, loadJournal, recordTrade, settleEstimates } from './liveJournal';
import type { PaperSettings } from './paperSettings';
import { bracketsOf, riskOf } from './paperSettings';
import { tickSizeOf } from '../alerts/symbolTick';
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
.midorii-live {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    /* The last term is the room the restore button takes when it is on screen — see
       replay/overlayCards.ts. Zero the rest of the time, and ignored once the band is
       dragged. */
    right: calc(var(--vela-scale-gutter, 0px) + 10px + var(--midorii-overlay-inset, 0px));
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 7px 12px 8px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    user-select: none;
}
.midorii-live-badge {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}
.midorii-live-badge[data-live="1"] { background: var(--vela-danger); color: #fff; }
.midorii-live-badge[data-live="0"] {
    background: var(--vela-surface);
    border: 1px solid var(--vela-border);
    color: var(--vela-fg-muted);
}
.midorii-live-col { display: flex; flex-direction: column; gap: 1px; min-width: 68px; }
.midorii-live-label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-live-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    line-height: 1.25;
    color: var(--vela-fg-bright);
}
.midorii-live-flat {
    all: unset;
    padding: 5px 12px;
    border: 1px solid var(--vela-danger);
    border-radius: var(--vela-radius-md);
    font-size: var(--vela-font-size-md);
    color: var(--vela-danger);
    cursor: pointer;
}
.midorii-live-flat[disabled] { opacity: 0.4; cursor: default; }
/* Dimmed as one statement — every figure on it is equally out of date. The badge keeps its
   colour: which account this is does not become uncertain when the connection does. */
.midorii-live[data-stale="1"] .midorii-live-col { opacity: 0.4; }
.midorii-live-note {
    font-size: 10px;
    line-height: 1.3;
    color: var(--vela-fg-muted);
    max-width: 15ch;
}
.midorii-live-note.warn { color: var(--vela-danger); }

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

    const sidebar = mountTradeSidebar(opts.main, {
        account: () => ({
            equity: controller.equity(),
            price: controller.price(),
            available: controller.available(),
            marginFactor: controller.marginFactor(),
            /* The one account whose feed quotes two sides, so the one where the ticket's
             * header shows what a sell gets and what a buy costs rather than the same number
             * twice. Null until the first tick — the panel then shows the last price on both
             * halves, which is what every other account shows always. */
            ...(controller.quote() ?? {}),
        }),
        counts: () => ({ positions: controller.positions().length, orders: controller.orders().length }),
        actions: {
            order: (spec) => guarded(ws, () => controller.order(spec)),
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
     * The replay's own dock, on the venue's book. Four of its buttons are not offered here
     * and the dock does not draw them: taking half off, reversing, break-even and trailing
     * are things an ENGINE does to a position it owns, and this one belongs to Capital.com.
     * What is left — the stop, the target, closing, cancelling — is every instruction the
     * venue actually accepts, and each one goes through the same controller an order does. */
    const dock = mountTradeDock(opts.stack, {
        closePosition: (id) => guarded(ws, () => controller.closeOne(id)),
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
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));
    off.push(wirePositionLevels({
        chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    }));

    // ── the band that says which account this is ─────────────────────────
    injectStyles(STYLE_ID, CSS, doc);
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    const card = doc.createElement('div');
    card.className = 'midorii-live';

    const badge = doc.createElement('span');
    badge.className = 'midorii-live-badge';
    badge.dataset.live = opts.live ? '1' : '0';
    badge.textContent = opts.live ? 'Live money' : 'Demo';
    badge.title = opts.live
        ? 'Orders from this chart are real orders on a real account.'
        : 'Real prices, money that is not real. Set CAPITAL_ENV in .env.local to change which account this is.';

    const column = (label: string, title: string): { el: HTMLElement; label: HTMLElement; value: HTMLElement } => {
        const el = doc.createElement('div');
        el.className = 'midorii-live-col';
        const l = doc.createElement('span');
        l.className = 'midorii-live-label';
        l.textContent = label;
        l.title = title;
        const value = doc.createElement('span');
        value.className = 'midorii-live-value';
        value.textContent = '—';
        el.append(l, value);
        return { el, label: l, value };
    };

    const equity = column('Equity', 'What the venue says the account is worth — its figure, not a computed one. The label carries the currency the account itself is held in; an instrument quoting in another one books its results in that other money.');
    const free = column('Available', 'What is left to open something new with, after margin.');

    /* The way out. Two presses rather than one — it closes real positions at market — but
     * never more than two, and never behind a menu. */
    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.className = 'midorii-live-flat';
    flatten.textContent = 'Close all';
    flatten.disabled = true;
    let armed = false;
    const disarm = (): void => {
        armed = false;
        flatten.textContent = 'Close all';
    };
    flatten.onclick = () => {
        if (!armed) {
            armed = true;
            flatten.textContent = 'Close all — press again';
            return;
        }
        disarm();
        const open = controller.positions();
        if (open.length === 0) return;
        // One instruction per position: the venue has no "flatten" of its own, and the
        // order gate in the main process keeps them inside its rate limit.
        for (const position of open) guarded(ws, () => controller.closeOne(position.id));
    };
    flatten.onmouseleave = disarm;

    /* One line for the two things that make every figure beside it untrustworthy or
     * unusable: a market that is shut, and a connection that has stopped answering. */
    const note = doc.createElement('span');
    note.className = 'midorii-live-note';

    card.append(badge, equity.el, free.el, note, flatten);
    if (cell) cell.appendChild(card);
    else console.warn('[midorii] no chart cell to mount the live account band into');

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
    const overlay = cell ? makeOverlayCard(cell, card, {
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
        overlay.setAvailable(loadOverlayDisplay().showLive);
        off.push(onOverlayDisplayChange((display) => overlay.setAvailable(display.showLive)));
        off.push(() => overlay.destroy());
    }

    if (cell) {
        quick = mountQuickPanel(cell, {
            price: () => controller.price(),
            order: (spec) => guarded(ws, () => controller.order(spec)),
            /* The venue takes two prices and reads nothing else — a distance handed to it is
             * protection dropped on the way out. See `QuickProtection`. */
            brackets: 'levels',
            tick: () => tickSizeOf(opts.epic) ?? null,
            // Under the band, or under the one line the band leaves behind.
            anchor: () => (card.hidden ? mark : card),
        });
        off.push(() => quick?.destroy());
    }

    const paint = (): void => {
        /* No account line with it: that summary is a history of what has been done, and this
         * account keeps none here — the band above carries the two figures a venue answers
         * for. */
        dock.render(controller.book());
        /* The account's own money, named on the label. A CFD account holds one currency while
         * its instruments quote in others, so "4,821.55" is a figure and not yet an amount. */
        const ccy = controller.accountCurrency();
        equity.label.textContent = ccy ? `Equity ${ccy}` : 'Equity';
        equity.value.textContent = formatMoney(controller.equity());
        free.value.textContent = formatMoney(controller.available());
        const open = controller.positions().length;
        flatten.disabled = open === 0;
        flatten.title = open === 0
            ? 'Nothing is open.'
            : `Close ${open} open ${open === 1 ? 'position' : 'positions'} at market, now.`;
        if (open === 0) disarm();

        const stale = controller.isStale();
        card.dataset.stale = stale ? '1' : '0';
        const shut = !controller.tradeable();
        /* Staleness first: a market status read minutes ago is not news about the market, it
         * is another figure that has stopped being confirmed. */
        if (stale) {
            const at = controller.readAt();
            note.textContent = at > 0 ? `not answering · last ${new Date(at).toISOString().slice(11, 19)}` : 'not answering';
            note.classList.add('warn');
        } else if (shut) {
            note.textContent = controller.status() === 'CLOSED' ? 'market closed' : `market ${String(controller.status()).toLowerCase()}`;
            note.classList.add('warn');
        } else {
            note.textContent = '';
            note.classList.remove('warn');
        }
    };
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
    off.push(chart.on('bar', (bar) => controller.mark(bar.close)));

    controller.start();

    return {
        unmount(): void {
            controller.stop();
            controller.onChange = null;
            controller.onTradeClosed = null;
            for (const dispose of off) dispose();
            card.remove();
            mark.remove();
            indicator.remove();
        },
    };
}
