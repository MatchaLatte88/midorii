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
import { wirePendingMenu } from './chartPending';
import { wireTradePreview } from './chartPreview';
import { wirePositionLevels } from './replayLevels';
import { wirePositionStyle } from '../trading/positionStyleSettings';
import { wireOverlaySettings } from './overlaySettings';
import { shareChartDoc } from '../shell/sharedChartDoc';
import { loadReplayWindow } from './replayWindow';
import { wireRadialMenu } from '../settings/radialMenuPrefs';
import { TickFeed } from './tickFeed';
import type { TapePrint } from './timeAndSales';

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

/** Where a session plays a recording, it opens on minutes: ticks are practised at the ladder,
 *  and an hourly candle growing for an hour is not what anybody watching a tape is reading. */
const TICK_TIMEFRAME = '1';

export interface ReplaySetup {
    symbol: string;
    /** The replay "clock" at session start — nothing at or after this is revealed yet. */
    startTime: number;
    balance?: number;
    /** The recording to play on ticks — a contract name, `NQU6` — or none. */
    ticks?: string | null;
}

/** What a mounted replay hands back. (Not the engine's ReplaySession — that's the account.) */
export interface MountedReplay {
    ws: VelaWorkspace;
    provider: ReplayProvider;
    controller: ReplayController;
}

/** Tells two provider names made in the same millisecond apart. */
let providerSerial = 0;

/**
 * A name for a replay provider.
 *
 * Underscore, not hyphen: Vela parses a symbol's `provider:` prefix as `[A-Za-z0-9_.]+` — a
 * hyphen makes the prefix unparseable and the provider is then never found (the chart just
 * stays empty, with no error anywhere). A fresh name per provider also keeps the shared
 * closed-bar cache from serving one provider's candles to the next — which is exactly what
 * going back to an earlier candle relies on.
 */
function providerNameFor(): string {
    providerSerial += 1;
    return `replay_${Date.now().toString(36)}${providerSerial.toString(36)}`;
}

/** What a controller is handed from the chart it drives. */
interface ControllerWiring {
    rechart: (timeframe: string, clock: number) => Promise<ReplayProvider>;
    notify: (message: string, kind: 'info' | 'error') => void;
}

/** What a controller is built from, once the chart it drives exists. */
type MakeController = (
    provider: ReplayProvider,
    bars: ReplayBar[],
    startIndex: number,
    wiring: ControllerWiring,
) => ReplayController;

