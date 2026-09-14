import { rMultiple } from '../format';

/**
 * What is open and what is waiting, as rows.
 *
 * The engine holds positions and orders in the shape it needs to match them against bars; this
 * is the shape a person reads. Every number still comes off the Broker as it stands — nothing
 * here keeps a tally of its own, for the reason the account readout gives.
 *
 * Kept apart from the dock that paints it so the rows can be asserted without a DOM.
 */

/** The position fields a row reads. The engine's `Position` satisfies it. */
export interface BookPosition {
    id: number;
    size: number;
    entryPrice: number;
    openedAt: number;
    stopLoss: number | null;
    takeProfit: number | null;
    trailing: unknown;
    riskPerUnit: number | null;
    entryTag: string | null;
}

/** The order fields a row reads. The engine's `Order` satisfies it. */
export interface BookOrder {
    id: number;
    side: 'buy' | 'sell';
    type: string;
    size: number;
    limitPrice: number | null;
    stopPrice: number | null;
    reduceOnly: boolean;
    tag: string | null;
}

/** The slice of the Broker a book needs. The real `Broker` satisfies it. */
export interface BookSource {
    positions: readonly BookPosition[];
    pending: readonly BookOrder[];
    /** Nullable, because the engine's own signature is — a row never passes null. */
    positionPnl(position: BookPosition | null): number;
    /** Money per point per unit. Absent means one. */
    readonly pointValue?: number;
    exitResult(position: BookPosition, price: number): number;
    breakEvenRefusal(position: BookPosition): string | null;
}

export interface PositionRow {
    id: number;
    side: 'long' | 'short';
    /** Always positive — the side says the direction. */
    size: number;
    entryPrice: number;
    openedAt: number;
    stopLoss: number | null;
    takeProfit: number | null;
    /** The stop is following price rather than standing still. */
    trailing: boolean;
    entryTag: string | null;
    /** Profit if it closed at the last price, costs included. */
    unrealized: number;
    /** That profit against what the position risked when it opened, or null without a stop. */
    r: number | null;
    /**
     * What the stop would leave behind if it filled: negative while it is protection, positive
     * once it sits past break-even. Null when the position has no stop — which is not zero
     * risk, it is an amount nobody knows.
     */
    stopResult: number | null;
    /** Why moving the stop to break-even is refused right now, or null when it can be done. */
    breakEvenRefusal: string | null;
}

export interface OrderRow {
    id: number;
    side: 'buy' | 'sell';
    type: string;
    size: number;
    /** Where it waits — a limit's price, or a stop's trigger. */
    price: number | null;
    tag: string | null;
}

export interface TradeBook {
    positions: PositionRow[];
    orders: OrderRow[];
}

/** The trade fields a history row reads. The engine's closed trade satisfies it. */
export interface ClosedTrade {
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
    fees: number;
    entryTag: string | null;
    exitTag: string | null;
    riskPerUnit: number | null;
    /** What a point was worth on the account that closed it. Absent on older records. */
    pointValue?: number;
}

/** One closed round trip, as a person reads it. */
export interface HistoryRow {
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
    fees: number;
    /** The result against what the trade risked when it opened, or null without a stop. */
    r: number | null;
    /** How it ended: the exit tag the engine recorded ('stop', 'target', 'manual', …). */
    exitTag: string | null;
}

/**
 * What the account has already done, newest first.
 *
 * Reversed here rather than in the view: "newest first" is a statement about how a
 * history is read, and a second list that sorted it differently would be a second
 * answer to the same question.
 */
export function tradeHistory(trades: readonly ClosedTrade[]): HistoryRow[] {
    const rows = trades.map((t): HistoryRow => ({
        side: t.side,
        size: t.size,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        netPnl: t.netPnl,
        fees: t.fees,
        // The same R the run library reports afterwards, measured against the same unit.
        r: rMultiple({ netPnl: t.netPnl, size: t.size, riskPerUnit: t.riskPerUnit, pointValue: t.pointValue }),
        exitTag: t.exitTag,
    }));
    rows.reverse();
    return rows;
}

/** The position fields a venue row reads. Both venue controllers' positions satisfy it. */
export interface VenuePosition {
    id: number;
    /** Signed: above zero is long, below is short. */
    size: number;
    entryPrice: number;
    openedAt: number;
    stopLoss: number | null;
    takeProfit: number | null;
    /** The stop follows price. Absent on a venue whose stops cannot. */
    trailing?: boolean;
}

/** The order fields a venue row reads. */
export interface VenueOrder {
    id: number;
    side: 'buy' | 'sell';
    /** Where it waits. */
    price: number;
    size: number;
    /** `limit` or `stop`, in the app's own vocabulary. */
    kind: 'limit' | 'stop';
}

/**
 * What a VENUE says is open, as the same rows.
 *
 * The counterpart of {@link tradeBook} for an account no engine is behind. Three of the row's
 * figures cannot be filled in and are left null rather than invented: R and the stop's result
 * both need the risk a trade OPENED with, which a venue does not record. A break-even refusal
 * comes from the controller where it has one, and is null otherwise. The unrealized figure comes in from
 * the caller, because where it comes from differs in kind — Capital.com states its own, and
 * a spot balance has none until somebody computes one.
 *
 * Resting orders come through unfiltered, unlike an engine's: a venue's protective legs are
 * held apart from its working orders already, in the controller, so there is nothing here to
 * sort out.
 */
export function venueBook<P extends VenuePosition>(
    positions: readonly P[],
    orders: readonly VenueOrder[],
    unrealized: (position: P) => number,
    /** Why break-even is refused for a position — for a venue controller that has a view. */
    breakEvenRefusal: (position: P) => string | null = () => null,
): TradeBook {
    return {
        positions: positions.map((p): PositionRow => ({
            id: p.id,
            side: p.size > 0 ? 'long' : 'short',
            size: Math.abs(p.size),
            entryPrice: p.entryPrice,
            openedAt: p.openedAt,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            trailing: p.trailing === true,
            entryTag: null,
            unrealized: unrealized(p),
            r: null,
            stopResult: null,
            breakEvenRefusal: breakEvenRefusal(p),
        })),
        orders: orders.map((o): OrderRow => ({
            id: o.id,
            side: o.side,
            type: o.kind,
            size: o.size,
            price: o.price,
            tag: null,
        })),
    };
}

export function tradeBook(broker: BookSource): TradeBook {
    const positions = broker.positions.map((p): PositionRow => {
        const size = Math.abs(p.size);
        const unrealized = broker.positionPnl(p);
        return {
            id: p.id,
            side: p.size > 0 ? 'long' : 'short',
            size,
            entryPrice: p.entryPrice,
            openedAt: p.openedAt,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            trailing: p.trailing != null,
            entryTag: p.entryTag,
            unrealized,
            // The same R the run library reports afterwards, measured against the same unit.
            r: rMultiple({ netPnl: unrealized, size, riskPerUnit: p.riskPerUnit, pointValue: broker.pointValue }),
            stopResult: p.stopLoss == null ? null : broker.exitResult(p, p.stopLoss),
            breakEvenRefusal: broker.breakEvenRefusal(p),
        };
    });

    /* A position's own stop and target are reduce-only legs of it, and the position already
     * shows them as its levels. Listing them again as resting orders would offer two ways to
     * cancel the same protection, one of which leaves the position looking protected. */
    const orders = broker.pending
        .filter((o) => !o.reduceOnly)
        .map((o): OrderRow => ({
            id: o.id,
            side: o.side,
            type: o.type,
            size: o.size,
            price: o.limitPrice ?? o.stopPrice,
            tag: o.tag,
        }));

    return { positions, orders };
}
