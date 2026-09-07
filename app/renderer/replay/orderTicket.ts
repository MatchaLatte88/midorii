import { positionSize } from '../../../shared/strategies/risk.js';
import type { OrderBracket, OrderSpec } from '../../../shared/engine/broker.js';
import { levelAllowed } from './replayLevels';
import type { RiskSettings } from './replayOrders';

/**
 * A typed order, before it is an order: what the panel is describing, what it would cost, and
 * why it cannot be sent yet.
 *
 * Kept apart from the sidebar that paints it for the same reason the book is kept apart from
 * the dock — every rule here is a rule about money, and a rule about money that can only be
 * exercised by clicking on a chart is a rule nobody checks.
 *
 * Sizing is derived, not typed
 * ----------------------------
 * By default you say where the trade is wrong and how much that may cost; the size follows,
 * through the same `positionSize` a strategy uses. So a trade taken by hand and a trade taken
 * by a bot are the same size for the same stop, and the two are comparable afterwards. A fixed
 * size is still offered — sometimes the question really is what one whole coin does here — but
 * it is the second option, and it is the one whose risk nobody worked out.
 */

export type TicketOrderType = 'market' | 'limit' | 'stop';
export type TicketSizing = 'risk' | 'fixed';

/** What the panel currently says. Every field is exactly what is in the boxes. */
export interface TicketDraft {
    type: TicketOrderType;
    /** Where a resting order waits. Ignored by a market order, which fills at the market. */
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    sizing: TicketSizing;
    /** Units, when the size is typed rather than derived. */
    fixedSize: number | null;
}

/** A ticket with nothing in it. */
export function emptyTicket(): TicketDraft {
    return { type: 'market', entryPrice: null, stopLoss: null, takeProfit: null, sizing: 'risk', fixedSize: null };
}

/** The account, as far as a ticket needs to know it. */
export interface TicketAccount {
    equity: number;
    /** The last price on the chart — the only price a market order can be sized against. */
    price: number;
}

export interface TicketPlan {
    /**
     * The price the fill is expected around: the market for a market order, the typed level
     * for a resting one. Null when there is no honest answer yet.
     *
     * An estimate, and only that — the engine charges spread and slippage on top, so a market
     * order fills near this and not on it. Everything below is measured from it, so everything
     * below is an estimate too. That is the right kind of wrong for a number read while
     * deciding: it is the plan, not the receipt.
     */
    reference: number | null;
    /** What would be sent, or null where no size can be worked out. */
    size: number | null;
    /** Size at the reference price — what the account would actually be carrying. */
    notional: number | null;
    /**
     * What the stop would cost, in cash and as a share of equity. Null without a stop: a trade
     * with no stop does not risk nothing, it risks an amount nobody has worked out.
     */
    risk: { cash: number; share: number | null } | null;
    /** How far the target is, measured in stops. */
    rr: number | null;
    /** The leverage ceiling decided this size, not the risk — the stop is too tight for it. */
    capped: boolean;
}

/**
 * What the ticket comes to. Side-independent on purpose: the size, the notional, the cash at
 * risk and the reward:risk are the same numbers whichever way the trade goes — only whether it
 * may be SENT depends on the side, and that is {@link ticketRefusal}.
 */
export function ticketPlan(draft: TicketDraft, account: TicketAccount, risk: RiskSettings): TicketPlan {
    const typed = draft.entryPrice != null && draft.entryPrice > 0 ? draft.entryPrice : null;
    const reference = draft.type === 'market' ? (account.price > 0 ? account.price : null) : typed;

    const size = ticketSize(draft, reference, account, risk);
    const notional = size != null && reference != null ? size * reference : null;

    const cash = size != null && reference != null && draft.stopLoss != null
        ? Math.abs(reference - draft.stopLoss) * size
        : null;

    const spread = reference != null && draft.stopLoss != null ? Math.abs(reference - draft.stopLoss) : 0;
    const rr = reference != null && draft.takeProfit != null && spread > 0
        ? Math.abs(draft.takeProfit - reference) / spread
        : null;

    /* Where the cap bit, the size is no longer the one the risk asked for, and the trade will
     * lose less than it was allowed to at its stop. Worth saying out loud: a ticket pinned to
     * the ceiling is telling you the stop is too tight for the risk, not that all is well. */
    const ceiling = reference != null && reference > 0 ? (account.equity * risk.maxLeverage) / reference : null;
    const capped = draft.sizing === 'risk' && size != null && ceiling != null
        && Math.abs(size - ceiling) < ceiling * 1e-9;

    return {
        reference,
        size,
        notional,
        risk: cash == null ? null : { cash, share: account.equity > 0 ? cash / account.equity : null },
        rr,
        capped,
    };
}

