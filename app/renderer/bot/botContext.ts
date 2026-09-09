import type { BacktestBar, BacktestContext, BacktestEvent, RunnableStrategy } from '../../../shared/engine/backtest';
import type { Order, OrderSpec, Position } from '../../../shared/engine/broker.js';
import type { StrategyParams } from '../strategies/types';
import type { BotAccount } from './botAccount';

/**
 * The context a strategy is handed, over a feed that is still arriving.
 *
 * A strategy is written against `shared/engine/backtest.js`'s context and knows nothing
 * else: `ctx.bar`, `ctx.events()`, `ctx.order()`, `ctx.state`. That is the entire reason a
 * bot can run one at all. If a bot needed strategies written for bots, then every strategy
 * would exist twice — once as the thing that was tested and once as the thing that trades —
 * and the two would drift apart on the first bug fixed in only one of them.
 *
 * So this builds the same context, over a live account instead of a Broker walking history.
 * Every method below is the backtest's own, and where the semantics cannot be identical it
 * says so rather than pretending.
 *
 * The three real differences
 * --------------------------
 * 1. FILLS ARE NOT THIS FILE'S. The backtest resolves orders against the next bar before
 *    calling `onBar`. Here they resolve wherever the account lives — the paper engine plays
 *    the feed itself, the venue fills whether anybody is watching. By the time `onBar` is
 *    called, whatever filled has filled.
 *
 * 2. `ctx.index` IS AN INDEX INTO THE BOT'S OWN HISTORY, not into a dataset. It starts at
 *    whatever the seeded history was and only grows. That matters because strategies store
 *    it — the Relative Volume ORB keeps the bar it means to be flat by — so the history a
 *    bot runs on must never be re-based under a strategy that is holding one. See
 *    BotRunner's `reseed` for the one place that is allowed to happen.
 *
 * 3. THE ORDER IDS MAY BE THE BOT'S OWN. On paper they are the engine's and mean exactly
 *    what they mean in a backtest. On a live venue they are issued here and matched to the
 *    venue's book later — see botAccount.ts, where that is done and argued.
 *
 * Nothing here refuses a trade. The guards do that, before this is ever called, and the
 * separation is deliberate: this file's job is to be faithful to the backtest, and a
 * context that quietly dropped orders would be the opposite of faithful.
 */

export interface BotContextOptions {
    /** The bars the strategy sees, oldest first, closed only. Grows; never re-based. */
    bars: readonly BacktestBar[];
    /** Which of them is the one just closed — always the last, but passed rather than
     *  assumed, so a caller cannot accidentally run the strategy on a bar twice. */
    index: number;
    /** Precomputed inputs, from the strategy build for THIS history. */
    strategy: RunnableStrategy<StrategyParams>;
    account: BotAccount;
    /** The strategy's own store, kept by the runner so it survives a rebuild. */
    state: Record<string, unknown>;
    /** Told about every order the strategy places — what the bot's log is written from. */
    onOrder?: (spec: OrderSpec, id: number) => void;
    /**
     * Whether an order that would OPEN something may go out, and why not when it may not.
     *
     * This is where the live guards sit, and it is the only place they sit. They are not
     * asked before `onBar`, because a strategy that is holding a position has to keep being
     * called: the Relative Volume ORB cancels its own order and goes flat at the session's
     * close, and a guard that stopped it running would strand exactly the position it was
     * meant to protect. So the strategy always runs, and only its ENTRIES are gated.
     *
     * A `reduceOnly` order is never gated for the same reason: it can only make a position
     * smaller, and refusing it would be the guards making a position larger than the
     * strategy intends.
     */
    canOpen?: (spec: OrderSpec) => string | null;
    /** Told when an entry was gated, so the log can say which guard turned it away. */
    onRefused?: (spec: OrderSpec, reason: string) => void;
}

/**
 * Build the context for one bar.
 *
 * Cheap enough to build per bar (it closes over arrays that already exist), and built per
 * bar on purpose: `index` is fixed for the call, exactly as it is inside the backtest's
 * loop, so a strategy cannot read a bar that has not closed yet.
 */
