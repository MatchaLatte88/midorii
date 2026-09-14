import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectXController } from '../app/renderer/trading/ProjectXController';

const CONTRACT = 'CON.F.US.ENQ.U26';
const DEALING = { contractId: CONTRACT, tickSize: 0.25, tickValue: 5, minSize: 1, sizeStep: 1 };
const ACCOUNT = { id: 42, name: 'EXPRESS-V2-CT', balance: 50_000, canTrade: true, simulated: true };

/** A gateway position. `type` is 1 for long and 2 for short — the venue's own enum. */
const position = (over: Record<string, unknown> = {}) => ({
    id: 6124, accountId: 42, contractId: CONTRACT,
    creationTimestamp: '2026-09-11T12:00:00+00:00',
    type: 1, size: 2, averagePrice: 29_000, ...over,
});

/** A resting order. `type` 4 is Stop and 1 is Limit; `side` 1 is sell. */
const order = (over: Record<string, unknown> = {}) => ({
    id: 26_970, accountId: 42, contractId: CONTRACT,
    creationTimestamp: '2026-09-11T12:00:00+00:00', updateTimestamp: '2026-09-11T12:00:00+00:00',
    status: 1, type: 4, side: 1, size: 2, limitPrice: null, stopPrice: 28_900, filledPrice: null, ...over,
});

/** Everyone the controller has registered for account-side events, so a test can ring them. */
const userHandlers = new Set<(update: unknown) => void>();
const ringUserHub = (event = 'GatewayUserOrder'): void => {
    for (const handler of userHandlers) handler({ subscriptionId: 'user-sub', event, payload: null });
};

function bridge(over: Record<string, unknown> = {}) {
    const api = {
        positions: vi.fn(async () => [] as unknown[]),
        openOrders: vi.fn(async () => [] as unknown[]),
        accounts: vi.fn(async () => [ACCOUNT]),
        account: vi.fn(async () => ({ accountId: ACCOUNT.id, chosen: true })),
        placeOrder: vi.fn(async () => ({ orderId: 1 })),
        modifyOrder: vi.fn(async () => {}),
        cancelOrder: vi.fn(async () => {}),
        closePosition: vi.fn(async () => {}),
        trades: vi.fn(async () => [] as unknown[]),
        /* The account-side hub. Absent from a bridge that overrides it with a rejection, which
           is how the fallback path is exercised. */
        subscribeUser: vi.fn(async () => 'user-sub'),
        unsubscribeUser: vi.fn(async () => {}),
        onUserEvent: vi.fn((handler: (u: unknown) => void) => {
            userHandlers.add(handler);
            return () => userHandlers.delete(handler);
        }),
        ...over,
    };
    vi.stubGlobal('window', { midori: { projectx: api } });
    return api;
}

/** A controller that has read the venue once. */
async function controllerWith(api: ReturnType<typeof bridge>, dealing = DEALING) {
    const notes: Array<[string, string]> = [];
    const c = new ProjectXController({
        ticker: 'NQU6', dealing, accountName: ACCOUNT.name,
        notify: (m, k) => notes.push([k, m]),
    });
    c.start();
    await vi.waitFor(() => expect(api.positions).toHaveBeenCalled());
    await vi.waitFor(() => expect(c.readAt()).toBeGreaterThan(0));
    return { c, notes };
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    userHandlers.clear();
});

