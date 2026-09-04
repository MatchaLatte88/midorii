import { registerIcon, registerWidgetAction } from '../../../src/plugin';
import type { VelaWorkspace } from '../../../src/workspace';
import { SPEEDS, type ReplayController } from './ReplayController';
import { armOrderTool } from './replayOrders';

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

/** Whether a chart belongs to the running replay — the gate the other way round,
 *  for actions that make sense everywhere EXCEPT inside a session. */
export function isReplayChart(chart: unknown): boolean {
    return active != null && active.ws.chart === chart;
}

function registerControls(): void {
    const playing = active?.controller.playing ?? false;
    const speed = active?.controller.speed ?? SPEEDS[2];

    registerWidgetAction({
        id: 'replay.step',
        target: 'topbar',
        align: 'right',
        order: 1,
        iconOnly: true,
        label: 'Step one bar',
        icon: 'replay-step',
        when: onActiveChart,
        run: () => active?.controller.step(),
    });

    registerWidgetAction({
        id: 'replay.skip',
        target: 'topbar',
        align: 'right',
        order: 2,
        iconOnly: true,
        label: 'Skip 10 bars',
        icon: 'replay-skip',
        when: onActiveChart,
        run: () => active?.controller.skip(10),
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
            const next = SPEEDS[(SPEEDS.indexOf(active.controller.speed as typeof SPEEDS[number]) + 1) % SPEEDS.length]!;
            active.controller.setSpeed(next);
            refreshControls();
            ctx.toast(`Replay speed ${next} bars/sec`);
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
            ctx.toast('Click the entry, drag to the target');
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
