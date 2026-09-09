// The app shell: Vela's workspace, wired to Midorii's own data layer.
//
// Two kinds of market sit side by side in one symbol picker. `local:` reads the
// bar store on this machine over IPC — the archive a replay or a backtest runs
// on — while the venue providers stream live from the exchange. Same chart,
// same tools; what differs is only where the bars come from.
import { BinanceProvider } from '../../src/data/providers/binance';
import { CoinbaseProvider } from '../../src/data/providers/coinbase';
import { HyperliquidProvider } from '../../src/data/providers/hyperliquid';
import { registerIcon, registerWidgetAction } from '../../src/plugin';
import { ensureUIHost } from '../../src/ui';
import type { VelaTheme } from '../../src/core/options';
import { VelaWorkspace } from '../../src/workspace';
import { BRAND } from './about/brand';
import { mountAnalysisView, type AnalysisViewHandle } from './analysis/analysisView';
import { mountBotView, type BotViewHandle } from './bot/botView';
import { isBotContext } from './bot/botChart';
import { mountBacktestView, type BacktestViewHandle } from './backtest/backtestView';
import { mountStrategiesView, type StrategiesViewHandle } from './strategies/strategiesView';
import { openDownloadDialog } from './data/downloadDialog';
import { CapitalProvider } from './providers/CapitalProvider';
import { LocalArchiveProvider } from './providers/LocalArchiveProvider';
import { isReplayContext } from './replay/replayActions';
import { resumeReplay, startReplay, type MountedReplay } from './replay/replayBootstrap';
import { askReplaySetup } from './replay/replaySetup';
import { openRunsDialog } from './runs/runsDialog';
import { loadPrefs, savePrefs, type AppPrefs } from './settings/prefs';
import { mountSettingsView, type SettingsViewHandle } from './settings/settingsView';
import { mountAppTopbar, type AppTab } from './shell/appTopbar';
import { paletteOf, type AppStyle, type AppThemeName } from './shell/themes';
import { installTradeMenu } from './trading/tradeMode';
import { installAlerts } from './alerts/installAlerts';
import { installQuotes } from './quotes/installQuotes';

/** Every market source the app can chart: the local archive, then the venues. */
function providers() {
    return {
        local: () => new LocalArchiveProvider(),
        binance: () => new BinanceProvider(),
        coinbase: () => new CoinbaseProvider(),
        hyperliquid: () => new HyperliquidProvider(),
        // Needs a Capital.com account — see .env.example. Registered either way (so
        // it shows up in the symbol picker's provider filter); getBars/subscribe
        // fail soft with a console warning until CAPITAL_* is set in .env.local.
        capital: () => new CapitalProvider(),
    };
}

const THEME_STORAGE_KEY = 'midorii-theme';

/** The theme the last session left the app in, so a restart does not default back to
 *  dark under someone who switched to light. Falls back to dark — the app's own
 *  original default — if nothing was ever stored, or storage is unavailable. */
