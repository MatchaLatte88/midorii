import { applyThemeTokens, ensureUIHost, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { ThemeName, VelaTheme } from '../../../src';
import type { DataProvider } from '../../../src/plugin';
import { VelaWorkspace } from '../../../src/workspace';
import { BRAND } from '../about/brand';
import { formatMoney, formatSignedMoney } from '../format';
import { mountAccountStrip, type AccountStrip } from '../replay/accountStrip';
import type { AccountFigures } from '../replay/accountFigures';
import { mountTradeDock, type TradeDock } from '../replay/tradeDock';
import { TRADE_INDICATOR_TYPE, registerTradeIndicator } from '../replay/replayIndicator';
import { button, ensureFigureStyles } from '../runs/runViews';
import { STRATEGIES } from '../strategies';
import { BotEngine } from './BotEngine';
import { setBotChart } from './botChart';
import type { BotRunner } from './BotRunner';
import { mountBotForm, type BotForm } from './botForm';
import { newBot, type BotConfig } from './botTypes';
import { botTape } from './botTape';

/**
 * The Trading Bot tab: the chart's own trading screen, run by a strategy instead of by a
 * hand.
 *
 * Everything on it already exists somewhere else, on purpose. The chart is a Vela
 * workspace, the account card and the position dock are the replay's, the position lines
 * are the same native indicator the paper account draws through. That is what makes this a
 * screen somebody can trust: a bot's position looks exactly like a hand-placed one, on the
 * same chart, drawn by the same code, because it IS one.
 *
 * What is not copied from the Chart tab is the ways IN. There is no ticket, no quick panel,
 * no right-click-to-order, and the dock's own buttons stay — a person can always close what
 * a bot opened, and never through this screen open something a strategy did not ask for.
 * The asymmetry is the point: a bot screen where a slip of the hand places a trade is a bot
 * screen that lies about who traded.
 *
 * One chart, whichever bot is selected
 * ------------------------------------
 * Rather than a workspace per bot. A bot does not need a chart to run — it has its own feed
 * and its own account and neither of them is on screen — so a chart per bot would be four
 * live subscriptions kept open to draw three charts nobody is looking at. The one chart
 * follows the selection.
 */

const STYLE_ID = 'midorii-bot';
const CSS = `
.midorii-bot {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-bot-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    height: 34px; padding: 0 14px;
    border-bottom: 1px solid var(--vela-border);
    font-size: 12px; color: var(--vela-fg-muted);
}
.midorii-bot-bar-spacer { flex: 1 1 auto; }
.midorii-bot-main { flex: 1 1 auto; min-height: 0; display: flex; }

.midorii-bot-list {
    flex: none; width: 240px; padding: 8px;
    border-right: 1px solid var(--vela-border);
    overflow: auto;
}
${overlayScrollbarCss('.midorii-bot-list')}
.midorii-bot-item {
    all: unset;
    display: block; box-sizing: border-box; width: 100%;
    padding: 8px 10px; margin-bottom: 3px;
    border-radius: var(--vela-radius-sm);
    cursor: pointer;
}
.midorii-bot-item:hover { background: var(--vela-hover); }
.midorii-bot-item[data-active='1'] { background: var(--vela-active); }
.midorii-bot-item-head { display: flex; align-items: center; gap: 6px; }
.midorii-bot-item b { flex: 1 1 auto; font-size: 13px; font-weight: 600; color: var(--vela-fg-bright);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-item span { display: block; margin-top: 2px; font-size: 11.5px; color: var(--vela-fg-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--vela-fg-faint); }
.midorii-bot-dot[data-state='running'] { background: var(--vela-up, #089981); }
.midorii-bot-dot[data-state='starting'] { background: var(--vela-warning, #d9822b); }
.midorii-bot-dot[data-state='failed'] { background: var(--vela-danger, #f23645); }

.midorii-bot-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.midorii-bot-head {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--vela-border);
}
.midorii-bot-title { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.midorii-bot-title b { font-size: 14px; font-weight: 600; color: var(--vela-fg-bright);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.midorii-bot-title span { font-size: 11.5px; color: var(--vela-fg-muted); }
.midorii-bot-title span[data-error='1'] { color: var(--vela-danger); }

.midorii-bot-tabs { display: inline-flex; flex: none; gap: 2px; }
.midorii-bot-tab {
    all: unset;
    padding: 4px 12px; border-radius: var(--vela-radius-sm);
    font-size: 12px; font-weight: 600; color: var(--vela-fg-muted); cursor: pointer;
}
.midorii-bot-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-bot-tab[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }

.midorii-bot-pane { flex: 1 1 auto; min-height: 0; position: relative; }
.midorii-bot-pane[hidden] { display: none; }
.midorii-bot-settings { position: absolute; inset: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-bot-settings')}
.midorii-bot-settings-inner { max-width: 900px; margin: 0 auto; padding: 16px 18px 32px; }

/* The live pane: chart on top, then the dock, then the tape. */
.midorii-bot-live { position: absolute; inset: 0; display: flex; flex-direction: column; }
.midorii-bot-chart { flex: 1 1 auto; min-height: 0; position: relative; }
.midorii-bot-tape {
    flex: 0 0 auto; height: 150px; min-height: 0;
    border-top: 1px solid var(--vela-border);
    background: var(--vela-surface);
    overflow: auto;
}
${overlayScrollbarCss('.midorii-bot-tape')}

.midorii-bot-empty { padding: 28px 20px; color: var(--vela-fg-muted); line-height: 1.65; max-width: 620px; }
.midorii-bot-empty h2 { margin: 0 0 8px; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-bot-empty p { margin: 0 0 10px; }

.midorii-bot-figs { display: inline-flex; align-items: center; gap: 14px; flex: none; font-size: 12px; }
.midorii-bot-fig { display: inline-flex; flex-direction: column; line-height: 1.3; }
.midorii-bot-fig small { font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vela-fg-faint); }
.midorii-bot-fig b { font-weight: 600; color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; }
.midorii-bot-fig b.up { color: var(--vela-up, #089981); }
.midorii-bot-fig b.down { color: var(--vela-down, #f23645); }
`;

/** Which half of a bot's screen is showing. */
type Pane = 'live' | 'settings';

/**
 * What the account card reads while no bot is running.
 *
 * `open` and `risk` are null rather than zero, which is the same distinction the figures
 * themselves make: an account holding nothing is not breaking even on it, and it does not
 * have zero at stake — there is nothing to have an amount of.
 */
const EMPTY_ACCOUNT: AccountFigures = {
    equity: 0,
    cash: 0,
    initialBalance: 0,
    returnPct: 0,
    open: null,
    risk: null,
    unprotected: 0,
    netSize: 0,
    openPositions: 0,
};

export interface BotViewOptions {
    /** Every market source the app can reach — the bots build their own instances. */
    providers: Record<string, () => DataProvider>;
    /** The app's palette, read fresh: this view builds a chart of its own. */
    theme: () => ThemeName | VelaTheme;
    /** How something that happened without a click reaches a person. */
    notify: (message: string, kind: 'info' | 'error' | 'success') => void;
}

export interface BotViewHandle {
    /** Re-read the stored bots and repaint. Called whenever the tab is opened. */
    refresh(): Promise<void>;
    /** Dress the view's own chart in the app's current palette. */
    setTheme(theme: VelaTheme): void;
    /** The engine, so the app can resume bots at startup and stop them at shutdown. */
    readonly engine: BotEngine;
}

/** Mount the Trading Bot tab into `host`. */
export function mountBotView(host: HTMLElement, opts: BotViewOptions): BotViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);
    registerTradeIndicator();

    let capitalConfigured = false;
    void window.midori.capital.environment()
        .then((env) => { capitalConfigured = env.configured; paint(); })
        .catch((err: unknown) => console.error('[midorii] could not read the Capital.com environment', err));

    const engine = new BotEngine({
        providers: opts.providers,
        live: () => liveCredentials,
        onChange: () => schedulePaint(),
        notify: opts.notify,
    });
    let liveCredentials = false;
    void window.midori.capital.environment()
        .then((env) => { liveCredentials = env.live; })
        .catch(() => undefined);

    let selected = '';
    let pane: Pane = 'live';
    let form: BotForm | null = null;
    /** Which bot the form is currently pointed at, so it is only rebuilt on a real change. */
    let formFor = '';

    /* ── the frame ───────────────────────────────────────────────────────── */

    const root = doc.createElement('div');
    root.className = 'midorii-bot midorii-figures';

    const bar = doc.createElement('div');
    bar.className = 'midorii-bot-bar';
    const barLabel = doc.createElement('span');
    const barSpacer = doc.createElement('span');
    barSpacer.className = 'midorii-bot-bar-spacer';
    const addButton = button('New bot', 'primary');
    addButton.onclick = () => void createBot();
    bar.append(barLabel, barSpacer, addButton);

    const main = doc.createElement('div');
    main.className = 'midorii-bot-main';

    const list = doc.createElement('div');
    list.className = 'midorii-bot-list';

    const body = doc.createElement('div');
    body.className = 'midorii-bot-body';

    const head = doc.createElement('div');
    head.className = 'midorii-bot-head';

    const livePane = doc.createElement('div');
    livePane.className = 'midorii-bot-pane';
    const liveStack = doc.createElement('div');
    liveStack.className = 'midorii-bot-live';
    const chartHost = doc.createElement('div');
    chartHost.className = 'midorii-bot-chart';
    const tapeHost = doc.createElement('div');
    tapeHost.className = 'midorii-bot-tape';
    liveStack.append(chartHost, tapeHost);
    livePane.appendChild(liveStack);

    const settingsPane = doc.createElement('div');
    settingsPane.className = 'midorii-bot-pane';
    const settingsScroll = doc.createElement('div');
    settingsScroll.className = 'midorii-bot-settings';
    const settingsInner = doc.createElement('div');
    settingsInner.className = 'midorii-bot-settings-inner';
    settingsScroll.appendChild(settingsInner);
    settingsPane.appendChild(settingsScroll);

    body.append(head, livePane, settingsPane);
    main.append(list, body);
    root.append(bar, main);
    host.appendChild(root);

    const tape = botTape(tapeHost);

    /* ── the chart ───────────────────────────────────────────────────────── */

    /**
     * The chart, built on the first bot that is looked at rather than at startup.
     *
     * A workspace is a live subscription and a canvas; building one for a tab nobody has
     * opened would be a feed running for a chart that has never been painted. Kept
     * afterwards — coming back to a bot should be instant.
     */
    let ws: VelaWorkspace | null = null;
    let strip: AccountStrip | null = null;
    let dock: TradeDock | null = null;
    /** The indicator drawing the selected bot's positions, and whose it is. */
    let indicator: ReturnType<VelaWorkspace['chart']['addNativeIndicator']> | null = null;
    let indicatorFor = '';
    /** The market the chart is on, so it is only switched when it actually differs. */
    let chartMarket = '';

    function ensureChart(): VelaWorkspace {
        if (ws) return ws;
        ws = new VelaWorkspace(chartHost, {
            layout: false,
            live: true,
            theme: opts.theme(),
            symbol: 'binance:BTCUSDT',
            timeframe: '5',
            brand: BRAND,
            providers: opts.providers,
            /* Its own document, separate from the Chart tab's: the indicators and drawings
             * somebody puts on a bot's chart are about that bot, and a shared one would put
             * them on the live chart too. */
            persist: 'midorii-bot-workspace',
        });

        /* Claimed before anything else, so the app's own topbar actions know not to project
         * onto it — the Trade menu most of all, which on a bot's chart would wire a second
         * account to one that is already being traded. See botChart.ts. */
        setBotChart(ws.chart);
        ws.refreshActions();

        const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
        if (cell) {
            strip = mountAccountStrip(cell, {
                broker: 'Bot',
                brokerHint: 'The account this bot trades — its own, never the Chart tab’s.',
            });
        }

        dock = mountTradeDock(liveStack, {
            /* A person can always close what a bot opened. Nothing here can OPEN anything —
             * see the file header on why this screen has no ticket. */
            closePosition: (id) => act((c) => c.closeOne(id)),
            closePart: (size, id) => act((c) => c.closePart?.(size, id)),
            reverse: (id) => act((c) => c.reverse?.(id)),
            breakEven: (id) => act((c) => c.breakEven?.(id)),
            protect: (levels, id) => act((c) => c.protect(levels, id)),
            setTrailing: (distance, id) => act((c) => c.setTrailing?.(distance, {}, id)),
            cancelOrder: (id) => act((c) => c.cancelOrder?.(id)),
            cancelAll: () => act((c) => c.cancelAll?.()),
            flatten: () => {
                const runner = engine.runner(selected);
                runner?.flatten('closed by hand from the bot screen');
            },
        }, {
            // No way in from this screen, so no instructions for one. See the file header.
            howToTrade: 'The bot opens its own trades — these buttons can only close them.',
        });
        // The dock mounts at the end of the column; the tape belongs under it.
        liveStack.appendChild(tapeHost);

        ensureUIHost(chartHost, resolveTheme(opts.theme()));
        return ws;
    }

    /**
     * Run one of the dock's actions against whichever controller the selected bot has.
     *
     * The two controllers do not implement the same set — a live account has no partial
     * close or trailing stop in this app — so those are called optionally and a controller
     * that does not offer one simply does nothing. The dock is the same dock the Chart tab
     * uses, and giving it a second, cut-down shape for live bots would be a second thing to
     * keep in step with the first.
     */
    function act(run: (controller: PartialController) => unknown): void {
        const runner = engine.runner(selected);
        const controller = (runner?.paperController ?? runner?.capitalController) as PartialController | undefined;
        if (!controller) {
            opts.notify('That bot is not running — there is nothing open to act on.', 'error');
            return;
        }
        try {
            run(controller);
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /** The union of what the two controllers offer, with the differences optional. */
    type PartialController = {
        closeOne(id: number): void;
        protect(levels: { stopLoss?: number | null; takeProfit?: number | null }, id: number): void;
        closePart?(size: number, id: number | null): void;
        reverse?(id: number | null): void;
        breakEven?(id: number | null): boolean;
        setTrailing?(distance: number, options: Record<string, never>, id: number | null): void;
        cancelOrder?(id: number): boolean | void;
        cancelAll?(): void;
    };

    /**
     * Put the chart on the selected bot's market and its positions on the chart.
     *
     * The indicator is torn down and rebuilt on a change of bot rather than reused, because
     * it is fed by whichever controller owns it — a reused one would keep being pushed the
     * previous bot's positions until the new one's first update.
     */
    function syncChart(bot: BotConfig | undefined): void {
        if (!bot) return;
        const chart = ensureChart().chart;

        const market = `${bot.symbol}|${bot.timeframe}`;
        if (market !== chartMarket && bot.symbol) {
            chartMarket = market;
            void chart.setMarket({ symbol: bot.symbol, timeframe: bot.timeframe }).catch((err: unknown) => (
                opts.notify(`The bot’s market could not be charted: ${err instanceof Error ? err.message : String(err)}`, 'error')
            ));
        }

        const runner = engine.runner(bot.id);
        const key = runner ? `${bot.id}:${runner.status}` : '';
        if (key === indicatorFor) return;

        indicator?.remove();
        indicator = null;
        indicatorFor = key;
        if (!runner) return;

        indicator = chart.addNativeIndicator(TRADE_INDICATOR_TYPE);
        const controller = runner.paperController ?? runner.capitalController;
        controller?.attachIndicator(indicator);
    }

    /* ── the list and the head ───────────────────────────────────────────── */

    function paintList(): void {
        list.replaceChildren();
        for (const bot of engine.list()) {
            const status = engine.status(bot.id);
            const item = doc.createElement('button');
            item.className = 'midorii-bot-item';
            if (bot.id === selected) item.dataset.active = '1';

            const row = doc.createElement('div');
            row.className = 'midorii-bot-item-head';
            const dot = doc.createElement('span');
            dot.className = 'midorii-bot-dot';
            dot.dataset.state = status;
            const name = doc.createElement('b');
            name.textContent = bot.name;
            row.append(dot, name);

            const what = doc.createElement('span');
            const spec = STRATEGIES[bot.strategy];
            what.textContent = `${spec?.name ?? bot.strategy} · ${bot.symbol || 'no market'} · `
                + `${bot.venue === 'capital' ? 'live' : 'paper'}`;

            item.append(row, what);
            item.onclick = () => {
                selected = bot.id;
                paint();
            };
            list.appendChild(item);
        }
    }

    function figure(caption: string, text: string, tone?: 'up' | 'down'): HTMLElement {
        const el = doc.createElement('span');
        el.className = 'midorii-bot-fig';
        const small = doc.createElement('small');
        small.textContent = caption;
        const value = doc.createElement('b');
        value.textContent = text;
        if (tone) value.classList.add(tone);
        el.append(small, value);
        return el;
    }

    function paintHead(bot: BotConfig | undefined): void {
        head.replaceChildren();
        if (!bot) return;

        const runner = engine.runner(bot.id);
        const status = engine.status(bot.id);

        const title = doc.createElement('div');
        title.className = 'midorii-bot-title';
        const name = doc.createElement('b');
        name.textContent = bot.name;
        const sub = doc.createElement('span');
        if (status === 'failed' && runner?.error) {
            sub.textContent = runner.error;
            sub.dataset.error = '1';
        } else if (status === 'running') {
            const refusal = runner?.refusal();
            sub.textContent = refusal
                ? `Running · not trading: ${refusal}`
                : `Running · watching for a setup · ${runner?.barCount ?? 0} bars`;
        } else if (status === 'starting') {
            sub.textContent = 'Starting…';
        } else {
            sub.textContent = `Stopped · ${STRATEGIES[bot.strategy]?.name ?? bot.strategy} on ${bot.symbol || 'no market'}`;
        }
        title.append(name, sub);
        head.appendChild(title);

        if (runner && status === 'running') {
            const figs = doc.createElement('span');
            figs.className = 'midorii-bot-figs';
            const equity = runner.equity();
            const move = equity - bot.balance;
            figs.append(
                figure('Equity', formatMoney(equity)),
                ...(bot.venue === 'paper'
                    ? [figure('Since start', formatSignedMoney(move), move === 0 ? undefined : move > 0 ? 'up' : 'down')]
                    : []),
                figure('Open', String(runner.openPositions())),
                figure('Resting', String(runner.restingOrders())),
                figure('Today', String(runner.todaysTrades)),
            );
            head.appendChild(figs);
        }

        const tabs = doc.createElement('span');
        tabs.className = 'midorii-bot-tabs';
        for (const [id, label] of [['live', 'Live'], ['settings', 'Settings']] as const) {
            const b = doc.createElement('button');
            b.className = 'midorii-bot-tab';
            b.textContent = label;
            if (pane === id) b.dataset.active = '1';
            b.onclick = () => { pane = id; paint(); };
            tabs.appendChild(b);
        }
        head.appendChild(tabs);

        const toggle = button(status === 'stopped' || status === 'failed' ? 'Start' : 'Stop',
            status === 'stopped' || status === 'failed' ? 'primary' : 'danger');
        toggle.onclick = () => void toggleBot(bot);
        head.appendChild(toggle);
    }

    /* ── acting ──────────────────────────────────────────────────────────── */

    async function createBot(): Promise<void> {
        const first = Object.keys(STRATEGIES)[0];
        if (!first) {
            opts.notify('This build has no strategies to run.', 'error');
            return;
        }
        /* Seeded from the Chart tab's market where there is one: a bot is nearly always made
         * while looking at the market it is meant to trade. */
        const bot = newBot(first, chartMarket.split('|')[0] || '');
        try {
            await engine.add(bot);
            selected = bot.id;
            pane = 'settings';
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    async function toggleBot(bot: BotConfig): Promise<void> {
        const status = engine.status(bot.id);
        try {
            if (status === 'stopped' || status === 'failed') {
                await engine.start(bot.id);
                pane = 'live';
            } else {
                await engine.stop(bot.id);
            }
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
        paint();
    }

    async function saveBot(next: BotConfig): Promise<void> {
        await engine.update(next);
        paint();
    }

    async function deleteBot(bot: BotConfig): Promise<void> {
        try {
            await engine.remove(bot.id);
            if (selected === bot.id) selected = engine.list()[0]?.id ?? '';
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    async function resetAccount(bot: BotConfig): Promise<void> {
        try {
            const filed = await engine.resetAccount(bot.id);
            opts.notify(
                filed
                    ? `“${bot.name}” was filed as a run (${filed}) and starts again on ${bot.balance}.`
                    : `“${bot.name}” had traded nothing, so its account simply starts again.`,
                'success',
            );
            paint();
        } catch (err) {
            opts.notify(err instanceof Error ? err.message : String(err), 'error');
        }
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    function paintEmpty(): void {
        livePane.hidden = true;
        settingsPane.hidden = false;
        settingsInner.replaceChildren();
        const empty = doc.createElement('div');
        empty.className = 'midorii-bot-empty';
        const h = doc.createElement('h2');
        h.textContent = engine.ready ? 'No bots yet' : 'Reading the bots…';
        const p1 = doc.createElement('p');
        p1.textContent = 'A bot runs one of the strategies from the Strategies tab against a live '
            + 'feed, on its own account, and keeps running while you look at something else. It '
            + 'uses the same rules a backtest does — what changes is only that nobody has to be '
            + 'watching.';
        const p2 = doc.createElement('p');
        p2.textContent = 'Before it may trade unattended it is given conditions a backtest never '
            + 'needed: which hours, how many trades a day, what it does about a losing day, and '
            + 'what it refuses to trade through. None of them can open a trade — every one can '
            + 'refuse one.';
        empty.append(h, p1, p2);
        settingsInner.appendChild(empty);
    }

    function paint(): void {
        const bots = engine.list();
        if (bots.length > 0 && !bots.some((b) => b.id === selected)) selected = bots[0]!.id;

        barLabel.textContent = bots.length === 0
            ? 'Trading Bot'
            : `Trading Bot · ${bots.length} ${bots.length === 1 ? 'bot' : 'bots'}`
              + (engine.runningCount > 0 ? ` · ${engine.runningCount} running` : '');

        paintList();

        const bot = bots.find((b) => b.id === selected);
        if (!bot) {
            head.replaceChildren();
            paintEmpty();
            return;
        }

        paintHead(bot);
        const running = engine.status(bot.id) === 'running' || engine.status(bot.id) === 'starting';

        livePane.hidden = pane !== 'live';
        settingsPane.hidden = pane !== 'settings';

        if (pane === 'live') {
            /* Only while the tab is actually on screen. The bots are started at launch, with
             * this view built and this root still hidden — and a chart built inside a hidden
             * container measures itself at zero by zero. Everything anchored to the plot then
             * lands in its top-left corner and stays there, because nothing re-measures a
             * chart that was never wrong about its own size, it was wrong about being
             * visible. The tab switch calls refresh(), which paints again with a real box. */
            if (!host.hidden) {
                syncChart(bot);
                paintLive(engine.runner(bot.id));
            }
        } else if (formFor !== bot.id || !form) {
            formFor = bot.id;
            settingsInner.replaceChildren();
            form = mountBotForm(doc, {
                bot,
                readOnly: running,
                capitalConfigured,
                accountTrades: engine.runner(bot.id)?.paperController?.broker.trades.length ?? 0,
                onSave: saveBot,
                onDelete: () => void deleteBot(bot),
                onResetAccount: () => void resetAccount(bot),
            });
            settingsInner.appendChild(form.el);
        }
    }

    /** The live half: the account card, the dock and the tape, from whatever is running. */
    function paintLive(runner: BotRunner | null): void {
        if (!runner) {
            /* The card is left alone rather than hidden. It owns its own visibility — a
             * person can put it away with its corner button and the Settings tab can switch
             * it off — and reaching past that from here both fought those and skipped the
             * reflow that keeps it inside the plot. An empty account reads as empty. */
            strip?.update(EMPTY_ACCOUNT);
            dock?.render({ positions: [], orders: [] });
            tape.render(null);
            return;
        }
        const paper = runner.paperController;
        if (paper) {
            strip?.update(paper.account());
            dock?.render(paper.book(), { stats: paper.stats() });
        } else {
            /* A live bot's positions are the venue's, and the venue does not answer in the
             * engine's shape. The dock is left empty rather than filled with a guess — the
             * chart's own lines are drawn from the venue's answer and are the truthful view. */
            dock?.render({ positions: [], orders: [] });
        }
        tape.render(runner);
    }

    /** Repaints are driven by a running bot's every tick, which is far more often than a
     *  screen needs redrawing. One per frame is plenty and keeps the chart smooth. */
    let painting = false;
    function schedulePaint(): void {
        if (painting) return;
        painting = true;
        requestAnimationFrame(() => {
            painting = false;
            if (!host.hidden) paint();
        });
    }

    paint();

    return {
        engine,
        async refresh(): Promise<void> {
            if (!engine.ready) {
                try {
                    await engine.load();
                } catch (err) {
                    opts.notify(
                        `The stored bots could not be read: ${err instanceof Error ? err.message : String(err)}`,
                        'error',
                    );
                }
            }
            paint();
        },
        setTheme(theme: VelaTheme): void {
            ws?.setTheme(theme);
            applyThemeTokens(chartHost, theme);
        },
    };
}
