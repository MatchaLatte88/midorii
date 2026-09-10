import type { VelaTheme } from '../../../src';
import { applyThemeTokens, ensureUIHost } from '../../../src/ui';
import { VelaWorkspace } from '../../../src/workspace';
import { barIndexAt } from '../../../shared/engine/replaySession.js';
import type { ReplayBar } from '../../../shared/engine/replaySession.js';
import { BRAND } from '../about/brand';
import { LocalArchiveProvider } from '../providers/LocalArchiveProvider';
import { ReplayController } from './ReplayController';
import { ReplayProvider } from './ReplayProvider';
import { mountAccountStrip } from './accountStrip';
import { mountQuickPanel } from './quickPanel';
import { mountTradeDock } from './tradeDock';
import { mountTradeSidebar } from './tradeSidebar';
import type { TradeSidebar } from './tradeSidebar';
import { setActiveReplay, syncControls } from './replayActions';
import { REPLAY_INDICATOR_TYPE, registerReplayIndicator } from './replayIndicator';
import { wireOrderEntry } from './replayOrders';
import { wirePositionLevels } from './replayLevels';
import { wirePositionStyle } from '../trading/positionStyleSettings';
import { wireOverlaySettings } from './overlaySettings';
import { shareChartDoc } from '../shell/sharedChartDoc';
import { loadReplayWindow } from './replayWindow';

/**
 * The timeframe a fresh replay opens on.
 *
 * The setup dialog deliberately does not ask: a timeframe is not a property of
 * the session, it is how you happen to be looking at it right now, and it can
 * be changed at any point from the chart's own picker without disturbing the
 * account (see {@link ReplayController.retime}). Vela's canonical spelling —
 * a bare number is minutes, so this is one hour.
 */
const DEFAULT_TIMEFRAME = '60';

export interface ReplaySetup {
    symbol: string;
    /** The replay "clock" at session start — nothing at or after this is revealed yet. */
    startTime: number;
    balance?: number;
}

/** What a mounted replay hands back. (Not the engine's ReplaySession — that's the account.) */
export interface MountedReplay {
    ws: VelaWorkspace;
    provider: ReplayProvider;
    controller: ReplayController;
}