/** Everything a mounted replay shares, whether it is new or resumed. */
async function mount(
    container: HTMLElement,
    cfg: { symbol: string; timeframe: string; clock: number; bars: ReplayBar[] },
    makeController: MakeController,
    theme: VelaTheme,
): Promise<MountedReplay> {
    const archive = new LocalArchiveProvider();
    let providerName = providerNameFor();
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
    wireRadialMenu(ws);
    await ws.chart.ready();

    /**
     * Put the chart back on an earlier instant.
     *
     * A fresh provider under a fresh name rather than the running one wound back: the chart
     * already holds every candle after that instant, and the shared cache would hand them
     * straight back on the reload. Drawings survive — a market switch leaves them alone. The
     * provider it replaces is let go only once the chart is on the new one; where the switch
     * fails, the chart is put back where it was before the error goes on.
     */
    const rechart = async (timeframe: string, clock: number): Promise<ReplayProvider> => {
        const previous = { name: providerName, timeframe: ws.chart.market.timeframe ?? timeframe };
        const name = providerNameFor();
        const next = new ReplayProvider(archive, name, timeframe, clock);
        ws.chart.data.registerProvider(name, next);
        try {
            await ws.chart.setMarket({ symbol: `${name}:${cfg.symbol}`, timeframe });
        } catch (err) {
            ws.chart.data.unregisterProvider(name);
            await ws.chart.setMarket({ symbol: `${previous.name}:${cfg.symbol}`, timeframe: previous.timeframe })
                .catch((restoreErr: unknown) => console.error('[midorii] could not put the replay chart back', restoreErr));
            throw err;
        }
        ws.chart.data.unregisterProvider(previous.name);
        providerName = name;
        return next;
    };

    const notify = (message: string, kind: 'info' | 'error'): void => ws.toast(message, kind === 'error' ? 'error' : 'info');
    const controller = makeController(provider, cfg.bars, barIndexAt(cfg.bars, cfg.clock - 1), { rechart, notify });

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
    // The ticket drawn where it would trade, before it is sent — see chartPreview.ts.
    wireTradePreview({
        chart: ws.chart,
        indicator,
        sidebar,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    });

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
    const feed = controller.ticks;

    /* What the recording is of — above all its price increment, which the ladder is drawn on.
     * Written beside the recording when the gateway had listed the contract; where it had not,
     * worked out from the prints themselves as they play, which is the increment the market
     * actually moved in and never a guess. */
    let tickSize: number | null = null;
    let inferredTick: number | null = null;
    if (feed) {
        void window.midori.ticks.meta(feed.source)
            .then((meta) => {
                if (meta?.tickSize && meta.tickSize > 0) {
                    tickSize = meta.tickSize;
                    sidebar.refresh();
                }
            })
            .catch((err: unknown) => console.error('[midorii] could not read what the recording is of', err));
    }

    const sidebar = mountTradeSidebar(main, {
        account: () => ({
            equity: controller.session.broker.equity,
            price: controller.session.bar.close,
            /* The recorded bid and ask, while the quote is fresh — what a market order here is
             * filled at, and what the ticket's two sides show. */
            ...(controller.session.broker.quote ?? {}),
        }),
        counts: () => {
            const book = controller.book();
            return { positions: book.positions.length, orders: book.orders.length };
        },
        actions: {
            order: (spec) => guarded(ws, () => controller.order(spec)),
            flatten: () => guarded(ws, () => controller.flatten()),
            cancelAll: () => guarded(ws, () => controller.cancelAll()),
        },
        ...(feed
            ? {
                tick: () => tickSize ?? inferredTick,
                ladder: {
                    quote: () => controller.session.broker.quote,
                    positions: () => controller.session.broker.positions.map((p) => ({
                        size: p.size, entryPrice: p.entryPrice, stopLoss: p.stopLoss ?? null, takeProfit: p.takeProfit ?? null,
                    })),
                    orders: () => controller.book().orders
                        .filter((o) => o.price != null)
                        .map((o) => ({ id: o.id, side: o.side, price: o.price!, size: o.size })),
                    cancelOrder: (id: number) => guarded(ws, () => controller.cancelOrder(id)),
                },
                /* Prints only flow while the recording is being played, so the tape is offered
                 * only then — an empty tape on candles would promise prints that never come. */
                tape: () => controller.mode === 'ticks',
            }
            : {}),
    });

    if (feed) {
        /* The ladder folds volume as a running figure (see priceLadder.ts), so it is handed one:
         * every print adds its own size at its own price, and a new candle never reads as a
         * drop that has to be guessed at. */
        let traded = 0;
        let lastPrint: number | null = null;
        controller.onPrints = (prints) => {
            const tape: TapePrint[] = [];
            for (const [time, , price, size, side] of prints) {
                tape.push({ time, price, size, side: side === 1 ? 'sell' : 'buy' });
                traded += size;
                sidebar.markVolume(price, traded);
                if (lastPrint !== null && price !== lastPrint) {
                    const step = Math.round(Math.abs(price - lastPrint) * 1e9) / 1e9;
                    if (step > 0 && (inferredTick === null || step < inferredTick)) inferredTick = step;
                }
                lastPrint = price;
            }
            sidebar.pushPrints(tape);
        };
        /* Going back leaves a tape and a volume profile of a market that has not happened yet. */
        controller.onJump = () => {
            traded = 0;
            lastPrint = null;
            sidebar.resetMarket();
        };
    }

    ensureUIHost(sidebar.el, theme);
    ws.chart.on('theme:changed', (theme) => applyThemeTokens(sidebar.el, theme));
    // A level right-clicked on the plot, onto the ticket as a resting order — not sent.
    wirePendingMenu({
        chart: ws.chart,
        sidebar,
        price: () => controller.price(),
        tick: () => tickSize ?? inferredTick,
    });
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
    const timeframe = cfg.ticks ? TICK_TIMEFRAME : DEFAULT_TIMEFRAME;
    const { bars } = await loadReplayWindow(cfg.symbol, timeframe, cfg.startTime);
    return mount(
        container,
        { symbol: cfg.symbol, timeframe, clock: cfg.startTime, bars },
        (provider, window_, startIndex, { rechart, notify }) => new ReplayController({
            provider, bars: window_, startIndex, balance: cfg.balance,
            symbol: cfg.symbol, timeframe, rechart,
            ticks: cfg.ticks ? new TickFeed(cfg.ticks) : null,
            onPlayStateChange: () => syncControls(),
            onNotice: notify,
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
        (provider, window_, startIndex, { rechart, notify }) => new ReplayController({
            provider, bars: window_, startIndex, forming,
            symbol: record.symbol, timeframe: record.timeframe,
            restoreFrom: record.session,
            restoredSessionId: record.id,
            // What lets a session picked up today still go back to a candle from yesterday.
            journal: record.journal ?? null,
            ticks: record.ticks ? new TickFeed(record.ticks) : null,
            rechart,
            onPlayStateChange: () => syncControls(),
            onNotice: notify,
        }),
        theme,
    );
}
