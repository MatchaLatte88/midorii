import type { Order, OrderSpec, Position } from '../../../shared/engine/broker.js';
import type { CapitalController } from '../trading/CapitalController';
import type { PaperController } from '../trading/PaperController';

/**
 * The account, as far as a running strategy needs one.
 *
 * A strategy asks the same five questions of a paper engine and of a real venue — what is
 * this worth, what is open, what is waiting, put this on, take that off — and gets them
 * answered by two things that are not remotely alike. A paper account IS the engine and
 * answers instantly and exactly; a live account is a client of a venue that has already
 * decided, answers a second late, and can refuse after saying yes.
 *
 * This is where that difference is absorbed, once, so {@link botContext} never has to know
 * which of the two it is driving. Nothing here smooths the difference away — see the
 * comments on {@link BotAccount.order} and the live adapter's own — it only puts both
 * behind one shape.
 *
 * What is deliberately NOT here
 * -----------------------------
 * The feed. A paper account has to be played bars to fill anything, and a live one fills
 * whether anybody is watching; the runner does each of those itself, because they are not
 * two implementations of one idea, they are two different jobs (see BotRunner.ts).
 */

/** A position, in the fields a strategy can read off one. */
export type BotPosition = Pick<Position, 'id' | 'size' | 'entryPrice'> & Partial<Position>;

/** A resting order, in the fields a strategy can read off one. */
export type BotOrder = Pick<Order, 'id' | 'side' | 'size'> & Partial<Order>;

export interface BotAccount {
    /** What the account is worth, marked at the last price. */
    equity(): number;
    /** Settled cash. On a live account this is the venue's own single figure — it does not
     *  separate the two, and inventing the split would be a number nobody stated. */
    balance(): number;
    /** The last price the account has been marked at, or 0 before there is one. */
    price(): number;
    /** The two sides of the book, where the venue quotes them. Null where it quotes one. */
    quote(): { bid: number; ask: number } | null;
    positions(): readonly BotPosition[];
    /** What is on the book and has not filled. */
    pending(): readonly BotOrder[];

    /**
     * Place an order, and answer with the id the strategy will address it by.
     *
     * On paper the id IS the engine's, and everything the strategy does with it lands on
     * the same order. On a live account nothing has an id yet — the venue has not taken
     * delivery, let alone confirmed — so the id is the bot's own and is matched to the
     * venue's order when one appears. See the live adapter's {@link cancel}.
     *
     * Throws where the account refuses outright. A live venue's later refusal cannot come
     * back this way and reaches the bot's log instead.
     */
    order(spec: OrderSpec): { id: number };
    /** Take a resting order off the book. Answers whether there was one to take off. */
    cancel(id: number): boolean;
    /** Take every resting order off. Answers how many. */
    cancelAll(tag?: string | null): number;
    /** Close what is open, at market. */
    close(tag?: string): void;
    /** Close everything and cancel everything — what a guard does at the end of a window. */
    flatten(): void;
}

/** The bot's own paper engine, behind the shared shape. */
export function paperAccount(controller: PaperController): BotAccount {
    return {
        equity: () => controller.equity(),
        balance: () => controller.broker.balance,
        price: () => controller.price(),
        // A paper account is marked from the chart's candles, which are one price.
        quote: () => null,
        positions: () => controller.broker.positions,
        pending: () => controller.broker.pending,
        order: (spec) => controller.order(spec),
        cancel: (id) => controller.cancelOrder(id),
        cancelAll: (tag) => {
            const before = controller.broker.pending.length;
            controller.cancelAll(tag ?? undefined);
            return before - controller.broker.pending.length;
        },
        close: (tag) => controller.close(tag),
        flatten: () => {
            controller.cancelAll();
            controller.flatten();
        },
    };
}

/**
 * A real Capital.com account, behind the same shape.
 *
 * Two things here are honest rather than convenient, and both are visible in the code:
 *
 * The ids are the bot's own. The venue gives an order an id only once it has accepted it,
 * which is after this call has returned — so a strategy that stored the id it was handed
 * would be holding a number for something that may never exist. The bot issues its own,
 * remembers what it asked for, and resolves it against the venue's book when the order
 * turns up there. An order that never turned up cannot be cancelled, and saying so is the
 * only truthful answer.
 *
 * The match is by side, kind and level. That is enough because a strategy places at most
 * one order per level per setup — the ones in this app place exactly one per session — and
 * a wrong match would have to be an order the bot itself placed at the same price, on the
 * same side, of the same kind. Where nothing matches, `cancel` answers false rather than
 * cancelling something else.
 */
export function liveAccount(controller: CapitalController): BotAccount {
    /** What the bot asked for, by the id it handed the strategy. Only resting orders are
     *  kept — a market order has nothing to cancel. */
    const asked = new Map<number, { side: 'buy' | 'sell'; kind: 'limit' | 'stop'; level: number }>();
    let nextId = 1;

    /** The venue's order for what the bot asked for under `id`, or null. */
    const resolve = (id: number): number | null => {
        const want = asked.get(id);
        if (!want) return null;
        /* Levels come back from the venue as it stores them, which is not always bit-exact
         * with what was sent. A tolerance of a ten-thousandth of the level is far tighter
         * than any instrument's own tick and far looser than float noise. */
        const tolerance = Math.max(Math.abs(want.level) * 1e-4, 1e-8);
        const match = controller.orders().find((o) => (
            o.side === want.side && o.kind === want.kind && Math.abs(o.price - want.level) <= tolerance
        ));
        return match ? match.id : null;
    };

    return {
        equity: () => controller.equity(),
        // The venue states one figure and does not split settled from unrealized.
        balance: () => controller.equity(),
        price: () => controller.price(),
        quote: () => controller.quote(),
        positions: () => controller.positions(),
        pending: () => controller.orders().map((o) => ({
            id: o.id,
            side: o.side,
            size: o.size,
            type: o.kind,
            limitPrice: o.kind === 'limit' ? o.price : null,
            stopPrice: o.kind === 'stop' ? o.price : null,
        })),
        order: (spec) => {
            controller.order(spec);
            const id = nextId;
            nextId += 1;
            if (spec.type === 'limit' || spec.type === 'stop') {
                const level = spec.type === 'limit' ? spec.limitPrice : spec.stopPrice;
                if (level != null) asked.set(id, { side: spec.side, kind: spec.type, level });
            }
            return { id };
        },
        cancel: (id) => {
            const venueId = resolve(id);
            asked.delete(id);
            if (venueId == null) return false;
            controller.cancelOrder(venueId);
            return true;
        },
        cancelAll: () => {
            const count = controller.orders().length;
            controller.cancelAll();
            asked.clear();
            return count;
        },
        close: () => {
            for (const position of controller.positions()) controller.closeOne(position.id);
        },
        flatten: () => {
            controller.cancelAll();
            asked.clear();
            for (const position of controller.positions()) controller.closeOne(position.id);
        },
    };
}