describe('ProjectX positions', () => {
    it('signs the size from the venue enum — 1 is long, 2 is short', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2 }), position({ id: 2, type: 2, size: 3 })]) });
        const { c } = await controllerWith(api);
        expect(c.positions().map((p) => p.size)).toEqual([2, -3]);
        c.stop();
    });

    it('values a position in ticks times tick value, not in points', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(29_004);
        // 4 points = 16 ticks; 16 × $5 × 2 contracts = $160. A naive price difference says 8.
        expect(c.positions()[0]!.unrealized).toBe(160);
        expect(c.equity()).toBe(50_000 + 160);
        c.stop();
    });

    it('values a short the other way round', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_996);
        expect(c.positions()[0]!.unrealized).toBe(80);
        c.stop();
    });

    it('attaches the resting orders that protect a position to it', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [
                order({ id: 10, type: 4, side: 1, stopPrice: 28_900 }),
                order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null }),
            ]),
        });
        const { c } = await controllerWith(api);
        expect(c.positions()[0]).toMatchObject({ stopLoss: 28_900, takeProfit: 29_200, stopOrderId: 10, targetOrderId: 11 });
        c.stop();
    });

    it('marks itself stale when the venue cannot be read, rather than showing old figures as current', async () => {
        const api = bridge({ positions: vi.fn(async () => { throw new Error('gateway down'); }) });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const c = new ProjectXController({ ticker: 'NQU6', dealing: DEALING, notify: () => {} });
        c.start();
        await vi.waitFor(() => expect(c.isStale()).toBe(true));
        c.stop();
    });
});

describe('ProjectX protection', () => {
    it('places a stop as a resting order facing the other way', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2 })]) });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_900 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            contractId: CONTRACT, side: 'sell', type: 'stop', size: 2, stopPrice: 28_900,
        }));
        c.stop();
    });

    it('protects a short by buying', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1 })]) });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 29_100 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', type: 'stop' }));
        c.stop();
    });

    /**
     * The point of the whole design: moving a level must not uncover the position.
     */
    it('moves an existing stop instead of cancelling and replacing it', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950 });
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalled());
        expect(api.modifyOrder).toHaveBeenCalledWith(10, { stopPrice: 28_950 });
        expect(api.cancelOrder).not.toHaveBeenCalled();
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    /**
     * A level dragged on the chart is whatever price the pixel stood for — 29410.29 on a
     * contract that trades in quarters. ProjectX refuses that outright, so it is rounded
     * before it is sent rather than left to the hand that dragged it.
     */
    it('rounds a dragged level to the tick grid before sending it', async () => {
        const api = bridge({ positions: vi.fn(async () => [position()]) });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950.29, takeProfit: 29_100.13 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalledTimes(2));
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop', stopPrice: 28_950.25 }));
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'limit', limitPrice: 29_100.25 }));
        c.stop();
    });

    it('rounds a level that MOVES an existing order too', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950.29 });
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalled());
        expect(api.modifyOrder).toHaveBeenCalledWith(10, { stopPrice: 28_950.25 });
        c.stop();
    });

    /** The rounding itself is where binary fractions surface: 289503 * 0.1 is 28950.300000000003,
     *  and a price with that tail is refused for the same reason the unrounded one was. */
    it('sends a clean number on a tick size that is not a binary fraction', async () => {
        const api = bridge({ positions: vi.fn(async () => [position()]) });
        const { c } = await controllerWith(api, { ...DEALING, tickSize: 0.1 });
        c.protect({ stopLoss: 28_950.27 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 28_950.3 }));
        c.stop();
    });

    it('cancels the order when a level is removed', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: null });
        await vi.waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith(10));
        c.stop();
    });

    it('leaves the target alone when only the stop is dragged', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [
                order({ id: 10, type: 4, side: 1, stopPrice: 28_900 }),
                order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null }),
            ]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950 });
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalled());
        expect(api.modifyOrder).toHaveBeenCalledTimes(1);
        expect(api.modifyOrder).toHaveBeenCalledWith(10, { stopPrice: 28_950 });
        c.stop();
    });

    it('refuses to protect when nothing is open', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(() => c.protect({ stopLoss: 1 })).toThrow(/No open NQU6 position/);
        c.stop();
    });
});

