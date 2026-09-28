// The chart's right-click at a level: which rows it offers, and that picking one only fills in
// the ticket. DOM-free — the ticket is a stub, and the pointer's price is mocked.
import { afterEach, describe, it, expect, vi } from 'vitest';

const pointer = vi.hoisted(() => ({ price: null as number | null }));
vi.mock('../app/renderer/alerts/cursorPrice', () => ({ lastCrosshairPrice: () => pointer.price }));

import { widgetActions } from '../src/widget/contributions';
import { wirePendingMenu } from '../app/renderer/replay/chartPending';
import type { TradeSidebar } from '../app/renderer/replay/tradeSidebar';

const chart = {} as never;
const ctxOf = (c: unknown = chart) => ({ chart: c }) as never;

function mount(market = 100, tick: number | null = 0.25) {
    const stage = vi.fn();
    const off = wirePendingMenu({
        chart,
        sidebar: { stage } as unknown as TradeSidebar,
        price: () => market,
        tick: () => tick,
    });
    return { stage, off };
}

let dispose: (() => void) | null = null;
afterEach(() => {
    dispose?.();
    dispose = null;
    pointer.price = null;
});

describe('the pending-order rows on the chart menu', () => {
    it('names each direction with its kind and the level, on the instrument grid', () => {
        const { off } = mount();
        dispose = off;
        pointer.price = 95.13;
        const rows = widgetActions('context:body', ctxOf()).filter((a) => a.id.startsWith('midorii.pending.'));
        expect(rows.map((a) => a.label)).toEqual(['Buy Limit @ 95.25', 'Sell Stop @ 95.25']);
    });

    it('fills in the ticket and sends nothing', () => {
        const { stage, off } = mount();
        dispose = off;
        pointer.price = 104;
        const ctx = ctxOf();
        const buy = widgetActions('context:body', ctx).find((a) => a.id.startsWith('midorii.pending.buy'))!;
        buy.run(ctx);
        expect(stage).toHaveBeenCalledWith('buy', 'stop', 104);
    });

    it('offers nothing on another chart, without a pointer price, or at the market', () => {
        const { off } = mount();
        dispose = off;
        const pending = (ctx: never) => widgetActions('context:body', ctx).filter((a) => a.id.startsWith('midorii.pending.'));
        pointer.price = 95;
        expect(pending(ctxOf({}))).toHaveLength(0);
        pointer.price = null;
        expect(pending(ctxOf())).toHaveLength(0);
        pointer.price = 100;
        expect(pending(ctxOf())).toHaveLength(0);
    });

    it('takes its rows away again', () => {
        const { off } = mount();
        pointer.price = 95;
        off();
        expect(widgetActions('context:body', ctxOf()).filter((a) => a.id.startsWith('midorii.pending.'))).toHaveLength(0);
    });
});
