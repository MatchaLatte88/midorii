import type { Broker } from '../../../shared/engine/broker.js';
import type { ReplayVisualState } from '../replay/replayIndicator';

/**
 * One entry in `Broker.fills`, as this file reads it.
 *
 * The engine types that list `unknown[]`, so the shape is stated here rather than assumed
 * anywhere else. `symbol` is not the engine's — see the stamp in `PaperController`.
 */
interface BrokerFill {
    orderId: number;
    time: number;
    price: number;
    side: 'buy' | 'sell';
    symbol?: string;
}

/**
 * The account, as the chart draws it.
 *
 * One function rather than one per controller: a replay and a paper account draw
 * the same position the same way, and two copies of this arithmetic would be two
 * chances for the R on a chart to disagree with the R in the run library.
 *
 * Everything is derived from the Broker as it stands, at the price given. Nothing
 * here is stored, and nothing here decides anything.
 *
 * `symbol` names the market the chart is on, and only the fills stamped with it are
 * handed over. An account that has moved between markets — which only a paper account
 * can do — still carries every fill it ever made, and marking a Bitcoin execution onto
 * an Ethereum candle would be drawing a price that never happened there. Omitted where
 * there is nothing to tell apart: a replay is one account on one market for its whole
 * life.
 */
export function visualState(broker: Broker, price: number, symbol?: string): ReplayVisualState {
    return {
        positions: broker.positions.map((p) => {
            /* Money a level is worth = the distance it would travel, times what is held.
             * R divides that by the risk the trade OPENED with (`riskPerUnit`), which is
             * the point of the unit: moving a stop must not restate what one R was. */
            const at = (level: number | null): number | null => (level == null ? null : (level - p.entryPrice) * p.size);
            const risk = p.riskPerUnit != null ? Math.abs(p.riskPerUnit * p.size) : null;
            const inR = (money: number | null): number | null => (money == null || !risk ? null : money / risk);
            const openPnl = (price - p.entryPrice) * p.size;
            return {
                id: p.id,
                side: p.size > 0 ? 'buy' as const : 'sell' as const,
                entryPrice: p.entryPrice,
                entryTime: p.openedAt,
                stopPrice: p.stopLoss,
                targetPrice: p.takeProfit,
                size: Math.abs(p.size),
                openPnl,
                stopPnl: at(p.stopLoss),
                targetPnl: at(p.takeProfit),
                openR: inR(openPnl),
                stopR: inR(at(p.stopLoss)),
                targetR: inR(at(p.takeProfit)),
            };
        }),
        orders: broker.pending
            // reduce-only legs are a position's own stop/target — that position
            // already draws them as its levels, so they are not resting orders.
            .filter((o) => !o.reduceOnly)
            .map((o) => ({ id: o.id, side: o.side, price: o.limitPrice ?? o.stopPrice, tag: o.tag }))
            .filter((o): o is { id: number; side: 'buy' | 'sell'; price: number; tag: string | null } => o.price != null),
        fills: (broker.fills as BrokerFill[])
            .filter((f) => symbol == null || f.symbol === symbol)
            .map((f) => ({ id: f.orderId, time: f.time, price: f.price, side: f.side })),
    };
}