describe('ProjectX orphan protection', () => {
    /**
     * The dangerous case this polling exists for.
     *
     * Stop and target are independent orders and the venue does not link them. When one
     * fills, the position is gone and the other is still working — and a working order
     * against no position OPENS one the other way.
     */
    it('cancels a protective order whose position has gone', async () => {
        const api = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => [order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null })]),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith(11));
        expect(notes.some(([, m]) => /left over from a closed/.test(m))).toBe(true);
        c.stop();
    });

    it('leaves orders alone while their position is still open', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1 })]),
        });
        const { c } = await controllerWith(api);
        expect(api.cancelOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('says so loudly when an orphan cannot be cancelled — a live order against nothing', async () => {
        const api = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => [order({ id: 11, type: 1, side: 1 })]),
            cancelOrder: vi.fn(async () => { throw new Error('refused'); }),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(notes.some(([k]) => k === 'error')).toBe(true));
        expect(notes.find(([k]) => k === 'error')![1]).toMatch(/could not be cancelled — check it on the platform/);
        c.stop();
    });
});

describe('ProjectX break-even', () => {
    it('refuses while the trade is not in profit, and says why', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_990);
        expect(c.breakEvenRefusal()).toMatch(/not in profit/);
        expect(() => c.breakEven()).toThrow(/not in profit/);
        c.stop();
    });

    it('moves the stop to the entry once the trade is in profit', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toBeNull();
        c.breakEven();
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop', stopPrice: 29_000, side: 'sell' }));
        c.stop();
    });

    it('works the same way on a short', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_980);
        expect(c.breakEvenRefusal()).toBeNull();
        c.breakEven();
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', stopPrice: 29_000 }));
        c.stop();
    });

    it('declines to repeat itself when the stop already sits at entry', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, averagePrice: 29_000 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 29_000 })]),
        });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toMatch(/already at entry/);
        c.stop();
    });
});

describe('ProjectX orders', () => {
    it('refuses a size below one whole contract', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(() => c.order({ side: 'buy', size: 0, type: 'market' })).toThrow(/whole contracts/);
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('closes a position through the venue rather than by sending an opposing order', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ id: 6124 })]) });
        const { c } = await controllerWith(api);
        c.closeOne(6124);
        await vi.waitFor(() => expect(api.closePosition).toHaveBeenCalledWith(CONTRACT));
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('puts an entry price on the tick grid — a dragged limit is no rounder than a dragged stop', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 28_800.37 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ limitPrice: 28_800.25 }));
        c.stop();
    });

    it('does the same for a stop entry', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.order({ side: 'buy', size: 1, type: 'stop', stopPrice: 29_100.13 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 29_100.25 }));
        c.stop();
    });
});

/**
 * The payload the chart is drawn from.
 *
 * Nothing here is about arithmetic; it is about the state ARRIVING at all. The indicator
 * reads its input with `JSON.parse` and ignores anything that is not a string, so a payload
 * sent as an object is a ProjectX chart with no position on it — and, because the drag
 * gestures are wired to the lines a position draws, no way to move a stop either.
 */
describe('ProjectX chart state', () => {
    /** The one method the controller calls, and the last thing it was handed. */
    function indicator() {
        const sent: string[] = [];
        const handle = { setInputs: (values: Record<string, unknown>) => { sent.push(String(values.stateJson)); } };
        return { handle, latest: () => JSON.parse(sent[sent.length - 1]!) };
    }

    it('sends the state as a string — an object is silently ignored by the indicator', async () => {
        const api = bridge({ positions: vi.fn(async () => [position()]) });
        const { c } = await controllerWith(api);
        const spy = indicator();
        c.attachIndicator(spy.handle as never);
        expect(spy.latest().positions).toHaveLength(1);
        c.stop();
    });

    it('names the fields the indicator actually reads — side, entry time, and the two levels', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 2, size: 3, averagePrice: 29_000 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 0, stopPrice: 29_100 })]),
        });
        const { c } = await controllerWith(api);
        const spy = indicator();
        c.attachIndicator(spy.handle as never);
        const [drawn] = spy.latest().positions;
        expect(drawn.side).toBe('sell');
        expect(drawn.size).toBe(3);            // always positive — the side carries the direction
        expect(drawn.stopPrice).toBe(29_100);
        expect(drawn.entryTime).toBe(Date.parse('2026-09-11T12:00:00+00:00'));
        c.stop();
    });

    it('values a level in ticks times tick value, not in points', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 2, averagePrice: 29_000 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        const spy = indicator();
        c.attachIndicator(spy.handle as never);
        // 100 points is 400 ticks; 400 × $5 × 2 contracts = $4,000 — not $200.
        expect(spy.latest().positions[0].stopPnl).toBe(-4_000);
        c.stop();
    });

    it('leaves R null — the gateway records no risk a trade opened with', async () => {
        const api = bridge({ positions: vi.fn(async () => [position()]) });
        const { c } = await controllerWith(api);
        const spy = indicator();
        c.attachIndicator(spy.handle as never);
        expect(spy.latest().positions[0].openR).toBeNull();
        c.stop();
    });
});

