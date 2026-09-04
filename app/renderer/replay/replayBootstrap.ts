import { VelaWorkspace } from '../../../src/workspace';
import { barIndexAt } from '../../../shared/engine/replaySession.js';
import type { ReplayBar } from '../../../shared/engine/replaySession.js';
import { BRAND } from '../about/brand';
import { LocalArchiveProvider } from '../providers/LocalArchiveProvider';
import { ReplayController } from './ReplayController';
import { ReplayProvider } from './ReplayProvider';
import { setActiveReplay, syncControls } from './replayActions';
import { REPLAY_INDICATOR_TYPE, registerReplayIndicator } from './replayIndicator';
import { wireOrderEntry } from './replayOrders';
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
): Promise<MountedReplay> {
    const archive = new LocalArchiveProvider();
    // Underscore, not hyphen: Vela parses a symbol's `provider:` prefix as
    // `[A-Za-z0-9_.]+` — a hyphen makes the prefix unparseable and the provider is
    // then never found (the chart just stays empty, with no error anywhere).
    // A per-session name also keeps the shared closed-bar cache from serving one
    // session's bars to the next one on the same symbol/timeframe.
    const providerName = `replay_${Date.now().toString(36)}`;
    const provider = new ReplayProvider(archive, providerName, cfg.timeframe, cfg.clock);

    const ws = new VelaWorkspace(container, {
        layout: false,
        live: true,
        theme: 'dark',
        symbol: `${providerName}:${cfg.symbol}`,
        timeframe: cfg.timeframe,
        brand: BRAND,
        providers: { [providerName]: () => provider },
    });
    await ws.chart.ready();

    const controller = makeController(provider, cfg.bars, barIndexAt(cfg.bars, cfg.clock - 1));

    // Added straight on the chart, not through the widget context: the replay's
    // visuals are recomputed state, so they must stay out of the undo timeline
    // and out of the persisted indicator ledger.
    registerReplayIndicator();
    controller.attachIndicator(ws.chart.addNativeIndicator(REPLAY_INDICATOR_TYPE));

    // Vela's own position tool becomes the order ticket.
    wireOrderEntry({
        chart: ws.chart,
        controller,
        notify: (message, kind) => ws.toast(message, kind === 'error' ? 'error' : 'info'),
    });

    // Transport controls into Vela's own topbar.
    setActiveReplay({ controller, ws });

    followChartTimeframe(ws, controller);

    return { ws, provider, controller };
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

/** Start a fresh replay at `startTime`, on the default timeframe. */
export async function startReplay(container: HTMLElement, cfg: ReplaySetup): Promise<MountedReplay> {
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
export async function resumeReplay(container: HTMLElement, sessionId: string): Promise<MountedReplay> {
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
    );
}
