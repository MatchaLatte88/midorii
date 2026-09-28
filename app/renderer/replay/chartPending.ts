import { registerWidgetAction } from '../../../src/plugin';
import type { Vela } from '../../../src';
import { lastCrosshairPrice } from '../alerts/cursorPrice';
import { formatPrice } from '../format';
import { priceOnGrid, restingTypeAt } from './orderTicket';
import type { TradeSidebar } from './tradeSidebar';

export interface PendingMenuOptions {
    /** The chart whose right-click offers the order — no other chart's menu shows it. */
    chart: Vela;
    /** The ticket the level is written into. */
    sidebar: TradeSidebar;
    /** The price the account stands on, which is what decides limit or stop. */
    price(): number;
    /** The instrument's own increment, or null where it is not known. */
    tick(): number | null;
}

/** Tells apart the menus of two accounts on screen at once — a replay beside a paper chart. */
let serial = 0;

/**
 * Right-click the chart at a level, get a resting order there on the ticket.
 *
 * Two rows, one per direction, and each already says which kind of order it is — a buy below
 * the market can only be a limit, so asking would be asking something the level has answered.
 * Neither row sends anything: the ticket is filled in and shown, and its own button is still
 * the press that trades, with the size, the exits and the refusals it would have had anyway.
 *
 * Returns an unsubscribe function.
 */
export function wirePendingMenu(opts: PendingMenuOptions): () => void {
    const n = ++serial;

    const offs = (['buy', 'sell'] as const).map((side) => {
        /* Worked out whenever the menu asks whether the row belongs in it — when it opens, and
         * again when the row is picked — and read by the label and the press. The level is the
         * pointer's, which the open menu covers; the kind follows the market as it is at the
         * press, and the ticket shows both before anything can be sent. */
        let staged: { type: 'limit' | 'stop'; level: number } | null = null;

        return registerWidgetAction({
            id: `midorii.pending.${side}.${n}`,
            target: 'context:body',
            // Ahead of the chart's other contributed rows: at a level, the order is the question.
            order: -1,
            get label(): string {
                if (!staged) return side === 'buy' ? 'Buy pending order' : 'Sell pending order';
                const name = `${side === 'buy' ? 'Buy' : 'Sell'} ${staged.type === 'limit' ? 'Limit' : 'Stop'}`;
                return `${name} @ ${formatPrice(staged.level)}`;
            },
            when: (ctx) => {
                staged = null;
                if (ctx.chart !== opts.chart) return false;
                const pointer = lastCrosshairPrice();
                if (pointer == null) return false;
                const level = priceOnGrid(pointer, opts.tick());
                const type = restingTypeAt(side, level, opts.price());
                if (type == null) return false;
                staged = { type, level };
                return true;
            },
            run: () => {
                if (staged) opts.sidebar.stage(side, staged.type, staged.level);
            },
        });
    });

    return () => {
        for (const off of offs) off();
    };
}