/**
 * Brackets asked for with the order.
 *
 * The ticket panel and a block drawn on the chart both produce absolute LEVELS; the gateway
 * takes ticks from the fill. Reading only distances meant a stop typed into the ticket went
 * out as no stop at all, without a word — the failure this venue least gets to have.
 */
describe('ProjectX brackets', () => {
    it('converts a stop level into ticks from the market', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.mark(29_000);
        c.order({ side: 'buy', size: 1, type: 'market', bracket: { stopLoss: 28_900 } });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        // 100 points at a quarter-point tick.
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ stopLossTicks: 400 }));
        c.stop();
    });

    it('measures a resting order against its own price, not against the market', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.mark(29_000);
        c.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 28_800, bracket: { takeProfit: 28_900 } });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ takeProfitTicks: 400 }));
        c.stop();
    });

    it('still takes a distance as it stands — the gateway own shape', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.mark(29_000);
        c.order({ side: 'buy', size: 1, type: 'market', bracket: { stopDistance: 25 } });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ stopLossTicks: 100 }));
        c.stop();
    });

    /** Both ends of the measurement come off the chart, so both are off the grid — and the
     *  distance between two unrounded prices is not the distance between the orders that
     *  actually get placed. Measured from the rounded entry, 28_900.12 is 399 ticks away;
     *  measured from the raw one it would be sent as 400. */
    it('measures a bracket from the entry the venue will actually see', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.mark(29_000);
        c.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 28_800.13, bracket: { takeProfit: 28_900.12 } });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            limitPrice: 28_800.25, takeProfitTicks: 399,
        }));
        c.stop();
    });

    it('refuses a stop on the winning side rather than sending it mirrored', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.mark(29_000);
        expect(() => c.order({ side: 'buy', size: 1, type: 'market', bracket: { stopLoss: 29_100 } }))
            .toThrow(/losing side/);
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('refuses the order outright when a level cannot be measured, rather than dropping it', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        // No price yet: a level has nothing to be a distance from.
        expect(() => c.order({ side: 'buy', size: 1, type: 'market', bracket: { stopLoss: 28_900 } }))
            .toThrow(/no entry price yet/);
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });
});

/**
 * What is waiting, and what is only protection.
 *
 * The dock was handed an empty list on this venue, so no ProjectX order could be seen or
 * cancelled from it — while the count beside it said otherwise.
 */
