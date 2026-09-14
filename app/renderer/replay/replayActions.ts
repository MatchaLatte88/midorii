import { registerIcon, registerWidgetAction } from '../../../src/plugin';
import type { VelaWorkspace } from '../../../src/workspace';
import { SPEEDS, type ReplayController } from './ReplayController';
import { armOrderTool } from './replayOrders';
import { lastCrosshairTime } from '../alerts/cursorPrice';
import { askSetupStrategy, findNextSetup, loadSetupStrategy, saveSetupStrategy, strategyName } from './setupStrategy';

/**
 * The replay controls, contributed into Vela's own topbar — no custom chrome.
 *
 * `WidgetActionDescriptor.label`/`icon` are static, so a button whose face
 * changes (play/pause, the speed readout) is re-registered under the same id
 * and the shell asked to refresh — re-registering an id replaces it. Every
 * action is gated on the chart the active session belongs to, so none of them
 * appear on the walking-skeleton chart.
 */

let active: ActiveReplay | null = null;

export interface ActiveReplay {
    controller: ReplayController;
    ws: VelaWorkspace;
}

const ICONS: Record<string, string> = {
    'replay-step': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5 10.5 8 5 12.5"/><path d="M12 3.5v9"/></svg>',
    'replay-ticks': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 9h2l1.5-4 2 7 2-9 2 6 1-2h2.5"/></svg>',
    'replay-bars': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5v11M12 2.5v11"/><rect x="2.5" y="5" width="3" height="6" rx="0.5"/><rect x="10.5" y="4" width="3" height="5" rx="0.5"/></svg>',
    'replay-setup': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="8" r="3.5"/><path d="M6.5 3v1.5M6.5 11.5V13M1.5 8H3M10 8h1.5"/><path d="M12 5.5 14.5 8 12 10.5"/></svg>',
    'replay-skip': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5 7 8l-4.5 4.5"/><path d="M8 3.5 12.5 8 8 12.5"/></svg>',
    'replay-play': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M4.5 3.2v9.6L12.8 8z"/></svg>',
    'replay-pause': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><rect x="4" y="3.2" width="3" height="9.6" rx="0.6"/><rect x="9" y="3.2" width="3" height="9.6" rx="0.6"/></svg>',
    'replay-flatten': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
    'replay-order': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="11" height="4.5" rx="0.8"/><path d="M2.5 11.5h11"/><path d="M8 2v2M8 8.5v3"/></svg>',
    'replay-park': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h8.5L13 4v9.5H3z"/><path d="M5.5 2.5v4h5v-4"/></svg>',
    'replay-finish': '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>',
};

let iconsRegistered = false;
function ensureIcons(): void {
    if (iconsRegistered) return;
    iconsRegistered = true;
    for (const [id, markup] of Object.entries(ICONS)) registerIcon(id, markup);
}

/** The gate: an action is only shown on the chart its session drives. */
function onActiveChart(ctx: { chart: unknown }): boolean {
    return active != null && active.ws.chart === ctx.chart;
}

/**
 * Whether this context is the running replay's — the gate the other way round, for actions
 * that make sense everywhere EXCEPT inside a session.
 *
 * Takes the CONTEXT, not the chart, so `active` is tested first: a shell evaluates every
 * `when()` while it builds its topbar, which is before it has an active cell, and reading
 * `ctx.chart` at that moment throws. Short-circuiting past it is what `onActiveChart`
 * above already does, for the same reason.
 */
export function isReplayContext(ctx: { readonly chart: unknown }): boolean {
    return active != null && active.ws.chart === ctx.chart;
}

/** Put a failed transport call in front of the person who pressed it. */
function report(ctx: { toast(message: string, kind?: 'info' | 'error' | 'success'): void }) {
    return (e: unknown): void => ctx.toast(e instanceof Error ? e.message : String(e), 'error');
}