export function botContext(opts: BotContextOptions): BacktestContext<StrategyParams> {
    const { bars, index, strategy, account, state } = opts;
    const series = strategy.series ?? {};
    const seriesNames = Object.keys(series);

    /* Events, bucketed by the bar that confirmed each one — the same bucketing the backtest
     * loop does up front. Rebuilt per bar rather than kept, because the strategy itself is
     * rebuilt per bar (detection has to see the new bar), so a kept bucket would belong to
     * the previous build. Only this bar's bucket is actually needed, so only it is built. */
    const arriving: Record<string, BacktestEvent[]> = {};
    for (const [name, items] of Object.entries(strategy.events ?? {})) {
        const here: BacktestEvent[] = [];
        for (const item of items) {
            if (item?.index === index) here.push(item);
        }
        arriving[name] = here;
    }
    const eventNames = Object.keys(strategy.events ?? {});

    const positions = (): readonly Position[] => account.positions() as readonly Position[];

    /* Ids handed out for entries the guards turned away. Negative, so one can never collide
     * with an engine's (which count up from 1) or with the live adapter's own. A strategy
     * that later cancels one gets a truthful `false`: there is nothing on any book. */
    let gatedId = 0;

    return {
        get bar() { return bars[index]!; },
        get index() { return index; },
        get time() { return bars[index]!.time; },

        history(n = 1) {
            if (!Number.isInteger(n) || n < 1) throw new Error(`history(${n}): n must be a positive integer`);
            return bars.slice(Math.max(0, index - n + 1), index + 1) as BacktestBar[];
        },

        value(name, back = 0) {
            const s = series[name];
            if (!s) {
                throw new Error(`Unknown series "${name}". Declared: ${seriesNames.join(', ') || 'none'}`);
            }
            if (!Number.isInteger(back) || back < 0) {
                throw new Error(`value("${name}", ${back}): back must be a non-negative integer`);
            }
            const at = index - back;
            return at < 0 ? null : (s[at] ?? null);
        },

        events<T extends BacktestEvent = BacktestEvent>(name: string): readonly T[] {
            const here = arriving[name];
            if (!here) {
                throw new Error(`Unknown events "${name}". Declared: ${eventNames.join(', ') || 'none'}`);
            }
            return here as readonly BacktestEvent[] as readonly T[];
        },

        /* One position or none, the way the backtest's `broker.position` answers. A hedging
         * account can hold several, and a strategy that reads `ctx.position` on one is
         * reading the first of them — which is the engine's own behaviour, not a
         * simplification introduced here. */
        get position() { return positions()[0] ?? null; },
        get positions() { return positions() as Position[]; },
        get balance() { return account.balance(); },
        get equity() { return account.equity(); },
        get isFlat() { return positions().length === 0; },
        get pendingOrders() { return account.pending() as Order[]; },

        params: strategy.params ?? ({} as StrategyParams),

        buy(spec) {
            return place({ side: 'buy', type: 'market', ...spec });
        },
        sell(spec) {
            return place({ side: 'sell', type: 'market', ...spec });
        },
        order(spec) {
            return place(spec as OrderSpec);
        },
        close(tag) {
            if (positions().length === 0) return null;
            account.close(tag);
            /* The backtest answers with the closing order. A live venue has not made one yet
             * and a paper close has already happened, so there is nothing truthful to hand
             * back — and no strategy in this app reads it. Null says "nothing to give you",
             * which is what the backtest itself answers when there is nothing open. */
            return null;
        },
        cancel(id) {
            return account.cancel(id);
        },
        cancelAll(tag) {
            return account.cancelAll(tag);
        },

        state,
    };

    /** Place an order and report it, so the log records what the strategy asked for even
     *  when the venue later refuses it. */
    function place(spec: OrderSpec): Order {
        if (!spec.reduceOnly) {
            const refused = opts.canOpen?.(spec) ?? null;
            if (refused != null) {
                opts.onRefused?.(spec, refused);
                /* Nothing goes out, and the strategy is handed a cancelled order under an id
                 * that can never match a real one. That is deliberate rather than throwing:
                 * a strategy stores the id and stops asking for the rest of the session, so
                 * a gated setup costs it one setup — which is what a guard is for. Throwing
                 * would abort its whole bar, leaving `ctx.state` half written. */
                gatedId -= 1;
                return synthetic(spec, gatedId, 'cancelled');
            }
        }
        const { id } = account.order(spec);
        opts.onOrder?.(spec, id);
        return synthetic(spec, id, 'pending');
    }
}

/**
 * An Order record for something that has been asked for but has not happened.
 *
 * The engine's own `Order` is a record of something that HAS happened; on a live venue
 * nothing has yet, and on a gated entry nothing ever will. So the strategy is handed the
 * fields it can act on — the id it would cancel by, and what it asked for — with the rest
 * as the backtest would have them before a fill. No strategy in this app reads more than
 * `.id`, and one that did would find honest nulls rather than invented prices.
 */
function synthetic(spec: OrderSpec, id: number, status: 'pending' | 'cancelled'): Order {
    return {
        id,
        side: spec.side,
        type: spec.type ?? 'market',
        size: spec.size,
        limitPrice: spec.limitPrice ?? null,
        stopPrice: spec.stopPrice ?? null,
        reduceOnly: spec.reduceOnly ?? false,
        tag: spec.tag ?? null,
        parentId: spec.parentId ?? null,
        positionId: spec.positionId ?? null,
        bracket: spec.bracket ?? null,
        status,
        placedAt: Date.now(),
        filledAt: null,
        fillPrice: null,
        fee: null,
    };
}