describe('ProjectX working orders', () => {
    /* A buy limit under a long is somebody adding to it — the same side as the position, so
     * it is not protection, and the contract is held, so the sweep is not involved at all. */
    it('lists a resting entry in the book', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 2 })]),
            openOrders: vi.fn(async () => [order({ id: 77, type: 1, side: 0, limitPrice: 28_800, stopPrice: null })]),
        });
        const { c } = await controllerWith(api);
        expect(c.book().orders).toEqual([
            { id: 77, side: 'buy', type: 'limit', size: 2, price: 28_800, tag: null },
        ]);
        c.stop();
    });

    it('keeps the protection of a position out of the order list — it is drawn as a level', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        expect(c.book().orders).toEqual([]);
        expect(c.positions()[0]).toMatchObject({ stopLoss: 28_900 });
        c.stop();
    });

    it('does not sweep an entry this app placed — it has no position by definition', async () => {
        let placed = false;
        const api = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => (placed
                ? [order({ id: 77, type: 1, side: 0, limitPrice: 28_800, stopPrice: null })]
                : [])),
            placeOrder: vi.fn(async () => { placed = true; return { orderId: 77 }; }),
        });
        const { c } = await controllerWith(api);
        c.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 28_800 });
        await vi.waitFor(() => expect(c.orders().map((o) => o.id)).toEqual([77]));
        expect(api.cancelOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('does not read a working entry as the target of a position', async () => {
        let placed = false;
        const api = bridge({
            positions: vi.fn(async () => (placed ? [position({ type: 1, size: 2 })] : [])),
            // A sell limit above a long is the shape of both a target and a short entry.
            openOrders: vi.fn(async () => (placed
                ? [order({ id: 88, type: 1, side: 1, limitPrice: 29_500, stopPrice: null })]
                : [])),
            placeOrder: vi.fn(async () => { placed = true; return { orderId: 88 }; }),
        });
        const { c } = await controllerWith(api);
        c.order({ side: 'sell', size: 1, type: 'limit', limitPrice: 29_500 });
        await vi.waitFor(() => expect(c.positions()).toHaveLength(1));
        expect(c.positions()[0]).toMatchObject({ takeProfit: null });
        expect(c.book().orders.map((o) => o.id)).toEqual([88]);
        c.stop();
    });
});

/**
 * What a contract is worth, and what size the venue will take.
 *
 * Both are asked BEFORE anything is sent, because both are figures the person is shown. A
 * ticket that reads 1.6 contracts and sends 2 has told them the wrong risk.
 */
describe('ProjectX sizing', () => {
    it('states what a point is worth, not what a tick is', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        // A quarter-point tick worth $5 is $20 a point.
        expect(c.pointValue()).toBe(20);
        c.stop();
    });

    it('takes a fractional size down to a whole contract, never up', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(c.sizeOnGrid(1.6)).toBe(1);
        expect(c.sizeOnGrid(2)).toBe(2);
        expect(c.sizeOnGrid(0.4)).toBe(0);
        c.stop();
    });

    it('sends the floor rather than the round — a risk may not be raised on the way out', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.order({ side: 'buy', size: 1.6, type: 'market' });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ size: 1 }));
        c.stop();
    });

    it('refuses what does not reach one contract rather than raising it to one', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(() => c.order({ side: 'buy', size: 0.4, type: 'market' })).toThrow(/whole contracts/);
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });
});

/**
 * Being told rather than asking.
 *
 * The timer was how a fill got noticed, which made the interval two things at once: how long
 * until the screen is right, and how long a leftover protective order lives. The account-side
 * hub takes the first job off it.
 */
describe('ProjectX account feed', () => {
    it('takes the feed and slows the timer down once it is up', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(c.isPushed()).toBe(true));
        expect(api.subscribeUser).toHaveBeenCalled();
        c.stop();
    });

    it('re-reads the account when the gateway says something happened', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(c.isPushed()).toBe(true));
        const before = api.positions.mock.calls.length;
        ringUserHub();
        await vi.waitFor(() => expect(api.positions.mock.calls.length).toBeGreaterThan(before));
        c.stop();
    });

    it('reads once for the burst of events one fill produces', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(c.isPushed()).toBe(true));
        const before = api.positions.mock.calls.length;
        ringUserHub('GatewayUserOrder');
        ringUserHub('GatewayUserPosition');
        ringUserHub('GatewayUserTrade');
        await vi.waitFor(() => expect(api.positions.mock.calls.length).toBe(before + 1));
        c.stop();
    });

    it('goes on asking on its own when the hub cannot be opened', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const api = bridge({ subscribeUser: vi.fn(async () => { throw new Error('no hub'); }) });
        const { c } = await controllerWith(api);
        expect(c.isPushed()).toBe(false);
        // Still a working account — the feed is an improvement, not a requirement.
        expect(c.readAt()).toBeGreaterThan(0);
        c.stop();
    });

    it('lets the feed go when trading stops', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(c.isPushed()).toBe(true));
        c.stop();
        expect(api.unsubscribeUser).toHaveBeenCalledWith('user-sub');
        expect(c.isPushed()).toBe(false);
    });
});

