import type { ReplaySession } from '../../../shared/engine/replaySession.js';
import type { OrderSpec, ProtectionLevels } from '../../../shared/engine/broker.js';

/**
 * Every call that changes a replay's account, in one table.
 *
 * Two things run these: the controller, when a person clicks, and the journal, when a session
 * is rebuilt to an earlier candle (see replayJournal.ts). They must be the same calls — a
 * rebuild that closed a position one way and a click that closed it another would put a
 * different account under the chart than the one that was actually traded — so neither keeps
 * its own copy. The controller's methods are one line each onto this; the journal replays the
 * same names with the same arguments.
 *
 * Nothing here pushes visuals or records anything. It is the account, and only the account.
 */

export type ReplayOp =
    | 'buy'
    | 'sell'
    | 'order'
    | 'close'
    | 'flatten'
    | 'cancelAll'
    | 'protect'
    | 'breakEven'
    | 'closeOne'
    | 'closePart'
    | 'reverse'
    | 'setTrailing'
    | 'modifyOrder'
    | 'cancelOrder';

export const REPLAY_OPS: readonly ReplayOp[] = [
    'buy', 'sell', 'order', 'close', 'flatten', 'cancelAll', 'protect', 'breakEven',
    'closeOne', 'closePart', 'reverse', 'setTrailing', 'modifyOrder', 'cancelOrder',
];

/** Run one account call. Throws exactly what the engine throws. */
export function applyOp(session: ReplaySession, op: ReplayOp, args: readonly unknown[]): unknown {
    const a = args as unknown[];
    switch (op) {
        case 'buy': return session.buy((a[0] ?? {}) as Partial<OrderSpec>);
        case 'sell': return session.sell((a[0] ?? {}) as Partial<OrderSpec>);
        case 'order': return session.order(a[0] as OrderSpec);
        case 'close': return session.close(a[0] as string | undefined);
        case 'flatten': return session.flatten();
        case 'cancelAll': return session.cancelAll(a[0] as string | undefined);
        case 'protect': return session.protect(a[0] as ProtectionLevels, (a[1] ?? null) as number | null);
        case 'breakEven': return session.breakEven((a[0] ?? null) as number | null);
        case 'closeOne': {
            /* Not `closePart` with the position's own size: that books the exit as a scale-out,
             * and the tag is what the trade record ends up saying about how it ended. */
            const broker = session.broker;
            const order = broker.closePosition('manual', { positionId: a[0] as number });
            if (order) broker.fillNow(order);
            return undefined;
        }
        case 'closePart': return session.closePart(a[0] as number, (a[1] ?? null) as number | null);
        case 'reverse': return session.reverse((a[0] ?? null) as number | null);
        case 'setTrailing': return session.setTrailing(
            a[0] as number,
            (a[1] ?? {}) as { activateAt?: number },
            (a[2] ?? null) as number | null,
        );
        case 'modifyOrder': return session.modifyOrder(a[0] as number, a[1] as Partial<OrderSpec>);
        case 'cancelOrder': return session.broker.cancelOrder(a[0] as number);
    }
}

/**
 * Where each call names a position or an order by id, so the journal can carry the reference
 * rather than the number.
 *
 * Ids are handed out by a counter the whole app shares, so a rebuilt account gives the same
 * position a different id than it had the first time. What does not change is WHICH one it
 * was — the third position this session opened is the third again — and that is what these
 * say where to find.
 */
export const OP_REFS: Readonly<Record<ReplayOp, { positions?: readonly number[]; orders?: readonly number[]; spec?: number }>> = {
    buy: { spec: 0 },
    sell: { spec: 0 },
    order: { spec: 0 },
    close: {},
    flatten: {},
    cancelAll: {},
    protect: { positions: [1] },
    breakEven: { positions: [0] },
    closeOne: { positions: [0] },
    closePart: { positions: [1] },
    reverse: { positions: [0] },
    setTrailing: { positions: [2] },
    modifyOrder: { orders: [0] },
    cancelOrder: { orders: [0] },
};
