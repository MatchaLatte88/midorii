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
     * What one point of price movement is worth, per unit, in the account's money.
     *
     * Absent — or null — means one, which is what a spot account is and what everything here
     * assumed before a futures contract was one of the things being traded: one NQ moving four
     * points is eighty dollars, not four, and a trade sized without knowing that is sized by
     * that multiple too large.
     *
     * Null rather than absent where a venue KNOWS it sometimes and not others: Capital.com can
     * state it from its own figures on most instruments and cannot on one that books in a
     * currency the account is not held in, until a position has shown it. The caller falls back
     * to one either way; the distinction is that a venue which cannot say must not say one.
     */
    pointValue?(): number | null;
    /**
     * The largest size at or below `size` this venue would accept, or 0 where none is.
     *
     * Sizing from risk produces a fraction; a venue takes whole contracts, or hundredths, or
     * whatever its own grid says. Asked here rather than left to the order call, because the
     * number has to be known BEFORE it is sent — it is the number the person is shown, and a
     * ticket that reads 1.6 and sends 2 has told them the wrong risk. Always downwards: a size
     * rounded up risks more than was asked for.
     *
     * Distinct from the `snapSize` helpers inside the venue controllers, which are the guard
     * on the way OUT and refuse rather than answer. This one is asked before anything is
     * sent, so it answers with a number a caller can show.
     */
    sizeOnGrid?(size: number): number;
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
    /**
     * Move a resting order to a new price.
     *
     * Optional, because not every account here HAS resting orders to move — a spot balance
     * with no working book has nothing to answer. Where it is absent the chart leaves those
     * lines where they are: a line that could be dragged and then silently sprang back would
     * be worse than one that was never draggable.
     */
    moveOrder?(orderId: number, price: number): void;
    /** Cancel one resting order — what the ✕ on its tag reaches. Optional for the same reason. */
    cancelOrder?(orderId: number): void;
    /** Redraw the chart from the account as it stands — after a refused edit, so what is
     *  on screen goes back to being what is true. */
    refreshVisuals(): void;
}