describe('ProjectX trade record', () => {
    const execution = (over: Record<string, unknown> = {}) => ({
        id: 1, accountId: 42, contractId: CONTRACT,
        creationTimestamp: '2026-09-11T12:00:00+00:00',
        price: 24_000, profitAndLoss: null, fees: 1.4, side: 0, size: 1, voided: false, orderId: 7,
        ...over,
    });

    it('reads the record from the venue and pairs it into trades', async () => {
        const api = bridge({
            trades: vi.fn(async () => [
                execution({ id: 1, side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
                execution({ id: 2, side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
            ]),
        });
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(c.history()).toHaveLength(1));
        expect(c.history()[0]).toMatchObject({ side: 'long', entryPrice: 24_000, exitPrice: 24_010 });
        c.stop();
    });

    it('keeps what it last knew when the record cannot be read', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const api = bridge({ trades: vi.fn(async () => { throw new Error('refused'); }) });
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(api.trades).toHaveBeenCalled());
        // An unreadable record is a History tab that is empty, not an account that cannot trade.
        expect(c.history()).toEqual([]);
        expect(c.isStale()).toBe(false);
        c.stop();
    });
});

describe('ProjectX two-sided quote', () => {
    it('has none until the feed has stated both sides', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(c.quote()).toBeNull();
        c.markQuote(23_999.75, null);
        expect(c.quote()).toBeNull();
        c.stop();
    });

    it('remembers each side separately — the feed sends deltas', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        c.markQuote(23_999.75, 24_000.25);
        c.markQuote(23_999.5, null);
        expect(c.quote()).toEqual({ bid: 23_999.5, ask: 24_000.25 });
        c.stop();
    });

    it('does not let the spread move what the position is marked at', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 1, averagePrice: 24_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(24_010);
        const marked = c.positions()[0]!.unrealized;
        c.markQuote(24_020, 24_030);
        // Everything valued is valued against what TRADED, not against a mid.
        expect(c.positions()[0]!.unrealized).toBe(marked);
        expect(c.price()).toBe(24_010);
        c.stop();
    });
});

describe('ProjectX protective orders after a partial close', () => {
    it('brings a stop left at the old size back to the position it guards', async () => {
        // Two contracts were on; one was taken off somewhere. The stop still says two.
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 1 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, size: 2, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalledWith(10, { size: 1 }));
        c.stop();
    });

    it('leaves a protective order that already matches alone', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 2 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, size: 2, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        expect(api.modifyOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('says so loudly when it cannot be corrected — the order would reverse the position', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 1 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, size: 2, stopPrice: 28_900 })]),
            modifyOrder: vi.fn(async () => { throw new Error('refused'); }),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(notes.some(([k]) => k === 'error')).toBe(true));
        expect(notes.find(([k]) => k === 'error')![1]).toMatch(/still sized for 2 against a position of 1/);
        c.stop();
    });
});

describe('ProjectX break-even, on prices that have been through a divide', () => {
    it('counts a stop within half a tick of the entry as already there', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 1, averagePrice: 29_000 })]),
            // 29_000 with the tail a round-trip through the tick grid leaves behind.
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, size: 1, stopPrice: 29_000.0000001 })]),
        });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toBe('The stop is already at entry.');
        c.stop();
    });

    it('still offers it for a stop a real tick away', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, size: 1, averagePrice: 29_000 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, size: 1, stopPrice: 28_999.75 })]),
        });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toBeNull();
        c.stop();
    });
});

/**
 * Saying what happened, without having been watched.
 *
 * Worked out by comparing two reads rather than from the hub's events — those are a doorbell
 * and carry no shape this class trusts, and the comparison is true whatever caused the fill.
 */