function registerControls(): void {
    const playing = active?.controller.playing ?? false;
    const speed = active?.controller.speed ?? SPEEDS[2];
    const onTicks = active?.controller.mode === 'ticks';

    registerWidgetAction({
        id: 'replay.step',
        target: 'topbar',
        align: 'right',
        order: 1,
        iconOnly: true,
        label: onTicks ? 'Play to the end of this candle' : 'Step one bar',
        icon: 'replay-step',
        when: onActiveChart,
        run: (ctx) => {
            void active?.controller.stepForward().then(refreshControls).catch(report(ctx));
        },
    });

    registerWidgetAction({
        id: 'replay.skip',
        target: 'topbar',
        align: 'right',
        order: 2,
        iconOnly: true,
        label: onTicks ? 'Play ten candles on' : 'Skip 10 bars',
        icon: 'replay-skip',
        when: onActiveChart,
        run: (ctx) => {
            void active?.controller.skipForward(10).then(refreshControls).catch(report(ctx));
        },
    });

    /* Candles or ticks — only where the session has a recording to play. The face says what a
     * press switches TO, the way the play button does. */
    registerWidgetAction({
        id: 'replay.playMode',
        target: 'topbar',
        align: 'right',
        order: 0.5,
        iconOnly: true,
        label: onTicks ? 'Play on candles' : 'Play the recorded ticks',
        icon: onTicks ? 'replay-bars' : 'replay-ticks',
        when: (ctx) => onActiveChart(ctx) && active?.controller.ticks != null,
        run: (ctx) => {
            if (!active) return;
            const next = active.controller.mode === 'ticks' ? 'bars' : 'ticks';
            void active.controller.setPlayMode(next)
                .then(() => {
                    refreshControls();
                    ctx.toast(next === 'ticks'
                        ? 'Playing the recorded prints and quotes — the Ladder and the Tape follow them.'
                        : 'Playing candles, one bar at a time.');
                })
                .catch(report(ctx));
        },
    });

    registerWidgetAction({
        id: 'replay.nextSetup',
        target: 'topbar',
        align: 'right',
        order: 2.5,
        iconOnly: true,
        label: 'Skip to the next setup',
        icon: 'replay-setup',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const { controller, ws } = active;
            void (async () => {
                let id = loadSetupStrategy();
                if (!id) {
                    id = await askSetupStrategy(ws.root, null);
                    if (!id) return;
                    saveSetupStrategy(id);
                }
                // Stepping under a running timer would interleave two playheads' worth of bars.
                controller.pause();
                refreshControls();
                const index = await findNextSetup(controller, id);
                if (index == null) {
                    ctx.toast(`No ${strategyName(id)} setup before the end of the loaded bars.`);
                    return;
                }
                const stepped = await controller.skipToIndex(index);
                ctx.toast(`${strategyName(id)} setup — ${stepped} ${stepped === 1 ? 'candle' : 'candles'} on.`, 'success');
            })().catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });

    registerWidgetAction({
        id: 'replay.playPause',
        target: 'topbar',
        align: 'right',
        order: 3,
        iconOnly: true,
        label: playing ? 'Pause' : 'Play',
        icon: playing ? 'replay-pause' : 'replay-play',
        when: onActiveChart,
        run: () => {
            if (!active) return;
            if (active.controller.playing) active.controller.pause();
            else active.controller.play();
            refreshControls();
        },
    });

    // A cycling button rather than a dropdown: five fixed steps, and a
    // WidgetContext carries no trigger element to anchor a menu to.
    registerWidgetAction({
        id: 'replay.speed',
        target: 'topbar',
        align: 'right',
        order: 4,
        label: `${speed}×`,
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            const { speeds } = active.controller;
            const next = speeds[(speeds.indexOf(active.controller.speed) + 1) % speeds.length]!;
            active.controller.setSpeed(next);
            refreshControls();
            ctx.toast(active.controller.mode === 'ticks' ? `Ticks at ${next}× real time` : `Replay speed ${next} bars/sec`);
        },
    });

    registerWidgetAction({
        id: 'replay.order',
        target: 'topbar',
        align: 'right',
        order: 5,
        iconOnly: true,
        label: 'Draw an order',
        icon: 'replay-order',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            armOrderTool(active.ws.chart);
            ctx.toast('Click the entry, drag to the target — then right-click the block to order');
        },
    });

    registerWidgetAction({
        id: 'replay.flatten',
        target: 'topbar',
        align: 'right',
        order: 6,
        iconOnly: true,
        label: 'Close all positions',
        icon: 'replay-flatten',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            if (active.controller.session.broker.isFlat) {
                ctx.toast('Nothing open to close');
                return;
            }
            active.controller.flatten();
            ctx.toast('Positions closed');
        },
    });

    registerWidgetAction({
        id: 'replay.park',
        target: 'topbar',
        align: 'right',
        order: 7,
        iconOnly: true,
        label: 'Pause session for later',
        icon: 'replay-park',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            void active.controller
                .saveSession()
                .then(() => {
                    refreshControls(); // playback stopped as part of saving
                    ctx.toast('Session put down — pick it up later');
                })
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });

    registerWidgetAction({
        id: 'replay.finish',
        target: 'topbar',
        align: 'right',
        order: 8,
        iconOnly: true,
        label: 'End and save as run',
        icon: 'replay-finish',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            void active.controller
                .saveAsRun()
                .then(() => {
                    refreshControls();
                    ctx.toast('Saved to the results library', 'success');
                })
                // The boundary refuses a session with no trades — say so plainly.
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });
}

/** `2026-09-14 14:35`, in UTC — the replay's clock is UTC, and so is its setup dialog. */
function candleLabel(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Right-click a candle, go back to it.
 *
 * On the chart's own context menu rather than in the topbar, because the question it answers
 * is "which candle" and the pointer has already answered it. Only over a candle — over the
 * empty space to the right of the newest one there is nothing to go back to.
 */
function registerJumpHere(): void {
    registerWidgetAction({
        id: 'replay.setupStrategy',
        target: 'context:body',
        label: 'Next setup: choose strategy…',
        when: onActiveChart,
        run: (ctx) => {
            if (!active) return;
            void askSetupStrategy(active.ws.root, loadSetupStrategy()).then((id) => {
                if (!id) return;
                saveSetupStrategy(id);
                ctx.toast(`Next setup now looks for ${strategyName(id)}.`);
            });
        },
    });

    registerWidgetAction({
        id: 'replay.jumpHere',
        target: 'context:body',
        label: 'Jump back here',
        when: (ctx) => onActiveChart(ctx) && lastCrosshairTime() != null,
        run: (ctx) => {
            const time = lastCrosshairTime();
            if (!active || time == null) return;
            const { controller } = active;
            void controller.jumpTo(time)
                .then(() => {
                    refreshControls(); // playback was stopped for the rebuild
                    ctx.toast(`Back at ${candleLabel(time)} UTC — everything done after it is gone.`, 'success');
                })
                .catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error'));
        },
    });
}

/** Re-register (faces are static) and let the shell rebuild its topbar. */
function refreshControls(): void {
    registerControls();
    active?.ws.refreshActions();
}

/** Point the replay controls at a mounted session — or `null` to retire them. */
export function setActiveReplay(next: ActiveReplay | null): void {
    ensureIcons();
    const previous = active;
    active = next;
    registerControls();
    registerJumpHere();
    next?.ws.refreshActions();
    if (previous && previous !== next) previous.ws.refreshActions();
}

/**
 * Keep the play/pause face honest when playback stops on its own (the session
 * reaching its last bar), which no click told the topbar about.
 */
export function syncControls(): void {
    refreshControls();
}
