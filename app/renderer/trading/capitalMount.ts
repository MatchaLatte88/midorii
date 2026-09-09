import { applyThemeTokens, ensureUIHost, injectStyles } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import { mountTradeSidebar } from '../replay/tradeSidebar';
import type { VelaWorkspace } from '../../../src/workspace';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { wirePositionLevels } from '../replay/replayLevels';
import { wireOrderEntry } from '../replay/replayOrders';
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
 * brings — the dock, the ticket's History tab, the account's own statistics — all read a
 * TRADE HISTORY, and a venue does not hand one over: it reports what is open now. Rather than
 * filling those with computed stand-ins, they are left off, and what is here is only what the
 * venue actually answers for.
 *
 * What is always on screen
 * ------------------------
 * A band saying which account this is. Not a setting, not dismissible, and red when the money
 * is real — the difference between demo and live is one word in a file nobody looks at twice,
 * and the chart is where that word has consequences. Beside it the two figures a live account
 * is judged by (what it is worth, what is left to trade with) and the one control that must
 * never be more than one press away.
 */

const STYLE_ID = 'midorii-live';
const CSS = `
.midorii-live {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px);
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
/* The one card in the app that keeps the pointer: it carries the way out. */
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
`;

/** How often to ask whether the venue's ledgers have caught up with a reconstructed exit.
 *  Slow on purpose: they settle in minutes, and nothing here changes in between. */
const SETTLE_INTERVAL_MS = 5 * 60_000;

export interface CapitalMountOptions {
    workspace: VelaWorkspace;
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
    off.push(() => sidebar.el.remove());

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

    const paint = (): void => {
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
            indicator.remove();
        },
    };
}