describe('ProjectX fill notices', () => {
    const held = (over: Record<string, unknown> = {}) => position({ type: 1, size: 1, ...over });

    it('says nothing about a position that was already on when the chart opened', async () => {
        const api = bridge({ positions: vi.fn(async () => [held()]) });
        const { c, notes } = await controllerWith(api);
        expect(notes.filter(([, m]) => /Filled/.test(m))).toEqual([]);
        c.stop();
    });

    it('announces a position that was not there a moment ago', async () => {
        let open = false;
        const api = bridge({ positions: vi.fn(async () => (open ? [held({ size: 2 })] : [])) });
        const { c, notes } = await controllerWith(api);
        open = true;
        c.order({ side: 'buy', size: 2, type: 'market' });
        await vi.waitFor(() => expect(notes.some(([, m]) => /Filled — long 2 NQU6/.test(m))).toBe(true));
        c.stop();
    });

    it('announces only what was ADDED when a position grows', async () => {
        let size = 1;
        const api = bridge({ positions: vi.fn(async () => [held({ size })]) });
        const { c, notes } = await controllerWith(api);
        size = 3;
        c.order({ side: 'buy', size: 2, type: 'market' });
        await vi.waitFor(() => expect(notes.some(([, m]) => /Filled — long 2 /.test(m))).toBe(true));
        c.stop();
    });

    it('says nothing when a position only shrinks — that is a close, not a fill', async () => {
        let size = 3;
        const api = bridge({ positions: vi.fn(async () => [held({ size })]) });
        const { c, notes } = await controllerWith(api);
        size = 1;
        c.closeOne(6124);
        await vi.waitFor(() => expect(api.closePosition).toHaveBeenCalled());
        expect(notes.filter(([, m]) => /Filled/.test(m))).toEqual([]);
        c.stop();
    });

    it('announces what a closed trade came to, once the record has caught up', async () => {
        const execution = (over: Record<string, unknown> = {}) => ({
            id: 1, accountId: 42, contractId: CONTRACT,
            creationTimestamp: '2026-09-11T12:00:00+00:00',
            price: 24_000, profitAndLoss: null, fees: 0, side: 0, size: 1, voided: false, orderId: 7, ...over,
        });
        let open = true;
        const api = bridge({
            positions: vi.fn(async () => (open ? [held()] : [])),
            trades: vi.fn(async () => (open
                ? []
                : [
                    execution({ id: 1, side: 0, price: 24_000, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
                    execution({ id: 2, side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
                ])),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(c.isPushed()).toBe(true));
        // The stop filled somewhere: the position is gone, and the gateway rings.
        open = false;
        ringUserHub('GatewayUserTrade');
        await vi.waitFor(() => expect(notes.some(([, m]) => /Closed long 1 NQU6/.test(m))).toBe(true));
        expect(notes.find(([, m]) => /Closed long/.test(m))![1]).toContain('+200.00');
        c.stop();
    });

    it('does not announce the same close twice when the record is re-read', async () => {
        const execution = (over: Record<string, unknown> = {}) => ({
            id: 1, accountId: 42, contractId: CONTRACT,
            creationTimestamp: '2026-09-11T12:00:00+00:00',
            price: 24_000, profitAndLoss: null, fees: 0, side: 0, size: 1, voided: false, orderId: 7, ...over,
        });
        const api = bridge({
            trades: vi.fn(async () => [
                execution({ id: 1, side: 0, creationTimestamp: '2026-09-11T12:00:00+00:00' }),
                execution({ id: 2, side: 1, price: 24_010, profitAndLoss: 200, creationTimestamp: '2026-09-11T12:05:00+00:00' }),
            ]),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(c.history()).toHaveLength(1));
        c.cancelAll();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(notes.filter(([, m]) => /Closed/.test(m)).length).toBeLessThanOrEqual(1);
        c.stop();
    });
});

describe('ProjectX taking part off', () => {
    it('closes whole contracts through the gateway partial close, rounded down', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ id: 6124, size: 3 })]) });
        const { c } = await controllerWith(api);
        c.closePart(1.5, 6124);
        await vi.waitFor(() => expect(api.closePosition).toHaveBeenCalledWith(CONTRACT, 1));
        c.stop();
    });

    it('refuses to halve a single contract rather than closing it all', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ id: 6124, size: 1 })]) });
        const { c } = await controllerWith(api);
        expect(() => c.closePart(0.5, 6124)).toThrow(/cannot be split/);
        expect(() => c.closePart(1, 6124)).toThrow(/whole position/);
        expect(api.closePosition).not.toHaveBeenCalled();
        c.stop();
    });
});