/** Everything a mounted replay shares, whether it is new or resumed. */
async function mount(
    container: HTMLElement,
    cfg: { symbol: string; timeframe: string; clock: number; bars: ReplayBar[] },
    makeController: (provider: ReplayProvider, bars: ReplayBar[], startIndex: number) => ReplayController,
    theme: VelaTheme,
): Promise<MountedReplay> {
    const archive = new LocalArchiveProvider();
    // Underscore, not hyphen: Vela parses a symbol's `provider:` prefix as
    // `[A-Za-z0-9_.]+` — a hyphen makes the prefix unparseable and the provider is
    // then never found (the chart just stays empty, with no error anywhere).
    // A per-session name also keeps the shared closed-bar cache from serving one
    // session's bars to the next one on the same symbol/timeframe.
    const providerName = `replay_${Date.now().toString(36)}`;
    const provider = new ReplayProvider(archive, providerName, cfg.timeframe, cfg.clock);

    /* A session is a chart, the ticket beside it and the book under it — two axes, so two
     * boxes: a column for the dock, and a row inside it for the panel. Elements of our own
     * rather than a restyled `container`, which main.ts shows and hides with `hidden` — an
     * inline `display` on it would override that and leave the replay on screen for good. */
    const stack = container.ownerDocument.createElement('div');
    stack.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column';
    const main = container.ownerDocument.createElement('div');
    main.style.cssText = 'flex:1 1 auto;min-height:0;display:flex';
    const chartHost = container.ownerDocument.createElement('div');
    // `min-width:0` is what lets the chart give way when the panel opens: without it a flex
    // item refuses to shrink past its content and the panel is pushed off the edge instead.
    chartHost.style.cssText = 'flex:1 1 auto;min-width:0;position:relative';
    main.appendChild(chartHost);
    stack.appendChild(main);
    container.appendChild(stack);

    /* The app's ONE chart document, worn here too — a session opens looking like the chart
     * it was started from rather than on the factory defaults. `remembers: false`: the market
     * is the one that was SET UP, never the one a previous session was left on. */
    const doc = shareChartDoc('replay', { symbol: `${providerName}:${cfg.symbol}`, timeframe: cfg.timeframe }, { remembers: false });

    const ws = new VelaWorkspace(chartHost, {
        layout: false,
        live: true,
        theme,
        symbol: `${providerName}:${cfg.symbol}`,
        timeframe: cfg.timeframe,
        brand: BRAND,
        providers: { [providerName]: () => provider },
        persist: doc.key,
        storage: doc.storage,
    });
    doc.attach(ws);
    await ws.chart.ready();

    const controller = makeController(provider, cfg.bars, barIndexAt(cfg.bars, cfg.clock - 1));

    // Added straight on the chart, not through the widget context: the replay's
    // visuals are recomputed state, so they must stay out of the undo timeline
    // and out of the persisted indicator ledger.
    registerReplayIndicator();
    const indicator = ws.chart.addNativeIndicator(REPLAY_INDICATOR_TYPE);
    controller.attachIndicator(indicator);
    // How those visuals look, and the Trading tab in the chart settings that says so.
    wirePositionStyle({ workspace: ws, indicator });
    // Which cards this replay's chart puts on its plot. Its own workspace, so its own tab.
    wireOverlaySettings(ws);

    // The ticket beside the plot: the way in that does not go through a drawing.
    const sidebar = showTicket(ws, main, controller, theme);

    // Vela's own position tool is the other way in — drawn like any other drawing, traded only
    // when its right-click menu says so, and sized by the panel's risk settings either way.
    wireOrderEntry({
        chart: ws.chart,
        controller,
        host: ws.root,
        risk: () => sidebar.risk(),
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    });

    // The open position's own levels: draggable stop and target, and a close button on the entry.
    wirePositionLevels({
        chart: ws.chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    });

    // Transport controls into Vela's own topbar.
    setActiveReplay({ controller, ws });

    showAccount(ws, stack, controller, sidebar);

    followChartTimeframe(ws, controller);

    return { ws, provider, controller };
}

/** Run an engine call and put its refusal in front of the person who asked for it. The
 *  engine's message is the message; there is nothing better to say than what it already said. */
function guarded(ws: VelaWorkspace, run: () => void): void {
    try {
        run();
    } catch (err: unknown) {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }
}

/**
 * Put the ticket beside the plot.
 *
 * Its own kit host: it is a sibling of the chart rather than a child, so the theme variables
 * the workspace writes on its own root do not reach it. They are re-applied when the chart's
 * theme changes, which is a thing the settings dialog can do mid-session.
 */
function showTicket(ws: VelaWorkspace, main: HTMLElement, controller: ReplayController, theme: VelaTheme): TradeSidebar {
    const sidebar = mountTradeSidebar(main, {
        account: () => ({ equity: controller.session.broker.equity, price: controller.session.bar.close }),
        counts: () => {
            const book = controller.book();
            return { positions: book.positions.length, orders: book.orders.length };
        },
        actions: {
            order: (spec) => guarded(ws, () => controller.order(spec)),
            flatten: () => guarded(ws, () => controller.flatten()),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
    });

    ensureUIHost(sidebar.el, theme);
    ws.chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme));
    return sidebar;
}

/**
 * Put the account on the chart, and keep it there.
 *
 * The strip anchors to the CELL rather than to the workspace root: the renderer publishes the
 * plot's own insets there for host overlays to use, and it is already a positioning context.
 * Without a cell — which would mean Vela's shell had changed shape — nothing is mounted, since
 * a card floating in the wrong corner of the window is worse than no card.
 */
