import { orderFromPlan, sizingEntry, sizingStop } from '../../../shared/engine/plannedTrade.js';
import type { BracketMode, PlanMode } from '../../../shared/engine/plannedTrade.js';
import { positionSize } from '../../../shared/strategies/risk.js';
import type { RiskMode } from '../../../shared/strategies/risk.js';
import { Menu } from '../../../src/ui';
import { formatSize } from '../format';
import type { Vela } from '../../../src';
import type { TradingController } from '../trading/TradingController';
import type { OrderSpec } from '../../../shared/engine/broker.js';

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
    controller: TradingController;
    /** Where the order menu mounts — pass the workspace root so it inherits the theme tokens. */
    host?: HTMLElement;
    /**
     * How much a trade may lose, read at the moment one is placed rather than captured here.
     * The ticket panel is where these are set and they change mid-session; a copy taken at
     * wiring time would size every block by whatever they happened to be when the chart opened.
     */
    risk?: () => RiskSettings;
    /** Feedback for the user — a rejected block explains itself instead of failing mute. */
    notify?: (message: string, kind: 'info' | 'error') => void;
    /**
     * A last word before the order goes, which refuses by throwing.
     *
     * Where the session limits are applied. It is a hook rather than a check written into this
     * file because a block traded from the chart is only one of three ways in, and all three
     * have to meet the same limit — so the rule lives with whoever mounted them, and each way
     * in asks it rather than owning a copy.
     */
    beforeOrder?: (spec: OrderSpec) => void;
}

/** Price formatting for the menu's hints — enough decimals to name a level, no more. */
function level(n: number): string {
    return Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(4);
}

/**
 * Turns Vela's own position drawing into a replay order — on request, not on sight.
 *
 * The block is a PLAN first. Drawing one does not trade it, exactly as in a normal chart:
 * you draw it, drag its levels around, and decide afterwards. Right-clicking it asks how to
 * trade it, and only that answer places an order:
 *
 *   Market    fills now, at the price everyone can see. The drawn entry is a level the
 *             market has usually left behind, so it is not what the fill is; what happens
 *             to the drawn stop and target is the block's own `bracketMode` — the levels as
 *             drawn, or their distances measured off the actual fill.
 *
 *   Pending   rests at the drawn entry. Limit or stop is not a second question: it follows
 *             from which side of the market that entry sits on.
 *
 * Sizing is the account's, not the drawing's: the risk settings decide how much of the
 * equity the distance to the stop is allowed to cost.
 *
 * Returns an unsubscribe function.
 */
export function wireOrderEntry(opts: OrderEntryOptions): () => void {
    const { chart, controller } = opts;
    const riskNow = opts.risk ?? ((): RiskSettings => DEFAULT_RISK);
    const notify = opts.notify ?? (() => {});
    const host = opts.host ?? document.body;

    let armed: string | null = null; // the block the open menu is about
    const menu = new Menu({
        host,
        items: [],
        placement: 'bottom-start',
        // Pointer-anchored action menu — the same shape the chart's own right-click menu uses.
        checkmarks: true,
        onSelect: (id) => {
            const target = armed;
            armed = null;
            if (target && (id === 'market' || id === 'pending')) place(target, id);
        },
    });

    /** Read a block's anchors, size it against the account, send it. */
    function place(id: string, mode: PlanMode): void {
        const doc = chart.drawings.all().find((d) => d.id === id);
        if (!doc || doc.type !== POSITION_TOOL) return;

        // PositionTool.onPlaced rewrites its anchors to exactly [entry, stop, target].
        const [entry, stop, target] = doc.anchors;
        try {
            if (!entry || !stop) throw new Error('The block has no entry and stop to read.');

            const spec = orderFromPlan(
                { entry: entry.price, stop: stop.price, target: target?.price ?? null },
                {
                    price: controller.price(),
                    mode,
                    bracket: (doc as { bracketMode?: BracketMode }).bracketMode ?? 'levels',
                },
            );

            const risk = riskNow();
            const sizeEntry = sizingEntry(spec, controller.price());
            /* Prices into account money before they are sized against, for the reason the
             * ticket panel gives: a point of an instrument is not always one of whatever the
             * account is kept in, and on a futures contract it is twenty of them. One is what
             * a spot account is, and what this did before contracts were tradeable here. */
            const value = controller.pointValue?.() ?? 1;
            const wanted = positionSize(
                controller.equity(),
                sizeEntry * value,
                sizingStop(spec, sizeEntry) * value,
                risk.mode,
                risk.value,
                risk.maxLeverage,
            );
            if (wanted == null) throw new Error('This block cannot be sized against the account.');

            /* On the venue's own grid before it goes, so the size reported below is the size
             * that was sent. A block that sizes to less than the smallest deal is refused
             * here rather than raised to one — the block said how much this may lose. */
            const size = controller.sizeOnGrid ? controller.sizeOnGrid(wanted) : wanted;
            if (!(size > 0)) {
                throw new Error('This block sizes to less than the smallest trade this instrument takes.');
            }

            const order: OrderSpec = {
                side: spec.side,
                type: spec.type,
                size,
                ...(spec.type === 'limit' ? { limitPrice: spec.price! } : {}),
                ...(spec.type === 'stop' ? { stopPrice: spec.price! } : {}),
                bracket: spec.bracket,
                tag: 'manual',
            };
            // Refuses by throwing, and the block stays where it is so the reason can be acted on.
            opts.beforeOrder?.(order);
            controller.order(order);
            notify(`${spec.side === 'buy' ? 'Long' : 'Short'} ${formatSize(size)} placed`, 'info');
            /* Only now does the block go: from here the position (or the resting order) is
             * drawn by the replay indicator, which is state. Leaving the drawing would put a
             * draggable copy on the chart that the account knows nothing about. A REJECTED
             * block stays exactly where it was — its message says which anchor to move, and
             * the user cannot move an anchor that has been deleted. */
            chart.drawings.remove(id);
        } catch (e) {
            // orderFromPlan names the anchor to move; surface that rather than swallowing it.
            notify(e instanceof Error ? e.message : String(e), 'error');
        }
    }

    // Vela has no per-drawing menu of its own: this is what makes it report the press to us
    // (and keep the chart's own menu shut for it) instead of treating it as any other click.
    chart.drawings.setContextMenu(true);

    const off = chart.on('drawing:contextmenu', ({ id, x, y }) => {
        const doc = chart.drawings.all().find((d) => d.id === id);
        if (!doc || doc.type !== POSITION_TOOL) return;
        const entry = doc.anchors[0];
        armed = id;
        menu.setItems([
            { id: 'market', label: 'Market order', hint: level(controller.price()) },
            { id: 'pending', label: 'Pending order', hint: entry ? level(entry.price) : undefined },
        ]);
        menu.openAt(x, y);
    });

    return () => {
        off();
        chart.drawings.setContextMenu(false);
        menu.destroy();
    };
}

/** Arm the position tool for one placement. */
export function armOrderTool(chart: Vela): void {
    chart.drawings.setStayMode(false);
    chart.drawings.setTool(POSITION_TOOL);
}
