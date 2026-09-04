import { orderFromPlan, sizingEntry, sizingStop } from '../../../shared/engine/plannedTrade.js';
import type { PlanMode } from '../../../shared/engine/plannedTrade.js';
import { positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import type { Vela } from '../../../src';
import type { ReplayController } from './ReplayController';

/** Vela's built-in click-drag entry/stop/target tool. */
const POSITION_TOOL = 'position';

export interface RiskSettings {
    mode: RiskMode;
    /** Percent of equity, or cash — read per `mode`. */
    value: number;
    /** Notional ceiling as a multiple of equity. */
    maxLeverage: number;
}

export const DEFAULT_RISK: RiskSettings = { mode: 'percent', value: 1, maxLeverage: 1 };

export interface OrderEntryOptions {
    chart: Vela;
    controller: ReplayController;
    risk?: RiskSettings;
    /** How a drawn block is read: fill now at the market, or rest at the drawn entry. */
    mode?: PlanMode;
    /** Feedback for the user — a rejected block explains itself instead of failing mute. */
    notify?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Turns Vela's own position drawing into a replay order.
 *
 * Vela already ships the interaction (click = entry, drag = target, stop derived
 * from R:R), so there is no custom click handling here: arm the tool, read the
 * finished block's anchors, translate them with the same `plannedTrade` code the
 * old app used, and take the drawing away again — from then on the position is
 * drawn by the replay indicator, which is state, not something the user can drag.
 *
 * Returns an unsubscribe function.
 */
export function wireOrderEntry(opts: OrderEntryOptions): () => void {
    const { chart, controller } = opts;
    const risk = opts.risk ?? DEFAULT_RISK;
    const mode: PlanMode = opts.mode ?? 'market';
    const notify = opts.notify ?? (() => {});

    return chart.on('drawing:created', ({ id }) => {
        const doc = chart.drawings.all().find((d) => d.id === id);
        if (!doc || doc.type !== POSITION_TOOL) return;

        // PositionTool.onPlaced rewrites its anchors to exactly [entry, stop, target].
        const [entry, stop, target] = doc.anchors;
        try {
            if (!entry || !stop) throw new Error('The block has no entry and stop to read.');

            const spec = orderFromPlan(
                { entry: entry.price, stop: stop.price, target: target?.price ?? null },
                { price: controller.session.bar.close, mode },
            );

            const sizeEntry = sizingEntry(spec, controller.session.bar.close);
            const size = positionSize(
                controller.session.broker.equity,
                sizeEntry,
                sizingStop(spec, sizeEntry),
                risk.mode,
                risk.value,
                risk.maxLeverage,
            );
            if (size == null) throw new Error('This block cannot be sized against the account.');

            controller.order({
                side: spec.side,
                type: spec.type,
                size,
                ...(spec.type === 'limit' ? { limitPrice: spec.price! } : {}),
                ...(spec.type === 'stop' ? { stopPrice: spec.price! } : {}),
                bracket: spec.bracket,
                tag: 'manual',
            });
            notify(`${spec.side === 'buy' ? 'Long' : 'Short'} ${size.toFixed(4)} placed`, 'info');
        } catch (e) {
            // orderFromPlan names the anchor to move; surface that rather than swallowing it.
            notify(e instanceof Error ? e.message : String(e), 'error');
        } finally {
            // The interactive block has done its job either way. Leaving it would
            // put a draggable copy of the position on the chart that the account
            // knows nothing about.
            chart.drawings.remove(id);
            chart.drawings.setTool(null);
        }
    });
}

/** Arm the position tool for one placement. */
export function armOrderTool(chart: Vela): void {
    chart.drawings.setStayMode(false);
    chart.drawings.setTool(POSITION_TOOL);
}