function showAccount(ws: VelaWorkspace, stack: HTMLElement, controller: ReplayController, sidebar: TradeSidebar): void {
    const cell = ws.root.querySelector<HTMLElement>('.vela-cell');
    const strip = cell
        ? mountAccountStrip(cell, {
            broker: 'Replay',
            brokerHint: 'A session played back bar by bar against this app\'s own engine — '
                + 'separate from the paper account, and from any venue.',
        })
        : null;

    // Buy/Sell on the chart itself, directly under the card — market orders, nothing else.
    const quick = cell
        ? mountQuickPanel(cell, {
            price: () => controller.session.bar.close,
            order: (spec) => guarded(ws, () => controller.order(spec)),
            anchor: strip?.el ?? null,
        })
        : null;

    /* Every action goes through here so a refusal from the engine — break-even on a trade that
     * has not moved, a stop on a position that just closed — reaches the person who asked for
     * it. */
    const guard = (run: () => void) => (): void => guarded(ws, run);

    const dock = mountTradeDock(stack, {
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
        dock.render(controller.book());
        // The ticket sizes against equity and the last price, so it moves with every bar too.
        sidebar.refresh();
        quick?.refresh();
    };
    controller.onAccountChange = paint;
    paint();
}

/**
 * Let the chart's own timeframe picker drive the session.
 *
 * `market:changed` lands after the reload has finished, so by the time this runs
 * the chart is already showing the new resolution — correctly, because the
 * provider reveals by instant rather than by bar count. What is left is to move
 * the account onto the same bars, which is what `retime` does.
 *
 * A timeframe the archive cannot serve leaves the session untouched and puts the
 * chart back where it was, rather than letting the two drift apart in silence.
 */
function followChartTimeframe(ws: VelaWorkspace, controller: ReplayController): void {
    ws.chart.on('market:changed', ({ timeframe }) => {
        if (timeframe === controller.timeframe) return;
        void controller.retime(timeframe).catch((err: unknown) => {
            ws.toast(err instanceof Error ? err.message : String(err), 'error');
            void ws.chart.setMarket({ timeframe: controller.timeframe });
        });
    });
}

/** Start a fresh replay at `startTime`, on the default timeframe. `theme` is the palette
 *  the app is currently wearing — a session is built in it rather than corrected into it. */
export async function startReplay(container: HTMLElement, cfg: ReplaySetup, theme: VelaTheme): Promise<MountedReplay> {
    const timeframe = DEFAULT_TIMEFRAME;
    const { bars } = await loadReplayWindow(cfg.symbol, timeframe, cfg.startTime);
    return mount(
        container,
        { symbol: cfg.symbol, timeframe, clock: cfg.startTime, bars },
        (provider, window_, startIndex) => new ReplayController({
            provider, bars: window_, startIndex, balance: cfg.balance,
            symbol: cfg.symbol, timeframe,
            onPlayStateChange: () => syncControls(),
        }),
        theme,
    );
}

/**
 * Pick up a parked session. The bars are fetched fresh around its stored clock —
 * they were never saved, and are the same bars today — and the account is
 * restored from the snapshot, which recomputes its playhead from that clock
 * rather than from an index into a window that no longer exists.
 *
 * It comes back on the timeframe it was put down on, including the bar it was
 * standing inside if the clock had stopped part-way through one.
 */
export async function resumeReplay(container: HTMLElement, sessionId: string, theme: VelaTheme): Promise<MountedReplay> {
    const record = await window.midori.replay.loadSession(sessionId);
    if (!record) throw new Error(`No stored replay session ${sessionId}.`);

    const { bars, forming } = await loadReplayWindow(record.symbol, record.timeframe, record.clock);
    return mount(
        container,
        { symbol: record.symbol, timeframe: record.timeframe, clock: record.clock, bars },
        (provider, window_, startIndex) => new ReplayController({
            provider, bars: window_, startIndex, forming,
            symbol: record.symbol, timeframe: record.timeframe,
            restoreFrom: record.session,
            restoredSessionId: record.id,
            onPlayStateChange: () => syncControls(),
        }),
        theme,
    );
}
