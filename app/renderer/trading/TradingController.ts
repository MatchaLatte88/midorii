import type { Broker, Order, OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';

/**
 * What the chart needs from whatever is trading behind it.
 *
 * Two things trade in this app — a replay stepping through history and a paper
 * account running against a live feed — and the ways INTO a trade are the same for
 * both: a block drawn on the chart and right-clicked, a stop dragged to a new
 * level, the close button on an entry. Those wirings are written against this
 * interface rather than against either controller, so neither of them owns a
 * private copy of "what a drag on a stop line means".
 *
 * Deliberately small. It is the surface the CHART touches, not the surface a panel
 * does — the ticket and the dock take their own callbacks, and a transport (play,
 * pause, step) has no meaning at all for a live account.
 */
export interface TradingController {
    /** The newest price the account has been marked at, or 0 before there is one. */
    price(): number;
    /** The account itself — read for sizing and for the position a dragged level belongs to. */
    readonly broker: Broker;
    /** Place an order. Refusals come out as thrown errors, with the engine's own words. */
    order(spec: OrderSpec): Order;
    /** Put a stop and a target on an open position, replacing what it had. */
    protect(levels: ProtectionLevels, positionId?: number | null): void;
    /** Close one position outright, at market. */
    closeOne(positionId: number): void;
    /** Redraw the chart from the account as it stands — after a refused edit, so what is
     *  on screen goes back to being what is true. */
    refreshVisuals(): void;
}