describe('ProjectX reverse', () => {
    it('cancels the protection first, then sends one market order for twice the size', async () => {
        const calls: string[] = [];
        const api = bridge({
            positions: vi.fn(async () => [position({ id: 6124, type: 1, size: 2 })]),
            openOrders: vi.fn(async () => [
                order({ id: 10, type: 4, side: 1, stopPrice: 28_900 }),
                order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null }),
            ]),
            cancelOrder: vi.fn(async (id: number) => { calls.push(`cancel ${id}`); }),
            placeOrder: vi.fn(async (spec: { side: string; size: number; type: string }) => {
                calls.push(`${spec.type} ${spec.side} ${spec.size}`);
                return { orderId: 1 };
            }),
        });
        const { c } = await controllerWith(api);
        c.reverse(6124);
        await vi.waitFor(() => expect(calls).toContain('market sell 4'));
        expect(calls.indexOf('market sell 4')).toBeGreaterThan(Math.max(calls.indexOf('cancel 10'), calls.indexOf('cancel 11')));
        c.stop();
    });

    it('sends nothing when the protection cannot be cancelled', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ id: 6124 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
            cancelOrder: vi.fn(async () => { throw new Error('rejected'); }),
        });
        const { c, notes } = await controllerWith(api);
        c.reverse(6124);
        await vi.waitFor(() => expect(notes.some(([k, m]) => k === 'error' && /Not reversed/.test(m))).toBe(true));
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });
});

describe('ProjectX trailing stop', () => {
    it('places a trailing stop at the last price less the distance, then cancels the fixed stop', async () => {
        const calls: string[] = [];
        const api = bridge({
            positions: vi.fn(async () => [position({ id: 6124, type: 1, size: 2 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
            cancelOrder: vi.fn(async (id: number) => { calls.push(`cancel ${id}`); }),
            placeOrder: vi.fn(async (spec: { type: string }) => { calls.push(spec.type); return { orderId: 12 }; }),
        });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        c.setTrailing(20.1, 6124);
        await vi.waitFor(() => expect(calls).toEqual(['trailingStop', 'cancel 10']));
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            contractId: CONTRACT, side: 'sell', type: 'trailingStop', size: 2, trailPrice: 28_990,
        }));
        c.stop();
    });

    it('reads a trailing stop order as the position stop, and sweeps one left behind', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ id: 6124 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 5, side: 1, stopPrice: 28_950 })]),
        });
        const { c } = await controllerWith(api);
        expect(c.positions()[0]).toMatchObject({ stopOrderId: 10, stopLoss: 28_950, trailing: true });
        expect(c.book().positions[0]!.trailing).toBe(true);
        c.stop();

        const gone = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => [order({ id: 10, type: 5, side: 1, stopPrice: 28_950 })]),
        });
        const { c: after } = await controllerWith(gone);
        await vi.waitFor(() => expect(gone.cancelOrder).toHaveBeenCalledWith(10));
        after.stop();
    });

    it('replaces a trailing stop with a fixed one when a level is set on it', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ id: 6124 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 5, side: 1, stopPrice: 28_950 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_975 }, 6124);
        await vi.waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith(10));
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop', stopPrice: 28_975, side: 'sell' }));
        expect(api.modifyOrder).not.toHaveBeenCalledWith(10, expect.anything());
        c.stop();
    });

    it('refuses a trail shorter than a tick', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ id: 6124 })]) });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(() => c.setTrailing(0.1, 6124)).toThrow(/at least one tick/);
        c.stop();
    });
});