function loadStoredTheme(): AppThemeName {
    try {
        return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch (err) {
        console.error('[midorii] could not read the stored theme', err);
        return 'dark';
    }
}

let currentTheme: AppThemeName = loadStoredTheme();

/**
 * The rest of the app's preferences, read once.
 *
 * The style lives here rather than beside the theme above because it is a different kind of
 * choice — which palette, not which lightness — and because it arrived with the Settings
 * tab, which is what writes it. Both are read before anything is built: a window that paints
 * one palette and then corrects itself is a window that flickers on every start.
 */
let prefs: AppPrefs = loadPrefs();
let currentStyle: AppStyle = prefs.style;

/** The colours the chart, the kit and the window are all dressed from. */
function palette(): VelaTheme {
    return paletteOf(currentStyle, currentTheme);
}

const appTopbarRoot = document.getElementById('app-topbar')!;
const chartRoot = document.getElementById('chart')!;
const replayRoot = document.getElementById('replay-root')!;
const backtestRoot = document.getElementById('backtest-root')!;
const analysisRoot = document.getElementById('analysis-root')!;
const strategiesRoot = document.getElementById('strategies-root')!;
const settingsRoot = document.getElementById('settings-root')!;
const botRoot = document.getElementById('bot-root')!;

/* The chart column, built whether or not anything is ever traded on it: the plot (and
 * the ticket beside it, once there is one) on top, the trade dock beneath. Empty it lays
 * out exactly as the bare chart did — a flex column with one item in it — so the cost of
 * having it here for the Trade menu to fill is nothing at all.
 *
 * Elements of our own rather than a restyled `#chart`, which showOnly toggles with
 * `hidden`: an inline `display` on that would override it and leave the chart on screen
 * over every other tab. */
const chartStack = document.createElement('div');
chartStack.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column';
const chartMain = document.createElement('div');
chartMain.style.cssText = 'flex:1 1 auto;min-height:0;display:flex';
const chartHost = document.createElement('div');
// `min-width:0` is what lets the plot give way when the ticket opens: without it a flex
// item refuses to shrink past its content and the panel is pushed off the edge instead.
chartHost.style.cssText = 'flex:1 1 auto;min-width:0;position:relative';
chartMain.appendChild(chartHost);
chartStack.appendChild(chartMain);
chartRoot.appendChild(chartStack);

const workspace = new VelaWorkspace(chartHost, {
    layout: false,
    live: true,
    theme: palette(),
    // A venue symbol rather than a local one so a fresh install charts something
    // on first run; the picker lists whatever has been downloaded beside it.
    symbol: 'binance:BTCUSDT',
    timeframe: '60',
    brand: BRAND,
    providers: providers(),
    persist: 'midorii-workspace',
});

/* The kit's theme tokens live on the workspace's own root, and the dialogs below open on
 * document.body — outside it. Without this they render with every --vela-* unresolved:
 * no surface, no borders, the chart showing straight through the panel. */
ensureUIHost(document.body, palette());

(window as unknown as { __workspace: VelaWorkspace }).__workspace = workspace;

// ── app top bar ──────────────────────────────────────────────────────────
//
// Above Vela's own chart topbar, not instead of it: the brand mark, the app's
// top-level views as tabs, and (light/dark, window controls) on the right. Every
// one of them is a real view built below.

/** Only ONE root is ever visible — the tabs are mutually exclusive views. */
function showOnly(root: HTMLElement): void {
    for (const r of [chartRoot, replayRoot, backtestRoot, analysisRoot, strategiesRoot, settingsRoot, botRoot]) {
        r.hidden = r !== root;
    }
}

/** The mounted replay's own workspace, once one exists — so the theme toggle can reach
 *  it too. A replay is a second, independent VelaWorkspace (see openReplay below). */
let mountedReplayWs: VelaWorkspace | null = null;

const appTopbar = mountAppTopbar(appTopbarRoot, {
    active: 'chart',
    theme: currentTheme,
    onSelectTab: (tab) => void selectTab(tab),
    onToggleTheme: () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'),
    onOpenSettings: () => void selectTab('settings'),
});

/** Switch the whole app's theme — the live chart, a mounted replay's chart, every
 *  dialog hosted on `document.body`, and the app topbar's own icon. */
function applyTheme(next: AppThemeName): void {
    if (next === currentTheme) return;
    currentTheme = next;
    repaint();
    try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (err) {
        console.error('[midorii] could not persist the theme', err);
    }
}

/** Switch which palette the app is wearing, at whatever lightness it is currently at. */
function applyStyle(next: AppStyle): void {
    if (next === currentStyle) return;
    currentStyle = next;
    prefs = { ...prefs, style: next };
    savePrefs(prefs);
    repaint();
}

/**
 * Put the current palette on everything that is wearing one.
 *
 * One function for both switches because they answer to the same thing: neither the theme
 * nor the style is a colour anybody stores, they are two coordinates of the one palette
 * below, and half of the app repainted is worse than either.
 */
function repaint(): void {
    const t = palette();
    workspace.setTheme(t);
    mountedReplayWs?.setTheme(t);
    ensureUIHost(document.body, t);
    // The Trading Bot tab builds a chart of its own, which is wearing the old palette until
    // it is told otherwise. Only if it has ever been opened — nothing is built before that.
    botView?.setTheme(t);
    appTopbar.setTheme(currentTheme);
    /* Only if it has ever been opened: the Settings tab shows which theme and style are on,
     * and the switch it would be disagreeing with is one row above it on the same screen. */
    settingsView?.refresh();
    // Cosmetic only (the OS window's paint colour, which shows during a resize and before
    // the page has painted) — a failure here must not undo the switch, which has happened.
    void window.midori.ui.setTheme(currentTheme, t.background).catch((err: unknown) => (
        console.error('[midorii] ui:set-theme failed', err)
    ));
}

/** Route a tab click to the view it names. Replay may ask the setup dialog first —
 *  dismissing it leaves the tab bar on Chart rather than on a view nothing opened. */
async function selectTab(tab: AppTab): Promise<void> {
    if (tab === 'chart') {
        showOnly(chartRoot);
        appTopbar.setActiveTab('chart');
        return;
    }
    if (tab === 'replay') {
        const opened = await openReplay();
        appTopbar.setActiveTab(opened ? 'replay' : 'chart');
        return;
    }
    if (tab === 'analysis') {
        showOnly(analysisRoot);
        appTopbar.setActiveTab('analysis');
        /* Read on the way in rather than kept live: a run that finished — or a paper
         * account that traded — while this tab was hidden is exactly what somebody opens
         * it to look at. The view reports its own failures in the panel. */
        await analysis().refresh();
        return;
    }
    if (tab === 'backtest') {
        showOnly(backtestRoot);
        appTopbar.setActiveTab('backtest');
        /* Read on the way in, like Analysis: a market downloaded while this tab was hidden
         * is exactly the one somebody opens it to run on — and so are settings changed on
         * the Strategies tab, which this one starts from. */
        await backtest().refresh();
        return;
    }
    if (tab === 'strategies') {
        showOnly(strategiesRoot);
        appTopbar.setActiveTab('strategies');
        // Same reason again: the settings on disk are what this screen is for.
        await strategies().refresh();
        return;
    }
    if (tab === 'settings') {
        showOnly(settingsRoot);
        appTopbar.setActiveTab('settings');
        /* Read on the way in, like the others: everything this screen shows is stored
         * somewhere else, and the chart's own settings dialog edits some of it. */
        settings().refresh();
        return;
    }
    showOnly(botRoot);
    appTopbar.setActiveTab('bot');
    /* Read on the way in, like the others. Unlike the others, what this screen shows may
     * already be RUNNING — the bots are started at launch (below) and keep running with the
     * tab shut, so this is the view catching up with them rather than the other way round. */
    await bots().refresh();
}

// ── topbar actions ───────────────────────────────────────────────────────
//
// Contributions rather than chrome of our own: they land in Vela's topbar next
// to the replay transport, and everything they act on comes from the context
// they are handed. Both are gated off the replay chart — a session has its own
// controls there, and neither downloading nor starting a second replay belongs
// in the middle of one.

registerIcon('midorii-download', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="M4.5 7 8 10.5 11.5 7"/><path d="M2.5 13.5h11"/></svg>');
registerIcon('midorii-runs', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 10.5 7 8l2 1.5 2.5-3.5"/></svg>');
registerIcon('midorii-replay', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 2v3h-3"/></svg>');

/* The Trade menu, top-right in the chart's own topbar: which broker — if any — this
 * chart is wired to. Off by default, and off is a real state: nothing about trading is
 * on the chart until a broker is picked, and Just Watching takes it all back off.
 *
 * Gated off the replay chart, which has a session and a transport of its own — and off the
 * Trading Bot tab's, which is already being traded by a strategy. A second account wired to
 * that one would put a hand-placed trade in the same ledger as an automated one, where
 * neither could be told from the other afterwards. */
const trading = installTradeMenu({
    workspace,
    stack: chartStack,
    main: chartMain,
    theme: palette,
    when: (ctx) => !isReplayContext(ctx) && !isBotContext(ctx),
});
(window as unknown as { __trading: typeof trading }).__trading = trading;

/* Price alerts: right-click the chart → "Add Alert" at the clicked level, watched
 * against the live feed regardless of what the chart is showing, and notified through
 * the OS even while the app is minimized. Its own provider instances (never the
 * workspace's) — it watches symbols independently of whichever one is on screen. */
installAlerts(workspace, providers());

/* The two-sided price, for venues that quote one. The candles are drawn from the bid, so
 * on a CFD market the chart alone never says what a buy costs — this does, and says what
 * the gap between the sides is costing. Absent on markets that quote a single price. */
installQuotes(workspace);

/* The Analysis tab, built the first time it is opened rather than at startup: it reads
 * the run shelf and the paper account off disk, and neither of those is worth a round
 * trip on a chart nobody has asked to analyse yet. Kept afterwards — coming back to it
 * should be instant, the way the replay view is. */
let analysisView: AnalysisViewHandle | null = null;
function analysis(): AnalysisViewHandle {
    analysisView ??= mountAnalysisView(analysisRoot, { liveAccount: () => trading.account });
    return analysisView;
}

/* The Backtest tab, built the first time it is opened — same reasoning as Analysis: it
 * reads the data library off disk, which is not worth a round trip until somebody asks
 * for it. Kept afterwards, so a form half filled in survives a look at the chart. */
let backtestView: BacktestViewHandle | null = null;
function backtest(): BacktestViewHandle {
    backtestView ??= mountBacktestView(backtestRoot);
    return backtestView;
}

/* The Strategies tab — what this app can trade on its own, and what each one is set to.
 * Built on first open like the others; it reads the settings file, which nothing else
 * needs until somebody asks to see it. */
let strategiesView: StrategiesViewHandle | null = null;
function strategies(): StrategiesViewHandle {
    strategiesView ??= mountStrategiesView(strategiesRoot);
    return strategiesView;
}

/* The Trading Bot tab.
 *
 * Built on first open like the others, and unlike the others that is only about the SCREEN:
 * the bots themselves are started at launch (see the resume at the foot of this file), so a
 * bot runs whether or not anybody has ever opened the tab it is drawn on. Which is the whole
 * point of a bot, and the reason its engine is reachable through the handle rather than
 * living inside the view. */
let botView: BotViewHandle | null = null;
function bots(): BotViewHandle {
    botView ??= mountBotView(botRoot, {
        providers: providers(),
        theme: palette,
        // The bot screen has no toast host of its own — it is not a chart. The live chart's
        // is the app's, and it is on screen whichever tab is open.
        notify: (message, kind) => workspace.toast(message, kind === 'success' ? 'success' : kind),
    });
    return botView;
}

/* The Settings tab — what the app is, as opposed to what it has done. Built on first open
 * like the others; until somebody asks for it there is nothing on it worth reading, and the
 * screens it edits for (the chart, the paper account) are already wired without it. */
let settingsView: SettingsViewHandle | null = null;
function settings(): SettingsViewHandle {
    settingsView ??= mountSettingsView(settingsRoot, {
        theme: () => currentTheme,
        setTheme: applyTheme,
        style: () => currentStyle,
        setStyle: applyStyle,
        trading,
    });
    return settingsView;
}

registerWidgetAction({
    id: 'midorii.download',
    target: 'topbar',
    align: 'right',
    order: 20,
    iconOnly: true,
    label: 'Download market data',
    icon: 'midorii-download',
    when: (ctx) => !isReplayContext(ctx) && !isBotContext(ctx),
    run: (ctx) => {
        void openDownloadDialog(document.body)
            .then((symbol) => {
                if (symbol) ctx.toast(`${symbol} is in the local archive`, 'success');
            })
            .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : String(err), 'error'));
    },
});

registerWidgetAction({
    id: 'midorii.runs',
    target: 'topbar',
    align: 'right',
    order: 22,
    iconOnly: true,
    label: 'Runs',
    icon: 'midorii-runs',
    when: (ctx) => !isReplayContext(ctx) && !isBotContext(ctx),
    run: (ctx) => void openRunsDialog(document.body).catch((err: unknown) => (
        ctx.toast(err instanceof Error ? err.message : String(err), 'error')
    )),
});

registerWidgetAction({
    id: 'midorii.replay',
    target: 'topbar',
    align: 'right',
    order: 21,
    iconOnly: true,
    label: 'Replay',
    icon: 'midorii-replay',
    when: (ctx) => !isReplayContext(ctx) && !isBotContext(ctx),
    // Routed through the same tab switch as the app topbar's own Replay tab, so
    // either entry point keeps it in sync with which one is highlighted.
    run: (ctx) => void selectTab('replay').catch((err: unknown) => (
        ctx.toast(err instanceof Error ? err.message : String(err), 'error')
    )),
});

/* The workspace built its topbar before any of the three actions above existed —
 * registering one does not tell a shell that has already rendered. Without this the
 * app's own buttons are simply absent, which is what replayActions does after every
 * re-registration of the transport controls. */
workspace.refreshActions();

// ── replay ───────────────────────────────────────────────────────────────
//
// A separate, dedicated VelaWorkspace mounted on demand into #replay-root: it
// runs against a provider that reveals bars one at a time, so it cannot share
// the live workspace's feed. The live chart is hidden rather than torn down —
// leaving the session is meant to be instant.

let mounted = false;

/** Open (or return to) the replay view. Resolves `false` only when a fresh setup was
 *  asked for and dismissed — every other path either mounts a session or throws. */
async function openReplay(): Promise<boolean> {
    if (mounted) {
        showOnly(replayRoot); // already running — the Chart tab may have hidden it
        return true;
    }

    const choice = await askReplaySetup(document.body);
    if (!choice) return false; // dismissed — stay on the live chart

    showOnly(replayRoot);
    mounted = true;

    try {
        const replay: MountedReplay = choice.kind === 'new'
            ? await startReplay(replayRoot, choice.setup)
            : await resumeReplay(replayRoot, choice.sessionId);
        mountedReplayWs = replay.ws;
        /* A replay builds its own workspace on its own default, which is the app's dark
         * one — right until the app is not wearing that. Dressed here rather than through
         * the bootstrap's arguments because this is the only place that knows. */
        replay.ws.setTheme(palette());
        (window as unknown as { __replay: typeof replay }).__replay = replay;
    } catch (err) {
        // Nothing mounted, so put the live chart back rather than leaving an
        // empty panel with no way out of it.
        showOnly(chartRoot);
        mounted = false;
        throw err;
    }
    return true;
}

// ── the view this machine opens on ───────────────────────────────────────
//
// Settings → General. Chart is the default and costs nothing to honour: it is what
// index.html already shows. Anything else is one tab switch, made through the same route a
// click takes — so a startup view builds and reads exactly as it would have on the click
// that is not being made. Last in the file because that switch may reach for anything above
// it (the trading handle, the workspace); a failure leaves the chart on screen, which is a
// working app rather than an empty panel.
const startupTab = prefs.startupTab;
if (startupTab !== 'chart') {
    void selectTab(startupTab).catch((err: unknown) => (
        console.error('[midorii] could not open the view this app was set to start on', err)
    ));
}

// ── the bots this machine was left running ───────────────────────────────
//
// Started without the tab being opened, which is the whole point of a bot: it keeps running
// while somebody looks at the chart, and it comes back when the app does. Paper bots only —
// a real account is armed by a person each time, the same rule the chart's Trade menu
// follows (see bot/BotEngine.ts's `resume`).
//
// The view is built to do it, because the engine lives on the handle; nothing is PAINTED
// until the tab is opened, so this costs a hidden DOM subtree and the feeds the bots
// themselves need.
void bots().refresh()
    .then(() => botView!.engine.resume())
    .catch((err: unknown) => console.error('[midorii] could not resume the trading bots', err));

/* A window closing mid-bar must not leave a subscription behind. Nothing is CLOSED — a bot
 * that was running is still marked enabled, and its positions keep the stop and target that
 * went out with them. */
window.addEventListener('beforeunload', () => botView?.engine.stopAll());