/** The size the ticket would send, or null where there is no honest answer. */
function ticketSize(draft: TicketDraft, reference: number | null, account: TicketAccount, risk: RiskSettings): number | null {
    if (draft.sizing === 'fixed') return draft.fixedSize != null && draft.fixedSize > 0 ? draft.fixedSize : null;
    if (reference == null || draft.stopLoss == null) return null;
    return positionSize(account.equity, reference, draft.stopLoss, risk.mode, risk.value, risk.maxLeverage);
}

/**
 * Why this side cannot be sent, in words — or null when it can.
 *
 * A reason rather than a disabled button, because every one of these is a question with an
 * answer ("which box do I fix?") and a grey button answers none of them.
 */
export function ticketRefusal(draft: TicketDraft, side: 'buy' | 'sell', account: TicketAccount, plan: TicketPlan): string | null {
    if (!(account.price > 0)) return 'The session has no price yet.';
    if (plan.reference == null) return 'A resting order needs a price to wait at.';

    /* What blocks BOTH directions comes first. Both sides are refused at once often enough —
     * a size of nothing, a missing stop — and the panel shows one message for the pair; if a
     * side-specific reason won that race it would name the direction the user did not press
     * while the real obstacle went unmentioned. */
    if (draft.sizing === 'risk' && draft.stopLoss == null) {
        return 'Risk sizing needs a stop — without one there is no distance to size against.';
    }
    if (draft.sizing === 'fixed' && !(draft.fixedSize != null && draft.fixedSize > 0)) {
        return 'A fixed size has to be a positive number of units.';
    }
    if (plan.size == null) return 'This cannot be sized against the account.';

    if (draft.type !== 'market') {
        /* A limit is a pullback and a stop is a breakout: which side of the market the level
         * sits on is what makes it one or the other. The engine does not check this — it would
         * happily rest a buy limit above the market and fill it on the next bar at a price
         * nobody meant. */
        if (plan.reference === account.price) return `A ${side} ${draft.type} needs a price away from the market.`;
        const wantAbove = draft.type === 'stop' ? side === 'buy' : side === 'sell';
        if ((plan.reference > account.price) !== wantAbove) {
            return wantAbove
                ? `A ${side} ${draft.type} waits above the market.`
                : `A ${side} ${draft.type} rests below the market.`;
        }
    }

    // The same rule a level dragged on the chart is held to, in the same words.
    if (draft.stopLoss != null && !levelAllowed('stop', side, plan.reference, draft.stopLoss)) {
        return 'A stop belongs on the losing side of the entry.';
    }
    if (draft.takeProfit != null && !levelAllowed('target', side, plan.reference, draft.takeProfit)) {
        return 'A target belongs on the winning side of the entry.';
    }
    return null;
}

/**
 * The ticket as an order spec.
 *
 * A stop and a target on an entry that has not filled yet cannot be two live orders — they
 * would trade against a position that does not exist. They ride along as a bracket instead and
 * become real orders the moment the entry fills, so a resting entry is protected exactly like
 * a market one.
 */
export function ticketOrder(draft: TicketDraft, side: 'buy' | 'sell', size: number): OrderSpec {
    const bracket: OrderBracket = {};
    if (draft.stopLoss != null) bracket.stopLoss = draft.stopLoss;
    if (draft.takeProfit != null) bracket.takeProfit = draft.takeProfit;

    return {
        side,
        type: draft.type,
        size,
        ...(draft.type === 'limit' ? { limitPrice: draft.entryPrice! } : {}),
        ...(draft.type === 'stop' ? { stopPrice: draft.entryPrice! } : {}),
        bracket: draft.stopLoss == null && draft.takeProfit == null ? null : bracket,
        // The tag the trade is filed under afterwards. 'manual' matches what a block traded
        // from the chart sends, so a hand-traded run reads as one thing in the library.
        tag: draft.type === 'market' ? 'manual' : `manual-${draft.type}`,
    };
}
