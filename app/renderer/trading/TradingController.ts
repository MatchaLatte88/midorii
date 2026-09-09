import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';

/**
 * A position, as far as the chart's own gestures need to know one.
 *
 * Three fields, because that is all a dragged level asks: which position it belongs to,
 * which way the trade goes, and what it is measured against. Deliberately not the engine's
 * own `Position` — a live account's positions are the venue's, not an engine's, and the
 * chart must be able to draw a stop on one without the engine existing at all.
 */
export interface ControlledPosition {
    id: number;
    /** Signed: above zero is long, below is short. */
    size: number;
    entryPrice: number;
}

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
    /**
     * What the account is worth, for sizing the next trade against.
     *
     * A method rather than the account object itself, because where the number COMES FROM
     * differs in kind: a paper account computes it, and a live one is told it by the venue.
     * Handing out an engine would make the second one pretend to be the first, and the
     * pretence would show up as a plausible, wrong balance at the moment of an order.
     */
    equity(): number;
    /** What is open right now — read to find the position a dragged level belongs to. */
    positions(): readonly ControlledPosition[];
    /**
     * Place an order.
     *
     * Anything the account can refuse OUTRIGHT — an unsized trade, a market it is not on —
     * comes straight back as a thrown error, in the engine's own words. A live venue can
     * also refuse an order it has already accepted delivery of, seconds later and for its
     * own reasons; that answer cannot come back through this call, and reaches the person
     * through whatever the controller was given to speak with.
     */
    order(spec: OrderSpec): void;
    /** Put a stop and a target on an open position, replacing what it had. */
    protect(levels: ProtectionLevels, positionId?: number | null): void;
    /** Close one position outright, at market. */
    closeOne(positionId: number): void;
    /** Redraw the chart from the account as it stands — after a refused edit, so what is
     *  on screen goes back to being what is true. */
    refreshVisuals(): void;
}
